/**
 * Chat backend — asks any chat model Rye supports (Copilot or Ollama) to answer
 * decision questions as strict JSON, validated with zod.
 */

import { type AssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { Settings } from "../config.js";
import { apiKeyFor, models, resolveModel } from "../llm-provider.js";
import { resolveTierModelId } from "../model-tiers.js";
import { isClefModel } from "./clef.js";
import type { Answers, DecideOptions, DecisionUsage, Questions } from "./types.js";

const SYSTEM_PROMPT =
  "You are a decision model. Read the STATE, then answer every question in QUESTIONS. " +
  "Reply with only one JSON object (no prose, no code fences) with exactly one key per question id:\n" +
  "- yes/no questions: true or false\n" +
  "- choice questions: the chosen option id, as a string\n" +
  "- score questions: the integer index of the chosen level (0 = first level)";

/** Blank (or a Clef id left over from switching providers) means the low tier. */
export async function resolveChatDecisionModelId(settings: Settings): Promise<string> {
  const configured = settings.decision.model.trim();
  return configured && !isClefModel(configured) ? configured : resolveTierModelId(settings, "low");
}

export function buildChatPrompt(state: unknown, questions: Questions): string {
  const lines: string[] = [];
  const template: string[] = [];
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      lines.push(`- ${id} (yes/no): ${q.instructions}`);
      if (q.criteria?.true) lines.push(`  true: ${q.criteria.true}`);
      if (q.criteria?.false) lines.push(`  false: ${q.criteria.false}`);
      template.push(`"${id}": true | false`);
    } else if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      lines.push(`- ${id} (choice): ${q.instructions}`);
      for (const [opt, desc] of Object.entries(q.criteria)) lines.push(`  "${opt}"${desc ? `: ${desc}` : ""}`);
      template.push(`"${id}": ${options.map((o) => JSON.stringify(o)).join(" | ")}`);
    } else {
      lines.push(`- ${id} (score 0-${q.criteria.length - 1}): ${q.instructions}`);
      q.criteria.forEach((level, i) => lines.push(`  ${i}: ${level}`));
      template.push(`"${id}": 0..${q.criteria.length - 1}`);
    }
  }
  const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 1);
  return `STATE:\n${stateText}\n\nQUESTIONS:\n${lines.join("\n")}\n\nReply with only this JSON object:\n{${template.join(", ")}}`;
}

const boolish = z.preprocess(
  (v) => (v === "true" ? true : v === "false" ? false : v),
  z.union([z.boolean(), z.number().min(0).max(1)]),
);

export function chatAnswerSchema(questions: Questions) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") shape[id] = boolish;
    else if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      shape[id] = z.string().refine((v) => options.includes(v), { message: `must be one of ${options.join(", ")}` });
    } else shape[id] = z.number().int().min(0).max(q.criteria.length - 1);
  }
  return z.object(shape);
}

function extractJson(text: string): unknown {
  const visible = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = visible.indexOf("{");
  const end = visible.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the reply");
  try {
    return JSON.parse(visible.slice(start, end + 1));
  } catch {
    throw new Error("the reply is not valid JSON");
  }
}

/** Validate a chat reply and convert it to Jev-shaped answers (probabilities are 0/1). */
export function parseChatAnswers(text: string, questions: Questions): Answers {
  const parsed = chatAnswerSchema(questions).safeParse(extractJson(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "reply"}: ${i.message}`);
    throw new Error(issues.join("; "));
  }
  const answers: Answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const v = parsed.data[id] as boolean | number | string;
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: typeof v === "boolean" ? (v ? 1 : 0) : (v as number) };
    } else if (q.type === "choice") {
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === v ? 1 : 0]));
      answers[id] = { type: "choice", choice: v as string, confidence: 1, probabilities };
    } else {
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === v ? 1 : 0]));
      const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
      answers[id] = { type: "score", score: v as number, confidence: 1, legend, probabilities };
    }
  }
  return answers;
}

const textOf = (msg: AssistantMessage) =>
  msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");

export type ChatCall = (context: Context, maxTokens: number) => Promise<AssistantMessage>;

/** Ask, validate, re-ask once on an invalid reply, then fail. */
export async function runChatDecision(
  call: ChatCall,
  state: unknown,
  questions: Questions,
  onUsage?: (usage: Pick<DecisionUsage, "inputTokens" | "outputTokens">) => void,
): Promise<Answers> {
  const maxTokens = Math.min(1024, 64 + 24 * Object.keys(questions).length);
  const messages: Message[] = [{ role: "user", content: buildChatPrompt(state, questions), timestamp: Date.now() }];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call({ systemPrompt: SYSTEM_PROMPT, messages }, maxTokens);
    if (result.usage) onUsage?.({ inputTokens: result.usage.input, outputTokens: result.usage.output });
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage ?? `model call ${result.stopReason}`);
    }
    try {
      return parseChatAnswers(textOf(result), questions);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push(result, {
        role: "user",
        content: `That reply was invalid (${lastError}). Reply with only the JSON object.`,
        timestamp: Date.now(),
      });
    }
  }
  throw new Error(`decision model gave an invalid reply twice: ${lastError}`);
}

export async function chatDecide(
  settings: Settings,
  state: unknown,
  questions: Questions,
  opts: DecideOptions = {},
): Promise<Answers> {
  const model = await resolveModel(settings, await resolveChatDecisionModelId(settings));
  const apiKey = await apiKeyFor(model);
  return runChatDecision(
    (context, maxTokens) => models.complete(model, context, { apiKey, signal: opts.signal, temperature: 0, maxTokens }),
    state,
    questions,
    (usage) => opts.onUsage?.({ provider: model.provider, model: model.id, contextWindow: model.contextWindow, ...usage }),
  );
}
