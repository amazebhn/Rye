/**
 * AgentStore — persistent custom agent definitions backed by bun:sqlite.
 *
 * Each agent has:
 *   - Specific instruction set
 *   - Unique @slug handle for tagging in generic chats
 *   - Visual avatar (gradient preset/CSS or profile image)
 *   - Optional default model, environment, and preferred tool groups
 *   - A single dedicated 1:1 chat thread (linked via chat_id / ChatHistoryRecord.agentId)
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.js";

export type AgentAvatarKind = "gradient" | "image";

export interface AgentAvatar {
  kind: AgentAvatarKind;
  /** Gradient preset id (e.g. "sunset", "ocean") or CSS gradient, or image URL/data URI. */
  value: string;
}

export interface AgentDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  avatar: AgentAvatar;
  model: string | null;
  env: string | null;
  tool_groups: string[];
  chat_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  name: string;
  slug?: string;
  description?: string;
  instructions: string;
  avatar?: AgentAvatar;
  model?: string | null;
  env?: string | null;
  tool_groups?: string[];
}

export interface UpdateAgentInput {
  name?: string;
  slug?: string;
  description?: string;
  instructions?: string;
  avatar?: AgentAvatar;
  model?: string | null;
  env?: string | null;
  tool_groups?: string[];
  chat_id?: string | null;
}

const DEFAULT_GRADIENTS = [
  "sunset",
  "ocean",
  "emerald",
  "violet",
  "amber",
  "rose",
  "cyan",
  "slate",
] as const;

export function slugifyAgentName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || `agent-${randomUUID().slice(0, 6)}`;
}

function defaultAvatarFor(name: string): AgentAvatar {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return { kind: "gradient", value: DEFAULT_GRADIENTS[hash % DEFAULT_GRADIENTS.length] };
}

export class AgentStore {
  private db: Database;

  constructor(dbPath = join(DATA_DIR, "agents.db")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id           TEXT PRIMARY KEY,
        slug         TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        avatar_kind  TEXT NOT NULL DEFAULT 'gradient',
        avatar_value TEXT NOT NULL DEFAULT 'sunset',
        model        TEXT,
        env          TEXT,
        tool_groups  TEXT NOT NULL DEFAULT '[]',
        chat_id      TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  list(): AgentDefinition[] {
    const rows = this.db
      .query("SELECT * FROM agents ORDER BY name COLLATE NOCASE ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  get(id: string): AgentDefinition | null {
    const row = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? this.rowToAgent(row) : null;
  }

  getBySlug(slug: string): AgentDefinition | null {
    const norm = slugifyAgentName(slug);
    const row = this.db
      .query("SELECT * FROM agents WHERE slug = ?")
      .get(norm) as Record<string, unknown> | null;
    return row ? this.rowToAgent(row) : null;
  }

  private ensureUniqueSlug(desired: string, excludeId?: string): string {
    const base = slugifyAgentName(desired);
    let candidate = base;
    let suffix = 2;
    while (true) {
      const existing = this.db
        .query("SELECT id FROM agents WHERE slug = ?")
        .get(candidate) as { id: string } | null;
      if (!existing || existing.id === excludeId) return candidate;
      candidate = `${base}-${suffix++}`;
    }
  }

  create(input: CreateAgentInput): AgentDefinition {
    const id = `agt_${randomUUID().slice(0, 8)}`;
    const name = input.name.trim();
    const slug = this.ensureUniqueSlug(input.slug?.trim() || name);
    const description = (input.description ?? "").trim();
    const instructions = input.instructions.trim();
    const avatar = input.avatar ?? defaultAvatarFor(name);
    const model = input.model?.trim() || null;
    const env = input.env?.trim() || null;
    const toolGroups = (input.tool_groups ?? []).map((g) => g.trim()).filter(Boolean);

    this.db.run(
      `INSERT INTO agents (id, slug, name, description, instructions, avatar_kind, avatar_value, model, env, tool_groups)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, slug, name, description, instructions, avatar.kind, avatar.value, model, env, JSON.stringify(toolGroups)],
    );
    return this.get(id)!;
  }

  update(id: string, input: UpdateAgentInput): AgentDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const slug = input.slug !== undefined ? this.ensureUniqueSlug(input.slug, id) : existing.slug;
    const description = input.description !== undefined ? input.description.trim() : existing.description;
    const instructions = input.instructions !== undefined ? input.instructions.trim() : existing.instructions;
    const avatar = input.avatar ?? existing.avatar;
    const model = input.model !== undefined ? (input.model?.trim() || null) : existing.model;
    const env = input.env !== undefined ? (input.env?.trim() || null) : existing.env;
    const toolGroups =
      input.tool_groups !== undefined
        ? input.tool_groups.map((g) => g.trim()).filter(Boolean)
        : existing.tool_groups;
    const chatId = input.chat_id !== undefined ? input.chat_id : existing.chat_id;

    this.db.run(
      `UPDATE agents
       SET slug = ?, name = ?, description = ?, instructions = ?,
           avatar_kind = ?, avatar_value = ?, model = ?, env = ?,
           tool_groups = ?, chat_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [slug, name, description, instructions, avatar.kind, avatar.value, model, env, JSON.stringify(toolGroups), chatId, id],
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.db.run("DELETE FROM agents WHERE id = ?", [id]);
    return res.changes > 0;
  }

  /**
   * Extract @slug mentions from a message that match existing agents, preserving
   * first-seen order without duplicates.
   */
  resolveMentions(text: string): AgentDefinition[] {
    const matches = text.matchAll(/(?:^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})\b/g);
    const found: AgentDefinition[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const slug = m[1].toLowerCase();
      if (seen.has(slug)) continue;
      const agent = this.getBySlug(slug);
      if (agent) {
        seen.add(slug);
        found.push(agent);
      }
    }
    return found;
  }

  close(): void {
    this.db.close();
  }

  private rowToAgent(row: Record<string, unknown>): AgentDefinition {
    return {
      id: row.id as string,
      slug: row.slug as string,
      name: row.name as string,
      description: (row.description as string) ?? "",
      instructions: (row.instructions as string) ?? "",
      avatar: {
        kind: (row.avatar_kind as string) === "image" ? "image" : "gradient",
        value: (row.avatar_value as string) || "sunset",
      },
      model: (row.model as string | null) ?? null,
      env: (row.env as string | null) ?? null,
      tool_groups: JSON.parse((row.tool_groups as string) || "[]") as string[],
      chat_id: (row.chat_id as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
