/**
 * SOP store — bun:sqlite + Ollama embeddings for semantic search.
 *
 * Schema mirrors the Python version:
 *   sops(id, title, description, content, steps_json, tags_json, embedding BLOB)
 *
 * Embeddings are float32 vectors fetched from the Ollama /api/embeddings endpoint.
 * Similarity search uses cosine similarity in JS (no sqlite-vec extension needed).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { settings } from "../config.js";
import { blobToFloat32, cosineSimilarity, embedText, float32ToBlob } from "../embeddings/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SOP {
  id: number;
  title: string;
  description: string;
  content: string;
  steps: string[];
  tags: string[];
  created_at?: string;
  updated_at?: string;
}

async function embed(text: string): Promise<number[] | null> {
  const res = await embedText(text);
  return res?.vector ?? null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SOPStore {
  private db: Database;

  constructor(dbPath: string = settings.db_path) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sops (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        content     TEXT    NOT NULL,
        steps_json  TEXT    NOT NULL DEFAULT '[]',
        tags_json   TEXT    NOT NULL DEFAULT '[]',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        embedding   BLOB
      )
    `);
    // Migrate existing DBs that were created before the embedding column was added.
    // ALTER TABLE fails harmlessly if the column already exists.
    try {
      this.db.exec("ALTER TABLE sops ADD COLUMN embedding BLOB");
    } catch {
      // column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE sops ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE sops ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE sops ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))");
    } catch {
      // column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE sops ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
    } catch {
      // column already exists — ignore
    }
  }

  async save(opts: {
    title: string;
    description?: string;
    content: string;
    steps?: string[];
    tags?: string[];
  }): Promise<number> {
    const embedding = await embed(
      `${opts.title} ${opts.description ?? ""} ${opts.content}`
    );
    const stmt = this.db.prepare(`
      INSERT INTO sops (title, description, content, steps_json, tags_json, created_at, updated_at, embedding)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
    `);
    const result = stmt.run(
      opts.title,
      opts.description ?? "",
      opts.content,
      JSON.stringify(opts.steps ?? []),
      JSON.stringify(opts.tags ?? []),
      embedding ? float32ToBlob(embedding) : null
    );
    return Number(result.lastInsertRowid);
  }

  async update(id: number, opts: {
    title?: string;
    description?: string;
    content?: string;
    steps?: string[];
    tags?: string[];
  }): Promise<boolean> {
    const existing = this.get(id);
    if (!existing) return false;
    const title = opts.title ?? existing.title;
    const description = opts.description ?? existing.description;
    const content = opts.content ?? existing.content;
    const steps = opts.steps ?? existing.steps;
    const tags = opts.tags ?? existing.tags;
    const embedding = await embed(`${title} ${description} ${content}`);
    this.db.prepare(`
      UPDATE sops SET title=?, description=?, content=?, steps_json=?, tags_json=?,
        updated_at=datetime('now'), embedding=?
      WHERE rowid=?
    `).run(
      title,
      description,
      content,
      JSON.stringify(steps),
      JSON.stringify(tags),
      embedding ? float32ToBlob(embedding) : null,
      id
    );
    return true;
  }

  async duplicate(id: number): Promise<number | null> {
    const sop = this.get(id);
    if (!sop) return null;
    return this.save({
      title: `${sop.title} (copy)`,
      description: sop.description,
      content: sop.content,
      steps: sop.steps,
      tags: sop.tags,
    });
  }

  get(id: number): SOP | null {
    const row = this.db
      .prepare("SELECT rowid as id, title, description, content, steps_json, tags_json, created_at, updated_at FROM sops WHERE rowid = ?")
      .get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToSop(row);
  }

  list(): SOP[] {
    const rows = this.db
      .prepare("SELECT rowid as id, title, description, content, steps_json, tags_json, created_at, updated_at FROM sops ORDER BY rowid DESC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToSop);
  }

  delete(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM sops WHERE rowid = ?")
      .run(id);
    return result.changes > 0;
  }

  async search(query: string, limit = 5): Promise<SOP[]> {
    const queryEmbedding = await embed(query);
    const rows = this.db
      .prepare("SELECT rowid as id, title, description, content, steps_json, tags_json, created_at, updated_at, embedding FROM sops WHERE embedding IS NOT NULL")
      .all() as Record<string, unknown>[];

    if (!queryEmbedding || rows.length === 0) {
      // Fall back to simple text match
      const likeRows = this.db
        .prepare(
          "SELECT rowid as id, title, description, content, steps_json, tags_json, created_at, updated_at FROM sops WHERE title LIKE ? OR content LIKE ? LIMIT ?"
        )
        .all(`%${query}%`, `%${query}%`, limit) as Record<string, unknown>[];
      return likeRows.map(rowToSop);
    }

    const scored = rows.map((row) => ({
      sop: rowToSop(row),
      score: cosineSimilarity(
        queryEmbedding,
        blobToFloat32(row.embedding as Buffer)
      ),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.sop);
  }

  /**
   * Compact index for progressive disclosure — injected into the system prompt.
   * Without this the agent only ever sees the handful of SOPs that semantic
   * search matched on the opening message, so newer SOPs look invisible.
   */
  formatIndexForPrompt(): string {
    const sops = this.list();
    if (sops.length === 0) return "";
    const lines = sops.map((s) => {
      const hint =
        s.description?.trim() ||
        s.content.replace(/^#+\s.*/gm, "").replace(/\s+/g, " ").trim().slice(0, 100);
      return `- [id ${s.id}] **${s.title}**${hint ? ` — ${hint}` : ""}`;
    });
    return (
      `## Available SOPs\n` +
      `Every SOP in the knowledge base is listed below. When one is relevant, call ` +
      `load_sop_tool with its id to read the full runbook. Use search_sops_tool to find SOPs by topic.\n\n` +
      lines.join("\n")
    );
  }

  close(): void {
    this.db.close();
  }
}

function rowToSop(row: Record<string, unknown>): SOP {
  return {
    id: row.id as number,
    title: row.title as string,
    description: row.description as string,
    content: row.content as string,
    steps: JSON.parse((row.steps_json as string) || "[]"),
    tags: JSON.parse((row.tags_json as string) || "[]"),
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  };
}
