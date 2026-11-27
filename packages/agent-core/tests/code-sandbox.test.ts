/**
 * The code-session sandbox plan (code/sandbox.ts) and the git shim (code/shim/git.ts).
 *
 * No sandbox is ever started here (`sandbox-exec`, `bwrap`), nor Claude Code. The shim is run
 * with /bin/sh against a fake "real git" in a temp dir that only prints its arguments.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicy } from "../src/code/policy.js";
import {
  buildSandboxPlan,
  claudeSandboxSettings,
  codeEngineEnv,
  createSandboxProbe,
  GIT_SHIM_SCRIPT,
  installGitShim,
  withApprovedHosts,
  workspaceEnv,
} from "../src/code/sandbox.js";
import type { CodeRepoConfig, PolicyScope, Workspace } from "../src/code/types.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "rye-code-sandbox-")));
const HOME = join(ROOT, "home");
const DATA = join(HOME, ".local", "share", "rye");
const CONFIG = join(HOME, ".config", "rye");
const SESSION = join(DATA, "code", "s1");
const USER = join(HOME, "Code", "app");
for (const d of [join(SESSION, "repo"), join(SESSION, "tmp"), join(SESSION, "cache", "bin"), join(USER, ".git", "objects")]) mkdirSync(d, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    sessionId: "s1",
    repoName: "app",
    sessionDir: SESSION,
    repoDir: join(SESSION, "repo"),
    tmpDir: join(SESSION, "tmp"),
    cacheDir: join(SESSION, "cache"),
    binDir: join(SESSION, "cache", "bin"),
    eventsFile: join(SESSION, "events.jsonl"),
    sessionFile: join(SESSION, "session.json"),
    userRepoPath: USER,
    userGitDir: join(USER, ".git"),
    userObjectsDir: join(USER, ".git", "objects"),
    isolation: "clone",
    baseRef: "main",
    baseSha: "0".repeat(40),
    includeUncommitted: false,
    slug: "fix",
    branch: "rye/fix",
    refPrefix: "refs/rye/s1/",
    baseRefPin: "refs/rye/s1/base",
    ...over,
  };
}

const SCOPE: PolicyScope = { home: HOME, dataDir: DATA, configDir: CONFIG, toolchainDirs: [] };
const REPO: CodeRepoConfig = { name: "app", path: USER, isolation: "clone", setup: [], checks: [] };
const policyFor = (ws: Workspace, domains: string[] = [], repo: CodeRepoConfig = REPO) =>
  compilePolicy({ allowed_domains: domains, allow: [], ask: [], deny: [] }, repo, ws, SCOPE);

describe("the sandbox plan", () => {
  const ws = workspace();
  const plan = buildSandboxPlan(ws, policyFor(ws), REPO, SCOPE);

  test("writes only in repo/, tmp/ and cache/; the cwd is the clone; no way out of the sandbox", () => {
    expect(plan.failIfUnavailable).toBe(true);
    expect(plan.allowUnsandboxedCommands).toBe(false);
    expect(plan.cwd).toBe(ws.repoDir);
    expect(plan.filesystem.allowWrite).toEqual([ws.repoDir, ws.tmpDir, ws.cacheDir]);
    expect(plan.filesystem.denyWrite).toEqual([ws.binDir, join(ws.repoDir, ".git", "hooks")]);
  });

  test("secrets, Rye's dirs and the user's checkout are unreadable; this session and the borrowed objects are", () => {
    for (const p of [".ssh", ".aws", ".gnupg", ".netrc", ".npmrc", ".docker", ".config/gh", ".claude", "Library/Keychains"]) {
      expect(plan.filesystem.denyRead).toContain(join(HOME, p));
    }
    expect(plan.filesystem.denyRead).toContain(CONFIG);
    expect(plan.filesystem.denyRead).toContain(DATA);
    expect(plan.filesystem.denyRead).toContain(USER);
    expect(plan.filesystem.allowRead).toEqual([SESSION, ws.userObjectsDir]);
  });

  test("network is off unless a domain is allowed, and localhost is unreachable (binding off)", () => {
    // With binding on, a real run reached Rye's own API on 127.0.0.1 from inside the sandbox.
    expect(plan.network).toEqual({ allowedDomains: [], allowLocalBinding: false });
    const withDomains = buildSandboxPlan(ws, policyFor(ws, ["registry.npmjs.org"]).allowForSession("bun add *", ["example.com"]), REPO, SCOPE);
    expect(withDomains.network.allowedDomains).toEqual(["registry.npmjs.org", "example.com"]);
  });

  test("an approval's hosts are added for one command without changing the plan", () => {
    const once = withApprovedHosts(plan, ["Registry.npmjs.org"]);
    expect(once.network.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(plan.network.allowedDomains).toEqual([]);
  });

  test("a repo's allow_write is added, with ~ expanded and relative paths under the clone", () => {
    const repo = { ...REPO, allow_write: ["~/.cache/turbo", "build-out"] };
    const p = buildSandboxPlan(ws, policyFor(ws, [], repo), repo, SCOPE);
    expect(p.filesystem.allowWrite).toEqual([ws.repoDir, ws.tmpDir, ws.cacheDir, join(HOME, ".cache", "turbo"), join(ws.repoDir, "build-out")]);
  });

  test("worktree mode reads the shared .git and never writes it", () => {
    const wt = workspace({ isolation: "worktree" });
    const p = buildSandboxPlan(wt, policyFor(wt), { ...REPO, isolation: "worktree" }, SCOPE);
    expect(p.filesystem.denyWrite).toContain(wt.userGitDir);
    expect(p.filesystem.allowRead).toContain(wt.userGitDir);
  });

  test("paths are canonical, as the sandbox compares resolved paths", () => {
    const raw = mkdtempSync(join(tmpdir(), "rye-code-sandbox-raw-"));
    try {
      const s = join(raw, "s");
      for (const d of ["repo", "tmp", "cache/bin"]) mkdirSync(join(s, d), { recursive: true });
      const w = workspace({ sessionDir: s, repoDir: join(s, "repo"), tmpDir: join(s, "tmp"), cacheDir: join(s, "cache"), binDir: join(s, "cache", "bin") });
      const p = buildSandboxPlan(w, policyFor(w), REPO, SCOPE);
      expect(p.cwd).toBe(realpathSync(join(s, "repo")));
      expect(p.filesystem.allowWrite[0]).toBe(realpathSync(join(s, "repo")));
    } finally {
      rmSync(raw, { recursive: true, force: true });
    }
  });
});

describe("the Claude Agent SDK sandbox option", () => {
  const ws = workspace();
  const plan = buildSandboxPlan(ws, policyFor(ws, ["registry.npmjs.org"]), REPO, SCOPE);
  const settings: SandboxSettings = claudeSandboxSettings(plan);

  test("is enabled, fails closed, and leaves every command to Rye's hook", () => {
    expect(settings.enabled).toBe(true);
    expect(settings.failIfUnavailable).toBe(true);
    expect(settings.allowUnsandboxedCommands).toBe(false);
    expect(settings.autoAllowBashIfSandboxed).toBe(false);
  });

  test("maps the network and filesystem lists, with a strict allowlist and no Mach lookups", () => {
    expect(settings.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: false, strictAllowlist: true });
    expect(settings.network?.allowMachLookup).toBeUndefined();
    expect(settings.network?.allowAllUnixSockets).toBeUndefined();
    expect(settings.filesystem).toEqual({
      allowWrite: plan.filesystem.allowWrite,
      denyWrite: plan.filesystem.denyWrite,
      allowRead: plan.filesystem.allowRead,
      denyRead: plan.filesystem.denyRead,
    });
    expect(settings.filesystem?.disabled).toBeUndefined();
    expect(settings.enableWeakerNestedSandbox).toBeUndefined();
  });

  test("copies the lists, so changing the settings can't change the plan", () => {
    settings.filesystem!.allowWrite!.push("/");
    expect(plan.filesystem.allowWrite).not.toContain("/");
  });
});

/** What Rye's process might hold after loading its .env. */
const SECRETS: Record<string, string> = {
  RYE_DATA_DIR: "/tmp/rye-data",
  RYE_CONFIG_DIR: "/tmp/rye-config",
  MYSQL_PASSWORD: "db-secret",
  PGPASSWORD: "pg-secret",
  JIRA_API_TOKEN: "jira-secret",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AWS_PROFILE: "prod",
  GITHUB_TOKEN: "ghp_secret",
  GH_TOKEN: "gh-secret",
  COPILOT_GITHUB_TOKEN: "copilot-secret",
  NPM_TOKEN: "npm-secret",
  NODE_OPTIONS: "--require /tmp/evil.js",
  GIT_SSH_COMMAND: "ssh -i /tmp/key",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
};
const SOURCE: Record<string, string> = {
  ...SECRETS,
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/Users/someone",
  TMPDIR: "/var/folders/xx/T/",
  LANG: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant-key",
};

describe("the engine's environment", () => {
  const ws = workspace();

  test("the workspace's own variables: temp and caches inside it, the shim first on PATH", () => {
    const env = workspaceEnv(ws, SOURCE);
    expect(env.PATH.split(":")).toEqual([ws.binDir, "/usr/local/bin", "/usr/bin", "/bin"]);
    expect(env.TMPDIR).toBe(ws.tmpDir);
    expect(env.XDG_CACHE_HOME).toBe(ws.cacheDir);
    expect(env.BUN_INSTALL_CACHE_DIR).toBe(join(ws.cacheDir, "bun"));
    expect(env.npm_config_cache).toBe(join(ws.cacheDir, "npm"));
    for (const [k, v] of Object.entries(env)) if (k !== "PATH" && v.startsWith("/")) expect({ k, inside: v.startsWith(ws.sessionDir) }).toEqual({ k, inside: true });
    expect(env.npm_config_ignore_scripts).toBe("true");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("the shim dir appears once, even when PATH already has it", () => {
    const env = workspaceEnv(ws, { PATH: `/usr/bin:${ws.binDir}:/bin` });
    expect(env.PATH).toBe(`${ws.binDir}:/usr/bin:/bin`);
    expect(workspaceEnv(ws, {}).PATH.startsWith(`${ws.binDir}:`)).toBe(true);
  });

  test("the whole env is claudeEnv's allowlist plus the workspace: no secrets", () => {
    const env = codeEngineEnv(ws, SOURCE);
    for (const k of Object.keys(SECRETS)) expect({ k, present: k in env }).toEqual({ k, present: false });
    expect(Object.values(env).some((v) => Object.values(SECRETS).includes(v))).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(env.HOME).toBe("/Users/someone");
    expect(env.PATH.split(":")[0]).toBe(ws.binDir);
    expect(env.TMPDIR).toBe(ws.tmpDir);
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^rye\//);
  });
});

describe("the sandbox probe (never runs the sandbox)", () => {
  const seen: string[] = [];
  const exists = (have: string[]) => (p: string) => {
    seen.push(p);
    return have.includes(p);
  };

  test("macOS needs sandbox-exec", async () => {
    expect(await createSandboxProbe({ platform: "darwin", exists: exists(["/usr/bin/sandbox-exec"]) })()).toEqual({ available: true, mechanism: "seatbelt" });
    expect(await createSandboxProbe({ platform: "darwin", exists: exists([]) })()).toMatchObject({ available: false, mechanism: null, reason: expect.stringContaining("sandbox-exec") });
  });

  test("Linux needs bubblewrap and socat on PATH", async () => {
    const path = "/usr/local/bin:/usr/bin";
    expect(await createSandboxProbe({ platform: "linux", path, exists: exists(["/usr/bin/bwrap", "/usr/bin/socat"]) })()).toEqual({ available: true, mechanism: "bubblewrap" });
    expect(await createSandboxProbe({ platform: "linux", path, exists: exists(["/usr/bin/socat"]) })()).toMatchObject({ available: false, reason: expect.stringContaining("bubblewrap") });
    expect(await createSandboxProbe({ platform: "linux", path, exists: exists(["/usr/local/bin/bwrap"]) })()).toMatchObject({ available: false, reason: expect.stringContaining("socat") });
  });

  test("Windows and others are not supported", async () => {
    expect(await createSandboxProbe({ platform: "win32", exists: exists([]) })()).toMatchObject({ available: false, mechanism: null, reason: expect.stringContaining("Windows") });
    expect(await createSandboxProbe({ platform: "freebsd", exists: exists([]) })()).toMatchObject({ available: false, mechanism: null });
  });

  test("it only looks at files", () => {
    expect(seen.every((p) => p.startsWith("/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The git shim
// ---------------------------------------------------------------------------

describe("the git shim", () => {
  const dir = join(ROOT, "shim-test");
  const bin = join(dir, "cache", "bin");
  const fake = join(dir, "fake-git");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "git"), `#!/bin/sh\nprintf 'REAL'\nfor a in "$@"; do printf ' [%s]' "$a"; done\nprintf '\\n'\n`, { mode: 0o755 });
  const shim = installGitShim(bin);

  /** Run the shim as the sandbox would find it: first on PATH, the "real" git after it. */
  function run(args: string[], path = `${bin}:${fake}:/usr/bin:/bin`) {
    const r = Bun.spawnSync(["/bin/sh", shim, ...args], { env: { PATH: path, HOME: dir }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test("is installed as an executable POSIX sh script", () => {
    expect(shim).toBe(join(bin, "git"));
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    expect(readFileSync(shim, "utf8")).toBe(GIT_SHIM_SCRIPT);
    expect(GIT_SHIM_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(GIT_SHIM_SCRIPT).toContain("NOT a security boundary");
    expect(GIT_SHIM_SCRIPT).not.toContain("@{");
    expect(Bun.spawnSync(["/bin/sh", "-n", shim]).exitCode).toBe(0);
    // Installing again overwrites (and keeps the mode).
    writeFileSync(shim, "stale", { mode: 0o600 });
    installGitShim(bin);
    expect(readFileSync(shim, "utf8")).toBe(GIT_SHIM_SCRIPT);
    expect(statSync(shim).mode & 0o777).toBe(0o755);
  });

  test("passes everything else to the real git, skipping its own directory, arguments intact", () => {
    expect(run(["status"])).toEqual({ code: 0, out: "REAL [status]\n", err: "" });
    expect(run(["commit", "-m", "two words", "--", "a b.txt"]).out).toBe("REAL [commit] [-m] [two words] [--] [a b.txt]\n");
    expect(run(["-c", "core.pager=cat", "log", "--oneline"]).out).toBe("REAL [-c] [core.pager=cat] [log] [--oneline]\n");
    expect(run(["config", "user.name", "Rye Agent"]).out).toBe("REAL [config] [user.name] [Rye Agent]\n");
    // Its own directory listed twice, or after the real git, is still skipped.
    expect(run(["status"], `${bin}:${bin}:${fake}:/usr/bin:/bin`).out).toBe("REAL [status]\n");
  });

  /** Git argv lists the shim refuses: each must also be denied by the policy. */
  const REFUSED: string[][] = [
    ["push"],
    ["push", "--force", "origin", "main"],
    ["PUSH"],
    ["--no-pager", "push"],
    ["-C", ".", "push"],
    ["-c", "user.name=x", "push"],
    ["-c", "alias.p=push", "p"],
    ["-c", "ALIAS.P=push origin", "p"],
    ["send-pack", "x"],
    ["send-email", "a.patch"],
    ["filter-branch", "--tree-filter", "x"],
    ["filter-repo"],
    ["clone", "https://x/y"],
    ["prune"],
    ["credential", "fill"],
    ["credential-osxkeychain", "get"],
    ["for-each-repo", "--config=x", "gc"],
    ["remote", "add", "origin", "https://x"],
    ["remote", "set-url", "origin", "https://x"],
    ["remote", "-v", "add", "up", "https://x"],
    ["gc", "--prune=now"],
    ["reflog", "expire", "--all"],
    ["reflog", "delete", "HEAD@{1}"],
    ["update-ref", "-d", "refs/rye/s1/base"],
    ["update-ref", "refs/rye/s1/turn-1", "HEAD"],
    ["maintenance", "start"],
    ["svn", "dcommit"],
    ["p4", "submit"],
    ["lfs", "push", "origin"],
    ["config", "core.hooksPath", "x"],
    ["config", "Core.HooksPath", "x"],
    ["config", "--local", "core.fsmonitor", "x"],
    ["config", "alias.p", "push"],
    ["config", "set", "alias.p", "push"],
    ["config", "--add", "credential.helper", "store"],
    ["config", "remote.origin.url", "https://x"],
    ["config", "pager.log", "less"],
    ["config", "diff.pdf.textconv", "x"],
    ["config", "--global", "user.name", "x"],
    ["config", "-e"],
    ["config", "edit"],
    ["config", "--rename-section", "foo", "alias"],
  ];

  /** Git argv lists the shim passes through (some of which the policy still denies or asks about). */
  const PASSED: string[][] = [
    ["status"],
    ["log", "--oneline"],
    ["commit", "-m", "push the button"],
    ["branch", "-D", "old"],
    ["reset", "--hard", "HEAD~1"],
    ["stash", "clear"],
    ["clean", "-fdx"],
    ["gc"],
    ["gc", "--no-prune"],
    ["reflog"],
    ["update-ref", "-d", "refs/heads/old"],
    ["config", "user.name", "x"],
    ["config", "core.pager"],
    ["config", "--get", "core.hooksPath"],
    ["config", "get", "alias.p"],
    ["config", "--unset", "core.pager"],
    ["-c", "alias.st=status", "st"],
    ["-c", "core.hooksPath=/dev/null", "status"],
    ["remote", "-v"],
    ["remote", "remove", "origin"],
    ["fetch"],
    ["maintenance", "run"],
  ];

  const quote = (s: string) => (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const p = policyFor(workspace());

  test.each(REFUSED.map((a) => [a.join(" "), a] as [string, string[]]))("refuses git %s, as the policy does", (_, args) => {
    const r = run(args);
    expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: "" });
    expect(r.err).toMatch(/^rye: /);
    expect(p.commandVerdict(`git ${args.map(quote).join(" ")}`).verdict).toBe("deny");
  });

  test.each(PASSED.map((a) => [a.join(" "), a] as [string, string[]]))("passes git %s through", (_, args) => {
    const r = run(args);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`REAL ${args.map((a) => `[${a}]`).join(" ")}\n`);
  });

  test("the refusal says why", () => {
    expect(run(["push"]).err).toContain("git push is never allowed in a code session");
    expect(run(["config", "core.hooksPath", "x"]).err).toContain("can make git run commands");
  });
});
