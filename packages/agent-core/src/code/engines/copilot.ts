/**
 * The `acp:copilot` code engine: the GitHub Copilot CLI over the Agent Client Protocol, with its
 * whole process inside Rye's OS sandbox (engines/acp.ts, code/process-sandbox.ts;
 * docs/design/code-sessions.md §2.2 item 3, §8 "Phase 1.5").
 *
 * What the docs say (checked 2026-11-25; the CLI was not installed or run here):
 * - ACP mode: `copilot --acp --stdio`; stdout then carries only the protocol. Startup flags apply
 *   to every session. Public preview. https://docs.github.com/en/copilot/reference/acp-server
 * - Tool rules: `--deny-tool=TOOL`, patterns `shell(git push)`; "Deny rules always take precedence
 *   over allow rules, even when `--allow-all` is set". `--disable-builtin-mcps` turns off the
 *   built-in MCP servers (the GitHub one acts on GitHub with the user's login).
 *   `--no-auto-update`, `--model=MODEL`. https://docs.github.com/en/copilot/reference/cli-command-reference
 *   (Unverified: that every one of these general flags is honoured under `--acp`.)
 * - Permissions: Copilot sends `session/request_permission` per tool call in ACP mode since early
 *   2026 (it used to auto-approve: https://github.com/github/copilot-cli/issues/845, closed).
 *   Rye answers each one through its policy, but the sandbox is the boundary either way.
 * - Files and shell: Copilot runs its own `bash`/`view`/`create`/`edit` tools (unverified that it
 *   never uses the client's `fs/*`), so Rye doesn't advertise `fs` or `terminal`: its own process
 *   is what the sandbox confines.
 * - Auth: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` in that order, else the stored OAuth
 *   login: the OS keychain (service `copilot-cli`), or `~/.copilot/config.json` in plain text
 *   where there is none. `COPILOT_HOME` moves `~/.copilot`.
 *   https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli ,
 *   https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
 *   Rye passes only `COPILOT_GITHUB_TOKEN` (harness/env.ts `copilotEnv`).
 * - Hosts: https://docs.github.com/en/copilot/reference/copilot-allowlist-reference (auth on
 *   github.com and api.github.com, the model API on `*.githubcopilot.com`, plus
 *   copilot-proxy/origin-tracker.githubusercontent.com). Telemetry and experiment hosts stay blocked.
 * - Org policy: an enterprise or org admin can turn the Copilot CLI off ("Copilot Clients" →
 *   Copilot CLI); that can't be seen from files, so it shows as an error on the first turn.
 *   https://docs.github.com/en/copilot/how-tos/copilot-cli/administer-copilot-cli-for-your-enterprise
 * - Install: `npm install -g @github/copilot` (Node 22+), `brew install copilot-cli`, or the
 *   install script. https://github.com/github/copilot-cli
 *
 * Availability looks at files and the environment only: the CLI is never run to check (whether
 * `copilot --version` is free of side effects is undocumented; it may check for updates).
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { copilotEnv } from "../../harness/env.js";
import type { CodeEngine, CodeEngineAvailability } from "../types.js";
import { acpCodeEngine, type AcpAgentFiles, type AcpAgentProfile, type AcpEngineDeps } from "./acp.js";

export const COPILOT_ENGINE_ID = "acp:copilot" as const;

/** Install and sign-in steps, for messages. */
export const COPILOT_INSTALL_HINT = "Install it with `npm install -g @github/copilot` (or `brew install copilot-cli`), then run `copilot` and sign in with /login.";
export const COPILOT_SIGNIN_HINT =
  "Run `copilot` and sign in with /login (needs a Copilot seat, and your org must allow the Copilot CLI), or set COPILOT_GITHUB_TOKEN to a fine-grained token with the Copilot Requests permission.";

/** The oldest CLI that asks before tool calls in ACP mode (it auto-approved before 1.0; issue #845). */
export const COPILOT_MIN_VERSION = "1.0.0";

/**
 * Models the docs list for `--model` (cli-command-reference, 2026-11-25; read through a summary,
 * so unverified). `auto` lets Copilot choose. The CLI's own default applies when none is picked.
 */
export const COPILOT_MODELS = [
  "auto",
  "claude-sonnet-5.5",
  "claude-opus-5.5",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-6.2-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6.2-astra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-4-hydrogen",
];

/**
 * Copilot's own deny rules, a second layer behind Rye's policy and the sandbox (no remote, no
 * credentials, no network to registries): publishing and pushing are refused by Copilot itself.
 */
export const COPILOT_DENY_TOOLS = [
  "shell(git push)",
  "shell(git remote)",
  "shell(npm publish)",
  "shell(pnpm publish)",
  "shell(yarn publish)",
  "shell(bun publish)",
  "shell(cargo publish)",
  "shell(twine upload)",
  "shell(gh)",
  "shell(sudo)",
];

/** Hosts Copilot needs: sign-in and its token exchange, and the model API. */
export function copilotHosts(source: Record<string, string | undefined>): string[] {
  const hosts = [
    "github.com",
    "api.github.com",
    "*.githubcopilot.com",
    "copilot-proxy.githubusercontent.com",
    "origin-tracker.githubusercontent.com",
  ];
  const custom = (source.COPILOT_GH_HOST || source.GH_HOST || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  // GitHub Enterprise Server / data residency (`<sub>.ghe.com`): the host, its API and its subdomains.
  if (custom && custom !== "github.com" && /^[a-z0-9.-]+$/.test(custom)) hosts.push(custom, `api.${custom}`, `*.${custom}`);
  return [...new Set(hosts)];
}

/** `COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(source: Record<string, string | undefined>, home: string): string {
  const configured = source.COPILOT_HOME?.trim();
  return configured && isAbsolute(configured) ? configured : join(home, ".copilot");
}

/** Copilot's files in the sandbox: its home readable (login, settings), only its session history and logs writable. */
export function copilotFiles(source: Record<string, string | undefined>, home: string): AcpAgentFiles {
  const dir = copilotHome(source, home);
  return {
    readOnly: [dir],
    write: [join(dir, "session-state"), join(dir, "logs")],
    // Settings, the stored login and MCP definitions outlive the session: the agent never changes them.
    denyWrite: [join(dir, "config.json"), join(dir, "settings.json"), join(dir, "mcp-config.json"), join(dir, "mcp-oauth-config")],
  };
}

/** The CLI's arguments (after its path). */
export function copilotArgs(o: { model?: string }): string[] {
  return [
    "--acp",
    "--stdio",
    "--no-auto-update",
    // The GitHub MCP server would act on GitHub with the user's login.
    "--disable-builtin-mcps",
    // Rye's sandbox holds the whole process; Copilot's own sandbox can't nest inside it (Seatbelt
    // profiles don't nest). An enterprise policy that enforces Copilot's sandbox overrides this.
    "--no-sandbox",
    ...COPILOT_DENY_TOOLS.map((t) => `--deny-tool=${t}`),
    ...(o.model ? [`--model=${o.model}`] : []),
  ];
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Where Copilot's installers put it, for a Rye started without them on PATH. */
function fallbackDirs(home: string): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".npm-global", "bin")];
}

/** The CLI's path: `copilot_path`, else `copilot` on PATH or where the installers put it. */
export function locateCopilot(env: Record<string, string | undefined>, configured: string | undefined, home: string): { path: string } | { missing: string } {
  const want = configured?.trim();
  if (want) {
    const p = want === "~" || want.startsWith("~/") ? join(home, want.slice(1)) : want;
    if (!isAbsolute(p)) return { missing: `copilot_path under [code] must be an absolute path (${want}).` };
    return isFile(p) ? { path: p } : { missing: `Copilot CLI not found at ${p} (copilot_path under [code]).` };
  }
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...fallbackDirs(home)];
  for (const dir of dirs) {
    const p = join(dir, "copilot");
    if (isFile(p)) return { path: p };
  }
  return { missing: `Copilot CLI isn't installed. ${COPILOT_INSTALL_HINT}` };
}

/** The installed CLI's version from the npm package next to the binary, without running it. */
export function copilotVersion(binary: string): string | undefined {
  try {
    let dir = dirname(realpathSync(binary));
    for (let i = 0; i < 5; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === "@github/copilot" && typeof parsed.version === "string") return parsed.version;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // Unknown.
  }
  return undefined;
}

function older(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Who Copilot would sign in as, from the environment and its config file only. The stored login
 * is in the keychain (or `config.json` in plain text); `config.json` also records who signed in.
 * Its field names (`last_logged_in_user`, `logged_in_users`) are unverified.
 */
export function copilotAuthSource(source: Record<string, string | undefined>, home: string): string | undefined {
  if (source.COPILOT_GITHUB_TOKEN?.trim()) return "COPILOT_GITHUB_TOKEN";
  const file = join(copilotHome(source, home), "config.json");
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const user = (parsed.last_logged_in_user ?? (Array.isArray(parsed.logged_in_users) ? parsed.logged_in_users[0] : undefined)) as { login?: unknown } | undefined;
    if (user && typeof user === "object") return typeof user.login === "string" && user.login ? user.login : "GitHub account";
  } catch {
    // Not plain JSON: fall back to looking for the keys.
  }
  return /"(last_logged_in_user|logged_in_users)"/.test(text) ? "GitHub account" : undefined;
}

export interface CopilotEngineDeps extends AcpEngineDeps {
  /** `[code] copilot_path`. Read on every check, so a config change applies without a restart. */
  configuredPath?: () => string | undefined;
}

/** The Copilot agent profile. */
export function copilotProfile(deps: Pick<CopilotEngineDeps, "configuredPath" | "home"> = {}): AcpAgentProfile {
  const home = () => deps.home ?? homedir();
  return {
    id: COPILOT_ENGINE_ID,
    title: "GitHub Copilot",
    shortName: "Copilot",
    clientFs: false,
    locate: (env) => locateCopilot(env, deps.configuredPath?.(), home()),
    args: copilotArgs,
    env: ({ source, workspaceVars, cacheDir }) => copilotEnv({ source, overrides: { ...workspaceVars, COPILOT_CACHE_HOME: join(cacheDir, "copilot") } }),
    files: ({ home: h, source }) => copilotFiles(source, h),
    hosts: ({ source }) => copilotHosts(source),
    models: async () => [...COPILOT_MODELS],
    async availability({ source, home: h }): Promise<CodeEngineAvailability> {
      const located = locateCopilot(source, deps.configuredPath?.(), h);
      if ("missing" in located) return { available: false, reason: located.missing };
      const version = copilotVersion(located.path);
      if (version && older(version, COPILOT_MIN_VERSION)) {
        return { available: false, reason: `Copilot CLI ${version} is too old: before ${COPILOT_MIN_VERSION} its ACP mode approved tool calls without asking. Update it with \`npm install -g @github/copilot\`.` };
      }
      const account = copilotAuthSource(source, h);
      if (!account) {
        const other = source.GH_TOKEN ? "GH_TOKEN" : source.GITHUB_TOKEN ? "GITHUB_TOKEN" : undefined;
        const note = other ? ` (${other} is set, but Rye passes only COPILOT_GITHUB_TOKEN to Copilot, since ${other} is a general GitHub token.)` : "";
        return { available: false, reason: `Copilot CLI isn't signed in. ${COPILOT_SIGNIN_HINT}${note}` };
      }
      return { available: true, account: version ? `${account} · Copilot CLI ${version}` : account };
    },
    errorHint(text) {
      if (/polic(y|ies)|not (been )?enabled|disabled by|not authori[sz]ed|access denied|403/i.test(text)) {
        return "Your organization or enterprise may have turned off the Copilot CLI (Copilot policies → Copilot CLI), or your account has no Copilot seat.";
      }
      if (/log ?in|sign(ed)? ?in|unauthori[sz]ed|401|token/i.test(text)) return `Sign in again: ${COPILOT_SIGNIN_HINT}`;
      return undefined;
    },
  };
}

/** The `acp:copilot` engine. */
export function copilotCodeEngine(deps: CopilotEngineDeps = {}): CodeEngine & { close(): Promise<void> } {
  return acpCodeEngine(copilotProfile(deps), deps);
}
