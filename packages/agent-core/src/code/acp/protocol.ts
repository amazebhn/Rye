/**
 * The subset of the Agent Client Protocol (ACP) that Rye's `acp:<cli>` code engines use.
 *
 * Spec: https://agentclientprotocol.com/protocol/overview (schema:
 * https://agentclientprotocol.com/protocol/schema). JSON-RPC 2.0 over the agent process's stdio,
 * one message per line (UTF-8, newline-delimited; a message never contains an embedded newline:
 * https://agentclientprotocol.com/protocol/transports).
 *
 * Only the fields Rye reads or sends are typed; everything else an agent sends is tolerated and
 * ignored. Methods marked "unstable" are not in the stable schema yet: Rye only uses them when the
 * agent advertises them, and never depends on them.
 */

/** The protocol version Rye speaks (`initialize` `protocolVersion`, an integer). */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** Standard JSON-RPC codes, plus ACP's (https://agentclientprotocol.com/protocol/schema, error codes). */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "audio"; data: string; mimeType: string };

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: { name: string; title?: string; version?: string };
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  /** Newer agents: `{ resume?: {}, list?: {}, … }` (session/resume is unstable). */
  sessionCapabilities?: Record<string, unknown>;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: { name?: string; title?: string; version?: string };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** MCP servers handed to the agent for a session. Rye passes none: its tools aren't bridged into ACP agents yet. */
export type McpServerConfig = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export interface NewSessionParams {
  /** Absolute. */
  cwd: string;
  mcpServers: McpServerConfig[];
}

/**
 * A session setting the agent offers (https://agentclientprotocol.com/protocol/session-config-options).
 * Rye only reads `select` options with `category: "model"`, to pick the model.
 */
export interface SessionConfigOption {
  id: string;
  name?: string;
  type: "select" | "boolean" | string;
  currentValue?: unknown;
  category?: string | null;
  /** For `select`: plain values, or groups of them. */
  options?: Array<{ value?: string; name?: string; options?: Array<{ value?: string; name?: string }> }>;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> } | null;
  configOptions?: SessionConfigOption[] | null;
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
}

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

/** https://agentclientprotocol.com/protocol/prompt-turn#stop-reasons */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** Token counts some agents add to a prompt's result (unstable, optional). */
export interface PromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

export interface PromptResult {
  stopReason: StopReason;
  usage?: PromptUsage | null;
}

// ---------------------------------------------------------------------------
// session/update
// ---------------------------------------------------------------------------

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

/** A `tool_call` (every field but the id required by the spec) or `tool_call_update` (only the id required). */
export interface ToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "plan"; entries: Array<{ content: string; priority?: string; status?: string }> }
  | { sessionUpdate: "available_commands_update"; availableCommands?: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  /** Unstable: context window use and cost. */
  | { sessionUpdate: "usage_update"; used?: number; size?: number; cost?: { amount?: number; currency?: string } | null }
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// session/request_permission
// ---------------------------------------------------------------------------

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallFields;
  options: PermissionOption[];
}

export type RequestPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
}

// ---------------------------------------------------------------------------
// fs (client methods, only when advertised in clientCapabilities)
// ---------------------------------------------------------------------------

export interface ReadTextFileParams {
  sessionId: string;
  /** Absolute. */
  path: string;
  /** 1-based first line. */
  line?: number | null;
  /** Lines to read. */
  limit?: number | null;
}

export interface WriteTextFileParams {
  sessionId: string;
  /** Absolute. */
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** Agent methods Rye calls, and the notifications it sends. */
export const AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  /** Unstable: continue a session without replaying its history. */
  sessionResume: "session/resume",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetConfigOption: "session/set_config_option",
} as const;

/** Client methods an agent calls on Rye. */
export const CLIENT_METHODS = {
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
} as const;
