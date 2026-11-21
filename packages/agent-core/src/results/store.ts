/**
 * Query result store — keeps large tool output on disk instead of in the
 * conversation, so a big result costs context once (as a small preview)
 * rather than on every subsequent LLM call in the session.
 *
 * Text output is stored as a single-column table so paging, filtering and
 * aggregation share one code path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { isSessionDeleted } from "../session/lifecycle.js";

const RESULTS_DIR = join(DATA_DIR, "results");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESULTS = 200;

/** Results at or below this size stay inline — a reference would cost more than it saves. */
export const INLINE_ROW_LIMIT = 20;
export const INLINE_CHAR_LIMIT = 2000;

export const TEXT_COLUMN = "line";

export interface StoredResult {
  id: string;
  createdAt: number;
  sessionId?: string;
  source: string;
  label: string;
  kind: "table" | "text";
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface StoredResultSummary {
  id: string;
  createdAt: number;
  source: string;
  label: string;
  kind: "table" | "text";
  columns: string[];
  rowCount: number;
}

function ensureDir() {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
}

function resultPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(RESULTS_DIR, `${safe}.json`);
}

function prune() {
  try {
    const entries = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(RESULTS_DIR, f);
        return { path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const cutoff = Date.now() - RETENTION_MS;
    entries.forEach((entry, i) => {
      if (entry.mtime < cutoff || i >= MAX_RESULTS) rmSync(entry.path, { force: true });
    });
  } catch {
    // Pruning is best-effort.
  }
}

export function saveResult(opts: {
  sessionId?: string;
  source: string;
  label: string;
  kind: "table" | "text";
  columns: string[];
  rows: Record<string, unknown>[];
}): StoredResult {
  const id = `res_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const record: StoredResult = { id, createdAt: Date.now(), ...opts };
  try {
    if (opts.sessionId && isSessionDeleted(opts.sessionId)) return record;
    ensureDir();
    writeFileSync(resultPath(id), JSON.stringify(record), "utf8");
    prune();
  } catch {
    // If persistence fails the caller still gets the record for this turn.
  }
  return record;
}

export function getResult(id: string, sessionId?: string): StoredResult | null {
  try {
    const p = resultPath(id);
    if (!existsSync(p)) return null;
    const result = JSON.parse(readFileSync(p, "utf8")) as StoredResult;
    if (sessionId !== undefined && result.sessionId !== sessionId) return null;
    return result;
  } catch {
    return null;
  }
}

/** List retained result metadata without sending potentially large row payloads. */
export function listResults(sessionId: string): StoredResultSummary[] {
  try {
    ensureDir();
    prune();
    return readdirSync(RESULTS_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file): StoredResultSummary | null => {
        try {
          const result = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Partial<StoredResult>;
          if (
            typeof result.id !== "string" ||
            typeof result.createdAt !== "number" ||
            result.sessionId !== sessionId ||
            typeof result.source !== "string" ||
            typeof result.label !== "string" ||
            (result.kind !== "table" && result.kind !== "text") ||
            !Array.isArray(result.columns) ||
            !Array.isArray(result.rows)
          ) return null;
          return {
            id: result.id,
            createdAt: result.createdAt,
            source: result.source,
            label: result.label,
            kind: result.kind,
            columns: result.columns.filter((column): column is string => typeof column === "string"),
            rowCount: result.rows.length,
          };
        } catch {
          return null;
        }
      })
      .filter((result): result is StoredResultSummary => result !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_RESULTS);
  } catch {
    return [];
  }
}

/** Delete every retained result owned by a session. */
export function deleteResultsForSession(sessionId: string): number {
  let deleted = 0;
  try {
    ensureDir();
    for (const file of readdirSync(RESULTS_DIR).filter((entry) => entry.endsWith(".json"))) {
      const path = join(RESULTS_DIR, file);
      try {
        const result = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredResult>;
        if (result.sessionId !== sessionId) continue;
        rmSync(path, { force: true });
        deleted++;
      } catch {
        // Leave malformed files for normal retention pruning.
      }
    }
  } catch {
    // Deletion is best-effort; the normal retention policy remains a backstop.
  }
  return deleted;
}

export function saveTextResult(source: string, label: string, text: string, sessionId?: string): StoredResult {
  const lines = text.split("\n");
  return saveResult({
    sessionId,
    source,
    label,
    kind: "text",
    columns: [TEXT_COLUMN],
    rows: lines.map((line) => ({ [TEXT_COLUMN]: line })),
  });
}
