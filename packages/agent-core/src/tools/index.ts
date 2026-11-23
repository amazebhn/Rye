/**
 * Tools index — aggregates all tool definitions and provides the executeTool dispatcher.
 * Imported by agent/loop.ts.
 */

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { codeSearchTools, listRepos, codeSearch, symbolSearch, stackTraceTool, logToSource, fileSearch } from "./code-search.js";
import { awsTools, cloudwatchSearch, cloudwatchListLogGroups, rdsListInstances, ecsListClusters, ecsListServices, ecsDescribeService, ecsListTasks, ec2ListInstances, albListLoadBalancers, albTargetHealth, s3ListBuckets, s3ListObjects, s3ReadObject } from "./aws.js";
import { mysqlTools, mysqlQuery, mysqlSchema, mysqlListDatabases } from "./mysql.js";
import { jiraTools, jiraTicket } from "./jira.js";
import { gitTools, gitLog, gitBlame } from "./git.js";
import { memoryTools, rememberFact, forgetFact, listMemories } from "./memory.js";
import { knowledgeTools, searchKnowledge, getKnowledge, saveKnowledge, deleteKnowledge } from "./knowledge.js";
import { agentTools, saveAgentTool } from "./agents.js";
import { subagentTools, spawnSubagents } from "./subagent.js";
import { askUserTools, ASK_USER_TOOL_NAME, askUserFallback } from "./ask-user.js";
import {
  customToolManagerTools,
  proposeTool,
  installTool,
  listCustomTools,
  deleteCustomTool,
  isCustomTool,
  executeCustomTool,
  getCustomToolDefs,
} from "./custom.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { AgentStore } from "../agents/store.js";
import type { SOPStore } from "../sop/store.js";
import type { SkillStore } from "../skill/store.js";
import { upsertPricing, readPricing } from "../usage/pricing.js";
import { queryResult, aggregateResult, storeOrInlineText } from "../results/query.js";
import type { Filter, Sort, AggregateOp } from "../results/query.js";
import { getMcpToolDefs, isMcpTool, callMcpTool } from "../mcp/client.js";
import { ADD_MCP_SERVER_TOOL_NAME, mcpManagerTools } from "./mcp-manager.js";
import { getSettings, getActiveEnv } from "../config.js";
import { getRunContext } from "../run-context.js";
import { skillTools, loadSkill, saveSkill, readSkillFile } from "./skills.js";
import { artifactTools, writeArtifact, readArtifact, WRITE_ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME } from "./artifacts.js";
import { RUN_SKILL_SCRIPT_TOOL_NAME, runSkillScriptTool } from "../skill/runner.js";
import type { ScriptApprovalToken } from "../skill/script-approval.js";

let _memoryStore: MemoryStore | undefined;
let _knowledgeStore: KnowledgeStore | undefined;
let _agentStore: AgentStore | undefined;
let _sopStore: SOPStore | undefined;
let _skillStore: SkillStore | undefined;

// Only the SOP editor sheet can render a draft diff, so direct chat applies edits immediately.
export function setSopDraftMode(enabled: boolean) {
  const ctx = getRunContext();
  if (ctx) ctx.sopDraftMode = enabled;
}

export function setMemoryStore(store: MemoryStore) {
  _memoryStore = store;
}

export function setKnowledgeStore(store: KnowledgeStore) {
  _knowledgeStore = store;
}

export function setAgentStore(store: AgentStore) {
  _agentStore = store;
}

export function setSopStore(store: SOPStore) {
  _sopStore = store;
}

export function setSkillStore(store: SkillStore) {
  _skillStore = store;
}

// ---------------------------------------------------------------------------
// Simple TTL cache for idempotent tool calls
// ---------------------------------------------------------------------------

interface CacheEntry { result: string; expiresAt: number; }
const toolCache = new Map<string, CacheEntry>();

// Tools that are safe to cache and their TTL in ms
const CACHE_TTL: Record<string, number> = {
  mysql_schema_tool: 24 * 60 * 60 * 1000,  // 24 hr — schema is stable between deploys
  mysql_list_databases_tool: 60 * 60 * 1000,  // 1 hr — database list rarely changes
  list_repos_tool:    7 * 24 * 60 * 60 * 1000,  // 7 days — static config
};

// Tools whose output is bulk text worth storing by reference when it gets big.
const STORE_LARGE_TEXT = new Set([
  "cloudwatch_search_tool",
  "code_search_tool",
  "file_search_tool",
]);

function cacheKey(name: string, args: Record<string, unknown>): string {
  // Cached results (e.g. MySQL schema) differ per environment.
  return `${getActiveEnv() ?? "default"}:${name}:${JSON.stringify(args)}`;
}

function cacheGet(name: string, args: Record<string, unknown>): string | undefined {
  const entry = toolCache.get(cacheKey(name, args));
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { toolCache.delete(cacheKey(name, args)); return undefined; }
  return entry.result;
}

function cacheSet(name: string, args: Record<string, unknown>, result: string, ttlMs: number) {
  toolCache.set(cacheKey(name, args), { result, expiresAt: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// All tools
// ---------------------------------------------------------------------------

// Static tools (always present)
const STATIC_TOOLS: Tool[] = [
  ...codeSearchTools,
  ...awsTools,
  ...mysqlTools,
  ...jiraTools,
  ...gitTools,
  ...memoryTools,
  ...knowledgeTools,
  ...agentTools,
  ...subagentTools,
  ...askUserTools,
  ...customToolManagerTools,
  ...mcpManagerTools,
  ...skillTools,
  ...artifactTools,
  {
    name: "save_sop_tool",
    description:
      "Save or update a Standard Operating Procedure (SOP) in the knowledge base. " +
      "If editing an existing SOP, you MUST pass the 'id' field so the existing record is updated instead of creating a duplicate. " +
      "Provide a concise title, a one-sentence description, and the full content in Markdown.",
    parameters: Type.Object({
      title: Type.String({ description: "Short descriptive title for the SOP." }),
      description: Type.String({ description: "One-sentence summary of when to use this SOP." }),
      content: Type.String({ description: "Full SOP content in Markdown, including steps, commands, and notes." }),
      id: Type.Optional(Type.Number({ description: "Existing SOP id to update. Omit when creating a brand-new SOP." })),
    }),
  },
  {
    name: "result_query_tool",
    description:
      "Filter, sort, select columns from, or page through a stored result set without loading it into context. " +
      "Large tool output (big SQL results, log dumps, search hits) is stored server-side and referenced by a result id like 'res_a1b2c3d4'. " +
      "Use this whenever the user wants to SEE records — 'show me', 'list them', 'which ones', 'what are they'. " +
      "Request a sensible page (10–50 rows) rather than everything.",
    parameters: Type.Object({
      result_id: Type.String({ description: "The stored result id, e.g. 'res_a1b2c3d4'." }),
      columns: Type.Optional(Type.Array(Type.String(), { description: "Subset of columns to return. Omit for all." })),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            column: Type.String(),
            op: Type.String({ description: "eq, ne, gt, gte, lt, lte, contains, not_contains, is_null, not_null" }),
            value: Type.Optional(Type.String()),
          }),
          { description: "Filters combined with AND." }
        )
      ),
      sort: Type.Optional(
        Type.Object({
          column: Type.String(),
          direction: Type.Optional(Type.String({ description: "asc or desc" })),
        })
      ),
      offset: Type.Optional(Type.Number({ description: "Rows to skip. Default 0." })),
      limit: Type.Optional(Type.Number({ description: "Max rows to return. Default 20, max 200." })),
    }),
  },
  {
    name: "result_aggregate_tool",
    description:
      "Compute an aggregate over a stored result set server-side, optionally grouped. " +
      "Use ONLY for genuinely quantitative questions — 'how many', 'total', 'average', 'breakdown by X'. " +
      "If the user asked to see the actual records, use result_query_tool instead; a count is not an answer to 'show me'.",
    parameters: Type.Object({
      result_id: Type.String({ description: "The stored result id, e.g. 'res_a1b2c3d4'." }),
      op: Type.String({ description: "count, sum, avg, min or max." }),
      column: Type.Optional(Type.String({ description: "Column to aggregate. Required for everything except count." })),
      group_by: Type.Optional(Type.String({ description: "Column to group by." })),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            column: Type.String(),
            op: Type.String(),
            value: Type.Optional(Type.String()),
          })
        )
      ),
      limit: Type.Optional(Type.Number({ description: "Max groups to return. Default 50." })),
    }),
  },
  {
    name: "set_model_pricing_tool",
    description:
      "Populate the model pricing table used for cost estimates in the Analytics panel. " +
      "Use this when the user pastes a pricing page, table, or any unstructured text containing model prices — " +
      "parse it yourself and pass normalised entries. Prices MUST be converted to USD per MILLION tokens " +
      "(e.g. $3 per 1M input = 3; $0.003 per 1K input = 3). Existing models are overwritten.",
    parameters: Type.Object({
      entries: Type.Array(
        Type.Object({
          model: Type.String({ description: "Model id as it appears in the model picker, e.g. 'claude-sonnet-4.5'." }),
          input_per_mtok: Type.Number({ description: "USD per 1,000,000 input tokens." }),
          output_per_mtok: Type.Number({ description: "USD per 1,000,000 output tokens." }),
          source: Type.Optional(Type.String({ description: "Where the price came from, e.g. a URL or 'Anthropic pricing page'." })),
        }),
        { description: "One entry per model." }
      ),
    }),
  },
  {
    name: "get_model_pricing_tool",
    description: "Show the current model pricing table used for cost estimates.",
    parameters: Type.Object({}),
  },
  {
    name: "load_sop_tool",
    description:
      "Load the full Markdown content of a saved SOP by its id. " +
      "The available SOPs (id + title + description) are listed in the system prompt under 'Available SOPs'. " +
      "Call this when a user's problem matches an SOP so you can follow its steps.",
    parameters: Type.Object({
      id: Type.Number({ description: "The id of the SOP to load (from the Available SOPs index)." }),
    }),
  },
  {
    name: "search_sops_tool",
    description:
      "Search the SOP knowledge base by topic and get back matching SOPs with their ids and summaries. " +
      "Use this when the conversation moves to a new problem and you want to check whether a runbook exists for it.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for, e.g. 'payment service timeouts'." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of SOPs to return. Defaults to 5." })),
    }),
  },
  {
    name: "switch_env_tool",
    description:
      "Switch the environment for this chat only. All connector tools (MySQL, AWS, Jira, Git) in this chat will immediately use the new environment's connection settings. " +
      "Use this only when the user asks to check a different environment (e.g. 'switch to prod', 'look at QA'); never call it for the environment that is already active. " +
      "After switching, confirm to the user which environment is now active. " +
      "Use 'default' to revert to the base configuration.",
    parameters: Type.Object({
      env_name: Type.String({
        description: "Environment key to activate (e.g. 'qa', 'prod') or 'default' to revert to base config. " +
          "The available environments are listed in the system prompt.",
      }),
    }),
  },
];

// Returns all tools including currently-active custom tools.
// Called by the agent loop on each run so newly-installed tools are visible.
export function getTools(): Tool[] {
  return [...STATIC_TOOLS, ...getCustomToolDefs(), ...getMcpToolDefs()];
}

// Keep TOOLS as a compat alias for code that reads it statically (e.g. subagent.ts)
export const TOOLS: Tool[] = STATIC_TOOLS;

// ---------------------------------------------------------------------------
// Pending SOP draft queue
// When save_sop_tool is called with an id, we don't immediately persist — instead
// we queue a draft event so the UI can show a diff and let the user approve.
// ---------------------------------------------------------------------------

export interface SopDraftEvent {
  type: "sop_draft";
  sop_id: number;
  title: string;
  proposed_content: string;
  original_content: string;
}

export interface ToolExecutionContext {
  sessionId?: string;
  /** Minted by the agent loop from a user approval; run_skill_script_tool refuses without it. */
  scriptApproval?: ScriptApprovalToken;
}

/** Drain and return all pending draft events (called by agent loop after each tool call). */
export function drainPendingDraftEvents(): SopDraftEvent[] {
  return getRunContext()?.pendingDraftEvents.splice(0) ?? [];
}

/** Pending drafts keyed by sop_id — used by the approve endpoint. */
const _pendingDrafts = new Map<number, { title: string; description?: string; content: string }>();

export function getPendingDraft(sopId: number) {
  return _pendingDrafts.get(sopId) ?? null;
}

export function clearPendingDraft(sopId: number) {
  _pendingDrafts.delete(sopId);
}

// ---------------------------------------------------------------------------
// Dispatcher — maps tool name → implementation function
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext = {},
): Promise<string> {
  const ttl = CACHE_TTL[name];
  if (ttl !== undefined) {
    const cached = cacheGet(name, args);
    if (cached !== undefined) return cached;
  }

  let result: string;
  switch (name) {
    // Code search
    case "list_repos_tool":
      result = await listRepos();
      break;
    case "code_search_tool":
      result = await codeSearch(args as Parameters<typeof codeSearch>[0]);
      break;
    case "symbol_search_tool":
      result = await symbolSearch(args as Parameters<typeof symbolSearch>[0]);
      break;
    case "stack_trace_tool":
      result = await stackTraceTool(args as Parameters<typeof stackTraceTool>[0]);
      break;
    case "log_to_source_tool":
      result = await logToSource(args as Parameters<typeof logToSource>[0]);
      break;    case "file_search_tool":
      result = fileSearch(args as Parameters<typeof fileSearch>[0]);
      break;
    // AWS
    case "cloudwatch_list_log_groups_tool":
      result = await cloudwatchListLogGroups(args as Parameters<typeof cloudwatchListLogGroups>[0]);
      break;
    case "cloudwatch_search_tool":
      result = await cloudwatchSearch(args as Parameters<typeof cloudwatchSearch>[0]);
      break;
    case "rds_list_instances_tool":
      result = await rdsListInstances(args as Parameters<typeof rdsListInstances>[0]);
      break;
    case "ecs_list_clusters_tool":
      result = await ecsListClusters(args as Parameters<typeof ecsListClusters>[0]);
      break;
    case "ecs_list_services_tool":
      result = await ecsListServices(args as Parameters<typeof ecsListServices>[0]);
      break;
    case "ecs_describe_service_tool":
      result = await ecsDescribeService(args as Parameters<typeof ecsDescribeService>[0]);
      break;
    case "ecs_list_tasks_tool":
      result = await ecsListTasks(args as Parameters<typeof ecsListTasks>[0]);
      break;
    case "ec2_list_instances_tool":
      result = await ec2ListInstances(args as Parameters<typeof ec2ListInstances>[0]);
      break;
    case "alb_list_load_balancers_tool":
      result = await albListLoadBalancers(args as Parameters<typeof albListLoadBalancers>[0]);
      break;
    case "alb_target_health_tool":
      result = await albTargetHealth(args as Parameters<typeof albTargetHealth>[0]);
      break;
    case "s3_list_buckets_tool":
      result = await s3ListBuckets(args as Parameters<typeof s3ListBuckets>[0]);
      break;
    case "s3_list_objects_tool":
      result = await s3ListObjects(args as Parameters<typeof s3ListObjects>[0]);
      break;
    case "s3_read_object_tool":
      result = await s3ReadObject(args as Parameters<typeof s3ReadObject>[0]);
      break;

    // MySQL
    case "mysql_query_tool":
      result = await mysqlQuery(args as Parameters<typeof mysqlQuery>[0], context.sessionId);
      break;
    case "mysql_schema_tool":
      result = await mysqlSchema(args as Parameters<typeof mysqlSchema>[0]);
      break;
    case "mysql_list_databases_tool":
      result = await mysqlListDatabases();
      break;

    // Jira
    case "jira_ticket_tool":
      result = await jiraTicket(args as Parameters<typeof jiraTicket>[0]);
      break;

    // Git
    case "git_log_tool":
      result = await gitLog(args as Parameters<typeof gitLog>[0]);
      break;
    case "git_blame_tool":
      result = await gitBlame(args as Parameters<typeof gitBlame>[0]);
      break;

    // Memory
    case "remember_tool":
      if (!_memoryStore) return "Memory store not initialised.";
      result = rememberFact(_memoryStore, args as Parameters<typeof rememberFact>[1]);
      break;
    case "forget_tool":
      if (!_memoryStore) return "Memory store not initialised.";
      result = forgetFact(_memoryStore, args as { key: string });
      break;
    case "list_memories_tool":
      if (!_memoryStore) return "Memory store not initialised.";
      result = listMemories(_memoryStore);
      break;

    // Knowledge Base (RAG)
    case "search_knowledge_tool":
      if (!_knowledgeStore) return "Knowledge store not initialised.";
      result = await searchKnowledge(_knowledgeStore, args as Parameters<typeof searchKnowledge>[1]);
      break;
    case "get_knowledge_tool":
      if (!_knowledgeStore) return "Knowledge store not initialised.";
      result = getKnowledge(_knowledgeStore, args as { id: string });
      break;
    case "save_knowledge_tool":
      if (!_knowledgeStore) return "Knowledge store not initialised.";
      result = await saveKnowledge(_knowledgeStore, args as Parameters<typeof saveKnowledge>[1]);
      break;
    case "delete_knowledge_tool":
      if (!_knowledgeStore) return "Knowledge store not initialised.";
      result = deleteKnowledge(_knowledgeStore, args as { id: string });
      break;

    // Custom Agents
    case "save_agent_tool":
      if (!_agentStore) return "Agent store not initialised.";
      result = saveAgentTool(_agentStore, args as Parameters<typeof saveAgentTool>[1]);
      break;

    // Subagents
    case "spawn_subagents_tool":
      result = await spawnSubagents(args as Parameters<typeof spawnSubagents>[0], context.sessionId);
      break;

    case ASK_USER_TOOL_NAME:
      result = askUserFallback();
      break;

    // SOP
    case "save_sop_tool": {
      console.log(`[save_sop_tool] called, _sopStore=${_sopStore ? "set" : "UNSET"}, title=${(args as { title?: string }).title}`);
      if (!_sopStore) return "SOP store not initialised.";
      const sopArgs = args as { title: string; description: string; content: string; id?: number };
      const runCtx = getRunContext();
      if (sopArgs.id && runCtx?.sopDraftMode) {
        // Don't save yet — queue a draft event so the user can review the diff first.
        const existing = _sopStore.get(sopArgs.id);
        if (!existing) return `No SOP found with id=${sopArgs.id}. Use save_sop_tool without an id to create a new one.`;
        _pendingDrafts.set(sopArgs.id, { title: sopArgs.title, description: sopArgs.description, content: sopArgs.content });
        runCtx.pendingDraftEvents.push({
          type: "sop_draft",
          sop_id: sopArgs.id,
          title: sopArgs.title,
          proposed_content: sopArgs.content,
          original_content: existing.content,
        });
        console.log(`[save_sop_tool] draft queued for id=${sopArgs.id}`);
        result = `Draft changes proposed for SOP id=${sopArgs.id} ("${sopArgs.title}"). The user will review the diff and approve or discard the changes.`;
      } else if (sopArgs.id) {
        const updated = await _sopStore.update(sopArgs.id, {
          title: sopArgs.title,
          description: sopArgs.description,
          content: sopArgs.content,
        });
        if (!updated) return `No SOP found with id=${sopArgs.id}. Use save_sop_tool without an id to create a new one.`;
        console.log(`[save_sop_tool] updated id=${sopArgs.id}`);
        result = `SOP updated with id=${sopArgs.id}: "${sopArgs.title}"`;
      } else {
        const sopId = await _sopStore.save({ title: sopArgs.title, description: sopArgs.description, content: sopArgs.content });
        console.log(`[save_sop_tool] saved id=${sopId}`);
        result = `SOP saved with id=${sopId}: "${sopArgs.title}"`;
      }
      break;
    }

    case "result_query_tool": {
      const a = args as {
        result_id: string; columns?: string[];
        filters?: Filter[]; sort?: Sort; offset?: number; limit?: number;
      };
      result = queryResult(a, context.sessionId);
      break;
    }

    case "result_aggregate_tool": {
      const a = args as {
        result_id: string; op: AggregateOp; column?: string;
        group_by?: string; filters?: Filter[]; limit?: number;
      };
      result = aggregateResult(a, context.sessionId);
      break;
    }

    case "set_model_pricing_tool": {
      const { entries } = args as { entries: Array<{ model: string; input_per_mtok: number; output_per_mtok: number; source?: string }> };
      const { saved, skipped } = upsertPricing(entries ?? []);
      result =
        `Saved pricing for ${saved.length} model(s): ${saved.join(", ") || "none"}.` +
        (skipped.length > 0 ? ` Skipped ${skipped.length} invalid entr(ies): ${skipped.join(", ")}.` : "");
      break;
    }

    case "get_model_pricing_tool": {
      const table = readPricing();
      const models = Object.keys(table);
      result =
        models.length === 0
          ? "No model pricing configured yet. Paste a pricing table and I can populate it with set_model_pricing_tool."
          : models
              .map((m) => `- ${m}: $${table[m].input_per_mtok}/Mtok in, $${table[m].output_per_mtok}/Mtok out${table[m].source ? ` (${table[m].source})` : ""}`)
              .join("\n");
      break;
    }

    case "load_sop_tool": {
      if (!_sopStore) return "SOP store not initialised.";
      const { id } = args as { id: number };
      const sop = _sopStore.get(id);
      if (!sop) return `No SOP found with id=${id}. See the Available SOPs index in the system prompt for valid ids.`;
      result = `# ${sop.title}\n${sop.description ? `\n_${sop.description}_\n` : ""}\n${sop.content}`;
      break;
    }

    case "search_sops_tool": {
      if (!_sopStore) return "SOP store not initialised.";
      const { query, limit } = args as { query: string; limit?: number };
      const matches = await _sopStore.search(query, limit ?? 5);
      if (matches.length === 0) {
        result = `No SOPs matched "${query}". The Available SOPs index in the system prompt lists everything in the knowledge base.`;
      } else {
        result = matches
          .map((s) => `- [id ${s.id}] **${s.title}**${s.description ? ` — ${s.description}` : ""}`)
          .join("\n") + `\n\nCall load_sop_tool with an id to read the full runbook.`;
      }
      break;
    }

    // Skill
    case "save_skill_tool":
      if (!_skillStore) return "Skill store not initialised.";
      result = saveSkill(_skillStore, args);
      break;

    case "load_skill_tool":
      if (!_skillStore) return "Skill store not initialised.";
      result = loadSkill(_skillStore, args);
      break;

    case "read_skill_file_tool":
      if (!_skillStore) return "Skill store not initialised.";
      result = readSkillFile(_skillStore, args);
      break;

    case RUN_SKILL_SCRIPT_TOOL_NAME:
      if (!_skillStore) return "Skill store not initialised.";
      result = await runSkillScriptTool(_skillStore, args, context.scriptApproval, getRunContext()?.signal);
      break;

    case WRITE_ARTIFACT_TOOL_NAME:
      result = writeArtifact(args, context.sessionId);
      break;
    case READ_ARTIFACT_TOOL_NAME:
      result = readArtifact(args, context.sessionId);
      break;

    // Environment switcher — scoped to the current run, never the global default.
    case "switch_env_tool": {
      const { env_name } = args as { env_name: string };
      const base = getSettings();
      const availableKeys = Object.keys(base.environments);
      const available = ["default", ...availableKeys].join(", ");
      const runCtx = getRunContext();
      const current = getActiveEnv() ?? "default";
      if (!runCtx) {
        result = "Environment switching is only available inside a chat run. No change made.";
      } else if (env_name !== "default" && !Object.hasOwn(base.environments, env_name)) {
        result = `Unknown environment "${env_name}". Available: ${available}. No change made.`;
      } else if (env_name === current) {
        const displayName = env_name === "default" ? "default" : base.environments[env_name]?.name ?? env_name;
        result = `Already on ${displayName} (key: ${env_name}). No change made.`;
      } else if (env_name === "default") {
        runCtx.envKey = null;
        result = `Switched to default environment (base config). Available: ${available}.`;
      } else {
        runCtx.envKey = env_name;
        const displayName = base.environments[env_name]?.name ?? env_name;
        const overrides = Object.keys(base.environments[env_name] ?? {}).filter(k => k !== "name");
        result = `Switched to environment "${displayName}" (key: ${env_name}). Active overrides: ${overrides.join(", ") || "none"}.`;
      }
      break;
    }

    // Custom tool manager
    case "propose_tool_tool":
      result = proposeTool(args as Parameters<typeof proposeTool>[0]);
      break;
    case "install_tool_tool":
      result = installTool(args as Parameters<typeof installTool>[0]);
      break;
    case "list_custom_tools_tool":
      result = listCustomTools();
      break;
    case "delete_custom_tool_tool":
      result = deleteCustomTool(args as Parameters<typeof deleteCustomTool>[0]);
      break;
    case ADD_MCP_SERVER_TOOL_NAME:
      // The main loop intercepts this tool to bind installation to a user
      // confirmation. Subagents and direct dispatcher calls may not install.
      result = "MCP server installation requires confirmation in the main conversation.";
      break;

    default:
      // Check dynamically-installed custom tools
      if (isCustomTool(name)) {
        result = await executeCustomTool(name, args);
        break;
      }
      if (isMcpTool(name)) {
        result = await callMcpTool(name, args);
        break;
      }
      return `Unknown tool: ${name}`;
  }

  // Bulk text output is kept server-side so it costs context once, not on
  // every subsequent LLM call in the session.
  if (STORE_LARGE_TEXT.has(name)) {
    result = storeOrInlineText(name, JSON.stringify(args), result, context.sessionId);
  }

  if (ttl !== undefined) cacheSet(name, args, result, ttl);
  return result;
}
