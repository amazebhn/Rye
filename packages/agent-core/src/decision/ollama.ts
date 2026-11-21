/**
 * Ollama decision backend — Clef and other decision models served by Ollama's
 * Jev/SystemOne-compatible `/v1/systemone` endpoint (Ollama 0.35.1+).
 */

import type { Settings } from "../config.js";
import { systemOneDecide } from "./clef.js";
import type { Answers, DecideOptions, Questions } from "./types.js";

// Keeps the model resident between messages; a cold load takes several seconds and would blow the decision timeout.
const KEEP_ALIVE = "30m";
const CONTEXT_WINDOW = 65_536;
const LIST_CACHE_MS = 60_000;

let listCache: { baseUrl: string; models: string[]; at: number } | null = null;

/** Installed Ollama models that report the "decision" capability. Throws when Ollama is unreachable. */
export async function listOllamaDecisionModels(settings: Settings): Promise<string[]> {
  const baseUrl = settings.ollama.base_url;
  if (listCache?.baseUrl === baseUrl && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.models;

  const tags = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!tags.ok) throw new Error(`Ollama HTTP ${tags.status}`);
  const names = (((await tags.json()) as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name);

  const shown = await Promise.all(
    names.map(async (name) => {
      try {
        const resp = await fetch(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: name }),
          signal: AbortSignal.timeout(4000),
        });
        const info = resp.ok ? ((await resp.json()) as { capabilities?: string[] }) : {};
        return info.capabilities?.includes("decision") ? name : null;
      } catch {
        return null;
      }
    }),
  );
  const models = shown.filter((n): n is string => n !== null);
  listCache = { baseUrl, models, at: Date.now() };
  return models;
}

/** Same list, or [] when Ollama is unreachable. */
export const ollamaDecisionModelsOrEmpty = (settings: Settings) => listOllamaDecisionModels(settings).catch(() => [] as string[]);

/** The configured model, else the first installed decision model. */
export async function resolveOllamaDecisionModel(settings: Settings): Promise<string> {
  const configured = settings.decision.model.trim();
  if (configured) return configured;
  const [first] = await listOllamaDecisionModels(settings);
  if (!first) throw new Error("no Ollama decision model installed (try: ollama pull clef-flash)");
  return first;
}

export async function ollamaDecide(
  settings: Settings,
  state: unknown,
  questions: Questions,
  opts: DecideOptions = {},
): Promise<Answers> {
  const model = await resolveOllamaDecisionModel(settings);
  return systemOneDecide(
    {
      url: `${settings.ollama.base_url}/v1/systemone`,
      headers: { "Content-Type": "application/json" },
      model,
      provider: "ollama",
      contextWindow: CONTEXT_WINDOW,
      extra: { keep_alive: KEEP_ALIVE },
    },
    state,
    questions,
    opts,
  );
}

/** Load the decision model in the background so the first real message doesn't pay the cold start. */
export function warmOllamaDecisionModel(settings: Settings): void {
  if (settings.decision.provider !== "ollama") return;
  void ollamaDecide(settings, "warm-up", { ready: { type: "noul", instructions: "Is this a warm-up request?" } }, {
    signal: AbortSignal.timeout(120_000),
  })
    .then(() => console.info(`[decision] Ollama decision model loaded`))
    .catch((err) => console.warn(`[decision] Ollama decision model warm-up failed: ${err instanceof Error ? err.message : String(err)}`));
}
