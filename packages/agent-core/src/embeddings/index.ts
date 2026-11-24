/**
 * Shared embedding provider — supports Ollama (local) and GitHub Copilot
 * (/embeddings), with graceful fallback when neither is available.
 *
 * Used by SOPStore and KnowledgeStore for semantic search.
 */

import { getSettings } from "../config.js";
import { copilotFetch } from "../copilot-models.js";

export type EmbeddingProvider = "ollama" | "copilot" | "none";

export interface EmbeddingResult {
  vector: number[];
  provider: Exclude<EmbeddingProvider, "none">;
  model: string;
}

export interface EmbeddingStatus {
  provider: EmbeddingProvider;
  model: string | null;
  available: boolean;
}

const EMBED_TIMEOUT_MS = 10_000;
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
const COPILOT_EMBEDDINGS_URL = "https://api.githubcopilot.com/embeddings";
const COPILOT_MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

const COPILOT_HEADERS = {
  "Content-Type": "application/json",
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.90.0",
  "Editor-Plugin-Version": "copilot-chat/0.1.0",
};

let copilotEmbedModelCache: { model: string | null; at: number } | null = null;
let lastStatus: EmbeddingStatus = { provider: "none", model: null, available: false };

/** Reset internal caches (useful for tests). */
export function resetEmbeddingCache(): void {
  copilotEmbedModelCache = null;
  lastStatus = { provider: "none", model: null, available: false };
}

/** Return the most recently observed embedding provider status. */
export function getLastEmbeddingStatus(): EmbeddingStatus {
  return lastStatus;
}

/** Cosine similarity between two equal-length float vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function float32ToBlob(arr: number[]): Buffer {
  const buf = Buffer.allocUnsafe(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}

export function blobToFloat32(buf: Uint8Array | Buffer): number[] {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const result: number[] = [];
  for (let i = 0; i + 4 <= b.byteLength; i += 4) result.push(b.readFloatLE(i));
  return result;
}

// ---------------------------------------------------------------------------
// Ollama embeddings
// ---------------------------------------------------------------------------

/**
 * What some embedding models expect in front of a search query (never in front of the
 * documents being searched). Models not listed take queries as they are.
 */
export function queryPrefix(model: string): string {
  // F2LLM and Qwen3-Embedding: an instruction, then the query.
  if (/f2llm|qwen3[^/]*embed/i.test(model)) return "Instruct: Given a question, retrieve passages that can help answer the question.\nQuery: ";
  return "";
}

/** The embedding model Ollama is asked for: the one notes and messages should be indexed with. */
export function configuredEmbeddingModel(): string {
  return getSettings().ollama.embedding_model.trim();
}

async function embedViaOllama(texts: string[], kind: "document" | "query" = "document"): Promise<{ vectors: number[][]; model: string } | null> {
  const cfg = getSettings();
  const baseUrl = cfg.ollama.base_url.replace(/\/+$/, "");
  const model = cfg.ollama.embedding_model;
  if (!baseUrl || !model) return null;
  if (kind === "query") {
    const prefix = queryPrefix(model);
    if (prefix) texts = texts.map((t) => prefix + t);
  }
  // A large model takes a while over a batch (and longer still to load), so the allowance grows with the batch.
  const timeout = Math.min(EMBED_TIMEOUT_MS + texts.length * 3000, 180_000);

  // Prefer the modern /api/embed batch endpoint; fall back to legacy /api/embeddings.
  try {
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
        return { vectors: data.embeddings, model };
      }
    }
  } catch {
    // Fall through to legacy endpoint or next provider.
  }

  // Legacy /api/embeddings (single prompt per request)
  try {
    const vectors: number[][] = [];
    for (const prompt of texts) {
      const res = await fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) return null;
      vectors.push(data.embedding);
    }
    return { vectors, model };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Copilot embeddings
// ---------------------------------------------------------------------------

async function discoverCopilotEmbeddingModel(): Promise<string | null> {
  if (copilotEmbedModelCache && Date.now() - copilotEmbedModelCache.at < COPILOT_MODEL_CACHE_TTL_MS) {
    return copilotEmbedModelCache.model;
  }
  try {
    const resp = await copilotFetch(
      COPILOT_MODELS_URL,
      { signal: AbortSignal.timeout(5000) },
      { "Copilot-Integration-Id": "vscode-chat", "Editor-Version": "vscode/1.90.0" },
    );
    if (!resp.ok) {
      copilotEmbedModelCache = { model: null, at: Date.now() };
      return null;
    }
    const data = (await resp.json()) as { data?: Array<{ id: string; capabilities?: { type?: string } }> };
    const candidates = (data.data ?? [])
      .filter((m) => m.capabilities?.type === "embeddings")
      .map((m) => m.id);
    const picked = candidates.find((id) => id.includes("text-embedding-3-small")) ?? candidates[0] ?? null;
    copilotEmbedModelCache = { model: picked, at: Date.now() };
    return picked;
  } catch {
    copilotEmbedModelCache = { model: null, at: Date.now() };
    return null;
  }
}

async function embedViaCopilot(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
  const model = await discoverCopilotEmbeddingModel();
  if (!model) return null;
  try {
    const resp = await copilotFetch(
      COPILOT_EMBEDDINGS_URL,
      {
        method: "POST",
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      },
      COPILOT_HEADERS,
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) return null;
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((d) => d.embedding);
    if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) return null;
    return { vectors, model };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a batch of texts using Ollama first (local, zero-cost), falling back
 * to Copilot embeddings if configured and available.
 */
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[] | null> {
  if (texts.length === 0) return [];

  const ollama = await embedViaOllama(texts);
  if (ollama) {
    lastStatus = { provider: "ollama", model: ollama.model, available: true };
    return ollama.vectors.map((vector) => ({ vector, provider: "ollama", model: ollama.model }));
  }

  const cfg = getSettings();
  if (cfg.llm_provider.includes("copilot")) {
    const copilot = await embedViaCopilot(texts);
    if (copilot) {
      lastStatus = { provider: "copilot", model: copilot.model, available: true };
      return copilot.vectors.map((vector) => ({ vector, provider: "copilot", model: copilot.model }));
    }
  }

  lastStatus = { provider: "none", model: null, available: false };
  return null;
}

/**
 * Embed with the local model (Ollama) only, never a hosted fallback. Used for
 * chat history, which should not be sent to a service the user didn't pick
 * for those conversations.
 */
export async function embedBatchLocal(texts: string[]): Promise<EmbeddingResult[] | null> {
  if (texts.length === 0) return [];
  const ollama = await embedViaOllama(texts);
  return ollama ? ollama.vectors.map((vector) => ({ vector, provider: "ollama", model: ollama.model })) : null;
}

export async function embedTextLocal(text: string): Promise<EmbeddingResult | null> {
  return (await embedBatchLocal([text]))?.[0] ?? null;
}

/** Embed a search query (as opposed to text being indexed) with the local model only. */
export async function embedQueryLocal(text: string): Promise<EmbeddingResult | null> {
  const ollama = await embedViaOllama([text], "query");
  return ollama ? { vector: ollama.vectors[0], provider: "ollama", model: ollama.model } : null;
}

/** Embed a search query: Ollama first, with the model's query prefix, then the hosted fallback. */
export async function embedQuery(text: string): Promise<EmbeddingResult | null> {
  return (await embedQueryLocal(text)) ?? (getSettings().llm_provider.includes("copilot") ? embedText(text) : null);
}

/** Embed a single text string. Returns null if no embedding provider is reachable. */
export async function embedText(text: string): Promise<EmbeddingResult | null> {
  const res = await embedBatch([text]);
  return res?.[0] ?? null;
}

/** Probe embedding availability and return the active provider/model. */
export async function probeEmbeddingStatus(): Promise<EmbeddingStatus> {
  const res = await embedText("ping");
  if (res) return { provider: res.provider, model: res.model, available: true };
  return { provider: "none", model: null, available: false };
}
