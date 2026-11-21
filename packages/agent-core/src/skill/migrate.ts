/**
 * One-time migration of legacy SQLite skills (knowledge.db `skills` table) into Rye-owned
 * skill folders. Non-destructive: the table is left untouched; a marker file records completion
 * and maps old numeric ids to the new folder names.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { getSettings } from "../config.js";
import { atomicWriteFile } from "./fs-safe.js";
import type { SkillStore } from "./store.js";

const MARKER_NAME = ".migrated-from-db.json";
export const MIGRATED_ID_KEY = "migrated_from_db_id";

interface LegacyRow {
  id: number;
  title: string;
  description: string | null;
  content: string | null;
  updated_at: string | null;
}

interface Marker {
  version: 1;
  migratedAt: string;
  dbPath: string;
  /** Legacy numeric id -> skill folder name. */
  skills: Record<string, string>;
}

export function markerPath(store: SkillStore): string {
  return join(store.ryeDir, MARKER_NAME);
}

function readMarker(store: SkillStore): Marker | null {
  try {
    return JSON.parse(readFileSync(markerPath(store), "utf8")) as Marker;
  } catch {
    return null;
  }
}

/** Folder name a legacy numeric id was migrated to, if known. */
export function legacyIdToName(store: SkillStore, id: number): string | null {
  const name = readMarker(store)?.skills[String(id)];
  return name && store.summary(name) ? name : null;
}

function readLegacyRows(dbPath: string): LegacyRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='skills'`).get();
    if (!table) return [];
    return db
      .prepare(`SELECT rowid AS id, title, description, content, updated_at FROM skills ORDER BY rowid`)
      .all() as LegacyRow[];
  } finally {
    db.close();
  }
}

export interface MigrationResult {
  status: "migrated" | "already-done" | "failed";
  migrated: number;
  error?: string;
}

/** Idempotent: a marker file short-circuits; a crash mid-way resumes without duplicating. */
export function migrateLegacySkills(store: SkillStore, dbPath: string = getSettings().db_path): MigrationResult {
  if (readMarker(store)) return { status: "already-done", migrated: 0 };

  let rows: LegacyRow[];
  try {
    rows = readLegacyRows(dbPath);
  } catch (err) {
    return { status: "failed", migrated: 0, error: err instanceof Error ? err.message : String(err) };
  }

  // Skills already written by an interrupted earlier run carry their legacy id.
  const map: Record<string, string> = {};
  for (const s of store.list()) {
    const id = s.frontmatter[MIGRATED_ID_KEY];
    if (s.source === "rye" && typeof id === "number") map[String(id)] = s.name;
  }

  let migrated = 0;
  try {
    for (const row of rows) {
      if (map[String(row.id)]) continue;
      const created = store.create({
        title: row.title?.trim() || `Skill ${row.id}`,
        description: row.description ?? "",
        content: row.content ?? "",
        extras: { [MIGRATED_ID_KEY]: row.id },
      });
      map[String(row.id)] = created.name;
      migrated++;
      // Keep the old "recently updated first" ordering.
      const ts = row.updated_at ? new Date(`${row.updated_at.replace(" ", "T")}Z`) : null;
      if (ts && !Number.isNaN(ts.getTime())) {
        try {
          utimesSync(join(created.path, "SKILL.md"), ts, ts);
        } catch {
          // ordering only
        }
      }
    }
    const marker: Marker = { version: 1, migratedAt: new Date().toISOString(), dbPath, skills: map };
    mkdirSync(store.ryeDir, { recursive: true });
    atomicWriteFile(markerPath(store), JSON.stringify(marker, null, 2));
    store.rescan();
    return { status: "migrated", migrated };
  } catch (err) {
    return { status: "failed", migrated, error: err instanceof Error ? err.message : String(err) };
  }
}
