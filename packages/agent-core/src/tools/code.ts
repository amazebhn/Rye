/**
 * Code-session tools for chats and agents (docs/design/code-sessions.md §4.3), group `code`.
 *
 * - `start_code_session_tool` never starts anything by itself. Like `add_mcp_server_tool`, the
 *   model only makes a proposal; the agent loop shows the end-of-turn prompt ("Start a code
 *   session on **rye** from **main** with Claude (sonnet)?", Start / Cancel) and the user's next
 *   message decides (`resolvePendingCodeSessionStart`). On Start the session is created with the
 *   task as its first message, and the parent chat gets a tool result carrying
 *   `[rye:code-session:<id>]`, which the web app draws as the session's card.
 * - `code_session_status_tool` is read-only: status, diffstat, branch.
 *
 * Both are offered only while code sessions are on (`getTools` in tools/index.ts).
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CodeRunner } from "../code/runner.js";
import type { CodeConfig } from "../code/types.js";
import { getSettings } from "../config.js";

// The same rule as `codeSessionsEnabled` in code/service.ts (not imported, so the tool registry
// doesn't load the code engines).
const codeSessionsEnabled = () => {
  const code = getSettings().code;
  return code.enabled && code.repos.length > 0;
};

export const START_CODE_SESSION_TOOL_NAME = "start_code_session_tool";
export const CODE_SESSION_STATUS_TOOL_NAME = "code_session_status_tool";
export const CODE_TOOL_NAMES: ReadonlySet<string> = new Set([START_CODE_SESSION_TOOL_NAME, CODE_SESSION_STATUS_TOOL_NAME]);
export const START_CODE_SESSION = "Start";
export const CANCEL_CODE_SESSION = "Cancel";

export interface CodeToolService {
  enabled(): boolean;
  runner(): CodeRunner;
  /** The chat a run belongs to (the parent chat of a session started from it). */
  chatForSession?(sessionId: string): string | undefined;
  /** `[code]`; default the config file's. */
  config?(): Pick<CodeConfig, "repos" | "engine" | "model">;
}

let service: CodeToolService | null = null;

/** Set by server.ts; tests pass their own. */
export function setCodeToolService(s: CodeToolService | null): void {
  service = s;
}

/** Whether the code tools are offered: a service is set and `[code]` allows a repo. */
export function codeToolsEnabled(): boolean {
  return service !== null && (service.enabled?.() ?? codeSessionsEnabled());
}

export const codeTools: Tool[] = [
  {
    name: START_CODE_SESSION_TOOL_NAME,
    description:
      "Propose starting a code session: a coding agent working in a sandboxed clone of an allowed repository, on a branch of its own, in a new chat the user can watch and review. " +
      "Use it when the user wants code changed (implement, fix in code, refactor, open a branch or PR). Nothing starts until the user approves the prompt Rye shows, so call it once and stop; " +
      "the user's answer arrives as the next message. `task` must be a self-contained brief (the coding agent doesn't see this chat): what to change, where, why, and how to check it.",
    parameters: Type.Object({
      repo: Type.String({ description: "A repository allowed for code sessions ([[code.repos]] name)." }),
      task: Type.String({ description: "The complete, self-contained brief for the coding agent." }),
      base: Type.Optional(Type.String({ description: "Base branch; default the repo's configured base." })),
      title: Type.Optional(Type.String({ description: "A short title for the session's chat." })),
    }),
  },
  {
    name: CODE_SESSION_STATUS_TOOL_NAME,
    description: "Read a code session's state (running, waiting for approval, ready to review), its branch, and what changed so far. Read-only.",
    parameters: Type.Object({
      session_id: Type.String({ description: "The code session id (from [rye:code-session:<id>])." }),
    }),
  },
];

interface PendingStart {
  repo: string;
  task: string;
  base?: string;
  title?: string;
}

const pending = new Map<string, PendingStart>();

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validate a proposal and remember it for the user's answer. */
export function prepareCodeSessionStart(sessionId: string, args: Record<string, unknown>): { ok: true; question: string } | { ok: false; error: string } {
  if (!codeToolsEnabled()) return { ok: false, error: "Code sessions aren't set up here ([code] with [[code.repos]] in config.toml)." };
  const repoName = str(args.repo, 64);
  const task = str(args.task, 100_000);
  if (!repoName || !task) return { ok: false, error: "start_code_session_tool needs `repo` and `task`." };
  const config = service?.config?.() ?? getSettings().code;
  const repo = config.repos.find((r) => r.name === repoName);
  if (!repo) return { ok: false, error: `"${repoName}" isn't allowed for code sessions. Allowed: ${config.repos.map((r) => r.name).join(", ") || "none"}.` };
  const base = str(args.base, 200) ?? repo.base;
  const title = str(args.title, 80);
  pending.set(sessionId, { repo: repoName, task, ...(base ? { base } : {}), ...(title ? { title } : {}) });
  const model = config.model || (config.engine === "claude" ? getSettings().claude.model : "");
  const engine = config.engine === "claude" ? "Claude" : config.engine;
  const brief = task.length > 1200 ? `${task.slice(0, 1200)}…` : task;
  return {
    ok: true,
    question:
      `Start a code session on **${repoName}**${base ? ` from **${base}**` : ""} with ${engine}${model ? ` (${model})` : ""}?\n\n` +
      `It works in a sandboxed clone on a branch of its own; your checkout isn't touched.\n\n**Task:**\n\n${brief}`,
  };
}

export function clearPendingCodeSessionStart(sessionId: string): void {
  pending.delete(sessionId);
}

export interface CodeStartOutcome {
  /** For this turn's `<rye_context>`. */
  note: string;
  /** When a session was started: the tool call to show in the parent chat (its result carries the card marker). */
  call?: { args: Record<string, unknown>; result: string };
}

/** Apply the user's answer to a pending proposal; null when there is none. Anything but Start cancels. */
export async function resolvePendingCodeSessionStart(sessionId: string, answer: string): Promise<CodeStartOutcome | null> {
  const proposal = pending.get(sessionId);
  if (!proposal) return null;
  pending.delete(sessionId);
  if (answer.trim().toLowerCase() !== START_CODE_SESSION.toLowerCase()) {
    return { note: `The user did not start the code session on ${proposal.repo}. Don't start it again unless they ask.` };
  }
  if (!service || !codeToolsEnabled()) return { note: "The code session could not be started: code sessions are turned off." };
  try {
    const parentChatId = service.chatForSession?.(sessionId);
    const { session } = await service.runner().create(
      { repo: proposal.repo, task: proposal.task, ...(proposal.base ? { base: proposal.base } : {}), ...(proposal.title ? { title: proposal.title } : {}) },
      parentChatId ? { parentChatId } : {},
    );
    const result = `Started code session "${session.title}" on ${session.repo} (branch ${session.branch}, from ${session.base}). The user can open it from the card below.\n[rye:code-session:${session.id}]`;
    return {
      note: `**Code session started:** "${session.title}" (id ${session.id}) on ${session.repo}, branch ${session.branch}. Tell the user briefly; they follow it in its own chat. Use code_session_status_tool to check on it later.`,
      call: { args: { repo: proposal.repo, task: proposal.task, ...(proposal.base ? { base: proposal.base } : {}), ...(proposal.title ? { title: proposal.title } : {}) }, result },
    };
  } catch (err) {
    return { note: `The code session could not be started: ${err instanceof Error ? err.message : String(err)}. Tell the user.` };
  }
}

/** `code_session_status_tool`. */
export async function codeSessionStatusForAgent(args: Record<string, unknown>): Promise<string> {
  if (!service || !codeToolsEnabled()) return "Code sessions aren't set up here.";
  const id = str(args.session_id, 80)?.replace(/^\[rye:code-session:|\]$/g, "");
  if (!id) return "Give session_id.";
  try {
    const d = await service.runner().detail(id);
    const b = d.status.branch;
    const lines = [
      `Code session "${d.title}" (${d.id}) on ${d.repo}: ${d.state === "archived" ? "archived" : d.activity.replace("_", " ")}.`,
      `Branch ${d.branch} from ${d.base}${b ? `: ${b.ahead} commit(s) ahead, ${b.behind} behind; ${b.stat.files} file(s) changed (+${b.stat.additions} -${b.stat.deletions}); ${b.dirtyFiles} uncommitted.` : "."}`,
      `Cost so far: $${d.costUsd.toFixed(2)}.`,
      ...(d.pendingPrompt ? ["It is waiting for the user to answer an approval in its chat."] : []),
    ];
    if (d.state === "active" && b && b.stat.files > 0) {
      const { files } = await service.runner().changes(id);
      lines.push("Changed files:", ...files.slice(0, 30).map((f) => `- ${f.status} ${f.path} (+${f.additions} -${f.deletions})${f.sensitive.length ? ` [review: ${f.sensitive.map((s) => s.kind).join(", ")}]` : ""}`));
    }
    return `${lines.join("\n")}\n[rye:code-session:${d.id}]`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
