/**
 * Decision model — answers typed questions (noul / choice / score) about a state.
 * Backends: "clef" (Jev/SystemOne endpoint) or "chat" (any chat model Rye supports).
 */

import { getSettings, type Settings } from "../config.js";
import { clefDecide, clefTarget, resolveClefModel } from "./clef.js";
import { chatDecide, resolveChatDecisionModelId } from "./chat.js";
import { ollamaDecide, resolveOllamaDecisionModel } from "./ollama.js";
import type { Answers, DecideOptions, Questions } from "./types.js";

export * from "./types.js";
export { CLEF_MODELS, clefTarget } from "./clef.js";
export { listOllamaDecisionModels, ollamaDecisionModelsOrEmpty, warmOllamaDecisionModel } from "./ollama.js";

export async function decide(
  state: unknown,
  questions: Questions,
  opts: DecideOptions & { settings?: Settings } = {},
): Promise<Answers> {
  if (Object.keys(questions).length === 0) return {};
  const settings = opts.settings ?? getSettings();
  switch (settings.decision.provider) {
    case "ollama":
      return ollamaDecide(settings, state, questions, opts);
    case "clef":
      return clefDecide(settings, state, questions, opts);
    case "chat":
      return chatDecide(settings, state, questions, opts);
    default:
      throw new Error("decision model is off");
  }
}

/** The model the current provider would use ("" when off). */
export async function resolveDecisionModelId(settings: Settings): Promise<string> {
  if (settings.decision.provider === "ollama") return resolveOllamaDecisionModel(settings);
  if (settings.decision.provider === "clef") return resolveClefModel(settings.decision.model);
  if (settings.decision.provider === "chat") return resolveChatDecisionModelId(settings);
  return "";
}

export function clefConfigured(settings: Settings): boolean {
  return clefTarget(settings.decision.clef) !== null;
}
