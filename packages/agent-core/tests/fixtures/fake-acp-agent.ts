/**
 * A fake Agent Client Protocol agent for tests/code-engine-acp.test.ts: JSON-RPC 2.0 over stdio,
 * one message per line, scripted by `FAKE_ACP_SCENARIO` (and `FAKE_ACP_ARGS`, a JSON value).
 * It starts nothing and touches no files except where a scenario asks Rye to (through fs/*).
 *
 * Scenarios (what `session/prompt` does):
 * - `basic`     message chunks, one shell tool call with streamed output, usage, end_turn
 * - `echo`      "got: <prompt text> pid=<pid>", after `FAKE_ACP_ARGS.delayMs` if set
 * - `perms`     for each command in FAKE_ACP_ARGS: a tool call and session/request_permission;
 *               reports "<command> => <outcome>" per line
 * - `calls`     like perms, with whole tool calls (FAKE_ACP_ARGS: ToolCall objects)
 * - `fs`        fs/write_text_file and fs/read_text_file for each FAKE_ACP_ARGS entry; reports results
 * - `terminal`  calls terminal/create; reports the error code it got
 * - `hang`      answers only after session/cancel, with stopReason "cancelled"
 * - `silent`    never answers, and ignores session/cancel
 * - `crash`     writes "boom" to stderr and exits 3
 * - `noinit`    never answers initialize
 * - `toolflood` FAKE_ACP_ARGS.count tool calls, then waits for cancel
 */

const scenario = process.env.FAKE_ACP_SCENARIO ?? "basic";
const args: unknown = process.env.FAKE_ACP_ARGS ? JSON.parse(process.env.FAKE_ACP_ARGS) : undefined;

let nextId = 1000;
const waiting = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string } }) => void>();
let cancelWaiter: (() => void) | null = null;
const sessions = new Set<string>(["s-old"]);

function send(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

function update(sessionId: string, u: Record<string, unknown>) {
  send({ method: "session/update", params: { sessionId, update: u } });
}

function call(method: string, params: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((r) => waiting.set(id, r));
}

const say = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (prompt: Array<{ type: string; text?: string }>) => prompt.filter((b) => b.type === "text").map((b) => b.text).join("");

const PERMISSION_OPTIONS = [
  { optionId: "yes-once", name: "Allow once", kind: "allow_once" },
  { optionId: "yes-always", name: "Always allow", kind: "allow_always" },
  { optionId: "no-once", name: "Reject", kind: "reject_once" },
];

async function prompt(id: number, p: { sessionId: string; prompt: Array<{ type: string; text?: string }> }) {
  const sid = p.sessionId;
  const done = (stopReason: string, extra: Record<string, unknown> = {}) => send({ id, result: { stopReason, ...extra } });
  switch (scenario) {
    case "basic": {
      say(sid, "Hello ");
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      say(sid, "world");
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "file1\n" } }] });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file1\nfile2\n" } }] });
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit a.ts", kind: "edit", status: "failed", locations: [{ path: "/repo/a.ts" }], rawOutput: { message: "no such file" } });
      update(sid, { sessionUpdate: "plan", entries: [{ content: "step", priority: "high", status: "pending" }] });
      return done("end_turn", { usage: { inputTokens: 10, cachedReadTokens: 2, outputTokens: 5, totalTokens: 17 } });
    }
    case "echo": {
      const delay = (args as { delayMs?: number } | undefined)?.delayMs;
      if (delay) await sleep(delay);
      say(sid, `got: ${textOf(p.prompt)} pid=${process.pid}`);
      return done("end_turn");
    }
    case "perms":
    case "calls": {
      const calls = (args as unknown[]).map((c, i) =>
        typeof c === "string" ? { toolCallId: `p${i}`, title: `Run ${c}`, kind: "execute", status: "pending", rawInput: { command: c } } : (c as Record<string, unknown>),
      );
      const lines: string[] = [];
      for (const tc of calls) {
        update(sid, { sessionUpdate: "tool_call", ...tc });
        const r = await call("session/request_permission", { sessionId: sid, toolCall: tc, options: PERMISSION_OPTIONS });
        const outcome = r.result as { outcome?: { outcome?: string; optionId?: string } } | undefined;
        const label = outcome?.outcome?.outcome === "selected" ? outcome.outcome.optionId : outcome?.outcome?.outcome ?? `error ${r.error?.code}`;
        lines.push(`${String((tc.rawInput as { command?: string } | undefined)?.command ?? tc.toolCallId)} => ${label}`);
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: tc.toolCallId, status: label === "yes-once" ? "completed" : "failed" });
      }
      say(sid, lines.join("\n"));
      return done("end_turn");
    }
    case "fs": {
      const lines: string[] = [];
      for (const entry of args as Array<{ write?: string; read?: string; content?: string }>) {
        if (entry.write) {
          const r = await call("fs/write_text_file", { sessionId: sid, path: entry.write, content: entry.content ?? "x" });
          lines.push(`write ${entry.write} => ${r.error ? `error ${r.error.message}` : "ok"}`);
        }
        if (entry.read) {
          const r = await call("fs/read_text_file", { sessionId: sid, path: entry.read, line: 2, limit: 1 });
          lines.push(`read ${entry.read} => ${r.error ? `error ${r.error.message}` : JSON.stringify((r.result as { content: string }).content)}`);
        }
      }
      say(sid, lines.join("\n"));
      return done("end_turn");
    }
    case "terminal": {
      const r = await call("terminal/create", { sessionId: sid, command: "ls" });
      say(sid, `terminal => ${r.error ? r.error.code : "ok"}`);
      return done("end_turn");
    }
    case "hang":
      update(sid, { sessionUpdate: "tool_call", toolCallId: "h1", title: "Run sleep", kind: "execute", status: "in_progress", rawInput: { command: "sleep 100" } });
      await new Promise<void>((r) => (cancelWaiter = r));
      return done("cancelled");
    case "toolflood": {
      const count = (args as { count: number }).count;
      for (let i = 0; i < count; i++) update(sid, { sessionUpdate: "tool_call", toolCallId: `f${i}`, title: "Read", kind: "read", status: "completed" });
      await new Promise<void>((r) => (cancelWaiter = r));
      return done("cancelled");
    }
    case "silent":
      return;
    case "crash":
      process.stderr.write("boom\n");
      process.exit(3);
  }
}

async function handle(msg: { id?: number; method?: string; params?: any; result?: unknown; error?: any }) {
  if (msg.method === undefined && typeof msg.id === "number") {
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      if (scenario === "noinit") return;
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
          authMethods: [],
          agentInfo: { name: "fake-acp", version: "9.9.9" },
        },
      });
    case "session/new": {
      const sid = `s-${process.pid}-${sessions.size}`;
      sessions.add(sid);
      return send({ id, result: { sessionId: sid } });
    }
    case "session/load":
      if (!sessions.has(params.sessionId) && params.sessionId !== "s-stored") return send({ id, error: { code: -32002, message: "Session not found" } });
      // History replays before the answer (and must not show up as this turn's events).
      say(params.sessionId, "OLD HISTORY");
      sessions.add(params.sessionId);
      return send({ id, result: {} });
    case "session/prompt":
      return prompt(id!, params);
    case "session/cancel":
      if (scenario === "silent") return;
      cancelWaiter?.();
      cancelWaiter = null;
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
