/**
 * MemoryStore — persistent agent memory backed by bun:sqlite.
 *
 * The agent can save arbitrary key-value facts (with optional tags) that
 * survive process restarts. All memories are injected into the system prompt
 * at the start of each run so the agent always has full context.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA_DIR } from "../config.js";

export type MemoryKind = "fact" | "acronym" | "term";

export interface Memory {
  id: number;
  key: string;
  value: string;
  kind: MemoryKind;
  category: string;
  tags: string[];
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Cap on a single memory value's length to keep the prompt bounded. */
const MAX_VALUE_LEN = 2000;
/** Default cap, in estimated tokens, on the memories shown in the system prompt. */
export const DEFAULT_MEMORY_BUDGET_TOKENS = 3000;
/** How many left-out keys are named so the agent knows what else exists. */
const MAX_OMITTED_KEYS = 40;

/** Rough prompt cost of one entry: its text at ~4 chars per token plus list/table markup. */
const entryTokens = (m: Memory): number => Math.ceil((m.key.length + m.value.length + m.tags.join(", ").length) / 4) + 6;

/** Normalise a memory key so lookups/dedupe are case- and whitespace-insensitive. */
function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_");
}

function normaliseKind(kind?: string): MemoryKind {
  if (kind === "acronym" || kind === "term") return kind;
  return "fact";
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath = join(DATA_DIR, "memory.db")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL UNIQUE,
        value      TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'fact',
        category   TEXT NOT NULL DEFAULT 'general',
        tags       TEXT NOT NULL DEFAULT '[]',
        agent_id   TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Safe migrations for existing DBs (ALTER fails harmlessly if column exists)
    try { this.db.run("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general'"); } catch { /* already exists */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'"); } catch { /* already exists */ }
    try { this.db.run("ALTER TABLE memories ADD COLUMN agent_id TEXT"); } catch { /* already exists */ }
  }

  /** Upsert a memory by key. Keys are normalised so casing/spacing can't create duplicates. */
  save(
    key: string,
    value: string,
    tags: string[] = [],
    category = "general",
    opts?: { kind?: MemoryKind; agentId?: string | null },
  ): void {
    const normKey = normaliseKey(key);
    const trimmedValue = value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value;
    const cat = category.trim() || "general";
    const kind = normaliseKind(opts?.kind);
    const agentId = opts?.agentId ?? null;
    this.db.run(
      `INSERT INTO memories (key, value, kind, category, tags, agent_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value      = excluded.value,
         kind       = excluded.kind,
         category   = excluded.category,
         tags       = excluded.tags,
         agent_id   = excluded.agent_id,
         updated_at = datetime('now')`,
      [normKey, trimmedValue, kind, cat, JSON.stringify(tags), agentId]
    );
  }

  /** Delete a memory by key. Returns true if it existed. */
  forget(key: string): boolean {
    const info = this.db.run("DELETE FROM memories WHERE key = ?", [normaliseKey(key)]);
    return info.changes > 0;
  }

  /** Return all memories ordered by most recently updated. */
  all(opts?: { agentId?: string | null; kind?: MemoryKind }): Memory[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts?.agentId !== undefined && opts.agentId !== null) {
      clauses.push("(agent_id IS NULL OR agent_id = ?)");
      params.push(opts.agentId);
    }
    if (opts?.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM memories ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.deserialise(r));
  }

  /**
   * Format memories as a compact block for injection into the system prompt.
   * Splits acronyms & custom terms into a Glossary table, and groups facts by
   * category underneath. Entries are kept newest first until the token budget
   * is spent; the rest are named by key so the agent can ask for them.
   */
  formatForPrompt(agentId?: string | null, budgetTokens = DEFAULT_MEMORY_BUDGET_TOKENS): string {
    const everything = this.all(agentId ? { agentId } : undefined);
    if (everything.length === 0) return "";

    const memories: Memory[] = [];
    const omitted: Memory[] = [];
    let spent = 0;
    for (const m of everything) {
      const cost = entryTokens(m);
      // Always show at least one entry, however large.
      if (memories.length > 0 && spent + cost > budgetTokens) {
        omitted.push(m);
        continue;
      }
      spent += cost;
      memories.push(m);
    }

    const glossary = memories.filter((m) => m.kind === "acronym" || m.kind === "term");
    const facts = memories.filter((m) => m.kind === "fact");
    const blocks: string[] = [];

    if (glossary.length > 0) {
      const sorted = [...glossary].sort((a, b) => a.key.localeCompare(b.key));
      const rows = sorted.map((m) => {
        const badge = m.kind === "acronym" ? "acronym" : "term";
        return `| \`${m.key}\` | ${badge} | ${m.value.replace(/\|/g, "\\|")} |`;
      });
      blocks.push(
        `## Glossary & Acronyms\nCustom terms and acronyms used in this environment:\n\n| Term | Type | Meaning |\n|---|---|---|\n${rows.join("\n")}`,
      );
    }

    if (facts.length > 0) {
      const byCategory = new Map<string, Memory[]>();
      for (const m of facts) {
        const cat = m.category || "general";
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(m);
      }

      const sections = [...byCategory.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cat, items]) => {
          const lines = items.map((m) => {
            const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
            return `- **${m.key}**${tagStr}: ${m.value}`;
          });
          return `### ${cat}\n${lines.join("\n")}`;
        });

      blocks.push(`## Saved Facts\nGround-truth facts remembered from previous sessions:\n\n${sections.join("\n\n")}`);
    }

    if (omitted.length > 0) {
      const keys = omitted.slice(0, MAX_OMITTED_KEYS).map((m) => `\`${m.key}\``).join(", ");
      const more = omitted.length > MAX_OMITTED_KEYS ? `, and ${omitted.length - MAX_OMITTED_KEYS} more` : "";
      blocks.push(
        `_${omitted.length} older saved ${omitted.length === 1 ? "entry is" : "entries are"} not shown to save context: ${keys}${more}. ` +
          `Call list_memories_tool to read them._`,
      );
    }

    return blocks.join("\n\n");
  }

  private deserialise(row: Record<string, unknown>): Memory {
    return {
      id: row.id as number,
      key: row.key as string,
      value: row.value as string,
      kind: normaliseKind(row.kind as string | undefined),
      category: (row.category as string) ?? "general",
      tags: JSON.parse(row.tags as string) as string[],
      agent_id: (row.agent_id as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
