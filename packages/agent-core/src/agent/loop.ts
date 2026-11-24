/**
 * Agent loop — pi-ai based investigation loop.
 *
 * Structure mirrors pi-agent-core's approach:
 *   1. User message arrives
 *   2. Retrieve relevant SOPs and prepend to system prompt
 *   3. Call LLM with tools bound
 *   4. If the response contains tool calls → execute them → loop back to 3
 *   5. When the LLM responds with no tool calls → yield final text to caller
 *
 * No framework, no state machine. Just a loop.
 */

import {
  type Context,
  type Message,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getSettings } from "../config.js";
import type { Settings } from "../config.js";
import { invalidateCopilotToken } from "../copilot-auth.js";
import { apiKeyFor, models, resolveModel, type ResolvedModel } from "../llm-provider.js";
import { isHarnessToolEvent, type HarnessToolEvent } from "../harness/claude-sdk.js";
import { describeContentFilter, installCopilotFilterCapture } from "../copilot-filter.js";
import { resolveTaskModelId } from "../model-tiers.js";
import type { SOP } from "../sop/store.js";
import { TOOLS, executeTool, drainPendingDraftEvents, setMemoryStore, setKnowledgeStore, setSopStore, setSkillStore, setSopDraftMode } from "../tools/index.js";
import {
  CORE_GROUP,
  LOAD_TOOLS_TOOL_NAME,
  SQL_GROUP,
  forgetToolGroups,
  formatGroupList,
  getRememberedToolGroups,
  getToolGroupSelector,
  getToolGroups,
  groupOfTool,
  groupsUsedInHistory,
  rememberToolGroups,
  resolveGroupNames,
  toolsForExactGroups,
  toolsForGroups,
} from "../tools/groups.js";
import { LEGACY_MYSQL_NAME, describeConnections, listConnections } from "../db/connections.js";
import { ASK_USER_TOOL_NAME, normalizeAskUserArgs } from "../tools/ask-user.js";
import { installDecisionToolGroupSelector } from "../decision/tool-groups.js";
import { runSubagents } from "./subagent.js";
import { toolLimitMessage } from "./continue.js";
import { OLD_TOOL_RESULT_MAX_CHARS, shrinkOldToolResults } from "./trim.js";
import type { SOPStore } from "../sop/store.js";
import type { SkillStore } from "../skill/store.js";
import { MemoryStore } from "../memory/store.js";
import { meaningfulTokens } from "../knowledge/store.js";
import type { KnowledgeSearchHit, KnowledgeStore } from "../knowledge/store.js";
import { attachTurnContext, buildTurnContext, previousUserText, shownChunkKeys, stripTurnContext } from "./turn-context.js";
import type { AgentDefinition } from "../agents/store.js";
import { UsageStore } from "../usage/store.js";
import { estimateCost } from "../usage/pricing.js";
import { isMcpTool, isReadOnlyTool, parseToolName } from "../mcp/client.js";
import {
  isApproved,
  isDenied,
  setPending,
  resolvePending,
  clearPendingApproval,
  consumeApproval,
  APPROVE_ONCE,
  APPROVE_ALWAYS,
  APPROVE_READONLY,
  DENY,
} from "../mcp/approval.js";
import { getActiveEnv, getEffectiveSettings } from "../config.js";
import {
  ADD_MCP_SERVER_TOOL_NAME,
  CANCEL_ADD_MCP_SERVER,
  CONFIRM_ADD_MCP_SERVER,
  clearPendingMcpServerAddition,
  prepareMcpServerAddition,
  resolvePendingMcpServerAddition,
} from "../tools/mcp-manager.js";
import { getRunContext } from "../run-context.js";
import { RUN_SKILL_SCRIPT_TOOL_NAME, formatApprovalQuestion, planScriptRun, type ScriptPlan } from "../skill/runner.js";
import {
  clearScriptApprovals,
  expireScriptApprovals,
  gateScriptRun,
  resolvePendingScript,
  type ScriptApprovalToken,
} from "../skill/script-approval.js";

const CANCELLED_TOOL_RESULT = "Cancelled: the user stopped the response before this tool finished.";
const CANCELLED_NOTE =
  "[System] The user stopped the previous response before it finished. Don't resume that work unless they ask.";

// Every tool call needs a result, or the provider rejects the next request; give unanswered calls a cancelled result.
function closeOrphanToolCalls(messages: Message[]): void {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return;
  const answered = new Set(
    messages.slice(lastAssistant + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );
  for (const block of (messages[lastAssistant] as AssistantMessage).content) {
    if (block.type !== "toolCall" || answered.has(block.id)) continue;
    messages.push({
      role: "toolResult",
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: "text", text: CANCELLED_TOOL_RESULT }],
      isError: true,
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const usageStore = new UsageStore();
installCopilotFilterCapture();
installDecisionToolGroupSelector();

function log(level: "info" | "warn" | "error", msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [agent] [${level.toUpperCase()}]`;
  if (data !== undefined) {
    console[level](`${prefix} ${msg}`, data);
  } else {
    console[level](`${prefix} ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You are Rye, a production support AI agent. You help engineers investigate and resolve incidents, debug infrastructure issues, and build runbooks.

**CORE RULE — no guessing, no hypothesizing without evidence:**
Never state a conclusion, root cause, probable cause, or explanation as fact unless you have retrieved evidence from a tool call that supports it — not even "this is likely caused by X". If you have not yet called a tool, you do not yet know: when asked something you have no data for, say "I'll check" and make a tool call your first action — do not pre-answer, speculate, or offer likely explanations before looking. This applies even when the answer seems obvious; it is always better to run one more query than to speculate.

You have access to tools — use them to gather evidence before answering. When investigating:
1. **When the user's request is ambiguous** (e.g. environment unclear, service name not specified, time range vague), call **ask_user_tool** immediately to clarify before doing any investigation. Do NOT guess or proceed with assumptions when a quick question would save multiple wrong tool calls.
   - Use **prompt_type='choice'** when there are discrete options (e.g. "Which environment?" → ["production", "staging", "dev"]); set multi_select=true when several can apply
   - Use **prompt_type='yesno'** for binary confirmations
   - Use **prompt_type='text'** for open-ended clarification
   - Ask ONE question. Put what you found so far in your message text before the call; the \`question\` field holds only the question.
   - After calling ask_user_tool, stop — you will receive the answer as a follow-up message. Do not call any other tools in the same turn.
2. **For complex incidents with multiple independent angles** (e.g. check logs AND check ECS AND check DB), use **spawn_subagents_tool** to run up to 3 parallel investigations simultaneously. Each subagent is self-contained and has all tools.
3. Use tools sequentially when tasks depend on each other's results.
4. When given a stack trace, use stack_trace_tool immediately to locate the relevant source (code_search group)
5. When given a log line, use log_to_source_tool to find its origin (code_search group)
6. State your hypotheses and reasoning as you go — but clearly label them as hypotheses, not conclusions
7. Summarize your findings and recommend next steps — only after tool results support them
8. **Build durable memory**: when you discover stable system knowledge (service architectures, table relationships, deployment topologies, recurring quirks), save it with **save_knowledge_tool** so future chats don't have to re-investigate from scratch. For short always-on facts, acronyms, or custom domain terms, use **remember_tool**.

**IMPORTANT — reasoning discipline:**
Before EVERY tool call you MUST write at least one sentence explaining:
- What you are looking for and why
- What hypothesis you are testing
This reasoning must appear as plain text BEFORE the tool call, not after. Do not call tools silently.

**IMPORTANT — stored results:**
Large tool output (big SQL results, log dumps, search hits) is stored server-side and returned to you as a reference: a row count, the column list, a short preview, and an id like \`res_a1b2c3d4\`. The user already sees the full table in the UI — you do not need to reprint it.
- Do NOT ask the user to re-run the query to see more, and do not assume the preview is all the data.
- The result tools (results group) load automatically once a stored result appears.
- **Match the tool to what was actually asked.** If the user wants to SEE records — "show me", "what are they", "list them", "which ones" — call **result_query_tool** and show the rows. Do NOT answer a request for records with a count.
- Use **result_aggregate_tool** only when the question is genuinely quantitative: "how many", "what's the total", "what's the average", "what's the breakdown by X".
- When in doubt, show rows. A short table answers both kinds of question; a bare number answers only one.
- Never dump a whole stored result back into your reply. Summarise it, or show a small relevant slice.

When a user describes how they resolved an incident, offer to save it as a Standard Operating Procedure (SOP). To do so, call **save_sop_tool** (sop_authoring group) — do NOT use remember_tool for SOPs. SOPs are structured runbooks stored in a searchable knowledge base; memories are short key/value facts. Use the right tool:
- **save_sop_tool** → incident runbooks, step-by-step resolution guides, recurring issue playbooks
- **remember_tool** → short facts: hostnames, service names, contacts, credentials patterns, environment quirks

When the user asks about SOPs — what SOPs exist, to look at the SOPs, or to follow a runbook — use the SOP tools, **never list_memories_tool**. Memories and SOPs are separate stores:
- The **Available SOPs** index in this prompt lists every SOP with its id. Answer "what SOPs do you have?" from that index, not from memory.
- Call **load_sop_tool** with an id to read a full runbook before following it.
- Call **search_sops_tool** to find SOPs on a topic that comes up mid-conversation.

When the user asks you to edit, improve, or update an existing SOP (the SOP id will be provided in the context at the start of the conversation), you MUST call **save_sop_tool** with the **id** field set to the existing SOP's id. This updates the record in place instead of creating a duplicate. Never omit the id when editing an existing SOP.

**In SOP editing mode: do NOT write the revised SOP content as chat text.** Call **save_sop_tool** immediately with the full revised content — the user will see a diff and approve or discard it. Writing the SOP in chat instead of calling the tool is incorrect.

You have persistent memory across sessions. Use it proactively:
- Call **remember_tool** to save any useful facts you learn (hostnames, service owners, recurring patterns, on-call contacts, environment quirks).
- Save infrastructure specifics the user mentions: RDS instance identifiers, ECS cluster/service names, EC2 instance IDs or tags, ALB names, common CloudWatch log groups, database names, S3 buckets. This avoids the user repeating themselves.
- Call **list_memories_tool** when asked what you remember.
- Call **forget_tool** to remove stale facts.
Memories are automatically shown to you at the top of each session — you do not need to recall them manually.

A user message may end with a \`<rye_context>\` block. Rye adds it, not the user: it carries the current time and sometimes knowledge-base notes matching the message. Use it as background and don't mention the block itself.

Always format your responses in Markdown. Use tables, code blocks, and bullet lists where appropriate. Immediately precede every Markdown table with a short descriptive level-three heading (for example, \`### Rollout status\`) so the UI can use that heading as the table name.

**Charts:** when numbers over time or across categories are clearer as a picture, add a fenced code block with the language \`chart\` holding one JSON object: \`{"type":"bar","title":"Errors by service","x":"service","y":["errors"],"data":[{"service":"checkout","errors":42}]}\`. \`type\` is bar, line, area or scatter; \`x\` and \`y\` name columns; optional \`"stacked":true\`, \`"horizontal":true\` (bar) and \`"unit":"ms"\`. To plot a stored result, give \`"result_id":"res_…"\` instead of \`data\` so the rows don't pass through the conversation. Use at most 8 series on one scale and keep inline \`data\` under about 50 rows. The UI draws the chart with a table view, so don't repeat the same numbers as a table.

**Diagrams:** to show a flow, sequence, architecture, data model or timeline, add a fenced code block with the language \`mermaid\` (flowchart, sequenceDiagram, erDiagram, stateDiagram-v2, gantt). The UI draws it. Keep labels short and put any label containing punctuation in double quotes.

Be concise — short paragraphs or bullets. Avoid lengthy preambles or restating the question. Lead with the answer.

**Available connectors:** SQL databases (MySQL, PostgreSQL), AWS (CloudWatch, RDS, ECS, EC2, ALB), Jira, Git/Bitbucket, code search. Never say a connector or tool is unavailable — if its tools aren't loaded, load its group with **load_tools_tool**, then attempt the call and report the actual error if it fails.

**Custom tool creation** (custom_tools group): You can create new tools to improve your own capabilities. When you find yourself repeatedly doing the same transformation (e.g. reformatting a timestamp, grepping through tool output, converting bytes to MB), consider creating a custom tool:
1. Call **propose_tool_tool** with the tool name, description, parameter definitions, and a JS function body.
2. Immediately call **ask_user_tool** (type='yesno') to request the user's approval — include the tool name in your question.
3. Only call **install_tool_tool** if the user approves.
The code runs as a JS function body receiving \`args\` (your declared parameters as an object) and must return a string. No imports — use built-in JS globals only. Examples: format a date in a given timezone, grep/filter a multiline string, convert a JSON blob to a readable table.

**MCP server creation** (admin group): When the user asks to add or configure an MCP server, call **add_mcp_server_tool** with either a stdio command or a remote URL. For a remote server using OAuth, set \`auth="oauth"\`; Rye will provide an authorization link after installation. Never put literal secrets in the configuration; use \`\${ENV_VAR}\` references. The tool automatically pauses and shows the exact configuration and risks to the user. Do not separately call ask_user_tool for this operation.`;

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Explicit request model, else the model configured for the chat task. */
async function resolveModelId(settings: Settings, modelOverride?: string): Promise<string> {
  return modelOverride || resolveTaskModelId(settings, "chat");
}

// ---------------------------------------------------------------------------
// Session state — persisted to DATA_DIR/sessions/<id>.json
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { DATA_DIR } from "../config.js";
import { isSessionDeleted } from "../session/lifecycle.js";

const SESSIONS_DIR = join(DATA_DIR, "sessions");

// turnId links a user message to its chat bubble; summarizedTurnIds lists turns folded into a summary.
type TaggedMessage = Message & { turnId?: string; summarizedTurnIds?: string[] };

function ensureSessionsDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  // Sanitize to prevent path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return join(SESSIONS_DIR, `${safe}.json`);
}

export function getSession(sessionId: string): Message[] {
  try {
    const p = sessionPath(sessionId);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Message[];
    // Heal any sessions already persisted in a broken state.
    return repairToolPairing(parsed);
  } catch {
    return [];
  }
}

function syntheticToolResult(id: string, name: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: "[no result recorded — the previous run was interrupted]" }],
    isError: true,
    timestamp: Date.now(),
  } as Message;
}

/**
 * Enforce strict tool-call/tool-result pairing.
 * Providers reject a tool_result whose tool_use is missing (and vice versa)
 * with a 400, which otherwise wedges a session permanently.
 */
function repairToolPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  let pending = new Map<string, string>();

  const flushPending = () => {
    for (const [id, name] of pending) out.push(syntheticToolResult(id, name));
    pending.clear();
  };

  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const id = (msg as { toolCallId?: string }).toolCallId;
      if (!id || !pending.has(id)) continue; // orphaned result — drop it
      pending.delete(id);
      out.push(msg);
      continue;
    }

    flushPending();

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      pending = new Map(
        msg.content
          .filter((b): b is ToolCall => b.type === "toolCall")
          .map((b) => [b.id, b.name])
      );
    }
    out.push(msg);
  }

  flushPending();
  return out;
}

function saveSession(sessionId: string, messages: Message[]): void {
  try {
    if (isSessionDeleted(sessionId)) return;
    ensureSessionsDir();
    writeFileSync(sessionPath(sessionId), JSON.stringify(messages), "utf8");
  } catch (err) {
    log("warn", `failed to persist session ${sessionId}`, err);
  }
}

export function clearSession(sessionId: string): void {
  forgetToolGroups(sessionId);
  clearPendingApproval(sessionId);
  clearScriptApprovals(sessionId);
  try {
    const p = sessionPath(sessionId);
    if (existsSync(p)) rmSync(p);
  } catch {
    // ignore
  }
}

export interface RewindTurn {
  role: "user" | "assistant";
  content: string;
  id?: string;
}

const REBUILD_MAX_CHARS = 60_000;

/**
 * Rewind a session so it only holds the `kept` chat turns. Slices exactly when every
 * dropped turn is tagged and still verbatim; otherwise rebuilds context from `kept`.
 */
export function rewindSession(
  sessionId: string,
  kept: RewindTurn[],
  exact: boolean
): "sliced" | "rebuilt" | "unchanged" {
  clearPendingApproval(sessionId);
  clearScriptApprovals(sessionId);
  clearPendingMcpServerAddition(sessionId);

  const history = getSession(sessionId) as TaggedMessage[];
  const keptIds = new Set(kept.flatMap((t) => (t.role === "user" && t.id ? [t.id] : [])));
  const isDropped = (id: string) => !keptIds.has(id);
  const droppedWasSummarized = history.some((m) => m.summarizedTurnIds?.some(isDropped));

  if (exact && !droppedWasSummarized) {
    const cut = history.findIndex((m) => m.role === "user" && m.turnId !== undefined && isDropped(m.turnId));
    if (cut === -1) return "unchanged";
    saveSession(sessionId, history.slice(0, cut));
    return "sliced";
  }

  const transcript = kept
    .filter((t) => t.content.trim())
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.trim()}`)
    .join("\n\n")
    .slice(-REBUILD_MAX_CHARS);
  if (!transcript) {
    clearSession(sessionId);
    return "rebuilt";
  }
  const rebuilt: TaggedMessage = {
    role: "user",
    content: `[Context — the earlier part of this conversation, rebuilt from the chat transcript:]\n\n${transcript}\n\n[End of earlier conversation.]`,
    timestamp: Date.now(),
    summarizedTurnIds: [...keptIds],
  };
  saveSession(sessionId, [rebuilt]);
  return "rebuilt";
}

// ---------------------------------------------------------------------------
// Chat title generator
// Produces a short (3-6 word) title for a conversation given the first
// user message and assistant response.
// ---------------------------------------------------------------------------

export async function generateChatTitle(
  userMessage: string,
  assistantResponse: string
): Promise<string> {
  const settings = getSettings();
  const model = await resolveModel(settings, await resolveTaskModelId(settings, "labels"));
  const apiKey = await apiKeyFor(model);

  const prompt =
    `User message: ${userMessage.slice(0, 300)}\n\n` +
    `Assistant response: ${assistantResponse.slice(0, 300)}\n\n` +
    `Write a title for this conversation in 3-6 words. No punctuation, no quotes, title case. Just the title.`;

  try {
    const ctx: Context = {
      systemPrompt: "You generate short conversation titles. Output only the title, nothing else.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };
    const result = await models.complete(model, ctx, { apiKey });
    const textBlock = (result as AssistantMessage).content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    return text.replace(/^["'.]|["'.]$/g, "").slice(0, 80) || userMessage.slice(0, 60);
  } catch {
    return userMessage.slice(0, 60);
  }
}

// ---------------------------------------------------------------------------
// Edit suggestions
// Document-specific improvement prompts for the AI Editor, from a fast model.
// ---------------------------------------------------------------------------

export interface EditSuggestion {
  label: string;
  prompt: string;
}

export async function generateEditSuggestions(
  kind: "sop" | "skill",
  title: string,
  content: string,
  modelId?: string
): Promise<EditSuggestion[]> {
  const settings = getSettings();
  const model = await resolveModel(settings, modelId ?? (await resolveTaskModelId(settings, "doc_review")));
  const apiKey = await apiKeyFor(model);
  const noun = kind === "sop" ? "standard operating procedure (SOP)" : "agent Skill";

  const prompt =
    `Title: ${title.slice(0, 200)}\n\n` +
    `Content:\n${content.slice(0, 8000)}\n\n` +
    `Suggest 4 concrete improvements to this ${noun}, specific to what it actually says or is missing. ` +
    `Respond with only a JSON array of objects with "label" (2-3 words, sentence case, no punctuation) ` +
    `and "prompt" (one imperative sentence instructing an editor what to change).`;

  try {
    const ctx: Context = {
      systemPrompt: "You review operational documentation and suggest precise edits. Output only valid JSON.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };
    const result = await models.complete(model, ctx, { apiKey });
    const textBlock = (result as AssistantMessage).content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is EditSuggestion =>
        typeof s?.label === "string" && typeof s?.prompt === "string" && s.label.trim() !== "" && s.prompt.trim() !== "")
      .slice(0, 5)
      .map((s) => ({ label: s.label.trim().slice(0, 32), prompt: s.prompt.trim().slice(0, 240) }));
  } catch (err) {
    log("warn", "edit suggestion generation failed", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agent run — yields SSE-style event strings to the caller
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "session"; session_id: string }
  | { type: "iter_start" }
  | { type: "token"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; content: string }
  | { type: "usage"; input_tokens: number; output_tokens: number; context_pct: number; model: string; provider: string; cost_usd: number | null }
  | { type: "pause"; message: string; rounds: number }
  | { type: "prompt"; prompt_id: string; prompt_type: "yesno" | "choice" | "text"; question: string; options?: string[]; multi_select?: boolean }
  | { type: "iter_summary"; content: string }
  | { type: "sop_draft"; sop_id: number; title: string; proposed_content: string; original_content: string }
  | { type: "env_changed"; env_key: string; env_name: string }
  | { type: "done"; session_id: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Context summarization
// When the context fills past COMPACT_THRESHOLD, the middle of the conversation
// is summarized via an LLM call and replaced with a compact summary message.
// The first user message and the most recent KEEP_TAIL messages are always kept
// verbatim so the agent retains both the original goal and fresh tool results.
// ---------------------------------------------------------------------------

const COMPACT_THRESHOLD = 0.72; // summarize when input tokens exceed this fraction of contextWindow
const KEEP_TAIL = 6;            // number of recent messages to always preserve verbatim

const SUMMARIZE_SYSTEM = `You are a concise technical summarizer. You will be given a partial conversation between a user and a production support AI agent (Rye). Summarize what has been investigated so far:
- The original user question / incident description
- Key findings from tool calls (errors found, services implicated, data returned)
- Hypotheses that were ruled in or out
- Any conclusions or next steps already decided

Be thorough but compact. Use bullet points. Do NOT omit technical details like error messages, service names, stack frames, query results, or timestamps — those are essential context for continued investigation. Output only the summary, no preamble.`;

async function summarizeMessages(
  messages: Message[],
  model: ResolvedModel,
  apiKey: string
): Promise<string> {
  // Render the messages to plain text for the summarizer
  const transcript = messages
    .map((m) => {
      if (m.role === "user") return `USER: ${typeof m.content === "string" ? stripTurnContext(m.content) : m.content}`;
      if (m.role === "assistant") {
        const blocks = (m as AssistantMessage).content ?? [];
        const text = blocks
          .map((b) => {
            if (b.type === "text") return b.text;
            if (b.type === "toolCall") return `[tool: ${b.name}(${JSON.stringify(b.arguments)})]`;
            return "";
          })
          .filter(Boolean)
          .join(" ");
        return `ASSISTANT: ${text}`;
      }
      if (m.role === "toolResult") {
        const content = (m as { toolName?: string; content?: Array<{ text?: string }> });
        const text = content.content?.map((c) => c.text ?? "").join("") ?? "";
        return `TOOL(${content.toolName ?? "?"}): ${text.slice(0, 800)}${text.length > 800 ? "…" : ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const summarizeContext: Context = {
    systemPrompt: SUMMARIZE_SYSTEM,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  };

  try {
    const result = await models.complete(model, summarizeContext, { apiKey });
    const textBlock = (result as AssistantMessage).content.find((b) => b.type === "text");
    return textBlock && textBlock.type === "text" ? textBlock.text : transcript.slice(0, 2000);
  } catch (err) {
    log("warn", "summarization call failed, falling back to truncated transcript", err);
    return transcript.slice(0, 2000);
  }
}

async function compactMessages(
  messages: Message[],
  contextWindow: number,
  inputTokens: number,
  model: ResolvedModel,
  apiKey: string
): Promise<{ messages: Message[]; compacted: boolean }> {
  const pct = inputTokens / contextWindow;
  if (pct < COMPACT_THRESHOLD || messages.length <= KEEP_TAIL + 1) {
    return { messages, compacted: false };
  }

  // Never start the tail with a tool result — its originating tool call would
  // be summarized away, leaving an orphan the provider rejects with a 400.
  let cut = messages.length - KEEP_TAIL;
  while (cut < messages.length && messages[cut].role === "toolResult") cut++;

  const toSummarize = messages.slice(0, cut);
  const tail = messages.slice(cut);

  log("warn", `context at ${Math.round(pct * 100)}% — summarizing ${toSummarize.length} messages`);
  const summary = await summarizeMessages(toSummarize, model, apiKey);

  const sentinel: TaggedMessage = {
    role: "user",
    content: `[Context summary — the earlier part of this conversation has been summarized to save space:]\n\n${summary}\n\n[End of summary. The most recent messages follow verbatim.]`,
    timestamp: Date.now(),
    summarizedTurnIds: (toSummarize as TaggedMessage[]).flatMap((m) => [
      ...(m.summarizedTurnIds ?? []),
      ...(m.turnId ? [m.turnId] : []),
    ]),
  };

  return { messages: [sentinel, ...tail], compacted: true };
}

// ---------------------------------------------------------------------------
// Iteration summarizer
// Generates a short human-readable label for a completed tool-call iteration.
// Uses the same model as the main loop but with a tiny prompt — output is
// typically 5-12 words, e.g. "Searched CloudWatch logs, found 3 errors".
// ---------------------------------------------------------------------------

interface IterTool {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

async function summarizeIteration(
  tools: IterTool[],
  model: ResolvedModel,
  apiKey: string
): Promise<string> {
  if (tools.length === 0) return "";

  const lines = tools.map((t) => {
    const argSnippet = Object.entries(t.args)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
      .join(", ");
    const resultSnippet = t.result.slice(0, 120).replace(/\n/g, " ");
    return `- ${t.name}(${argSnippet}) → ${resultSnippet}`;
  });

  const prompt = `Summarize the following tool calls in ONE short phrase of 5–12 words. Focus on what was found or checked. Use backticks for filenames/queries. No preamble, just the phrase.\n\n${lines.join("\n")}`;

  try {
    const ctx: Context = {
      systemPrompt: "You are a concise summarizer. Output only the requested phrase, nothing else.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };
    const result = await models.complete(model, ctx, { apiKey });
    const textBlock = (result as AssistantMessage).content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    // Strip leading/trailing quotes the model sometimes adds
    return text.replace(/^["']|["']$/g, "");
  } catch {
    // Fallback: build a simple label from tool names
    return tools.map((t) => t.name.replace(/_tool$/, "").replace(/_/g, " ")).join(", ");
  }
}

export async function* runAgent(
  sessionId: string,
  userMessage: string,
  sopStore: SOPStore,
  memoryStore: MemoryStore,
  systemPromptSuffix?: string,
  skillStore?: SkillStore,
  modelOverride?: string,
  turnId?: string,
  knowledgeStore?: KnowledgeStore,
  agent?: AgentDefinition | null,
): AsyncGenerator<AgentEvent> {
  const settings = getSettings();
  log("info", `session=${sessionId} message="${userMessage.slice(0, 80)}"`);
  yield { type: "session", session_id: sessionId };

  // If the suffix declares a specific SOP edit id, extract it so we can force
  // any save_sop_tool call (even one that forgot the id) through the draft path.
  const sopEditIdMatch = systemPromptSuffix?.match(/SOP id:\s*(\d+)/);
  const sopEditId = sopEditIdMatch ? parseInt(sopEditIdMatch[1], 10) : undefined;
  setSopDraftMode(sopEditId !== undefined);

  // Skill edit mode: the UI names the skill ("Skill name: <folder>"); save_skill_tool without a name edits it in place.
  const skillEditName = systemPromptSuffix?.match(/Skill name:\s*([a-z0-9][a-z0-9._-]{0,63})/)?.[1];

  // Script approvals last one run: drop leftovers, then apply the user's answer to any pending prompt.
  expireScriptApprovals(sessionId);
  const scriptAnswer = resolvePendingScript(sessionId, userMessage);
  if (scriptAnswer) log("info", `skill script approval answer: ${scriptAnswer}`);
  // This turn may be the user answering an MCP approval prompt.
  const approvedTool = resolvePending(sessionId, userMessage);
  if (approvedTool) {
    log("info", `MCP approval answer "${userMessage.slice(0, 40)}" applied to ${approvedTool}`);
  }
  const mcpConfigDecision = await resolvePendingMcpServerAddition(sessionId, userMessage);
  if (mcpConfigDecision) log("info", mcpConfigDecision);

  // Make stores available to tool implementations
  setMemoryStore(memoryStore);
  if (knowledgeStore) setKnowledgeStore(knowledgeStore);
  setSopStore(sopStore);
  if (skillStore) setSkillStore(skillStore);

  const history = getSession(sessionId);

  const effectiveModelOverride = modelOverride || agent?.model || undefined;
  const model = await resolveModel(settings, await resolveModelId(settings, effectiveModelOverride));
  log("info", `using model ${model.id} via ${model.provider} @ ${model.baseUrl}${agent ? ` (agent=@${agent.slug})` : ""}`);
  const labelModel = await resolveModel(settings, await resolveTaskModelId(settings, "labels"));
  const compactionModel = await resolveModel(settings, await resolveTaskModelId(settings, "compaction"));

  // Only core tools plus the selected groups are sent; the agent can load more with load_tools_tool.
  // Selection may call the decision model, so it runs alongside the SOP search.
  const toolGroups = getToolGroups();
  const optionalGroups = toolGroups.filter((g) => g.id !== CORE_GROUP);
  // A low-context agent (skip_base_prompt) gets only its own instructions and exactly the tool groups
  // chosen for it: no automatic core group, no group selection, no on-demand loading.
  const leanAgent = agent?.skip_base_prompt === true;
  const groupSelection = Promise.resolve()
    .then(() =>
      leanAgent ? [] : getToolGroupSelector()({
        userMessage,
        history,
        availableGroups: optionalGroups,
        previouslyEnabled: [...new Set([...getRememberedToolGroups(sessionId), ...groupsUsedInHistory(history, toolGroups)])],
        systemPromptSuffix,
        sessionId,
      }),
    )
    .then(
      (picked) => new Set(resolveGroupNames(toolGroups, picked).enabled),
      (err) => {
        log("warn", "tool group selection failed, sending all tools", err);
        return new Set(optionalGroups.map((g) => g.id));
      },
    );

  // A low-context agent only sees Rye's stores (memory, knowledge, SOPs, skills) if it was given the core tools.
  const usesStores = !leanAgent || agent.tool_groups.includes(CORE_GROUP);

  // Look for knowledge-base notes matching this message, in parallel with tool group selection.
  // A short follow-up ("and in prod?") is searched together with the message before it, and
  // notes already shown in this conversation are not sent again.
  const knowledgeQuery =
    meaningfulTokens(userMessage).length === 0
      ? ""
      : meaningfulTokens(userMessage).length < 4
        ? `${previousUserText(history).slice(-400)} ${userMessage}`.trim()
        : userMessage;
  const knowledgeSearch: Promise<KnowledgeSearchHit[]> =
    knowledgeStore && usesStores && settings.context.auto_knowledge && knowledgeQuery
      ? knowledgeStore
          .searchForContext(knowledgeQuery, {
            limit: 3,
            agentId: agent?.id,
            exclude: shownChunkKeys(history),
            minSimilarity: settings.context.knowledge_min_similarity,
          })
          .catch((err) => {
            log("warn", "Knowledge search failed, continuing without it", err);
            return [];
          })
      : Promise.resolve([]);

  const [enabledGroups, relevantKnowledge] = await Promise.all([groupSelection, knowledgeSearch]);
  if (agent && agent.tool_groups.length > 0) {
    const { enabled } = resolveGroupNames(toolGroups, agent.tool_groups);
    for (const g of enabled) enabledGroups.add(g);
  }
  if (leanAgent && agent.tool_groups.includes(CORE_GROUP)) enabledGroups.add(CORE_GROUP);
  if (!leanAgent) rememberToolGroups(sessionId, enabledGroups);
  log("info", `tool groups: ${[...(leanAgent ? [] : [CORE_GROUP]), ...enabledGroups].join(", ") || "none"}${leanAgent ? " (low-context agent)" : ""}`);

  const skipBase = leanAgent;
  let systemPrompt = skipBase ? "" : BASE_SYSTEM_PROMPT;
  if (agent) {
    const desc = agent.description ? `\n_${agent.description}_\n` : "\n";
    systemPrompt += skipBase
      ? `You are ${agent.name} (@${agent.slug}).${desc}\n${agent.instructions}`
      : `\n\n---\n## Active Agent Persona: ${agent.name} (@${agent.slug})${desc}\nFollow these specialized instructions for this conversation while still adhering to Rye's evidence and tool-use discipline:\n\n${agent.instructions}`;

    // Resolve explicit [[sop:id|title]], [[skill:name]], and [[knowledge:id|title]] tags pinned in instructions
    const pinnedNotes: string[] = [];
    for (const m of agent.instructions.matchAll(/\[\[sop:(\d+)(?:\|[^\]]*)?\]\]/g)) {
      const sopId = Number(m[1]);
      const sop = sopStore.get(sopId);
      if (sop) {
        pinnedNotes.push(`- **SOP [id ${sop.id}] ${sop.title}** — call \`load_sop_tool(id=${sop.id})\` when relevant.`);
      }
    }
    if (skillStore) {
      for (const m of agent.instructions.matchAll(/\[\[skill:([a-zA-Z0-9._-]+)(?:\|[^\]]*)?\]\]/g)) {
        const skillName = m[1];
        const skill = skillStore.get(skillName);
        if (skill) {
          pinnedNotes.push(`- **Skill \`${skill.name}\`**${skill.description ? ` — ${skill.description}` : ""} — call \`load_skill_tool(name="${skill.name}")\` when relevant.`);
        }
      }
    }
    if (knowledgeStore) {
      for (const m of agent.instructions.matchAll(/\[\[knowledge:([a-zA-Z0-9_-]+)(?:\|[^\]]*)?\]\]/g)) {
        const docId = m[1];
        const doc = knowledgeStore.get(docId);
        if (doc) {
          const snippet = doc.content.length > 1500 ? `${doc.content.slice(0, 1500)}…` : doc.content;
          pinnedNotes.push(`- **Knowledge [${doc.id}] ${doc.title}**:\n${snippet}`);
        }
      }
    }
    if (pinnedNotes.length > 0) {
      systemPrompt += `\n\n### Referenced Resources for ${agent.name}\n${pinnedNotes.join("\n")}`;
    }
  }
  if (optionalGroups.length > 0 && !leanAgent) {
    systemPrompt += `\n\n**More tools:** only some tool groups are loaded. If you need a tool you don't have, call load_tools_tool with its group, then use it on your next step. Groups: ${formatGroupList(toolGroups)}.`;
  }

  if (model.provider === "claude" && (!leanAgent || enabledGroups.size > 0)) {
    // Under the Claude harness Rye's tools are MCP tools, so their names differ from the ones used above.
    systemPrompt +=
      "\n\n**Tool names:** the tools named above appear to you with an `mcp__rye__` prefix." +
      // ask_user_tool is a core tool, which a low-context agent only has when it was selected.
      (!leanAgent || enabledGroups.has(CORE_GROUP)
        ? " `mcp__rye__ask_user_tool` forwards questions and permission requests to the user, who may not see them otherwise, " +
          "so use it whenever you need their input or approval."
        : "") +
      (settings.claude.web_tools ? " Use WebSearch and WebFetch when you need current or external information." : "");
  }

  // Everything below goes in the system prompt and so should only change when the user changes
  // something (an environment switch, a saved memory, a new SOP). What changes every turn (the
  // time, knowledge found for this message) is attached to the user message instead; see turn-context.ts.

  // Inject active environment context
  const effectiveSettings = getEffectiveSettings();
  const activeEnvKey = getActiveEnv() ?? "default";
  const availableEnvKeys = ["default", ...Object.keys(effectiveSettings.environments)];
  const activeEnvEntry = activeEnvKey === "default" ? null : effectiveSettings.environments[activeEnvKey];
  const activeEnvName = activeEnvEntry?.name ?? activeEnvKey;
  const activeOverrides = activeEnvEntry ? Object.keys(activeEnvEntry).filter((k) => k !== "name") : [];
  systemPrompt += `\n\n---\n**Active environment for this chat:** ${activeEnvName} (key: ${activeEnvKey})${
    activeOverrides.length > 0 ? ` (overrides: ${activeOverrides.join(", ")})` : " (base config)"
  }\nThis is authoritative: all connector tools in this chat already use it, and the user can change it between turns from the UI. Do not call switch_env_tool for the environment that is already active; only call it when the user asks for a different one.\nAvailable environments: ${availableEnvKeys.join(", ")}`;

  // The databases this environment can reach, by name and engine (never credentials), so the agent
  // knows which `connection` to pass and which SQL dialect to write. Part of the environment block:
  // it changes only when the environment or the config does.
  const databases = listConnections(effectiveSettings).connections.filter((c) => c.name !== LEGACY_MYSQL_NAME || c.database);
  if (databases.length > 0 && (!leanAgent || enabledGroups.has(SQL_GROUP))) {
    systemPrompt += `\nDatabases in this environment (pass the name as \`connection\` to the SQL tools; write SQL in that engine's dialect):\n${describeConnections(databases)}`;
  }

  // Inject saved memories first so the agent treats them as ground truth
  const memoryBlock = usesStores ? memoryStore.formatForPrompt(agent?.id, settings.context.memory_budget_tokens) : "";
  if (memoryBlock) {
    log("info", `injecting saved memories (~${Math.ceil(memoryBlock.length / 4)} tokens)`);
    systemPrompt += `\n\n---\n${memoryBlock}`;
  }

  // Inject the skill index (progressive disclosure — full content loaded on demand)
  if (skillStore && usesStores) {
    const skillIndex = skillStore.formatIndexForPrompt();
    if (skillIndex) {
      log("info", `injecting skill index (${skillStore.list().length} skill(s))`);
      systemPrompt += `\n\n---\n${skillIndex}`;
    }
  }

  // Always list every SOP so newer ones aren't invisible when semantic search misses.
  const sopIndex = usesStores ? sopStore.formatIndexForPrompt() : "";
  if (sopIndex) {
    log("info", `injecting SOP index (${sopStore.list().length} SOP(s))`);
    systemPrompt += `\n\n---\n${sopIndex}`;
  }

  if (systemPromptSuffix) {
    systemPrompt += `\n\n---\n${systemPromptSuffix}`;
  }
  // The fingerprint should repeat from turn to turn; when it doesn't, the provider's prompt cache was lost.
  log("info", `system prompt ~${Math.ceil(systemPrompt.length / 4)} tokens, fingerprint ${Bun.hash(systemPrompt).toString(36)}`);

  // Append the new user message, with this turn's context after the user's own text.
  if (relevantKnowledge.length > 0) log("info", `attaching ${relevantKnowledge.length} knowledge note(s) to the message`);
  const turnContext = buildTurnContext({
    notes: mcpConfigDecision ? [`**MCP configuration result:** ${mcpConfigDecision}\nReport this result clearly to the user.`] : [],
    knowledge: knowledgeStore ? knowledgeStore.formatHitsForPrompt(relevantKnowledge) : "",
  });
  const newUserMessage: TaggedMessage = {
    role: "user",
    content: attachTurnContext(userMessage, turnContext),
    timestamp: Date.now(),
    ...(turnId ? { turnId } : {}),
  };
  const messages: Message[] = [...history, newUserMessage];

  const context: Context = {
    systemPrompt,
    messages,
    tools: leanAgent ? toolsForExactGroups(toolGroups, enabledGroups) : toolsForGroups(toolGroups, enabledGroups),
  };
  const enableGroups = (ids: string[]) => {
    // A low-context agent's tool set is fixed.
    if (leanAgent) return;
    const added = ids.filter((id) => id !== CORE_GROUP && !enabledGroups.has(id));
    if (added.length === 0) return;
    added.forEach((id) => enabledGroups.add(id));
    context.tools = toolsForGroups(toolGroups, enabledGroups);
    rememberToolGroups(sessionId, added);
    log("info", `enabled tool group(s): ${added.join(", ")}`);
  };

  // Stop in the UI disconnects the client, which aborts this signal (see POST /chat/).
  const signal = getRunContext()?.signal;
  const cancelled = () => signal?.aborted === true;
  // Stop waiting on work that can't itself be interrupted; its result is discarded.
  const untilCancelled = <T,>(work: Promise<T>): Promise<T> =>
    signal
      ? Promise.race([
          work,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error("Cancelled"));
            signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          }),
        ])
      : work;
  // Persist what happened so the next turn has a valid history and knows the reply was cut short.
  const finishCancelled = () => {
    closeOrphanToolCalls(context.messages);
    context.messages.push({ role: "user", content: CANCELLED_NOTE, timestamp: Date.now() });
    saveSession(sessionId, context.messages);
    log("info", `session=${sessionId} stopped by the user`);
  };

  // For copilot, fetch a fresh ephemeral Bearer so pi-ai passes auth validation.
  // The local proxy additionally injects the required Copilot-specific headers.
  let apiKey: string;
  try {
    apiKey = await apiKeyFor(model);
  } catch (err) {
    yield { type: "error", message: `Copilot auth failed: ${err instanceof Error ? err.message : String(err)}` };
    return;
  }
  // Label and compaction models may be served by a different provider than the chat model.
  const keyFor = (m: ResolvedModel) =>
    m.provider === model.provider ? Promise.resolve(apiKey) : apiKeyFor(m).catch(() => "");

  // Agent loop — keep going until the model stops calling tools
  const MAX_ITERATIONS = 10;
  const TOOL_TIMEOUT_MS = 60_000;
  const SUBAGENT_TIMEOUT_MS = 3 * 60_000; // subagents run their own loops — needs 3 min
  let iteration = 0;
  let finished = false;
  const calledToolSigs = new Set<string>(); // tracks ALL calls to catch cycles across iterations
  // Full output of large results, which later model calls only see truncated.
  const largeResults = new Map<string, string>();

  while (iteration < MAX_ITERATIONS) {
    if (cancelled()) {
      finishCancelled();
      return;
    }
    iteration++;
    log("info", `iteration ${iteration}/${MAX_ITERATIONS} — calling LLM`);
    yield { type: "iter_start" };
    const iterTools: IterTool[] = []; // collect tool calls for this iteration's summary

    // Also set via env so pi-ai's getEnvApiKey fallback works for github-copilot
    if (model.provider === "github-copilot") {
      process.env.COPILOT_GITHUB_TOKEN = apiKey;
    }
    // A long-running process can hold a bearer that VS Code silently rotated,
    // which Copilot rejects with 401/403. On such an error — before any tokens
    // were streamed — drop the cache, re-exchange, and retry the iteration once.
    const isAuthError = (m: string) =>
      model.provider === "github-copilot" && /\b(401|403)\b|unauthorized|forbidden/i.test(m);

    let s: AssistantMessageEventStream | undefined;
    let assistantMessage: AssistantMessage | undefined;
    let authRetried = false;
    // Old tool output is cut in the copy sent to the model; context.messages (persisted) keeps it whole.
    const requestContext: Context = { ...context, messages: shrinkOldToolResults(context.messages) };

    streamAttempt: while (true) {
      try {
        // The Claude harness keeps one live SDK session per chat, found by this id.
        s = models.stream(model, requestContext, { apiKey, signal, ...(model.provider === "claude" ? { sessionId } : {}) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", `stream() threw synchronously: ${msg}`);
        yield { type: "error", message: `LLM error: ${msg}` };
        return;
      }

      let emittedTokens = false;
      let authErr: string | null = null;
      let harnessToolsRunning = 0;

      try {
        for await (const event of s) {
          // Tools the harness ran itself (Claude Code's web search and fetch) show up as ordinary tool steps.
          if (isHarnessToolEvent(event as { type: string })) {
            const tool = event as unknown as HarnessToolEvent;
            emittedTokens = true;
            if (tool.type === "harness_tool_start") {
              harnessToolsRunning++;
              yield { type: "tool_start", name: tool.name, args: tool.args };
            } else {
              harnessToolsRunning = Math.max(0, harnessToolsRunning - 1);
              yield { type: "tool_result", name: tool.name, content: tool.isError ? `Error: ${tool.content}` : tool.content };
              // The model carries on in the same stream. Close the step the way a Rye tool round does, so the
              // text before the call files under it and what comes next streams in as a fresh part of the reply.
              if (harnessToolsRunning === 0) yield { type: "iter_start" };
            }
            continue;
          }
          const ev = event as AssistantMessageEvent;
          if (ev.type === "text_delta") {
            emittedTokens = true;
            yield { type: "token", content: ev.delta };
          } else if (ev.type === "error") {
            if (cancelled()) {
              finishCancelled();
              return;
            }
            const rawErr = ev.error.errorMessage ?? `stop_reason=${ev.reason}`;
            const errMsg = rawErr.includes("finish_reason: content_filter") ? await describeContentFilter() : rawErr;
            if (!authRetried && !emittedTokens && isAuthError(errMsg)) {
              authErr = errMsg;
              break;
            }
            log("error", `LLM stream error event: ${errMsg}`);
            yield { type: "error", message: errMsg };
            return;
          } else if (ev.type === "done") {
            log("info", `stream done, stop_reason=${ev.reason}, tokens=${ev.message.usage.totalTokens}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (cancelled()) {
          finishCancelled();
          return;
        }
        if (!authRetried && !emittedTokens && isAuthError(msg)) {
          authErr = msg;
        } else {
          log("error", `error iterating stream: ${msg}`, err);
          yield { type: "error", message: `LLM stream error: ${msg}` };
          return;
        }
      }

      if (authErr) {
        authRetried = true;
        log("warn", `Copilot auth rejected (${authErr}); refreshing token and retrying`);
        invalidateCopilotToken();
        try {
          apiKey = await apiKeyFor(model, true);
        } catch (err) {
          yield { type: "error", message: `Copilot auth failed: ${err instanceof Error ? err.message : String(err)}` };
          return;
        }
        continue streamAttempt;
      }

      break;
    }

    try {
      assistantMessage = await s!.result();
    } catch (err) {
      if (cancelled()) {
        finishCancelled();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `s.result() threw: ${msg}`);
      yield { type: "error", message: `LLM result error: ${msg}` };
      return;
    }

    // Emit usage stats for this iteration
    const inputTok = assistantMessage.usage.input;
    const outputTok = assistantMessage.usage.output;
    const contextPct = Math.round((inputTok / model.contextWindow) * 100);
    log("info", `usage: input=${inputTok} output=${outputTok} context=${contextPct}%`);
    usageStore.record({
      kind: "llm",
      ts: Date.now(),
      sessionId,
      provider: model.provider,
      model: model.id,
      inputTokens: inputTok,
      outputTokens: outputTok,
      contextPct,
      contextWindow: model.contextWindow,
    });
    yield {
      type: "usage",
      input_tokens: inputTok,
      output_tokens: outputTok,
      context_pct: contextPct,
      model: model.id,
      provider: model.provider,
      // null when the model has no entry in the pricing table; local Ollama models default to free.
      cost_usd: estimateCost(model.id, inputTok, outputTok) ?? (model.provider === "ollama" ? 0 : null),
    };

    context.messages.push(assistantMessage);
    if (cancelled()) {
      finishCancelled();
      return;
    }

    // Summarize context if approaching the window limit
    const { messages: compacted, compacted: didCompact } = await compactMessages(
      context.messages,
      model.contextWindow,
      assistantMessage.usage.input,
      compactionModel,
      await keyFor(compactionModel)
    );
    if (didCompact) {
      log("warn", `context summarized: ${context.messages.length} → ${compacted.length} messages`);
      context.messages = compacted;
    }

    // Check for tool calls
    const toolCalls = assistantMessage.content.filter(
      (b) => b.type === "toolCall"
    );

    log("info", `assistant responded — ${toolCalls.length} tool call(s), stopReason=${assistantMessage.stopReason}`);

    if (assistantMessage.stopReason !== "toolUse") {
      // Model finished — no more tool calls
      finished = true;
      break;
    }

    // Execute each tool call and push results back into context
    for (const block of toolCalls) {
      if (block.type !== "toolCall") continue;
      if (cancelled()) {
        finishCancelled();
        return;
      }
      log("info", `executing tool: ${block.name}`, block.arguments);

      // Guard: if the model calls the same tool with semantically identical args anywhere
      // in this session's run, inject a recovery prompt so the agent self-corrects.
      // Strip cosmetic-only args (e.g. context_lines) so bumping a display parameter
      // can't bypass the check.
      const COSMETIC_ARGS = new Set(["context_lines", "max_results", "limit", "offset"]);
      const normaliseArgs = (args: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(args).filter(([k]) => !COSMETIC_ARGS.has(k)));
      const thisSig = `${block.name}:${JSON.stringify(normaliseArgs(block.arguments as Record<string, unknown>))}`;
      if (calledToolSigs.has(thisSig)) {
        const earlier = largeResults.get(thisSig);
        const notice = earlier !== undefined
          ? `[Duplicate call] You already called ${block.name} with these arguments in this investigation; its full earlier result is repeated below (no new data). Don't call it again with the same arguments.\n\n${earlier}`
          : `[Duplicate call] You already called ${block.name} with these arguments earlier in this investigation and received a result. Repeating it will return the same data. Do not call this tool again with the same search — instead, reason from the results you already have, or try a meaningfully different query.`;
        log("warn", `dedup guard triggered for ${block.name} (seen earlier in run) — injecting recovery prompt`);
        yield { type: "tool_start", name: block.name, args: block.arguments as Record<string, unknown> };
        yield { type: "tool_result", name: block.name, content: notice };
        context.messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: notice }],
          isError: earlier === undefined,
          timestamp: Date.now(),
        });
        continue;
      }
      calledToolSigs.add(thisSig);

      yield { type: "tool_start", name: block.name, args: block.arguments as Record<string, unknown> };

      if (block.name === LOAD_TOOLS_TOOL_NAME) {
        const requested = (block.arguments as { groups?: unknown }).groups;
        const { enabled, unknown } = resolveGroupNames(toolGroups, Array.isArray(requested) ? requested.map(String) : []);
        enableGroups(enabled);
        const loaded = enabled.map((id) => `${id}: ${toolGroups.find((g) => g.id === id)!.tools.map((t) => t.name).join(", ")}`);
        const resultText = [
          ...(enabled.length === 0 ? ["Error: no valid tool group given."] : []),
          ...(loaded.length > 0 ? [`Enabled for the rest of this conversation (callable from your next step):\n${loaded.join("\n")}`] : []),
          ...(unknown.length > 0 ? [`Unknown group(s): ${unknown.join(", ")}. Available: ${optionalGroups.map((g) => g.id).join(", ")}.`] : []),
        ].join("\n");
        yield { type: "tool_result", name: block.name, content: resultText };
        context.messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: resultText }],
          isError: enabled.length === 0,
          timestamp: Date.now(),
        });
        iterTools.push({ name: block.name, args: block.arguments as Record<string, unknown>, result: resultText.slice(0, 200) });
        continue;
      }

      // Fail open: a call to a tool whose group isn't loaded still runs, and loads the group.
      const calledGroup = groupOfTool(toolGroups, block.name);
      if (calledGroup) enableGroups([calledGroup]);

      // Adding an MCP server changes executable/network configuration. The
      // model may only propose it; the next user response performs the write.
      if (block.name === ADD_MCP_SERVER_TOOL_NAME) {
        const prepared = prepareMcpServerAddition(
          sessionId,
          block.arguments as unknown as Parameters<typeof prepareMcpServerAddition>[1]
        );
        if (!prepared.ok) {
          const notice = `MCP server proposal rejected: ${prepared.error}`;
          yield { type: "tool_result", name: block.name, content: notice };
          context.messages.push({
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text: notice }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const placeholderText = "[Awaiting user approval to add the MCP server]";
        context.messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: placeholderText }],
          isError: false,
          timestamp: Date.now(),
        });
        saveSession(sessionId, context.messages);
        yield { type: "tool_result", name: block.name, content: placeholderText };
        yield {
          type: "prompt",
          prompt_id: crypto.randomUUID(),
          prompt_type: "choice",
          question: prepared.question,
          options: [CONFIRM_ADD_MCP_SERVER, CANCEL_ADD_MCP_SERVER],
        };
        yield { type: "done", session_id: sessionId };
        return;
      }

      // MCP tools are third-party and may have side effects, so the first use
      // in a session pauses for explicit user approval.
      if (isMcpTool(block.name) && !isApproved(sessionId, block.name)) {
        const parsed = parseToolName(block.name);

        if (isDenied(sessionId, block.name)) {
          const notice = `The user denied access to ${block.name} in this session. Do not call it again — find another approach or tell the user what you need.`;
          yield { type: "tool_result", name: block.name, content: notice };
          context.messages.push({
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text: notice }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        setPending(sessionId, block.name);
        const placeholderText = `[Awaiting user approval to run ${block.name}]`;
        context.messages.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: placeholderText }],
          isError: false,
          timestamp: Date.now(),
        });
        saveSession(sessionId, context.messages);

        log("info", `awaiting MCP approval for ${block.name} in session=${sessionId}`);
        yield { type: "tool_result", name: block.name, content: placeholderText };
        yield {
          type: "prompt",
          prompt_id: crypto.randomUUID(),
          prompt_type: "choice",
          question:
            `Allow the agent to run \`${parsed?.tool ?? block.name}\` from MCP server "${parsed?.server ?? "?"}"?` +
            `\n\nArguments: ${JSON.stringify(block.arguments)}`,
          options: isReadOnlyTool(block.name)
            ? [APPROVE_ONCE, APPROVE_ALWAYS, APPROVE_READONLY, DENY]
            : [APPROVE_ONCE, APPROVE_ALWAYS, DENY],
        };
        yield { type: "done", session_id: sessionId };
        return;
      }

      // Skill scripts run only with the user's approval of this exact run (skill, script, args, content),
      // asked every time; a granted approval becomes a one-shot token passed to the tool below.
      let scriptApproval: ScriptApprovalToken | undefined;
      if (block.name === RUN_SKILL_SCRIPT_TOOL_NAME) {
        let plan: ScriptPlan | undefined;
        let notice: string | undefined;
        if (!skillStore) {
          notice = "Error: Skill store not initialised.";
        } else {
          try {
            plan = planScriptRun(skillStore, block.arguments as Record<string, unknown>);
          } catch (err) {
            notice = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const gate = plan && notice === undefined ? gateScriptRun(sessionId, plan.fingerprint) : undefined;
        if (plan && gate?.action === "denied") {
          notice = `The user denied running ${plan.script} from skill ${plan.skill} with these arguments. Do not retry it — find another approach or tell the user what you need.`;
        }
        if (notice !== undefined || !plan || !gate) {
          const text = notice ?? "Error: could not plan the script run.";
          yield { type: "tool_result", name: block.name, content: text };
          context.messages.push({
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        if (gate.action === "ask") {
          const placeholderText = `[Awaiting user approval to run ${plan.script} from skill ${plan.skill}]`;
          context.messages.push({
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text: placeholderText }],
            isError: false,
            timestamp: Date.now(),
          });
          saveSession(sessionId, context.messages);
          log("info", `awaiting script approval for ${plan.skill}/${plan.script} in session=${sessionId}`);
          yield { type: "tool_result", name: block.name, content: placeholderText };
          yield {
            type: "prompt",
            prompt_id: crypto.randomUUID(),
            prompt_type: "choice",
            question: formatApprovalQuestion(plan),
            options: [APPROVE_ONCE, DENY],
          };
          yield { type: "done", session_id: sessionId };
          return;
        }
        if (gate.action === "run") scriptApproval = gate.token;
      }

      // Special handling: ask_user_tool pauses the agent and waits for user input.
      // We inject the question as a tool result, persist the session, then end the stream
      // so the frontend can display the prompt UI and resume on the next user message.
      if (block.name === ASK_USER_TOOL_NAME) {
        const promptArgs = normalizeAskUserArgs(block.arguments as Record<string, unknown>);
        if ("error" in promptArgs) {
          yield { type: "tool_result", name: block.name, content: promptArgs.error };
          context.messages.push({
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text: promptArgs.error }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }
        const promptId = crypto.randomUUID();

        // Build a placeholder tool result so the session history is valid
        const placeholderText = `[User was asked: "${promptArgs.question}" — awaiting response]`;
        const toolResultMsg: Message = {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: placeholderText }],
          isError: false,
          timestamp: Date.now(),
        };
        context.messages.push(toolResultMsg);

        // Persist session state NOW so the next runAgent call has the history
        saveSession(sessionId, context.messages);
        log("info", `ask_user_tool — pausing session=${sessionId} promptId=${promptId}`);

        yield { type: "tool_result", name: block.name, content: placeholderText };
        yield {
          type: "prompt",
          prompt_id: promptId,
          prompt_type: promptArgs.prompt_type,
          question: promptArgs.question,
          options: promptArgs.options,
          multi_select: promptArgs.multi_select,
        };
        yield { type: "done", session_id: sessionId };
        return;
      }

      // Special handling: spawn_subagents_tool — stream per-subagent progress events
      // and use a much longer timeout since subagents run their own multi-iteration loops.
      if (block.name === "spawn_subagents_tool") {
        const subArgs = block.arguments as { tasks: string[] };
        const progressLines: string[] = [];
        let resultText: string;
        try {
          const subagentTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Subagents timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`)), SUBAGENT_TIMEOUT_MS)
          );
          const run = runSubagents(subArgs.tasks, (progress) => {
            const label = `[subagent ${progress.agentIndex + 1}]`;
            if (progress.type === "iter_start") {
              log("info", `${label} iter_start`);
            } else if (progress.type === "tool_start") {
              const line = `${label} → ${progress.toolName}`;
              log("info", `${label} tool_start name=${progress.toolName}`);
              progressLines.push(line);
            } else if (progress.type === "tool_result") {
              log("info", `${label} tool_result name=${progress.toolName} len=${progress.content?.length ?? 0}`);
            } else if (progress.type === "error") {
              log("error", `${label} error: ${progress.content}`);
            }
          }, sessionId);
          const results = await untilCancelled(Promise.race([run, subagentTimeout]));
          resultText = results
            .map(({ task, result }, i) => `## Subagent ${i + 1}: ${task}\n\n${result}`)
            .join("\n\n---\n\n");
        } catch (err) {
          if (cancelled()) {
            finishCancelled();
            return;
          }
          resultText = `Subagent execution error: ${err instanceof Error ? err.message : String(err)}`;
          log("error", `spawn_subagents_tool threw`, err);
        }

        // Emit progress summary as a token so the user sees what tools were called
        if (progressLines.length > 0) {
          const progressSummary = `\n*Subagent tool calls: ${progressLines.join(", ")}*\n`;
          yield { type: "token", content: progressSummary };
        }

        log("info", `spawn_subagents_tool returned ${resultText.length} chars`);
        yield { type: "tool_result", name: block.name, content: resultText };

        const subagentResultMsg: Message = {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: resultText }],
          isError: false,
          timestamp: Date.now(),
        };
        context.messages.push(subagentResultMsg);
        iterTools.push({ name: block.name, args: block.arguments as Record<string, unknown>, result: resultText.slice(0, 200) });
        continue;
      }

      let resultText: string;
      let toolFailed = false;
      const toolStartedAt = Date.now();
      const envBefore = getActiveEnv();
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
        );
        // If we're in SOP-edit mode and the agent forgot to include the id, inject it.
        const toolArgs = block.arguments as Record<string, unknown>;
        if (block.name === "save_sop_tool" && sopEditId !== undefined && !toolArgs.id) {
          log("warn", `save_sop_tool called without id in SOP-edit session — injecting id=${sopEditId}`);
          toolArgs.id = sopEditId;
        }
        // Same for skill edit mode: without a name the tool would create a new skill instead of editing.
        if (block.name === "save_skill_tool" && skillEditName && !toolArgs.name) {
          log("warn", `save_skill_tool called without name in skill-edit session — injecting name=${skillEditName}`);
          toolArgs.name = skillEditName;
          delete toolArgs.id;
        }
        resultText = await untilCancelled(Promise.race([
          executeTool(block.name, toolArgs, { sessionId, scriptApproval }),
          timeout,
        ]));
        log("info", `tool ${block.name} returned ${resultText.length} chars`);
      } catch (err) {
        if (cancelled()) {
          finishCancelled();
          return;
        }
        toolFailed = true;
        resultText = `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
        log("error", `tool ${block.name} threw`, err);
      }

      usageStore.record({
        kind: "tool",
        ts: Date.now(),
        sessionId,
        tool: block.name,
        durationMs: Date.now() - toolStartedAt,
        isError: toolFailed,
      });

      if (isMcpTool(block.name)) consumeApproval(sessionId, block.name);

      yield { type: "tool_result", name: block.name, content: resultText };

      // Emit env_changed only when switch_env_tool actually changed this run's env
      if (block.name === "switch_env_tool" && getActiveEnv() !== envBefore) {
        const newEnvKey = getActiveEnv() ?? "default";
        const baseCfg = getEffectiveSettings();
        const newEnvEntry = newEnvKey === "default" ? null : baseCfg.environments[newEnvKey];
        yield { type: "env_changed", env_key: newEnvKey, env_name: newEnvEntry?.name ?? newEnvKey };
      }

      // Drain any SOP draft events queued by save_sop_tool
      for (const draftEv of drainPendingDraftEvents()) {
        yield draftEv;
      }

      const toolResultMessage: Message = {
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: "text", text: resultText }],
        isError: false,
        timestamp: Date.now(),
      };
      context.messages.push(toolResultMessage);
      if (resultText.length > OLD_TOOL_RESULT_MAX_CHARS) largeResults.set(thisSig, resultText);
      if (/\bres_[a-z0-9]{8}\b/i.test(resultText)) enableGroups(["results"]);
      iterTools.push({ name: block.name, args: block.arguments as Record<string, unknown>, result: resultText.slice(0, 200) });
    }

    // After each round of tool results, emit an LLM-generated summary of what was done.
    if (cancelled()) {
      finishCancelled();
      return;
    }
    if (iterTools.length > 0) {
      const summary = await summarizeIteration(iterTools, labelModel, await keyFor(labelModel));
      if (summary) yield { type: "iter_summary", content: summary };
    }

    // After each round of tool results, inject a synthesis check so the model
    // re-evaluates what it has before deciding whether to call more tools.
    context.messages.push({
      role: "user",
      content: `[System] You have completed iteration ${iteration} of tool use. Review ALL results above carefully.\n- If you have enough information to answer the user's question, do so now — do NOT call more tools.\n- If you genuinely need more information, state in one sentence exactly what is missing and why the above results don't cover it, then make at most ONE targeted follow-up tool call with a query you have NOT already tried.`,
      timestamp: Date.now(),
    });
  }

  // Persist updated message history (include the original user message + all turns)
  saveSession(sessionId, context.messages);
  log("info", `session=${sessionId} complete after ${iteration} iteration(s)`);

  // A reply that ends on the last allowed round is finished, not paused.
  if (!finished) {
    yield { type: "pause", message: toolLimitMessage(MAX_ITERATIONS), rounds: MAX_ITERATIONS };
  }

  yield { type: "done", session_id: sessionId };
}
