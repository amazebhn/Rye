/**
 * Custom tool builder — lets the agent propose, install, list, and delete its own tools.
 *
 * Each custom tool is a named JS function body that receives `args` (object) and must
 * return a string (sync or async via Promise). Tools are persisted to DATA_DIR/custom-tools.json
 * and hot-loaded at runtime.
 *
 * Workflow the agent follows:
 *   1. propose_tool(name, description, parameters, code)  — drafts the tool, saves as pending
 *   2. ask_user_tool({type:"yesno", question:"Install <name>?"}) — waits for approval
 *   3. install_tool(name)  — activates it (on user approval)
 *
 * The agent MUST always call ask_user_tool between propose and install.
 */

import { Type, type Tool } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface CustomToolDef {
  name: string;
  description: string;
  /** Simplified parameter definitions: { paramName: "description" } */
  parameters: Record<string, string>;
  /** JS function body. Receives `args` (object). Must return string | Promise<string>. */
  code: string;
  created_at: string;
}

const CUSTOM_TOOLS_FILE = join(DATA_DIR, "custom-tools.json");
const PENDING_TOOLS_FILE = join(DATA_DIR, "custom-tools-pending.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFile(path: string): CustomToolDef[] {
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf-8")) as CustomToolDef[];
  } catch {
    return [];
  }
}

function saveFile(path: string, tools: CustomToolDef[]) {
  ensureDataDir();
  writeFileSync(path, JSON.stringify(tools, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// In-memory registry — rebuilt whenever a tool is installed
// ---------------------------------------------------------------------------

let _activeTools: Map<string, CustomToolDef> = new Map();

export function reloadCustomTools() {
  const defs = loadFile(CUSTOM_TOOLS_FILE);
  _activeTools = new Map(defs.map((d) => [d.name, d]));
}

// Load on module import
reloadCustomTools();

// ---------------------------------------------------------------------------
// Runtime tool dispatch — called from executeTool in index.ts
// ---------------------------------------------------------------------------

export function isCustomTool(name: string): boolean {
  return _activeTools.has(name);
}

export async function executeCustomTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const def = _activeTools.get(name);
  if (!def) return `Custom tool '${name}' not found.`;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("args", def.code);
    const result = await Promise.resolve(fn(args));
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return `Custom tool '${name}' threw an error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Dynamic Tool[] objects for registered custom tools (passed to LLM)
// ---------------------------------------------------------------------------

export function getCustomToolDefs(): Tool[] {
  return Array.from(_activeTools.values()).map((d) => ({
    name: d.name,
    description: d.description,
    parameters: Type.Object(
      Object.fromEntries(
        Object.entries(d.parameters).map(([k, desc]) => [
          k,
          Type.String({ description: desc }),
        ])
      )
    ),
  }));
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function proposeTool(args: {
  name: string;
  description: string;
  parameters: Record<string, string>;
  code: string;
}): string {
  const { name, description, parameters, code } = args;

  if (!name.match(/^[a-z][a-z0-9_]*_tool$/)) {
    return `Tool name must match pattern: lowercase letters/numbers/underscores, ending in '_tool'. Got: ${name}`;
  }

  const def: CustomToolDef = {
    name,
    description,
    parameters,
    code,
    created_at: new Date().toISOString(),
  };

  const pending = loadFile(PENDING_TOOLS_FILE).filter((t) => t.name !== name);
  pending.push(def);
  saveFile(PENDING_TOOLS_FILE, pending);

  const paramLines = Object.entries(parameters)
    .map(([k, v]) => `  • ${k}: ${v}`)
    .join("\n");

  return (
    `Proposed tool: **${name}**\n\n` +
    `**Description:** ${description}\n\n` +
    `**Parameters:**\n${paramLines}\n\n` +
    `**Code:**\n\`\`\`js\n${code}\n\`\`\`\n\n` +
    `Now call ask_user_tool with type='yesno' to get approval before calling install_tool("${name}").`
  );
}

export function installTool(args: { name: string }): string {
  const { name } = args;
  const pending = loadFile(PENDING_TOOLS_FILE);
  const def = pending.find((t) => t.name === name);
  if (!def) {
    return `No pending tool named '${name}'. Call propose_tool first.`;
  }

  // Validate the code compiles (basic syntax check)
  try {
    // eslint-disable-next-line no-new-func
    new Function("args", def.code);
  } catch (err) {
    return `Tool '${name}' has a syntax error and cannot be installed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const active = loadFile(CUSTOM_TOOLS_FILE).filter((t) => t.name !== name);
  active.push(def);
  saveFile(CUSTOM_TOOLS_FILE, active);

  // Remove from pending
  saveFile(
    PENDING_TOOLS_FILE,
    pending.filter((t) => t.name !== name)
  );

  // Hot-reload so it's immediately available
  reloadCustomTools();

  return `Tool '${name}' installed successfully. It is now available for use in this and future sessions.`;
}

export function listCustomTools(): string {
  const active = loadFile(CUSTOM_TOOLS_FILE);
  const pending = loadFile(PENDING_TOOLS_FILE);

  if (active.length === 0 && pending.length === 0) {
    return "No custom tools installed or pending.";
  }

  const lines: string[] = [];
  if (active.length > 0) {
    lines.push("**Installed custom tools:**");
    for (const t of active) {
      lines.push(`  • ${t.name} — ${t.description}`);
    }
  }
  if (pending.length > 0) {
    lines.push("**Pending (not yet installed):**");
    for (const t of pending) {
      lines.push(`  • ${t.name} — ${t.description}`);
    }
  }
  return lines.join("\n");
}

export function deleteCustomTool(args: { name: string }): string {
  const { name } = args;
  const active = loadFile(CUSTOM_TOOLS_FILE);
  const filtered = active.filter((t) => t.name !== name);
  if (filtered.length === active.length) {
    return `No installed tool named '${name}'.`;
  }
  saveFile(CUSTOM_TOOLS_FILE, filtered);
  reloadCustomTools();
  return `Tool '${name}' deleted.`;
}

// ---------------------------------------------------------------------------
// Tool schema definitions (static tools for managing custom tools)
// ---------------------------------------------------------------------------

export const customToolManagerTools: Tool[] = [
  {
    name: "propose_tool_tool",
    description:
      "Draft a new custom tool. The tool is saved as pending but NOT yet active. " +
      "After calling this, you MUST call ask_user_tool with type='yesno' to request user approval, " +
      "then call install_tool_tool only if the user approves. " +
      "Use this to add small utility functions: formatters, grep helpers, data transformers. " +
      "Parameter 'code' is a JavaScript function body — it receives 'args' (object with your declared parameters) " +
      "and must return a string (sync or async). Example: return args.text.toUpperCase();",
    parameters: Type.Object({
      name: Type.String({
        description: "Tool name in snake_case ending with _tool, e.g. format_timezone_tool",
      }),
      description: Type.String({
        description: "What the tool does — used as the LLM-visible description",
      }),
      parameters: Type.Record(
        Type.String(),
        Type.String(),
        {
          description:
            "Parameter names mapped to their descriptions, e.g. {\"timestamp\": \"ISO timestamp to format\", \"tz\": \"Target timezone\"}",
        }
      ),
      code: Type.String({
        description:
          "JavaScript function body. Receives 'args' object. Must return a string. " +
          "Can use await. Cannot import modules. Has access to built-in JS globals only. " +
          "Example: const d = new Date(args.timestamp); return d.toLocaleString('en-US', {timeZone: args.tz});",
      }),
    }),
  },
  {
    name: "install_tool_tool",
    description:
      "Install a previously proposed tool (from propose_tool_tool). " +
      "Only call this AFTER the user has explicitly approved the tool via ask_user_tool. " +
      "The tool becomes immediately available for use.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the pending tool to install" }),
    }),
  },
  {
    name: "list_custom_tools_tool",
    description: "List all installed and pending custom tools.",
    parameters: Type.Object({}),
  },
  {
    name: "delete_custom_tool_tool",
    description: "Permanently remove an installed custom tool.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the installed tool to delete" }),
    }),
  },
];
