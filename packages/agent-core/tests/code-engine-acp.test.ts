/**
 * The `acp:<cli>` code engine and its Copilot profile, against a fake ACP agent
 * (tests/fixtures/fake-acp-agent.ts) speaking JSON-RPC over stdio. The sandbox is a stub that
 * runs the fixture instead of wrapping anything: the real Copilot CLI, `sandbox-exec`, `bwrap`
 * and sandbox-runtime are never started here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodeEngineRegistry } from "../src/code/engine.js";
import {
  acpCodeEngine,
  acpCommand,
  acpPaths,
  acpToolView,
  judgeAcpToolCall,
  pickOption,
  type AcpAgentProfile,
  type AcpEngineDeps,
} from "../src/code/engines/acp.js";
import {
  COPILOT_DENY_TOOLS,
  copilotArgs,
  copilotAuthSource,
  copilotCodeEngine,
  copilotFiles,
  copilotHosts,
  copilotProfile,
  locateCopilot,
} from "../src/code/engines/copilot.js";
import { shellCommand, srtConfigFor, srtProcessSandbox, type ProcessSandbox, type ProcessSandboxRequest } from "../src/code/process-sandbox.js";
import { copilotEnv, copilotEnvAllows } from "../src/harness/env.js";
import type { ApprovalDecision, ApprovalRequest, CodeEvent, CodeRun, CodeRunOptions, CompiledPolicy, SandboxPlan, Verdict, Workspace } from "../src/code/types.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "fake-acp-agent.ts");
const roots: string[] = [];
const engines: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  await Promise.all(engines.map((e) => e.close()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

const HOME = "/home/me";

function workspace(id = "cs_acp"): Workspace {
  const root = tmp("rye-acp-ws-");
  const sessionDir = join(root, "sess");
  const dirs = { repoDir: join(sessionDir, "repo"), tmpDir: join(sessionDir, "tmp"), cacheDir: join(sessionDir, "cache") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dirs.repoDir, "notes.txt"), "one\ntwo\nthree\n");
  const userRepoPath = join(root, "user-repo");
  return {
    sessionDir,
    ...dirs,
    binDir: join(dirs.cacheDir, "bin"),
    eventsFile: join(sessionDir, "events.jsonl"),
    sessionFile: join(sessionDir, "session.json"),
    sessionId: id,
    repoName: "demo",
    userRepoPath,
    userGitDir: join(userRepoPath, ".git"),
    userObjectsDir: join(userRepoPath, ".git", "objects"),
    isolation: "clone",
    baseRef: "main",
    baseSha: "a".repeat(40),
    includeUncommitted: false,
    slug: "fix",
    branch: "rye/fix",
    refPrefix: `refs/rye/${id}/`,
    baseRefPin: `refs/rye/${id}/base`,
  };
}

function plan(ws: Workspace): SandboxPlan {
  return {
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    cwd: ws.repoDir,
    filesystem: { allowWrite: [ws.repoDir, ws.tmpDir, ws.cacheDir], denyWrite: [ws.binDir], allowRead: [ws.sessionDir], denyRead: [`${HOME}/.ssh`] },
    network: { allowedDomains: ["registry.example.org"], allowLocalBinding: false },
  };
}

interface PolicyLog {
  commands: string[];
  sessionPatterns: Array<{ pattern: string; hosts: readonly string[] }>;
}

/** A small stand-in for code/policy.ts. */
function stubPolicy(ws: Workspace, log: PolicyLog, session: string[] = []): CompiledPolicy {
  return {
    commandVerdict(cmd): Verdict {
      log.commands.push(cmd);
      if (/\bgit\s+push\b/.test(cmd)) return { verdict: "deny", reason: "git push is never allowed in a code session" };
      if (/^bun install\b/.test(cmd)) {
        if (session.includes("bun install *")) return { verdict: "allow", rule: "bun install *" };
        return { verdict: "ask", category: "install", reason: "installs packages", hosts: ["registry.npmjs.org"], pattern: "bun install *" };
      }
      if (/^curl\b/.test(cmd)) return { verdict: "ask", category: "network", reason: "reaches example.org", hosts: ["example.org"] };
      return { verdict: "allow" };
    },
    pathVerdict(path, op): Verdict {
      const abs = resolve(ws.repoDir, path);
      if (abs.startsWith(`${HOME}/.ssh`)) return { verdict: "deny", reason: "~/.ssh is never readable in a code session" };
      const inside = abs === ws.repoDir || abs.startsWith(`${ws.repoDir}/`);
      if (inside) return { verdict: "allow" };
      if (op === "write") return { verdict: "deny", reason: `${abs} is outside the workspace` };
      return { verdict: "ask", category: "path", reason: `reads ${abs}, outside the workspace` };
    },
    allowForSession(pattern, hosts = []) {
      log.sessionPatterns.push({ pattern, hosts });
      return stubPolicy(ws, log, [...session, pattern]);
    },
    rules: [],
    allowedDomains: [],
  };
}

/** A sandbox stub: records each request and runs the fixture (with the scenario in its env) instead. */
function stubSandbox(scenario: string, fixtureArgs?: unknown, available = true) {
  const requests: ProcessSandboxRequest[] = [];
  const domainUpdates: string[][] = [];
  let disposed = 0;
  const sandbox: ProcessSandbox = {
    async status() {
      return available ? { available: true, mechanism: "seatbelt" } : { available: false, mechanism: null, reason: "ripgrep (rg) is not installed" };
    },
    async wrap(req) {
      requests.push(req);
      return {
        argv: [process.execPath, FIXTURE],
        env: { ...req.env, FAKE_ACP_SCENARIO: scenario, ...(fixtureArgs === undefined ? {} : { FAKE_ACP_ARGS: JSON.stringify(fixtureArgs) }) },
        setAllowedDomains: (d) => domainUpdates.push(d),
        dispose: async () => {
          disposed++;
        },
      };
    },
  };
  return { sandbox, requests, domainUpdates, disposed: () => disposed };
}

function testProfile(over: Partial<AcpAgentProfile> = {}): AcpAgentProfile {
  return {
    id: "acp:fake",
    title: "Fake Agent",
    shortName: "Fake",
    clientFs: true,
    locate: () => ({ path: "/opt/fake/agent" }),
    args: (o) => ["--acp", ...(o.model ? [`--model=${o.model}`] : [])],
    env: ({ workspaceVars }) => ({ HOME, ...workspaceVars }),
    files: () => ({ readOnly: [`${HOME}/.fake`], write: [`${HOME}/.fake/sessions`], denyWrite: [`${HOME}/.fake/config.json`] }),
    hosts: () => ["api.fake.example"],
    availability: async () => ({ available: true, account: "tester" }),
    models: async () => ["fast", "smart"],
    ...over,
  };
}

interface Harness {
  options: CodeRunOptions;
  approvals: ApprovalRequest[];
  policyLog: PolicyLog;
  abort: AbortController;
}

function harness(ws: Workspace, over: Partial<CodeRunOptions> = {}, decide: ApprovalDecision[] = []): Harness {
  const approvals: ApprovalRequest[] = [];
  const policyLog: PolicyLog = { commands: [], sessionPatterns: [] };
  const abort = new AbortController();
  const options: CodeRunOptions = {
    workspace: ws,
    input: { text: "Fix the bug.", attachments: [] },
    systemPrompt: "Follow AGENTS.md.",
    policy: stubPolicy(ws, policyLog),
    sandbox: plan(ws),
    async approve(req) {
      approvals.push(req);
      return decide.shift() ?? { behavior: "deny", reason: "user", message: "no decision scripted" };
    },
    ryeTools: [],
    runRyeTool: async () => ({ content: [], isError: true }),
    // What the runner passes today: the Claude allowlist plus the workspace's own variables.
    env: { PATH: `${ws.binDir}:/usr/bin:/bin`, HOME, TMPDIR: ws.tmpDir, ANTHROPIC_API_KEY: "sk-ant-secret", npm_config_cache: join(ws.cacheDir, "npm") },
    limits: { maxTurns: 50, maxCostUsd: 5 },
    signal: abort.signal,
    ...over,
  };
  return { options, approvals, policyLog, abort };
}

async function collect(run: CodeRun, timeoutMs = 15_000): Promise<CodeEvent[]> {
  const events: CodeEvent[] = [];
  const timer = setTimeout(() => {
    throw new Error(`run did not finish; got ${JSON.stringify(events)}`);
  }, timeoutMs);
  for await (const ev of run) events.push(ev);
  clearTimeout(timer);
  return events;
}

const doneOf = (events: CodeEvent[]) => events.find((e) => e.type === "done") as Extract<CodeEvent, { type: "done" }>;
const textOf = (events: CodeEvent[]) =>
  events
    .filter((e): e is Extract<CodeEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");

function engine(sandbox: ProcessSandbox, deps: AcpEngineDeps = {}, profile = testProfile()) {
  const e = acpCodeEngine(profile, { sandbox, processEnv: { PATH: "/usr/bin:/bin", HOME }, home: HOME, keepAliveMs: 0, ...deps });
  engines.push(e);
  return e;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("events", () => {
  test("session/update maps to CodeEvents, ending with usage and done", async () => {
    const ws = workspace();
    const box = stubSandbox("basic");
    const events = await collect(engine(box.sandbox).start(harness(ws).options));
    const shape = events.map((e) => (e.type === "engine_session" ? { type: e.type, version: e.version } : e));
    expect(shape).toEqual([
      { type: "engine_session", version: "9.9.9" },
      { type: "text", delta: "Hello " },
      { type: "text", delta: "world" },
      { type: "tool_start", id: "t1", name: "Bash", args: { command: "ls -la", description: "Run ls" } },
      { type: "tool_output", id: "t1", chunk: "file1\n" },
      { type: "tool_result", id: "t1", content: "file1\nfile2\n", isError: false },
      { type: "tool_start", id: "t2", name: "Edit", args: { file_path: "/repo/a.ts", description: "Edit a.ts" } },
      { type: "tool_result", id: "t2", content: "no such file", isError: true },
      { type: "usage", inputTokens: 12, outputTokens: 5 },
      { type: "done", reason: "end" },
    ]);
    const session = events[0] as Extract<CodeEvent, { type: "engine_session" }>;
    expect(session.id).toMatch(/^s-\d+-/);
    // keepAliveMs 0: the CLI is closed after the turn, and its sandbox registration dropped.
    for (let i = 0; i < 200 && box.disposed() === 0; i++) await Bun.sleep(10);
    expect(box.disposed()).toBe(1);
  });

  test("the system prompt goes with the first prompt of a new session, as Rye's instructions", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("echo").sandbox).start(harness(ws).options));
    expect(textOf(events)).toStartWith("got: <rye_instructions>\nFollow AGENTS.md.\n</rye_instructions>\n\nFix the bug.");
  });

  test("an unknown client method (terminal/create) is refused: Rye never offers a terminal", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("terminal").sandbox).start(harness(ws).options));
    expect(textOf(events)).toBe("terminal => -32601");
  });

  test("the sandbox gets the plan, the agent's files and hosts, and the agent's own env (never Rye's)", async () => {
    const ws = workspace();
    const box = stubSandbox("echo");
    await collect(engine(box.sandbox).start(harness(ws, { model: "smart" }).options));
    const req = box.requests[0];
    expect(req.argv).toEqual(["/opt/fake/agent", "--acp", "--model=smart"]);
    expect(req.plan.cwd).toBe(ws.repoDir);
    expect(req.readOnly).toEqual([`${HOME}/.fake`]);
    expect(req.write).toEqual([`${HOME}/.fake/sessions`]);
    expect(req.denyWrite).toEqual([`${HOME}/.fake/config.json`]);
    expect(req.allowedDomains).toEqual(["api.fake.example", "registry.example.org"]);
    expect(req.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(req.env.npm_config_cache).toBe(join(ws.cacheDir, "npm"));
    expect(req.env.TMPDIR).toBe(ws.tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Policy and approvals
// ---------------------------------------------------------------------------

describe("permissions", () => {
  test("deny is rejected without asking, ask goes to approve, allow is allowed once", async () => {
    const ws = workspace();
    const h = harness(ws, {}, [{ behavior: "allow", scope: "once" }]);
    const events = await collect(engine(stubSandbox("perms", ["git push origin main", "bun install", "ls"]).sandbox).start(h.options));
    expect(textOf(events)).toBe("git push origin main => no-once\nbun install => yes-once\nls => yes-once");
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ kind: "command", category: "install", command: "bun install", hosts: ["registry.npmjs.org"], pattern: "bun install *", toolName: "Bash", toolUseId: "p1" });
    expect(h.policyLog.commands).toEqual(["git push origin main", "bun install", "ls"]);
    expect(doneOf(events)).toEqual({ type: "done", reason: "end" });
  });

  test("allow for the session reaches allowForSession with the hosts, opens them in the sandbox, and later calls aren't asked", async () => {
    const ws = workspace();
    const h = harness(ws, {}, [{ behavior: "allow", scope: "session", pattern: "bun install *" }]);
    const box = stubSandbox("perms", ["bun install", "bun install left-pad"]);
    const events = await collect(engine(box.sandbox).start(h.options));
    expect(textOf(events)).toBe("bun install => yes-once\nbun install left-pad => yes-once");
    expect(h.approvals).toHaveLength(1);
    expect(h.policyLog.sessionPatterns).toEqual([{ pattern: "bun install *", hosts: ["registry.npmjs.org"] }]);
    expect(box.domainUpdates.some((d) => d.includes("registry.npmjs.org"))).toBe(true);
  });

  test("a user's deny rejects; hosts approved once are dropped when their tool call ends", async () => {
    const ws = workspace();
    const h = harness(ws, {}, [{ behavior: "allow", scope: "once" }, { behavior: "deny", reason: "user", message: "no" }]);
    const box = stubSandbox("perms", ["curl https://example.org", "curl https://example.org/2"]);
    const events = await collect(engine(box.sandbox).start(h.options));
    expect(textOf(events)).toBe("curl https://example.org => yes-once\ncurl https://example.org/2 => no-once");
    expect(box.domainUpdates[0]).toContain("example.org");
    expect(box.domainUpdates[1]).not.toContain("example.org");
  });

  test("file edits are judged by pathVerdict; a call Rye can't inspect asks", async () => {
    const ws = workspace();
    const h = harness(ws, {}, [{ behavior: "deny", reason: "user", message: "no" }]);
    const calls = [
      { toolCallId: "e1", title: "Edit", kind: "edit", status: "pending", rawInput: { path: join(ws.repoDir, "a.ts") } },
      { toolCallId: "e2", title: "Edit", kind: "edit", status: "pending", locations: [{ path: "/etc/passwd" }] },
      { toolCallId: "o1", title: "Mystery", kind: "other", status: "pending", rawInput: { foo: 1 } },
    ];
    const events = await collect(engine(stubSandbox("calls", calls).sandbox).start(h.options));
    expect(textOf(events)).toBe("e1 => yes-once\ne2 => no-once\no1 => no-once");
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ kind: "command", category: "unparseable", command: 'tool {"foo":1}' });
  });
});

describe("judging ACP tool calls (pure)", () => {
  const ws = { repoDir: "/w/repo" } as Workspace;
  const ctx = { policy: stubPolicy(ws, { commands: [], sessionPatterns: [] }), repoDir: "/w/repo", home: HOME, agent: "Copilot" };

  test("commands come from a string or an argv", () => {
    expect(acpCommand({ rawInput: { command: "git status" } })).toBe("git status");
    expect(acpCommand({ rawInput: { command: ["git", "commit", "-m", "a b"] } })).toBe("git commit -m 'a b'");
    expect(judgeAcpToolCall({ toolCallId: "x", kind: "execute", rawInput: { command: ["git", "push"] } }, ctx)).toEqual({ verdict: "deny", reason: "git push is never allowed in a code session" });
  });

  test("paths come from locations, diffs and raw input", () => {
    expect(acpPaths({ locations: [{ path: "/a" }], content: [{ type: "diff", path: "/b", newText: "" }], rawInput: { file_path: "/c", paths: ["/d"] } })).toEqual(["/a", "/b", "/c", "/d"]);
    expect(judgeAcpToolCall({ toolCallId: "x", kind: "edit", locations: [{ path: "/w/repo/x" }, { path: "/tmp/y" }] }, ctx).verdict).toBe("deny");
    expect(judgeAcpToolCall({ toolCallId: "x", kind: "read", rawInput: { path: `${HOME}/.ssh/id_rsa` } }, ctx).verdict).toBe("deny");
    expect(judgeAcpToolCall({ toolCallId: "x", kind: "search" }, ctx)).toEqual({ verdict: "allow" });
  });

  test("fetch asks with its host; think is allowed; execute without a command asks", () => {
    const fetch = judgeAcpToolCall({ toolCallId: "x", kind: "fetch", rawInput: { url: "https://docs.example.com/a" } }, ctx);
    expect(fetch).toMatchObject({ verdict: "ask", draft: { category: "network", hosts: ["docs.example.com"] } });
    expect(judgeAcpToolCall({ toolCallId: "x", kind: "think" }, ctx)).toEqual({ verdict: "allow" });
    expect(judgeAcpToolCall({ toolCallId: "x", kind: "execute", rawInput: { input: "y\n" } }, ctx)).toMatchObject({ verdict: "ask", draft: { category: "unparseable" } });
  });

  test("options: once-only kinds first; tool views", () => {
    const opts = [
      { optionId: "a", name: "Always", kind: "allow_always" as const },
      { optionId: "b", name: "Once", kind: "allow_once" as const },
      { optionId: "c", name: "No forever", kind: "reject_always" as const },
    ];
    expect(pickOption(opts, true)?.optionId).toBe("b");
    expect(pickOption(opts, false)?.optionId).toBe("c");
    expect(pickOption([], false)).toBeUndefined();
    expect(acpToolView({ toolCallId: "x", kind: "read", title: "Read a", locations: [{ path: "/a" }] })).toEqual({ name: "Read", args: { file_path: "/a", description: "Read a" } });
  });
});

// ---------------------------------------------------------------------------
// Client fs
// ---------------------------------------------------------------------------

describe("fs/* (when the profile offers it)", () => {
  test("writes inside the workspace go through; outside are refused; reads honour line/limit and the policy", async () => {
    const ws = workspace();
    const outside = join(tmp("rye-acp-outside-"), "x.txt");
    const entries = [
      { write: join(ws.repoDir, "src", "new.ts"), content: "export {};\n" },
      { write: outside },
      { read: join(ws.repoDir, "notes.txt") },
      { read: `${HOME}/.ssh/id_rsa` },
    ];
    const events = await collect(engine(stubSandbox("fs", entries).sandbox).start(harness(ws).options));
    const lines = textOf(events).split("\n");
    expect(lines[0]).toBe(`write ${join(ws.repoDir, "src", "new.ts")} => ok`);
    expect(readFileSync(join(ws.repoDir, "src", "new.ts"), "utf8")).toBe("export {};\n");
    expect(lines[1]).toContain("is outside the workspace");
    expect(existsSync(outside)).toBe(false);
    expect(lines[2]).toBe(`read ${join(ws.repoDir, "notes.txt")} => "two"`);
    expect(lines[3]).toContain("never readable");
  });

  test("without clientFs, fs methods aren't served", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("fs", [{ write: join(ws.repoDir, "a.txt") }]).sandbox, {}, testProfile({ clientFs: false })).start(harness(ws).options));
    expect(textOf(events)).toContain("error Rye doesn't offer fs/write_text_file");
    expect(existsSync(join(ws.repoDir, "a.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

describe("run control", () => {
  test("interrupt sends session/cancel; the prompt ends cancelled → done interrupted", async () => {
    const ws = workspace();
    const run = engine(stubSandbox("hang").sandbox).start(harness(ws).options);
    const events: CodeEvent[] = [];
    for await (const ev of run) {
      events.push(ev);
      if (ev.type === "tool_start") void run.interrupt();
    }
    expect(doneOf(events)).toEqual({ type: "done", reason: "interrupted" });
  });

  test("aborting the run's signal ends it interrupted", async () => {
    const ws = workspace();
    const h = harness(ws);
    const run = engine(stubSandbox("silent").sandbox).start(h.options);
    const events: CodeEvent[] = [];
    for await (const ev of run) {
      events.push(ev);
      if (ev.type === "engine_session") setTimeout(() => h.abort.abort(), 50);
    }
    expect(doneOf(events)).toEqual({ type: "done", reason: "interrupted" });
  });

  test("an agent that exits mid-turn ends the run with an error and its stderr", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("crash").sandbox).start(harness(ws).options));
    const done = doneOf(events);
    expect(done.reason).toBe("error");
    expect(done.error).toContain("exit code 3");
    expect(done.error).toContain("boom");
  });

  test("an agent that goes quiet hits the idle timeout", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("silent").sandbox, { idleTimeoutMs: 300 }).start(harness(ws).options));
    expect(doneOf(events)).toMatchObject({ type: "done", reason: "error", error: "Fake did nothing for 1 second, so Rye stopped it." });
  });

  test("an agent that never answers initialize hits the start timeout", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("noinit").sandbox, { startTimeoutMs: 300 }).start(harness(ws).options));
    expect(doneOf(events)).toMatchObject({ reason: "error" });
    expect(doneOf(events).error).toContain("didn't answer initialize");
  });

  test("more tool calls than max_turns ends with max_turns", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("toolflood", { count: 5 }).sandbox).start(harness(ws, { limits: { maxTurns: 3, maxCostUsd: 5 } }).options));
    expect(doneOf(events)).toMatchObject({ reason: "max_turns", limit: "max_turns" });
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(4);
  });

  test("send() during a turn goes as the next prompt", async () => {
    const ws = workspace();
    const run = engine(stubSandbox("echo", { delayMs: 150 }).sandbox).start(harness(ws, { systemPrompt: "" }).options);
    run.send("And add a test.");
    const events = await collect(run);
    expect(textOf(events)).toMatch(/^got: Fix the bug\. pid=\d+got: And add a test\. pid=\d+$/);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("sessions", () => {
  test("the CLI process is kept for the session's next turn (no new process, no load)", async () => {
    const ws = workspace("cs_keep");
    const box = stubSandbox("echo");
    const e = engine(box.sandbox, { keepAliveMs: 60_000 });
    const first = await collect(e.start(harness(ws, { systemPrompt: "" }).options));
    const id = (first[0] as Extract<CodeEvent, { type: "engine_session" }>).id;
    const pid1 = /pid=(\d+)/.exec(textOf(first))![1];
    const second = await collect(e.start(harness(ws, { resume: id, input: { text: "Next.", attachments: [] } }).options));
    expect((second[0] as Extract<CodeEvent, { type: "engine_session" }>).id).toBe(id);
    expect(textOf(second)).toBe(`got: Next. pid=${pid1}`);
    expect(box.requests).toHaveLength(1);
    await e.close();
    expect(box.disposed()).toBe(1);
  });

  test("a new process continues a stored session with session/load; the replay isn't this turn's", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("echo").sandbox).start(harness(ws, { resume: "s-stored", input: { text: "Again.", attachments: [] } }).options));
    expect(events[0]).toMatchObject({ type: "engine_session", id: "s-stored" });
    expect(textOf(events)).toMatch(/^got: Again\. pid=\d+$/);
  });

  test("a session the agent can't load starts a new one, with a warning", async () => {
    const ws = workspace();
    const events = await collect(engine(stubSandbox("echo").sandbox).start(harness(ws, { resume: "s-gone" }).options));
    const session = events[0] as Extract<CodeEvent, { type: "engine_session" }>;
    expect(session.id).not.toBe("s-gone");
    expect(session.warning).toContain("couldn't continue session s-gone");
    expect(textOf(events)).toContain("<rye_instructions>");
  });
});

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

describe("sandbox", () => {
  test("no sandbox, no run: the engine refuses before starting anything", async () => {
    const ws = workspace();
    const box = stubSandbox("basic", undefined, false);
    let spawned = 0;
    const e = engine(box.sandbox, {
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });
    const events = await collect(e.start(harness(ws).options));
    expect(doneOf(events)).toMatchObject({ reason: "error" });
    expect(doneOf(events).error).toContain("runs only with its whole process inside Rye's OS sandbox");
    expect(doneOf(events).error).toContain("ripgrep");
    expect(box.requests).toHaveLength(0);
    expect(spawned).toBe(0);
    expect(await e.availability()).toEqual({ available: false, reason: "Fake Agent runs only inside Rye's OS sandbox, which can't run here: ripgrep (rg) is not installed." });
  });

  test("a plan that allows unsandboxed commands is refused", async () => {
    const ws = workspace();
    const box = stubSandbox("basic");
    const bad = { ...plan(ws), failIfUnavailable: false } as unknown as SandboxPlan;
    const events = await collect(engine(box.sandbox).start(harness(ws, { sandbox: bad }).options));
    expect(doneOf(events).error).toContain("must refuse to run unsandboxed");
    expect(box.requests).toHaveLength(0);
  });

  test("plan → srt config: the agent's files join the plan's lists", () => {
    const ws = workspace();
    const cfg = srtConfigFor({ plan: plan(ws), readOnly: ["/h/.copilot"], write: ["/h/.copilot/session-state"], denyWrite: ["/h/.copilot/config.json"], allowedDomains: ["API.example.com", "api.example.com"] });
    expect(cfg.filesystem.allowWrite).toEqual([ws.repoDir, ws.tmpDir, ws.cacheDir, "/h/.copilot/session-state"]);
    expect(cfg.filesystem.denyWrite).toEqual([ws.binDir, "/h/.copilot/config.json"]);
    expect(cfg.filesystem.allowRead).toEqual([ws.sessionDir, "/h/.copilot", "/h/.copilot/session-state"]);
    expect(cfg.filesystem.denyRead).toEqual([`${HOME}/.ssh`]);
    expect(cfg.allowedDomains).toEqual(["api.example.com"]);
    expect(shellCommand(["/bin/copilot", "--deny-tool=shell(git push)"])).toBe("/bin/copilot '--deny-tool=shell(git push)'");
  });

  test("srtProcessSandbox (with a fake srt module): status, per-process config and network list", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const fake = {
      SandboxManager: {
        isSupportedPlatform: () => true,
        checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
        initialize: async (cfg: unknown) => void calls.push(["initialize", cfg]),
        wrapWithSandbox: async (cmd: string, shell: string, custom: unknown, _s: unknown, opts: { commandId: string }) => {
          calls.push(["wrap", cmd, shell, custom, opts.commandId]);
          return `sandbox-exec -p PROFILE ${cmd}`;
        },
        registerCommandNetworkLists: (id: string, lists: unknown) => void calls.push(["register", id, lists]),
        unregisterCommandNetworkLists: (id: string) => void calls.push(["unregister", id]),
      },
    };
    const box = srtProcessSandbox({ load: async () => fake as never, platform: "darwin" });
    expect(await box.status()).toEqual({ available: true, mechanism: "seatbelt" });
    const ws = workspace();
    const proc = await box.wrap({ argv: ["/bin/copilot", "--acp"], env: { HOME }, plan: plan(ws), allowedDomains: ["api.github.com"], readOnly: [], write: [], denyWrite: [] });
    expect(proc.argv).toEqual(["/bin/bash", "-c", "sandbox-exec -p PROFILE /bin/copilot --acp"]);
    expect(proc.env).toEqual({ HOME });
    const init = calls.find((c) => c[0] === "initialize")![1] as { network: { allowedDomains: string[]; allowLocalBinding: boolean } };
    expect(init.network).toEqual({ allowedDomains: [], deniedDomains: [], allowLocalBinding: false });
    const wrap = calls.find((c) => c[0] === "wrap")!;
    const id = wrap[4] as string;
    expect(id.length).toBeGreaterThanOrEqual(22);
    expect((wrap[3] as { filesystem: { allowWrite: string[] } }).filesystem.allowWrite).toContain(ws.repoDir);
    expect(calls).toContainEqual(["register", id, { allowedDomains: ["api.github.com"] }]);
    proc.setAllowedDomains!(["api.github.com", "registry.npmjs.org"]);
    expect(calls).toContainEqual(["register", id, { allowedDomains: ["api.github.com", "registry.npmjs.org"] }]);
    await proc.dispose();
    expect(calls.at(-1)).toEqual(["unregister", id]);

    const missing = srtProcessSandbox({ load: async () => ({ SandboxManager: { ...fake.SandboxManager, checkDependenciesAsync: async () => ({ errors: ["ripgrep (rg) not found"], warnings: [] }) } }) as never, platform: "linux" });
    expect(await missing.status()).toEqual({ available: false, mechanism: null, reason: "ripgrep (rg) not found" });
    expect(await srtProcessSandbox({ load: async () => fake as never, platform: "win32" }).status()).toMatchObject({ available: false });
  });
});

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

describe("copilot", () => {
  test("the env allowlist drops Rye's secrets and general GitHub tokens", () => {
    const source = {
      PATH: "/usr/bin",
      HOME,
      LANG: "en_US.UTF-8",
      COPILOT_GITHUB_TOKEN: "github_pat_copilot",
      GH_TOKEN: "gho_general",
      GITHUB_TOKEN: "ghp_general",
      COPILOT_ALLOW_ALL: "true",
      RYE_COPILOT_API_KEY: "rye-secret",
      AWS_SECRET_ACCESS_KEY: "aws",
      ANTHROPIC_API_KEY: "sk-ant",
      MYSQL_PASSWORD: "db",
      HTTPS_PROXY: "http://corp:3128",
    };
    const env = copilotEnv({ source, overrides: { TMPDIR: "/ws/tmp" } });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME,
      LANG: "en_US.UTF-8",
      COPILOT_GITHUB_TOKEN: "github_pat_copilot",
      HTTPS_PROXY: "http://corp:3128",
      TMPDIR: "/ws/tmp",
      COPILOT_AUTO_UPDATE: "false",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(copilotEnvAllows("RYE_ANYTHING")).toBe(false);
    const profileEnv = copilotProfile({ home: HOME }).env({ source, workspaceVars: { PATH: "/ws/bin:/usr/bin" }, cacheDir: "/ws/cache" });
    expect(profileEnv.COPILOT_CACHE_HOME).toBe("/ws/cache/copilot");
    expect(profileEnv.PATH).toBe("/ws/bin:/usr/bin");
    expect(profileEnv.GH_TOKEN).toBeUndefined();
  });

  test("args: ACP over stdio, deny rules for push and publish, no allow-all", () => {
    const args = copilotArgs({ model: "gpt-5.4" });
    expect(args.slice(0, 2)).toEqual(["--acp", "--stdio"]);
    expect(args).toContain("--deny-tool=shell(git push)");
    expect(args).toContain("--deny-tool=shell(npm publish)");
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).toContain("--no-auto-update");
    expect(args).toContain("--model=gpt-5.4");
    expect(args.some((a) => a.startsWith("--allow"))).toBe(false);
    expect(args.filter((a) => a.startsWith("--deny-tool="))).toHaveLength(COPILOT_DENY_TOOLS.length);
    expect(copilotArgs({}).some((a) => a.startsWith("--model"))).toBe(false);
  });

  test("files and hosts", () => {
    expect(copilotFiles({}, HOME)).toEqual({
      readOnly: [`${HOME}/.copilot`],
      write: [`${HOME}/.copilot/session-state`, `${HOME}/.copilot/logs`],
      denyWrite: [`${HOME}/.copilot/config.json`, `${HOME}/.copilot/settings.json`, `${HOME}/.copilot/mcp-config.json`, `${HOME}/.copilot/mcp-oauth-config`],
    });
    expect(copilotFiles({ COPILOT_HOME: "/data/copilot" }, HOME).readOnly).toEqual(["/data/copilot"]);
    expect(copilotHosts({})).toEqual(["github.com", "api.github.com", "*.githubcopilot.com", "copilot-proxy.githubusercontent.com", "origin-tracker.githubusercontent.com"]);
    expect(copilotHosts({ GH_HOST: "https://acme.ghe.com" })).toContain("api.acme.ghe.com");
  });

  test("availability: not installed, not signed in, signed in, too old", async () => {
    const home = tmp("rye-copilot-home-");
    const emptyBin = tmp("rye-copilot-nobin-");
    const notInstalled = await copilotProfile({ home }).availability({ source: { PATH: emptyBin }, home });
    expect(notInstalled.available).toBe(false);
    expect(notInstalled.reason).toContain("isn't installed");
    expect(notInstalled.reason).toContain("npm install -g @github/copilot");

    const configured = locateCopilot({ PATH: emptyBin }, "/nowhere/copilot", home);
    expect("missing" in configured && configured.missing).toContain("/nowhere/copilot");

    // An npm-style install: bin/copilot → lib/node_modules/@github/copilot/index.js with its package.json.
    const prefix = tmp("rye-copilot-prefix-");
    const pkgDir = join(prefix, "lib", "node_modules", "@github", "copilot");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(join(prefix, "bin"));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@github/copilot", version: "1.0.116" }));
    writeFileSync(join(pkgDir, "index.js"), "// never run\n");
    symlinkSync(join(pkgDir, "index.js"), join(prefix, "bin", "copilot"));
    chmodSync(join(pkgDir, "index.js"), 0o755);
    const source = { PATH: join(prefix, "bin"), GH_TOKEN: "gho_x" };

    const signedOut = await copilotProfile({ home }).availability({ source, home });
    expect(signedOut.available).toBe(false);
    expect(signedOut.reason).toContain("isn't signed in");
    expect(signedOut.reason).toContain("GH_TOKEN is set, but Rye passes only COPILOT_GITHUB_TOKEN");

    expect(await copilotProfile({ home }).availability({ source: { ...source, COPILOT_GITHUB_TOKEN: "github_pat_x" }, home })).toEqual({ available: true, account: "COPILOT_GITHUB_TOKEN · Copilot CLI 1.0.116" });

    mkdirSync(join(home, ".copilot"));
    writeFileSync(join(home, ".copilot", "config.json"), JSON.stringify({ last_logged_in_user: { host: "https://github.com", login: "octocat" } }));
    expect(copilotAuthSource({}, home)).toBe("octocat");
    expect((await copilotProfile({ home }).availability({ source, home })).account).toBe("octocat · Copilot CLI 1.0.116");

    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@github/copilot", version: "0.0.339" }));
    const old = await copilotProfile({ home }).availability({ source, home });
    expect(old.available).toBe(false);
    expect(old.reason).toContain("too old");
  });

  test("the registry lists GitHub Copilot with its unavailable reason", async () => {
    const home = tmp("rye-copilot-home-");
    const e = copilotCodeEngine({ processEnv: { PATH: tmp("rye-copilot-nobin-") }, home, sandbox: stubSandbox("basic").sandbox });
    engines.push(e);
    const listing = (await new CodeEngineRegistry([e]).list())[0];
    expect(listing).toMatchObject({ id: "acp:copilot", title: "GitHub Copilot", capabilities: { ownSandbox: false, liveApprovals: true, resume: true }, models: [] });
    expect(listing.availability.available).toBe(false);
    expect(listing.availability.reason).toContain("isn't installed");
  });
});
