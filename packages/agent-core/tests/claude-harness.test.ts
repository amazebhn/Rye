import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeContext, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getSettings, type Settings } from "../src/config.js";
import { CLAUDE_WEB_TOOLS, buildOpeningPrompt, claudeAgentSdkApi, closeClaudeSessions, isHarnessToolEvent } from "../src/harness/claude-sdk.js";
import { providerForModel, resolveModel, usesClaudeHarness } from "../src/llm-provider.js";
import { resolveTierModelId } from "../src/model-tiers.js";

const MODEL = { id: "sonnet", name: "Claude", api: "claude-agent-sdk", provider: "claude" } as unknown as Model<Api>;

const weatherTool = {
  name: "get_weather",
  description: "Weather for a city",
  parameters: Type.Object({ city: Type.String() }),
};
const timeTool = { name: "get_time", description: "Current time", parameters: Type.Object({}) };

interface FakeLog {
  queries: number;
  closed: number;
  /** Text of each user message the fake Claude Code received. */
  prompts: string[];
  systemPrompts: Array<string | undefined>;
  /** Tool names listed at the start of each model turn. */
  toolLists: string[][];
  /** Built-in tools each query was started with. */
  builtinTools: string[][];
  /** Text blocks of each tool result the fake Claude Code received. */
  toolResults: string[][];
}

const newLog = (): FakeLog => ({ queries: 0, closed: 0, prompts: [], systemPrompts: [], toolLists: [], builtinTools: [], toolResults: [] });

function* textTurn(id: string, text: string) {
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } };
  yield { type: "result", subtype: "success", is_error: false, result: text };
}

function* toolTurn(id: string, toolUseId: string, name: string, args: object) {
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id, usage: { input_tokens: 20 } } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: `mcp__rye__${name}` } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
  yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } };
}

/**
 * Stands in for the SDK's query(): a scripted Claude Code that calls Rye's MCP
 * server the way the real one does. "weather" in a prompt triggers a tool call.
 */
function fakeQuery(log: FakeLog, opts: { failWith?: string } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ({ prompt, options }: any) => {
    log.queries++;
    log.systemPrompts.push(options.systemPrompt);
    log.builtinTools.push(options.tools);
    const input = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await options.mcpServers.rye.instance.connect(serverSide);
      const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
      await client.connect(clientSide);
      const listTools = async () => (await client.listTools()).tools.map((t) => t.name);
      // Claude Code re-reads the list when told it changed.
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void client.listTools());
      let turn = 0;
      while (true) {
        const next = await input.next();
        if (next.done) return;
        const text = next.value.message.content.map((b: { text?: string }) => b.text ?? "").join("\n");
        log.prompts.push(text);
        log.toolLists.push(await listTools());
        turn++;
        if (opts.failWith) {
          yield { type: "result", subtype: "success", is_error: true, result: opts.failWith };
          continue;
        }
        if (text.includes("search")) {
          // A built-in tool call: Claude Code runs it itself, then the model answers in a second response.
          const events = [...toolTurn(`msg_${turn}a`, `toolu_${turn}`, "x", { query: "rye docs" })] as Array<{ event: { content_block?: { name: string } } }>;
          events[1].event.content_block!.name = "WebSearch";
          yield* events;
          // Claude Code reports the result of a tool it ran as a user message.
          yield {
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${turn}`, content: [{ type: "text", text: "1. Rye docs" }] }] },
          };
          yield* textTurn(`msg_${turn}b`, "found it");
        } else if (text.includes("weather")) {
          const toolUseId = `toolu_${turn}`;
          yield* toolTurn(`msg_${turn}a`, toolUseId, "get_weather", { city: "Paris" });
          const res = await client.callTool({ name: "get_weather", arguments: { city: "Paris" }, _meta: { "claudecode/toolUseId": toolUseId } });
          log.toolLists.push(await listTools());
          log.toolResults.push((res.content as Array<{ text: string }>).map((b) => b.text));
          yield* textTurn(`msg_${turn}b`, `Paris: ${(res.content as Array<{ text: string }>)[0].text}`);
        } else {
          yield* textTurn(`msg_${turn}`, `reply ${turn}`);
        }
      }
    })();
    return Object.assign(gen, {
      close() {
        log.closed++;
        void gen.return(undefined);
      },
    });
  };
}

const textOf = (m: AssistantMessage) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

async function turn(api: ReturnType<typeof claudeAgentSdkApi>, context: Context, options: { sessionId?: string; signal?: AbortSignal } = {}) {
  const message = await api.stream(MODEL, normalizeContext(context), options).result();
  context.messages.push(message);
  return message;
}

afterEach(() => closeClaudeSessions());

describe("claude harness adapter", () => {
  test("a one-off call streams text and closes its session", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const context: Context = { systemPrompt: "Be terse.", messages: [{ role: "user", content: "hi", timestamp: 1 }] };

    const events: string[] = [];
    const stream = api.stream(MODEL, normalizeContext(context));
    for await (const ev of stream) events.push(ev.type);
    const message = await stream.result();

    expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(textOf(message)).toBe("reply 1");
    expect(message.stopReason).toBe("stop");
    expect(message.responseId).toBe("msg_1");
    // input is the whole prompt, cached tokens included.
    expect(message.usage).toMatchObject({ input: 100, cacheRead: 90, output: 7, totalTokens: 107 });
    expect(log.systemPrompts).toEqual(["Be terse."]);
    expect(log.closed).toBe(1);
  });

  test("tool calls go back to the caller and the result continues the same session", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const context: Context = {
      systemPrompt: "sys",
      tools: [weatherTool],
      messages: [{ role: "user", content: "weather in Paris?", timestamp: 1 }],
    };

    const first = await turn(api, context, { sessionId: "chat-1" });
    expect(first.stopReason).toBe("toolUse");
    const call = first.content.find((b) => b.type === "toolCall");
    expect(call).toMatchObject({ id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } });

    context.messages.push({
      role: "toolResult",
      toolCallId: "toolu_1",
      toolName: "get_weather",
      content: [{ type: "text", text: "sunny" }],
      isError: false,
      timestamp: 2,
    });
    const second = await turn(api, context, { sessionId: "chat-1" });
    expect(second.stopReason).toBe("stop");
    expect(textOf(second)).toBe("Paris: sunny");

    // A follow-up user message is pushed into the live session rather than starting a new one.
    context.messages.push({ role: "user", content: "thanks", timestamp: 3 });
    const third = await turn(api, context, { sessionId: "chat-1" });
    expect(textOf(third)).toBe("reply 2");
    expect(log.queries).toBe(1);
    expect(log.prompts).toEqual(["weather in Paris?", "thanks"]);
    expect(log.closed).toBe(0);
  });

  test("a user reply after a tool result (ask_user_tool) continues the session with the reply attached", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const context: Context = { systemPrompt: "v1", tools: [weatherTool], messages: [{ role: "user", content: "weather?", timestamp: 1 }] };
    await turn(api, context, { sessionId: "chat-ask" });

    // The loop stores a placeholder result, ends the run, and the answer arrives as the next user message.
    context.systemPrompt = "v2";
    context.messages.push(
      { role: "toolResult", toolCallId: "toolu_1", toolName: "get_weather", content: [{ type: "text", text: "[awaiting response]" }], isError: false, timestamp: 2 },
      { role: "user", content: "Paris, France", timestamp: 3 },
    );
    const reply = await turn(api, context, { sessionId: "chat-ask" });

    expect(log.queries).toBe(1);
    expect(textOf(reply)).toBe("Paris: [awaiting response]");
    expect(log.toolResults).toEqual([["[awaiting response]", "The user replied:", "Paris, France"]]);
  });

  test("tools added mid-run reach the model before its next turn", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const context: Context = { tools: [weatherTool], messages: [{ role: "user", content: "weather?", timestamp: 1 }] };

    await turn(api, context, { sessionId: "chat-2" });
    context.tools = [weatherTool, timeTool];
    context.messages.push({ role: "toolResult", toolCallId: "toolu_1", toolName: "get_weather", content: [{ type: "text", text: "rain" }], isError: false, timestamp: 2 });
    await turn(api, context, { sessionId: "chat-2" });

    expect(log.toolLists).toEqual([["get_weather"], ["get_weather", "get_time"]]);
  });

  test("history the SDK hasn't seen starts a new session from a text transcript", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const context: Context = {
      messages: [
        { role: "user", content: "what is 2+2?", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "4" }], responseId: "msg_from_before_restart", timestamp: 2 } as AssistantMessage,
        { role: "user", content: "and 3+3?", timestamp: 3 },
      ],
    };

    await turn(api, context, { sessionId: "chat-3" });
    expect(log.queries).toBe(1);
    expect(log.prompts[0]).toContain("<conversation_history>\nUser: what is 2+2?\n\nAssistant: 4\n</conversation_history>");
    expect(log.prompts[0]).toEndWith("and 3+3?");
  });

  test("a changed system prompt replaces the chat's session", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const context: Context = { systemPrompt: "v1", messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    await turn(api, context, { sessionId: "chat-4" });

    context.systemPrompt = "v2";
    context.messages.push({ role: "user", content: "again", timestamp: 2 });
    await turn(api, context, { sessionId: "chat-4" });

    expect(log.systemPrompts).toEqual(["v1", "v2"]);
    expect(log.closed).toBe(1);
    expect(log.prompts[1]).toContain("<conversation_history>");
  });

  test("a failed request ends the stream with the SDK's message", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log, { failWith: "Not logged in · Please run /login" }) });
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

    const message = await api.stream(MODEL, normalizeContext(context), { sessionId: "chat-5" }).result();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("Claude: Not logged in · Please run /login");
    expect(log.closed).toBe(1);
  });

  test("aborting while a tool call is outstanding closes the session", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log) });
    const controller = new AbortController();
    const context: Context = { tools: [weatherTool], messages: [{ role: "user", content: "weather?", timestamp: 1 }] };
    await turn(api, context, { sessionId: "chat-6", signal: controller.signal });

    // Cancelled while Rye would be running the tool: the session ends without another stream() call.
    controller.abort();
    expect(log.closed).toBe(1);
    const message = await api.stream(MODEL, normalizeContext(context), { sessionId: "chat-6", signal: controller.signal }).result();
    expect(message.stopReason).toBe("aborted");
  });

  test("built-in web tools are run by the SDK and stay out of the caller's tool calls", async () => {
    const log = newLog();
    const api = claudeAgentSdkApi({ query: fakeQuery(log), builtinTools: () => CLAUDE_WEB_TOOLS });
    const context: Context = { tools: [weatherTool], messages: [{ role: "user", content: "search the web", timestamp: 1 }] };

    // The call and its result are reported on the stream, in order, before the answer's text.
    const stream = api.stream(MODEL, normalizeContext(context), {});
    const seen: unknown[] = [];
    for await (const event of stream) {
      if (isHarnessToolEvent(event)) seen.push(event);
      else if (event.type === "text_delta") seen.push(event.delta);
    }
    expect(seen).toEqual([
      { type: "harness_tool_start", id: "toolu_1", name: "WebSearch", args: { query: "rye docs" } },
      { type: "harness_tool_result", id: "toolu_1", name: "WebSearch", content: "1. Rye docs", isError: false },
      "found it",
    ]);
    const message = await stream.result();
    expect(log.builtinTools).toEqual([["WebSearch", "WebFetch"]]);
    expect(message.stopReason).toBe("stop");
    expect(message.content.map((b) => b.type)).toEqual(["text"]);
    expect(textOf(message)).toBe("found it");
    // Output tokens add up across both model responses (5 + 7).
    expect(message.usage.output).toBe(12);
  });

  test("opening prompt with no history is just the user's message", () => {
    expect(buildOpeningPrompt([{ role: "user", content: "hello", timestamp: 1 }])).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("harness routing", () => {
  const base = getSettings();
  const claude: Settings = { ...base, harness: "claude", llm_provider: ["copilot", "ollama"] };
  const pi: Settings = { ...base, harness: "pi", llm_provider: ["copilot", "ollama"] };

  test("the claude harness takes Claude models ahead of llm_provider", async () => {
    expect(usesClaudeHarness(claude, "claude-sonnet-4.5")).toBe(true);
    expect(usesClaudeHarness(claude, "opus[1m]")).toBe(true);
    expect(usesClaudeHarness(claude, "gpt-4.1")).toBe(false);
    expect(usesClaudeHarness(pi, "claude-sonnet-4.5")).toBe(false);
    expect(await providerForModel(claude, "haiku")).toBe("claude");
    expect(await providerForModel(pi, "claude-sonnet-4.5")).toBe("copilot");

    const model = await resolveModel(claude, "sonnet");
    expect(model).toMatchObject({ provider: "claude", api: "claude-agent-sdk", contextWindow: claude.claude.context_window });
  });

  test("blank tiers resolve to Claude models under the claude harness", async () => {
    const blank: Settings = { ...claude, models: { ...claude.models, low: "", medium: "", high: "" } };
    expect(await resolveTierModelId(blank, "low")).toBe("haiku");
    expect(await resolveTierModelId(blank, "medium")).toBe(blank.claude.model);
    expect(await resolveTierModelId(blank, "high")).toBe("opus");
    expect(await resolveTierModelId({ ...blank, models: { ...blank.models, low: "llama3.2" } }, "low")).toBe("llama3.2");
  });
});
