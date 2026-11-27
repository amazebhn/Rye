/**
 * What the Claude chat harness (`harness/claude-sdk.ts`) and the Claude code engine
 * (`code/engines/claude.ts`) share about driving the Claude Agent SDK:
 *
 * - `InputChannel`: user messages fed to a live `query()` (streaming input mode);
 * - `RyeMcpBridge`: Rye's tools exposed to Claude Code as an in-process MCP server;
 * - reading SDK messages: tool_use blocks in the stream (`ToolUseBlocks`), tool results Claude
 *   Code reports as user messages (`toolResultBlocks`), API errors (`assistantErrorText`,
 *   `resultErrorDetail`), and the stderr tail for errors (`StderrTail`).
 *
 * Each caller turns these into its own events: pi-ai stream events for chats, `CodeEvent`s for
 * code sessions.
 */

import { randomUUID } from "node:crypto";
import type { Options, Query, SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";

/** The SDK's `query()`, or a fake one in tests. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

/** Name of the in-process MCP server that carries Rye's tools. */
export const RYE_MCP_SERVER = "rye";
/** Claude Code's name for a tool on that server: `mcp__rye__<tool>`. */
export const RYE_TOOL_PREFIX = `mcp__${RYE_MCP_SERVER}__`;
/** Rye enforces its own tool timeouts and may wait on the user, so the SDK's limit only bounds leaks. */
export const SDK_TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** How long `syncTools` waits for Claude Code to re-read a changed tool list. */
const TOOL_LIST_WAIT_MS = 3000;

// A type alias, not an interface, so it satisfies the MCP SDK's open-ended result type.
export type ToolOutcome = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
};

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** User messages fed to a live SDK session. */
export class InputChannel implements AsyncIterable<SDKUserMessage> {
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

export type UserBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** A user message for the SDK's input stream; `extra` sets fields such as `uuid` or `priority`. */
export function sdkUserMessage(blocks: UserBlock[], extra: Partial<Pick<SDKUserMessage, "uuid" | "priority">> = {}): SDKUserMessage {
  return { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null, ...extra } as SDKUserMessage;
}

// ---------------------------------------------------------------------------
// Rye tools as an in-process MCP server
// ---------------------------------------------------------------------------

export const toolSignature = (tools: Tool[]) => JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]));

/** One call of a Rye tool, as Claude Code made it. */
export interface RyeMcpCall {
  /** The Rye tool's own name (no `mcp__rye__` prefix). */
  name: string;
  arguments?: Record<string, unknown>;
  /** The model's tool_use id, when Claude Code sent it (`_meta["claudecode/toolUseId"]`). */
  toolUseId?: string;
}

/** The tool_use id Claude Code sends with an MCP call, when it does. */
export function toolUseIdFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const fromMeta = meta?.["claudecode/toolUseId"];
  return typeof fromMeta === "string" ? fromMeta : undefined;
}

/**
 * Rye's tools as an in-process MCP server. `call` answers each call: the chat harness waits for
 * Rye's agent loop to run the tool, the code engine runs it directly (`CodeRunOptions.runRyeTool`).
 */
export class RyeMcpBridge {
  readonly server: McpServer;
  private current: Tool[];
  private sig: string;
  private listWaiters: Array<() => void> = [];

  constructor(
    tools: Tool[],
    call: (call: RyeMcpCall) => Promise<ToolOutcome>,
    readonly name: string = RYE_MCP_SERVER,
  ) {
    this.current = tools;
    this.sig = toolSignature(tools);
    const mcp = new McpServer({ name, version: "1.0.0" });
    mcp.server.registerCapabilities({ tools: { listChanged: true } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
      for (const wake of this.listWaiters.splice(0)) wake();
      return { tools: this.current.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" } })) };
    });
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req) =>
      call({ name: req.params.name, arguments: req.params.arguments, toolUseId: toolUseIdFromMeta(req.params._meta) }),
    );
    this.server = mcp;
  }

  get tools(): Tool[] {
    return this.current;
  }

  /** The `mcpServers` entry for `query()` options. */
  config(timeout = SDK_TOOL_TIMEOUT_MS) {
    return { type: "sdk" as const, name: this.name, instance: this.server, timeout };
  }

  /** Swap the tool list and wait for Claude Code to re-read it, so the next model turn sees it. */
  async syncTools(tools: Tool[]) {
    const sig = toolSignature(tools);
    if (sig === this.sig) return;
    this.current = tools;
    this.sig = sig;
    const reread = new Promise<void>((resolve) => {
      this.listWaiters.push(resolve);
      setTimeout(resolve, TOOL_LIST_WAIT_MS);
    });
    try {
      await this.server.server.sendToolListChanged();
      await reread;
    } catch {
      // Not connected yet; the first tools/list picks up the new list.
    }
  }
}

// ---------------------------------------------------------------------------
// Reading SDK messages
// ---------------------------------------------------------------------------

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
export const BUILTIN_RESULT_CHARS = 6000;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [truncated]` : text);

/** Text of a tool_result block's content, which is a string or a list of text/other blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** One Messages API streaming event, as a `stream_event` SDK message carries it. */
export interface StreamEvent {
  type: string;
  index?: number;
  message?: { id?: string; usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
  usage?: AnthropicUsage;
}

/** A tool call read from the stream once its block is complete. */
export interface StreamedToolUse {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * tool_use blocks of the current API response, by content-block index, collected from
 * `content_block_start` / `input_json_delta` / `content_block_stop` events.
 */
export class ToolUseBlocks {
  private blocks = new Map<number, { id: string; name: string; json: string }>();

  /** A new API response started (`message_start`): indices start again. */
  reset() {
    this.blocks = new Map();
  }

  /** Track the block when it is a tool_use; true when it is. */
  start(index: number, block: { type: string; id?: string; name?: string }): boolean {
    if (block.type !== "tool_use" || !block.name) return false;
    this.blocks.set(index, { id: block.id ?? randomUUID(), name: block.name, json: "" });
    return true;
  }

  has(index: number): boolean {
    return this.blocks.has(index);
  }

  /** Add streamed arguments; true when the block is tracked here. */
  delta(index: number, delta: { type?: string; partial_json?: string }): boolean {
    const block = this.blocks.get(index);
    if (!block) return false;
    if (delta.type === "input_json_delta" && delta.partial_json) block.json += delta.partial_json;
    return true;
  }

  /** The complete call, when the block is tracked here. Unparseable arguments come back empty. */
  stop(index: number): StreamedToolUse | undefined {
    const block = this.blocks.get(index);
    if (!block) return undefined;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(block.json || "{}");
    } catch {
      // show the call without arguments
    }
    return { id: block.id, name: block.name, args };
  }
}

/** The tool_result blocks of a user message: results of tools Claude Code ran itself. */
export function toolResultBlocks(message: { message: unknown }): Array<{ id: string; content: unknown; isError: boolean }> {
  const content = (message.message as { content?: unknown }).content;
  const out: Array<{ id: string; content: unknown; isError: boolean }> = [];
  for (const block of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
    if (block.type !== "tool_result") continue;
    out.push({ id: typeof block.tool_use_id === "string" ? block.tool_use_id : "", content: block.content, isError: block.is_error === true });
  }
  return out;
}

/** The text of a synthetic assistant message reporting an API failure, e.g. "Not logged in · Please run /login". */
export function assistantErrorText(m: SDKAssistantMessage): string {
  const text = (m.message.content as Array<{ type: string; text?: string }>)
    .map((b) => (b.type === "text" ? b.text ?? "" : ""))
    .join("")
    .trim();
  return text || m.error || "";
}

/** Why a result message failed: the API error seen before it, else what the result says. */
export function resultErrorDetail(m: SDKResultMessage, apiError: string): string {
  return apiError || (m.subtype === "success" ? m.result : m.errors.join("; ")) || m.subtype;
}

/** The last few lines Claude Code wrote to stderr, for error messages. */
export class StderrTail {
  private lines: string[] = [];

  constructor(private readonly keep = 5) {}

  push(data: string) {
    this.lines.push(data.trim());
    if (this.lines.length > this.keep) this.lines.shift();
  }

  text(): string {
    return this.lines.filter(Boolean).join("\n");
  }
}
