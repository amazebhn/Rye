/**
 * Code sessions: detached runs (code/runner.ts) with a scripted engine (code/engines/fake.ts).
 * Real git on temporary repos; no Claude Code, no sandbox-exec, no CLI agent is ever started.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SSEEvent } from "@rye/shared";
import { ChatStore } from "../src/chat/store.js";
import { CodeEngineRegistry } from "../src/code/engine.js";
import { scriptedCodeEngine, type FakeScript } from "../src/code/engines/fake.js";
import { ALLOW_ONCE, CONTINUE, CodeError, CodeRunner, DENY, decisionFor, logTurnOpen, promptFor, readLog, sessionOption, sessionSlug, userGitIdentity, type CodeTimers } from "../src/code/runner.js";
import { CodeStore } from "../src/code/store.js";
import { CODE_CONFIG_DEFAULTS, type ApprovalRequest, type CodeConfig, type CodeLogEntry } from "../src/code/types.js";
import { createWorkspaceManager } from "../src/code/workspace.js";

const TIMEOUT = 60_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const HOME = tmp("rye-run-home-");
const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Setup", "-c", "user.email=setup@example.com", ...args], { cwd, env: GIT_ENV, stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function makeRepo(): string {
  const repo = tmp("rye-run-repo-");
  git(repo, ["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  // The user's own identity, in the repo's config (read for branches they keep).
  git(repo, ["config", "user.name", "Ada User"]);
  git(repo, ["config", "user.email", "ada@example.com"]);
  return repo;
}

class ManualTimers implements CodeTimers {
  pending = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.n;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.pending.delete(h as number);
  }
  /** Fire every timer of at least `ms`. */
  fire(ms: number): number {
    let fired = 0;
    for (const [id, t] of [...this.pending]) {
      if (t.ms < ms) continue;
      this.pending.delete(id);
      t.fn();
      fired++;
    }
    return fired;
  }
}

async function waitFor(cond: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

interface Harness {
  runner: CodeRunner;
  store: CodeStore;
  chats: ChatStore;
  repo: string;
  root: string;
  timers: ManualTimers;
  engine: ReturnType<typeof scriptedCodeEngine>;
  config: CodeConfig;
  deps: ConstructorParameters<typeof CodeRunner>[0];
  log(id: string): CodeLogEntry[];
}

function harness(script: FakeScript, configPatch: Partial<CodeConfig> = {}): Harness {
  const base = tmp("rye-run-data-");
  const repo = makeRepo();
  const root = join(base, "code");
  const store = new CodeStore(join(base, "code.db"));
  const chats = new ChatStore(join(base, "chats.db"), null, null);
  const engine = scriptedCodeEngine(script);
  const timers = new ManualTimers();
  const config: CodeConfig = {
    ...CODE_CONFIG_DEFAULTS,
    policy: { allowed_domains: [], allow: [], ask: [], deny: [] },
    repos: [{ name: "demo", path: repo, base: "main", isolation: "clone", setup: [], checks: [] }],
    ...configPatch,
  };
  const workspaces = createWorkspaceManager();
  const deps: ConstructorParameters<typeof CodeRunner>[0] = {
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
    timers,
    log: () => {},
  };
  const runner = new CodeRunner(deps);
  return {
    runner,
    store,
    chats,
    repo,
    root,
    timers,
    engine,
    config,
    deps,
    log: (id) => readLog(join(root, id, "events.jsonl")),
  };
}

const types = (entries: CodeLogEntry[]) => entries.map((e) => e.event.type);
const turnsIn = (entries: CodeLogEntry[]) => {
  // How the view counts turns (codeEvents.ts): opened by a turn event, closed by done/error.
  let open = false;
  let n = 0;
  for (const { event } of entries) {
    if (event.type === "done" || event.type === "error") {
      if (!open) n++;
      open = false;
    } else if (!["code_status", "session", "agent", "env_changed", "sop_draft", "pause"].includes(event.type)) {
      if (!open) n++;
      open = true;
    }
  }
  return n;
};
const userMessages = (h: Harness, chatId: string) => (h.chats.get(chatId)?.messages ?? []).filter((m) => (m as { role?: string }).role === "user");

/** Writes a file in the clone, says something, ends. */
const editScript: FakeScript = async function* (ctx) {
  yield { type: "engine_session", id: "engine-1" };
  yield { type: "text", delta: "Editing. " };
  yield { type: "tool_start", id: `w-${ctx.options.input.text.length}`, name: "Write", args: { file_path: "src/new.ts" } };
  writeFileSync(join(ctx.options.workspace.repoDir, "src", "new.ts"), `export const said = ${JSON.stringify(ctx.options.input.text.split("\n")[0])};\n`);
  yield { type: "tool_result", id: `w-${ctx.options.input.text.length}`, content: "ok", isError: false };
  yield { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 };
  yield { type: "text", delta: "Done." };
  yield { type: "done", reason: "end" };
};

describe("pure helpers", () => {
  test("slugs, prompts and answers", () => {
    expect(sessionSlug("Fix search lag!", "cs_abcdef123456")).toBe("fix-search-lag-3456");
    const req: ApprovalRequest = { id: "p1", sessionId: "s", kind: "command", category: "install", reason: "installs packages", command: "bun add x", cwd: "", hosts: ["registry.npmjs.org"], pattern: "bun add *" };
    const prompt = promptFor(req, 30);
    expect(prompt.options).toEqual(["Allow once", 'Allow "bun add *" for this session', "Deny"]);
    expect(prompt.live).toBe(true);
    expect(prompt.type).toBe("choice");
    expect(prompt.question).toContain("`bun add x`");
    expect(prompt.question).toContain("registry.npmjs.org");
    expect(promptFor({ ...req, pattern: undefined }, 30).options).toEqual(["Allow once", "Deny"]);
    expect(decisionFor(req, ALLOW_ONCE)).toEqual({ behavior: "allow", scope: "once" });
    expect(decisionFor(req, sessionOption("bun add *"))).toEqual({ behavior: "allow", scope: "session", pattern: "bun add *" });
    expect(decisionFor(req, DENY).behavior).toBe("deny");
    expect(() => decisionFor(req, "yes please")).toThrow(CodeError);
    // An option for another pattern is not this prompt's.
    expect(() => decisionFor(req, sessionOption("rm *"))).toThrow(CodeError);
  });

  test("an open turn is one with events after the last done/error", () => {
    const e = (type: SSEEvent["type"], seq: number): CodeLogEntry => ({ seq, at: 0, event: { type, seq } });
    expect(logTurnOpen([])).toBe(false);
    expect(logTurnOpen([e("iter_start", 1), e("token", 2)])).toBe(true);
    expect(logTurnOpen([e("iter_start", 1), e("done", 2), e("code_status", 3)])).toBe(false);
  });
});

describe("CodeRunner", () => {
  test("create: a workspace, a code chat with the user's message, a turn in the log, a snapshot", async () => {
    const h = harness(editScript);
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "Add a new module" });
    expect(session.state).toBe("active");
    // No title model in tests: "<repo>: <the task's words>", and the branch from those words.
    expect(session.branch).toMatch(/^rye\/new-module-[a-f0-9]{4}$/);
    expect(h.chats.get(chatId)?.title).toBe("demo: New module");
    expect(session.lastSeq).toBeGreaterThan(0);
    const chat = h.chats.get(chatId)!;
    expect(chat.kind).toBe("code");
    expect(chat.sessionId).toBe(session.id);
    expect(userMessages(h, chatId)).toHaveLength(1);
    expect((userMessages(h, chatId)[0] as { content: string; id: string }).content).toBe("Add a new module");
    await h.runner.idle(session.id);
    const log = h.log(session.id);
    // Every frame has an increasing seq, set on the event too.
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.every((e) => e.event.seq === e.seq)).toBe(true);
    expect(types(log)).toContain("token");
    expect(types(log)).toContain("tool_start");
    expect(types(log)).toContain("tool_result");
    expect(types(log)).toContain("usage");
    expect(types(log).filter((t) => t === "done")).toHaveLength(1);
    expect(log.find((e) => e.event.type === "tool_result")!.event.name).toBe("Write");
    expect(turnsIn(log)).toBe(1);
    const status = log.filter((e) => e.event.type === "code_status").at(-1)!.event.code_status!;
    expect(status.activity).toBe("ready");
    expect(status.branch?.stat.files).toBe(1);
    expect(status.run).toBeUndefined();
    // The run's user turn closed with a snapshot.
    expect((await h.runner.snapshots(session.id)).snapshots.map((s) => s.turn)).toEqual([1]);
    expect(h.store.get(session.id)!.engineSessionId).toBe("engine-1");
    expect(h.store.get(session.id)!.costUsd).toBeCloseTo(0.01);
    // The engine got the workspace, a sandbox, a scrubbed env and a stable system prompt.
    const o = h.engine.runs[0].options;
    expect(o.sandbox.cwd.endsWith("/repo")).toBe(true);
    expect(o.sandbox.failIfUnavailable).toBe(true);
    expect(o.env.PATH.split(":")[0]).toBe(o.workspace.binDir);
    expect(Object.keys(o.env).some((k) => k.startsWith("RYE_"))).toBe(false);
    expect(o.systemPrompt).toContain(session.branch);
    expect(o.input.text.startsWith("Add a new module")).toBe(true);
    expect(o.input.text).toContain("<rye_context>");
    expect(existsSync(join(o.workspace.binDir, "git"))).toBe(true);
  }, TIMEOUT);

  test("a run continues after its subscriber disconnects, and ?after resumes strictly after a seq", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async function* (ctx) {
      yield { type: "text", delta: "one " };
      await gate;
      yield { type: "text", delta: "two " };
      yield { type: "text", delta: "three" };
      void ctx;
      yield { type: "done", reason: "end" };
    });
    const { session } = await h.runner.create({ repo: "demo", task: "Count" });
    const ctrl = new AbortController();
    const seen: CodeLogEntry[] = [];
    const reading = (async () => {
      for await (const e of h.runner.subscribe(session.id, 0, ctrl.signal)) {
        seen.push(e);
        if (e.event.type === "token") ctrl.abort(); // the tab closes after the first token
      }
    })();
    await reading;
    const lastSeen = seen.at(-1)!.seq;
    expect(h.runner.isRunning(session.id)).toBe(true);
    release();
    await h.runner.idle(session.id);
    expect(h.runner.isRunning(session.id)).toBe(false);

    // Resubscribe after what was seen: only what came later, then it stays open for more.
    const ctrl2 = new AbortController();
    const later: CodeLogEntry[] = [];
    const following = (async () => {
      for await (const e of h.runner.subscribe(session.id, lastSeen, ctrl2.signal)) later.push(e);
    })();
    await waitFor(() => later.some((e) => e.event.type === "done"), 5000, "the replayed done");
    expect(later.every((e) => e.seq > lastSeen)).toBe(true);
    expect(later.filter((e) => e.event.type === "token").map((e) => e.event.content)).toEqual(["two ", "three"]);
    const before = later.length;
    await h.runner.send(session.chatId, { message: "Again", turnId: "t2" });
    await waitFor(() => later.length > before && later.slice(before).some((e) => e.event.type === "done"), 5000, "live events of the next turn");
    ctrl2.abort();
    await following;
  }, TIMEOUT);

  test("approvals: allow once, deny, allow for the session (kept for later runs)", async () => {
    const answers: string[] = [];
    const h = harness(async function* (ctx) {
      const id = `bash-${ctx.options.input.text.slice(0, 5)}`;
      yield { type: "tool_start", id, name: "Bash", args: { command: "bun add left-pad" } };
      const d = await ctx.options.approve({ id: `ask-${Math.random()}`, sessionId: ctx.options.workspace.sessionId, toolName: "Bash", toolUseId: id, kind: "command", category: "install", reason: "installs packages from registry.npmjs.org", command: "bun add left-pad", argv: ["bun", "add", "left-pad"], cwd: "", hosts: ["registry.npmjs.org"], pattern: "bun add *" });
      answers.push(d.behavior === "allow" ? `allow:${d.scope}` : d.behavior);
      yield { type: "tool_result", id, content: d.behavior === "allow" ? "installed" : "refused", isError: d.behavior !== "allow" };
      yield { type: "done", reason: "end" };
    });
    const { session } = await h.runner.create({ repo: "demo", task: "first install" });
    const promptOf = () => h.log(session.id).filter((e) => e.event.type === "prompt").at(-1)?.event;
    await waitFor(() => promptOf() !== undefined, 5000, "the live prompt");
    let prompt = promptOf()!;
    expect(prompt.live).toBe(true);
    expect(prompt.prompt_type).toBe("choice");
    expect(prompt.options).toEqual(["Allow once", 'Allow "bun add *" for this session', "Deny"]);
    await waitFor(() => (h.store.get(session.id)?.activity ?? "") === "needs_approval");
    const detail = await h.runner.detail(session.id);
    expect(detail.pendingPrompt?.id).toBe(prompt.prompt_id);
    expect(detail.status.pendingPromptId).toBe(prompt.prompt_id);
    // A wrong prompt id is "answered".
    expect(() => h.runner.answer(session.id, "nope", ALLOW_ONCE)).toThrow(expect.objectContaining({ code: "answered" }));
    h.runner.answer(session.id, prompt.prompt_id!, ALLOW_ONCE);
    // Answering twice: already answered.
    expect(() => h.runner.answer(session.id, prompt.prompt_id!, ALLOW_ONCE)).toThrow(expect.objectContaining({ code: "answered", status: 409 }));
    await h.runner.idle(session.id);
    expect(answers).toEqual(["allow:once"]);
    // The status after the answer has no pending prompt.
    const statuses = h.log(session.id).filter((e) => e.event.type === "code_status").map((e) => e.event.code_status!);
    expect(statuses.some((s) => s.pendingPromptId === prompt.prompt_id)).toBe(true);
    expect(statuses.at(-1)!.pendingPromptId).toBeUndefined();
    expect(h.store.commands(session.id).map((c) => c.status)).toEqual(["ok"]);

    await h.runner.send(session.chatId, { message: "second deny", turnId: "t2" });
    await waitFor(() => promptOf()!.prompt_id !== prompt.prompt_id, 5000, "the second prompt");
    prompt = promptOf()!;
    h.runner.answer(session.id, prompt.prompt_id!, DENY);
    await h.runner.idle(session.id);
    expect(answers).toEqual(["allow:once", "deny"]);
    expect(h.store.commands(session.id).map((c) => c.status)).toEqual(["ok", "denied"]);

    await h.runner.send(session.chatId, { message: "third session", turnId: "t3" });
    await waitFor(() => promptOf()!.prompt_id !== prompt.prompt_id, 5000, "the third prompt");
    prompt = promptOf()!;
    h.runner.answer(session.id, prompt.prompt_id!, sessionOption("bun add *"));
    await h.runner.idle(session.id);
    expect(h.store.get(session.id)!.sessionRules).toEqual([{ pattern: "bun add *", hosts: ["registry.npmjs.org"] }]);
    // The next run's policy carries the session's approval: the pattern is allowed and its host reachable.
    await h.runner.send(session.chatId, { message: "fourth", turnId: "t4" });
    await waitFor(() => h.engine.runs.length === 4);
    const policy = h.engine.runs[3].options.policy;
    expect(policy.commandVerdict("bun add zod").verdict).toBe("allow");
    expect(policy.allowedDomains).toContain("registry.npmjs.org");
    expect(h.engine.runs[3].options.sandbox.network.allowedDomains).toContain("registry.npmjs.org");
    expect(h.engine.runs[0].options.policy.commandVerdict("bun add zod").verdict).toBe("ask");
    await waitFor(() => promptOf()!.prompt_id !== prompt.prompt_id);
    h.runner.answer(session.id, promptOf()!.prompt_id!, DENY);
    await h.runner.idle(session.id);
  }, TIMEOUT);

  test("an unanswered prompt is denied after approval_timeout_minutes", async () => {
    let decision = "";
    const h = harness(async function* (ctx) {
      const d = await ctx.options.approve({ id: "ask-1", sessionId: ctx.options.workspace.sessionId, kind: "command", category: "network", reason: "fetches a page", command: "curl https://example.com", cwd: "", hosts: ["example.com"] });
      decision = d.behavior === "deny" ? `${d.reason}:${d.message}` : d.behavior;
      yield { type: "done", reason: "end" };
    }, { approval_timeout_minutes: 30 });
    const { session } = await h.runner.create({ repo: "demo", task: "fetch" });
    await waitFor(() => h.timers.pending.size > 0, 5000, "the approval timer");
    expect([...h.timers.pending.values()][0].ms).toBe(30 * 60_000);
    // Nothing fires early.
    expect(h.timers.fire(31 * 60_000)).toBe(0);
    expect(h.timers.fire(30 * 60_000)).toBe(1);
    await h.runner.idle(session.id);
    expect(decision).toBe("timeout:No answer within 30 minutes, so Rye refused this.");
    expect(() => h.runner.answer(session.id, "ask-1", ALLOW_ONCE)).toThrow(expect.objectContaining({ code: "answered" }));
    expect((await h.runner.detail(session.id)).pendingPrompt).toBeUndefined();
  }, TIMEOUT);

  test("steering goes into the live run and pairs each user message with its own turn", async () => {
    const h = harness(async function* (ctx) {
      yield { type: "text", delta: "starting " };
      const m = await ctx.nextSteer();
      yield { type: "text", delta: `got ${m?.split("\n")[0]}` };
      yield { type: "done", reason: "end" };
    });
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "wait for me" });
    await waitFor(() => h.log(session.id).some((e) => e.event.type === "token"));
    const sent = await h.runner.send(chatId, { message: "use tabs", turnId: "steer-1" });
    expect(sent.sessionId).toBe(session.id);
    await h.runner.idle(session.id);
    expect(h.engine.runs).toHaveLength(1);
    expect(h.engine.runs[0].steered[0].startsWith("use tabs")).toBe(true);
    const users = userMessages(h, chatId) as Array<{ id: string; content: string }>;
    expect(users.map((u) => u.content)).toEqual(["wait for me", "use tabs"]);
    expect(users[1].id).toBe("steer-1");
    const log = h.log(session.id);
    expect(turnsIn(log)).toBe(2);
    expect(log.filter((e) => e.seq > sent.after && e.event.type === "token").map((e) => e.event.content)).toEqual(["got use tabs"]);
    expect(h.store.get(session.id)!.turns).toBe(2);
  }, TIMEOUT);

  test("stop interrupts the run; the busy guard refuses git actions while it runs", async () => {
    const h = harness(async function* (ctx) {
      yield { type: "text", delta: "working " };
      await ctx.sleep(60_000);
      yield { type: "done", reason: "end" };
    });
    const { session } = await h.runner.create({ repo: "demo", task: "long job" });
    await waitFor(() => h.log(session.id).some((e) => e.event.type === "token"));
    for (const action of [
      () => h.runner.stage(session.id, ["src/app.ts"], true),
      () => h.runner.discard(session.id, ["src/app.ts"]),
      () => h.runner.createBranch(session.id, {}),
      () => h.runner.merge(session.id, {}),
      () => h.runner.archive(session.id),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "busy", status: 409 });
    }
    await h.runner.stop(session.id);
    expect(h.runner.isRunning(session.id)).toBe(false);
    expect(h.engine.runs[0].interrupted).toBe(true);
    const done = h.log(session.id).filter((e) => e.event.type === "done").at(-1)!;
    expect(done.event.content).toBe("Stopped.");
    expect(h.store.get(session.id)!.runState).toBe("idle");
    // Stopping again is harmless.
    await h.runner.stop(session.id);
  }, TIMEOUT);

  test("a budget limit asks to continue; Continue resumes the engine session", async () => {
    const h = harness(async function* (ctx) {
      yield { type: "engine_session", id: "eng-budget" };
      if (ctx.options.input.text.startsWith("Continue")) {
        yield { type: "text", delta: "carrying on" };
        yield { type: "done", reason: "end" };
        return;
      }
      yield { type: "text", delta: "busy " };
      yield { type: "done", reason: "max_turns", limit: "max_turns", error: "Reached the limit of 200 turns." };
    });
    const { session } = await h.runner.create({ repo: "demo", task: "big job" });
    const promptOf = () => h.log(session.id).filter((e) => e.event.type === "prompt").at(-1)?.event;
    await waitFor(() => promptOf() !== undefined, 5000, "the budget prompt");
    expect(promptOf()!.options).toEqual(["Continue", "Stop"]);
    expect(promptOf()!.question).toContain("200 turns");
    h.runner.answer(session.id, promptOf()!.prompt_id!, CONTINUE);
    await h.runner.idle(session.id);
    expect(h.engine.runs).toHaveLength(2);
    expect(h.engine.runs[1].options.resume).toBe("eng-budget");
    const log = h.log(session.id);
    // Still one turn: the continuation belongs to the same user message.
    expect(turnsIn(log)).toBe(1);
    expect(log.filter((e) => e.event.type === "token").map((e) => e.event.content)).toEqual(["busy ", "carrying on"]);
  }, TIMEOUT);

  test("a snapshot per turn; stage, branch (the user's identity) and merge after the run", async () => {
    const h = harness(editScript);
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "first" });
    await h.runner.idle(session.id);
    await h.runner.send(chatId, { message: "second", turnId: "t2" });
    await h.runner.idle(session.id);
    expect((await h.runner.snapshots(session.id)).snapshots.map((s) => s.turn)).toEqual([1, 2]);
    const changes = await h.runner.changes(session.id);
    expect(changes.files.map((f) => f.path)).toEqual(["src/new.ts"]);
    const staged = await h.runner.stage(session.id, ["src/new.ts"], true);
    expect(staged.files[0].stage).toBe("staged");
    const branch = await h.runner.createBranch(session.id, {});
    expect(branch.status).toBe("created");
    if (branch.status !== "created") throw new Error("unreachable");
    expect(git(h.repo, ["branch", "--list", "rye/*"])).toContain(branch.branch);
    expect(git(h.repo, ["log", "-1", "--format=%an <%ae>", branch.branch])).toBe("Ada User <ada@example.com>");
    // Snapshots stay Rye's.
    expect(git(h.repo, ["log", "-1", "--format=%an", `refs/rye/${session.id}/turn-2`])).toBe("Rye");
    // The user's checkout is untouched.
    expect(git(h.repo, ["status", "--porcelain"])).toBe("");
    expect(git(h.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    // A second Create branch with the same name writes nothing.
    expect((await h.runner.createBranch(session.id, {})).status).toBe("branch_exists");
    // Merge with latest base, after the base moved on.
    writeFileSync(join(h.repo, "README.md"), "# Demo\n\nmore\n");
    git(h.repo, ["commit", "-q", "-am", "base moves"]);
    const merged = await h.runner.merge(session.id, { name: "rye/merged" });
    expect(merged.status).toBe("merged");
    expect(git(h.repo, ["log", "-1", "--format=%an|%P", "rye/merged"]).split("|")[0]).toBe("Ada User");
    expect(git(h.repo, ["log", "-1", "--format=%P", "rye/merged"]).split(" ")).toHaveLength(2);
    // The discard undo snapshot.
    const discarded = await h.runner.discard(session.id, ["src/new.ts"]);
    expect(discarded.snapshot.ref).toBe(`refs/rye/${session.id}/discard-1`);
    expect(discarded.changes.files).toEqual([]);
  }, TIMEOUT);

  test("restart recovery closes the cut-off turn; the next message resumes the engine session", async () => {
    const h = harness(editScript);
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "before the crash" });
    await h.runner.idle(session.id);
    // A crash mid-turn: a second turn's message stored, its events half written, the row still running.
    h.chats.appendMessage(chatId, { role: "user", content: "during the crash", id: "t-crash" });
    const file = join(h.root, session.id, "events.jsonl");
    const last = h.log(session.id).at(-1)!.seq;
    appendFileSync(file, `${JSON.stringify({ seq: last + 1, at: 1, event: { type: "iter_start", seq: last + 1 } })}\n`);
    appendFileSync(file, `${JSON.stringify({ seq: last + 2, at: 1, event: { type: "token", content: "half", seq: last + 2 } })}\n{"torn`);
    h.store.update(session.id, { runState: "running", activity: "running", turns: 2 });

    const after = new CodeRunner(h.deps);
    expect(after.recover()).toBe(1);
    await after.idle(session.id);
    const log = readLog(file);
    const error = log.find((e) => e.event.type === "error")!;
    expect(error.seq).toBe(last + 3);
    expect(error.event.error).toContain("restarted");
    expect(turnsIn(log)).toBe(2);
    expect(h.store.get(session.id)!.runState).toBe("idle");
    expect(h.store.get(session.id)!.activity).toBe("error");
    // Recovering again changes nothing.
    expect(after.recover()).toBe(0);

    await after.send(chatId, { message: "carry on", turnId: "t3" });
    await after.idle(session.id);
    expect(h.engine.runs.at(-1)!.options.resume).toBe("engine-1");
    expect(turnsIn(readLog(file))).toBe(3);
    expect(userMessages(h, chatId)).toHaveLength(3);
  }, TIMEOUT);

  test("refusals: unknown repo, no sandbox, max_sessions, archived sessions", async () => {
    const h = harness(editScript, { max_sessions: 1 });
    await expect(h.runner.create({ repo: "elsewhere", task: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.runner.create({ repo: "demo", task: "  " })).rejects.toMatchObject({ code: "invalid" });
    const noSandbox = new CodeRunner({ ...h.deps, sandboxProbe: async () => ({ available: false, mechanism: null, reason: "bubblewrap is not installed" }) });
    await expect(noSandbox.create({ repo: "demo", task: "x" })).rejects.toMatchObject({ code: "sandbox_unavailable", status: 503 });
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "one" });
    await h.runner.idle(session.id);
    await expect(h.runner.create({ repo: "demo", task: "two" })).rejects.toMatchObject({ code: "limit" });
    const archived = await h.runner.archive(session.id);
    expect(archived.state).toBe("archived");
    expect(archived.workspacePath).toBeUndefined();
    await expect(h.runner.send(chatId, { message: "more" })).rejects.toMatchObject({ code: "archived" });
    await expect(h.runner.changes(session.id)).rejects.toMatchObject({ code: "archived" });
    const restored = await h.runner.restore(session.id);
    expect(restored.state).toBe("active");
    expect(readFileSync(join(restored.workspacePath!, "src", "new.ts"), "utf8")).toContain("one");
  }, TIMEOUT);

  test("deleting the code chat archives the session and keeps the work", async () => {
    const h = harness(editScript);
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "keep me" });
    await h.runner.idle(session.id);
    await h.runner.onChatRemoved(chatId);
    const rec = h.store.get(session.id)!;
    expect(rec.status).toBe("archived");
    expect(git(h.repo, ["for-each-ref", "--format=%(refname)", `refs/rye/${session.id}/`])).toContain("turn-1");
  }, TIMEOUT);
});
