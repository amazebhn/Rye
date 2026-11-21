/**
 * Approval state for MCP tools.
 *
 * MCP servers are third-party code that can have side effects, while the rest
 * of Rye is read-only by design. First use of a tool in a session prompts the
 * user; they can approve that one call, or trust a server's read-only tools for
 * the remainder of the session.
 */

import { isReadOnlyTool, parseToolName } from "./client.js";

interface SessionApprovals {
  /** Approved for a single call, consumed on use. */
  oneShot: Set<string>;
  /** Approved for the rest of the session. */
  tools: Set<string>;
  /** Servers whose read-only tools are auto-approved this session. */
  readOnlyServers: Set<string>;
  denied: Set<string>;
}

const sessions = new Map<string, SessionApprovals>();
const pending = new Map<string, string>();

export const APPROVE_ONCE = "Allow once";
export const APPROVE_ALWAYS = "Allow this tool for this session";
export const APPROVE_READONLY = "Allow read-only tools from this server for this session";
export const DENY = "Deny";

function get(sessionId: string): SessionApprovals {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { oneShot: new Set(), tools: new Set(), readOnlyServers: new Set(), denied: new Set() };
    sessions.set(sessionId, entry);
  }
  return entry;
}

export function isApproved(sessionId: string, tool: string): boolean {
  const approvals = get(sessionId);
  if (approvals.tools.has(tool) || approvals.oneShot.has(tool)) return true;
  const parsed = parseToolName(tool);
  if (!parsed) return false;
  return approvals.readOnlyServers.has(parsed.server) && isReadOnlyTool(tool);
}

export function isDenied(sessionId: string, tool: string): boolean {
  return get(sessionId).denied.has(tool);
}

/** Spend a single-use approval, if that's what authorised the call. */
export function consumeApproval(sessionId: string, tool: string): void {
  get(sessionId).oneShot.delete(tool);
}

/** Record that the user is being asked about this tool, pending their reply. */
export function setPending(sessionId: string, tool: string): void {
  pending.set(sessionId, tool);
}

export function getPending(sessionId: string): string | undefined {
  return pending.get(sessionId);
}

/**
 * Apply the user's answer to the outstanding prompt. Returns the tool the
 * decision applied to, or null when nothing was pending.
 */
export function resolvePending(sessionId: string, answer: string): string | null {
  const tool = pending.get(sessionId);
  if (!tool) return null;
  pending.delete(sessionId);

  const approvals = get(sessionId);
  const normalized = answer.trim().toLowerCase();
  const parsed = parseToolName(tool);

  if (normalized.startsWith("allow read-only") && parsed) {
    approvals.readOnlyServers.add(parsed.server);
    approvals.oneShot.add(tool);
  } else if (normalized.startsWith("allow this tool")) {
    approvals.tools.add(tool);
  } else if (normalized.startsWith("allow") || normalized === "yes" || normalized === "y") {
    approvals.oneShot.add(tool);
  } else {
    approvals.denied.add(tool);
  }

  return tool;
}

export function clearPendingApproval(sessionId: string): void {
  pending.delete(sessionId);
}

export function clearSessionApprovals(sessionId: string): void {
  sessions.delete(sessionId);
  pending.delete(sessionId);
}
