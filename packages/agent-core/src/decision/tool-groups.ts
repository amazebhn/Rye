/**
 * Tool-group selection via the decision model: one yes/no question per group,
 * unioned with the keyword selector so it can add groups but never drop them.
 */

import type { Message } from "@earendil-works/pi-ai";
import { getSettings, type Settings } from "../config.js";
import { stripTurnContext } from "../agent/turn-context.js";
import { getRunContext } from "../run-context.js";
import { UsageStore } from "../usage/store.js";
import {
  defaultToolGroupSelector,
  setToolGroupSelector,
  type ToolGroup,
  type ToolGroupSelectionInput,
  type ToolGroupSelector,
} from "../tools/groups.js";
import { decide } from "./index.js";
import type { Answers, DecisionUsage, Questions } from "./types.js";

const USER_MESSAGE_MAX_CHARS = 4000;
const HISTORY_MAX_CHARS = 1500;
const HISTORY_LINE_MAX_CHARS = 300;
const HISTORY_MAX_LINES = 8;

function log(level: "info" | "warn", msg: string) {
  console[level](`[${new Date().toISOString()}] [decision] [${level.toUpperCase()}] ${msg}`);
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Recent user/assistant text, newest kept first when trimming; tool outputs are left out. */
export function historyDigest(history: Message[], maxChars = HISTORY_MAX_CHARS): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0 && lines.length < HISTORY_MAX_LINES; i--) {
    const m = history[i];
    let line: string;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
      if (!text.trim()) continue;
      line = `User: ${stripTurnContext(text)}`;
    } else if (m.role === "assistant") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
      const tools = [...new Set(m.content.flatMap((b) => (b.type === "toolCall" ? [b.name] : [])))];
      if (!text && tools.length === 0) continue;
      line = `Assistant: ${text}${tools.length ? ` [called ${tools.join(", ")}]` : ""}`;
    } else continue;
    line = clip(line, HISTORY_LINE_MAX_CHARS);
    if (total + line.length > maxChars) break;
    lines.unshift(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

export function buildDecisionState(input: ToolGroupSelectionInput, enabled: string[]): Record<string, unknown> {
  const history = historyDigest(input.history);
  return {
    context: "A production-support agent investigates this user message with tools (logs, infra, databases, code, tickets).",
    user_message: input.userMessage.slice(0, USER_MESSAGE_MAX_CHARS),
    ...(history ? { recent_history: history } : {}),
    enabled_tool_groups: enabled,
  };
}

/** One noul question per group; ids are sanitised because Jev ids can't contain ':'. */
export function toolGroupQuestions(groups: ToolGroup[]): { questions: Questions; groupByQuestion: Map<string, string> } {
  const questions: Questions = {};
  const groupByQuestion = new Map<string, string>();
  for (const g of groups) {
    const base = g.id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 90) || "group";
    let id = base;
    for (let n = 2; questions[id]; n++) id = `${base}_${n}`;
    questions[id] = {
      type: "noul",
      instructions: `Does handling this message need the ${g.id} tools? (${clip(g.description, 300)})`,
    };
    groupByQuestion.set(id, g.id);
  }
  return { questions, groupByQuestion };
}

export function picksFromAnswers(answers: Answers, groupByQuestion: Map<string, string>, threshold: number): string[] {
  const picks: string[] = [];
  for (const [questionId, groupId] of groupByQuestion) {
    const a = answers[questionId];
    if (a?.type === "noul" && a.noul >= threshold) picks.push(groupId);
  }
  return picks;
}

export const unionSelection = (...lists: string[][]): string[] => [...new Set(lists.flat())];

/** Rejects after `ms`, aborting the work's signal; also aborts when `outer` does. */
export function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (outer?.aborted) ctrl.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([work(ctrl.signal), timeout]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  });
}

const usageStore = new UsageStore();

function recordDecisionUsage(u: DecisionUsage, sessionId: string): void {
  usageStore.record({
    kind: "llm",
    source: "decision",
    ts: Date.now(),
    sessionId,
    provider: u.provider,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    contextPct: u.contextWindow > 0 ? Math.round((u.inputTokens / u.contextWindow) * 100) : 0,
    contextWindow: u.contextWindow,
  });
}

export interface DecisionSelectorDeps {
  keyword?: ToolGroupSelector;
  decide?: typeof decide;
  settings?: () => Settings;
  recordUsage?: (usage: DecisionUsage, sessionId: string) => void;
}

/** Previously enabled ∪ keyword picks ∪ decision picks; on timeout/error the decision part is just skipped. */
export function createDecisionToolGroupSelector(deps: DecisionSelectorDeps = {}): ToolGroupSelector {
  const keyword = deps.keyword ?? defaultToolGroupSelector;
  const decideFn = deps.decide ?? decide;
  const loadSettings = deps.settings ?? getSettings;
  const record = deps.recordUsage ?? recordDecisionUsage;

  return async (input) => {
    const keywordPicks = await keyword(input);
    const settings = loadSettings();
    const { provider, timeout_ms, tool_threshold } = settings.decision;
    if (provider === "off") return keywordPicks;

    const enabled = unionSelection(input.previouslyEnabled, keywordPicks);
    const candidates = input.availableGroups.filter((g) => !enabled.includes(g.id));
    if (candidates.length === 0) return enabled;

    const started = Date.now();
    try {
      const { questions, groupByQuestion } = toolGroupQuestions(candidates);
      const answers = await withTimeout(
        (signal) =>
          decideFn(buildDecisionState(input, enabled), questions, {
            settings,
            signal,
            onUsage: (u) => record(u, input.sessionId ?? ""),
          }),
        timeout_ms,
        getRunContext()?.signal,
      );
      const picks = picksFromAnswers(answers, groupByQuestion, tool_threshold);
      log("info", `${provider} picked [${picks.join(", ")}] of ${candidates.length} candidate group(s) in ${Date.now() - started}ms`);
      return unionSelection(enabled, picks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `${provider} failed after ${Date.now() - started}ms, using keyword selection: ${msg}`);
      return enabled;
    }
  };
}

export const decisionToolGroupSelector = createDecisionToolGroupSelector();

/** Always installed; it checks the provider per call so Settings changes apply without a restart. */
export function installDecisionToolGroupSelector(): void {
  setToolGroupSelector(decisionToolGroupSelector);
}
