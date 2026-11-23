/**
 * Model tiers — maps each task to a low/medium/high tier, and each tier to a
 * concrete model id (explicit config, or auto-picked from the live catalog).
 */

import { getRuntimeModel } from "./config.js";
import type { ModelTask, ModelTier, Settings } from "./config.js";
import { autoSelectFastModel, autoSelectModel, autoSelectStrongModel } from "./copilot-models.js";

/** Concrete model id for a tier. */
export async function resolveTierModelId(settings: Settings, tier: ModelTier): Promise<string> {
  const explicit = settings.models[tier].trim();
  if (explicit) return explicit;
  // The Claude harness fills blank tiers ahead of any provider.
  if (settings.harness === "claude") {
    if (tier === "low") return "haiku";
    if (tier === "high") return "opus";
    return settings.claude.model || "sonnet";
  }
  // Blank tiers auto-pick from the first (primary) provider.
  if (settings.llm_provider[0] !== "copilot") return settings.ollama.model;
  if (tier === "low") return autoSelectFastModel();
  if (tier === "high") return autoSelectStrongModel();
  return settings.copilot.model || autoSelectModel();
}

/** Concrete model id for a task, via its configured tier. */
export async function resolveTaskModelId(settings: Settings, task: ModelTask): Promise<string> {
  // A model picked in the chat UI applies to chat until the process restarts.
  const runtime = getRuntimeModel();
  if (task === "chat" && runtime) return runtime;
  return resolveTierModelId(settings, settings.models.tasks[task]);
}
