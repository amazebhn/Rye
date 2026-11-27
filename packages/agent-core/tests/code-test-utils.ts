/**
 * Shared set-up for code-session tests: a temporary user repo (real git, no network, no global
 * config) and a `CodeRunner` on temporary stores with a scripted engine. Never a real agent.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/chat/store.js";
import { CodeEngineRegistry } from "../src/code/engine.js";
import { scriptedCodeEngine, type FakeScript } from "../src/code/engines/fake.js";
import { CodeRunner, userGitIdentity } from "../src/code/runner.js";
import { CodeStore } from "../src/code/store.js";
import { CODE_CONFIG_DEFAULTS, type CodeConfig } from "../src/code/types.js";
import { createWorkspaceManager } from "../src/code/workspace.js";

const dirs: string[] = [];
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
export function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export const HOME = tmp("rye-code-home-");
const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Setup", "-c", "user.email=setup@example.com", ...args], { cwd, env: GIT_ENV, stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A user repo on `main` with one commit and the user's identity in its config. */
export function makeRepo(): string {
  const repo = tmp("rye-code-repo-");
  git(repo, ["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["config", "user.name", "Ada User"]);
  git(repo, ["config", "user.email", "ada@example.com"]);
  return repo;
}

export async function waitFor(cond: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

export interface CodeHarness {
  runner: CodeRunner;
  store: CodeStore;
  chats: ChatStore;
  repo: string;
  root: string;
  config: CodeConfig;
  engine: ReturnType<typeof scriptedCodeEngine>;
}

export function codeHarness(script: FakeScript, configPatch: Partial<CodeConfig> = {}): CodeHarness {
  const base = tmp("rye-code-data-");
  const repo = makeRepo();
  const root = join(base, "code");
  const store = new CodeStore(join(base, "code.db"));
  const chats = new ChatStore(join(base, "chats.db"), null, null);
  const engine = scriptedCodeEngine(script);
  const config: CodeConfig = {
    ...CODE_CONFIG_DEFAULTS,
    policy: { allowed_domains: [], allow: [], ask: [], deny: [] },
    repos: [{ name: "demo", path: repo, base: "main", isolation: "clone", setup: [], checks: [] }],
    ...configPatch,
  };
  const workspaces = createWorkspaceManager();
  const runner = new CodeRunner({
    store,
    chats,
    engines: new CodeEngineRegistry([engine]),
    config: () => config,
    root: () => root,
    scope: { home: HOME, dataDir: base, configDir: join(base, "config"), toolchainDirs: [] },
    sandboxProbe: async () => ({ available: true, mechanism: "seatbelt" }),
    workspaces,
    userIdentity: (ws) => userGitIdentity(workspaces.git, ws, HOME, join(HOME, ".config")),
    processEnv: { PATH: process.env.PATH, HOME },
    log: () => {},
  });
  return { runner, store, chats, repo, root, config, engine };
}
