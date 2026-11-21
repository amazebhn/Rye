/**
 * Copilot model catalog — live listing, on-disk cache, and default resolution.
 *
 * The catalog changes often, so nothing here hardcodes a model list. When
 * `copilot.model` is left blank in config we auto-select the newest Sonnet
 * from the live catalog (falling back to the last cached catalog offline).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { getCopilotBearerToken, invalidateCopilotToken } from "./copilot-auth.js";

const MODELS_CACHE_FILE = join(DATA_DIR, "models-cache.json");
const MODELS_URL = "https://api.githubcopilot.com/models";
const AUTO_REFRESH_MS = 60 * 60 * 1000;

// Used only when the API is unreachable and no cache has ever been written.
const LAST_RESORT_MODEL = "claude-sonnet-4.5";

export interface ModelsCache {
  models: string[];
  fetchedAt: number;
}

/**
 * Copilot fetch with auth retry.
 * A long-running process can hold a bearer that VS Code silently rotated,
 * which the API rejects with 401/403. On that, drop the cache, re-exchange,
 * and retry once before giving up.
 */
export async function copilotFetch(
  url: string,
  init: RequestInit,
  extraHeaders: Record<string, string>
): Promise<Response> {
  const build = (bearer: string): RequestInit => ({
    ...init,
    headers: { Authorization: `Bearer ${bearer}`, ...extraHeaders },
  });

  let bearer = await getCopilotBearerToken();
  let resp = await fetch(url, build(bearer));
  if (resp.status === 401 || resp.status === 403) {
    invalidateCopilotToken();
    bearer = await getCopilotBearerToken(true);
    resp = await fetch(url, build(bearer));
  }
  return resp;
}

export function readModelsCache(): ModelsCache | null {
  try {
    if (!existsSync(MODELS_CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(MODELS_CACHE_FILE, "utf8")) as ModelsCache;
    if (Array.isArray(parsed.models) && parsed.models.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeModelsCache(models: string[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ models, fetchedAt: Date.now() }), "utf8");
  } catch {
    // Best-effort; a failed cache write just means we refetch next time.
  }
}

/** Fetch the live chat-capable model ids and refresh the cache. */
export async function fetchCopilotModels(): Promise<string[]> {
  const resp = await copilotFetch(
    MODELS_URL,
    { signal: AbortSignal.timeout(5000) },
    { "Copilot-Integration-Id": "vscode-chat", "Editor-Version": "vscode/1.90.0" }
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: Array<{ id: string; capabilities?: { type?: string } }> };
  const models = (data.data ?? []).filter((m) => m.capabilities?.type === "chat").map((m) => m.id);
  if (models.length > 0) writeModelsCache(models);
  return models;
}

/** Compare dotted version strings segment by segment, e.g. "4.6" < "5". */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Highest-versioned Sonnet id in the list. Handles both naming styles the
 * catalog has used: "claude-sonnet-4.6" and "claude-3.7-sonnet".
 */
export function pickNewestSonnet(models: string[]): string | null {
  let best: { id: string; version: number[] } | null = null;

  for (const id of models) {
    const lower = id.toLowerCase();
    if (!lower.includes("sonnet")) continue;
    // Skip variants that aren't plain chat completions (e.g. "-thinking").
    if (lower.includes("thinking")) continue;

    const match = lower.match(/(\d+(?:\.\d+)*)/);
    if (!match) continue;
    const version = match[1].split(".").map(Number);

    if (!best || compareVersions(version, best.version) > 0) best = { id, version };
  }

  return best?.id ?? null;
}

let autoCache: { model: string; at: number } | null = null;

/**
 * Newest Sonnet available, preferring the live catalog and falling back to the
 * cached one. Memoized for an hour so this doesn't hit the API every turn.
 */
export async function autoSelectModel(): Promise<string> {
  if (autoCache && Date.now() - autoCache.at < AUTO_REFRESH_MS) return autoCache.model;

  let models: string[] = [];
  try {
    models = await fetchCopilotModels();
  } catch {
    models = readModelsCache()?.models ?? [];
  }

  const model = pickNewestSonnet(models) ?? models[0] ?? LAST_RESORT_MODEL;
  autoCache = { model, at: Date.now() };
  return model;
}

// Small, low-latency families for utility calls, in preference order. gpt-5.x and
// o-series are omitted because Copilot only serves them on /responses.
const FAST_FAMILIES: RegExp[] = [/haiku/, /gpt-4(?:\.\d+|o)-mini/, /gemini-.*flash/];

function pickNewestMatching(models: string[], family: RegExp): string | null {
  let best: { id: string; version: number[] } | null = null;
  for (const id of models) {
    const lower = id.toLowerCase();
    if (!family.test(lower) || lower.includes("thinking") || lower.includes("preview")) continue;
    const version = (lower.match(/(\d+(?:\.\d+)*)/)?.[1] ?? "0").split(".").map(Number);
    if (!best || compareVersions(version, best.version) > 0) best = { id, version };
  }
  return best?.id ?? null;
}

/** Newest model from the first fast family present in the list. */
export function pickFastModel(models: string[]): string | null {
  for (const family of FAST_FAMILIES) {
    const id = pickNewestMatching(models, family);
    if (id) return id;
  }
  return null;
}

/** Highest-versioned Opus, the most capable family served on /chat/completions. */
export function pickStrongModel(models: string[]): string | null {
  return pickNewestMatching(models, /opus/);
}

async function catalogModels(): Promise<string[]> {
  try {
    return await fetchCopilotModels();
  } catch {
    return readModelsCache()?.models ?? [];
  }
}

let fastCache: { model: string; at: number } | null = null;
let strongCache: { model: string; at: number } | null = null;

/** Fastest suitable model for utility calls, falling back to the default model. */
export async function autoSelectFastModel(): Promise<string> {
  if (fastCache && Date.now() - fastCache.at < AUTO_REFRESH_MS) return fastCache.model;
  const model = pickFastModel(await catalogModels()) ?? (await autoSelectModel());
  fastCache = { model, at: Date.now() };
  return model;
}

/** Most capable model available, falling back to the default model. */
export async function autoSelectStrongModel(): Promise<string> {
  if (strongCache && Date.now() - strongCache.at < AUTO_REFRESH_MS) return strongCache.model;
  const model = pickStrongModel(await catalogModels()) ?? (await autoSelectModel());
  strongCache = { model, at: Date.now() };
  return model;
}

/** Whether Copilot serves this model on /chat/completions, which Rye uses. */
export function supportsChatCompletions(id: string): boolean {
  return !/^(gpt-5|o\d)|codex|grok/i.test(id);
}
