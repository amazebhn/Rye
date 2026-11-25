/**
 * What Ollama has installed and what each model can do, for the retrieval
 * settings: which models can embed, which can generate (and so rerank), and
 * whether a model that was just chosen for embedding actually loads.
 */

import type { Settings } from "../config.js";

export interface OllamaModelInfo {
  name: string;
  capabilities: string[];
  /** Bytes on disk; 0 when Ollama didn't say. */
  size: number;
}

const LIST_CACHE_MS = 30_000;
let cache: { baseUrl: string; models: OllamaModelInfo[]; at: number } | null = null;

/** Installed Ollama models with their capabilities; [] when Ollama is unreachable. */
export async function listOllamaModels(settings: Settings, fetchFn: typeof fetch = fetch): Promise<OllamaModelInfo[]> {
  const baseUrl = settings.ollama.base_url.replace(/\/+$/, "");
  if (!baseUrl) return [];
  if (cache?.baseUrl === baseUrl && Date.now() - cache.at < LIST_CACHE_MS) return cache.models;
  try {
    const tags = await fetchFn(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!tags.ok) return [];
    const listed = ((await tags.json()) as { models?: Array<{ name: string; size?: number }> }).models ?? [];
    const models = await Promise.all(
      listed.map(async ({ name, size = 0 }) => {
        try {
          const resp = await fetchFn(`${baseUrl}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: name }),
            signal: AbortSignal.timeout(4000),
          });
          const info = resp.ok ? ((await resp.json()) as { capabilities?: string[] }) : {};
          return { name, capabilities: info.capabilities ?? [], size };
        } catch {
          return { name, capabilities: [], size };
        }
      }),
    );
    cache = { baseUrl, models, at: Date.now() };
    return models;
  } catch {
    return [];
  }
}

/** "nomic-embed-text" and "nomic-embed-text:latest" are the same model. */
export const sameModel = (a: string, b: string) => a.replace(/:latest$/, "") === b.replace(/:latest$/, "");

/** Whether Ollama says `model` can see images. False when Ollama is unreachable or doesn't know the model. */
export async function ollamaModelSeesImages(settings: Settings, model: string): Promise<boolean> {
  const info = (await listOllamaModels(settings)).find((m) => sameModel(m.name, model));
  return info?.capabilities.includes("vision") ?? false;
}

/**
 * Ask Ollama to embed one word with `model`. Returns the vector size, or the
 * reason it can't: a model that fails to load would otherwise leave search
 * with no vectors at all once it is chosen.
 */
export async function probeEmbeddingModel(
  settings: Settings,
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; dimensions: number } | { ok: false; error: string }> {
  const baseUrl = settings.ollama.base_url.replace(/\/+$/, "");
  try {
    // Loading a large model for the first time can take a while.
    const res = await fetchFn(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: ["ping"] }),
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await res.json().catch(() => ({}))) as { embeddings?: number[][]; error?: string };
    const dimensions = data.embeddings?.[0]?.length ?? 0;
    if (res.ok && dimensions > 0) return { ok: true, dimensions };
    return { ok: false, error: (data.error ?? `Ollama answered HTTP ${res.status}`).split("\n")[0].slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
