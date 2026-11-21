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

/** A tool-permission prompt (MCP tool approval or add-MCP-server confirmation), not an ask_user question. */
export function isPermissionPrompt(prompt: PendingPrompt): boolean {
  const options = prompt.options ?? [];
  return (
    prompt.type === "choice" &&
    options.length > 0 &&
    options.every((option) => OUTCOMES.has(option)) &&
    (options.includes("Deny") || options.includes("Add MCP server"))
  );
}

export function permissionOutcome(answer: string): string {
  return OUTCOMES.get(answer) ?? answer;
}

export function isDenial(answer: string): boolean {
  return answer === "Deny" || answer === "Cancel";
}
