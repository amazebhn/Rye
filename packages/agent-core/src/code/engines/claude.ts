/**
 * The `claude` code engine: Claude Code through the Claude Agent SDK's `query()`, behind Rye's
 * policy, sandbox and live approvals (docs/design/code-sessions.md §2, §3).
 *
 * How a call is judged (§3.3):
 * 1. A `PreToolUse` hook judges every tool call: Bash through `policy.commandVerdict`, file tools
 *    through `policy.pathVerdict` on every path they name, web tools as network access, Rye's
 *    bridged tools as allowed, anything else as unavailable. A deny there is final (it holds even
 *    under bypass); an ask is returned as `ask`, which makes Claude Code ask the host; an allow
 *    passes the call on to Claude Code's own checks.
 * 2. `canUseTool` gets every call Claude Code asks about, judges it again with the same rules,
 *    and turns an ask into a live prompt (`CodeRunOptions.approve`). "Allow for this session"
 *    adds its pattern to the run's policy (`allowForSession`). `AskUserQuestion` becomes one
 *    `question` request per question.
 * 3. Bash and its children run in the SDK's OS sandbox (`SandboxPlan`), which fails closed.
 *
 * One `CodeRun` is one user turn, in streaming input mode so `send()` can steer it. It ends with
 * `done` once Claude Code has answered every message sent into it. Claude Code is never started
 * by tests: they inject `query` (see `tests/code-engine-claude.test.ts`).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SandboxSettings,
} from "@anthropic-ai/claude-agent-sdk";
import type { Attachment } from "../../chat/attachments.js";
import {
  InputChannel,
  RYE_MCP_SERVER,
  RYE_TOOL_PREFIX,
  RyeMcpBridge,
  StderrTail,
  ToolUseBlocks,
  assistantErrorText,
  clip,
  resultErrorDetail,
  sdkUserMessage,
  toolResultBlocks,
  toolResultText,
  type QueryFn,
  type RyeMcpCall,
  type StreamEvent,
  type ToolOutcome,
  type UserBlock,
} from "../../harness/claude-events.js";
import { CLAUDE_MODEL_ALIASES } from "../../harness/claude-sdk.js";
import { claudeEnv, claudeEnvAllows } from "../../harness/env.js";
import { isLocalHost } from "../policy.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CodeEngine,
  CodeEngineAvailability,
  CodeEvent,
  CodeRun,
  CodeRunOptions,
  CodeSandboxStatus,
  CompiledPolicy,
  PathOp,
  SandboxPlan,
  Verdict,
} from "../types.js";

export const CLAUDE_ENGINE_ID = "claude" as const;

/**
 * Claude Code versions this engine is known to work with (§8 risks: "SDK churn"). The SDK pinned
 * in package.json (0.3.330) drives 2.1.331; 2.1.259 is the oldest with the permission and hook
 * options used here. A version outside the range still runs, with a warning on `engine_session`.
 */
export const CLAUDE_CODE_VERSIONS = { min: "2.1.259", tested: "2.1.331", below: "2.2.0" } as const;

/** Claude Code's built-in tools a code session gets. Everything else is off (`tools`) and disallowed below. */
export const CODE_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "TodoWrite",
  "AskUserQuestion",
  // Network access outside the sandbox's proxy: every call asks, unless its host is allowed (§3.4).
  "WebFetch",
  "WebSearch",
];

/**
 * A backstop behind `tools` (§3.3: "keep disallowedTools as a backstop"): tools that would reach
 * past the workspace, start other agents or run unattended, plus the publish rules the policy
 * already denies.
 */
export const CODE_DISALLOWED_TOOLS = [
  "Agent",
  "Task",
  "Skill",
  "Workflow",
  "Monitor",
  "PowerShell",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "SendUserFile",
  "SendUserMessage",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  "Bash(git push)",
  "Bash(git push *)",
  "Bash(git remote add *)",
  "Bash(git remote set-url *)",
  "Bash(sudo *)",
];

/** File tools and the input fields holding their paths (§3.2). */
const FILE_TOOL_PATHS: Record<string, Array<{ key: string; op: PathOp; optional?: boolean; glob?: boolean }>> = {
  Read: [{ key: "file_path", op: "read" }],
  Write: [{ key: "file_path", op: "write" }],
  Edit: [{ key: "file_path", op: "write" }],
  MultiEdit: [{ key: "file_path", op: "write" }],
  NotebookEdit: [{ key: "notebook_path", op: "write" }],
  NotebookRead: [{ key: "notebook_path", op: "read" }],
  LS: [{ key: "path", op: "read" }],
  Glob: [
    { key: "path", op: "read", optional: true },
    { key: "pattern", op: "read", glob: true },
  ],
  Grep: [
    { key: "path", op: "read", optional: true },
    { key: "glob", op: "read", optional: true, glob: true },
  ],
};

/** Tools allowed without further checks: they only touch Claude Code's own state. */
const PLAIN_TOOLS = new Set(["TodoWrite"]);

/** Longest tool result passed on; the runner logs every event. */
const RESULT_CHARS = 20_000;
/** How long `interrupt()` waits for Claude Code to stop before closing it. */
const INTERRUPT_GRACE_MS = 5000;
/** PreToolUse never waits on the user (asks go to canUseTool), so a short timeout is enough. */
const HOOK_TIMEOUT_S = 60;

export interface ClaudeEngineDeps {
  /** Replaces the SDK's `query()` in tests. */
  query?: QueryFn;
  /** Where the env allowlist reads from (`claudeEnv`'s `source`). Default `process.env`. */
  processEnv?: Record<string, string | undefined>;
  /** The user's home directory, for `~` in paths and finding Claude Code's login. Default `os.homedir()`. */
  home?: string;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether the OS sandbox can run here. Default: a check of the platform and its sandbox binaries. */
  sandboxProbe?: () => Promise<CodeSandboxStatus>;
  /** Whether the Agent SDK can be loaded. Default: resolve the package. */
  sdkInstalled?: () => boolean | Promise<boolean>;
  /** Models to offer. Default: the SDK's aliases (no Claude Code process is started). */
  models?: () => Promise<string[]>;
  /** An image attachment's bytes, so a model that can see gets it. Default: none (the `<rye_context>` line describes it). */
  readAttachmentImage?: (attachment: Attachment) => Promise<{ data: string; mimeType: string } | null>;
  /** Default 5000. */
  interruptGraceMs?: number;
  /** Where version warnings go besides `engine_session`. Default `console.warn`. */
  onWarning?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Why a Claude Code version is outside `CLAUDE_CODE_VERSIONS`, or undefined when it is inside. */
export function claudeCodeVersionProblem(version: string | undefined): string | undefined {
  if (!version) return "Claude Code didn't report its version.";
  const v = parseVersion(version);
  if (!v) return `Claude Code reported an unreadable version (${version}).`;
  if (compareVersions(v, parseVersion(CLAUDE_CODE_VERSIONS.min)!) < 0) {
    return `Claude Code ${version} is older than ${CLAUDE_CODE_VERSIONS.min}, the oldest version code sessions support.`;
  }
  if (compareVersions(v, parseVersion(CLAUDE_CODE_VERSIONS.below)!) >= 0) {
    return `Claude Code ${version} is newer than the versions code sessions were tested with (up to ${CLAUDE_CODE_VERSIONS.tested}).`;
  }
  return undefined;
}

/**
 * The environment Claude Code gets: `claudeEnv`'s allowlist plus the run's own variables
 * (`CodeRunOptions.env`: TMPDIR, caches, PATH with the shim first). A variable in `env` that the
 * allowlist refuses and that holds exactly the value Rye's own environment has is a leak, not a
 * workspace setting, and is dropped; so is every `RYE_*` variable.
 */
export function claudeCodeEnv(env: Record<string, string>, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("RYE_")) continue;
    if (!claudeEnvAllows(name, source) && source[name] === value) continue;
    overrides[name] = value;
  }
  return claudeEnv({ source, overrides });
}

/** The SDK `sandbox` option for a plan (§3.3; the mapping in `SandboxPlan`'s comment), with extra hosts allowed. */
export function sdkSandbox(plan: SandboxPlan, allowedDomains: readonly string[] = plan.network.allowedDomains): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    // Rye's PreToolUse hook judges every command, sandboxed or not.
    autoAllowBashIfSandboxed: false,
    network: { allowedDomains: [...new Set(allowedDomains)], allowLocalBinding: plan.network.allowLocalBinding },
    filesystem: {
      allowWrite: [...plan.filesystem.allowWrite],
      denyWrite: [...plan.filesystem.denyWrite],
      allowRead: [...plan.filesystem.allowRead],
      denyRead: [...plan.filesystem.denyRead],
    },
  };
}

/** Whether `host` is covered by `domains` (`example.com` exactly, `*.example.com` any subdomain). */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => {
    const domain = d.toLowerCase();
    return domain.startsWith("*.") ? h.endsWith(domain.slice(1)) : h === domain;
  });
}

/** The part of a glob before its first wildcard segment ("src/**" → "src", "*.ts" → ""). */
function globBase(pattern: string): string {
  const parts = pattern.split("/");
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) break;
    fixed.push(part);
  }
  if (fixed.length === parts.length) return pattern;
  return fixed.join("/") || (pattern.startsWith("/") ? "/" : "");
}

/** argv for a command that is plainly one simple command of plain words; undefined otherwise. */
function simpleArgv(command: string): string[] | undefined {
  const trimmed = command.trim();
  return /^[A-Za-z0-9_@%+=:,./-]+(?:\s+[A-Za-z0-9_@%+=:,./-]+)*$/.test(trimmed) ? trimmed.split(/\s+/) : undefined;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An approval request before Rye gives it an id. */
export type ApprovalDraft = DistributiveOmit<ApprovalRequest, "id" | "sessionId" | "toolName" | "toolUseId">;

/** What Rye makes of one tool call. */
export type ToolJudgement =
  | { verdict: "allow" }
  | { verdict: "deny"; reason: string }
  | { verdict: "ask"; draft: ApprovalDraft }
  /** `AskUserQuestion`: answered by the user through `question` requests. */
  | { verdict: "question" };

export interface JudgeContext {
  policy: CompiledPolicy;
  repoDir: string;
  home: string;
  /** The session's current directory when the call was made (relative paths resolve against it). */
  cwd: string;
  /** Rye tools bridged into this run (names without the `mcp__rye__` prefix). */
  ryeTools: ReadonlySet<string>;
}

const strictness = { allow: 0, ask: 1, question: 1, deny: 2 } as const;

/**
 * Judge one tool call (§3.2, §3.3). Pure apart from `pathVerdict`'s realpath. Never throws: a
 * failure to judge is a deny.
 */
export function judgeToolCall(toolName: string, rawInput: unknown, ctx: JudgeContext): ToolJudgement {
  try {
    return judge(toolName, (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>, ctx);
  } catch (err) {
    return { verdict: "deny", reason: `Rye couldn't check this ${toolName} call (${err instanceof Error ? err.message : String(err)}), so it is refused.` };
  }
}

function judge(toolName: string, input: Record<string, unknown>, ctx: JudgeContext): ToolJudgement {
  if (toolName === "Bash") return judgeBash(input, ctx);
  if (FILE_TOOL_PATHS[toolName]) return judgePaths(toolName, input, ctx);
  if (toolName === "WebFetch") return judgeWebFetch(input, ctx);
  if (toolName === "WebSearch") {
    const query = typeof input.query === "string" ? input.query : "";
    return {
      verdict: "ask",
      draft: { kind: "command", category: "network", reason: "searches the web; the search query leaves this machine", command: `WebSearch ${JSON.stringify(query)}`, cwd: "", hosts: [] },
    };
  }
  if (toolName === "AskUserQuestion") return { verdict: "question" };
  if (PLAIN_TOOLS.has(toolName)) return { verdict: "allow" };
  if (toolName.startsWith(RYE_TOOL_PREFIX) && ctx.ryeTools.has(toolName.slice(RYE_TOOL_PREFIX.length))) return { verdict: "allow" };
  return { verdict: "deny", reason: `${toolName} isn't available in a code session.` };
}

function relativeCwd(ctx: JudgeContext): string {
  const rel = relative(ctx.repoDir, ctx.cwd);
  return rel.startsWith("..") || isAbsolute(rel) ? ctx.cwd : rel;
}

function judgeBash(input: Record<string, unknown>, ctx: JudgeContext): ToolJudgement {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return { verdict: "deny", reason: "Bash needs a command." };
  if (input.dangerouslyDisableSandbox === true) {
    return { verdict: "deny", reason: "Commands can't run outside the sandbox in a code session. Run it without dangerouslyDisableSandbox." };
  }
  const v: Verdict = ctx.policy.commandVerdict(command);
  const base = { kind: "command" as const, command, argv: simpleArgv(command), cwd: relativeCwd(ctx) };
  if (v.verdict === "deny") return { verdict: "deny", reason: v.reason };
  if (v.verdict === "ask") {
    return { verdict: "ask", draft: { ...base, category: v.category, reason: v.reason, hosts: v.hosts ?? [], ...(v.pattern ? { pattern: v.pattern } : {}) } };
  }
  if (input.run_in_background === true) {
    // Starting a long-running process needs approval (§3.4); once only, since each one keeps running.
    return { verdict: "ask", draft: { ...base, category: "long_running", reason: "runs in the background and keeps running after this step", hosts: [] } };
  }
  return { verdict: "allow" };
}

/** A path as Claude Code will use it: `~` expanded, relative paths resolved against the session's cwd. */
function absolutePath(path: string, base: string, home: string): string | { refused: string } {
  if (path.includes("\0")) return { refused: "a path with a NUL character" };
  let p = path;
  if (p === "~" || p.startsWith("~/")) p = join(home, p.slice(1));
  else if (p.startsWith("~")) return { refused: `${path} (another user's home)` };
  return isAbsolute(p) ? p : resolve(base, p);
}

function judgePaths(toolName: string, input: Record<string, unknown>, ctx: JudgeContext): ToolJudgement {
  let worst: ToolJudgement = { verdict: "allow" };
  const consider = (j: ToolJudgement) => {
    if (strictness[j.verdict] > strictness[worst.verdict]) worst = j;
  };
  const rawBase = typeof input.path === "string" && input.path ? input.path : undefined;
  const baseAbs = rawBase ? absolutePath(rawBase, ctx.cwd, ctx.home) : ctx.cwd;
  for (const field of FILE_TOOL_PATHS[toolName]) {
    const value = input[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.optional) continue;
      return { verdict: "deny", reason: `${toolName} needs ${field.key}.` };
    }
    if (typeof value !== "string") return { verdict: "deny", reason: `${toolName}'s ${field.key} must be a path.` };
    let path: string | { refused: string };
    if (field.glob) {
      if (typeof baseAbs !== "string") return { verdict: "deny", reason: `${toolName} can't use ${baseAbs.refused}.` };
      path = absolutePath(globBase(value) || ".", baseAbs, ctx.home);
    } else {
      path = absolutePath(value, ctx.cwd, ctx.home);
    }
    if (typeof path !== "string") return { verdict: "deny", reason: `${toolName} can't use ${path.refused}.` };
    const v = ctx.policy.pathVerdict(path, field.op);
    if (v.verdict === "deny") consider({ verdict: "deny", reason: v.reason });
    else if (v.verdict === "ask") {
      consider({ verdict: "ask", draft: { kind: "path", category: "path", reason: v.reason, path, op: field.op, ...(v.pattern ? { pattern: v.pattern } : {}) } });
    }
  }
  return worst;
}

function judgeWebFetch(input: Record<string, unknown>, ctx: JudgeContext): ToolJudgement {
  const url = typeof input.url === "string" ? input.url : "";
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { verdict: "deny", reason: `WebFetch can't fetch ${parsed.protocol} URLs.` };
    host = parsed.hostname;
  } catch {
    return { verdict: "deny", reason: "WebFetch needs a valid URL." };
  }
  // WebFetch runs in Claude Code's own process, outside the sandbox: a local or private host would reach
  // Rye's API (or a metadata service) directly. Never fetched, never approvable.
  if (isLocalHost(host)) return { verdict: "deny", reason: `WebFetch can't fetch ${host}: this machine and private networks are off limits to code sessions.` };
  if (hostAllowed(host, ctx.policy.allowedDomains)) return { verdict: "allow" };
  return {
    verdict: "ask",
    draft: { kind: "command", category: "network", reason: `fetches a page from ${host}; what it says goes to the model`, command: `WebFetch ${url}`, cwd: "", hosts: [host] },
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const isOn = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * How Claude Code would authenticate, from the environment and its config files only (no Claude
 * Code process is started): an API key or token, a cloud provider, or a saved login. Undefined
 * when none is found. On macOS the login itself is in the keychain, which isn't read; the
 * account recorded in `.claude.json` stands for it.
 */
export function claudeAuthSource(env: Record<string, string | undefined>, home: string): string | undefined {
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (isOn(env.CLAUDE_CODE_USE_BEDROCK)) return "Amazon Bedrock";
  if (isOn(env.CLAUDE_CODE_USE_VERTEX)) return "Google Vertex AI";
  if (isOn(env.CLAUDE_CODE_USE_FOUNDRY)) return "Microsoft Foundry";
  const configDir = env.CLAUDE_CONFIG_DIR;
  const globalConfig = readJson(configDir ? join(configDir, ".claude.json") : join(home, ".claude.json"));
  const account = globalConfig?.oauthAccount as { emailAddress?: unknown; organizationName?: unknown } | undefined;
  if (account && typeof account === "object") {
    if (typeof account.emailAddress === "string" && account.emailAddress) return account.emailAddress;
    if (typeof account.organizationName === "string" && account.organizationName) return account.organizationName;
    return "Claude account";
  }
  if (typeof globalConfig?.primaryApiKey === "string") return "Anthropic Console key";
  if (existsSync(join(configDir ?? join(home, ".claude"), ".credentials.json"))) return "Claude account";
  return undefined;
}

function onPath(binary: string, env: Record<string, string | undefined>): boolean {
  return (env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, binary)));
}

/** Whether Claude Code's sandbox can run on this platform: Seatbelt on macOS, bubblewrap (and socat) on Linux. Files only. */
export function platformSandboxStatus(platform: NodeJS.Platform, env: Record<string, string | undefined> = process.env): CodeSandboxStatus {
  if (platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec")
      ? { available: true, mechanism: "seatbelt" }
      : { available: false, mechanism: null, reason: "sandbox-exec is missing from /usr/bin" };
  }
  if (platform === "linux") {
    if (!onPath("bwrap", env)) return { available: false, mechanism: null, reason: "bubblewrap is not installed" };
    if (!onPath("socat", env)) return { available: false, mechanism: null, reason: "socat is not installed (the sandbox's network proxy needs it)" };
    return { available: true, mechanism: "bubblewrap" };
  }
  return { available: false, mechanism: null, reason: platform === "win32" ? "native Windows is not supported" : `${platform} is not supported` };
}

function sdkResolvable(): boolean {
  try {
    import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Events for one consumer, in order; iteration ends after `end()`. */
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

interface EngineState {
  /** Last `total_cost_usd` seen per Claude Code session, so a resumed run can tell what it added. */
  lastTotals: Map<string, number>;
  warned: Set<string>;
}

class ClaudeCodeRun implements CodeRun {
  private readonly events = new EventQueue();
  private readonly input = new InputChannel();
  private readonly abort = new AbortController();
  private readonly stderr = new StderrTail();
  private readonly blocks = new ToolUseBlocks();
  private readonly ryeNames: ReadonlySet<string>;
  private query: Query | null = null;
  private policy: CompiledPolicy;
  private finished = false;
  private interrupted = false;
  private apiError = "";
  private engineSessionId: string | undefined;
  private sessionReported = false;
  /** Messages sent into the run that no result has reported answering yet. */
  private readonly unanswered = new Set<string>();
  private readonly started = new Set<string>();
  private readonly finishedTools = new Set<string>();
  /** API response ids whose text came as stream deltas (so their assistant messages aren't repeated). */
  private readonly streamedResponses = new Set<string>();
  private currentResponse: string | undefined;
  /** The cwd each pending tool call was made in (from the hook), for canUseTool. */
  private readonly callCwds = new Map<string, string>();
  /** Hosts approved once, per tool call, removed when the call finishes. */
  private readonly onceHosts = new Map<string, string[]>();
  private readonly sessionHosts = new Set<string>();
  private appliedDomains: string;
  private lastTotal: number | undefined;
  private runSpend = 0;
  private readonly home: string;
  private readonly onAbort = () => this.finish({ type: "done", reason: "interrupted" });

  constructor(
    private readonly o: CodeRunOptions,
    private readonly deps: ClaudeEngineDeps,
    private readonly state: EngineState,
  ) {
    this.policy = o.policy;
    this.ryeNames = new Set(o.ryeTools.map((t) => t.name));
    this.home = deps.home ?? o.env.HOME ?? homedir();
    this.appliedDomains = this.domains().join(",");
    this.lastTotal = o.resume ? state.lastTotals.get(o.resume) : 0;
    void this.pump();
  }

  [Symbol.asyncIterator](): AsyncIterator<CodeEvent> {
    return this.events[Symbol.asyncIterator]();
  }

  send(text: string): void {
    if (this.finished || !text.trim()) return;
    const uuid = randomUUID();
    this.unanswered.add(uuid);
    // "next": delivered into the running turn between tool rounds.
    this.input.push(sdkUserMessage([{ type: "text", text }], { uuid, priority: "next" }));
  }

  async interrupt(): Promise<void> {
    if (this.finished) return;
    this.interrupted = true;
    const done = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.finished) {
          clearInterval(check);
          resolve();
        }
      }, 20);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, this.deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    });
    try {
      await this.query?.interrupt();
    } catch {
      // Not running any more, or the interrupt failed; closing below covers both.
    }
    await done;
    this.finish({ type: "done", reason: "interrupted" });
  }

  // -------------------------------------------------------------------------

  private emit(event: CodeEvent) {
    if (!this.finished) this.events.push(event);
  }

  private finish(done: DoneEvent) {
    if (this.finished) return;
    this.events.push(done);
    this.finished = true;
    this.events.end();
    this.o.signal.removeEventListener("abort", this.onAbort);
    this.abort.abort();
    this.input.end();
    try {
      this.query?.close();
    } catch {
      // Already gone.
    }
  }

  private domains(): string[] {
    const once = [...this.onceHosts.values()].flat();
    return [...new Set([...this.o.sandbox.network.allowedDomains, ...this.policy.allowedDomains, ...this.sessionHosts, ...once])];
  }

  /** Bring the sandbox's network allowlist up to date after an approval or when a once-approved call ends. */
  private async syncDomains() {
    const domains = this.domains();
    if (domains.join(",") === this.appliedDomains || !this.query) return;
    this.appliedDomains = domains.join(",");
    try {
      // `applyFlagSettings` replaces a top-level key whole, so the full sandbox block goes every time.
      await this.query.applyFlagSettings({ sandbox: sdkSandbox(this.o.sandbox, domains) } as Parameters<Query["applyFlagSettings"]>[0]);
    } catch {
      // The command then runs without the new host and fails its network call, which it reports.
    }
  }

  private judge(toolName: string, input: unknown, cwd: string | undefined): ToolJudgement {
    return judgeToolCall(toolName, input, {
      policy: this.policy,
      repoDir: this.o.workspace.repoDir,
      home: this.home,
      cwd: cwd ?? this.o.workspace.repoDir,
      ryeTools: this.ryeNames,
    });
  }

  private readonly preToolUse: HookCallback = async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.cwd) this.callCwds.set(input.tool_use_id, input.cwd);
    const j = this.judge(input.tool_name, input.tool_input, input.cwd || undefined);
    if (j.verdict === "deny") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: j.reason } };
    }
    if (j.verdict === "ask" || j.verdict === "question") {
      // Claude Code then asks the host: canUseTool turns it into a live prompt.
      const reason = j.verdict === "ask" && "reason" in j.draft ? j.draft.reason : "a question for the user";
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
    }
    // Allowed by Rye's policy: Claude Code's own checks still apply, then canUseTool if it asks.
    return {};
  };

  private readonly postToolUse: HookCallback = async (input): Promise<HookJSONOutput> => {
    if ((input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") && this.onceHosts.delete(input.tool_use_id)) {
      await this.syncDomains();
    }
    if ("tool_use_id" in input && typeof input.tool_use_id === "string") this.callCwds.delete(input.tool_use_id);
    return {};
  };

  private async ask(draft: ApprovalDraft, toolName: string, toolUseId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    const request = { ...draft, id: randomUUID(), sessionId: this.o.workspace.sessionId, toolName, toolUseId } as ApprovalRequest;
    const stopped: ApprovalDecision = { behavior: "deny", reason: "aborted", message: "The run was stopped." };
    if (signal.aborted || this.abort.signal.aborted) return stopped;
    let cleanup = () => {};
    const aborted = new Promise<ApprovalDecision>((resolve) => {
      const onStop = () => resolve(stopped);
      signal.addEventListener("abort", onStop, { once: true });
      this.abort.signal.addEventListener("abort", onStop, { once: true });
      cleanup = () => {
        signal.removeEventListener("abort", onStop);
        this.abort.signal.removeEventListener("abort", onStop);
      };
    });
    try {
      return await Promise.race([this.o.approve(request), aborted]);
    } catch (err) {
      return { behavior: "deny", reason: "user", message: `The approval failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      cleanup();
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const j = this.judge(toolName, input, this.callCwds.get(options.toolUseID));
    if (j.verdict === "allow") return { behavior: "allow", updatedInput: input };
    if (j.verdict === "deny") return { behavior: "deny", message: j.reason };
    if (j.verdict === "question") return this.askQuestions(input, options.toolUseID, options.signal);

    const decision = await this.ask(j.draft, toolName, options.toolUseID, options.signal);
    if (decision.behavior === "deny") return { behavior: "deny", message: decision.message || "The user refused this." };
    if (decision.behavior === "answer") return { behavior: "deny", message: "This needed an approval, not an answer." };
    const hosts = j.draft.kind === "command" && toolName === "Bash" ? j.draft.hosts : [];
    if (decision.scope === "session") {
      this.policy = this.policy.allowForSession(decision.pattern);
      for (const host of hosts) this.sessionHosts.add(host);
    } else if (hosts.length > 0) {
      this.onceHosts.set(options.toolUseID, hosts);
    }
    await this.syncDomains();
    return { behavior: "allow", updatedInput: input };
  };

  private async askQuestions(input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const question = typeof q.question === "string" ? q.question : "";
      if (!question) continue;
      const options = Array.isArray(q.options) ? (q.options as Array<{ label?: unknown }>).map((o) => (typeof o?.label === "string" ? o.label : "")).filter(Boolean) : [];
      const decision = await this.ask({ kind: "question", question, options, multiSelect: q.multiSelect === true }, "AskUserQuestion", toolUseId, signal);
      if (decision.behavior === "deny") return { behavior: "deny", message: decision.message || "The user didn't answer." };
      if (decision.behavior !== "answer") return { behavior: "deny", message: "No answer was given." };
      answers[question] = Array.isArray(decision.answer) ? decision.answer.join(", ") : decision.answer;
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private async runRyeTool(call: RyeMcpCall): Promise<ToolOutcome> {
    if (!this.ryeNames.has(call.name)) return { content: [{ type: "text", text: `${call.name} isn't available in a code session.` }], isError: true };
    try {
      const outcome = await this.o.runRyeTool({ id: call.toolUseId ?? randomUUID(), name: call.name, args: call.arguments ?? {} }, this.abort.signal);
      return { content: outcome.content.length > 0 ? outcome.content : [{ type: "text", text: "(no output)" }], isError: outcome.isError };
    } catch (err) {
      return { content: [{ type: "text", text: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }

  private options(bridge: RyeMcpBridge | null): Options {
    const { limits, sandbox } = this.o;
    const model = this.o.model?.trim();
    return {
      cwd: sandbox.cwd,
      env: claudeCodeEnv(this.o.env, this.deps.processEnv ?? process.env),
      sandbox: sdkSandbox(sandbox, this.domains()),
      // Every ask comes to canUseTool; no bare-name allowedTools (they would skip it).
      permissionMode: "default",
      // The user's and the repo's Claude settings, hooks, skills and MCP servers stay out (the repo's are untrusted).
      settingSources: [],
      strictMcpConfig: true,
      tools: CODE_BUILTIN_TOOLS,
      disallowedTools: CODE_DISALLOWED_TOOLS,
      // Rye writes the prompt text (with its <rye_context>); no @path expansion past the hooks.
      verbatimPrompts: true,
      // No "Co-Authored-By: Claude" trailer (or PR attribution) in the user's history: commits made in a code
      // session are the user's work. Object form, which every Claude Code version accepts (sdk.d.ts `attribution`).
      settings: { attribution: { commit: "", pr: "" } },
      systemPrompt: this.o.systemPrompt ? { type: "preset", preset: "claude_code", append: this.o.systemPrompt } : { type: "preset", preset: "claude_code" },
      ...(model && model !== "default" ? { model } : {}),
      ...(this.o.resume ? { resume: this.o.resume } : {}),
      ...(limits.maxTurns > 0 ? { maxTurns: limits.maxTurns } : {}),
      ...(limits.maxCostUsd > 0 ? { maxBudgetUsd: limits.maxCostUsd } : {}),
      // Kept so a session can be resumed after a restart and continued in a terminal (§9.7).
      persistSession: true,
      includePartialMessages: true,
      abortController: this.abort,
      ...(bridge ? { mcpServers: { [RYE_MCP_SERVER]: bridge.config() } } : {}),
      canUseTool: this.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse], timeout: HOOK_TIMEOUT_S, onFailure: "block" }],
        PostToolUse: [{ hooks: [this.postToolUse] }],
        PostToolUseFailure: [{ hooks: [this.postToolUse] }],
      },
      stderr: (data) => this.stderr.push(data),
    };
  }

  private refusal(): string | undefined {
    const { sandbox, workspace } = this.o;
    if (sandbox.failIfUnavailable !== true || sandbox.allowUnsandboxedCommands !== false) {
      return "The sandbox plan must refuse to run unsandboxed (failIfUnavailable, no unsandboxed commands).";
    }
    // Compare real paths: the sandbox plan is canonical (symlinks resolved, e.g. macOS /var → /private/var)
    // while the workspace keeps the path it was given, so a plain resolve() refused every session under a link.
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    if (real(sandbox.cwd) !== real(workspace.repoDir)) return "The sandbox's working directory must be the workspace's repo.";
    if (!sandbox.filesystem.allowWrite.some((p) => real(p) === real(workspace.repoDir))) {
      return "The sandbox must allow writes to the workspace's repo.";
    }
    return undefined;
  }

  private async firstMessage(): Promise<UserBlock[]> {
    const blocks: UserBlock[] = [{ type: "text", text: this.o.input.text || "Continue." }];
    if (!this.deps.readAttachmentImage) return blocks;
    for (const attachment of this.o.input.attachments) {
      if (attachment.kind !== "image") continue;
      try {
        const image = await this.deps.readAttachmentImage(attachment);
        if (image) blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
      } catch {
        // The <rye_context> line still describes it.
      }
    }
    return blocks;
  }

  private async pump() {
    if (this.o.signal.aborted) return this.finish({ type: "done", reason: "interrupted" });
    this.o.signal.addEventListener("abort", this.onAbort, { once: true });
    const refused = this.refusal();
    if (refused) return this.finish({ type: "done", reason: "error", error: refused });

    try {
      const bridge = this.o.ryeTools.length > 0 ? new RyeMcpBridge(this.o.ryeTools, (call) => this.runRyeTool(call)) : null;
      this.query = (this.deps.query ?? sdkQuery)({ prompt: this.input, options: this.options(bridge) });
      const uuid = randomUUID();
      this.unanswered.add(uuid);
      this.input.push(sdkUserMessage(await this.firstMessage(), { uuid }));

      while (!this.finished) {
        const next = await this.query.next();
        if (this.finished) break;
        if (next.done) {
          if (this.interrupted || this.o.signal.aborted) return this.finish({ type: "done", reason: "interrupted" });
          const detail = this.apiError || this.stderr.text();
          return this.finish({ type: "done", reason: "error", error: `Claude Code exited before finishing.${detail ? `\n${detail}` : ""}` });
        }
        this.handle(next.value as SDKMessage);
      }
    } catch (err) {
      if (this.interrupted || this.o.signal.aborted) return this.finish({ type: "done", reason: "interrupted" });
      const detail = this.stderr.text();
      this.finish({ type: "done", reason: "error", error: `${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ""}` });
    }
  }

  private startTool(id: string, name: string, args: unknown) {
    if (this.started.has(id)) return;
    this.started.add(id);
    this.emit({ type: "tool_start", id, name: name.startsWith(RYE_TOOL_PREFIX) ? name.slice(RYE_TOOL_PREFIX.length) : name, args });
  }

  private handle(m: SDKMessage) {
    if (m.type === "system" && m.subtype === "init") {
      this.engineSessionId = m.session_id;
      if (this.sessionReported) return;
      this.sessionReported = true;
      const warning = claudeCodeVersionProblem(m.claude_code_version);
      if (warning && !this.state.warned.has(warning)) {
        this.state.warned.add(warning);
        (this.deps.onWarning ?? console.warn)(`[code] ${warning}`);
      }
      this.emit({ type: "engine_session", id: m.session_id, ...(m.claude_code_version ? { version: m.claude_code_version } : {}), ...(warning ? { warning } : {}) });
    } else if (m.type === "stream_event") {
      // Subagents are disallowed; skip their output if any ever arrives.
      if (m.parent_tool_use_id) return;
      const ev = m.event as StreamEvent;
      if (ev.type === "message_start") {
        this.blocks.reset();
        this.currentResponse = ev.message?.id;
      } else if (ev.type === "content_block_start" && ev.index !== undefined && ev.content_block) {
        this.blocks.start(ev.index, ev.content_block);
      } else if (ev.type === "content_block_delta" && ev.index !== undefined && ev.delta) {
        if (this.blocks.delta(ev.index, ev.delta)) return;
        if (ev.delta.type === "text_delta" && ev.delta.text) {
          if (this.currentResponse) this.streamedResponses.add(this.currentResponse);
          this.emit({ type: "text", delta: ev.delta.text });
        }
      } else if (ev.type === "content_block_stop" && ev.index !== undefined) {
        const call = this.blocks.stop(ev.index);
        if (call) this.startTool(call.id, call.name, call.args);
      }
    } else if (m.type === "assistant") {
      if (m.parent_tool_use_id) return;
      if (m.error) {
        this.apiError = assistantErrorText(m);
        return;
      }
      // Without stream deltas (or for blocks they missed), the whole message carries the same content.
      const content = (m.message.content ?? []) as Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }>;
      const streamed = m.message.id ? this.streamedResponses.has(m.message.id) : false;
      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) this.startTool(block.id, block.name, block.input ?? {});
        else if (block.type === "text" && block.text && !streamed) this.emit({ type: "text", delta: block.text });
      }
    } else if (m.type === "user") {
      if (m.parent_tool_use_id) return;
      for (const block of toolResultBlocks(m)) {
        if (!block.id || this.finishedTools.has(block.id)) continue;
        this.finishedTools.add(block.id);
        this.emit({ type: "tool_result", id: block.id, content: clip(toolResultText(block.content), RESULT_CHARS), isError: block.isError });
      }
    } else if (m.type === "result") {
      this.handleResult(m);
    }
  }

  private handleResult(m: SDKResultMessage) {
    const total = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
    let costUsd: number | undefined;
    if (total !== undefined) {
      if (this.lastTotal !== undefined) costUsd = Math.max(0, total - this.lastTotal);
      this.lastTotal = total;
      if (this.engineSessionId) this.state.lastTotals.set(this.engineSessionId, total);
      if (costUsd !== undefined) this.runSpend += costUsd;
    }
    const u = m.usage;
    if (u) {
      this.emit({
        type: "usage",
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(total !== undefined ? { totalCostUsd: total } : {}),
      });
    }

    const consumed = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : undefined);
    for (const uuid of consumed ?? []) this.unanswered.delete(uuid);
    const apiError = this.apiError;
    this.apiError = "";

    if (this.interrupted) return this.finish({ type: "done", reason: "interrupted" });
    if (m.subtype === "error_max_turns") {
      return this.finish({ type: "done", reason: "max_turns", limit: "max_turns", error: `Reached the limit of ${this.o.limits.maxTurns} turns.` });
    }
    if (m.subtype === "error_max_budget_usd") {
      return this.finish({ type: "done", reason: "max_turns", limit: "max_cost_usd", error: `Reached the cost limit of $${this.o.limits.maxCostUsd.toFixed(2)}.` });
    }
    if (m.subtype !== "success" || m.is_error) return this.finish({ type: "done", reason: "error", error: `Claude: ${resultErrorDetail(m, apiError)}` });

    // More turns follow when messages sent into the run are still waiting for theirs.
    const more = consumed !== undefined ? this.unanswered.size > 0 && m.queued_turn_count !== 0 : (m.queued_turn_count ?? 0) > 0;
    if (!more) return this.finish({ type: "done", reason: "end" });
    const max = this.o.limits.maxCostUsd;
    if (max > 0 && this.runSpend >= max) {
      return this.finish({ type: "done", reason: "max_turns", limit: "max_cost_usd", error: `Reached the cost limit of $${max.toFixed(2)} ($${this.runSpend.toFixed(2)} spent).` });
    }
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** The `claude` code engine. */
export function claudeCodeEngine(deps: ClaudeEngineDeps = {}): CodeEngine {
  const state: EngineState = { lastTotals: new Map(), warned: new Set() };
  return {
    id: CLAUDE_ENGINE_ID,
    capabilities: { resume: true, liveApprovals: true, ownSandbox: true },
    async models() {
      return deps.models ? deps.models() : [...CLAUDE_MODEL_ALIASES];
    },
    async availability(): Promise<CodeEngineAvailability> {
      if (!(await (deps.sdkInstalled ?? sdkResolvable)())) return { available: false, reason: "The Claude Agent SDK isn't installed." };
      const sandbox = deps.sandboxProbe ? await deps.sandboxProbe() : platformSandboxStatus(deps.platform ?? process.platform, deps.processEnv ?? process.env);
      if (!sandbox.available) return { available: false, reason: `The sandbox can't run here: ${sandbox.reason ?? "unknown reason"}.` };
      const account = claudeAuthSource(deps.processEnv ?? process.env, deps.home ?? homedir());
      if (!account) return { available: false, reason: "Claude Code isn't signed in. Run `claude` and /login, or set ANTHROPIC_API_KEY." };
      return { available: true, account };
    },
    start(o: CodeRunOptions): CodeRun {
      return new ClaudeCodeRun(o, deps, state);
    },
  };
}
