/**
 * Code sessions: the OS sandbox (docs/design/code-sessions.md §3.2, §3.3, §3.6).
 *
 * - `buildSandboxPlan`: the engine-neutral `SandboxPlan` for a workspace: writes only in repo/,
 *   tmp/ and cache/ (plus the repo's `allow_write`); the secrets list (`secretPaths`, shared with
 *   `pathVerdict`), Rye's config and data dirs and the user's checkout unreadable (except this
 *   session's directory and the objects the clone borrows); network off except `allowedDomains`.
 * - `claudeSandboxSettings`: that plan as the Claude Agent SDK's `sandbox` option.
 * - `workspaceEnv` / `codeEngineEnv`: the engine's scrubbed environment: `claudeEnv()` (an
 *   allowlist, harness/env.ts) plus TMPDIR, cache variables and PATH with the git shim first.
 * - `createSandboxProbe`: whether the sandbox can run here, from the platform and the files the
 *   sandbox needs. It never starts a sandbox (`sandbox-exec`, `bwrap`) itself.
 * - `installGitShim`: the git shim (code/shim/git.ts), re-exported for the workspace.
 */

import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { claudeEnv } from "../harness/env.js";
import { canonicalPath, isLocalHost, secretPaths } from "./policy.js";
import type { BuildSandboxPlan, CodeSandboxStatus, SandboxPlan, SandboxProbe, Workspace } from "./types.js";

export { GIT_SHIM_SCRIPT, installGitShim } from "./shim/git.js";

const canon = (p: string) => {
  try {
    return canonicalPath(p);
  } catch {
    return p;
  }
};

const unique = (xs: string[]) => [...new Set(xs)];

/**
 * The OS sandbox for a run in `ws`. Paths are canonical (`/var/…` is `/private/var/…` on macOS),
 * since the sandbox compares resolved paths.
 */
export const buildSandboxPlan: BuildSandboxPlan = (ws, policy, repo, scope) => {
  const home = scope.home;
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const repoDir = canon(ws.repoDir);
  const extraWrite = (repo.allow_write ?? []).map((p) => canon(isAbsolute(expand(p)) ? expand(p) : join(repoDir, p)));
  const worktree = ws.isolation === "worktree";
  return {
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    cwd: repoDir,
    filesystem: {
      allowWrite: unique([repoDir, canon(ws.tmpDir), canon(ws.cacheDir), ...extraWrite]),
      denyWrite: unique([
        // The shim stays as Rye wrote it, and hooks can't be planted for later git runs.
        canon(ws.binDir),
        join(repoDir, ".git", "hooks"),
        // Worktree mode shares the user's .git: read it, never write it (Rye makes the commits).
        ...(worktree ? [canon(ws.userGitDir)] : []),
      ]),
      allowRead: unique([
        canon(ws.sessionDir),
        // The clone borrows the user's objects through objects/info/alternates.
        canon(ws.userObjectsDir),
        ...(worktree ? [canon(ws.userGitDir)] : []),
      ]),
      denyRead: unique([
        ...secretPaths({ home, dataDir: scope.dataDir, configDir: scope.configDir }).map(canon),
        // The user's checkout (its untracked .env files, other branches' work): the session has its own clone.
        canon(ws.userRepoPath),
      ]),
    },
    network: {
      allowedDomains: [...policy.allowedDomains],
      // OFF: with it on, sandboxed commands could also CONNECT to localhost, which reached Rye's own API
      // (verified with a real run: `node -e fetch('http://127.0.0.1:<rye port>/health')` got through). An
      // agent that can call Rye can answer its own approvals, start chats and write memory. Dev servers that
      // must listen locally are the cost; revisit only with a loopback rule that excludes Rye's ports.
      allowLocalBinding: false,
    },
  };
};

/** The plan with an approval's hosts added for one command ("the current approval's hosts"). */
export function withApprovedHosts(plan: SandboxPlan, hosts: readonly string[]): SandboxPlan {
  // Local and private hosts never join the allowlist, even approved: the sandbox's proxy runs outside it.
  const approved = hosts.map((h) => h.toLowerCase()).filter((h) => !isLocalHost(h));
  return { ...plan, network: { ...plan.network, allowedDomains: unique([...plan.network.allowedDomains, ...approved]) } };
}

/**
 * The plan as the Claude Agent SDK's `sandbox` option (`Options.sandbox`, `SandboxSettings` in the
 * installed sdk.d.ts):
 * - `enabled` with `failIfUnavailable`: no sandbox, no code session.
 * - `allowUnsandboxedCommands: false`: a command's `dangerouslyDisableSandbox` is ignored.
 * - `autoAllowBashIfSandboxed: false`: Rye's `PreToolUse` hook judges every command.
 * - `network.strictAllowlist: true`: a host not on the list is refused by the sandbox instead of
 *   prompting; Rye asks before the command runs (`commandVerdict`) and adds approved hosts.
 * - No `network.allowMachLookup`, so keychain lookups stay denied.
 * Claude Code's protected paths (`.git/hooks`, `.claude/settings*.json`, `.mcp.json`, `.gitconfig`)
 * stay protected on top.
 */
export function claudeSandboxSettings(plan: SandboxPlan): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: plan.failIfUnavailable,
    allowUnsandboxedCommands: plan.allowUnsandboxedCommands,
    autoAllowBashIfSandboxed: false,
    network: {
      allowedDomains: [...plan.network.allowedDomains],
      allowLocalBinding: plan.network.allowLocalBinding,
      strictAllowlist: true,
    },
    filesystem: {
      allowWrite: [...plan.filesystem.allowWrite],
      denyWrite: [...plan.filesystem.denyWrite],
      allowRead: [...plan.filesystem.allowRead],
      denyRead: [...plan.filesystem.denyRead],
    },
  };
}

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * What a workspace adds to the engine's scrubbed env (§3.1, §3.6): temp and cache dirs inside the
 * workspace (so toolchains write where the sandbox lets them), installs without dependency scripts
 * where the package manager supports it, no git credential prompts, and PATH with the git shim's
 * `binDir` first. `source` (default `process.env`) only provides the PATH to extend.
 */
export function workspaceEnv(ws: Workspace, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const cache = (sub: string) => join(ws.cacheDir, sub);
  const path = (source.PATH || DEFAULT_PATH).split(delimiter).filter((d) => d && d !== ws.binDir);
  return {
    PATH: [ws.binDir, ...path].join(delimiter),
    TMPDIR: ws.tmpDir,
    TMP: ws.tmpDir,
    TEMP: ws.tmpDir,
    XDG_CACHE_HOME: ws.cacheDir,
    BUN_INSTALL_CACHE_DIR: cache("bun"),
    npm_config_cache: cache("npm"),
    // ~/.npmrc is unreadable in the sandbox (registry tokens); point npm at an empty one.
    npm_config_userconfig: cache("npmrc"),
    npm_config_ignore_scripts: "true",
    npm_config_store_dir: cache("pnpm-store"),
    YARN_CACHE_FOLDER: cache("yarn"),
    YARN_ENABLE_SCRIPTS: "false",
    PIP_CACHE_DIR: cache("pip"),
    UV_CACHE_DIR: cache("uv"),
    GOCACHE: cache("go-build"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The Claude engine's whole environment: `claudeEnv({ overrides: workspaceEnv(ws) })`. */
export function codeEngineEnv(ws: Workspace, source: Record<string, string | undefined> = process.env): Record<string, string> {
  return claudeEnv({ source, overrides: workspaceEnv(ws, source) });
}

export interface SandboxProbeDeps {
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Default `existsSync`. */
  exists?: (path: string) => boolean;
  /** Where to look for bwrap and socat on Linux. Default `process.env.PATH`. */
  path?: string;
}

/**
 * Whether Claude Code's sandbox can run here: Seatbelt (`/usr/bin/sandbox-exec`) on macOS,
 * bubblewrap plus socat (its network proxy) on Linux. Only looks for the files; it never runs
 * them, so it can be called from settings pages and tests. The engine's `failIfUnavailable` is the
 * real check at start.
 */
export function createSandboxProbe(deps: SandboxProbeDeps = {}): SandboxProbe {
  return async (): Promise<CodeSandboxStatus> => {
    const platform = deps.platform ?? process.platform;
    const exists = deps.exists ?? existsSync;
    if (platform === "darwin") {
      return exists("/usr/bin/sandbox-exec")
        ? { available: true, mechanism: "seatbelt" }
        : { available: false, mechanism: null, reason: "sandbox-exec was not found at /usr/bin/sandbox-exec" };
    }
    if (platform === "linux") {
      const dirs = (deps.path ?? process.env.PATH ?? "").split(":").filter(Boolean);
      const has = (bin: string) => dirs.some((d) => exists(join(d, bin)));
      if (!has("bwrap")) return { available: false, mechanism: null, reason: "bubblewrap (bwrap) is not installed" };
      if (!has("socat")) return { available: false, mechanism: null, reason: "socat is not installed (the sandbox's network proxy needs it)" };
      return { available: true, mechanism: "bubblewrap" };
    }
    if (platform === "win32") return { available: false, mechanism: null, reason: "native Windows is not supported; run Rye in WSL" };
    return { available: false, mechanism: null, reason: `${platform} is not supported` };
  };
}

/** The probe for this machine. */
export const probeSandbox: SandboxProbe = createSandboxProbe();
