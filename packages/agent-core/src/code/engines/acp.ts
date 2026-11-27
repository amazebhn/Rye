/**
 * `acp:<cli>` code engines: a coding agent CLI that speaks the Agent Client Protocol (ACP),
 * driven by Rye over JSON-RPC on the CLI's stdio (code/acp/), with the **whole CLI process**
 * inside Rye's OS sandbox (docs/design/code-sessions.md §2.2 item 3, §3.3 "ACP CLIs").
 *
 * One engine per agent profile (`AcpAgentProfile`): the command and its flags, the env allowlist,
 * the auth/state dirs the sandbox must let it read (and the few it may write), the API hosts it
 * needs, and how to tell whether it is installed and signed in. GitHub Copilot is the first
 * (`engines/copilot.ts`).
 *
 * Why the whole process is sandboxed (`capabilities.ownSandbox = false`): an ACP agent runs its
 * own file and shell tools, and its permission requests are advisory (an agent may run a tool
 * without asking). So the boundary is the OS sandbox around the CLI and everything it starts
 * (code/process-sandbox.ts): writes only in the session's repo/, tmp/ and cache/ (plus the
 * agent's own session history), no reads of secrets, network only to the agent's own API hosts
 * plus the plan's allowed domains and approved hosts. The engine refuses to start without it.
 *
 * Approvals (`session/request_permission`, https://agentclientprotocol.com/protocol/tool-calls#requesting-permission):
 * the tool call is judged with the same rules as the Claude engine (`judgeToolCall`): a command
 * (`kind: "execute"`) through `policy.commandVerdict`, file tools (`read`/`edit`/`delete`/`move`/
 * `search`) through `policy.pathVerdict` on every path they name, `fetch` as network access.
 * - deny  → the `reject_once` option (the agent is told no);
 * - ask   → a live prompt (`CodeRunOptions.approve`): allow once → `allow_once` (its hosts are
 *           reachable until that tool call ends); allow for the session →
 *           `allowForSession(pattern, hosts)` on the run's policy, then `allow_once` (never
 *           `allow_always`, so the agent keeps asking and Rye keeps judging); deny → `reject_once`;
 * - allow → `allow_once`.
 * Anything Rye can't inspect (`other`, no command or path) asks, showing the raw input.
 *
 * Client capabilities: Rye offers `fs/read_text_file` and `fs/write_text_file` (each judged by
 * `pathVerdict`; writes only inside the workspace) when the profile asks for them, and never the
 * `terminal/*` methods: a terminal Rye ran would sit outside the agent's sandbox.
 *
 * One `CodeRun` is one user turn. The first turn starts the CLI, `initialize`s and opens a
 * session (`session/resume` or `session/load` when continuing a stored one and the agent supports
 * it, else `session/new`). The CLI process is then **kept** between turns (per code session, up
 * to `keepAliveMs` idle), because an agent may not be able to load a session another process
 * made (Copilot: https://github.com/github/copilot-cli/issues/1767). A turn sends
 * `session/prompt` and maps `session/update` notifications to `CodeEvent`s until the prompt
 * returns its stop reason. ACP can't add a message to a running prompt turn, so `send()` queues
 * the text as the next prompt. `interrupt()` sends `session/cancel` and answers open permission
 * requests with `cancelled`.
 *
 * Tests run a fake ACP agent script (tests/fixtures/fake-acp-agent.ts) through an injected
 * spawner and sandbox; they never start a real CLI, `sandbox-exec`, `bwrap` or srt.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Attachment } from "../../chat/attachments.js";
import { clip } from "../../harness/claude-events.js";
import { AcpClosedError, AcpConnection, AcpError, AcpTimeoutError, bunAcpSpawn, type AcpSpawn } from "../acp/connection.js";
import {
  ACP_PROTOCOL_VERSION,
  AGENT_METHODS,
  CLIENT_METHODS,
  RPC_ERRORS,
  type ContentBlock,
  type InitializeResult,
  type NewSessionResult,
  type PermissionOption,
  type PromptResult,
  type ReadTextFileParams,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionNotification,
  type ToolCallFields,
  type WriteTextFileParams,
} from "../acp/protocol.js";
import { type ProcessSandbox, type SandboxedProcess, srtProcessSandbox } from "../process-sandbox.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CodeEngine,
  CodeEngineAvailability,
  CodeEngineId,
  CodeEvent,
  CodeRun,
  CodeRunOptions,
  CompiledPolicy,
} from "../types.js";
import { judgeToolCall, type ApprovalDraft, type ToolJudgement } from "./claude.js";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Where an agent's own files are, and what the sandbox lets it do there. */
export interface AcpAgentFiles {
  /** Readable inside the sandbox even where `denyRead` would refuse (its login and settings). */
  readOnly: string[];
  /** Writable (its session history and logs), so it can keep and resume sessions. */
  write: string[];
  /** Never writable, even inside `write`. */
  denyWrite: string[];
}

/** One ACP agent CLI. */
export interface AcpAgentProfile {
  id: CodeEngineId & `acp:${string}`;
  /** "GitHub Copilot". */
  title: string;
  /** How the agent is named in messages: "Copilot". */
  shortName: string;
  /** The CLI's absolute path, or why it can't be found (with how to install it). */
  locate(env: Record<string, string | undefined>): { path: string } | { missing: string };
  /** The CLI's arguments after its path: the ACP flag, the model, its own deny rules. */
  args(o: { model?: string }): string[];
  /**
   * The CLI's whole environment: an allowlist from `source` (never Rye's secrets), plus the
   * workspace's variables (`workspaceVars`: TMPDIR, caches, PATH with the git shim first).
   */
  env(o: { source: Record<string, string | undefined>; workspaceVars: Record<string, string>; cacheDir: string }): Record<string, string>;
  /** The agent's own files. */
  files(o: { home: string; source: Record<string, string | undefined> }): AcpAgentFiles;
  /** Hosts the agent itself needs (its model API, its auth), on top of the plan's allowed domains. */
  hosts(o: { source: Record<string, string | undefined> }): string[];
  /** Installed and signed in (files and env only: never runs the CLI). The engine adds the sandbox check. */
  availability(o: { source: Record<string, string | undefined>; home: string }): Promise<CodeEngineAvailability>;
  models(): Promise<string[]>;
  /** Offer `fs/read_text_file` and `fs/write_text_file` (each through `pathVerdict`). */
  clientFs: boolean;
  /** A sentence added to an agent error whose text suggests a known cause (an org policy, a login). */
  errorHint?(text: string): string | undefined;
}

export interface AcpEngineDeps {
  /** Starts the (sandboxed) CLI. Default `Bun.spawn`. Tests run a fake agent script. */
  spawn?: AcpSpawn;
  /** The whole-process OS sandbox. Default `sandbox-runtime` (code/process-sandbox.ts). */
  sandbox?: ProcessSandbox;
  /** Where the env allowlist and PATH come from. Default `process.env`. */
  processEnv?: Record<string, string | undefined>;
  /** Default `os.homedir()`. */
  home?: string;
  /** An image attachment's bytes, for agents that take images. Default: none (the `<rye_context>` line describes it). */
  readAttachmentImage?: (attachment: Attachment) => Promise<{ data: string; mimeType: string } | null>;
  /** `initialize` and opening the session. Default 60 s. */
  startTimeoutMs?: number;
  /** No message from the agent for this long (not counting time waiting on the user) ends the run. Default 20 min. */
  idleTimeoutMs?: number;
  /** How long `interrupt()` waits for the agent to acknowledge `session/cancel`. Default 5 s. */
  interruptGraceMs?: number;
  /** How long closing the CLI waits before SIGTERM, and again before SIGKILL. Default 2 s. */
  closeGraceMs?: number;
  /** How long a CLI is kept for the session's next turn. 0 closes it after every turn. Default 15 min. */
  keepAliveMs?: number;
}

/** Longest tool result passed on; the runner logs every event. */
const RESULT_CHARS = 20_000;
const DEFAULTS = { startTimeoutMs: 60_000, idleTimeoutMs: 20 * 60_000, interruptGraceMs: 5000, closeGraceMs: 2000, keepAliveMs: 15 * 60_000 };
type Timeouts = typeof DEFAULTS;

// ---------------------------------------------------------------------------
// Tool calls → Rye's judgement (pure; exported for tests)
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** A word quoted for the shell when it needs it, so an argv judges as the same command line. */
function shellWord(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** The command an `execute` tool call runs, from its raw input (a string or an argv). */
export function acpCommand(call: Pick<ToolCallFields, "rawInput">): string | undefined {
  const input = record(call.rawInput);
  if (!input) return str(call.rawInput);
  for (const key of ["command", "cmd", "commandLine", "script"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      const args = Array.isArray(input.args) ? (input.args as unknown[]).filter((x): x is string => typeof x === "string") : [];
      return [...(v as string[]), ...args].map(shellWord).join(" ");
    }
  }
  return undefined;
}

/** Every path a tool call names: its locations, diff targets and the usual raw-input fields. */
export function acpPaths(call: Pick<ToolCallFields, "rawInput" | "locations" | "content">): string[] {
  const out: string[] = [];
  for (const loc of call.locations ?? []) if (str(loc?.path)) out.push(loc.path);
  for (const c of call.content ?? []) if (c && c.type === "diff" && str(c.path)) out.push(c.path);
  const input = record(call.rawInput);
  if (input) {
    for (const key of ["path", "file_path", "filePath", "file", "fileName", "filename", "notebook_path", "source", "destination", "target", "old_path", "new_path", "from", "to"]) {
      const v = str(input[key]);
      if (v) out.push(v);
    }
    for (const key of ["paths", "files", "file_paths"]) {
      const v = input[key];
      if (Array.isArray(v)) for (const p of v) if (str(p)) out.push(p as string);
    }
  }
  return [...new Set(out)];
}

/** The URL a `fetch` tool call reaches. */
function acpUrl(call: Pick<ToolCallFields, "rawInput">): string | undefined {
  const input = record(call.rawInput);
  return input ? str(input.url) ?? str(input.uri) : undefined;
}

const strictness = { allow: 0, ask: 1, question: 1, deny: 2 } as const;

function worst(js: ToolJudgement[]): ToolJudgement {
  return js.reduce((a, b) => (strictness[b.verdict] > strictness[a.verdict] ? b : a), { verdict: "allow" } as ToolJudgement);
}

export interface AcpJudgeContext {
  policy: CompiledPolicy;
  repoDir: string;
  home: string;
  /** The agent's name in prompts: "Copilot". */
  agent: string;
}

/**
 * Rye's judgement of an ACP tool call, mapped onto the Claude engine's rules (`judgeToolCall`):
 * `execute` → Bash, `edit`/`delete`/`move` → Edit on each path, `read`/`search` → Read on each
 * path, `fetch` → WebFetch, `think` → allowed. A call Rye can't inspect asks, with its raw input
 * shown as-is. Never throws.
 */
export function judgeAcpToolCall(call: ToolCallFields, ctx: AcpJudgeContext): ToolJudgement {
  try {
    const jctx = { policy: ctx.policy, repoDir: ctx.repoDir, home: ctx.home, cwd: ctx.repoDir, ryeTools: new Set<string>() };
    const command = acpCommand(call);
    const paths = acpPaths(call);
    const kind = call.kind ?? "other";
    if (kind === "execute" || (kind === "other" && command)) {
      if (!command) return uninspectable(call, ctx, "runs a command Rye can't read");
      return judgeToolCall("Bash", { command }, jctx);
    }
    if (kind === "edit" || kind === "delete" || kind === "move") {
      if (paths.length === 0) return uninspectable(call, ctx, "changes files without naming them");
      return worst(paths.map((p) => judgeToolCall("Edit", { file_path: p }, jctx)));
    }
    if (kind === "read" || kind === "search") {
      // A search with no path searches the repo (the cwd).
      return paths.length === 0 ? { verdict: "allow" } : worst(paths.map((p) => judgeToolCall("Read", { file_path: p }, jctx)));
    }
    if (kind === "fetch") {
      const url = acpUrl(call);
      if (!url) return uninspectable(call, ctx, "reaches the network");
      return judgeToolCall("WebFetch", { url }, jctx);
    }
    if (kind === "think") return { verdict: "allow" };
    if (paths.length > 0) return worst(paths.map((p) => judgeToolCall("Edit", { file_path: p }, jctx)));
    return uninspectable(call, ctx, "uses a tool Rye can't inspect");
  } catch (err) {
    return { verdict: "deny", reason: `Rye couldn't check this tool call (${err instanceof Error ? err.message : String(err)}), so it is refused.` };
  }
}

function uninspectable(call: ToolCallFields, ctx: AcpJudgeContext, why: string): ToolJudgement {
  const raw = call.rawInput === undefined ? "" : clip(JSON.stringify(call.rawInput), 400);
  const label = call.kind && call.kind !== "other" ? call.kind : "tool";
  return {
    verdict: "ask",
    draft: {
      kind: "command",
      category: "unparseable",
      reason: `${ctx.agent} ${why}; it still runs inside the sandbox`,
      // The raw input, not the agent's title, so the prompt shows what will actually run.
      command: raw ? `${label} ${raw}` : label,
      cwd: "",
      hosts: [],
    },
  };
}

/** The option Rye picks for a decision: once-only kinds first, so Rye judges every later call. */
export function pickOption(options: readonly PermissionOption[], allow: boolean): PermissionOption | undefined {
  const order = allow ? (["allow_once", "allow_always"] as const) : (["reject_once", "reject_always"] as const);
  for (const kind of order) {
    const o = options.find((x) => x.kind === kind);
    if (o) return o;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Events (pure; exported for tests)
// ---------------------------------------------------------------------------

function rawArgs(call: ToolCallFields): Record<string, unknown> {
  const raw = call.rawInput;
  return record(raw) ? { ...(raw as Record<string, unknown>) } : raw === undefined ? {} : { input: raw };
}

/** How a tool call shows in Rye: commands as `Bash` (the Terminal tab), file edits as `Edit`, reads as `Read`. */
export function acpToolView(call: ToolCallFields): { name: string; args: Record<string, unknown> } {
  const title = call.title ?? "";
  const described = title ? { description: title } : {};
  const command = acpCommand(call);
  const paths = acpPaths(call);
  switch (call.kind) {
    case "execute":
      return command ? { name: "Bash", args: { command, ...described } } : { name: title || "execute", args: rawArgs(call) };
    case "edit":
    case "delete":
    case "move":
      return { name: "Edit", args: { ...(paths[0] ? { file_path: paths[0] } : {}), ...(paths.length > 1 ? { paths } : {}), ...described } };
    case "read":
      return { name: "Read", args: { ...(paths[0] ? { file_path: paths[0] } : {}), ...described } };
    case "search":
      return { name: "Grep", args: { ...rawArgs(call), ...described } };
    case "fetch":
      return { name: "WebFetch", args: { ...rawArgs(call), ...described } };
    default:
      return { name: title || call.kind || "tool", args: rawArgs(call) };
  }
}

/** A tool call's result as text: its content blocks, diffs as a one-line summary, else its raw output. */
export function acpToolText(call: Pick<ToolCallFields, "content" | "rawOutput">): string {
  const parts: string[] = [];
  for (const c of call.content ?? []) {
    if (!c) continue;
    if (c.type === "content" && c.content?.type === "text") parts.push(c.content.text);
    else if (c.type === "diff") parts.push(`${c.oldText == null ? "Created" : "Edited"} ${c.path}`);
  }
  if (parts.length > 0) return parts.join("\n");
  const raw = call.rawOutput;
  if (typeof raw === "string") return raw;
  const r = record(raw);
  if (r) {
    for (const key of ["output", "stdout", "content", "text", "result", "message"]) if (typeof r[key] === "string") return r[key] as string;
    return clip(JSON.stringify(raw), RESULT_CHARS);
  }
  return "";
}

/** The model option of an agent's session settings, if it has one. */
function modelOption(created: NewSessionResult) {
  return (created.configOptions ?? []).find((o) => o && o.type === "select" && o.category === "model");
}

// ---------------------------------------------------------------------------
// A live agent process (kept between a session's turns)
// ---------------------------------------------------------------------------

/** The run a live agent's messages currently go to. */
interface AgentClient {
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  onActivity(): void;
  onExit(exitCode: number | null, stderr: string): void;
}

class LiveAgent {
  client: AgentClient | null = null;
  sessionId: string | undefined;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    readonly conn: AcpConnection,
    readonly proc: SandboxedProcess,
    readonly init: InitializeResult,
    /** The model and argv it was started with: a turn that wants another one starts a new process. */
    readonly key: string,
    private readonly closeGraceMs: number,
  ) {}

  get alive(): boolean {
    return !this.disposed && this.conn.isOpen;
  }

  attach(client: AgentClient) {
    this.client = client;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
  }

  /** Keep for the next turn, closing after `ms` idle. */
  park(ms: number, onExpire: () => void) {
    this.client = null;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      onExpire();
      void this.dispose();
    }, ms);
    (this.keepTimer as { unref?: () => void }).unref?.();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.client = null;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    try {
      await this.conn.close(this.closeGraceMs);
    } catch {
      // Gone already.
    }
    try {
      await this.proc.dispose();
    } catch {
      // The sandbox's own cleanup failing changes nothing for the run.
    }
  }
}

interface EngineState {
  /** Live agents by code session id. */
  live: Map<string, LiveAgent>;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

class EventQueue implements AsyncIterable<CodeEvent> {
  private items: CodeEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(event: CodeEvent) {
    if (this.ended) return;
    this.items.push(event);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CodeEvent> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

type DoneEvent = Extract<CodeEvent, { type: "done" }>;

interface ToolState {
  started: boolean;
  finished: boolean;
  /** Characters of in-progress text already sent as `tool_output`. */
  streamed: number;
  /** Hosts approved once for this call, dropped from the sandbox when it ends. */
  onceHosts?: string[];
}

class AcpCodeRun implements CodeRun, AgentClient {
  private readonly events = new EventQueue();
  private readonly abort = new AbortController();
  private readonly tools = new Map<string, ToolState>();
  private readonly steer: string[] = [];
  private readonly permissionAborts = new Set<AbortController>();
  private readonly sessionHosts = new Set<string>();
  private policy: CompiledPolicy;
  private agent: LiveAgent | null = null;
  private finished = false;
  private interrupted = false;
  private replaying = false;
  private toolCalls = 0;
  private waitingOnUser = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly home: string;
  private readonly source: Record<string, string | undefined>;
  private readonly t: Timeouts;
  private readonly onAbort = () => void this.stop(false);

  constructor(
    private readonly o: CodeRunOptions,
    private readonly profile: AcpAgentProfile,
    private readonly deps: AcpEngineDeps,
    private readonly sandbox: ProcessSandbox,
    private readonly state: EngineState,
  ) {
    this.policy = o.policy;
    this.source = deps.processEnv ?? process.env;
    this.home = deps.home ?? homedir();
    this.t = {
      startTimeoutMs: deps.startTimeoutMs ?? DEFAULTS.startTimeoutMs,
      idleTimeoutMs: deps.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      interruptGraceMs: deps.interruptGraceMs ?? DEFAULTS.interruptGraceMs,
      closeGraceMs: deps.closeGraceMs ?? DEFAULTS.closeGraceMs,
      keepAliveMs: deps.keepAliveMs ?? DEFAULTS.keepAliveMs,
    };
    void this.pump();
  }

  [Symbol.asyncIterator](): AsyncIterator<CodeEvent> {
    return this.events[Symbol.asyncIterator]();
  }

  send(text: string): void {
    if (this.finished || !text.trim()) return;
    // ACP can't add a message to a running prompt turn; it goes as the next prompt.
    this.steer.push(text);
  }

  async interrupt(): Promise<void> {
    await this.stop(true);
  }

  // -------------------------------------------------------------------------

  private get sessionId(): string | undefined {
    return this.agent?.sessionId;
  }

  private emit(event: CodeEvent) {
    if (!this.finished) this.events.push(event);
  }

  /** End the run. `keep`: the agent finished its prompt cleanly, so its process can serve the next turn. */
  private finish(done: DoneEvent, keep = false) {
    if (this.finished) return;
    this.finished = true;
    this.events.push(done);
    this.events.end();
    this.clearIdle();
    this.o.signal.removeEventListener("abort", this.onAbort);
    for (const a of this.permissionAborts) a.abort();
    this.abort.abort();
    this.release(keep);
  }

  private release(keep: boolean) {
    const agent = this.agent;
    if (!agent || agent.client !== this) return;
    const key = this.o.workspace.sessionId;
    if (keep && agent.alive && agent.sessionId && this.t.keepAliveMs > 0) {
      agent.park(this.t.keepAliveMs, () => {
        if (this.state.live.get(key) === agent) this.state.live.delete(key);
      });
      this.state.live.set(key, agent);
      // Only the agent's own hosts and the session's approvals stay reachable while it waits.
      try {
        agent.proc.setAllowedDomains?.(this.baseDomains());
      } catch {
        // Ignore.
      }
      return;
    }
    if (this.state.live.get(key) === agent) this.state.live.delete(key);
    void agent.dispose();
  }

  /** `session/cancel`, then (for Stop) wait a little for the prompt to end as `cancelled`. */
  private async stop(wait: boolean) {
    if (this.finished) return;
    this.interrupted = true;
    for (const a of this.permissionAborts) a.abort();
    if (this.agent && this.sessionId) this.agent.conn.notify(AGENT_METHODS.sessionCancel, { sessionId: this.sessionId });
    if (wait) {
      const deadline = Date.now() + this.t.interruptGraceMs;
      while (!this.finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    }
    // Not acknowledged in time: the process may still be working, so it isn't kept.
    this.finish({ type: "done", reason: "interrupted" });
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Restart the inactivity clock; it doesn't run while Rye waits on the user. */
  private touch() {
    this.clearIdle();
    if (this.finished || this.waitingOnUser > 0 || !(this.t.idleTimeoutMs > 0)) return;
    this.idleTimer = setTimeout(() => {
      if (this.agent && this.sessionId) this.agent.conn.notify(AGENT_METHODS.sessionCancel, { sessionId: this.sessionId });
      const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
      const ms = this.t.idleTimeoutMs;
      const span = ms >= 60_000 ? plural(Math.round(ms / 60_000), "minute") : plural(Math.max(1, Math.ceil(ms / 1000)), "second");
      this.finish({ type: "done", reason: "error", error: `${this.profile.shortName} did nothing for ${span}, so Rye stopped it.` });
    }, this.t.idleTimeoutMs);
  }

  private refusal(): string | undefined {
    const { sandbox, workspace } = this.o;
    if (sandbox.failIfUnavailable !== true || sandbox.allowUnsandboxedCommands !== false) {
      return "The sandbox plan must refuse to run unsandboxed (failIfUnavailable, no unsandboxed commands).";
    }
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    if (real(sandbox.cwd) !== real(workspace.repoDir)) return "The sandbox's working directory must be the workspace's repo.";
    if (!sandbox.filesystem.allowWrite.some((p) => real(p) === real(workspace.repoDir))) return "The sandbox must allow writes to the workspace's repo.";
    return undefined;
  }

  /** The agent's own hosts, the plan's, the policy's and the session's approvals. */
  private baseDomains(): string[] {
    return [
      ...new Set(
        [...this.profile.hosts({ source: this.source }), ...this.o.sandbox.network.allowedDomains, ...this.policy.allowedDomains, ...this.sessionHosts].map((h) => h.toLowerCase()),
      ),
    ];
  }

  /** Plus hosts approved once, for the tool calls still running. */
  private domains(): string[] {
    const once = [...this.tools.values()].flatMap((t) => t.onceHosts ?? []);
    return [...new Set([...this.baseDomains(), ...once.map((h) => h.toLowerCase())])];
  }

  private syncDomains() {
    try {
      this.agent?.proc.setAllowedDomains?.(this.domains());
    } catch {
      // The call then fails its network request, which it reports.
    }
  }

  /** The workspace's own variables from the run's env (TMPDIR, caches, PATH), never anything else from it. */
  private workspaceVars(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.o.env)) {
      if (k.startsWith("RYE_")) continue;
      if (/^(PATH|TMPDIR|TMP|TEMP|XDG_CACHE_HOME|GIT_TERMINAL_PROMPT|BUN_INSTALL_CACHE_DIR|npm_config_[a-z_]+|YARN_[A-Z_]+|PIP_CACHE_DIR|UV_CACHE_DIR|GOCACHE)$/.test(k)) out[k] = v;
    }
    return out;
  }

  private async pump() {
    if (this.o.signal.aborted) return this.finish({ type: "done", reason: "interrupted" });
    this.o.signal.addEventListener("abort", this.onAbort, { once: true });
    const name = this.profile.shortName;
    const refused = this.refusal();
    if (refused) return this.finish({ type: "done", reason: "error", error: refused });

    try {
      const model = this.o.model?.trim();
      const args = this.profile.args(model && model !== "default" ? { model } : {});
      const key = JSON.stringify(args);
      const parked = this.state.live.get(this.o.workspace.sessionId);
      let continued: boolean;
      let warning: string | undefined;
      if (parked && parked.alive && !parked.client && parked.key === key && this.o.resume && parked.sessionId === this.o.resume) {
        // The same CLI process, still holding this session: no initialize, no load.
        this.state.live.delete(this.o.workspace.sessionId);
        this.agent = parked;
        parked.attach(this);
        this.syncDomains();
        continued = true;
      } else {
        if (parked) {
          this.state.live.delete(this.o.workspace.sessionId);
          void parked.dispose();
        }
        const started = await this.startAgent(args, key);
        if (!started || this.finished) return;
        ({ continued, warning } = await this.openSession());
        if (this.finished) return;
      }
      const init = this.agent!.init;
      this.emit({
        type: "engine_session",
        id: this.sessionId!,
        ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}),
        ...(warning ? { warning } : {}),
      });
      this.touch();

      let prompt = await this.firstPrompt(continued, init);
      while (!this.finished) {
        const result = await this.agent!.conn.request<PromptResult>(AGENT_METHODS.sessionPrompt, { sessionId: this.sessionId, prompt });
        if (this.finished) return;
        this.reportUsage(result);
        const stop = result?.stopReason;
        if (this.interrupted || stop === "cancelled") return this.finish({ type: "done", reason: "interrupted" }, true);
        if (stop === "max_turn_requests") return this.finish({ type: "done", reason: "max_turns", limit: "max_turns", error: `${name} reached its limit of model requests for this turn.` }, true);
        if (stop === "refusal") return this.finish({ type: "done", reason: "error", error: `${name} refused to continue.` }, true);
        if (stop === "max_tokens") return this.finish({ type: "done", reason: "error", error: `${name} reached its token limit.` }, true);
        if (stop !== "end_turn") return this.finish({ type: "done", reason: "error", error: `${name} ended the turn with an unknown stop reason (${String(stop)}).` });
        const next = this.steer.splice(0);
        if (next.length === 0) return this.finish({ type: "done", reason: "end" }, true);
        prompt = [{ type: "text", text: next.join("\n\n") }];
      }
    } catch (err) {
      if (this.finished) return;
      if (this.interrupted || this.o.signal.aborted) return this.finish({ type: "done", reason: "interrupted" });
      this.finish({ type: "done", reason: "error", error: this.errorText(err) });
    }
  }

  /** Start the CLI inside the sandbox and `initialize` it. False when the run ended instead. */
  private async startAgent(args: string[], key: string): Promise<boolean> {
    // No sandbox, no run: this engine's own approvals can't be trusted to hold.
    const status = await this.sandbox.status().catch((err) => ({ available: false, mechanism: null, reason: err instanceof Error ? err.message : String(err) }));
    if (!status.available) {
      this.finish({ type: "done", reason: "error", error: `${this.profile.title} runs only with its whole process inside Rye's OS sandbox, which can't run here: ${status.reason ?? "unknown reason"}.` });
      return false;
    }
    const located = this.profile.locate(this.source);
    if ("missing" in located) {
      this.finish({ type: "done", reason: "error", error: located.missing });
      return false;
    }
    const files = this.profile.files({ home: this.home, source: this.source });
    const env = this.profile.env({ source: this.source, workspaceVars: this.workspaceVars(), cacheDir: this.o.workspace.cacheDir });
    const proc = await this.sandbox.wrap({
      argv: [located.path, ...args],
      env,
      plan: this.o.sandbox,
      allowedDomains: this.domains(),
      readOnly: files.readOnly,
      write: files.write,
      denyWrite: files.denyWrite,
    });
    if (this.finished) {
      void proc.dispose();
      return false;
    }
    let child;
    try {
      child = (this.deps.spawn ?? bunAcpSpawn)(proc.argv, { cwd: this.o.sandbox.cwd, env: proc.env });
    } catch (err) {
      void proc.dispose();
      throw err;
    }
    // The connection's handlers go to whichever run the agent serves at the time.
    let agent: LiveAgent | null = null;
    const conn = new AcpConnection(child, {
      onRequest: (method, params, signal) => {
        if (agent?.client) return agent.client.onRequest(method, params, signal);
        // Between turns nothing is approved and nothing is read or written.
        if (method === CLIENT_METHODS.requestPermission) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return Promise.reject(new AcpError(RPC_ERRORS.internalError, "No turn is running."));
      },
      onNotification: (method, params) => agent?.client?.onNotification(method, params),
      onActivity: () => agent?.client?.onActivity(),
    });
    const placeholder: InitializeResult = { protocolVersion: ACP_PROTOCOL_VERSION };
    agent = new LiveAgent(conn, proc, placeholder, key, this.t.closeGraceMs);
    this.agent = agent;
    agent.attach(this);
    const wsKey = this.o.workspace.sessionId;
    const self = agent;
    void conn.closed.then(({ exitCode }) => {
      if (this.state.live.get(wsKey) === self) this.state.live.delete(wsKey);
      self.client?.onExit(exitCode, conn.stderr());
      void self.dispose();
    });
    this.touch();

    const init = await conn.request<InitializeResult>(
      AGENT_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: this.profile.clientFs, writeTextFile: this.profile.clientFs }, terminal: false },
        clientInfo: { name: "rye", title: "Rye", version: "0.1.0" },
      },
      { timeoutMs: this.t.startTimeoutMs },
    );
    if (!init || init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.finish({ type: "done", reason: "error", error: `${this.profile.shortName} speaks ACP version ${init?.protocolVersion ?? "unknown"}; Rye speaks ${ACP_PROTOCOL_VERSION}.` });
      return false;
    }
    Object.assign(placeholder, init);
    return true;
  }

  onExit(exitCode: number | null, stderr: string): void {
    if (this.finished) return;
    if (this.interrupted) return this.finish({ type: "done", reason: "interrupted" });
    this.finish({
      type: "done",
      reason: "error",
      error: `${this.profile.shortName} exited before finishing (${exitCode === null ? "killed" : `exit code ${exitCode}`}).${stderr ? `\n${stderr}` : ""}`,
    });
  }

  onActivity(): void {
    this.touch();
  }

  private errorText(err: unknown): string {
    const name = this.profile.shortName;
    if (err instanceof AcpError) {
      if (err.code === RPC_ERRORS.authRequired) return `${this.profile.title} isn't signed in (${err.message}). Sign in to ${name} in a terminal first.`;
      const tail = this.agent?.conn.stderr();
      const hint = this.profile.errorHint?.(`${err.message}\n${tail ?? ""}`);
      return `${name}: ${err.message}${hint ? ` ${hint}` : ""}${tail ? `\n${tail}` : ""}`;
    }
    if (err instanceof AcpClosedError) {
      const tail = this.agent?.conn.stderr();
      return `${name} exited before finishing (${err.exitCode === null ? "killed" : `exit code ${err.exitCode}`}).${tail ? `\n${tail}` : ""}`;
    }
    if (err instanceof AcpTimeoutError) return `${name}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }

  /** Continue the stored session when asked and possible, else open a new one. */
  private async openSession(): Promise<{ continued: boolean; warning?: string }> {
    const agent = this.agent!;
    const conn = agent.conn;
    const base = { cwd: this.o.sandbox.cwd, mcpServers: [] };
    const caps = agent.init.agentCapabilities ?? {};
    const timeoutMs = this.t.startTimeoutMs;
    let warning: string | undefined;
    if (this.o.resume) {
      const canResume = !!record(caps.sessionCapabilities) && "resume" in (caps.sessionCapabilities as object);
      try {
        if (canResume) {
          await conn.request(AGENT_METHODS.sessionResume, { sessionId: this.o.resume, ...base }, { timeoutMs });
          agent.sessionId = this.o.resume;
          return { continued: true };
        }
        if (caps.loadSession) {
          // session/load replays the conversation as session/update notifications; they are not this turn's.
          this.replaying = true;
          await conn.request(AGENT_METHODS.sessionLoad, { sessionId: this.o.resume, ...base }, { timeoutMs: Math.max(timeoutMs, 5 * 60_000) });
          agent.sessionId = this.o.resume;
          return { continued: true };
        }
        warning = `${this.profile.shortName} can't continue an earlier session, so this turn starts a new one without the earlier context.`;
      } catch (err) {
        if (err instanceof AcpClosedError || err instanceof AcpTimeoutError) throw err;
        warning = `${this.profile.shortName} couldn't continue session ${this.o.resume} (${err instanceof Error ? err.message : String(err)}), so this turn starts a new one without the earlier context.`;
      } finally {
        this.replaying = false;
      }
    }
    const created = await conn.request<NewSessionResult>(AGENT_METHODS.sessionNew, base, { timeoutMs });
    if (!created || typeof created.sessionId !== "string" || !created.sessionId) throw new Error(`${this.profile.shortName} didn't return a session id.`);
    agent.sessionId = created.sessionId;
    await this.chooseModel(created);
    return { continued: false, ...(warning ? { warning } : {}) };
  }

  /** Pick the model through the session's `model` setting when the agent has one and the CLI flag didn't already. */
  private async chooseModel(created: NewSessionResult) {
    const model = this.o.model?.trim();
    const option = modelOption(created);
    if (!model || model === "default" || !option || option.currentValue === model) return;
    const values = (option.options ?? []).flatMap((o) => (o.options ? o.options : [o])).map((o) => o.value);
    if (!values.includes(model)) return;
    try {
      await this.agent!.conn.request(AGENT_METHODS.sessionSetConfigOption, { sessionId: this.sessionId, configId: option.id, value: model }, { timeoutMs: this.t.startTimeoutMs });
    } catch {
      // The CLI's own --model flag (if any) still applies.
    }
  }

  /** The first prompt: Rye's instructions (ACP has no system prompt) on a new session, then the user's message and images. */
  private async firstPrompt(continued: boolean, init: InitializeResult): Promise<ContentBlock[]> {
    const text = this.o.input.text || "Continue.";
    const instructions = !continued && this.o.systemPrompt.trim() ? `<rye_instructions>\n${this.o.systemPrompt.trim()}\n</rye_instructions>\n\n` : "";
    const blocks: ContentBlock[] = [{ type: "text", text: `${instructions}${text}` }];
    if (!init.agentCapabilities?.promptCapabilities?.image || !this.deps.readAttachmentImage) return blocks;
    for (const attachment of this.o.input.attachments) {
      if (attachment.kind !== "image") continue;
      try {
        const image = await this.deps.readAttachmentImage(attachment);
        if (image) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
      } catch {
        // The <rye_context> line still describes it.
      }
    }
    return blocks;
  }

  private reportUsage(result: PromptResult | null | undefined) {
    const u = result?.usage;
    if (!u || typeof u !== "object") return;
    const input = (u.inputTokens ?? 0) + (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
    const output = u.outputTokens ?? 0;
    // No cost: the agent bills by its own plan (Copilot: premium requests), not in USD per token.
    if (input > 0 || output > 0) this.emit({ type: "usage", inputTokens: input, outputTokens: output });
  }

  // ── Agent → Rye ──────────────────────────────────────────────────────────

  onNotification(method: string, params: unknown): void {
    if (method !== CLIENT_METHODS.sessionUpdate || this.replaying || this.finished) return;
    const n = params as SessionNotification;
    if (!n || typeof n !== "object" || !n.update || (this.sessionId && n.sessionId !== this.sessionId)) return;
    const u = n.update as { sessionUpdate: string } & Record<string, unknown>;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as ContentBlock | undefined;
        if (c?.type === "text" && c.text) this.emit({ type: "text", delta: c.text });
        return;
      }
      case "tool_call":
      case "tool_call_update":
        return this.onToolCall(u as unknown as ToolCallFields);
      default:
        // Thoughts, plans, commands, modes and context use aren't shown in a code chat.
        return;
    }
  }

  private onToolCall(call: ToolCallFields) {
    if (!call.toolCallId) return;
    let t = this.tools.get(call.toolCallId);
    if (!t) {
      t = { started: false, finished: false, streamed: 0 };
      this.tools.set(call.toolCallId, t);
    }
    if (!t.started) {
      t.started = true;
      const view = acpToolView(call);
      this.emit({ type: "tool_start", id: call.toolCallId, name: view.name, args: view.args });
      this.toolCalls += 1;
      const max = this.o.limits.maxTurns;
      if (max > 0 && this.toolCalls > max) {
        // ACP has no turn limit Rye can set; tool calls stand in for agent turns.
        if (this.agent && this.sessionId) this.agent.conn.notify(AGENT_METHODS.sessionCancel, { sessionId: this.sessionId });
        this.finish({ type: "done", reason: "max_turns", limit: "max_turns", error: `Reached the limit of ${max} tool calls.` });
        return;
      }
    }
    if (t.finished) return;
    if (call.status === "completed" || call.status === "failed") {
      t.finished = true;
      this.emit({ type: "tool_result", id: call.toolCallId, content: clip(acpToolText(call), RESULT_CHARS), isError: call.status === "failed" });
      if (t.onceHosts) {
        t.onceHosts = undefined;
        this.syncDomains();
      }
      return;
    }
    const text = call.content ? acpToolText({ content: call.content }) : "";
    if (text.length > t.streamed) {
      this.emit({ type: "tool_output", id: call.toolCallId, chunk: text.slice(t.streamed) });
      t.streamed = text.length;
    }
  }

  async onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.finished) {
      if (method === CLIENT_METHODS.requestPermission) return { outcome: { outcome: "cancelled" } } satisfies RequestPermissionResult;
      throw new AcpError(RPC_ERRORS.internalError, "The run has ended.");
    }
    switch (method) {
      case CLIENT_METHODS.requestPermission:
        return this.onPermission(params as RequestPermissionParams, signal);
      case CLIENT_METHODS.readTextFile:
        if (!this.profile.clientFs) break;
        return this.readFile(params as ReadTextFileParams, signal);
      case CLIENT_METHODS.writeTextFile:
        if (!this.profile.clientFs) break;
        return this.writeFile(params as WriteTextFileParams);
    }
    throw new AcpError(RPC_ERRORS.methodNotFound, `Rye doesn't offer ${method}.`);
  }

  private judgeCtx(): AcpJudgeContext {
    return { policy: this.policy, repoDir: this.o.workspace.repoDir, home: this.home, agent: this.profile.shortName };
  }

  private async onPermission(params: RequestPermissionParams, signal: AbortSignal): Promise<RequestPermissionResult> {
    const options = Array.isArray(params?.options) ? params.options : [];
    const call: ToolCallFields = params?.toolCall && typeof params.toolCall === "object" ? params.toolCall : { toolCallId: "" };
    const cancelled: RequestPermissionResult = { outcome: { outcome: "cancelled" } };
    const select = (allow: boolean): RequestPermissionResult => {
      const o = pickOption(options, allow);
      // No option of the right kind: "cancelled" is the only answer that can't be taken as a yes.
      return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : cancelled;
    };
    if (this.interrupted) return cancelled;
    const j = judgeAcpToolCall(call, this.judgeCtx());
    if (j.verdict === "allow") return select(true);
    if (j.verdict === "deny" || j.verdict === "question") return select(false);

    const decision = await this.ask(j.draft, call, signal);
    if (this.interrupted || this.finished) return cancelled;
    if (decision.behavior !== "allow") return select(false);
    const hosts = j.draft.kind === "command" ? j.draft.hosts : [];
    if (decision.scope === "session") {
      this.policy = this.policy.allowForSession(decision.pattern, hosts);
      for (const h of hosts) this.sessionHosts.add(h);
    } else if (hosts.length > 0 && call.toolCallId) {
      const t = this.tools.get(call.toolCallId) ?? { started: false, finished: false, streamed: 0 };
      t.onceHosts = hosts;
      this.tools.set(call.toolCallId, t);
    }
    if (hosts.length > 0) this.syncDomains();
    return select(true);
  }

  /** A live prompt; answered "aborted" when the run stops or the agent's request is dropped. */
  private async ask(draft: ApprovalDraft, call: ToolCallFields, signal: AbortSignal): Promise<ApprovalDecision> {
    const stopped: ApprovalDecision = { behavior: "deny", reason: "aborted", message: "The run was stopped." };
    if (signal.aborted || this.abort.signal.aborted) return stopped;
    const local = new AbortController();
    this.permissionAborts.add(local);
    const request = {
      ...draft,
      id: randomUUID(),
      sessionId: this.o.workspace.sessionId,
      toolName: acpToolView(call).name,
      ...(call.toolCallId ? { toolUseId: call.toolCallId } : {}),
    } as ApprovalRequest;
    let cleanup = () => {};
    const aborted = new Promise<ApprovalDecision>((resolve) => {
      const onStop = () => resolve(stopped);
      const signals = [signal, this.abort.signal, local.signal];
      for (const s of signals) s.addEventListener("abort", onStop, { once: true });
      cleanup = () => {
        for (const s of signals) s.removeEventListener("abort", onStop);
      };
    });
    this.waitingOnUser += 1;
    this.clearIdle();
    try {
      return await Promise.race([this.o.approve(request), aborted]);
    } catch (err) {
      return { behavior: "deny", reason: "user", message: `The approval failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      cleanup();
      this.permissionAborts.delete(local);
      this.waitingOnUser -= 1;
      this.touch();
    }
  }

  private async readFile(p: ReadTextFileParams, signal: AbortSignal): Promise<{ content: string }> {
    const path = this.checkedPath(p?.path);
    const v = this.policy.pathVerdict(path, "read");
    if (v.verdict === "deny") throw new AcpError(RPC_ERRORS.internalError, v.reason);
    if (v.verdict === "ask") {
      const d = await this.ask({ kind: "path", category: "path", reason: v.reason, path, op: "read", ...(v.pattern ? { pattern: v.pattern } : {}) }, { toolCallId: "", kind: "read" }, signal);
      if (d.behavior !== "allow") throw new AcpError(RPC_ERRORS.internalError, d.behavior === "deny" ? d.message : "Not allowed.");
      if (d.scope === "session") this.policy = this.policy.allowForSession(d.pattern);
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new AcpError(RPC_ERRORS.resourceNotFound, `Can't read ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    }
    const line = typeof p.line === "number" && p.line > 0 ? p.line : 1;
    const limit = typeof p.limit === "number" && p.limit > 0 ? p.limit : undefined;
    if (line === 1 && limit === undefined) return { content: text };
    const lines = text.split("\n");
    return { content: lines.slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join("\n") };
  }

  private async writeFile(p: WriteTextFileParams): Promise<null> {
    const path = this.checkedPath(p?.path);
    if (typeof p.content !== "string") throw new AcpError(RPC_ERRORS.invalidParams, "content must be a string.");
    const v = this.policy.pathVerdict(path, "write");
    // Writes go only where the policy allows them outright: inside the workspace. There's nothing to ask.
    if (v.verdict !== "allow") throw new AcpError(RPC_ERRORS.internalError, v.verdict === "deny" ? v.reason : `Writes are allowed only inside the workspace (${this.o.workspace.repoDir}).`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, p.content);
    } catch (err) {
      throw new AcpError(RPC_ERRORS.internalError, `Can't write ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    }
    return null;
  }

  private checkedPath(path: unknown): string {
    if (typeof path !== "string" || !path) throw new AcpError(RPC_ERRORS.invalidParams, "path is required.");
    if (!isAbsolute(path)) throw new AcpError(RPC_ERRORS.invalidParams, "path must be absolute.");
    return path;
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** An `acp:<cli>` code engine for one agent profile. */
export function acpCodeEngine(profile: AcpAgentProfile, deps: AcpEngineDeps = {}): CodeEngine & { close(): Promise<void> } {
  let sandbox: ProcessSandbox | null = deps.sandbox ?? null;
  const box = () => (sandbox ??= srtProcessSandbox());
  const state: EngineState = { live: new Map() };
  return {
    id: profile.id,
    capabilities: { resume: true, liveApprovals: true, ownSandbox: false },
    models: () => profile.models(),
    async availability(): Promise<CodeEngineAvailability> {
      const own = await profile.availability({ source: deps.processEnv ?? process.env, home: deps.home ?? homedir() });
      if (!own.available) return own;
      const status = await box().status();
      if (!status.available) return { available: false, reason: `${profile.title} runs only inside Rye's OS sandbox, which can't run here: ${status.reason ?? "unknown reason"}.` };
      return own;
    },
    start(o: CodeRunOptions): CodeRun {
      return new AcpCodeRun(o, profile, deps, box(), state);
    },
    /** Close every kept CLI process (shutdown, tests). */
    async close() {
      const agents = [...state.live.values()];
      state.live.clear();
      await Promise.all(agents.map((a) => a.dispose()));
    },
  };
}
