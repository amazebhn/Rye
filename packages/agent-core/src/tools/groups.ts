/**
 * Tool groups — only `core` is sent on every model call; other groups load on
 * demand (selector at run start, or the agent calling load_tools_tool).
 */

import type { Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getTools } from "./index.js";
import { getCustomToolDefs } from "./custom.js";
import { parseToolName } from "../mcp/client.js";

export const CORE_GROUP = "core";
export const SQL_GROUP = "sql";
/** Former group ids → current ones. The SQL group was "mysql" when MySQL was the only engine. */
export const GROUP_ALIASES: Record<string, string> = { mysql: SQL_GROUP };
export const LOAD_TOOLS_TOOL_NAME = "load_tools_tool";
const MCP_GROUP_PREFIX = "mcp:";

export interface ToolGroup {
  id: string;
  description: string;
  tools: Tool[];
}

const STATIC_GROUPS: Array<{ id: string; description: string; tools: string[] }> = [
  {
    id: CORE_GROUP,
    description: "always loaded",
    tools: [
      "ask_user_tool",
      "remember_tool",
      "forget_tool",
      "list_memories_tool",
      "search_knowledge_tool",
      "get_knowledge_tool",
      "save_knowledge_tool",
      "delete_knowledge_tool",
      "load_sop_tool",
      "search_sops_tool",
      "load_skill_tool",
      "read_skill_file_tool",
      "run_skill_script_tool",
      "switch_env_tool",
      "spawn_subagents_tool",
    ],
  },
  { id: SQL_GROUP, description: "SQL databases (MySQL, PostgreSQL): queries, schema, connections", tools: ["sql_query_tool", "sql_schema_tool", "sql_list_databases_tool"] },
  {
    id: "aws",
    description: "CloudWatch logs, RDS, ECS, EC2, ALB, S3",
    tools: [
      "cloudwatch_list_log_groups_tool",
      "cloudwatch_search_tool",
      "rds_list_instances_tool",
      "ecs_list_clusters_tool",
      "ecs_list_services_tool",
      "ecs_describe_service_tool",
      "ecs_list_tasks_tool",
      "ec2_list_instances_tool",
      "alb_list_load_balancers_tool",
      "alb_target_health_tool",
      "s3_list_buckets_tool",
      "s3_list_objects_tool",
      "s3_read_object_tool",
    ],
  },
  { id: "jira", description: "Jira tickets", tools: ["jira_ticket_tool"] },
  { id: "git", description: "git log and blame", tools: ["git_log_tool", "git_blame_tool"] },
  {
    id: "code_search",
    description: "repo/code/symbol/file search, stack trace and log line to source",
    tools: ["list_repos_tool", "code_search_tool", "symbol_search_tool", "stack_trace_tool", "file_search_tool", "log_to_source_tool"],
  },
  { id: "results", description: "query/aggregate stored results (res_…)", tools: ["result_query_tool", "result_aggregate_tool"] },
  { id: "chats", description: "search and read the user's earlier conversations with Rye", tools: ["search_chats_tool", "read_chat_tool"] },
  { id: "sop_authoring", description: "save or update SOPs", tools: ["save_sop_tool"] },
  { id: "skills", description: "create or update Rye-owned Skills", tools: ["save_skill_tool"] },
  { id: "agents", description: "create or update custom Agents", tools: ["save_agent_tool"] },
  {
    id: "artifacts",
    description: "save downloadable files for the user: handoff docs, reports, Markdown, CSV exports, Word, JSON",
    tools: ["write_artifact_tool", "read_artifact_tool"],
  },
  {
    id: "custom_tools",
    description: "create and manage custom tools",
    tools: ["propose_tool_tool", "install_tool_tool", "list_custom_tools_tool", "delete_custom_tool_tool"],
  },
  { id: "admin", description: "model pricing, add MCP servers", tools: ["set_model_pricing_tool", "get_model_pricing_tool", "add_mcp_server_tool"] },
];

/** Group the given tools. Unknown built-ins land in core so nothing silently disappears. */
export function buildToolGroups(allTools: Tool[], customToolNames: Set<string> = new Set()): ToolGroup[] {
  const groups: ToolGroup[] = STATIC_GROUPS.map((g) => ({ id: g.id, description: g.description, tools: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const staticOwner = new Map(STATIC_GROUPS.flatMap((g) => g.tools.map((t) => [t, g.id] as const)));
  const installed: string[] = [];

  for (const tool of allTools) {
    const mcp = parseToolName(tool.name);
    let id: string;
    if (mcp) {
      id = MCP_GROUP_PREFIX + mcp.server;
      if (!byId.has(id)) {
        const group = { id, description: `MCP server "${mcp.server}"`, tools: [] };
        groups.push(group);
        byId.set(id, group);
      }
    } else if (customToolNames.has(tool.name)) {
      id = "custom_tools";
      installed.push(tool.name);
    } else {
      id = staticOwner.get(tool.name) ?? CORE_GROUP;
    }
    byId.get(id)!.tools.push(tool);
  }

  for (const g of groups) {
    if (g.id.startsWith(MCP_GROUP_PREFIX)) g.description += ` (${g.tools.length} tools)`;
  }
  if (installed.length > 0) byId.get("custom_tools")!.description += `; installed: ${installed.join(", ")}`;

  const nonEmpty = groups.filter((g) => g.id === CORE_GROUP || g.tools.length > 0);
  nonEmpty.find((g) => g.id === CORE_GROUP)!.tools.push(loadToolsToolDef(nonEmpty));
  return nonEmpty;
}

/** Groups for the live tool registry (built-ins, installed custom tools, connected MCP servers). */
export function getToolGroups(): ToolGroup[] {
  return buildToolGroups(getTools(), new Set(getCustomToolDefs().map((t) => t.name)));
}

/** "mysql (MySQL queries, …), aws (…)" — every group except core. */
export function formatGroupList(groups: ToolGroup[]): string {
  return groups
    .filter((g) => g.id !== CORE_GROUP)
    .map((g) => `${g.id} (${g.description})`)
    .join(", ");
}

function loadToolsToolDef(groups: ToolGroup[]): Tool {
  return {
    name: LOAD_TOOLS_TOOL_NAME,
    description:
      "Enable more tool groups for the rest of this conversation; their tools become callable from your next step. " +
      `Groups: ${formatGroupList(groups)}.`,
    parameters: Type.Object({
      groups: Type.Array(Type.String(), { description: 'Group names to enable, e.g. ["mysql", "aws"].' }),
    }),
  };
}

/** Core plus the enabled groups, in stable group order so the request prefix stays cacheable. */
export function toolsForGroups(groups: ToolGroup[], enabled: Iterable<string>): Tool[] {
  const on = new Set(enabled);
  return groups.filter((g) => g.id === CORE_GROUP || on.has(g.id)).flatMap((g) => g.tools);
}

/** Exactly the listed groups' tools, for low-context agents: `core` only if listed, and no load_tools_tool. */
export function toolsForExactGroups(groups: ToolGroup[], enabled: Iterable<string>): Tool[] {
  const on = new Set(enabled);
  return groups
    .filter((g) => on.has(g.id))
    .flatMap((g) => g.tools)
    .filter((t) => t.name !== LOAD_TOOLS_TOOL_NAME);
}

export function groupOfTool(groups: ToolGroup[], toolName: string): string | undefined {
  return groups.find((g) => g.tools.some((t) => t.name === toolName))?.id;
}

/** Map requested names to group ids; accepts a bare MCP server name or a tool name too. */
export function resolveGroupNames(groups: ToolGroup[], requested: string[]): { enabled: string[]; unknown: string[] } {
  const ids = new Set(groups.map((g) => g.id));
  const enabled = new Set<string>();
  const unknown: string[] = [];
  for (const raw of requested) {
    // Names saved before a rename (agents store their groups) still mean the same group.
    const name = GROUP_ALIASES[String(raw).trim().toLowerCase()] ?? String(raw).trim();
    const lower = name.toLowerCase();
    const id = ids.has(lower)
      ? lower
      : ids.has(name)
        ? name
        : ids.has(MCP_GROUP_PREFIX + name)
          ? MCP_GROUP_PREFIX + name
          : groupOfTool(groups, name);
    if (id && id !== CORE_GROUP) enabled.add(id);
    else if (!id) unknown.push(name);
  }
  return { enabled: [...enabled], unknown };
}

/** Groups this history already used: tools it called and groups it loaded. */
export function groupsUsedInHistory(history: Message[], groups: ToolGroup[]): string[] {
  const used = new Set<string>();
  for (const msg of history) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;
      if (block.name === LOAD_TOOLS_TOOL_NAME) {
        const requested = (block.arguments as { groups?: unknown }).groups;
        if (Array.isArray(requested)) resolveGroupNames(groups, requested.map(String)).enabled.forEach((g) => used.add(g));
        continue;
      }
      const id = groupOfTool(groups, block.name);
      if (id && id !== CORE_GROUP) used.add(id);
    }
  }
  return [...used];
}

// ---------------------------------------------------------------------------
// Per-session memory of enabled groups (in-memory; history-derived groups cover restarts)
// ---------------------------------------------------------------------------

const sessionGroups = new Map<string, Set<string>>();

export function getRememberedToolGroups(sessionId: string): string[] {
  return [...(sessionGroups.get(sessionId) ?? [])];
}

export function rememberToolGroups(sessionId: string, groups: Iterable<string>): void {
  const set = sessionGroups.get(sessionId) ?? new Set<string>();
  for (const g of groups) set.add(g);
  sessionGroups.set(sessionId, set);
}

export function forgetToolGroups(sessionId: string): void {
  sessionGroups.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Selection — pluggable; the runner always adds core and fails open to every group.
// ---------------------------------------------------------------------------

export interface ToolGroupSelectionInput {
  userMessage: string;
  history: Message[];
  /** Optional groups (core is always sent). */
  availableGroups: ToolGroup[];
  previouslyEnabled: string[];
  /** Mode instructions from the UI, e.g. SOP or Skill editing. */
  systemPromptSuffix?: string;
  sessionId?: string;
}

/** Returns the group ids to enable besides core. */
export type ToolGroupSelector = (input: ToolGroupSelectionInput) => Promise<string[]>;

const KEYWORD_RULES: Record<string, RegExp[]> = {
  [SQL_GROUP]: [/\b(sql|mysql|postgres|postgresql|psql|pg|query|queries|tables?|databases?|db|schemas?|select|columns?|rows?)\b/i],
  aws: [/\b(aws|cloudwatch|logs?|log groups?|ecs|rds|ec2|alb|elb|load balancers?|target groups?|target health|clusters?|containers?|fargate|instances?)\b/i],
  jira: [/\b(jira|tickets?)\b/i, /\b[A-Z][A-Z0-9]+-\d+\b/],
  git: [/\b(git|commits?|branch(es)?|blame|repos?|repository|diff)\b/i],
  code_search: [
    /\b(code|codebase|source|repos?|repository|functions?|class|methods?|symbols?|stack ?traces?|traceback|exceptions?|log lines?)\b/i,
    /\bat [\w$.<>]+\([\w$.]+:\d+\)|\.(java|kt|py|ts|tsx|js|go|rb|php|cs|scala):\d+/,
  ],
  // References to something said or done before this chat.
  chats: [
    /\b(earlier|previous|prior|past|old|other|another|last)\s+(chats?|conversations?|threads?|sessions?|discussions?)\b/i,
    /\b(last time|the other day|a while (ago|back))\b/i,
    /\b(we|you|i)\s+(already\s+|previously\s+)?(discussed|talked about|spoke about|went over|looked (at|into)|decided|figured out|investigated)\b/i,
    /\b(chat|conversation) (history|search)\b|\bsearch (my|our|the) (chats?|conversations?|history)\b|\bremember when\b/i,
  ],
  sop_authoring: [/\b(sops?|runbooks?|playbooks?|procedures?)\b/i],
  skills: [/\bskills?\b/i],
  artifacts: [
    /\b(artifacts?|documents?|docx|word docs?|markdown|csv|spreadsheets?|exports?|downloadable|handoffs?|hand[- ]offs?|write[- ]?ups?)\b/i,
    /\b(md|json|text|txt|word)\s+files?\b/i,
    /\b(html|web ?pages?|dashboards?|charts?|visuali[sz]e|visuali[sz]ations?)\b/i,
  ],
  results: [/\bres_[a-z0-9]{8}\b/i],
  custom_tools: [/\bcustom tools?\b/i, /\b(create|make|build|write|install|delete|remove)\s+(?:(?:a|an|new|the|custom)\s+)*tools?\b/i],
  admin: [/\b(pricing|prices?|costs?|mcp|connectors?)\b/i],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function historyMentionsStoredResult(history: Message[]): boolean {
  return history.some((m) => {
    if (m.role === "toolResult") return m.content.some((c) => c.type === "text" && /\bres_[a-z0-9]{8}\b/i.test(c.text));
    return m.role === "user" && typeof m.content === "string" && /\bres_[a-z0-9]{8}\b/i.test(m.content);
  });
}

/** Conservative, deterministic: previous groups + obvious keyword, tool-name, or MCP-server matches. */
export const defaultToolGroupSelector: ToolGroupSelector = async ({
  userMessage,
  history,
  availableGroups,
  previouslyEnabled,
  systemPromptSuffix,
}) => {
  const text = `${userMessage}\n${systemPromptSuffix ?? ""}`;
  const picked = new Set(previouslyEnabled);

  for (const group of availableGroups) {
    if (KEYWORD_RULES[group.id]?.some((re) => re.test(text))) picked.add(group.id);
    if (group.tools.some((t) => text.includes(t.name))) picked.add(group.id);
    if (group.id.startsWith(MCP_GROUP_PREFIX)) {
      const server = group.id.slice(MCP_GROUP_PREFIX.length);
      const spaced = server.replace(/[-_]+/g, " ");
      const pattern = new RegExp(`\\b(${escapeRegExp(server)}|${escapeRegExp(spaced)})\\b`, "i");
      if (pattern.test(text)) picked.add(group.id);
    }
  }
  if (historyMentionsStoredResult(history)) picked.add("results");

  const available = new Set(availableGroups.map((g) => g.id));
  return [...picked].filter((id) => available.has(id));
};

let activeSelector: ToolGroupSelector = defaultToolGroupSelector;

export function setToolGroupSelector(selector: ToolGroupSelector): void {
  activeSelector = selector;
}

export function getToolGroupSelector(): ToolGroupSelector {
  return activeSelector;
}
