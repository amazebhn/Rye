/**
 * MCP client manager — connects to configured servers, exposes their tools to
 * the agent under a namespaced name, and proxies calls.
 *
 * Tools are named `mcp__<server>__<tool>` so they can never collide with or
 * shadow a built-in tool.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@earendil-works/pi-ai";
import { loadMcpConfig } from "./config.js";
import type { McpServerConfig } from "./config.js";
import { McpOAuthProvider } from "./oauth.js";

export const MCP_PREFIX = "mcp__";

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

interface Connection {
  server: McpServerConfig;
  client: Client;
  tools: McpTool[];
}

export interface ServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  transport: string;
  error?: string;
  auth?: "oauth";
  authRequired?: boolean;
  authorizeUrl?: string;
}

const connections = new Map<string, Connection>();
const failures = new Map<string, string>();
let initialised = false;

function log(msg: string, data?: unknown) {
  if (data !== undefined) console.log(`[mcp] ${msg}`, data);
  else console.log(`[mcp] ${msg}`);
}

export function toolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

/** Split a namespaced tool name back into server + remote tool name. */
export function parseToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep === -1) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

function buildTransport(cfg: McpServerConfig) {
  if (cfg.url) {
    const url = new URL(cfg.url);
    const authProvider = cfg.auth === "oauth" ? new McpOAuthProvider(cfg) : undefined;
    const opts = {
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
    };
    return cfg.transport === "sse"
      ? new SSEClientTransport(url, opts)
      : new StreamableHTTPClientTransport(url, opts);
  }
  return new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args ?? [],
    // Servers routinely need PATH and friends, so inherit rather than isolate.
    env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
    cwd: cfg.cwd,
    stderr: "pipe",
  });
}

async function connectServer(cfg: McpServerConfig): Promise<void> {
  const existing = connections.get(cfg.name);
  if (existing) {
    try { await existing.client.close(); } catch { /* already closed */ }
    connections.delete(cfg.name);
  }
  const client = new Client({ name: "rye", version: "0.1.0" }, { capabilities: {} });
  const transport = buildTransport(cfg);

  await client.connect(transport);
  const listed = await client.listTools();

  const tools: McpTool[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    readOnly: t.annotations?.readOnlyHint === true,
  }));

  connections.set(cfg.name, { server: cfg, client, tools });
  failures.delete(cfg.name);
  log(`connected "${cfg.name}" (${tools.length} tool(s))`);
}

/** Connect to every configured server. Failures are recorded, never thrown. */
export async function initMcp(): Promise<void> {
  initialised = true;
  const configs = loadMcpConfig();
  if (configs.length === 0) return;

  await Promise.all(
    configs.map(async (cfg) => {
      try {
        await connectServer(cfg);
      } catch (err) {
        const pending = cfg.auth === "oauth" ? new McpOAuthProvider(cfg).pendingAuthorization() : null;
        const msg = err instanceof UnauthorizedError && pending
          ? "OAuth authorization required"
          : err instanceof Error ? err.message : String(err);
        failures.set(cfg.name, msg);
        log(`failed to connect "${cfg.name}": ${msg}`);
      }
    })
  );
}

export async function reloadMcp(): Promise<void> {
  await shutdownMcp();
  failures.clear();
  await initMcp();
}

export async function shutdownMcp(): Promise<void> {
  await Promise.all(
    [...connections.values()].map(async (conn) => {
      try {
        await conn.client.close();
      } catch {
        // Already gone; nothing to do.
      }
    })
  );
  connections.clear();
}

export function isMcpReady(): boolean {
  return initialised;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

export function isReadOnlyTool(name: string): boolean {
  const parsed = parseToolName(name);
  if (!parsed) return false;
  return connections.get(parsed.server)?.tools.find((t) => t.name === parsed.tool)?.readOnly ?? false;
}

/** Tool definitions for the LLM, namespaced per server. */
export function getMcpToolDefs(): Tool[] {
  const defs: Tool[] = [];
  for (const [server, conn] of connections) {
    for (const tool of conn.tools) {
      defs.push({
        name: toolName(server, tool.name),
        description: `[MCP: ${server}] ${tool.description ?? tool.name}`,
        // MCP inputSchema is already JSON Schema, which is what the API expects.
        parameters: tool.inputSchema as never,
      });
    }
  }
  return defs;
}

export function getServerStatuses(): ServerStatus[] {
  const statuses: ServerStatus[] = [];
  for (const [name, conn] of connections) {
    statuses.push({
      name,
      connected: true,
      toolCount: conn.tools.length,
      transport: conn.server.url ? conn.server.transport ?? "http" : "stdio",
      ...(conn.server.auth ? { auth: conn.server.auth } : {}),
    });
  }
  for (const [name, error] of failures) {
    const cfg = loadMcpConfig().find((entry) => entry.name === name);
    const pending = cfg?.auth === "oauth" ? new McpOAuthProvider(cfg).pendingAuthorization() : null;
    statuses.push({
      name,
      connected: false,
      toolCount: 0,
      transport: cfg?.url ? cfg.transport ?? "http" : cfg?.command ? "stdio" : "unknown",
      error,
      ...(cfg?.auth ? { auth: cfg.auth } : {}),
      ...(pending ? { authRequired: true, authorizeUrl: pending.startUrl } : {}),
    });
  }
  return statuses;
}

export function getMcpOAuthAuthorization(server: string): { authorizationUrl: string } | null {
  const cfg = loadMcpConfig().find((entry) => entry.name === server && entry.auth === "oauth");
  const pending = cfg ? new McpOAuthProvider(cfg).pendingAuthorization() : null;
  return pending ? { authorizationUrl: pending.authorizationUrl } : null;
}

export async function completeMcpOAuth(
  state: string,
  authorizationCode: string
): Promise<ServerStatus> {
  for (const cfg of loadMcpConfig()) {
    if (cfg.auth !== "oauth" || !cfg.url) continue;
    const provider = new McpOAuthProvider(cfg);
    if (!provider.consumeState(state)) continue;

    const url = new URL(cfg.url);
    const opts = {
      authProvider: provider,
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
    };
    const transport = cfg.transport === "sse"
      ? new SSEClientTransport(url, opts)
      : new StreamableHTTPClientTransport(url, opts);
    try {
      await transport.finishAuth(authorizationCode);
      await connectServer(cfg);
    } catch (err) {
      provider.invalidateCredentials("verifier");
      throw err;
    }
    const status = getServerStatuses().find((entry) => entry.name === cfg.name);
    if (!status) throw new Error(`MCP server '${cfg.name}' did not report a status after OAuth.`);
    return status;
  }
  throw new Error("OAuth state is invalid, expired, or has already been used.");
}

export function cancelMcpOAuth(state: string): string | null {
  for (const cfg of loadMcpConfig()) {
    if (cfg.auth !== "oauth") continue;
    const provider = new McpOAuthProvider(cfg);
    if (!provider.consumeState(state)) continue;
    provider.clearPendingAuthorization();
    return cfg.name;
  }
  return null;
}

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const parsed = parseToolName(name);
  if (!parsed) return `Not an MCP tool: ${name}`;

  const conn = connections.get(parsed.server);
  if (!conn) {
    const reason = failures.get(parsed.server);
    return reason
      ? `MCP server "${parsed.server}" is not connected: ${reason}`
      : `MCP server "${parsed.server}" is not configured.`;
  }

  try {
    const res = await conn.client.callTool({ name: parsed.tool, arguments: args });
    const blocks = (res.content ?? []) as Array<Record<string, unknown>>;
    const text = blocks
      .map((b) => {
        if (b.type === "text") return String(b.text ?? "");
        if (b.type === "resource") {
          const resource = b.resource as Record<string, unknown> | undefined;
          return String(resource?.text ?? resource?.uri ?? "[resource]");
        }
        return `[${String(b.type ?? "content")}]`;
      })
      .filter(Boolean)
      .join("\n");

    const body = text || (res.structuredContent ? JSON.stringify(res.structuredContent) : "(no output)");
    return res.isError ? `MCP tool error: ${body}` : body;
  } catch (err) {
    const pending = conn.server.auth === "oauth"
      ? new McpOAuthProvider(conn.server).pendingAuthorization()
      : null;
    if (pending) {
      return `MCP authentication required. Authorize server "${parsed.server}" at ${pending.startUrl}`;
    }
    return `MCP call failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
