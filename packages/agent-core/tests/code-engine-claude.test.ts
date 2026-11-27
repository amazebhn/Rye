/**
 * The `claude` code engine against a fake `query()`: a scripted Claude Code that runs Rye's
 * hooks and `canUseTool` the way the real one does. Claude Code, `sandbox-exec` and real CLIs are
 * never started here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { CodeEngineRegistry, getEngine } from "../src/code/engine.js";
import {
  CODE_BUILTIN_TOOLS,
  claudeAuthSource,
  claudeCodeEngine,
  claudeCodeEnv,
  claudeCodeVersionProblem,
  hostAllowed,
  platformSandboxStatus,
  type ClaudeEngineDeps,
} from "../src/code/engines/claude.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CodeEngine,
  CodeEvent,
  CodeRun,
  CodeRunOptions,
  CompiledPolicy,
  RyeToolCall,
  SandboxPlan,
  Verdict,
  Workspace,
} from "../src/code/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "rye-code-engine-"));
  roots.push(root);
  const sessionDir = join(root, "sess");
  const dirs = { repoDir: join(sessionDir, "repo"), tmpDir: join(sessionDir, "tmp"), cacheDir: join(sessionDir, "cache") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const userRepoPath = join(root, "user-repo");
  return {
    sessionDir,
    ...dirs,
    binDir: join(dirs.cacheDir, "bin"),
    eventsFile: join(sessionDir, "events.jsonl"),
    sessionFile: join(sessionDir, "session.json"),
    sessionId: "cs_test",
    repoName: "rye",
    userRepoPath,
    userGitDir: join(userRepoPath, ".git"),
    userObjectsDir: join(userRepoPath, ".git", "objects"),
    isolation: "clone",
    baseRef: "main",
    baseSha: "a".repeat(40),
    includeUncommitted: false,
    slug: "fix-it",
    branch: "rye/fix-it",
    refPrefix: "refs/rye/cs_test/",
    baseRefPin: "refs/rye/cs_test/base",
  };
}

function plan(ws: Workspace, over: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    cwd: ws.repoDir,
    filesystem: { allowWrite: [ws.repoDir, ws.tmpDir, ws.cacheDir], denyWrite: [], allowRead: [ws.sessionDir], denyRead: ["/home/me/.ssh"] },
    network: { allowedDomains: [], allowLocalBinding: false },
    ...over,
  };
}

const HOME = "/home/me";

interface PolicyLog {
  commands: string[];
  paths: Array<[string, string]>;
  sessionPatterns: string[];
}

/** A small stand-in for code/policy.ts. */
function stubPolicy(ws: Workspace, log: PolicyLog, session: string[] = [], allowedDomains: string[] = []): CompiledPolicy {
  return {
    commandVerdict(cmd): Verdict {
      log.commands.push(cmd);
      if (/\bgit\s+push\b/.test(cmd)) return { verdict: "deny", reason: "git push is never allowed in a code session" };
      if (/^bun install\b/.test(cmd)) {
        if (session.includes("bun install *")) return { verdict: "allow", rule: "bun install *" };
        return { verdict: "ask", category: "install", reason: "installs packages from registry.npmjs.org", hosts: ["registry.npmjs.org"], pattern: "bun install *" };
      }
      if (/^curl\b/.test(cmd)) return { verdict: "ask", category: "network", reason: "reaches example.org", hosts: ["example.org"] };
      return { verdict: "allow" };
    },
    pathVerdict(path, op): Verdict {
      log.paths.push([path, op]);
      const abs = resolve(ws.repoDir, path);
      if (abs.startsWith(`${HOME}/.ssh`)) return { verdict: "deny", reason: "~/.ssh is never readable in a code session" };
      const inside = abs === ws.repoDir || abs.startsWith(`${ws.repoDir}/`);
      if (inside) return { verdict: "allow" };
      if (op === "write") return { verdict: "deny", reason: `${abs} is outside the workspace` };
      return { verdict: "ask", category: "path", reason: `reads ${abs}, outside the workspace` };
    },
    allowForSession(pattern) {
      log.sessionPatterns.push(pattern);
      return stubPolicy(ws, log, [...session, pattern], allowedDomains);
    },
    rules: [],
    allowedDomains,
  };
}

const newPolicyLog = (): PolicyLog => ({ commands: [], paths: [], sessionPatterns: [] });

interface Harness {
  options: CodeRunOptions;
  approvals: ApprovalRequest[];
  ryeCalls: Array<{ call: RyeToolCall; signal: AbortSignal }>;
  policyLog: PolicyLog;
  abort: AbortController;
}

/** Run options with recorders; `decide` answers approvals in order. */
function harness(ws: Workspace, over: Partial<CodeRunOptions> = {}, decide: Array<ApprovalDecision | ((r: ApprovalRequest) => ApprovalDecision)> = []): Harness {
  const approvals: ApprovalRequest[] = [];
  const ryeCalls: Harness["ryeCalls"] = [];
  const policyLog = newPolicyLog();
  const abort = new AbortController();
  const options: CodeRunOptions = {
    workspace: ws,
    input: { text: "Fix the search lag.", attachments: [] },
    systemPrompt: "Follow AGENTS.md.",
    policy: stubPolicy(ws, policyLog),
    sandbox: plan(ws),
    async approve(req) {
      approvals.push(req);
      const next = decide.shift();
      if (!next) return { behavior: "deny", reason: "user", message: "no decision scripted" };
      return typeof next === "function" ? next(req) : next;
    },
    ryeTools: [],
    async runRyeTool(call, signal) {
      ryeCalls.push({ call, signal });
      return { content: [{ type: "text", text: `found 2 notes for ${String(call.args.query)}` }], isError: false };
    },
    env: { PATH: `${ws.binDir}:/usr/bin`, HOME, TMPDIR: ws.tmpDir },
    limits: { maxTurns: 50, maxCostUsd: 5 },
    signal: abort.signal,
    ...over,
  };
  return { options, approvals, ryeCalls, policyLog, abort };
}

// ---------------------------------------------------------------------------
// The fake Claude Code
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = Record<string, any>;

interface FakeLog {
  options: any;
  queries: number;
  prompts: Array<{ text: string; uuid?: string; priority?: string }>;
  executed: Array<{ name: string; input: any }>;
  denials: Array<{ name: string; by: "hook" | "canUseTool"; message: string }>;
  closed: number;
  interrupts: number;
  flagSettings: any[];
}

interface Fake {
  log: FakeLog;
  options: any;
  /** The next user message Rye sent, or undefined when the input ended. */
  next(): Promise<Msg | undefined>;
  /** Run a tool call through the hooks and canUseTool, as Claude Code does. */
  useTool(name: string, input: Record<string, unknown>, id: string, cwd?: string): Promise<{ allowed: boolean; message?: string; input?: any }>;
  interrupted: Promise<void>;
}

function fakeQuery(script: (f: Fake) => AsyncGenerator<Msg>) {
  const log: FakeLog = { options: undefined, queries: 0, prompts: [], executed: [], denials: [], closed: 0, interrupts: 0, flagSettings: [] };
  const query = ({ prompt, options }: any) => {
    log.queries++;
    log.options = options;
    const input = prompt[Symbol.asyncIterator]();
    let onInterrupt!: () => void;
    const interrupted = new Promise<void>((r) => (onInterrupt = r));
    const signal = new AbortController().signal;
    const fake: Fake = {
      log,
      options,
      async next() {
        const n = await input.next();
        if (n.done) return undefined;
        const text = (n.value.message.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("\n");
        log.prompts.push({ text, uuid: n.value.uuid, priority: n.value.priority });
        return n.value;
      },
      async useTool(name, toolInput, id, cwd = options.cwd) {
        for (const matcher of options.hooks?.PreToolUse ?? []) {
          for (const hook of matcher.hooks) {
            const out = await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: toolInput, tool_use_id: id, cwd, session_id: "sess-1", transcript_path: "/t" }, id, { signal });
            if (out?.hookSpecificOutput?.permissionDecision === "deny") {
              const message = out.hookSpecificOutput.permissionDecisionReason;
              log.denials.push({ name, by: "hook", message });
              return { allowed: false, message };
            }
          }
        }
        const r = await options.canUseTool(name, toolInput, { signal, toolUseID: id, requestId: `req_${id}` });
        if (r.behavior === "deny") {
          log.denials.push({ name, by: "canUseTool", message: r.message });
          return { allowed: false, message: r.message };
        }
        log.executed.push({ name, input: r.updatedInput ?? toolInput });
        for (const matcher of options.hooks?.PostToolUse ?? []) {
          for (const hook of matcher.hooks) {
            await hook({ hook_event_name: "PostToolUse", tool_name: name, tool_input: toolInput, tool_response: {}, tool_use_id: id, cwd, session_id: "sess-1", transcript_path: "/t" }, id, { signal });
          }
        }
        return { allowed: true, input: r.updatedInput };
      },
      interrupted,
    };
    const gen = script(fake);
    return Object.assign(gen, {
      close() {
        log.closed++;
        void gen.return(undefined);
      },
      async interrupt() {
        log.interrupts++;
        onInterrupt();
      },
      async applyFlagSettings(settings: unknown) {
        log.flagSettings.push(settings);
      },
    });
  };
  return { query: query as unknown as ClaudeEngineDeps["query"], log };
}

const init = (version = "2.1.331", sessionId = "sess-1"): Msg => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  claude_code_version: version,
  cwd: "/repo",
  tools: CODE_BUILTIN_TOOLS,
  mcp_servers: [],
  model: "sonnet",
  permissionMode: "default",
});

const stream = (event: Msg): Msg => ({ type: "stream_event", parent_tool_use_id: null, event });

/** A text reply, streamed and then repeated as the assistant message (which must not show twice). */
function* textReply(messageId: string, text: string): Generator<Msg> {
  yield stream({ type: "message_start", message: { id: messageId, usage: { input_tokens: 5 } } });
  yield stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  yield stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  yield stream({ type: "content_block_stop", index: 0 });
  yield { type: "assistant", parent_tool_use_id: null, message: { id: messageId, content: [{ type: "text", text }] } };
  yield stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
  yield stream({ type: "message_stop" });
}

/** A tool call, streamed and then repeated as the assistant message. */
function* toolCall(messageId: string, id: string, name: string, input: Record<string, unknown>): Generator<Msg> {
  yield stream({ type: "message_start", message: { id: messageId } });
  yield stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } });
  yield stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  yield stream({ type: "content_block_stop", index: 0 });
  yield { type: "assistant", parent_tool_use_id: null, message: { id: messageId, content: [{ type: "tool_use", id, name, input }] } };
  yield stream({ type: "message_delta", delta: { stop_reason: "tool_use" } });
  yield stream({ type: "message_stop" });
}

const toolResult = (id: string, content: string, isError = false): Msg => ({
  type: "user",
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: content }], is_error: isError }] },
});

const result = (o: { subtype?: string; isError?: boolean; total?: number; uuids?: string[]; queued?: number; text?: string; errors?: string[] } = {}): Msg => ({
  type: "result",
  subtype: o.subtype ?? "success",
  is_error: o.isError ?? false,
  result: o.text ?? "",
  errors: o.errors ?? [],
  num_turns: 1,
  total_cost_usd: o.total ?? 0.01,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  ...(o.uuids ? { user_message_uuids: o.uuids } : {}),
  ...(o.queued !== undefined ? { queued_turn_count: o.queued } : {}),
});

/** A Claude Code that makes `calls` in order (through the hooks), then answers. */
function callsScript(calls: Array<{ name: string; input: Record<string, unknown>; cwd?: string }>) {
  return async function* (f: Fake): AsyncGenerator<Msg> {
    yield init();
    const first = await f.next();
    for (const [i, c] of calls.entries()) {
      const id = `toolu_${i}`;
      yield* toolCall(`msg_${i}`, id, c.name, c.input);
      const r = await f.useTool(c.name, c.input, id, c.cwd);
      yield toolResult(id, r.allowed ? `ran ${c.name}` : r.message ?? "denied", !r.allowed);
    }
    yield* textReply("msg_end", "Done.");
    yield result({ uuids: [first?.uuid] });
  };
}

async function collect(run: CodeRun): Promise<CodeEvent[]> {
  const events: CodeEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

const engineWith = (query: ClaudeEngineDeps["query"], deps: ClaudeEngineDeps = {}) =>
  claudeCodeEngine({ query, home: HOME, processEnv: { PATH: "/usr/bin", HOME }, onWarning: () => {}, ...deps });

const done = (events: CodeEvent[]) => events.find((e): e is Extract<CodeEvent, { type: "done" }> => e.type === "done");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe("claude code engine: options", () => {
  test("cwd, sandbox, permission mode and isolation options reach query()", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(callsScript([]));
    const h = harness(ws, { model: "opus", resume: "prev-session", sandbox: plan(ws, { network: { allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true } }) });
    h.options.policy = stubPolicy(ws, h.policyLog, [], ["docs.example.com"]);
    await collect(engineWith(query).start(h.options));

    const o = log.options;
    expect(o.cwd).toBe(ws.repoDir);
    expect(o.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: ["registry.npmjs.org", "docs.example.com"], allowLocalBinding: true },
      filesystem: { allowWrite: [ws.repoDir, ws.tmpDir, ws.cacheDir], denyWrite: [], allowRead: [ws.sessionDir], denyRead: ["/home/me/.ssh"] },
    });
    expect(o.permissionMode).toBe("default");
    expect(o.settingSources).toEqual([]);
    // No "Co-Authored-By: Claude" trailer or PR attribution in the user's history.
    expect(o.settings).toEqual({ attribution: { commit: "", pr: "" } });
    expect(o.strictMcpConfig).toBe(true);
    expect(o.allowedTools).toBeUndefined();
    expect(o.tools).toEqual(CODE_BUILTIN_TOOLS);
    expect(o.disallowedTools).toContain("Agent");
    expect(o.disallowedTools).toContain("Bash(git push *)");
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Follow AGENTS.md." });
    expect(o.model).toBe("opus");
    expect(o.resume).toBe("prev-session");
    expect(o.maxTurns).toBe(50);
    expect(o.maxBudgetUsd).toBe(5);
    expect(o.persistSession).toBe(true);
    expect(o.verbatimPrompts).toBe(true);
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(o.hooks.PreToolUse[0].onFailure).toBe("block");
    expect(typeof o.canUseTool).toBe("function");
    expect(o.mcpServers).toBeUndefined();
    expect(log.prompts[0].text).toBe("Fix the search lag.");
  });

  test("a blank or 'default' model leaves the choice to Claude Code", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(callsScript([]));
    await collect(engineWith(query).start(harness(ws, { model: " default " }).options));
    expect(log.options.model).toBeUndefined();
    expect(log.options.resume).toBeUndefined();
  });

  test("refuses a sandbox plan that doesn't fail closed, or runs anywhere but the repo", async () => {
    const ws = workspace();
    for (const sandbox of [
      { ...plan(ws), failIfUnavailable: false } as unknown as SandboxPlan,
      { ...plan(ws), allowUnsandboxedCommands: true } as unknown as SandboxPlan,
      plan(ws, { cwd: ws.userRepoPath }),
      plan(ws, { filesystem: { allowWrite: [ws.tmpDir], denyWrite: [], allowRead: [], denyRead: [] } }),
    ]) {
      const { query, log } = fakeQuery(callsScript([]));
      const events = await collect(engineWith(query).start(harness(ws, { sandbox }).options));
      expect(events).toHaveLength(1);
      expect(done(events)?.reason).toBe("error");
      expect(log.queries).toBe(0);
    }
  });

  test("the env is scrubbed: workspace variables in, Rye's secrets out", async () => {
    const ws = workspace();
    const processEnv = {
      PATH: "/usr/bin",
      HOME,
      TMPDIR: "/var/tmp",
      ANTHROPIC_API_KEY: "sk-ant-test",
      MYSQL_PASSWORD: "hunter2",
      JIRA_API_TOKEN: "jira-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      RYE_DATA_DIR: "/data",
    };
    const { query, log } = fakeQuery(callsScript([]));
    const env = {
      PATH: `${ws.binDir}:/usr/bin`,
      HOME,
      TMPDIR: ws.tmpDir,
      BUN_INSTALL_CACHE_DIR: join(ws.cacheDir, "bun"),
      npm_config_cache: join(ws.cacheDir, "npm"),
      XDG_CACHE_HOME: ws.cacheDir,
      // A runner that copied these through by mistake: dropped.
      JIRA_API_TOKEN: "jira-secret",
      RYE_DATA_DIR: "/data",
    };
    await collect(engineWith(query, { processEnv }).start(harness(ws, { env }).options));
    const passed = log.options.env as Record<string, string>;
    expect(passed.PATH).toBe(`${ws.binDir}:/usr/bin`);
    expect(passed.TMPDIR).toBe(ws.tmpDir);
    expect(passed.BUN_INSTALL_CACHE_DIR).toBe(join(ws.cacheDir, "bun"));
    expect(passed.npm_config_cache).toBe(join(ws.cacheDir, "npm"));
    expect(passed.XDG_CACHE_HOME).toBe(ws.cacheDir);
    expect(passed.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(passed.CLAUDE_AGENT_SDK_CLIENT_APP).toBeDefined();
    for (const secret of ["MYSQL_PASSWORD", "JIRA_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "RYE_DATA_DIR"]) expect(passed[secret]).toBeUndefined();
    expect(Object.values(passed)).not.toContain("hunter2");
  });

  test("claudeCodeEnv keeps a workspace value even when Rye's own env has the same name", () => {
    const env = claudeCodeEnv({ GOCACHE: "/ws/cache/go", SECRET: "s" }, { GOCACHE: "/Users/me/go", SECRET: "s", PATH: "/bin" });
    expect(env.GOCACHE).toBe("/ws/cache/go");
    expect(env.SECRET).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("claude code engine: events", () => {
  test("a scripted SDK stream maps to CodeEvents", async () => {
    const ws = workspace();
    const { query } = fakeQuery(async function* (f) {
      yield init("2.1.331", "sess-42");
      const first = await f.next();
      yield* textReply("msg_1", "Looking at search.ts.");
      yield* toolCall("msg_2", "toolu_1", "Bash", { command: "bun test" });
      await f.useTool("Bash", { command: "bun test" }, "toolu_1");
      yield toolResult("toolu_1", "41 pass");
      yield { type: "tool_progress", tool_use_id: "toolu_1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 1 };
      yield* textReply("msg_3", "Fixed.");
      yield result({ total: 0.12, uuids: [first?.uuid] });
    });
    const events = await collect(engineWith(query).start(harness(ws).options));
    expect(events).toEqual([
      { type: "engine_session", id: "sess-42", version: "2.1.331" },
      { type: "text", delta: "Looking at search.ts." },
      { type: "tool_start", id: "toolu_1", name: "Bash", args: { command: "bun test" } },
      { type: "tool_result", id: "toolu_1", content: "41 pass", isError: false },
      { type: "text", delta: "Fixed." },
      { type: "usage", inputTokens: 1000, outputTokens: 50, costUsd: 0.12, totalCostUsd: 0.12 },
      { type: "done", reason: "end" },
    ]);
  });

  test("assistant messages carry the content when nothing was streamed", async () => {
    const ws = workspace();
    const { query } = fakeQuery(async function* (f) {
      yield init();
      const first = await f.next();
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Hi." }, { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [] } }] } };
      yield result({ uuids: [first?.uuid] });
    });
    const events = await collect(engineWith(query).start(harness(ws).options));
    expect(events.slice(1, 3)).toEqual([
      { type: "text", delta: "Hi." },
      { type: "tool_start", id: "t1", name: "TodoWrite", args: { todos: [] } },
    ]);
  });

  test("a Claude Code version outside the tested range is reported on engine_session", async () => {
    const ws = workspace();
    const warnings: string[] = [];
    const { query } = fakeQuery(async function* (f) {
      yield init("2.0.10");
      const first = await f.next();
      yield result({ uuids: [first?.uuid] });
    });
    const events = await collect(engineWith(query, { onWarning: (w) => warnings.push(w) }).start(harness(ws).options));
    const session = events[0] as Extract<CodeEvent, { type: "engine_session" }>;
    expect(session.version).toBe("2.0.10");
    expect(session.warning).toContain("older than 2.1.259");
    expect(warnings).toHaveLength(1);
    expect(claudeCodeVersionProblem("2.1.331")).toBeUndefined();
    expect(claudeCodeVersionProblem("2.2.0")).toContain("newer");
    expect(claudeCodeVersionProblem(undefined)).toBeDefined();
  });

  test("an API error ends the run with done error and the error's text", async () => {
    const ws = workspace();
    const { query } = fakeQuery(async function* (f) {
      yield init();
      await f.next();
      yield { type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: { id: "e", content: [{ type: "text", text: "Not logged in · Please run /login" }] } };
      yield result({ isError: true, text: "Not logged in" });
    });
    const d = done(await collect(engineWith(query).start(harness(ws).options)));
    expect(d).toEqual({ type: "done", reason: "error", error: "Claude: Not logged in · Please run /login" });
  });

  test("Claude Code exiting before a result is an error", async () => {
    const ws = workspace();
    const { query } = fakeQuery(async function* (f) {
      yield init();
      await f.next();
    });
    const d = done(await collect(engineWith(query).start(harness(ws).options)));
    expect(d?.reason).toBe("error");
    expect(d?.error).toContain("exited before finishing");
  });
});

// ---------------------------------------------------------------------------
// Hooks and approvals
// ---------------------------------------------------------------------------

describe("claude code engine: hooks and approvals", () => {
  test("a denied Bash command is refused with the policy's reason and never runs", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(callsScript([{ name: "Bash", input: { command: "git push origin main" } }]));
    const h = harness(ws);
    const events = await collect(engineWith(query).start(h.options));
    expect(log.executed).toEqual([]);
    expect(log.denials).toEqual([{ name: "Bash", by: "hook", message: "git push is never allowed in a code session" }]);
    expect(h.approvals).toEqual([]);
    expect(events).toContainEqual({ type: "tool_result", id: "toolu_0", content: "git push is never allowed in a code session", isError: true });
  });

  test("an ask goes to approve; allow once runs it with the hosts for that call only", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(callsScript([{ name: "Bash", input: { command: "bun install" } }]));
    const h = harness(ws, {}, [{ behavior: "allow", scope: "once" }]);
    await collect(engineWith(query).start(h.options));

    expect(h.approvals).toHaveLength(1);
    const { id, ...request } = h.approvals[0];
    expect(id).toBeTruthy();
    expect(request).toEqual({
      kind: "command",
      category: "install",
      reason: "installs packages from registry.npmjs.org",
      command: "bun install",
      argv: ["bun", "install"],
      cwd: "",
      hosts: ["registry.npmjs.org"],
      pattern: "bun install *",
      sessionId: "cs_test",
      toolName: "Bash",
      toolUseId: "toolu_0",
    });
    expect(log.executed.map((e) => e.input.command)).toEqual(["bun install"]);
    // The host is allowed while the call runs, then taken away again; the rest of the sandbox stays as planned.
    expect(log.flagSettings).toHaveLength(2);
    expect(log.flagSettings[0].sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(log.flagSettings[0].sandbox.filesystem.allowWrite).toEqual([ws.repoDir, ws.tmpDir, ws.cacheDir]);
    expect(log.flagSettings[0].sandbox.failIfUnavailable).toBe(true);
    expect(log.flagSettings[1].sandbox.network.allowedDomains).toEqual([]);
  });

  test("a deny from the user is honoured and its message reaches the agent", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(callsScript([{ name: "Bash", input: { command: "bun install left-pad" } }]));
    const h = harness(ws, {}, [{ behavior: "deny", reason: "user", message: "Not now." }]);
    const events = await collect(engineWith(query).start(h.options));
    expect(h.approvals).toHaveLength(1);
    expect(log.executed).toEqual([]);
    expect(log.denials).toEqual([{ name: "Bash", by: "canUseTool", message: "Not now." }]);
    expect(events).toContainEqual({ type: "tool_result", id: "toolu_0", content: "Not now.", isError: true });
  });

  test("allow for the session adds the pattern to the policy, so the next call doesn't ask", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(
      callsScript([
        { name: "Bash", input: { command: "bun install" } },
        { name: "Bash", input: { command: "bun install zod" } },
      ]),
    );
    const h = harness(ws, {}, [{ behavior: "allow", scope: "session", pattern: "bun install *" }]);
    await collect(engineWith(query).start(h.options));
    expect(h.approvals).toHaveLength(1);
    expect(h.policyLog.sessionPatterns).toEqual(["bun install *"]);
    expect(log.executed.map((e) => e.input.command)).toEqual(["bun install", "bun install zod"]);
    // Session hosts stay allowed for the rest of the run.
    expect(log.flagSettings.at(-1).sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  });

  test("background commands and sandbox opt-outs are caught even when the policy allows the command", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(
      callsScript([
        { name: "Bash", input: { command: "bun run dev", run_in_background: true } },
        { name: "Bash", input: { command: "ls", dangerouslyDisableSandbox: true } },
      ]),
    );
    const h = harness(ws, {}, [{ behavior: "deny", reason: "user", message: "no servers" }]);
    await collect(engineWith(query).start(h.options));
    expect(h.approvals.map((a) => (a.kind === "command" ? [a.category, a.pattern] : []))).toEqual([["long_running", undefined]]);
    expect(log.executed).toEqual([]);
    expect(log.denials[1]).toMatchObject({ by: "hook" });
    expect(log.denials[1].message).toContain("outside the sandbox");
  });

  test("file tools with paths escaping the workspace are denied; reads outside ask", async () => {
    const ws = workspace();
    const src = join(ws.repoDir, "src");
    const { query, log } = fakeQuery(
      callsScript([
        { name: "Write", input: { file_path: "../outside.txt", content: "x" } },
        { name: "Read", input: { file_path: "~/.ssh/id_rsa" } },
        { name: "Edit", input: { file_path: "/etc/hosts", old_string: "a", new_string: "b" } },
        { name: "NotebookEdit", input: { notebook_path: "../../n.ipynb", new_source: "" } },
        { name: "Glob", input: { pattern: "../../**/*.pem" } },
        { name: "Grep", input: { pattern: "secret", path: "/etc" } },
        { name: "Read", input: { file_path: "~root/.profile" } },
        { name: "Edit", input: { file_path: "search.ts", old_string: "a", new_string: "b" }, cwd: src },
        { name: "Glob", input: { pattern: "src/**/*.ts" } },
      ]),
    );
    const h = harness(ws, {}, [
      { behavior: "deny", reason: "user", message: "no" },
      { behavior: "deny", reason: "user", message: "no" },
    ]);
    await collect(engineWith(query).start(h.options));

    expect(log.executed.map((e) => e.name)).toEqual(["Edit", "Glob"]);
    expect(log.executed[0].input.file_path).toBe("search.ts");
    expect(log.denials.map((d) => [d.name, d.by])).toEqual([
      ["Write", "hook"],
      ["Read", "hook"],
      ["Edit", "hook"],
      ["NotebookEdit", "hook"],
      ["Glob", "canUseTool"],
      ["Grep", "canUseTool"],
      ["Read", "hook"],
    ]);
    // Paths reach the policy absolute, with ~ expanded and relative ones resolved against the call's cwd.
    const paths = h.policyLog.paths;
    expect(paths).toContainEqual([resolve(ws.repoDir, "../outside.txt"), "write"]);
    expect(paths).toContainEqual([`${HOME}/.ssh/id_rsa`, "read"]);
    expect(paths).toContainEqual([resolve(ws.repoDir, "../.."), "read"]);
    expect(paths).toContainEqual([join(src, "search.ts"), "write"]);
    expect(h.approvals.map((a) => (a.kind === "path" ? [a.path, a.op] : a.kind))).toEqual([
      [resolve(ws.repoDir, "../.."), "read"],
      ["/etc", "read"],
    ]);
  });

  test("canUseTool judges whatever falls through to it with the same rules", async () => {
    const ws = workspace();
    const outcomes: Record<string, any> = {};
    const { query } = fakeQuery(async function* (f) {
      yield init();
      const first = await f.next();
      const ask = (name: string, input: Record<string, unknown>, id: string) =>
        f.options.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: id });
      outcomes.push = await ask("Bash", { command: "git push --force" }, "a");
      outcomes.curl = await ask("Bash", { command: "curl https://example.org" }, "b");
      outcomes.test = await ask("Bash", { command: "bun test" }, "c");
      outcomes.agent = await ask("Agent", { prompt: "go" }, "d");
      outcomes.otherMcp = await ask("mcp__github__create_pr", {}, "e");
      outcomes.todo = await ask("TodoWrite", { todos: [] }, "f");
      outcomes.fetchAllowed = await ask("WebFetch", { url: "https://docs.example.com/x", prompt: "?" }, "g");
      outcomes.fetchOther = await ask("WebFetch", { url: "https://evil.example.net/x", prompt: "?" }, "h");
      outcomes.fetchFile = await ask("WebFetch", { url: "file:///etc/passwd", prompt: "?" }, "i");
      // WebFetch runs outside the sandbox: Rye's own API on localhost must never be fetched.
      outcomes.fetchLocal = await ask("WebFetch", { url: "http://127.0.0.1:7337/code/engines", prompt: "?" }, "i2");
      outcomes.read = await ask("Read", {}, "j");
      yield result({ uuids: [first?.uuid] });
    });
    const h = harness(ws, {}, [{ behavior: "allow", scope: "once" }, { behavior: "deny", reason: "timeout", message: "No answer in 30 minutes." }]);
    h.options.policy = stubPolicy(ws, h.policyLog, [], ["*.example.com"]);
    await collect(engineWith(query).start(h.options));

    expect(outcomes.push).toEqual({ behavior: "deny", message: "git push is never allowed in a code session" });
    expect(outcomes.curl).toEqual({ behavior: "allow", updatedInput: { command: "curl https://example.org" } });
    expect(outcomes.test).toEqual({ behavior: "allow", updatedInput: { command: "bun test" } });
    expect(outcomes.agent.behavior).toBe("deny");
    expect(outcomes.otherMcp.behavior).toBe("deny");
    expect(outcomes.todo.behavior).toBe("allow");
    expect(outcomes.fetchAllowed.behavior).toBe("allow");
    expect(outcomes.fetchOther).toEqual({ behavior: "deny", message: "No answer in 30 minutes." });
    expect(outcomes.fetchFile.behavior).toBe("deny");
    expect(outcomes.fetchLocal.behavior).toBe("deny");
    expect(outcomes.read).toEqual({ behavior: "deny", message: "Read needs file_path." });
    expect(h.approvals.map((a) => (a.kind === "command" ? [a.toolName, a.category, a.hosts] : a.kind))).toEqual([
      ["Bash", "network", ["example.org"]],
      ["WebFetch", "network", ["evil.example.net"]],
    ]);
  });

  test("AskUserQuestion becomes one question request per question, answered in updatedInput", async () => {
    const ws = workspace();
    const questions = [
      { question: "Which library?", header: "Lib", multiSelect: false, options: [{ label: "date-fns", description: "" }, { label: "dayjs", description: "" }] },
      { question: "Which tests?", header: "Tests", multiSelect: true, options: [{ label: "unit", description: "" }, { label: "e2e", description: "" }] },
    ];
    const { query, log } = fakeQuery(callsScript([{ name: "AskUserQuestion", input: { questions } }]));
    const h = harness(ws, {}, [
      { behavior: "answer", answer: "dayjs" },
      { behavior: "answer", answer: ["unit", "e2e"] },
    ]);
    await collect(engineWith(query).start(h.options));
    expect(h.approvals.map((a) => (a.kind === "question" ? [a.question, a.options, a.multiSelect] : a.kind))).toEqual([
      ["Which library?", ["date-fns", "dayjs"], false],
      ["Which tests?", ["unit", "e2e"], true],
    ]);
    expect(log.executed[0].input.answers).toEqual({ "Which library?": "dayjs", "Which tests?": "unit, e2e" });
  });
});

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

describe("claude code engine: run control", () => {
  test("interrupt() stops the turn and ends with done interrupted", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(async function* (f) {
      yield init();
      await f.next();
      yield* textReply("m1", "Working…");
      await f.interrupted;
      yield result({ subtype: "error_during_execution", isError: true, errors: ["interrupted"] });
    });
    const run = engineWith(query).start(harness(ws).options);
    const events: CodeEvent[] = [];
    for await (const e of run) {
      events.push(e);
      if (e.type === "text") void run.interrupt();
    }
    expect(done(events)).toEqual({ type: "done", reason: "interrupted" });
    expect(log.interrupts).toBe(1);
    expect(log.closed).toBe(1);
  });

  test("interrupt() still ends the run when Claude Code doesn't answer it", async () => {
    const ws = workspace();
    const { query } = fakeQuery(async function* (f) {
      yield init();
      await f.next();
      await new Promise(() => {});
    });
    const run = engineWith(query, { interruptGraceMs: 30 }).start(harness(ws).options);
    const events: CodeEvent[] = [];
    for await (const e of run) {
      events.push(e);
      if (e.type === "engine_session") void run.interrupt();
    }
    expect(done(events)?.reason).toBe("interrupted");
  });

  test("aborting the signal ends the run and aborts the SDK's controller", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(async function* (f) {
      yield init();
      await f.next();
      await new Promise((r) => f.options.abortController.signal.addEventListener("abort", r));
    });
    const h = harness(ws);
    const run = engineWith(query).start(h.options);
    const events: CodeEvent[] = [];
    for await (const e of run) {
      events.push(e);
      if (e.type === "engine_session") h.abort.abort();
    }
    expect(done(events)).toEqual({ type: "done", reason: "interrupted" });
    expect(log.options.abortController.signal.aborted).toBe(true);
    expect(log.closed).toBe(1);
  });

  test("an approval waiting when the run is stopped is denied", async () => {
    const ws = workspace();
    let outcome: any;
    const { query } = fakeQuery(async function* (f) {
      yield init();
      await f.next();
      outcome = await f.options.canUseTool("Bash", { command: "bun install" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    });
    const h = harness(ws);
    h.options.approve = (req) => {
      h.approvals.push(req);
      setTimeout(() => h.abort.abort(), 5);
      return new Promise<ApprovalDecision>(() => {});
    };
    await collect(engineWith(query).start(h.options));
    await Bun.sleep(10);
    expect(h.approvals).toHaveLength(1);
    expect(outcome).toEqual({ behavior: "deny", message: "The run was stopped." });
  });

  test("the SDK's turn and cost limits end the run with max_turns and which limit", async () => {
    const ws = workspace();
    for (const [subtype, limit] of [
      ["error_max_budget_usd", "max_cost_usd"],
      ["error_max_turns", "max_turns"],
    ] as const) {
      const { query } = fakeQuery(async function* (f) {
        yield init();
        await f.next();
        yield result({ subtype, isError: true, total: 5.2 });
      });
      const d = done(await collect(engineWith(query).start(harness(ws).options)));
      expect(d).toMatchObject({ type: "done", reason: "max_turns", limit });
    }
  });

  test("a steered run stops at the cost limit instead of starting another turn", async () => {
    const ws = workspace();
    const { query } = fakeQuery(async function* (f) {
      yield init();
      const first = await f.next();
      yield* textReply("m1", "Started.");
      await f.next(); // the steer, queued for a turn of its own
      yield result({ total: 1.5, uuids: [first?.uuid], queued: 1 });
      yield* textReply("m2", "should not be reached");
    });
    const run = engineWith(query).start(harness(ws, { limits: { maxTurns: 50, maxCostUsd: 1 } }).options);
    const events: CodeEvent[] = [];
    for await (const e of run) {
      events.push(e);
      if (e.type === "text" && e.delta === "Started.") run.send("Also update the docs.");
    }
    expect(done(events)).toMatchObject({ reason: "max_turns", limit: "max_cost_usd" });
    expect(events.some((e) => e.type === "text" && e.delta === "should not be reached")).toBe(false);
  });

  test("send() steers the live turn; the run ends once every message is answered", async () => {
    const ws = workspace();
    const { query, log } = fakeQuery(async function* (f) {
      yield init();
      const first = await f.next();
      yield* textReply("m1", "On it.");
      const steer = await f.next();
      yield result({ uuids: [first?.uuid], queued: 1 });
      yield* textReply("m2", "Docs too.");
      yield result({ uuids: [steer?.uuid], queued: 0 });
    });
    const run = engineWith(query).start(harness(ws).options);
    const events: CodeEvent[] = [];
    for await (const e of run) {
      events.push(e);
      if (e.type === "text" && e.delta === "On it.") run.send("Update the docs as well.");
    }
    expect(log.prompts.map((p) => [p.text, p.priority])).toEqual([
      ["Fix the search lag.", undefined],
      ["Update the docs as well.", "next"],
    ]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual(["On it.", "Docs too."]);
    expect(done(events)).toEqual({ type: "done", reason: "end" });
    run.send("too late");
    expect(log.prompts).toHaveLength(2);
  });

  test("a resumed run reports only what it added to the session's cost", async () => {
    const ws = workspace();
    // Claude Code's total_cost_usd carries the earlier runs' cost on a resumed session.
    const totals = [0.5, 0.8, 0.8];
    const { query } = fakeQuery(async function* (f) {
      yield init("2.1.331", "sess-1");
      const first = await f.next();
      yield result({ total: totals.shift(), uuids: [first?.uuid] });
    });
    const usage = (events: CodeEvent[]) => events.find((e) => e.type === "usage") as Extract<CodeEvent, { type: "usage" }>;
    const engine = engineWith(query);

    const one = usage(await collect(engine.start(harness(ws).options)));
    expect([one.costUsd, one.totalCostUsd]).toEqual([0.5, 0.5]);

    const two = usage(await collect(engine.start(harness(ws, { resume: "sess-1" }).options)));
    expect(two.costUsd).toBeCloseTo(0.3, 10);
    expect(two.totalCostUsd).toBe(0.8);

    // After a restart (a new engine) the earlier total is unknown: only the running total is reported.
    const three = usage(await collect(engineWith(query).start(harness(ws, { resume: "sess-1" }).options)));
    expect(three.costUsd).toBeUndefined();
    expect(three.totalCostUsd).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Rye tools
// ---------------------------------------------------------------------------

describe("claude code engine: Rye tools", () => {
  test("bridged Rye tools are listed over MCP and run through runRyeTool", async () => {
    const ws = workspace();
    const searchTool = { name: "search_knowledge_tool", description: "Search the knowledge base", parameters: Type.Object({ query: Type.String() }) };
    let listed: string[] = [];
    const { query, log } = fakeQuery(async function* (f) {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await f.options.mcpServers.rye.instance.connect(serverSide);
      const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
      await client.connect(clientSide);
      listed = (await client.listTools()).tools.map((t) => t.name);
      yield init();
      const first = await f.next();
      const name = "mcp__rye__search_knowledge_tool";
      yield* toolCall("m1", "toolu_r", name, { query: "search lag" });
      const allowed = await f.useTool(name, { query: "search lag" }, "toolu_r");
      expect(allowed.allowed).toBe(true);
      const res = await client.callTool({ name: "search_knowledge_tool", arguments: { query: "search lag" }, _meta: { "claudecode/toolUseId": "toolu_r" } });
      const unknown = await client.callTool({ name: "sql_query_tool", arguments: {} });
      expect(unknown.isError).toBe(true);
      yield toolResult("toolu_r", (res.content as Array<{ text: string }>)[0].text, res.isError === true);
      yield result({ uuids: [first?.uuid] });
    });
    const h = harness(ws, { ryeTools: [searchTool] });
    const events = await collect(engineWith(query).start(h.options));

    expect(log.options.mcpServers.rye.type).toBe("sdk");
    expect(listed).toEqual(["search_knowledge_tool"]);
    expect(h.ryeCalls.map((c) => c.call)).toEqual([{ id: "toolu_r", name: "search_knowledge_tool", args: { query: "search lag" } }]);
    expect(h.ryeCalls[0].signal).toBeInstanceOf(AbortSignal);
    expect(events).toContainEqual({ type: "tool_start", id: "toolu_r", name: "search_knowledge_tool", args: { query: "search lag" } });
    expect(events).toContainEqual({ type: "tool_result", id: "toolu_r", content: "found 2 notes for search lag", isError: false });
  });
});

// ---------------------------------------------------------------------------
// Availability and the registry
// ---------------------------------------------------------------------------

describe("claude code engine: availability", () => {
  const sandboxOk = async () => ({ available: true, mechanism: "seatbelt" as const });

  test("available with an API key, without starting Claude Code", async () => {
    const engine = claudeCodeEngine({ query: () => { throw new Error("must not start Claude Code"); }, sdkInstalled: () => true, sandboxProbe: sandboxOk, processEnv: { ANTHROPIC_API_KEY: "sk" }, home: "/nonexistent" });
    expect(await engine.availability()).toEqual({ available: true, account: "ANTHROPIC_API_KEY" });
    expect(engine.capabilities).toEqual({ resume: true, liveApprovals: true, ownSandbox: true });
    expect(await engine.models()).toEqual(["sonnet", "opus", "haiku"]);
  });

  test("a saved login is found in Claude Code's config; none means not signed in", async () => {
    const home = mkdtempSync(join(tmpdir(), "rye-claude-home-"));
    roots.push(home);
    const engine = (processEnv: Record<string, string>) => claudeCodeEngine({ sdkInstalled: () => true, sandboxProbe: sandboxOk, processEnv, home });
    const out = await engine({}).availability();
    expect(out.available).toBe(false);
    expect(out.reason).toContain("isn't signed in");

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
    expect(await engine({}).availability()).toEqual({ available: true, account: "me@example.com" });

    const configDir = join(home, "alt");
    mkdirSync(configDir);
    writeFileSync(join(configDir, ".credentials.json"), "{}");
    expect(claudeAuthSource({ CLAUDE_CONFIG_DIR: configDir }, home)).toBe("Claude account");
    expect(claudeAuthSource({ CLAUDE_CODE_USE_BEDROCK: "1" }, "/nonexistent")).toBe("Amazon Bedrock");
    expect(claudeAuthSource({ CLAUDE_CODE_USE_BEDROCK: "0" }, "/nonexistent")).toBeUndefined();
  });

  test("no sandbox or no SDK means unavailable, with the reason", async () => {
    const env = { ANTHROPIC_API_KEY: "sk" };
    const noSandbox = claudeCodeEngine({ sdkInstalled: () => true, sandboxProbe: async () => ({ available: false, mechanism: null, reason: "bubblewrap is not installed" }), processEnv: env });
    expect(await noSandbox.availability()).toEqual({ available: false, reason: "The sandbox can't run here: bubblewrap is not installed." });
    const noSdk = claudeCodeEngine({ sdkInstalled: () => false, sandboxProbe: sandboxOk, processEnv: env });
    expect((await noSdk.availability()).available).toBe(false);
    expect(platformSandboxStatus("win32")).toEqual({ available: false, mechanism: null, reason: "native Windows is not supported" });
    expect(platformSandboxStatus("linux", { PATH: "" }).reason).toBe("bubblewrap is not installed");
  });

  test("hostAllowed matches exact hosts and *. wildcards", () => {
    expect(hostAllowed("docs.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("evilexample.com", ["*.example.com", "example.com"])).toBe(false);
  });
});

describe("code engine registry", () => {
  const fakeEngine = (id: string, availability: () => Promise<{ available: boolean; reason?: string }>): CodeEngine => ({
    id: id as CodeEngine["id"],
    capabilities: { resume: false, liveApprovals: true, ownSandbox: false },
    models: async () => ["m1"],
    availability,
    start: () => {
      throw new Error("not started in tests");
    },
  });

  test("the default registry has the claude engine", () => {
    const engine = getEngine("claude");
    expect(engine?.id).toBe("claude");
    expect(engine?.capabilities.ownSandbox).toBe(true);
    expect(getEngine("acp:nothing")).toBeUndefined();
  });

  test("lists availability and models, never throwing", async () => {
    const registry = new CodeEngineRegistry([
      fakeEngine("pi", async () => ({ available: true })),
      fakeEngine("acp:copilot", async () => {
        throw new Error("copilot not found on PATH");
      }),
    ]);
    const res = await registry.describe("pi", { pi: "qwen3" });
    expect(res).toEqual({
      defaultEngine: "pi",
      engines: [
        { id: "pi", title: "Rye", capabilities: { resume: false, liveApprovals: true, ownSandbox: false }, availability: { available: true }, models: ["m1"], defaultModel: "qwen3" },
        { id: "acp:copilot", title: "GitHub Copilot", capabilities: { resume: false, liveApprovals: true, ownSandbox: false }, availability: { available: false, reason: "copilot not found on PATH" }, models: [] },
      ],
    });
    expect(() => registry.require("claude")).toThrow("Unknown code engine");
  });
});
