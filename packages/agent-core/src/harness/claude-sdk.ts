/**
 * Claude harness — runs Claude through the Claude Agent SDK behind pi-ai's
 * stream contract, so the agent loop calls `models.stream()` as for any other
 * provider.
 *
 * The SDK owns its own agent loop, while pi-ai expects one model turn per
 * `stream()` call with tool calls handed back to the caller. The bridge:
 * Rye's tools are exposed to the SDK as an in-process MCP server whose handlers
 * wait for a result. When the model calls tools the pi stream ends with
 * `toolUse`; Rye runs them, and the next `stream()` call finds the live SDK
 * session (by the last assistant message's `responseId`), hands the results to
 * the waiting handlers, and streams the model's next turn.
 *
 * The SDK session holds the real transcript. When a call can't continue a live
 * session (new process, idle timeout, changed system prompt, edited history) a
 * new one starts from Rye's saved history rendered as text.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { query as sdkQuery, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type ProviderStreams,
  type StreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";

export const CLAUDE_SDK_API = "claude-agent-sdk";
/** Model aliases the SDK always accepts; the live list comes from claudeHarnessInfo(). */
export const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku"];

/** Claude Code's own web tools. The SDK runs these itself; they never pass through Rye's loop. */
export const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"];

const MCP_SERVER = "rye";
const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;
// Rye enforces its own tool timeouts and may wait on the user, so the SDK's limit only bounds leaks.
const SDK_TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 15 * 60 * 1000;
const TOOL_LIST_WAIT_MS = 3000;
const HISTORY_RESULT_CHARS = 4000;
const HISTORY_ARGS_CHARS = 500;
const HISTORY_MAX_CHARS = 300_000;

type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeSdkDeps {
  /** Replaces the SDK's query() in tests. */
  query?: QueryFn;
  /** Working directory for the Claude Code process. */
  cwd?: () => string;
  /** Claude Code built-in tools to enable alongside Rye's, e.g. CLAUDE_WEB_TOOLS. Default: none. */
  builtinTools?: () => string[];
}

// A type alias, not an interface, so it satisfies the MCP SDK's open-ended result type.
type ToolOutcome = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** User messages fed to a live SDK session. */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage) {
    this.queue.push(message);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

const toolSignature = (tools: Tool[]) => JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]));

class ClaudeSession {
  readonly input = new InputChannel();
  readonly query: Query;
  private readonly mcp: McpServer;
  private tools: Tool[];
  private toolSig: string;
  /** Tool calls handed to Rye that it hasn't answered yet. */
  readonly pending = new Map<string, { name: string; args: string }>();
  /** Built-in tool calls (tool_use id → tool name) Claude Code is running itself and hasn't reported a result for. */
  readonly builtinCalls = new Map<string, string>();
  /** Built-in tools this session was started with; they can't change while it runs. */
  readonly builtinSig: string;
  private readonly results = new Map<string, Deferred<ToolOutcome>>();
  private toolListWaiters: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail: string[] = [];
  lastResponseId: string | undefined;
  busy = false;
  closed = false;

  constructor(
    readonly modelId: string,
    readonly systemPrompt: string,
    tools: Tool[],
    /** Rye chat session; undefined for one-off calls, which close once the model stops. */
    readonly chatSessionId: string | undefined,
    queryFn: QueryFn,
    cwd: string | undefined,
    builtinTools: string[],
  ) {
    this.tools = tools;
    this.toolSig = toolSignature(tools);
    this.builtinSig = builtinTools.join(",");
    this.mcp = this.createMcpServer();
    this.query = queryFn({
      prompt: this.input,
      options: {
        // "default" leaves the choice to the SDK.
        ...(modelId && modelId !== "default" ? { model: modelId } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        // Rye's tools plus any enabled built-ins: no user/project settings, skills, hooks or MCP servers.
        tools: builtinTools,
        settingSources: [],
        strictMcpConfig: true,
        // Rye keeps its own history; don't add its chats to the user's Claude Code sessions.
        persistSession: false,
        includePartialMessages: true,
        mcpServers: { [MCP_SERVER]: { type: "sdk", name: MCP_SERVER, instance: this.mcp, timeout: SDK_TOOL_TIMEOUT_MS } },
        // Rye gates its own tools (approvals, ask_user), so everything on its server is allowed here.
        canUseTool: async (name, input) =>
          name.startsWith(TOOL_PREFIX) || builtinTools.includes(name)
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: `${name} is not available in Rye.` },
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "rye/0.1.0" },
        ...(cwd ? { cwd } : {}),
        stderr: (data) => {
          this.stderrTail.push(data.trim());
          if (this.stderrTail.length > 5) this.stderrTail.shift();
        },
      },
    });
    this.touch();
  }

  private createMcpServer(): McpServer {
    const mcp = new McpServer({ name: MCP_SERVER, version: "1.0.0" });
    mcp.server.registerCapabilities({ tools: { listChanged: true } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
      for (const wake of this.toolListWaiters.splice(0)) wake();
      return { tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" } })) };
    });
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const id = this.toolUseIdFor(req.params);
      if (!id) {
        return { content: [{ type: "text", text: `No matching call to ${req.params.name} is waiting.` }], isError: true };
      }
      const outcome = await this.result(id).promise;
      this.results.delete(id);
      return outcome;
    });
    return mcp;
  }

  /** The model's tool_use id for an MCP call: sent by Claude Code in _meta, else matched by name and arguments. */
  private toolUseIdFor(params: { name: string; arguments?: unknown; _meta?: Record<string, unknown> }): string | undefined {
    const fromMeta = params._meta?.["claudecode/toolUseId"];
    if (typeof fromMeta === "string") return fromMeta;
    const args = JSON.stringify(params.arguments ?? {});
    for (const [id, call] of this.pending) {
      if (call.name === params.name && call.args === args) return id;
    }
    return undefined;
  }

  private result(id: string): Deferred<ToolOutcome> {
    let entry = this.results.get(id);
    if (!entry) this.results.set(id, (entry = deferred<ToolOutcome>()));
    return entry;
  }

  expectResult(call: ToolCall) {
    this.pending.set(call.id, { name: call.name, args: JSON.stringify(call.arguments) });
  }

  deliverResult(id: string, outcome: ToolOutcome) {
    this.pending.delete(id);
    this.result(id).resolve(outcome);
  }

  /** Swap the tool list and wait for Claude Code to re-read it, so the next model turn sees it. */
  async syncTools(tools: Tool[]) {
    const sig = toolSignature(tools);
    if (sig === this.toolSig) return;
    this.tools = tools;
    this.toolSig = sig;
    const reread = new Promise<void>((resolve) => {
      this.toolListWaiters.push(resolve);
      setTimeout(resolve, TOOL_LIST_WAIT_MS);
    });
    try {
      await this.mcp.server.sendToolListChanged();
      await reread;
    } catch {
      // Not connected yet; the first tools/list picks up the new list.
    }
  }

  /** Restart the idle countdown. */
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), SESSION_IDLE_MS);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  errorDetail(): string {
    return this.stderrTail.filter(Boolean).join("\n");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    sessions.delete(this);
    this.input.end();
    // Release tool handlers still waiting, so the SDK can shut down cleanly.
    for (const entry of this.results.values()) {
      entry.resolve({ content: [{ type: "text", text: "The session ended before this tool finished." }], isError: true });
    }
    try {
      this.query.close();
    } catch {
      // Already gone.
    }
  }
}

const sessions = new Set<ClaudeSession>();

/** Close every live SDK session (and its Claude Code process). */
export function closeClaudeSessions(): void {
  for (const session of [...sessions]) session.close();
}

process.once("exit", closeClaudeSessions);

// ---------------------------------------------------------------------------
// pi-ai ⇄ SDK conversion
// ---------------------------------------------------------------------------

const contentText = (content: string | (TextContent | ImageContent)[]) =>
  typeof content === "string" ? content : content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("\n");

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [truncated]` : text);

type UserBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function userBlocks(content: UserMessage["content"]): UserBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } },
  );
}

function sdkUserMessage(blocks: UserBlock[]): SDKUserMessage {
  return { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null } as SDKUserMessage;
}

function resultContent(content: string | (TextContent | ImageContent)[]): ToolOutcome["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((b) =>
    b.type === "text" ? { type: "text" as const, text: b.text } : { type: "image" as const, data: b.data, mimeType: b.mimeType },
  );
}

function toolOutcome(message: ToolResultMessage): ToolOutcome {
  const content = resultContent(message.content);
  return { content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }], isError: message.isError };
}

/** Saved history as text, for a session that starts mid-conversation. */
function renderHistory(history: Message[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role === "user") {
      lines.push(`User: ${contentText(m.content)}`);
    } else if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("\n");
      if (text) lines.push(`Assistant: ${text}`);
      for (const b of m.content) {
        if (b.type === "toolCall") lines.push(`[Assistant called ${b.name} ${clip(JSON.stringify(b.arguments), HISTORY_ARGS_CHARS)}]`);
      }
    } else if (m.role === "toolResult") {
      lines.push(`[${m.toolName} ${m.isError ? "failed" : "returned"}]: ${clip(contentText(m.content), HISTORY_RESULT_CHARS)}`);
    }
  }
  const text = lines.join("\n\n");
  // Keep the most recent part when the history is very long.
  return text.length > HISTORY_MAX_CHARS ? `[earlier conversation omitted]\n\n${text.slice(-HISTORY_MAX_CHARS)}` : text;
}

/** First user message of a new SDK session: prior history as text, then the latest user message(s). */
export function buildOpeningPrompt(conversation: Message[]): UserBlock[] {
  let split = conversation.length;
  while (split > 0 && conversation[split - 1].role === "user") split--;
  const history = conversation.slice(0, split);
  const latest = conversation.slice(split).flatMap((m) => userBlocks((m as UserMessage).content));
  if (history.length === 0) return latest.length > 0 ? latest : [{ type: "text", text: "Continue." }];
  const preamble =
    "This conversation is being resumed. The earlier turns, with tool calls and their results shown as text:\n\n" +
    `<conversation_history>\n${renderHistory(history)}\n</conversation_history>`;
  return [
    { type: "text", text: preamble },
    ...(latest.length > 0 ? latest : [{ type: "text" as const, text: "Continue from where the conversation left off." }]),
  ];
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * `input` is the whole prompt (cached and uncached), since Rye reads it as
 * context-window use; cacheRead/cacheWrite say how much of that was cached.
 */
function applyUsage(usage: Usage, u: AnthropicUsage | undefined, outputBase: number) {
  if (!u) return;
  if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
  if (u.input_tokens != null) usage.input = u.input_tokens + usage.cacheRead + usage.cacheWrite;
  // One stream can span several model responses when the SDK runs a built-in tool between them.
  if (u.output_tokens != null) usage.output = outputBase + u.output_tokens;
  usage.totalTokens = usage.input + usage.output;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/** The live session this request continues, with its tool results delivered or user message queued. */
async function continueSession(
  conversation: Message[],
  modelId: string,
  systemPrompt: string,
  tools: Tool[],
  builtinSig: string,
): Promise<ClaudeSession | undefined> {
  let last = conversation.length - 1;
  while (last >= 0 && conversation[last].role !== "assistant") last--;
  if (last < 0) return undefined;
  const responseId = (conversation[last] as AssistantMessage).responseId;
  const session = responseId ? [...sessions].find((s) => s.lastResponseId === responseId) : undefined;
  if (!session) return undefined;

  const tail = conversation.slice(last + 1);
  const usable = !session.closed && !session.busy && session.modelId === modelId && session.builtinSig === builtinSig;
  if (usable && session.pending.size > 0) {
    // Mid tool loop: every call the model made must have its result. User messages may follow them
    // (the answer to ask_user_tool, or a new message after the tool-round limit).
    const firstUser = tail.findIndex((m) => m.role !== "toolResult");
    const results = (firstUser === -1 ? tail : tail.slice(0, firstUser)) as ToolResultMessage[];
    const replies = firstUser === -1 ? [] : tail.slice(firstUser);
    const answered = new Set(results.map((r) => r.toolCallId));
    if (replies.every((m) => m.role === "user") && [...session.pending.keys()].every((id) => answered.has(id))) {
      await session.syncTools(tools);
      const waiting = results.filter((r) => session.pending.has(r.toolCallId));
      waiting.forEach((r, i) => {
        const outcome = toolOutcome(r);
        // The SDK is waiting on tool results, so the user's reply travels with the last one.
        if (i === waiting.length - 1 && replies.length > 0) {
          outcome.content.push({ type: "text", text: "The user replied:" });
          for (const m of replies) outcome.content.push(...resultContent((m as UserMessage).content));
        }
        session.deliverResult(r.toolCallId, outcome);
      });
      return session;
    }
  } else if (usable && tail.length > 0 && tail.every((m) => m.role === "user") && session.systemPrompt === systemPrompt) {
    // The model had finished its turn and the user replied.
    await session.syncTools(tools);
    session.input.push(sdkUserMessage(tail.flatMap((m) => userBlocks((m as UserMessage).content))));
    return session;
  }
  session.close();
  return undefined;
}

/**
 * Claude Code runs its built-in tools (WebSearch, WebFetch) itself, so they never become pi tool
 * calls. These extra events ride on the pi stream, in order with the text around them, so the
 * agent loop can show them as tool steps. Anything that doesn't know them ignores them.
 */
export type HarnessToolEvent =
  | { type: "harness_tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "harness_tool_result"; id: string; name: string; content: string; isError: boolean };

export function isHarnessToolEvent(event: { type: string }): event is HarnessToolEvent {
  return event.type === "harness_tool_start" || event.type === "harness_tool_result";
}

/** Longest built-in tool result passed on for display; a fetched page can be far larger. */
const BUILTIN_RESULT_CHARS = 6000;

/** Text of a tool_result block's content, which is a string or a list of text/other blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { id?: string; usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
  usage?: AnthropicUsage;
}

async function run(
  deps: ClaudeSdkDeps,
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions | undefined,
  out: AssistantMessageEventStream,
) {
  const signal = options?.signal;
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const fail = (errorMessage: string, reason: "error" | "aborted" = "error") => {
    out.push({ type: "error", reason, error: { ...message, stopReason: reason, errorMessage } });
    out.end();
  };
  if (signal?.aborted) {
    for (const s of [...sessions]) if (options?.sessionId && s.chatSessionId === options.sessionId) s.close();
    return fail("Request was aborted", "aborted");
  }

  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages);
  const conversation = context.messages.filter((m) => m.role !== "system");

  const builtinTools = deps.builtinTools?.() ?? [];
  let session = await continueSession(conversation, model.id, systemPrompt, tools, builtinTools.join(","));
  if (!session) {
    // One live session per chat: a replaced one would only hold a stale transcript.
    if (options?.sessionId) {
      for (const s of [...sessions]) if (s.chatSessionId === options.sessionId) s.close();
    }
    let cwd: string | undefined;
    try {
      cwd = deps.cwd?.();
      if (cwd) mkdirSync(cwd, { recursive: true });
    } catch {
      cwd = undefined;
    }
    session = new ClaudeSession(model.id, systemPrompt, tools, options?.sessionId, deps.query ?? sdkQuery, cwd, builtinTools);
    sessions.add(session);
    session.input.push(sdkUserMessage(buildOpeningPrompt(conversation)));
  }

  const live = session;
  const onAbort = () => live.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  live.busy = true;
  live.touch();

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    out.push({ type: "start", partial: message });
  };
  // Content-block index within the current API response → index in message.content (-1 = not surfaced).
  let blocks = new Map<number, number>();
  const toolJson = new Map<number, string>();
  // Built-in tool calls in the current API response, by content-block index.
  let builtinBlocks = new Map<number, { id: string; name: string; json: string }>();
  const pushHarnessEvent = (event: HarnessToolEvent) => out.push(event as never);
  let stopReason: string | null = null;
  let apiError = "";
  let outputBase = 0;

  const onEvent = (ev: StreamEvent): "toolUse" | undefined => {
    if (ev.type === "message_start") {
      start();
      blocks = new Map();
      builtinBlocks = new Map();
      stopReason = null;
      if (ev.message?.id) message.responseId = ev.message.id;
      outputBase = message.usage.output;
      applyUsage(message.usage, ev.message?.usage, outputBase);
    } else if (ev.type === "content_block_start" && ev.index !== undefined && ev.content_block) {
      const block = ev.content_block;
      const contentIndex = message.content.length;
      if (block.type === "text") {
        message.content.push({ type: "text", text: "" });
        out.push({ type: "text_start", contentIndex, partial: message });
      } else if (block.type === "thinking") {
        message.content.push({ type: "thinking", thinking: "" });
        out.push({ type: "thinking_start", contentIndex, partial: message });
      } else if (block.type === "tool_use" && block.name?.startsWith(TOOL_PREFIX)) {
        message.content.push({ type: "toolCall", id: block.id ?? randomUUID(), name: block.name.slice(TOOL_PREFIX.length), arguments: {} });
        toolJson.set(contentIndex, "");
        out.push({ type: "toolcall_start", contentIndex, partial: message });
      } else {
        // A built-in tool: Claude Code runs it, Rye only reports it.
        if (block.type === "tool_use" && block.name) builtinBlocks.set(ev.index, { id: block.id ?? randomUUID(), name: block.name, json: "" });
        blocks.set(ev.index, -1);
        return;
      }
      blocks.set(ev.index, contentIndex);
    } else if (ev.type === "content_block_delta" && ev.index !== undefined && ev.delta) {
      const builtin = builtinBlocks.get(ev.index);
      if (builtin) {
        if (ev.delta.type === "input_json_delta" && ev.delta.partial_json) builtin.json += ev.delta.partial_json;
        return;
      }
      const contentIndex = blocks.get(ev.index) ?? -1;
      const block = message.content[contentIndex];
      if (!block) return;
      if (block.type === "text" && ev.delta.type === "text_delta" && ev.delta.text) {
        block.text += ev.delta.text;
        out.push({ type: "text_delta", contentIndex, delta: ev.delta.text, partial: message });
      } else if (block.type === "thinking" && ev.delta.type === "thinking_delta" && ev.delta.thinking) {
        block.thinking += ev.delta.thinking;
        out.push({ type: "thinking_delta", contentIndex, delta: ev.delta.thinking, partial: message });
      } else if (block.type === "thinking" && ev.delta.type === "signature_delta" && ev.delta.signature) {
        block.thinkingSignature = (block.thinkingSignature ?? "") + ev.delta.signature;
      } else if (block.type === "toolCall" && ev.delta.type === "input_json_delta" && ev.delta.partial_json) {
        toolJson.set(contentIndex, (toolJson.get(contentIndex) ?? "") + ev.delta.partial_json);
        out.push({ type: "toolcall_delta", contentIndex, delta: ev.delta.partial_json, partial: message });
      }
    } else if (ev.type === "content_block_stop" && ev.index !== undefined) {
      const builtin = builtinBlocks.get(ev.index);
      if (builtin) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(builtin.json || "{}");
        } catch {
          // show the call without arguments
        }
        start();
        live.builtinCalls.set(builtin.id, builtin.name);
        pushHarnessEvent({ type: "harness_tool_start", id: builtin.id, name: builtin.name, args });
        return;
      }
      const contentIndex = blocks.get(ev.index) ?? -1;
      const block = message.content[contentIndex];
      if (!block) return;
      if (block.type === "text") {
        out.push({ type: "text_end", contentIndex, content: block.text, partial: message });
      } else if (block.type === "thinking") {
        out.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
      } else {
        try {
          block.arguments = JSON.parse(toolJson.get(contentIndex) || "{}");
        } catch {
          block.arguments = {};
        }
        out.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
      }
    } else if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      applyUsage(message.usage, ev.usage, outputBase);
    } else if (ev.type === "message_stop") {
      // Tool calls go back to Rye. Any other stop is confirmed by the SDK's result message.
      if (stopReason === "tool_use" && message.content.some((b) => b.type === "toolCall")) return "toolUse";
    }
    return undefined;
  };

  const finish = (reason: "stop" | "length" | "toolUse") => {
    start();
    message.stopReason = reason;
    message.responseId ??= `rye-${randomUUID()}`;
    live.lastResponseId = message.responseId;
    out.push({ type: "done", reason, message });
    out.end();
  };

  try {
    while (true) {
      const next = await live.query.next();
      if (next.done) throw new Error(`Claude Code exited before replying.${live.errorDetail() ? `\n${live.errorDetail()}` : ""}`);
      const m = next.value as SDKMessage;
      if (m.type === "stream_event") {
        // Built-in tool calls (e.g. WebSearch) are run by the SDK; onEvent skips them and the stream carries on.
        // Subagent output never reaches here (no Agent tool), but skip it if it ever does.
        if (m.parent_tool_use_id) continue;
        if (onEvent(m.event as StreamEvent) === "toolUse") {
          for (const b of message.content) if (b.type === "toolCall") live.expectResult(b);
          finish("toolUse");
          break;
        }
      } else if (m.type === "user") {
        // Tool results Claude Code produced itself come back as a user message.
        if (m.parent_tool_use_id) continue;
        const content = (m.message as { content?: unknown }).content;
        for (const block of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const name = live.builtinCalls.get(id);
          if (block.type !== "tool_result" || !name) continue;
          live.builtinCalls.delete(id);
          pushHarnessEvent({
            type: "harness_tool_result",
            id,
            name,
            content: clip(toolResultText(block.content), BUILTIN_RESULT_CHARS),
            isError: block.is_error === true,
          });
        }
      } else if (m.type === "assistant" && m.error) {
        // API failures arrive as a synthetic assistant message, e.g. "Not logged in · Please run /login".
        const text = (m.message.content as Array<{ type: string; text?: string }>)
          .map((b) => (b.type === "text" ? b.text ?? "" : ""))
          .join("")
          .trim();
        apiError = text || m.error;
      } else if (m.type === "result") {
        if (m.subtype === "success" && !m.is_error) {
          if (!message.content.some((b) => b.type === "text") && m.result) {
            start();
            const contentIndex = message.content.length;
            message.content.push({ type: "text", text: m.result });
            out.push({ type: "text_start", contentIndex, partial: message });
            out.push({ type: "text_delta", contentIndex, delta: m.result, partial: message });
            out.push({ type: "text_end", contentIndex, content: m.result, partial: message });
          }
          finish(stopReason === "max_tokens" ? "length" : "stop");
          // One-off calls have nothing to continue.
          if (!live.chatSessionId) live.close();
        } else {
          const detail = apiError || (m.subtype === "success" ? m.result : m.errors.join("; ")) || m.subtype;
          live.close();
          fail(`Claude: ${detail}`);
        }
        break;
      }
    }
  } catch (err) {
    live.close();
    if (signal?.aborted) fail("Request was aborted", "aborted");
    else fail(err instanceof Error ? err.message : String(err));
  } finally {
    // While Rye runs the tools the run can still be cancelled, which must end the session too.
    if (live.pending.size === 0) signal?.removeEventListener("abort", onAbort);
    live.busy = false;
    if (!live.closed) live.touch();
  }
}

/** pi-ai API implementation backed by the Claude Agent SDK. */
export function claudeAgentSdkApi(deps: ClaudeSdkDeps = {}): ProviderStreams {
  const stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
    const out = createAssistantMessageEventStream();
    void run(deps, model, context, options, out);
    return out;
  };
  return { stream, streamSimple: stream };
}

// ---------------------------------------------------------------------------
// Account + model catalog
// ---------------------------------------------------------------------------

export interface ClaudeHarnessInfo {
  models: string[];
  /** Who Claude Code is signed in as, or how it authenticates; undefined when it isn't. */
  account?: string;
}

const INFO_CACHE_MS = 10 * 60 * 1000;
let infoCache: { info: ClaudeHarnessInfo; at: number } | null = null;

/** Models and sign-in state reported by Claude Code. Starts it briefly; makes no model call. */
export async function claudeHarnessInfo(queryFn: QueryFn = sdkQuery): Promise<ClaudeHarnessInfo> {
  if (infoCache && Date.now() - infoCache.at < INFO_CACHE_MS) return infoCache.info;
  const input = new InputChannel();
  const q = queryFn({ prompt: input, options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false } });
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code didn't start in time")), 15_000)),
    ]);
    const a = init.account ?? {};
    const info: ClaudeHarnessInfo = {
      models: init.models.map((m) => m.value),
      account: a.email || a.organization || a.apiKeySource || a.tokenSource || (a.apiProvider && a.apiProvider !== "firstParty" ? a.apiProvider : undefined),
    };
    infoCache = { info, at: Date.now() };
    return info;
  } finally {
    input.end();
    try {
      q.close();
    } catch {
      // Already gone.
    }
  }
}
