/** Guarded MCP server configuration tool.
 *
 * The model may only create a pending proposal. The main agent loop owns the
 * confirmation prompt and calls resolvePendingMcpServerAddition on the user's
 * next message, so neither the model nor a subagent can silently install one.
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { McpServerDefinition, McpServerWrite } from "../mcp/config.js";
import { MCP_CONFIG_FILE, previewMcpServerWrite, writeMcpServer } from "../mcp/config.js";
import { getServerStatuses, reloadMcp } from "../mcp/client.js";

export const ADD_MCP_SERVER_TOOL_NAME = "add_mcp_server_tool";
export const CONFIRM_ADD_MCP_SERVER = "Add MCP server";
export const CANCEL_ADD_MCP_SERVER = "Cancel";

export interface AddMcpServerArgs extends McpServerDefinition {
  name: string;
  replace?: boolean;
}

interface PendingAddition {
  write: McpServerWrite;
  replacing: boolean;
}

const pending = new Map<string, PendingAddition>();

function toWrite(args: AddMcpServerArgs): McpServerWrite {
  const { name, replace, command, args: commandArgs, env, cwd, url, headers, transport, auth, oauth } = args;
  return {
    name,
    replace,
    config: { command, args: commandArgs, env, cwd, url, headers, transport, auth, oauth },
  };
}

function formatDefinition(write: McpServerWrite): string {
  return JSON.stringify({ [write.name]: write.config }, null, 2);
}

export function prepareMcpServerAddition(
  sessionId: string,
  args: AddMcpServerArgs
): { ok: true; question: string } | { ok: false; error: string } {
  const write = toWrite(args);
  try {
    const { replacing } = previewMcpServerWrite(write);
    pending.set(sessionId, { write, replacing });
    const risk = write.config.command
      ? `This permits Rye to start the local command \`${write.config.command}\` and expose its tools.`
      : `This permits Rye to connect to ${write.config.url} and send tool inputs to that remote server.`;
    return {
      ok: true,
      question:
        `${replacing ? "Replace" : "Add"} MCP server \`${write.name}\` in \`${MCP_CONFIG_FILE}\`?\n\n` +
        `${risk}\n\nConfiguration:\n\`\`\`json\n${formatDefinition(write)}\n\`\`\``,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function clearPendingMcpServerAddition(sessionId: string): void {
  pending.delete(sessionId);
}

/** Resolve a pending proposal. Anything other than an explicit approval cancels. */
export async function resolvePendingMcpServerAddition(
  sessionId: string,
  answer: string
): Promise<string | null> {
  const proposal = pending.get(sessionId);
  if (!proposal) return null;
  pending.delete(sessionId);

  const normalized = answer.trim().toLowerCase();
  const approved = ["add mcp server", "yes", "y", "approve", "approved"].includes(normalized);
  if (!approved) return `MCP server '${proposal.write.name}' was not added.`;

  try {
    writeMcpServer(proposal.write);
  } catch (err) {
    return `MCP server '${proposal.write.name}' was not added: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    await reloadMcp();
    const status = getServerStatuses().find((entry) => entry.name === proposal.write.name);
    if (!status) {
      return `MCP server '${proposal.write.name}' was ${proposal.replacing ? "replaced" : "added"}, but it did not report a connection status after reload.`;
    }
    if (!status.connected) {
      if (status.authRequired && status.authorizeUrl) {
        return `MCP server '${proposal.write.name}' was ${proposal.replacing ? "replaced" : "added"} and requires OAuth authorization. [Authorize ${proposal.write.name}](${status.authorizeUrl}) to finish connecting it.`;
      }
      return `MCP server '${proposal.write.name}' was ${proposal.replacing ? "replaced" : "added"}, but connection failed: ${status.error ?? "unknown error"}`;
    }
    return `MCP server '${proposal.write.name}' was ${proposal.replacing ? "replaced" : "added"} and connected successfully with ${status.toolCount} tool(s).`;
  } catch (err) {
    return `MCP server '${proposal.write.name}' was ${proposal.replacing ? "replaced" : "added"}, but MCP reload failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const mcpManagerTools: Tool[] = [
  {
    name: ADD_MCP_SERVER_TOOL_NAME,
    description:
      "Propose adding an MCP server to Rye. This never installs silently: Rye shows the complete configuration and security implications to the user, then waits for explicit approval before writing mcp.json and connecting. " +
      "Use command/args/env/cwd for a local stdio server, or url/headers/transport for a remote HTTP/SSE server. " +
      "Secrets in env or headers must use ${ENV_VAR} references, never literal secret values. Set replace=true only when the user explicitly asked to replace an existing server.",
    parameters: Type.Object({
      name: Type.String({ description: "Unique server name. Letters, numbers, dots, dashes, and single underscores are allowed." }),
      command: Type.Optional(Type.String({ description: "Executable for a local stdio server, e.g. 'npx' or 'uvx'." })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed directly to the stdio executable." })),
      env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment values. Use ${VAR} references for secrets." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for a stdio server. Supports ~ and ${VAR}." })),
      url: Type.Optional(Type.String({ description: "Absolute http(s) URL for a remote MCP server." })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Remote request headers. Use ${VAR} references for credentials." })),
      transport: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("sse")], { description: "Remote transport; defaults to Streamable HTTP." })),
      auth: Type.Optional(Type.Literal("oauth", { description: "Use OAuth 2.1 with PKCE for this remote server." })),
      oauth: Type.Optional(Type.Object({
        redirectUrl: Type.Optional(Type.String({ description: "Override Rye's OAuth callback URL. Usually omit this." })),
        scope: Type.Optional(Type.String({ description: "Space-delimited OAuth scopes. Usually omit and use server discovery." })),
        clientId: Type.Optional(Type.String({ description: "Pre-registered OAuth client id. Omit for dynamic registration." })),
        clientSecret: Type.Optional(Type.String({ description: "Pre-registered client secret as ${ENV_VAR}; never pass a literal secret." })),
        clientMetadataUrl: Type.Optional(Type.String({ description: "HTTPS client metadata document URL for SEP-991 servers." })),
      })),
      replace: Type.Optional(Type.Boolean({ description: "Explicitly replace an existing server with this name. Defaults to false." })),
    }),
  },
];