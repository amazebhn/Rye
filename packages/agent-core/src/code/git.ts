/**
 * Rye's own git for code sessions (docs/design/code-sessions.md §3.1, §3.5): a hardened runner,
 * diff → hunks, branch status, stage/discard, merge-tree, create-only refs and snapshots.
 *
 * ## Why Rye never runs git "in" the clone
 *
 * The clone's `.git` is written by the agent, and Rye's git runs outside the sandbox. `-c`
 * overrides cover hooks, fsmonitor and the ssh command, but not everything a repo's config can
 * name (`filter.<driver>.clean` is a command, chosen by `.gitattributes`; `core.worktree` can point
 * at the user's checkout; `commondir` and gitfiles can redirect the whole repo). So no Rye git
 * process ever reads the clone's config:
 *
 * - **Shadow context** (everything touching the clone's index or working tree): `--git-dir` is a
 *   Rye-owned bare repo beside `repo/` (`<session>/.rye-git`, outside the sandbox's write scope),
 *   `--work-tree` is `repo/`, `GIT_INDEX_FILE` is a Rye-owned copy of the clone's index, and
 *   objects are read through `GIT_ALTERNATE_OBJECT_DIRECTORIES` (the clone's objects, then the
 *   user's). Config, `info/attributes` and hooks are Rye's; filter drivers named in the tree have
 *   no definition, so nothing runs.
 * - **The clone's HEAD** is read from the files (`readCloneHead`), never by git.
 * - **User context** (refs, merges, objects in the user's repo): `--git-dir=<user git dir>`. That
 *   config is the user's own, and the agent can't write it.
 * - Objects reach the user's repo by `pack-objects` (shadow context) → `index-pack --strict`
 *   (user context): no transport, no upload-pack in the clone, and malformed objects are refused.
 *
 * The only refs Rye writes in the user's repo are `refs/rye/*` and new `refs/heads/rye/*`, always
 * create-only (`createRefOnly`).
 */

import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  HARDENED_GIT_CONFIG,
  HARDENED_GIT_DIFF_OPTIONS,
  HARDENED_GIT_ENV,
  RYE_BRANCH_PREFIX,
  RYE_REF_PREFIX,
  type BranchStatus,
  type ChangesSince,
  type CodeGit,
  type DiffFile,
  type DiffFileStatus,
  type DiffHunk,
  type DiffLine,
  type DiffStat,
  type FileStage,
  type GitResult,
  type GitRunner,
  type MergeConflict,
  type MergeResult,
  type SensitiveFlag,
  type Workspace,
} from "./types.js";

// ===========================================================================
// Limits and identity
// ===========================================================================

/** Committer and author of every commit Rye makes (snapshots, squash and merge commits). */
export const RYE_GIT_IDENTITY: Readonly<GitIdentity> = { name: "Rye", email: "rye@localhost" };
/** A git command taking longer than this is killed (a FIFO or `/dev/tty` named by an attacker can block a read). */
export const GIT_TIMEOUT_MS = 120_000;
/** A per-file diff stops being parsed after this many hunk lines (`DiffFile.truncated`). */
export const MAX_DIFF_LINES = 5_000;
/** ...or after this many bytes of patch text. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** Text commands are cut off (and killed) beyond this much stdout. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface GitIdentity {
  name: string;
  email: string;
}

export type CodeGitErrorCode = "archived" | "invalid" | "unsafe" | "not_found" | "busy" | "git";

/** A refusal or failure from code/git.ts or code/workspace.ts. `code` maps onto `CodeErrorResponse.code`. */
export class CodeGitError extends Error {
  constructor(
    message: string,
    readonly code: CodeGitErrorCode,
    /** git's stderr, when a git command failed. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "CodeGitError";
  }
}

// ===========================================================================
// The hardened runner
// ===========================================================================

export interface GitRunnerOptions {
  /** Default `RYE_GIT_IDENTITY`. */
  identity?: GitIdentity;
  /** Default `GIT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface SpawnOptions {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string>>;
  /** Read stdin from this file instead of `input`. */
  stdinPath?: string;
  /** Write stdout to this file (nothing is captured). */
  stdoutPath?: string;
  /** Stop reading (and kill git) beyond this many stdout bytes. */
  maxOutputBytes?: number;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout was cut at `maxOutputBytes`. */
  truncated: boolean;
}

/**
 * The scrubbed environment: PATH and HOME from Rye's process, C locale (git's messages are parsed),
 * no pager or editor, literal pathspecs, no replace refs, no optional index writes. Nothing else is
 * inherited, so no stray `GIT_DIR`/`GIT_INDEX_FILE` from Rye's own environment reaches git.
 */
function gitEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    LC_ALL: "C",
    LANG: "C",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!/^GIT_[A-Z_]+$/.test(k)) throw new CodeGitError(`Refusing to pass ${k} to git`, "invalid");
    env[k] = v;
  }
  return { ...env, ...HARDENED_GIT_ENV };
}

function hardenedArgs(identity: GitIdentity, args: readonly string[]): string[] {
  return ["git", ...HARDENED_GIT_CONFIG, "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, ...args];
}

async function spawnGit(args: readonly string[], o: SpawnOptions & GitRunnerOptions): Promise<SpawnResult> {
  const identity = o.identity ?? RYE_GIT_IDENTITY;
  const maxOut = o.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const stdin = o.stdinPath ? Bun.file(o.stdinPath) : o.input !== undefined ? new TextEncoder().encode(o.input) : "ignore";
  const proc = Bun.spawn(hardenedArgs(identity, args), {
    cwd: o.cwd,
    env: gitEnv(o.env),
    stdin,
    stdout: o.stdoutPath ? Bun.file(o.stdoutPath) : "pipe",
    stderr: "pipe",
  });
  let killed = false;
  const kill = () => {
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(kill, o.timeoutMs ?? GIT_TIMEOUT_MS);
  const onAbort = () => kill();
  if (o.signal?.aborted) kill();
  else o.signal?.addEventListener("abort", onAbort, { once: true });

  let truncated = false;
  const readAll = async (stream: ReadableStream<Uint8Array> | null | undefined | number, cap: number, cut: () => void): Promise<string> => {
    if (!stream || typeof stream === "number") return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.length > cap) {
          chunks.push(value.subarray(0, cap - total));
          total = cap;
          cut();
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    } catch {
      /* the process was killed */
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [stdout, stderr] = await Promise.all([
      readAll(o.stdoutPath ? null : (proc.stdout as ReadableStream<Uint8Array>), maxOut, () => {
        truncated = true;
        kill();
      }),
      readAll(proc.stderr as ReadableStream<Uint8Array>, MAX_STDERR_BYTES, () => {}),
    ]);
    const exitCode = await proc.exited;
    if (killed && !truncated) {
      return { exitCode: exitCode === 0 ? 137 : exitCode, stdout, stderr: `${stderr}\n(git was stopped: timed out or aborted)`, truncated };
    }
    return { exitCode: truncated ? 0 : exitCode, stdout, stderr, truncated };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Rye's git runner: fixed argv, no shell, `HARDENED_GIT_CONFIG` before the subcommand, an explicit
 * user.name/user.email, and `HARDENED_GIT_ENV` on a scrubbed env (see `gitEnv`).
 */
export function createGitRunner(o: GitRunnerOptions = {}): GitRunner {
  return async (args, opts) => {
    const r = await spawnGit(args, { ...o, ...opts });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr } satisfies GitResult;
  };
}

// ===========================================================================
// Contexts
// ===========================================================================

/** Where and how one git command runs: global options before the subcommand, extra env, cwd. */
interface GitContext {
  pre: string[];
  env: Record<string, string>;
  cwd: string;
}

/** The Rye-owned git dir used for every command touching the clone's index or working tree. */
export function shadowGitDir(ws: Pick<Workspace, "sessionDir">): string {
  return join(ws.sessionDir, ".rye-git");
}

/** C-quote one entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES` when it holds `:` or `"`. */
function altEntry(path: string): string {
  if (!/[:"\\\n]/.test(path)) return path;
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function userContext(ws: Pick<Workspace, "userGitDir">): GitContext {
  return { pre: [`--git-dir=${ws.userGitDir}`], env: {}, cwd: ws.userGitDir };
}

function cloneObjectsDir(ws: Pick<Workspace, "repoDir">): string {
  return join(ws.repoDir, ".git", "objects");
}

function shadowContext(ws: Workspace, indexFile: string | null): GitContext {
  const exclude = join(ws.repoDir, ".git", "info", "exclude");
  let excludes = "/dev/null";
  try {
    // Only patterns are read from it; a FIFO or symlink is ignored.
    if (lstatSync(exclude).isFile()) excludes = exclude;
  } catch {
    /* none */
  }
  return {
    pre: [`--git-dir=${shadowGitDir(ws)}`, `--work-tree=${ws.repoDir}`, "-c", `core.excludesFile=${excludes}`],
    env: {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [cloneObjectsDir(ws), ws.userObjectsDir].map(altEntry).join(":"),
      // Never the shadow's own index: an unset GIT_INDEX_FILE would mean <shadow>/index.
      GIT_INDEX_FILE: indexFile ?? join(shadowGitDir(ws), "no-index"),
    },
    cwd: ws.repoDir,
  };
}

/** The fresh clone itself, only while Rye creates or restores it (its config is Rye's then, and no agent runs). */
function freshCloneContext(repoDir: string): GitContext {
  return { pre: [`--git-dir=${join(repoDir, ".git")}`, `--work-tree=${repoDir}`], env: {}, cwd: repoDir };
}

// ===========================================================================
// Pure helpers: refs, paths, parsing, sensitive flags
// ===========================================================================

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The all-zero object id of the same length as `sha` ("this ref must not exist yet"). */
export function zeroOid(sha: string): string {
  return "0".repeat(sha.length === 64 ? 64 : 40);
}

/** The only refs Rye may write in the user's repo: `refs/rye/**` and `refs/heads/rye/**`. */
export function isRyeWritableRef(ref: string): boolean {
  return (ref.startsWith(RYE_REF_PREFIX) || ref.startsWith(`refs/heads/${RYE_BRANCH_PREFIX}`)) && !ref.includes("..") && !/[\0-\x20\x7f~^:?*[\\]/.test(ref);
}

/**
 * A path from a client or from the clone's index, relative to the repo root: no NUL, not absolute,
 * and no `.`, `..`, empty or `.git` segment (any case, trailing dots/spaces ignored).
 */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 4096 || p.includes("\0") || p.startsWith("/") || isAbsolute(p)) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.replace(/[. ]+$/, "").toLowerCase() === ".git") return false;
  }
  return true;
}

function assertSafePaths(paths: readonly string[]): void {
  if (!Array.isArray(paths) || paths.length === 0) throw new CodeGitError("No paths given", "invalid");
  for (const p of paths) {
    if (typeof p !== "string" || !isSafeRepoPath(p)) throw new CodeGitError(`Invalid path: ${JSON.stringify(p)}`, "invalid");
  }
}

/** A base or branch name as given by a client: never an option, never a newline or NUL. */
function assertRevision(rev: string): void {
  if (!rev || rev.startsWith("-") || /[\0\n\r]/.test(rev) || rev.length > 1024) throw new CodeGitError(`Invalid revision: ${JSON.stringify(rev)}`, "invalid");
}

/** One entry of `diff-tree --raw -z`. */
export interface RawEntry {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  /** A, M, D, R, C, T, U, X. */
  status: string;
  path: string;
  oldPath?: string;
}

/** Parse `git diff-tree -r -z --raw` output. */
export function parseRawZ(out: string): RawEntry[] {
  const t = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < t.length; i++) {
    const meta = t[i];
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, oldSha, newSha, statusField] = meta.slice(1).split(" ");
    const status = (statusField ?? "").charAt(0);
    if (status === "R" || status === "C") {
      const oldPath = t[++i];
      const path = t[++i];
      entries.push({ oldMode, newMode, oldSha, newSha, status, path, oldPath });
    } else {
      entries.push({ oldMode, newMode, oldSha, newSha, status, path: t[++i] });
    }
  }
  return entries;
}

/** Parse `git diff-tree -r -z --numstat` output, keyed by the new path. Binary files have `binary: true`. */
export function parseNumstatZ(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const t = out.split("\0");
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < t.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      i++; // old path
      path = t[++i];
    }
    const binary = m[1] === "-" && m[2] === "-";
    map.set(path, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

/**
 * Parse one file's unified diff (`diff --git` headers and `@@` hunks) into hunks. Stops after
 * `maxLines` hunk lines (`truncated`). Lines are taken by the hunk's counts, so content lines that
 * start with `---`/`+++` or `diff --git` are read as content.
 */
export function parseHunks(patch: string, maxLines = MAX_DIFF_LINES): { hunks: DiffHunk[]; truncated: boolean; binary: boolean } {
  const hunks: DiffHunk[] = [];
  let truncated = false;
  let binary = false;
  let total = 0;
  let cur: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let last: DiffLine | null = null;
  const lines = patch.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      if (total >= maxLines) {
        truncated = true;
        break;
      }
      const c = line.charAt(0);
      let dl: DiffLine | null = null;
      if (c === " " || (c === "" && line === "")) {
        dl = { kind: "context", text: line.slice(1), oldLine: oldNo++, newLine: newNo++ };
        oldLeft--;
        newLeft--;
      } else if (c === "-") {
        dl = { kind: "del", text: line.slice(1), oldLine: oldNo++ };
        oldLeft--;
      } else if (c === "+") {
        dl = { kind: "add", text: line.slice(1), newLine: newNo++ };
        newLeft--;
      } else if (c === "\\") {
        if (last) last.noNewline = true;
        continue;
      } else {
        // Malformed: the hunk ended early.
        cur = null;
      }
      if (dl && cur) {
        cur.lines.push(dl);
        last = dl;
        total++;
        continue;
      }
    }
    if (line.startsWith("\\")) {
      if (last) last.noNewline = true;
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h) {
      cur = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        section: h[5] ?? "",
        lines: [],
      };
      hunks.push(cur);
      oldLeft = cur.oldLines;
      newLeft = cur.newLines;
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      last = null;
      continue;
    }
    if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch") binary = true;
  }
  return { hunks, truncated, binary };
}

const MANIFESTS = new Set([
  "package.json", "cargo.toml", "pyproject.toml", "go.mod", "gemfile", "composer.json", "setup.py", "setup.cfg",
  "pipfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "podfile",
  "mix.exs", "deno.json", "deno.jsonc", "bunfig.toml", ".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml",
  "package.swift", "requirements.txt", "environment.yml", "build.sbt", "pubspec.yaml",
]);
const LOCKFILES = new Set([
  "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
  "poetry.lock", "pipfile.lock", "uv.lock", "pdm.lock", "go.sum", "gemfile.lock", "composer.lock", "flake.lock",
  "podfile.lock", "mix.lock", "deno.lock", "pubspec.lock", "package.resolved",
]);
const CI_PREFIXES = [".github/workflows/", ".github/actions/", ".circleci/", ".buildkite/", ".gitlab/ci/", ".woodpecker/", ".forgejo/workflows/", ".gitea/workflows/"];
const CI_FILES = new Set([".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".travis.yml", ".drone.yml", ".woodpecker.yml", "appveyor.yml", ".appveyor.yml", "cloudbuild.yaml", "cloudbuild.yml", ".github/dependabot.yml"]);
const HOOK_DIRS = [".husky", ".githooks", ".git-hooks", ".hooks"];
const HOOK_FILES = new Set([
  "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", "lefthook-local.yml", ".pre-commit-config.yaml",
  ".pre-commit-hooks.yaml", ".simple-git-hooks.json", ".simple-git-hooks.js", ".simple-git-hooks.cjs",
  "simple-git-hooks.js", "simple-git-hooks.json", ".lintstagedrc", ".lintstagedrc.json", ".lintstagedrc.js",
  ".lintstagedrc.yml", ".lintstagedrc.yaml", "lint-staged.config.js", "lint-staged.config.mjs", "lint-staged.config.cjs",
]);
const EDITOR_FILES = new Set([".vscode/tasks.json", ".vscode/launch.json", ".vscode/settings.json", ".zed/tasks.json", ".zed/settings.json"]);
const AGENT_DIRS = [".claude", ".cursor", ".codex", ".gemini", ".opencode", ".windsurf", ".continue", ".roo", ".clinerules"];
const AGENT_FILES = new Set([".mcp.json", "opencode.json", "opencode.jsonc", ".aider.conf.yml", ".cursor/mcp.json"]);
const INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "claude.local.md", "gemini.md", ".cursorrules", ".windsurfrules", ".clinerules", "copilot-instructions.md"]);

function pathFlags(path: string): SensitiveFlag[] {
  const lower = path.toLowerCase();
  const segs = lower.split("/");
  const base = segs[segs.length - 1];
  const flags: SensitiveFlag[] = [];
  if (MANIFESTS.has(base) || /^requirements[-_.].*\.txt$/.test(base) || base.endsWith(".gemspec") || base.endsWith(".csproj")) flags.push({ kind: "manifest" });
  if (LOCKFILES.has(base)) flags.push({ kind: "lockfile" });
  if (CI_PREFIXES.some((p) => lower.startsWith(p)) || CI_FILES.has(lower) || base === "jenkinsfile") flags.push({ kind: "ci" });
  if (HOOK_DIRS.includes(segs[0]) && segs.length > 1) flags.push({ kind: "git_hooks" });
  else if (HOOK_FILES.has(base)) flags.push({ kind: "git_hooks" });
  else if (base === ".gitattributes") flags.push({ kind: "git_hooks", detail: "attributes can name filter, diff and merge drivers" });
  else if (base === ".gitmodules") flags.push({ kind: "git_hooks", detail: "submodule URLs" });
  if (base === ".envrc") flags.push({ kind: "envrc" });
  if (EDITOR_FILES.has(lower) || (segs[0] === ".devcontainer" && segs.length > 1) || base.endsWith(".code-workspace") || lower.startsWith(".idea/runconfigurations/")) flags.push({ kind: "editor_tasks" });
  if (segs.slice(0, -1).some((s) => AGENT_DIRS.includes(s)) || AGENT_FILES.has(lower) || AGENT_FILES.has(base)) flags.push({ kind: "agent_config" });
  if (INSTRUCTION_FILES.has(base) || lower.startsWith(".github/instructions/")) flags.push({ kind: "agent_instructions" });
  if (base === ".env" || (base.startsWith(".env.") && base !== ".envrc")) flags.push({ kind: "env_file" });
  return flags;
}

/**
 * Why a changed file deserves a closer look in review (§3.5): path rules (manifests, lockfiles, CI,
 * git hook managers, `.envrc`, editor tasks, agent config and instructions, tracked `.env*`) on
 * either side of a rename, plus a new symlink, an executable bit turned on, and binaries.
 */
export function sensitiveFlags(
  f: Pick<DiffFile, "path" | "oldPath" | "status" | "oldMode" | "newMode" | "binary">,
  extra: { symlinkTarget?: string } = {},
): SensitiveFlag[] {
  const flags = pathFlags(f.path);
  if (f.oldPath && f.oldPath !== f.path) {
    for (const fl of pathFlags(f.oldPath)) if (!flags.some((x) => x.kind === fl.kind)) flags.push({ ...fl, detail: fl.detail ?? `was ${f.oldPath}` });
  }
  if (f.status !== "deleted" && f.newMode === "120000" && f.oldMode !== "120000") {
    const target = extra.symlinkTarget === undefined ? undefined : extra.symlinkTarget.length > 200 ? `${extra.symlinkTarget.slice(0, 200)}…` : extra.symlinkTarget;
    flags.push({ kind: "symlink", detail: target === undefined ? "new symlink" : `new symlink → ${target}` });
  }
  if (f.status !== "deleted" && f.newMode === "100755" && f.oldMode !== "100755") {
    flags.push({ kind: "executable", detail: f.oldMode && f.oldMode !== "000000" ? `mode ${f.oldMode} → ${f.newMode}` : "new executable file" });
  }
  if (f.binary) flags.push({ kind: "binary" });
  return flags;
}

/** Every host the added lines of a lockfile diff resolve packages from (`resolved "https://…"`, `git+ssh://…`, `git@host:`). */
export function lockfileHosts(addedLines: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const line of addedLines) {
    for (const m of line.matchAll(/\b(?:https?|git\+https?|git\+ssh|ssh|git):\/\/(?:[^@/\s"']+@)?([A-Za-z0-9.-]+)/g)) hosts.add(m[1].toLowerCase());
    for (const m of line.matchAll(/\bgit@([A-Za-z0-9.-]+):/g)) hosts.add(m[1].toLowerCase());
  }
  return [...hosts].sort();
}

const STATUS: Record<string, DiffFileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" };

// ===========================================================================
// Reading the clone safely
// ===========================================================================

/** Read a small regular file (never through a final symlink, never a FIFO). */
function readSmallFile(path: string, max = 4096): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > max) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Refuse a clone whose layout could redirect Rye: `repo/` and `repo/.git` must be real directories
 * (no gitfile, no symlink), `.git` must sit in `repo/` after realpath, and there must be no
 * `commondir` (which would point refs and config elsewhere).
 */
export function assertCloneLayout(ws: Pick<Workspace, "repoDir" | "userGitDir">): void {
  let repoSt;
  try {
    repoSt = lstatSync(ws.repoDir);
  } catch {
    throw new CodeGitError("The workspace is archived (no clone on disk)", "archived");
  }
  if (!repoSt.isDirectory()) throw new CodeGitError("The workspace's repo/ is not a directory", "unsafe");
  const gitDir = join(ws.repoDir, ".git");
  let st;
  try {
    st = lstatSync(gitDir);
  } catch {
    throw new CodeGitError("The clone has no .git directory", "unsafe");
  }
  if (!st.isDirectory()) throw new CodeGitError("The clone's .git is not a directory (a gitfile or symlink); refusing to use it", "unsafe");
  if (realpathSync(gitDir) !== join(realpathSync(ws.repoDir), ".git")) throw new CodeGitError("The clone's .git resolves outside the clone", "unsafe");
  if (existsSync(join(gitDir, "commondir"))) throw new CodeGitError("The clone's .git has a commondir; refusing to use it", "unsafe");
  const objects = join(gitDir, "objects");
  try {
    if (!lstatSync(objects).isDirectory()) throw new Error();
  } catch {
    throw new CodeGitError("The clone's .git/objects is not a directory", "unsafe");
  }
  const real = realpathSync(gitDir);
  const userReal = realpathSync(ws.userGitDir);
  if (real === userReal || real.startsWith(userReal + sep)) throw new CodeGitError("The clone's .git is inside the user's git dir", "unsafe");
}

/**
 * The clone's HEAD, read from `.git/HEAD`, loose refs and `packed-refs` without running git (so
 * the clone's config is never read). `sha` is null on an unborn branch; `branch` is null when HEAD
 * is detached.
 */
export function readCloneHead(repoDir: string): { sha: string | null; branch: string | null } {
  const gitDir = join(repoDir, ".git");
  const head = readSmallFile(join(gitDir, "HEAD"));
  if (head === null) throw new CodeGitError("The clone's HEAD can't be read", "unsafe");
  let content = head.trim();
  let branch: string | null = null;
  for (let depth = 0; depth < 5; depth++) {
    if (SHA_RE.test(content)) return { sha: content, branch };
    const m = /^ref: (refs\/[^\0\n]+)$/.exec(content);
    if (!m) throw new CodeGitError("The clone's HEAD is not a ref or an object id", "unsafe");
    const ref = m[1];
    if (ref.split("/").some((s) => s === "" || s === "." || s === "..")) throw new CodeGitError("The clone's HEAD names an invalid ref", "unsafe");
    if (depth === 0) branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    const loose = resolve(gitDir, ref);
    if (!loose.startsWith(gitDir + sep)) throw new CodeGitError("The clone's HEAD names an invalid ref", "unsafe");
    const value = readSmallFile(loose);
    if (value !== null) {
      content = value.trim();
      continue;
    }
    const packed = readSmallFile(join(gitDir, "packed-refs"), 64 * 1024 * 1024) ?? "";
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`) && SHA_RE.test(l.slice(0, l.indexOf(" "))));
    if (line) return { sha: line.slice(0, line.indexOf(" ")), branch };
    return { sha: null, branch }; // unborn
  }
  throw new CodeGitError("The clone's HEAD is a symref loop", "unsafe");
}

// ===========================================================================
// The engine room
// ===========================================================================

/** The clone's state as trees in the shadow store. */
export interface WorktreeState {
  /** The clone's HEAD commit (null on an unborn branch). */
  head: string | null;
  /** The clone's branch (null when detached). */
  branch: string | null;
  headTree: string;
  /** The clone's index as a tree; null when it can't be written (unmerged entries). */
  indexTree: string | null;
  /** Index plus every non-ignored file in the working tree, untracked included. */
  worktreeTree: string;
}

export interface SnapshotRefInfo {
  ref: string;
  sha: string;
  /** Epoch ms, from the `Rye-Snapshot-At` trailer (else the committer date). */
  createdAt: number;
}

/**
 * The hardened git operations shared by `CodeGit` and the workspace manager. Every command goes
 * through one `GitRunner` (`createGitRunner`), plus two file-piped commands (`pack-objects`,
 * `index-pack`) with the same argv prefix and env.
 */
export class HardenedGit {
  readonly run: GitRunner;
  private attrSource: boolean | null = null;

  constructor(private readonly opts: GitRunnerOptions = {}) {
    this.run = createGitRunner(opts);
  }

  /** Run in a context; returns the result whatever the exit code. */
  async exec(ctx: GitContext, args: readonly string[], o: { input?: string; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<GitResult> {
    return this.run([...ctx.pre, ...args], { cwd: ctx.cwd, input: o.input, signal: o.signal, env: { ...ctx.env, ...o.env } });
  }

  /** Run in a context; stdout, or a `CodeGitError` on a non-zero exit. */
  async ok(ctx: GitContext, args: readonly string[], o: { input?: string; signal?: AbortSignal; env?: Record<string, string>; what?: string } = {}): Promise<string> {
    const r = await this.exec(ctx, args, o);
    if (r.exitCode !== 0) throw new CodeGitError(`${o.what ?? `git ${args[0]}`} failed`, "git", r.stderr.trim().slice(0, 2000));
    return r.stdout;
  }

  /** `git --attr-source` (2.40+), so diffs ignore in-tree `.gitattributes` (`-diff` could hide text as "binary"). */
  async supportsAttrSource(): Promise<boolean> {
    if (this.attrSource !== null) return this.attrSource;
    const r = await this.run(["--version"], { cwd: "/" });
    const m = /git version (\d+)\.(\d+)/.exec(r.stdout);
    this.attrSource = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 40));
    return this.attrSource;
  }

  // ---- refs in the user's repo ----

  /** Resolve a revision to a commit in the user's repo, or null. */
  async resolveCommit(ws: Pick<Workspace, "userGitDir">, rev: string): Promise<string | null> {
    assertRevision(rev);
    const r = await this.exec(userContext(ws), ["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`]);
    const sha = r.stdout.trim();
    return r.exitCode === 0 && SHA_RE.test(sha) ? sha : null;
  }

  async refExists(ws: Pick<Workspace, "userGitDir">, ref: string): Promise<boolean> {
    const r = await this.exec(userContext(ws), ["show-ref", "--verify", "-q", "--", ref]);
    return r.exitCode === 0;
  }

  /**
   * The branch HEAD points at when that branch has no commits yet (a repo right after `git init`,
   * or `checkout --orphan`): HEAD is a symbolic ref to `refs/heads/<name>` and that ref doesn't
   * exist. Null otherwise (HEAD detached, or its branch has commits). Read-only.
   */
  async unbornHead(ctx: GitContext): Promise<string | null> {
    const r = await this.exec(ctx, ["symbolic-ref", "-q", "HEAD"]);
    const ref = r.stdout.trim();
    if (r.exitCode !== 0 || !ref.startsWith("refs/heads/") || ref.length <= "refs/heads/".length) return null;
    const exists = await this.exec(ctx, ["show-ref", "--verify", "-q", "--", ref]);
    return exists.exitCode === 0 ? null : ref.slice("refs/heads/".length);
  }

  /** Local branch names (`refs/heads/*`, short). Read-only. */
  async branchNames(ctx: GitContext): Promise<string[]> {
    const r = await this.exec(ctx, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return r.exitCode === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  }

  /**
   * Why `rev` names no commit in a repo, naming what does exist, for an error message (instead of
   * "no commit named dev"): its branches, or, with none, that it has no commits yet.
   */
  async missingBaseMessage(ctx: GitContext, repoName: string, rev: string): Promise<string> {
    const [branches, unborn] = await Promise.all([this.branchNames(ctx), this.unbornHead(ctx)]);
    const lead = `${repoName} has no branch or commit named "${rev}".`;
    if (branches.length > 0) {
      const shown = branches.slice(0, 20).join(", ");
      const more = branches.length > 20 ? ` and ${branches.length - 20} more` : "";
      const empty = unborn ? ` (and ${unborn}, checked out, with no commits yet)` : "";
      return `${lead} Its branches: ${shown}${more}${empty}.`;
    }
    if (unborn) return `${lead} It has no commits yet; its checked-out branch is ${unborn}, so use that as the base (the session starts from an empty project).`;
    return `${lead} It has no branches yet.`;
  }

  /**
   * Create `ref` at `sha` in the user's repo, only if it doesn't exist: `update-ref <ref> <sha>
   * 0000…`. Refuses any ref outside `refs/rye/**` and `refs/heads/rye/**`.
   */
  async createRefOnly(ws: Pick<Workspace, "userGitDir">, ref: string, sha: string): Promise<"created" | "exists"> {
    if (!isRyeWritableRef(ref)) throw new CodeGitError(`Rye only writes refs/rye/* and new rye/* branches, not ${ref}`, "invalid");
    if (!SHA_RE.test(sha)) throw new CodeGitError("Invalid object id", "invalid");
    const ctx = userContext(ws);
    const fmt = await this.exec(ctx, ["check-ref-format", ref]);
    if (fmt.exitCode !== 0) throw new CodeGitError(`Invalid ref name: ${ref}`, "invalid");
    const r = await this.exec(ctx, ["update-ref", "--no-deref", "-m", "rye: create", ref, sha, zeroOid(sha)]);
    if (r.exitCode === 0) return "created";
    if (await this.refExists(ws, ref)) return "exists";
    throw new CodeGitError(`Could not create ${ref}`, "git", r.stderr.trim());
  }

  /** Delete one of this session's refs (`refs/rye/<session>/…`), only if it still points at `oldSha`. */
  async deleteSessionRef(ws: Pick<Workspace, "userGitDir" | "refPrefix">, ref: string, oldSha: string): Promise<boolean> {
    if (!ws.refPrefix.startsWith(RYE_REF_PREFIX) || !ref.startsWith(ws.refPrefix) || !isRyeWritableRef(ref)) {
      throw new CodeGitError(`Refusing to delete ${ref}`, "invalid");
    }
    const r = await this.exec(userContext(ws), ["update-ref", "--no-deref", "-d", ref, oldSha]);
    return r.exitCode === 0;
  }

  /** Refs under a prefix in the user's repo, with their snapshot time. */
  async listRefs(ws: Pick<Workspace, "userGitDir">, prefix: string): Promise<SnapshotRefInfo[]> {
    const out = await this.ok(userContext(ws), [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(trailers:key=Rye-Snapshot-At,valueonly,separator=)",
      prefix,
    ]);
    const refs: SnapshotRefInfo[] = [];
    for (const line of out.split("\n")) {
      const [ref, sha, date, at] = line.split("\t");
      if (!ref || !sha) continue;
      const ms = Number((at ?? "").trim());
      refs.push({ ref, sha, createdAt: Number.isFinite(ms) && ms > 0 ? ms : Number(date) * 1000 });
    }
    return refs;
  }

  // ---- the shadow context ----

  /** Make sure the shadow git dir exists (a bare repo with no templates). */
  async ensureShadow(ws: Workspace): Promise<void> {
    const dir = shadowGitDir(ws);
    if (existsSync(join(dir, "HEAD"))) return;
    mkdirSync(ws.sessionDir, { recursive: true });
    await this.ok({ pre: [], env: {}, cwd: ws.sessionDir }, ["init", "-q", "--bare", "--template=", dir], { what: "git init (shadow)" });
  }

  private tmpPath(ws: Workspace, what: string): string {
    return join(shadowGitDir(ws), `${what}-${randomBytes(6).toString("hex")}`);
  }

  /**
   * A Rye-owned copy of the clone's index, checked entry by entry (`isSafeRepoPath`), or a fresh
   * index from HEAD when the clone's is missing, odd or unreadable.
   */
  private async copyIndex(ws: Workspace, headTree: string | null): Promise<string> {
    const tmp = this.tmpPath(ws, "index");
    const real = join(ws.repoDir, ".git", "index");
    let copied = false;
    try {
      if (lstatSync(real).isFile()) {
        copyFileSync(real, tmp);
        copied = true;
      }
    } catch {
      /* no index */
    }
    if (copied) {
      const r = await this.exec(shadowContext(ws, tmp), ["-c", "core.splitIndex=false", "ls-files", "-z", "-s"]);
      const safe = r.exitCode === 0 && r.stdout.split("\0").every((e) => e === "" || isSafeRepoPath(e.slice(e.indexOf("\t") + 1)));
      if (safe) return tmp;
      rmSync(tmp, { force: true });
    }
    if (headTree) await this.ok(shadowContext(ws, tmp), ["read-tree", headTree], { what: "git read-tree" });
    return tmp;
  }

  async emptyTree(ws: Workspace): Promise<string> {
    return (await this.ok(shadowContext(ws, null), ["mktree"], { input: "" })).trim();
  }

  /** The clone's HEAD, index and working tree as trees, without touching the clone. */
  async worktreeState(ws: Workspace, signal?: AbortSignal): Promise<WorktreeState> {
    assertCloneLayout(ws);
    await this.ensureShadow(ws);
    const { sha: head, branch } = readCloneHead(ws.repoDir);
    const headTree = head
      ? (await this.ok(shadowContext(ws, null), ["rev-parse", "--verify", `${head}^{tree}`], { signal, what: "reading the clone's HEAD" })).trim()
      : await this.emptyTree(ws);
    const index = await this.copyIndex(ws, head ? headTree : null);
    try {
      const ctx = shadowContext(ws, index);
      const it = await this.exec(ctx, ["-c", "core.splitIndex=false", "write-tree"], { signal });
      const indexTree = it.exitCode === 0 ? it.stdout.trim() : null;
      await this.ok(ctx, ["-c", "core.splitIndex=false", "add", "-A", "--ignore-errors"], { signal, what: "reading the working tree" });
      const worktreeTree = (await this.ok(ctx, ["-c", "core.splitIndex=false", "write-tree"], { signal })).trim();
      return { head, branch, headTree, indexTree, worktreeTree };
    } finally {
      rmSync(index, { force: true });
      rmSync(`${index}.lock`, { force: true });
    }
  }

  /** A commit in the shadow store. */
  async commitTree(ws: Workspace, tree: string, parents: readonly string[], message: string): Promise<string> {
    const args = ["commit-tree", "--no-gpg-sign"];
    for (const p of parents) args.push("-p", p);
    args.push("-F", "-", tree);
    return (await this.ok(shadowContext(ws, null), args, { input: message, what: "git commit-tree" })).trim();
  }

  /**
   * Copy every object reachable from `tips` (and not from `exclude`) into the user's repo:
   * `pack-objects --revs` in the shadow context → `index-pack --strict` in the user's repo (fsck
   * checks every object, so a crafted tree with a `.git` entry is refused).
   */
  async transferToUser(ws: Workspace, tips: readonly string[], exclude: readonly string[]): Promise<void> {
    const pack = this.tmpPath(ws, "transfer.pack");
    const input = `${tips.join("\n")}\n--not\n${exclude.filter((s) => SHA_RE.test(s)).join("\n")}\n`;
    try {
      const shadow = shadowContext(ws, null);
      const p = await spawnGit([...shadow.pre, "pack-objects", "--revs", "--stdout", "-q"], { ...this.opts, cwd: shadow.cwd, env: shadow.env, input, stdoutPath: pack });
      if (p.exitCode !== 0) throw new CodeGitError("Packing the session's objects failed", "git", p.stderr.trim());
      const header = Buffer.alloc(12);
      const fd = openSync(pack, "r");
      try {
        readSync(fd, header, 0, 12, 0);
      } finally {
        closeSync(fd);
      }
      if (header.readUInt32BE(8) === 0) return; // nothing new
      const user = userContext(ws);
      const ip = await spawnGit([...user.pre, "index-pack", "--strict", "--stdin"], { ...this.opts, cwd: user.cwd, env: user.env, stdinPath: pack });
      if (ip.exitCode !== 0) throw new CodeGitError("The session's objects failed git's checks and were not copied", "unsafe", ip.stderr.trim());
    } finally {
      rmSync(pack, { force: true });
    }
  }

  /** Shas already in the user's repo that bound what a transfer has to send. */
  async knownUserShas(ws: Workspace): Promise<string[]> {
    const refs = await this.listRefs(ws, ws.refPrefix);
    return [ws.baseSha, ...refs.map((r) => r.sha)];
  }

  /**
   * The session's current state as one commit in the user's repo: HEAD when the clone is clean,
   * else a commit of the working tree on top of HEAD (`message`).
   */
  async commitCurrentState(ws: Workspace, message: string, st?: WorktreeState): Promise<{ sha: string; state: WorktreeState }> {
    const state = st ?? (await this.worktreeState(ws));
    const head = state.head ?? ws.baseSha;
    const sha = state.head && state.worktreeTree === state.headTree ? state.head : await this.commitTree(ws, state.worktreeTree, [head], message);
    await this.transferToUser(ws, [sha], await this.knownUserShas(ws));
    return { sha, state };
  }

  // ---- diffs (shadow context, attributes off) ----

  private async diffPre(ws: Workspace): Promise<string[]> {
    return (await this.supportsAttrSource()) ? [`--attr-source=${await this.emptyTree(ws)}`] : [];
  }

  async diffTree(ws: Workspace, args: readonly string[], from: string, to: string, paths: readonly string[] = [], o: { maxBytes?: number } = {}): Promise<{ out: string; truncated: boolean }> {
    const ctx = shadowContext(ws, null);
    const full = [...ctx.pre, ...(await this.diffPre(ws)), "diff-tree", "-r", ...HARDENED_GIT_DIFF_OPTIONS, "--no-color", ...args, from, to, "--", ...paths];
    const r = await spawnGit(full, { ...this.opts, cwd: ctx.cwd, env: ctx.env, maxOutputBytes: o.maxBytes });
    if (r.exitCode !== 0) throw new CodeGitError("git diff-tree failed", "git", r.stderr.trim());
    return { out: r.stdout, truncated: r.truncated };
  }

  async changedNames(ws: Workspace, from: string, to: string): Promise<Map<string, string>> {
    const { out } = await this.diffTree(ws, ["-z", "--name-status", "--no-renames"], from, to);
    const t = out.split("\0");
    const m = new Map<string, string>();
    for (let i = 0; i + 1 < t.length; i += 2) if (t[i]) m.set(t[i + 1], t[i]);
    return m;
  }

  /** Replace the clone's real index with a Rye-built one (rename, so a symlinked index is replaced, not followed). */
  replaceCloneIndex(ws: Workspace, built: string): void {
    assertCloneLayout(ws);
    const gitDir = join(ws.repoDir, ".git");
    if (existsSync(join(gitDir, "index.lock"))) throw new CodeGitError("The clone's index is locked (is the agent running git?)", "busy");
    renameSync(built, join(gitDir, "index"));
  }

  /** A Rye-owned working copy of the clone's index for stage/discard. */
  async indexForUpdate(ws: Workspace): Promise<{ path: string; head: string | null; headTree: string | null }> {
    assertCloneLayout(ws);
    await this.ensureShadow(ws);
    const { sha: head } = readCloneHead(ws.repoDir);
    const headTree = head ? (await this.ok(shadowContext(ws, null), ["rev-parse", "--verify", `${head}^{tree}`])).trim() : null;
    return { path: await this.copyIndex(ws, headTree), head, headTree };
  }

  shadow(ws: Workspace, index: string | null): GitContext {
    return shadowContext(ws, index);
  }

  user(ws: Pick<Workspace, "userGitDir">): GitContext {
    return userContext(ws);
  }

  fresh(repoDir: string): GitContext {
    return freshCloneContext(repoDir);
  }
}

// ===========================================================================
// CodeGit
// ===========================================================================

function stageOf(path: string, staged: Map<string, string>, unstaged: Map<string, string>): FileStage {
  const s = staged.has(path);
  const u = unstaged.get(path);
  if (!s && !u) return "committed";
  if (u === "A" && !s) return "untracked";
  if (s && u) return "partly_staged";
  return s ? "staged" : "unstaged";
}

/** A rename's stage from its two sides: the same, the uncommitted one, or partly staged. */
function combineStages(a: FileStage, b: FileStage): FileStage {
  if (a === b || b === "committed") return a;
  if (a === "committed") return b;
  return "partly_staged";
}

function validateBranchName(name: string): string {
  if (typeof name !== "string" || !name.startsWith(RYE_BRANCH_PREFIX) || name.length <= RYE_BRANCH_PREFIX.length) {
    throw new CodeGitError(`Branch names must start with ${RYE_BRANCH_PREFIX}`, "invalid");
  }
  const ref = `refs/heads/${name}`;
  if (!isRyeWritableRef(ref)) throw new CodeGitError(`Invalid branch name: ${name}`, "invalid");
  return ref;
}

/** Map merge-tree's conflict type ("CONFLICT (modify/delete): …") onto `MergeConflict.kind`. */
export function conflictKind(typeOrMessage: string): MergeConflict["kind"] {
  const m = /^CONFLICT \(([^)]+)\)/.exec(typeOrMessage);
  const t = (m ? m[1] : typeOrMessage).toLowerCase();
  if (t === "content" || t === "contents" || t === "binary") return "content";
  if (t === "add/add") return "add_add";
  if (t === "modify/delete" || t === "rename/delete") return "modify_delete";
  if (t.startsWith("rename")) return "rename";
  return "other";
}

/**
 * Parse `git merge-tree --write-tree -z --name-only` output: the tree, then conflicted paths, then
 * (after an empty field) messages as `<n> <path>… <type> <message>`.
 */
export function parseMergeTree(out: string): { tree: string; conflicts: MergeConflict[] } {
  const t = out.split("\0");
  const tree = t[0]?.trim() ?? "";
  let i = 1;
  const paths: string[] = [];
  while (i < t.length && t[i] !== "") paths.push(t[i++]);
  i++;
  const byPath = new Map<string, MergeConflict>();
  while (i < t.length) {
    const n = Number(t[i]);
    if (!Number.isInteger(n) || n <= 0) break;
    const ps = t.slice(i + 1, i + 1 + n);
    const type = t[i + 1 + n] ?? "";
    const message = (t[i + 2 + n] ?? "").trim();
    i += 3 + n;
    if (!type.startsWith("CONFLICT")) continue;
    for (const p of ps) if (!byPath.has(p)) byPath.set(p, { path: p, kind: conflictKind(message.startsWith("CONFLICT") ? message : type), message });
  }
  for (const p of paths) if (!byPath.has(p)) byPath.set(p, { path: p, kind: "other" });
  return { tree, conflicts: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export interface CodeGitOptions extends GitRunnerOptions {
  /** Share one runner with the workspace manager. */
  git?: HardenedGit;
}

/** `CodeGit` (code/types.ts) on the hardened runner. */
export function createCodeGit(o: CodeGitOptions = {}): CodeGit & { readonly git: HardenedGit } {
  const git = o.git ?? new HardenedGit(o);

  const sinceCommit = async (ws: Workspace, since: ChangesSince): Promise<string> => {
    if (since === "base") return ws.baseSha;
    const m = /^turn-(\d+)$/.exec(String(since));
    if (!m) throw new CodeGitError(`Invalid comparison point: ${since}`, "invalid");
    const sha = await git.resolveCommit(ws, `${ws.refPrefix}turn-${Number(m[1])}`);
    if (!sha) throw new CodeGitError(`No snapshot for ${since}`, "not_found");
    return sha;
  };

  /** Staged and unstaged paths relative to HEAD and the index. */
  const stageMaps = async (ws: Workspace, st: WorktreeState) => {
    if (st.indexTree === null) return { staged: new Map<string, string>(), unstaged: await git.changedNames(ws, st.headTree, st.worktreeTree) };
    const [staged, unstaged] = await Promise.all([git.changedNames(ws, st.headTree, st.indexTree), git.changedNames(ws, st.indexTree, st.worktreeTree)]);
    return { staged, unstaged };
  };

  const listFiles = async (ws: Workspace, from: string, st: WorktreeState): Promise<DiffFile[]> => {
    const [raw, num, maps] = await Promise.all([
      git.diffTree(ws, ["-z", "--raw", "-M"], from, st.worktreeTree).then((r) => parseRawZ(r.out)),
      git.diffTree(ws, ["-z", "--numstat", "-M"], from, st.worktreeTree).then((r) => parseNumstatZ(r.out)),
      stageMaps(ws, st),
    ]);
    const files: DiffFile[] = [];
    for (const e of raw) {
      const n = num.get(e.path) ?? { additions: 0, deletions: 0, binary: false };
      const status = STATUS[e.status] ?? "modified";
      let stage = stageOf(e.path, maps.staged, maps.unstaged);
      if (e.oldPath) stage = combineStages(stage, stageOf(e.oldPath, maps.staged, maps.unstaged));
      const f: DiffFile = {
        path: e.path,
        ...(e.oldPath ? { oldPath: e.oldPath } : {}),
        status,
        additions: n.additions,
        deletions: n.deletions,
        binary: n.binary,
        stage,
        sensitive: [],
      };
      const modeChanged = e.oldMode !== e.newMode;
      if (e.oldMode !== "000000" && (status === "deleted" || modeChanged)) f.oldMode = e.oldMode;
      if (e.newMode !== "000000" && (status === "added" || modeChanged)) f.newMode = e.newMode;
      let symlinkTarget: string | undefined;
      if (e.newMode === "120000" && e.oldMode !== "120000") {
        const r = await git.exec(git.shadow(ws, null), ["cat-file", "blob", e.newSha]);
        if (r.exitCode === 0) symlinkTarget = r.stdout;
      }
      f.sensitive = sensitiveFlags({ ...f, oldMode: e.oldMode, newMode: e.newMode }, { symlinkTarget });
      if (f.sensitive.some((s) => s.kind === "lockfile") && !f.binary && status !== "deleted") {
        const { out } = await git.diffTree(ws, ["-p", "-U0", "-M"], from, st.worktreeTree, e.oldPath ? [e.oldPath, e.path] : [e.path], { maxBytes: MAX_DIFF_BYTES * 4 });
        f.resolvedHosts = lockfileHosts(out.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")));
      }
      files.push(f);
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };

  const statOf = (files: readonly DiffFile[]): DiffStat => ({
    files: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
  });

  return {
    git,

    async status(ws) {
      const st = await git.worktreeState(ws);
      const realTip = await git.resolveCommit(ws, ws.baseRef);
      // A session whose base had no commits (`ws.baseUnborn`) started from an empty root commit Rye
      // made. While the base still has none, the pinned base stands in for its tip: behind 0, ahead
      // = the session's commits.
      const baseUnborn = !realTip && ws.baseUnborn === true;
      const baseTip = realTip ?? ws.baseSha;
      let ahead = 0;
      let behind = 0;
      if (st.head) {
        const shadow = git.shadow(ws, null);
        // Once the user commits to the base, its history starts at their own root, not Rye's empty
        // one, so the two share nothing (unless the user merged or reset onto a rye/* branch, which
        // brings the empty root in). Then a symmetric difference would count Rye's placeholder root
        // as the session's work: ahead is the session's commits after the empty root, behind is
        // every commit of the base.
        const unrelated =
          ws.baseUnborn === true && !!realTip && realTip !== ws.baseSha && (await git.exec(shadow, ["merge-base", realTip, st.head])).exitCode !== 0;
        if (unrelated) {
          ahead = Number((await git.ok(shadow, ["rev-list", "--count", st.head, `^${ws.emptyRootSha ?? ws.baseSha}`])).trim()) || 0;
          behind = Number((await git.ok(shadow, ["rev-list", "--count", baseTip])).trim()) || 0;
        } else {
          const out = await git.ok(shadow, ["rev-list", "--left-right", "--count", `${baseTip}...${st.head}`]);
          const [b, a] = out.trim().split(/\s+/).map(Number);
          behind = b || 0;
          ahead = a || 0;
        }
      } else {
        behind = Number((await git.ok(git.shadow(ws, null), ["rev-list", "--count", baseTip])).trim()) || 0;
      }
      // Uncommitted files, a rename counted once (by its new path).
      const dirtyNames = new Set<string>();
      const renamedFrom = new Set<string>();
      for (const to of st.indexTree && st.indexTree !== st.headTree ? [st.worktreeTree, st.indexTree] : [st.worktreeTree]) {
        for (const e of parseRawZ((await git.diffTree(ws, ["-z", "--raw", "-M"], st.headTree, to)).out)) {
          dirtyNames.add(e.path);
          if (e.oldPath) renamedFrom.add(e.oldPath);
        }
      }
      for (const p of renamedFrom) dirtyNames.delete(p);
      const num = parseNumstatZ((await git.diffTree(ws, ["-z", "--numstat", "-M"], ws.baseSha, st.worktreeTree)).out);
      let additions = 0;
      let deletions = 0;
      for (const v of num.values()) {
        additions += v.additions;
        deletions += v.deletions;
      }
      return {
        branch: st.branch,
        head: st.head ?? "",
        base: ws.baseRef,
        baseSha: ws.baseSha,
        baseTip,
        ahead,
        behind,
        dirty: dirtyNames.size > 0,
        dirtyFiles: dirtyNames.size,
        stat: { files: num.size, additions, deletions },
        ...(baseUnborn ? { baseUnborn: true } : {}),
      } satisfies BranchStatus;
    },

    async changes(ws, since) {
      const from = await sinceCommit(ws, since);
      const st = await git.worktreeState(ws);
      const files = await listFiles(ws, from, st);
      return { files, stat: statOf(files) };
    },

    async fileDiff(ws, path, since) {
      assertSafePaths([path]);
      const from = await sinceCommit(ws, since);
      const st = await git.worktreeState(ws);
      const files = await listFiles(ws, from, st);
      const file = files.find((f) => f.path === path) ?? files.find((f) => f.oldPath === path);
      if (!file) return null;
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const { out, truncated: cut } = await git.diffTree(ws, ["-p", "-M", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative"], from, st.worktreeTree, paths, { maxBytes: MAX_DIFF_BYTES });
      let text = out;
      if (cut) text = text.slice(0, text.lastIndexOf("\n") + 1);
      const parsed = parseHunks(text);
      return { ...file, hunks: file.binary || parsed.binary ? [] : parsed.hunks, ...(cut || parsed.truncated ? { truncated: true } : {}) };
    },

    async stage(ws, paths, staged) {
      assertSafePaths(paths);
      const idx = await git.indexForUpdate(ws);
      try {
        const ctx = git.shadow(ws, idx.path);
        if (staged) {
          // `add -A -- <path>` stages adds, edits and deletions; skip paths neither on disk nor in the index.
          const inIndex = new Set((await git.ok(ctx, ["ls-files", "-z", "--", ...paths])).split("\0").filter(Boolean));
          const present = paths.filter((p) => inIndex.has(p) || existsLstat(join(ws.repoDir, p)));
          if (present.length) await git.ok(ctx, ["-c", "core.splitIndex=false", "add", "-A", "--", ...present], { what: "git add" });
        } else if (idx.head) {
          await git.ok(ctx, ["-c", "core.splitIndex=false", "reset", "-q", idx.head, "--", ...paths], { what: "git reset" });
        } else {
          await git.ok(ctx, ["-c", "core.splitIndex=false", "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...paths], { what: "git rm --cached" });
        }
        git.replaceCloneIndex(ws, idx.path);
      } finally {
        rmSync(idx.path, { force: true });
        rmSync(`${idx.path}.lock`, { force: true });
      }
    },

    async discard(ws, paths) {
      assertSafePaths(paths);
      const st = await git.worktreeState(ws);
      // A rename's old side goes back too.
      const renames = parseRawZ((await git.diffTree(ws, ["-z", "--raw", "-M"], st.headTree, st.worktreeTree)).out).filter((e) => e.oldPath);
      const all = new Set(paths);
      for (const p of paths) for (const r of renames) if (r.path === p && r.oldPath) all.add(r.oldPath);
      const list = [...all];
      const inHead = new Set(
        st.head ? (await git.ok(git.shadow(ws, null), ["ls-tree", "-r", "-z", "--name-only", st.head, "--", ...list])).split("\0").filter(Boolean) : [],
      );
      const restore = list.filter((p) => inHead.has(p));
      const drop = list.filter((p) => !inHead.has(p));
      const idx = await git.indexForUpdate(ws);
      try {
        const ctx = git.shadow(ws, idx.path);
        if (restore.length && st.head) await git.ok(ctx, ["-c", "core.splitIndex=false", "checkout", "-q", st.head, "--", ...restore], { what: "git checkout" });
        if (drop.length) {
          await git.ok(ctx, ["-c", "core.splitIndex=false", "rm", "-q", "--cached", "--ignore-unmatch", "--", ...drop], { what: "git rm --cached" });
          await git.ok(ctx, ["clean", "-f", "-q", "--", ...drop], { what: "git clean" });
        }
        git.replaceCloneIndex(ws, idx.path);
      } finally {
        rmSync(idx.path, { force: true });
        rmSync(`${idx.path}.lock`, { force: true });
      }
    },

    async createBranch(ws, o) {
      const ref = validateBranchName(o.name);
      if (await git.refExists(ws, ref)) return { status: "branch_exists", branch: o.name };
      let sha: string;
      if (o.mode === "squash") {
        const message = o.message?.trim();
        if (!message) throw new CodeGitError("A squash needs a commit message", "invalid");
        const st = await git.worktreeState(ws);
        sha = await git.commitTree(ws, st.worktreeTree, [ws.baseSha], `${message}\n`);
        await git.transferToUser(ws, [sha], await git.knownUserShas(ws));
      } else {
        sha = (await git.commitCurrentState(ws, `${o.message?.trim() || "Uncommitted changes from Rye code session"}\n`)).sha;
      }
      if ((await git.createRefOnly(ws, ref, sha)) === "exists") return { status: "branch_exists", branch: o.name };
      const commits = Number((await git.ok(git.user(ws), ["rev-list", "--count", sha, `^${ws.baseSha}`])).trim()) || 0;
      return { status: "created", branch: o.name, sha, commits };
    },

    async mergeWithBase(ws, o): Promise<MergeResult> {
      const ref = validateBranchName(o.name);
      if (await git.refExists(ws, ref)) return { status: "branch_exists", branch: o.name };
      const baseTip = await git.resolveCommit(ws, ws.baseRef);
      if (!baseTip) {
        if (ws.baseUnborn) throw new CodeGitError(`${ws.baseRef} has no commits yet, so there is nothing to merge; use Create branch.`, "invalid");
        throw new CodeGitError(`The base ${ws.baseRef} no longer exists. ${await git.missingBaseMessage(git.user(ws), ws.repoName, ws.baseRef)}`, "not_found");
      }
      const user = git.user(ws);
      // A session started on a base with no commits begins at Rye's empty root; once the user has
      // committed to the base, the two histories are unrelated (no merge base). Merging them is
      // still safe: merge-tree works on objects only, the empty tree stands in as the common
      // ancestor (which is what the session really started from), files added on both sides come
      // back as add/add conflicts, and the result is only ever a new branch. Any other session
      // with no history in common with its base is refused with a clear message.
      const { sha: tip } = await git.commitCurrentState(ws, "Uncommitted changes from Rye code session\n");
      const unrelated = (await git.exec(user, ["merge-base", baseTip, tip])).exitCode === 1;
      if (unrelated && !ws.baseUnborn) {
        throw new CodeGitError(`This session and ${ws.baseRef} share no history, so they can't be merged; use Create branch.`, "invalid");
      }
      let sha: string;
      if ((await git.exec(user, ["merge-base", "--is-ancestor", baseTip, tip])).exitCode === 0) {
        sha = tip; // already contains the base
      } else {
        const r = await git.exec(user, ["merge-tree", "--write-tree", "-z", "--name-only", ...(unrelated ? ["--allow-unrelated-histories"] : []), tip, baseTip]);
        if (r.exitCode === 1) return { status: "conflicts", baseTip, conflicts: parseMergeTree(r.stdout).conflicts };
        if (unrelated && r.exitCode === 129) {
          throw new CodeGitError(`${ws.baseRef} got its first commits after this session started, and this git can't merge unrelated histories (it needs git 2.39 or newer); use Create branch.`, "invalid");
        }
        if (r.exitCode !== 0) throw new CodeGitError("git merge-tree failed", "git", r.stderr.trim());
        const { tree } = parseMergeTree(r.stdout);
        const message = o.message?.trim() || `Merge ${ws.baseRef} into ${o.name}`;
        sha = (await git.ok(user, ["commit-tree", "--no-gpg-sign", "-p", tip, "-p", baseTip, "-F", "-", tree], { input: `${message}\n` })).trim();
      }
      if ((await git.createRefOnly(ws, ref, sha)) === "exists") return { status: "branch_exists", branch: o.name };
      return { status: "merged", branch: o.name, sha, baseTip };
    },
  };
}

function existsLstat(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
