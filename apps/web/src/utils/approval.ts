import type { PendingPrompt } from "@rye/shared";

// Keys mirror agent-core mcp/approval.ts and tools/mcp-manager.ts option strings.
const OUTCOMES = new Map<string, string>([
  ["Allow once", "Allowed once"],
  ["Allow this tool for this session", "Allowed for this session"],
  ["Allow read-only tools from this server for this session", "Allowed read-only tools for this session"],
  ["Deny", "Denied"],
  ["Add MCP server", "Approved adding MCP server"],
  ["Cancel", "Cancelled adding MCP server"],
]);

/** A code session's per-pattern option: `Allow "bun add *" for this session` (docs/design/code-sessions.md §3.4). */
export const SESSION_PATTERN_OPTION = /^Allow "(.+)" for this session$/;

/** A tool-permission prompt (MCP tool approval, add-MCP-server confirmation, or a code session's live approval), not an ask_user question. */
export function isPermissionPrompt(prompt: PendingPrompt): boolean {
  const options = prompt.options ?? [];
  if (prompt.type !== "choice" || options.length === 0) return false;
  // A code session's approval: its options are Allow once / Allow "<pattern>" for this session / Deny.
  if (prompt.live && options.includes("Deny")) return options.every((option) => OUTCOMES.has(option) || SESSION_PATTERN_OPTION.test(option));
  return options.every((option) => OUTCOMES.has(option)) && (options.includes("Deny") || options.includes("Add MCP server"));
}

export function permissionOutcome(answer: string): string {
  const pattern = SESSION_PATTERN_OPTION.exec(answer);
  if (pattern) return `Allowed "${pattern[1]}" for this session`;
  return OUTCOMES.get(answer) ?? answer;
}

export function isDenial(answer: string): boolean {
  return answer === "Deny" || answer === "Cancel";
}
