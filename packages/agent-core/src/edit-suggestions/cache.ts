/**
 * Edit-suggestion cache — persisted to DATA_DIR so reopening an unchanged
 * document never re-bills the model, even across restarts.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import type { EditSuggestion } from "../agent/loop.js";

const CACHE_FILE = join(DATA_DIR, "edit-suggestions.json");
const MAX_ENTRIES = 200;

let cache: Map<string, EditSuggestion[]> | null = null;

function isSuggestionList(value: unknown): value is EditSuggestion[] {
  return Array.isArray(value) && value.every((s) => typeof s?.label === "string" && typeof s?.prompt === "string");
}

function load(): Map<string, EditSuggestion[]> {
  if (cache) return cache;
  cache = new Map();
  try {
    if (!existsSync(CACHE_FILE)) return cache;
    const entries = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as unknown;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && isSuggestionList(entry[1])) cache.set(entry[0], entry[1]);
      }
    }
  } catch {
    // A corrupt cache is only a performance loss; start fresh.
  }
  return cache;
}

/** Same document text and same reviewing model produce the same key. */
export function editSuggestionKey(kind: string, title: string, content: string, modelId: string): string {
  return createHash("sha256").update(`${kind}\0${title}\0${content}\0${modelId}`).digest("hex");
}

export function getCachedEditSuggestions(key: string): EditSuggestion[] | undefined {
  return load().get(key);
}

export function setCachedEditSuggestions(key: string, suggestions: EditSuggestion[]): void {
  const map = load();
  map.delete(key);
  map.set(key, suggestions);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify([...map.entries()]), "utf8");
  } catch {
    // Best-effort persistence; the in-memory cache still serves this process.
  }
}
