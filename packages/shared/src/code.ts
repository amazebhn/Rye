/**
 * Code sessions: the web ↔ agent-core contract (docs/design/code-sessions.md).
 *
 * Types only, plus the few constants the design pins down. No Node imports: this file is read by
 * the browser bundle too. agent-core re-exports the git and status shapes from
 * `packages/agent-core/src/code/types.ts`, so both sides use one definition.
 *
 * Field names are camelCase (like `ChatRecord`); errors are `{ error }` (`CodeErrorResponse`).
 * `:id` is always a code session id (`CodeSessionSummary.id`), never a chat id.
 *
 * ## Routes (prefix `/code/`, added to the Vite proxy and to `MUTATION_TOPICS`)
 *
 * Every route that changes anything accepts only JSON from a local origin (`refuseForeignMcpWrite`).
 *
 * | Method | Path | Body → Response |
 * |---|---|---|
 * | GET    | `/code/repos`                              | → `CodeReposResponse` |
 * | GET    | `/code/repos/:name/branches`               | → `CodeBranchesResponse` |
 * | GET    | `/code/engines`                            | → `CodeEnginesResponse` |
 * | GET    | `/code/policy`                             | → `CodePolicyResponse` (Settings → Code) |
 * | GET    | `/code/sessions?status=&chat=`             | `ListCodeSessionsQuery` → `ListCodeSessionsResponse` |
 * | POST   | `/code/sessions`                           | `CreateCodeSessionRequest` → `CreateCodeSessionResponse` |
 * | GET    | `/code/sessions/:id`                       | → `CodeSessionDetail` |
 * | GET    | `/code/sessions/:id/status`                | → `CodeSessionStatus` |
 * | GET    | `/code/sessions/:id/events?after=<seq>`    | `CodeEventsQuery` → `text/event-stream` of `SSEEvent` (see below) |
 * | POST   | `/code/sessions/:id/stop`                  | `{}` → `CodeOkResponse` |
 * | POST   | `/code/sessions/:id/approvals/:promptId`    | `ApprovalAnswerRequest` → `CodeOkResponse` |
 * | GET    | `/code/sessions/:id/changes?since=`        | `CodeChangesQuery` → `CodeChangesResponse` |
 * | GET    | `/code/sessions/:id/diff?path=&since=`     | `CodeFileDiffQuery` → `CodeFileDiffResponse` |
 * | GET    | `/code/sessions/:id/snapshots`             | → `CodeSnapshotsResponse` |
 * | GET    | `/code/sessions/:id/commands`              | → `CodeCommandsResponse` |
 * | POST   | `/code/sessions/:id/files/stage`           | `StageFilesRequest` → `CodeChangesResponse` |
 * | POST   | `/code/sessions/:id/files/discard`         | `DiscardFilesRequest` → `DiscardFilesResponse` |
 * | POST   | `/code/sessions/:id/branch/message`        | `{}` → `DraftBranchMessageResponse` |
 * | POST   | `/code/sessions/:id/branch`                | `CreateBranchRequest` → `CreateBranchResponse` |
 * | POST   | `/code/sessions/:id/merge`                 | `MergeWithBaseRequest` → `MergeResult` |
 * | POST   | `/code/sessions/:id/archive`               | `{}` → `CodeSessionDetail` |
 * | POST   | `/code/sessions/:id/restore`               | `{}` → `CodeSessionDetail` |
 * | DELETE | `/code/sessions/:id`                       | → `DeleteCodeSessionResponse` (Settings → Code only) |
 *
 * **Sending a message** into a code chat is `POST /chat/` as for any chat: the server dispatches by
 * the chat's kind to `code/runner.ts`, which starts a turn (or steers the running one,
 * `CodeRun.send`) and answers with the same event stream as `/events`. Closing that stream never
 * stops the run.
 *
 * **The event stream.** Each frame's SSE `id:` is the event's log sequence number and its `data:`
 * is an `SSEEvent` with `seq` set. `?after=<seq>` replays every logged event after `seq`
 * (`after=0`: from the start) and then follows live events, so a reload or a second tab picks up
 * where it left off. Code sessions add two things to `SSEEvent`: `prompt` events with `live: true`
 * (answered through `/approvals/:promptId`; the run keeps going) and `code_status` events.
 */

import type { PendingPrompt } from "./index";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/**
 * Every chat kind. The kind is data on the chat, not part of its address: all kinds live at
 * `/c/<id>`. A later `document` kind is added here and registers itself in the kind registries.
 */
export const CHAT_KINDS = ["chat", "code"] as const;

/** What a chat is. A chat without a kind is a `chat`. */
export type ChatKind = (typeof CHAT_KINDS)[number];

// ---------------------------------------------------------------------------
// Engines and sessions
// ---------------------------------------------------------------------------

/** A code engine: `claude` (Agent SDK, MVP), `pi` (Rye's loop, phase 2) or an ACP CLI (`acp:copilot`, phase 1.5). */
export type CodeEngineId = "claude" | "pi" | `acp:${string}`;

/** What an engine can do; decides how Rye drives and confines it. */
export interface CodeEngineCapabilities {
  /** It can continue an earlier engine session by id (`CodeRunOptions.resume`). */
  resume: boolean;
  /** It asks before risky tool calls and waits for the answer, so approvals can be live prompts. */
  liveApprovals: boolean;
  /**
   * It confines its own commands in an OS sandbox Rye configures (the Agent SDK's `sandbox`).
   * `false` makes running the whole engine process under `sandbox-runtime` mandatory.
   */
  ownSandbox: boolean;
}

/** Whether an engine can be used here, for the engine picker and Settings → Code. */
export interface CodeEngineAvailability {
  available: boolean;
  /** Why not, when it isn't: "Claude Code isn't signed in", "copilot not found on PATH", "Disabled by your organization". */
  reason?: string;
  /** Who it is signed in as, or how it authenticates, when known. */
  account?: string;
}

/** How a session's workspace is isolated from the user's checkout (§3.1). */
export type CodeIsolation = "clone" | "worktree";

/** A session's stored lifecycle state: an archived session has no `repo/` but keeps its snapshot refs. */
export type CodeSessionState = "active" | "archived";

/**
 * What a session is doing now, for the sidebar indicator and the status strip.
 * - `idle`: no run, nothing new to review.
 * - `running`: a run is going.
 * - `needs_approval`: a run is waiting on a live prompt.
 * - `ready`: the last run ended with changes to review.
 * - `error`: the last run failed (the reason is in the chat).
 */
export type CodeActivity = "idle" | "running" | "needs_approval" | "ready" | "error";

// ---------------------------------------------------------------------------
// Git shapes (produced by agent-core code/git.ts)
// ---------------------------------------------------------------------------

/** Line totals for a set of changes. */
export interface DiffStat {
  /** Files changed. */
  files: number;
  /** Lines added. */
  additions: number;
  /** Lines removed. */
  deletions: number;
}

/** How a file changed against the comparison point. */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";

/** Where a change sits in the clone, for stage/unstage. */
export type FileStage = "committed" | "staged" | "unstaged" | "partly_staged" | "untracked";

/**
 * Why a changed file deserves a closer look in review (§3.5, §3.6).
 * - `manifest`: package.json, Cargo.toml, pyproject.toml, go.mod, …
 * - `lockfile`: bun.lock, package-lock.json, yarn.lock, … (see `DiffFile.resolvedHosts`)
 * - `ci`: `.github/workflows` and other CI definitions
 * - `git_hooks`: `.husky`, lefthook, pre-commit and other hook managers
 * - `envrc`: `.envrc`
 * - `editor_tasks`: `.vscode/tasks.json` and similar auto-run editor config
 * - `agent_config`: `.claude/`, `.mcp.json`
 * - `agent_instructions`: `AGENTS.md`, `CLAUDE.md`
 * - `env_file`: a tracked `.env*` file
 * - `symlink`: a new symlink
 * - `executable`: the executable bit changed
 * - `binary`: a binary file
 */
export type SensitiveKind =
  | "manifest"
  | "lockfile"
  | "ci"
  | "git_hooks"
  | "envrc"
  | "editor_tasks"
  | "agent_config"
  | "agent_instructions"
  | "env_file"
  | "symlink"
  | "executable"
  | "binary";

/** One reason a file is flagged. */
export interface SensitiveFlag {
  kind: SensitiveKind;
  /** A short human detail, written by Rye: "new symlink → ../../.ssh", "mode 100644 → 100755". */
  detail?: string;
}

/** One line of a hunk. */
export interface DiffLine {
  /** `context` is unchanged, `add` is new, `del` is removed. */
  kind: "context" | "add" | "del";
  /** The line's text without its trailing newline or the leading `+`/`-`/space. */
  text: string;
  /** Line number on the old side (context and del lines). */
  oldLine?: number;
  /** Line number on the new side (context and add lines). */
  newLine?: number;
  /** The file has no newline after this line ("\ No newline at end of file"). */
  noNewline?: true;
}

/** One `@@ … @@` hunk, parsed on the server so the client only renders. */
export interface DiffHunk {
  /** First old-side line (1-based; 0 for an added file). */
  oldStart: number;
  /** Old-side line count. */
  oldLines: number;
  /** First new-side line (1-based; 0 for a deleted file). */
  newStart: number;
  /** New-side line count. */
  newLines: number;
  /** The text after the closing `@@` (usually the enclosing function), or "". */
  section: string;
  lines: DiffLine[];
}

/** One changed file. In listings `hunks` is absent; the per-file diff fills it. */
export interface DiffFile {
  /** Path relative to the repo root, `/`-separated (the new path for a rename). */
  path: string;
  /** The old path, for renames and copies. */
  oldPath?: string;
  status: DiffFileStatus;
  /** Lines added (0 for binaries). */
  additions: number;
  /** Lines removed (0 for binaries). */
  deletions: number;
  binary: boolean;
  /** Git file mode before, when it changed or the file was deleted ("100644", "100755", "120000"). */
  oldMode?: string;
  /** Git file mode after, when it changed or the file was added. */
  newMode?: string;
  /** Where the change sits in the clone (committed on the session branch, staged, …). */
  stage: FileStage;
  /** Review flags; empty when nothing stands out. */
  sensitive: SensitiveFlag[];
  /** Lockfiles: every host the changed entries resolve packages from (the "resolved-URL summary"). */
  resolvedHosts?: string[];
  /** Parsed hunks (per-file diff only). */
  hunks?: DiffHunk[];
  /** The diff was cut short because the file is too large to show whole. */
  truncated?: boolean;
}

/** The session branch against its base: what the status strip shows. */
export interface BranchStatus {
  /** The clone's current branch (`rye/<slug>`), or null when HEAD is detached. */
  branch: string | null;
  /** The clone's HEAD commit. */
  head: string;
  /** The base the session started from, as the user named it ("main"). */
  base: string;
  /** The commit the session started from (pinned as `refs/rye/<session>/base`). */
  baseSha: string;
  /** The base's tip in the user's repo now; differs from `baseSha` once the base moved on. */
  baseTip: string;
  /** Commits on the session branch that the base tip doesn't have. */
  ahead: number;
  /** Commits on the base tip that the session branch doesn't have. */
  behind: number;
  /** The clone's working tree or index differs from HEAD. */
  dirty: boolean;
  /** Files with uncommitted changes (staged, unstaged or untracked). */
  dirtyFiles: number;
  /** Everything changed against `baseSha`, committed or not. */
  stat: DiffStat;
  /**
   * The base branch still has no commits (the session started from an empty project, see
   * `CodeSessionDetail.baseUnborn`): `baseTip` is the session's pinned base, and Merge with latest
   * base is refused until the base has commits. Absent once it has them.
   */
  baseUnborn?: boolean;
}

/** A turn's snapshot, stored in the user's repo where the agent can't reach it. */
export interface SnapshotRef {
  /** The turn it closes (1-based). */
  turn: number;
  /** The full ref: `refs/rye/<session>/turn-<n>`. */
  ref: string;
  /** The snapshot commit. */
  sha: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** What a comparison is against: the session's base, or the snapshot closing turn n. */
export type ChangesSince = "base" | `turn-${number}`;

/** One file that didn't merge cleanly with the latest base. */
export interface MergeConflict {
  path: string;
  /** `content`: both sides edited the same lines; the others are the structural cases. */
  kind: "content" | "add_add" | "modify_delete" | "rename" | "other";
  /** Git's own message for it, when there is one. */
  message?: string;
}

/**
 * Result of Merge with latest base (§3.5): `git merge-tree --write-tree` on objects only, then a
 * two-parent `commit-tree`, then a create-only new branch. Nothing existing is ever updated.
 */
export type MergeResult =
  | {
      status: "merged";
      /** The new branch in the user's repo. */
      branch: string;
      /** The merge commit it points at. */
      sha: string;
      /** The base tip that was merged in. */
      baseTip: string;
    }
  | {
      status: "conflicts";
      /** The base tip that was tried. */
      baseTip: string;
      conflicts: MergeConflict[];
    }
  | {
      /** A branch of that name already exists; nothing was written. */
      status: "branch_exists";
      branch: string;
    };

// ---------------------------------------------------------------------------
// Commands, checks, policy (for the Terminal and Checks tabs and Settings → Code)
// ---------------------------------------------------------------------------

/** One command the agent ran, for the Terminal tab. */
export interface CodeCommandEntry {
  /** The engine's tool-use id. */
  id: string;
  /** The turn it ran in (1-based). */
  turn: number;
  /** The exact command text. */
  command: string;
  /** The parsed argv when the policy could parse it as one simple command. */
  argv?: string[];
  /** Working directory relative to the repo root ("" for the root). */
  cwd: string;
  /** `denied` never ran: the policy or the user refused it. */
  status: "running" | "ok" | "failed" | "denied";
  /** Exit code once finished; null when killed or unknown. */
  exitCode?: number | null;
  /** Epoch milliseconds. */
  startedAt: number;
  durationMs?: number;
  /** Output so far (live where the engine streams it), capped. */
  output: string;
  /** `output` was capped. */
  outputTruncated?: boolean;
  /** Why it was denied, when it was. */
  deniedReason?: string;
}

/** One configured check (`checks` on the repo), run by Rye in the sandbox. */
export interface CheckResult {
  command: string;
  status: "pending" | "running" | "pass" | "fail";
  exitCode?: number | null;
  durationMs?: number;
  /** Output, capped. */
  output?: string;
  /** Epoch milliseconds of the run this result belongs to. */
  ranAt?: number;
}

/** The checks for a session's current state ("checks ✓2 ✗1"). */
export interface CodeCheckSummary {
  passed: number;
  failed: number;
  /** Pending or running. */
  running: number;
  results: CheckResult[];
}

/** One rule of the effective policy, as Settings → Code lists it. */
export interface CodePolicyRule {
  /** A command pattern (`bun test *`, matched against the whole command) or a description of a built-in rule. */
  pattern: string;
  verdict: "allow" | "ask" | "deny";
  /** `builtin` rules can't be removed; `config` is `[code.policy]`, `repo` a repo's own, `session` an "Allow … for this session". */
  source: "builtin" | "config" | "repo" | "session";
  /** Why the rule exists, for built-ins. */
  reason?: string;
}

/** Whether the OS sandbox works here. No sandbox, no code session (`failIfUnavailable`). */
export interface CodeSandboxStatus {
  available: boolean;
  /** `seatbelt` (macOS `sandbox-exec`), `bubblewrap` (Linux), or null when neither is usable. */
  mechanism: "seatbelt" | "bubblewrap" | null;
  /** Why not, when it isn't: "bubblewrap is not installed", "native Windows is not supported". */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A session's live state; also the payload of a `code_status` event. */
export interface CodeSessionStatus {
  sessionId: string;
  activity: CodeActivity;
  /** Null while archived (no clone to look at). */
  branch: BranchStatus | null;
  /** Absent when the repo defines no checks. */
  checks?: CodeCheckSummary;
  /** Total cost of this session's runs in USD, as the engine reports it. */
  costUsd: number;
  /** The run going now, if any. */
  run?: {
    /** The turn it is running (1-based). */
    turn: number;
    /** Epoch milliseconds. */
    startedAt: number;
    /** Cost of this run so far in USD. */
    costUsd: number;
  };
  /** The live prompt waiting for an answer, if any (`SSEEvent.prompt_id`). */
  pendingPromptId?: string;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** A session in a listing (sidebar, parent-chat card, Settings → Code). */
export interface CodeSessionSummary {
  /** The code session id (`DATA_DIR/code/<id>`). */
  id: string;
  /** The code chat (`/c/<chatId>`). */
  chatId: string;
  /** The chat it was started from, when started by `start_code_session_tool`. */
  parentChatId?: string;
  /** The chat's title. */
  title: string;
  /** The repo's name in `[[code.repos]]`. */
  repo: string;
  /** The session branch in the clone (`rye/<slug>`). */
  branch: string;
  /** The base as the user named it ("main"). */
  base: string;
  engine: CodeEngineId;
  /** The engine's model, when one was chosen. */
  model?: string;
  state: CodeSessionState;
  activity: CodeActivity;
  /** Changes against the base (zeros while archived). */
  stat: DiffStat;
  /** Total cost in USD. */
  costUsd: number;
  /** Disk used by the session directory in bytes, when measured. */
  diskBytes?: number;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** Epoch milliseconds; set while archived. */
  archivedAt?: number;
}

/** Everything the code chat's workspace panel and status strip need. */
export interface CodeSessionDetail extends CodeSessionSummary {
  /** The user's checkout the session was cloned from. */
  repoPath: string;
  /** The clone the agent works in (for "Open in editor"); absent while archived. */
  workspacePath?: string;
  /** The commit the session started from. */
  baseSha: string;
  isolation: CodeIsolation;
  /** The base included the user's uncommitted changes (`git stash create`). */
  includeUncommitted: boolean;
  /**
   * The base had no commits when the session started (a new repo): the session starts from an
   * empty root commit Rye made ("Empty project"), plus the user's staged files with
   * `includeUncommitted`. Whether it still has none is `BranchStatus.baseUnborn`.
   */
  baseUnborn?: boolean;
  /** The engine's own session id, for resume. */
  engineSessionId?: string;
  /** "Continue in terminal": e.g. `cd <workspace> && claude --resume <id>`; runs outside Rye's policy. */
  resumeCommand?: string;
  /** An `editor` URL for the workspace (`vscode://file/…`), absent when `editor = "none"`. */
  editorUrl?: string;
  capabilities: CodeEngineCapabilities;
  status: CodeSessionStatus;
  /** The live prompt waiting for an answer, as the chat stores it. */
  pendingPrompt?: PendingPrompt;
  /** The latest event sequence number; subscribe with `?after=` this to get only new events. */
  lastSeq: number;
}

/** An allowed repo (`[[code.repos]]`), for the "New code session" dialog and Settings → Code. */
export interface CodeRepoSummary {
  name: string;
  /** The user's checkout. */
  path: string;
  /** The default base branch. */
  base: string;
  isolation: CodeIsolation;
  /** The `setup` commands. */
  setup: string[];
  /** The `checks` commands. */
  checks: string[];
  /** False when the path is missing or not a git repo. */
  available: boolean;
  /** Why not, when it isn't. */
  reason?: string;
  /** `base` is the checked-out branch and has no commits yet (a new repo): a session starts from an empty project. */
  unborn?: boolean;
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/** Error body of every `/code/` route. */
export interface CodeErrorResponse {
  error: string;
  /**
   * - `not_found`: unknown session, repo, prompt or file
   * - `archived`: the session must be restored first
   * - `busy`: a run is going and the action needs it stopped
   * - `answered`: the prompt was already answered or timed out
   * - `sandbox_unavailable`: no OS sandbox, so no code session
   * - `limit`: `max_sessions` reached
   * - `invalid`: the body or query is wrong
   */
  code?: "not_found" | "archived" | "busy" | "answered" | "sandbox_unavailable" | "limit" | "invalid";
}

/** Plain success. */
export interface CodeOkResponse {
  ok: true;
}

/** `GET /code/repos`. */
export interface CodeReposResponse {
  repos: CodeRepoSummary[];
  /** Repos code search knows that aren't allowed for code sessions yet ("Enable for code sessions"). */
  candidates: Array<{ name: string; path: string }>;
}

/** `GET /code/repos/:name/branches`. */
export interface CodeBranchesResponse {
  /** Local branch names in the user's repo. */
  branches: string[];
  /** The repo's configured base, else its checked-out branch. */
  defaultBase: string;
  /** The user's checkout has uncommitted changes (offer "Include my uncommitted changes"); in a repo with no commits, staged files. */
  dirty: boolean;
  /**
   * The checked-out branch when it has no commits yet (a new repo, or `checkout --orphan`). It isn't
   * in `branches`; a session on it starts from an empty project.
   */
  unbornBranch?: string;
}

/** `GET /code/engines`. */
export interface CodeEnginesResponse {
  engines: Array<{
    id: CodeEngineId;
    /** "Claude", "GitHub Copilot". */
    title: string;
    capabilities: CodeEngineCapabilities;
    availability: CodeEngineAvailability;
    /** Models it offers; empty when unavailable. */
    models: string[];
    /** The model used when none is picked. */
    defaultModel?: string;
  }>;
  /** `[code] engine`. */
  defaultEngine: CodeEngineId;
}

/** `GET /code/policy`. */
export interface CodePolicyResponse {
  /** Built-in rules first, then the user's. */
  rules: CodePolicyRule[];
  /** `[code.policy] allowed_domains`. */
  allowedDomains: string[];
  sandbox: CodeSandboxStatus;
}

/** `GET /code/sessions` query. */
export interface ListCodeSessionsQuery {
  /** Default `active`. */
  status?: CodeSessionState | "all";
  /** Only the session of this chat. */
  chat?: string;
}

/** `GET /code/sessions`. Newest first. */
export interface ListCodeSessionsResponse {
  sessions: CodeSessionSummary[];
}

/** `POST /code/sessions`: the "New code session…" dialog. Creates the session and its chat, then starts the first run with `task`. */
export interface CreateCodeSessionRequest {
  /** A repo name from `[[code.repos]]`. */
  repo: string;
  /** The first message: what to do. */
  task: string;
  /** Base branch or ref; default the repo's `base`. */
  base?: string;
  /** Default `[code] engine`. */
  engine?: CodeEngineId;
  /** Default `[code] model`, else the engine's default. */
  model?: string;
  /** Base the session on the user's uncommitted changes too (`git stash create`). Default false. */
  includeUncommitted?: boolean;
  /** The chat's title; default one written from the task. */
  title?: string;
  /** Uploaded attachment ids (`POST /chat/attachments/`), at most 10. */
  attachments?: string[];
}

/** `POST /code/sessions`. */
export interface CreateCodeSessionResponse {
  session: CodeSessionDetail;
  /** The new code chat, to open at `/c/<chatId>`. */
  chatId: string;
}

/** `GET /code/sessions/:id/events` query. */
export interface CodeEventsQuery {
  /** Replay events with a greater sequence number, then follow live ones. Default 0 (everything). */
  after?: number;
}

/**
 * `POST /code/sessions/:id/approvals/:promptId`: the answer to a live prompt. `answer` is one of
 * the prompt's `options` exactly (`Allow once`, `Allow "<pattern>" for this session`, `Deny`, …),
 * or the typed text for a `text` prompt.
 */
export interface ApprovalAnswerRequest {
  answer: string;
}

/** `GET /code/sessions/:id/changes` query. */
export interface CodeChangesQuery {
  /** Default `base`. */
  since?: ChangesSince;
}

/** `GET /code/sessions/:id/changes`: every changed file, without hunks. */
export interface CodeChangesResponse {
  since: ChangesSince;
  files: DiffFile[];
  stat: DiffStat;
}

/** `GET /code/sessions/:id/diff` query. */
export interface CodeFileDiffQuery {
  /** The file's path relative to the repo root. */
  path: string;
  /** Default `base`. */
  since?: ChangesSince;
}

/** `GET /code/sessions/:id/diff`: one file with its hunks. */
export interface CodeFileDiffResponse {
  since: ChangesSince;
  file: DiffFile;
}

/** `GET /code/sessions/:id/snapshots`: oldest first, for the "changes since turn n" picker. */
export interface CodeSnapshotsResponse {
  snapshots: SnapshotRef[];
}

/** `GET /code/sessions/:id/commands`: the Terminal tab, oldest first. */
export interface CodeCommandsResponse {
  commands: CodeCommandEntry[];
}

/** `POST /code/sessions/:id/files/stage`: stage or unstage files in the clone. */
export interface StageFilesRequest {
  paths: string[];
  /** True stages, false unstages. */
  staged: boolean;
}

/** `POST /code/sessions/:id/files/discard`: drop the files' uncommitted changes in the clone (confirmed in the UI). */
export interface DiscardFilesRequest {
  paths: string[];
}

/** `POST /code/sessions/:id/files/discard`. */
export interface DiscardFilesResponse {
  changes: CodeChangesResponse;
  /** The snapshot taken just before discarding, to undo from. */
  snapshot: SnapshotRef;
}

/** `POST /code/sessions/:id/branch/message`: a squash commit message drafted by the model, for the user to edit. */
export interface DraftBranchMessageResponse {
  message: string;
}

/**
 * `POST /code/sessions/:id/branch`: Create branch. A create-only `update-ref` in the user's repo;
 * an existing branch is never updated.
 */
export interface CreateBranchRequest {
  /** Must start with `rye/`; default `rye/<slug>`. */
  name?: string;
  /** `keep`: the session's commits as they are; `squash`: one commit with `message`. Default `keep`. */
  mode?: "keep" | "squash";
  /** The commit message; required for `squash`. */
  message?: string;
}

/** `POST /code/sessions/:id/branch`. */
export type CreateBranchResponse =
  | {
      status: "created";
      branch: string;
      /** The commit it points at. */
      sha: string;
      /** Commits on it beyond the base. */
      commits: number;
    }
  | {
      /** Nothing was written. */
      status: "branch_exists";
      branch: string;
    };

/** `POST /code/sessions/:id/merge`: Merge with latest base, onto a new branch. */
export interface MergeWithBaseRequest {
  /** Must start with `rye/`; default `rye/<slug>`. */
  name?: string;
  /** The merge commit's message; default "Merge <base> into <branch>". */
  message?: string;
}

/** `DELETE /code/sessions/:id`: removes the workspace and `refs/rye/<session>/*`, never a `rye/*` branch the user created. */
export interface DeleteCodeSessionResponse {
  status: "deleted";
  id: string;
  /** How many `refs/rye/<session>/*` refs were dropped. */
  removedRefs: number;
}
