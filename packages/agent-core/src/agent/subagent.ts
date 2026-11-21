/**
 * Subagent runner — runs an isolated mini agent loop using complete() from pi-ai.
 *
 * Each subagent:
 *   - Receives a focused task description
 *   - Has access to all tools
 *   - Runs up to MAX_SUBAGENT_ITERS tool-call → result cycles
 *   - Returns a plain-text summary of its findings
 *
 * Multiple subagents can be run in parallel via Promise.allSettled.
 * Hard cap of MAX_CONCURRENT_SUBAGENTS to avoid token/rate exhaustion.
 */

import {
  type Context,
  type Message,
  type Tool,
  type AssistantMessage,
  type ToolResultMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getSettings } from "../config.js";
import { resolveTaskModelId } from "../model-tiers.js";
import { apiKeyFor, models, resolveModel } from "../llm-provider.js";
import { TOOLS, executeTool } from "../tools/index.js";
import { RUN_SKILL_SCRIPT_TOOL_NAME } from "../skill/runner.js";
import { getRunContext, runWithContext } from "../run-context.js";

// Subagents bypass the approval flow, so they never get the script runner.
// Built per call: tools/index.ts imports this module, so TOOLS isn't initialised at load time.
const subagentTools = () => TOOLS.filter((t) => t.name !== RUN_SKILL_SCRIPT_TOOL_NAME);

const MAX_SUBAGENT_ITERS = 6;
const MAX_CONCURRENT_SUBAGENTS = 3;
const TOOL_TIMEOUT_MS = 120_000;

export interface SubagentProgress {
  agentIndex: number; // 0-based
  task: string;
  type: "tool_start" | "tool_result" | "iter_start" | "done" | "error";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  content?: string;
}

// Semaphore — global across all sessions so we never flood the LLM
let running = 0;

const SUBAGENT_SYSTEM = `You are a focused investigative subagent. You have been given a single discrete task to complete.
- Use the available tools to gather information directly relevant to the task.
- Do not ask for clarification — make reasonable assumptions and proceed.
- When you have enough information, write a concise findings report.
- Lead with key facts: error messages, counts, service names, timestamps.
- Do not pad. If a tool returns no results, say so briefly.`;

/** Run a single subagent to completion. Returns its findings as a string. */
export async function runSubagent(
  task: string,
  onProgress?: (p: SubagentProgress) => void,
  agentIndex = 0,
  sessionId?: string,
): Promise<string> {
  if (running >= MAX_CONCURRENT_SUBAGENTS) {
    return `[subagent skipped — ${MAX_CONCURRENT_SUBAGENTS} already running]`;
  }
  running++;
  try {
    // Inherit the parent run's env, but keep a subagent's switch_env_tool local to it.
    const parent = getRunContext();
    const run = () => _run(task, onProgress, agentIndex, sessionId);
    return await (parent ? runWithContext({ ...parent }, run) : run());
  } finally {
    running--;
  }
}

async function _run(
  task: string,
  onProgress?: (p: SubagentProgress) => void,
  agentIndex = 0,
  sessionId?: string,
): Promise<string> {
  const cfg = getSettings();
  // Subagents keep a smaller output cap than the main loop.
  const resolved = await resolveModel(cfg, await resolveTaskModelId(cfg, "subagent"));
  const model = { ...resolved, maxTokens: resolved.provider === "github-copilot" ? 8192 : 16000 };
  const apiKey = await apiKeyFor(model);

  const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];
  const context: Context = {
    systemPrompt: SUBAGENT_SYSTEM,
    messages,
    tools: subagentTools() as Tool[],
  };

  for (let iter = 0; iter < MAX_SUBAGENT_ITERS; iter++) {
    // Subagents share the parent run's signal, so Stop ends them too.
    const signal = getRunContext()?.signal;
    if (signal?.aborted) return "[subagent cancelled]";
    onProgress?.({ agentIndex, task, type: "iter_start" });
    let result: AssistantMessage;
    try {
      result = await models.complete(model, context, { apiKey, signal });
    } catch (err) {
      const msg = `[subagent error: ${err instanceof Error ? err.message : String(err)}]`;
      onProgress?.({ agentIndex, task, type: "error", content: msg });
      return msg;
    }

    context.messages = [...context.messages, result];

    // Extract tool calls
    const toolCalls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
    if (toolCalls.length === 0) {
      // No more tool calls — extract final text
      const text = result.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      return text || "[subagent returned no text]";
    }

    // Execute tool calls and append results
    const toolResults: ToolResultMessage[] = [];
    await Promise.allSettled(
      toolCalls.map(async (tc) => {
        onProgress?.({ agentIndex, task, type: "tool_start", toolName: tc.name, toolArgs: tc.arguments as Record<string, unknown> });
        let output: string;
        try {
          const timer = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("Tool timeout")), TOOL_TIMEOUT_MS)
          );
          output = await Promise.race([
            executeTool(tc.name, tc.arguments as Record<string, unknown>, { sessionId }),
            timer,
          ]);
        } catch (err) {
          output = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        onProgress?.({ agentIndex, task, type: "tool_result", toolName: tc.name, content: output.slice(0, 300) + (output.length > 300 ? "…" : "") });
        toolResults.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: output }],
          isError: false,
          timestamp: Date.now(),
        });
      })
    );
    context.messages = [...context.messages, ...toolResults];
  }

  // Hit iteration limit — extract whatever text was last produced
  const allMsgs = context.messages;
  let lastMsg: AssistantMessage | undefined;
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    if (allMsgs[i].role === "assistant") { lastMsg = allMsgs[i] as AssistantMessage; break; }
  }
  const finalText = lastMsg?.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  return finalText
    ? `[max iterations reached]\n${finalText}`
    : "[subagent hit iteration limit with no text output]";
}

/** Run multiple subagents in parallel (capped at MAX_CONCURRENT_SUBAGENTS). */
export async function runSubagents(
  tasks: string[],
  onProgress?: (p: SubagentProgress) => void,
  sessionId?: string,
): Promise<Array<{ task: string; result: string }>> {
  const capped = tasks.slice(0, MAX_CONCURRENT_SUBAGENTS);
  const results = await Promise.allSettled(
    capped.map((t, i) => runSubagent(t, onProgress, i, sessionId))
  );
  return capped.map((task, i) => ({
    task,
    result: results[i].status === "fulfilled"
      ? results[i].value
      : `[error: ${(results[i] as PromiseRejectedResult).reason}]`,
  }));
}
