/**
 * Code sessions: the contract between the backend modules (docs/design/code-sessions.md,
 * "Implementation contract"). Types only, plus the few constants the design pins down.
 *
 * Who owns what:
 * - `code/policy.ts`: `compilePolicy` → `CompiledPolicy` (`commandVerdict`, `pathVerdict`).
 * - `code/sandbox.ts`: `SandboxPlan` and the engine's scrubbed env.
 * - `code/workspace.ts`: `Workspace` (clone, pin, snapshot, archive/restore, disk).
 * - `code/git.ts`: `CodeGit` (hardened git, diff → hunks, merge-tree, create-only update-ref).
 * - `code/engine.ts`, `code/engines/*`: `CodeEngine`.
 * - `code/runner.ts`, `code/store.ts`, `code/routes.ts`: runs, `CodeSessionRecord`, `/code/` routes.
 *
 * Shapes the web app also reads (git results, status, kinds) are defined once in
 * `@rye/shared` (`packages/shared/src/code.ts`) and re-exported here.
 *
 * Change this file only by agreement: the lead reviews.
 */

import type { Tool } from "@earendil-works/pi-ai";
import type {
  BranchStatus,
  ChangesSince,
  ChatKind,
  CodeEngineAvailability,
  CodeEngineCapabilities,
  CodeEngineId,
  CodeIsolation,
  CodePolicyRule,
  CodeSandboxStatus,
  CodeSessionState,
  DiffFile,
  DiffStat,
  MergeResult,
  SSEEvent,
  SnapshotRef,
} from "@rye/shared";
import type { Attachment } from "../chat/attachments.js";
import type { ChatHistoryRecord } from "../chat/store.js";

export type {
  BranchStatus,
  ChangesSince,
  ChatKind,
  CheckResult,
  CodeActivity,
  CodeCheckSummary,
  CodeCommandEntry,
  CodeEngineAvailability,
  CodeEngineCapabilities,
  CodeEngineId,
  CodeIsolation,
  CodePolicyRule,
  CodeSandboxStatus,
  CodeSessionState,
  CodeSessionStatus,
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  DiffStat,
  FileStage,
  MergeConflict,
  MergeResult,
  SensitiveFlag,
  SensitiveKind,
  SnapshotRef,
} from "@rye/shared";

// ===========================================================================
// Constants the design pins down
// ===========================================================================

/** The only ref namespace Rye writes in the user's repo besides new `rye/*` branches (§3.1). */
export const RYE_REF_PREFIX = "refs/rye/";

/** Branches Rye creates: in the clone, and (only new ones, create-only) in the user's repo. */
export const RYE_BRANCH_PREFIX = "rye/";

/**
 * Global options on every git command Rye itself runs (§3.5, "Hardened git"), before the
 * subcommand. The clone's `.git/config` is written by the agent, so without these Rye's own,
 * unsandboxed git calls could run its hooks, fsmonitor or ssh command.
 */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.sshCommand=false",
  // No credential helpers, and no transport at all (Rye's own git never fetches or pushes).
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  // No user-wide attributes or ignore files (filters are named by attributes).
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  // No signing or signature checks (gpg.program would run), no pager, no auto gc, no submodule recursion.
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "log.showSignature=false",
  "-c", "core.pager=cat",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "submodule.recurse=false",
];

/** Options added to every diff-producing command Rye runs (`diff`, `log -p`, `show`). */
export const HARDENED_GIT_DIFF_OPTIONS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

/**
 * Environment for every git command Rye runs, on top of a scrubbed base (no inherited `GIT_*`):
 * no system config, an empty global config (`/dev/null`), and never a terminal prompt.
 */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

// ===========================================================================
// Configuration: `[code]` in config.toml (§7)
// ===========================================================================

/** Editors "Open in editor" can link to. */
export type CodeEditor = "vscode" | "cursor" | "zed" | "none";

/**
 * `[code.policy]`, and a repo's own `policy`: rules **added** to the built-in policy. The
 * built-in deny list can't be removed by any of them.
 *
 * Patterns are matched against a whole simple command (after splitting on `; && || |`), with `*`
 * matching any run of characters: `bun test *`. Precedence: deny, then ask, then allow; built-in
 * deny always wins.
 *
 * Defaults: every list empty. (§7's `allow = ["bun test *", …]` / `ask = ["bun run dev *"]` are
 * an example for the Rye repo, not defaults.)
 */
export interface PolicyConfig {
  /** Hosts sandboxed commands may reach without asking. Default `[]`: network is denied, and each approval allows only its own hosts. */
  allowed_domains: string[];
  /** Commands allowed without asking. Default `[]`. */
  allow: string[];
  /** Commands that always ask. Default `[]`. */
  ask: string[];
  /** Commands always refused. Default `[]`. */
  deny: string[];
}

/** One `[[code.repos]]` entry. Code sessions run only on repos listed here (not on `code_search.repos`). */
export interface CodeRepoConfig {
  /** Unique name, shown in the picker. */
  name: string;
  /** The user's checkout (`~` expanded by config.ts). */
  path: string;
  /** Default base branch. Default: the branch checked out in `path`. */
  base?: string;
  /** Default `"clone"`. */
  isolation: CodeIsolation;
  /** Commands run once in a new workspace (installs need approval, §3.4). Default `[]`. */
  setup: string[];
  /** Commands run by Rye in the sandbox for the Checks tab. Default `[]`. */
  checks: string[];
  /** This repo's own rules, added to `[code.policy]` ("the repo's overrides", §3.4). Default: none. */
  policy?: PolicyConfig;
  /** Extra paths sandboxed commands may write, for toolchains that need them (§8 risks). Default `[]`. */
  allow_write?: string[];
}

/** `[code]`. Defaults in `CODE_CONFIG_DEFAULTS`. */
export interface CodeConfig {
  /** Default `true` (still useless until a repo is listed). */
  enabled: boolean;
  /** Default `"claude"`. */
  engine: CodeEngineId;
  /** Default `""`: `claude.model` for the Claude engine, else the engine's default. */
  model: string;
  /** Where session directories go. Default `""`: `DATA_DIR/code`. */
  worktree_root: string;
  /** Active sessions at once. Default `6`. */
  max_sessions: number;
  /** Idle sessions are archived (never deleted) after this many days. Default `14`. */
  archive_after_days: number;
  /** An unanswered live prompt is denied after this many minutes. Default `30`. */
  approval_timeout_minutes: number;
  /** Turns per run before asking to continue. Default `200`. */
  max_turns: number;
  /** Cost per run in USD before asking to continue. Default `5`. */
  max_cost_usd: number;
  /** Default `"vscode"`. */
  editor: CodeEditor;
  /** The GitHub Copilot CLI for `acp:copilot` (phase 1.5). Default `""`: `copilot` on PATH. */
  copilot_path?: string;
  policy: PolicyConfig;
  /** Default `[]`. */
  repos: CodeRepoConfig[];
}

/** The defaults of §7, for config.ts's schema. */
export const CODE_CONFIG_DEFAULTS: Readonly<CodeConfig> = {
  enabled: true,
  engine: "claude",
  model: "",
  worktree_root: "",
  max_sessions: 6,
  archive_after_days: 14,
  approval_timeout_minutes: 30,
  max_turns: 200,
  max_cost_usd: 5,
  editor: "vscode",
  policy: { allowed_domains: [], allow: [], ask: [], deny: [] },
  repos: [],
};

// ===========================================================================
// Workspace (code/workspace.ts)
// ===========================================================================

/**
 * A session's directories under `<worktree_root>/<session-id>/` (§3.1):
 *
 * ```
 * repo/    the clone (cwd of the engine); the only place file tools may write
 * tmp/     TMPDIR for the engine and its commands
 * cache/   BUN_INSTALL_CACHE_DIR, npm_config_cache, XDG_CACHE_HOME; cache/bin holds the git shim
 * events.jsonl, session.json
 * ```
 */
export interface WorkspacePaths {
  /** `<worktree_root>/<session-id>`. */
  sessionDir: string;
  /** `sessionDir/repo`: the clone (or, with `isolation = "worktree"`, the worktree). The engine's cwd. */
  repoDir: string;
  /** `sessionDir/tmp`. */
  tmpDir: string;
  /** `sessionDir/cache`. */
  cacheDir: string;
  /** `cacheDir/bin`: put first on PATH; holds the `git` shim (messages only, not a boundary). */
  binDir: string;
  /** `sessionDir/events.jsonl`: the append-only event log (`CodeLogEntry` per line). */
  eventsFile: string;
  /** `sessionDir/session.json`. */
  sessionFile: string;
}

/** A session's workspace: its paths plus where it came from. Never refers to the user's checkout as a place to write. */
export interface Workspace extends WorkspacePaths {
  /** The code session id. */
  sessionId: string;
  /** `[[code.repos]] name`. */
  repoName: string;
  /** The user's checkout (read-only to everything but Rye's own create-only ref writes). */
  userRepoPath: string;
  /** The user's git dir (`<userRepoPath>/.git`, or what `git rev-parse --git-dir` says). */
  userGitDir: string;
  /** `<userGitDir>/objects`: read by the clone through `objects/info/alternates`; readable, never writable, in the sandbox. */
  userObjectsDir: string;
  isolation: CodeIsolation;
  /** The base as the user named it ("main"). */
  baseRef: string;
  /** The commit the session started from: the base's tip, or a `git stash create` commit with uncommitted changes. */
  baseSha: string;
  /** The base includes the user's uncommitted changes. */
  includeUncommitted: boolean;
  /** Short name used in branch names. */
  slug: string;
  /** The clone's branch: `rye/<slug>`. */
  branch: string;
  /** `refs/rye/<session-id>/`: every ref Rye keeps for this session in the user's repo. */
  refPrefix: string;
  /** `refs/rye/<session-id>/base`: pins `baseSha` so the clone's objects can't be pruned. */
  baseRefPin: string;
  /**
   * The base branch had no commits at creation (HEAD was a symbolic ref to a branch that didn't
   * exist yet). The session then starts from `emptyRootSha`, an empty root commit Rye wrote in the
   * user's object store; `baseSha` is that commit, or the user's staged files on top of it.
   * Absent in sessions made before this field existed (their base always had commits).
   */
  baseUnborn?: boolean;
  /** With `baseUnborn`: the empty root commit ("Empty project"), the first commit of the session's history. */
  emptyRootSha?: string;
}

/** What `createWorkspace` needs. */
export interface CreateWorkspaceOptions {
  sessionId: string;
  repo: CodeRepoConfig;
  /** Default `repo.base`, else the checked-out branch. */
  base?: string;
  slug: string;
  includeUncommitted: boolean;
  /** `[code] worktree_root`, resolved (blank → `DATA_DIR/code`). */
  root: string;
}

/** code/workspace.ts. Every git call goes through `CodeGit`'s hardened runner. */
export interface WorkspaceManager {
  /** Clone `--shared --no-checkout`, check out `rye/<slug>` at the base, remove `origin`, pin the base, make tmp/ and cache/. */
  create(o: CreateWorkspaceOptions): Promise<Workspace>;
  /** Commit the clone's state without touching its working tree and store it as `refs/rye/<id>/turn-<turn>` in the user's repo. */
  snapshot(ws: Workspace, turn: number): Promise<SnapshotRef>;
  /** All of the session's snapshots, oldest first. */
  snapshots(ws: Workspace): Promise<SnapshotRef[]>;
  /** Remove `repo/` (and tmp/, cache/), keep the refs. */
  archive(ws: Workspace): Promise<void>;
  /** Re-clone from the last snapshot (or the base when there is none). */
  restore(ws: Workspace): Promise<Workspace>;
  /** Remove the session directory and `refs/rye/<id>/*`; never a `rye/*` branch the user created. Returns refs removed. */
  remove(ws: Workspace): Promise<number>;
  /** Bytes used by the session directory. */
  diskUsage(ws: Workspace): Promise<number>;
}

// ===========================================================================
// Git (code/git.ts)
// ===========================================================================

/** The result of one git command Rye ran. */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs git with fixed argv, no shell, `HARDENED_GIT_CONFIG` before the subcommand,
 * `HARDENED_GIT_ENV` on a scrubbed env, and an explicit user.name/user.email.
 */
export type GitRunner = (
  args: readonly string[],
  opts: {
    cwd: string;
    input?: string;
    signal?: AbortSignal;
    /** Extra `GIT_*` variables for this call (`GIT_INDEX_FILE`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`); `HARDENED_GIT_ENV` always wins. */
    env?: Readonly<Record<string, string>>;
  },
) => Promise<GitResult>;

/** code/git.ts: everything Rye reads from or writes to a session's git state. */
export interface CodeGit {
  /** The session branch against its base and the base's current tip. */
  status(ws: Workspace): Promise<BranchStatus>;
  /** Every changed file since `since`, without hunks, with sensitive flags. */
  changes(ws: Workspace, since: ChangesSince): Promise<{ files: DiffFile[]; stat: DiffStat }>;
  /** One file with its parsed hunks, or null when it didn't change. */
  fileDiff(ws: Workspace, path: string, since: ChangesSince): Promise<DiffFile | null>;
  /** Stage (`true`) or unstage files in the clone. */
  stage(ws: Workspace, paths: string[], staged: boolean): Promise<void>;
  /** Drop files' uncommitted changes in the clone (the caller snapshots first). */
  discard(ws: Workspace, paths: string[]): Promise<void>;
  /**
   * Create branch: `update-ref refs/heads/<name> <sha> ""` in the user's repo (create only, fail if
   * it exists). `squash` writes one commit on the base with `message` first.
   */
  createBranch(ws: Workspace, o: { name: string; mode: "keep" | "squash"; message?: string }): Promise<{ status: "created"; branch: string; sha: string; commits: number } | { status: "branch_exists"; branch: string }>;
  /** Merge with latest base: `merge-tree --write-tree`, two-parent `commit-tree`, create-only new branch. Never touches the user's index or working tree. */
  mergeWithBase(ws: Workspace, o: { name: string; message: string }): Promise<MergeResult>;
}

// ===========================================================================
// Policy (code/policy.ts)
// ===========================================================================

/** The file operation a path is checked for. */
export type PathOp = "read" | "write";

/**
 * Why something needs the user (§3.4):
 * - `network`: reaches a host not on the allowlist (curl, wget, git fetch/pull, …)
 * - `install`: a package install or fetch (bun/npm/pnpm/yarn install|add, pip install, cargo fetch, go mod download)
 * - `unparseable`: can't be judged statically (`eval`, `bash -c`, `$(…)` as a command name, xargs running git, …)
 * - `rule`: matched an `ask` pattern in `[code.policy]` or the repo's policy
 * - `long_running`: starts a server or watcher (`dev`, `serve`)
 * - `path`: a file tool reading outside the workspace and the known toolchain directories
 */
export type AskCategory = "network" | "install" | "unparseable" | "rule" | "long_running" | "path";

/**
 * A policy judgement. `deny` is final (a `PreToolUse` deny holds even under bypass); `ask` becomes
 * a live prompt; `allow` runs (inside the sandbox, which is what makes the default allow safe).
 */
export type Verdict =
  | {
      verdict: "allow";
      /** The rule that allowed it, when one did (absent for the sandboxed default). */
      rule?: string;
    }
  | {
      verdict: "deny";
      /** Shown to the agent and in the Terminal tab: "git push is never allowed in a code session". */
      reason: string;
      rule?: string;
    }
  | {
      verdict: "ask";
      /** Why it needs asking, written by Rye: "installs packages from registry.npmjs.org; dependency scripts may run in the sandbox". */
      reason: string;
      category: AskCategory;
      /** Hosts the command would be allowed to reach if approved. */
      hosts?: string[];
      /** The pattern offered for "Allow "<pattern>" for this session" (absent: only once/deny). */
      pattern?: string;
      rule?: string;
    };

/** Paths the policy needs beyond the workspace's own. */
export interface PolicyScope {
  /** The user's home directory (for `~/.ssh`, `~/.aws`, … in denyRead). */
  home: string;
  /** Rye's data dir (denied except this session's directory). */
  dataDir: string;
  /** Rye's config dir (denied). */
  configDir: string;
  /** Toolchain directories reads are allowed in (`~/.bun`, `/usr/local`, …). */
  toolchainDirs: string[];
}

/**
 * A policy compiled for one workspace. Pure and synchronous apart from `pathVerdict`'s realpath
 * of the deepest existing ancestor, so it can be table-tested.
 */
export interface CompiledPolicy {
  /**
   * Judge one Bash command line. Tokenised with a real shell tokenizer and split on
   * `; && || |` and subshells; the verdict is the strictest of the parts (deny > ask > allow).
   */
  commandVerdict(cmd: string): Verdict;
  /**
   * Judge a file tool's path (Read, Edit, Write, NotebookEdit, Glob/Grep). Resolved against
   * `repoDir`; NUL and `..` segments refused; writes only under `repoDir` (realpath of the deepest
   * existing ancestor, and a final symlink pointing outside is refused); reads under `repoDir`,
   * `userObjectsDir` and toolchain dirs, never on the denyRead list.
   */
  pathVerdict(path: string, op: PathOp): Verdict;
  /**
   * The same policy plus an "Allow "<pattern>" for this session" approval. `hosts` (the approved
   * request's `hosts`) join `allowedDomains` for the rest of the session. A pattern starting with
   * `read:` (`read:/abs/dir/*`, offered by `pathVerdict`'s asks) allows file-tool reads instead.
   */
  allowForSession(pattern: string, hosts?: readonly string[]): CompiledPolicy;
  /** The effective rules, built-ins first (Settings → Code). */
  readonly rules: readonly CodePolicyRule[];
  /** Hosts allowed without asking (`allowed_domains` plus session approvals). */
  readonly allowedDomains: readonly string[];
}

/** code/policy.ts's entry point. `repo.policy` is added to `config`. */
export type CompilePolicy = (config: PolicyConfig, repo: CodeRepoConfig, ws: Workspace, scope: PolicyScope) => CompiledPolicy;

// ===========================================================================
// Sandbox (code/sandbox.ts)
// ===========================================================================

/**
 * The OS sandbox for a run, engine-neutral (§3.2, §3.3). Absolute paths throughout.
 *
 * Claude engine mapping (Agent SDK `Options`):
 * ```
 * cwd: plan.cwd
 * sandbox: {
 *   enabled: true,
 *   failIfUnavailable: true,            // no sandbox, no code session
 *   allowUnsandboxedCommands: false,    // dangerouslyDisableSandbox is ignored
 *   autoAllowBashIfSandboxed: false,    // Rye's PreToolUse hook judges every command
 *   network: { allowedDomains, allowLocalBinding },
 *   filesystem: { allowWrite, denyWrite, allowRead, denyRead },
 * }
 * ```
 * No `network.allowMachLookup` entries, so keychain lookups stay denied. Claude Code's protected
 * paths (`.git/hooks`, `.claude/settings*.json`, `.mcp.json`, `.gitconfig`) stay protected on top.
 *
 * ACP / pi engines (phase 1.5+): the same plan becomes a `sandbox-runtime` (`srt`) profile around
 * the whole engine process (`ownSandbox: false`), with the model provider's API host added to
 * `allowedDomains`.
 */
export interface SandboxPlan {
  /** Always true: refuse to run rather than run unsandboxed. */
  failIfUnavailable: true;
  /** Always false: commands can't opt out of the sandbox. */
  allowUnsandboxedCommands: false;
  /** The working directory: `Workspace.repoDir`. */
  cwd: string;
  filesystem: {
    /** `repoDir`, `tmpDir`, `cacheDir`, plus the repo's `allow_write`. Nothing else. */
    allowWrite: string[];
    /** Inside allowed areas but still not writable (e.g. the user's git dir in worktree mode). */
    denyWrite: string[];
    /** Re-allowed inside denyRead areas: this session's directory under `DATA_DIR`. */
    allowRead: string[];
    /** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.config/gh`, Rye's config dir, `DATA_DIR`, `~/.claude`. Best effort. */
    denyRead: string[];
  };
  network: {
    /** Hosts reachable through the proxy: `allowed_domains`, session approvals, and the current approval's hosts. Empty denies all. */
    allowedDomains: string[];
    /** Let commands listen on localhost (test servers). */
    allowLocalBinding: boolean;
  };
}

/** code/sandbox.ts's builder. */
export type BuildSandboxPlan = (ws: Workspace, policy: CompiledPolicy, repo: CodeRepoConfig, scope: PolicyScope) => SandboxPlan;

/**
 * The variables a workspace adds to the engine's scrubbed env (§3.1, §3.6): `TMPDIR = tmpDir`,
 * `BUN_INSTALL_CACHE_DIR`, `npm_config_cache`, `XDG_CACHE_HOME` under `cacheDir`, and PATH with
 * `binDir` first. The Claude engine's env is `claudeEnv({ overrides: workspaceEnv(ws) })`
 * (`harness/env.ts`).
 */
export type WorkspaceEnv = (ws: Workspace) => Record<string, string>;

/** Whether the sandbox can run here (Settings → Code, the `code` tool group's availability). */
export type SandboxProbe = () => Promise<CodeSandboxStatus>;

// ===========================================================================
// Approvals
// ===========================================================================

interface ApprovalRequestBase {
  /** The live prompt's id (`SSEEvent.prompt_id`, `:promptId` in the approvals route). */
  id: string;
  /** The code session. */
  sessionId: string;
  /** The engine's tool name ("Bash", "Edit", "AskUserQuestion"), when a tool call asked. */
  toolName?: string;
  /** The engine's tool-use id, when a tool call asked. */
  toolUseId?: string;
}

/**
 * Something an engine (or the runner) needs the user to decide, built by Rye from the parsed
 * call, never from the agent's prose. The runner renders it as a live `PendingPrompt` with the
 * labels `Allow once` / `Allow "<pattern>" for this session` / `Deny` (`APPROVE_ONCE`, `DENY` in
 * `mcp/approval.ts`).
 */
export type ApprovalRequest =
  | (ApprovalRequestBase & {
      kind: "command";
      category: AskCategory;
      /** Why, from the verdict. */
      reason: string;
      /** The exact command text. */
      command: string;
      /** The parsed argv, when it is one simple command. */
      argv?: string[];
      /** Working directory relative to the repo root ("" for the root). */
      cwd: string;
      /** Hosts it will be allowed to reach if approved. */
      hosts: string[];
      /** Offered for "Allow for this session"; absent: once or deny only. */
      pattern?: string;
    })
  | (ApprovalRequestBase & {
      kind: "path";
      category: "path";
      reason: string;
      /** The resolved absolute path. */
      path: string;
      op: PathOp;
      pattern?: string;
    })
  | (ApprovalRequestBase & {
      /** A run reached `max_turns` or `max_cost_usd`: continue? */
      kind: "budget";
      limit: "max_turns" | "max_cost_usd";
      /** Turns run, or USD spent, so far. */
      used: number;
      /** The configured limit. */
      max: number;
    })
  | (ApprovalRequestBase & {
      /** The agent asked the user a question (`AskUserQuestion`); one request per question. */
      kind: "question";
      question: string;
      /** Choices; empty for a free-text answer. */
      options: string[];
      multiSelect?: boolean;
    });

/** The user's (or the timeout's) answer to an `ApprovalRequest`. */
export type ApprovalDecision =
  | { behavior: "allow"; scope: "once" }
  | {
      behavior: "allow";
      scope: "session";
      /** Added to the session's policy (`CompiledPolicy.allowForSession`). */
      pattern: string;
    }
  | {
      /** The answer to a `question` request: the chosen option(s) or typed text. */
      behavior: "answer";
      answer: string | string[];
    }
  | {
      behavior: "deny";
      /** `timeout`: unanswered after `approval_timeout_minutes`; `aborted`: the run was stopped. */
      reason: "user" | "timeout" | "aborted";
      /** What the agent is told. */
      message: string;
    };

// ===========================================================================
// Engine (code/engine.ts)
// ===========================================================================

/** A Rye tool call coming through the in-process MCP bridge. */
export interface RyeToolCall {
  /** The engine's tool-use id. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** What a bridged Rye tool returns to the engine. */
export interface RyeToolOutcome {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
}

/** Everything one run needs. Built by the runner. */
export interface CodeRunOptions {
  /** cwd is `repoDir`; never the user's checkout. */
  workspace: Workspace;
  /** The user's message, with its `<rye_context>` block, and its files. */
  input: { text: string; attachments: Attachment[] };
  /** Stable for the whole session (the repo's AGENTS.md/CLAUDE.md go here as instructions, not settings). */
  systemPrompt: string;
  /** The engine session to continue (`CodeEvent` `engine_session`). */
  resume?: string;
  /** Blank or absent: the engine's default. */
  model?: string;
  policy: CompiledPolicy;
  /** The OS sandbox for this run. */
  sandbox: SandboxPlan;
  /** A live prompt in Rye's UI; resolves when answered, timed out or aborted. */
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** Rye tools bridged as an in-process MCP server: knowledge/SOP/memory search, `run_checks`. Never SQL, AWS or Jira. */
  ryeTools: Tool[];
  /** Runs one of `ryeTools`. */
  runRyeTool(call: RyeToolCall, signal: AbortSignal): Promise<RyeToolOutcome>;
  /** The engine's whole environment, already scrubbed (`claudeEnv` + `workspaceEnv`). */
  env: Record<string, string>;
  /** Run limits; reaching one ends the run with `done` `max_turns` (the runner asks to continue). */
  limits: { maxTurns: number; maxCostUsd: number };
  /** Aborts the run (Stop, delete, shutdown). */
  signal: AbortSignal;
}

/**
 * What an engine reports while it runs. `args` is engine-specific. The runner logs these and
 * translates them into `SSEEvent`s (`token`, `tool_start`, `tool_result`, `usage`, `done`).
 */
export type CodeEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  /** Output as the engine streams it, when it does. */
  | { type: "tool_output"; id: string; chunk: string }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  /**
   * The engine's own session id, for resume; `version` is the engine's version when it reports one
   * (`claude_code_version`); `warning` when that version is outside the range Rye was tested with.
   */
  | { type: "engine_session"; id: string; version?: string; warning?: string }
  /**
   * One model turn's tokens. `costUsd`: what this turn added (absent when the engine can't tell,
   * e.g. the first turn of a resumed session after a restart); `totalCostUsd`: the engine
   * session's running total as the engine reports it, which on a resumed session can include
   * earlier runs.
   */
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number; totalCostUsd?: number }
  /** `limit`: with `max_turns`, which limit ended the run, so the runner can ask to continue (`ApprovalRequest` `budget`). */
  | { type: "done"; reason: "end" | "interrupted" | "max_turns" | "error"; error?: string; limit?: "max_turns" | "max_cost_usd" };

/** A running turn. Iterating yields its events and ends after `done`. */
export interface CodeRun extends AsyncIterable<CodeEvent> {
  /** Steer while running: a user message delivered into the live turn. */
  send(text: string): void;
  /** Stop the turn; it then yields `done` with `interrupted`. */
  interrupt(): Promise<void>;
}

/** A coding agent behind Rye's policy, sandbox and UI. Registered in `CODE_ENGINES`. */
export interface CodeEngine {
  id: CodeEngineId;
  capabilities: CodeEngineCapabilities;
  /** Models it offers. */
  models(): Promise<string[]>;
  /** Whether it can be used here (signed in, CLI found, org policy). */
  availability(): Promise<CodeEngineAvailability>;
  start(o: CodeRunOptions): CodeRun;
}

// ===========================================================================
// Runs and sessions (code/runner.ts, code/store.ts)
// ===========================================================================

/** One line of `events.jsonl`. `seq` starts at 1 and increases by 1 per session. */
export interface CodeLogEntry {
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  /** The event as subscribers get it (with `seq` set). */
  event: SSEEvent;
}

/** A `code_sessions` row in `code.db` (§4.1), one per code chat. */
export interface CodeSessionRecord {
  /** The code session id: the directory name under `worktree_root`. */
  id: string;
  /** The code chat (`chats.id`). */
  chatId: string;
  /** The chat it was started from, if any. */
  parentChatId?: string;
  /** `[[code.repos]] name`. */
  repoName: string;
  /** The user's checkout at creation. */
  repoPath: string;
  /** The base as the user named it. */
  baseRef: string;
  /** The commit the session started from. */
  baseSha: string;
  /** The clone's branch, `rye/<slug>`. */
  branch: string;
  /** Short name used in branch names. */
  slug: string;
  engine: CodeEngineId;
  /** Absent: the engine's default. */
  model?: string;
  /** The engine's own session id, for resume. */
  engineSessionId?: string;
  status: CodeSessionState;
  isolation: CodeIsolation;
  includeUncommitted: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** Epoch milliseconds; set while archived. */
  archivedAt?: number;
  /** The turn of the latest snapshot (`refs/rye/<id>/turn-<n>`); absent before the first. */
  lastSnapshotTurn?: number;
  /** Total cost of the session's runs in USD. */
  costUsd: number;
}

// ===========================================================================
// Chat kinds (chat/kinds.ts, §4.2)
// ===========================================================================

/**
 * The chat-record fields a kind adds (§4.1): `chats.kind` and `chats.parent_chat_id`. Server-owned
 * like `FolderFields`: set when a chat is created through `/code/` routes, kept on client upserts.
 * `ChatHistoryRecord` (chat/store.ts) gains these when the integration adds the columns.
 */
export interface ChatKindFields {
  /** Absent or NULL: `chat`. */
  kind?: ChatKind;
  parentChatId?: string;
}

/** One turn handed to a kind by `POST /chat/`. */
export interface ChatKindTurnInput {
  /** The user's text. */
  message: string;
  attachments: Attachment[];
  /** The model named by the request, if any. */
  model?: string;
}

/** A chat kind on the server. `POST /chat/` dispatches to `run` by the chat's kind. */
export interface ChatKindServer {
  id: ChatKind;
  /**
   * Run (or, for code, start or steer) a turn and stream its events. For `code` this is the
   * session's subscription: `signal` aborting ends the stream, never the detached run.
   */
  run(chat: ChatHistoryRecord, input: ChatKindTurnInput, ctx: { signal: AbortSignal }): AsyncIterable<SSEEvent>;
  /** Called by `ChatStore.remove`; for code it archives the session (never deletes work). */
  onRemove?(chat: ChatHistoryRecord): void | Promise<void>;
}
