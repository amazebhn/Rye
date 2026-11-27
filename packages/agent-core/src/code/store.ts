/**
 * `code.db`: one row per code session (docs/design/code-sessions.md §4.1) and the commands each
 * session's agent ran (the Terminal tab). Kind data lives here, so changes to code sessions never
 * touch `chats.db`.
 *
 * **The schema is additive and versioned** (`meta.schema_version`, `SCHEMA_VERSION`). A new
 * column goes in `COLUMNS` and is added with `ALTER TABLE … ADD COLUMN` behind a `PRAGMA
 * table_info` check; nothing is ever dropped or rewritten, because a running Rye (`bun --watch`)
 * opens the user's real database the moment a file is saved.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PendingPrompt } from "@rye/shared";
import type {
  ApprovalRequest,
  CodeActivity,
  CodeCommandEntry,
  CodeEngineId,
  CodeIsolation,
  CodeSessionRecord,
  CodeSessionState,
} from "./types.js";

/** Bump when a migration step is added below. */
export const SCHEMA_VERSION = 1;

/** An "Allow "<pattern>" for this session" approval, replayed into every later run's policy. */
export interface SessionRule {
  pattern: string;
  hosts: string[];
}

/** A live prompt waiting for the user, as stored (it is cleared, never kept, after a restart). */
export interface StoredPrompt {
  prompt: PendingPrompt;
  request: ApprovalRequest;
  /** Epoch milliseconds. */
  askedAt: number;
}

/** What the runner keeps per session beyond the contract's `CodeSessionRecord`. */
export interface CodeSessionRow extends CodeSessionRecord {
  /** The chat's title when the session was made (the chat's own title wins in listings). */
  title: string;
  activity: CodeActivity;
  /** `running` while a run is going; left `running` by a crash, which `recover` turns into an interrupted run. */
  runState: "idle" | "running";
  /** User turns so far (user messages stored in the chat). */
  turns: number;
  /** Cost of the run going now. */
  runCostUsd: number;
  /** Epoch ms the current run started. */
  runStartedAt?: number;
  pendingPrompt?: StoredPrompt;
  sessionRules: SessionRule[];
  /** The repo's AGENTS.md / CLAUDE.md as read when the session was made (instructions, never settings). */
  instructions: string;
  /** `<worktree_root>/<id>` when the session was made (holds session.json and events.jsonl). */
  sessionDir: string;
}

const COLUMNS: Array<[name: string, decl: string]> = [
  ["chat_id", "TEXT NOT NULL DEFAULT ''"],
  ["parent_chat_id", "TEXT"],
  ["title", "TEXT NOT NULL DEFAULT ''"],
  ["repo_name", "TEXT NOT NULL DEFAULT ''"],
  ["repo_path", "TEXT NOT NULL DEFAULT ''"],
  ["base_ref", "TEXT NOT NULL DEFAULT ''"],
  ["base_sha", "TEXT NOT NULL DEFAULT ''"],
  ["branch", "TEXT NOT NULL DEFAULT ''"],
  ["slug", "TEXT NOT NULL DEFAULT ''"],
  ["engine", "TEXT NOT NULL DEFAULT 'claude'"],
  ["model", "TEXT"],
  ["engine_session_id", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["isolation", "TEXT NOT NULL DEFAULT 'clone'"],
  ["include_uncommitted", "INTEGER NOT NULL DEFAULT 0"],
  ["created_at", "INTEGER NOT NULL DEFAULT 0"],
  ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
  ["archived_at", "INTEGER"],
  ["last_snapshot_turn", "INTEGER"],
  ["cost_usd", "REAL NOT NULL DEFAULT 0"],
  ["activity", "TEXT NOT NULL DEFAULT 'idle'"],
  ["run_state", "TEXT NOT NULL DEFAULT 'idle'"],
  ["turns", "INTEGER NOT NULL DEFAULT 0"],
  ["run_cost_usd", "REAL NOT NULL DEFAULT 0"],
  ["run_started_at", "INTEGER"],
  ["pending_prompt", "TEXT"],
  ["session_rules", "TEXT NOT NULL DEFAULT '[]'"],
  ["instructions", "TEXT NOT NULL DEFAULT ''"],
  ["session_dir", "TEXT NOT NULL DEFAULT ''"],
];

const COMMAND_COLUMNS: Array<[name: string, decl: string]> = [
  ["turn", "INTEGER NOT NULL DEFAULT 0"],
  ["command", "TEXT NOT NULL DEFAULT ''"],
  ["argv", "TEXT"],
  ["cwd", "TEXT NOT NULL DEFAULT ''"],
  ["status", "TEXT NOT NULL DEFAULT 'running'"],
  ["exit_code", "INTEGER"],
  ["started_at", "INTEGER NOT NULL DEFAULT 0"],
  ["duration_ms", "INTEGER"],
  ["output", "TEXT NOT NULL DEFAULT ''"],
  ["output_truncated", "INTEGER NOT NULL DEFAULT 0"],
  ["denied_reason", "TEXT"],
];

/** Output kept per command. */
export const MAX_COMMAND_OUTPUT = 64 * 1024;

interface SessionDbRow {
  id: string;
  chat_id: string;
  parent_chat_id: string | null;
  title: string;
  repo_name: string;
  repo_path: string;
  base_ref: string;
  base_sha: string;
  branch: string;
  slug: string;
  engine: string;
  model: string | null;
  engine_session_id: string | null;
  status: string;
  isolation: string;
  include_uncommitted: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  last_snapshot_turn: number | null;
  cost_usd: number;
  activity: string;
  run_state: string;
  turns: number;
  run_cost_usd: number;
  run_started_at: number | null;
  pending_prompt: string | null;
  session_rules: string;
  instructions: string;
  session_dir: string;
}

interface CommandDbRow {
  session_id: string;
  id: string;
  turn: number;
  command: string;
  argv: string | null;
  cwd: string;
  status: string;
  exit_code: number | null;
  started_at: number;
  duration_ms: number | null;
  output: string;
  output_truncated: number;
  denied_reason: string | null;
}

const ACTIVITIES: readonly CodeActivity[] = ["idle", "running", "needs_approval", "ready", "error"];

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(r: SessionDbRow): CodeSessionRow {
  const rules = parseJson<unknown>(r.session_rules, []);
  return {
    id: r.id,
    chatId: r.chat_id,
    ...(r.parent_chat_id ? { parentChatId: r.parent_chat_id } : {}),
    title: r.title,
    repoName: r.repo_name,
    repoPath: r.repo_path,
    baseRef: r.base_ref,
    baseSha: r.base_sha,
    branch: r.branch,
    slug: r.slug,
    engine: r.engine as CodeEngineId,
    ...(r.model ? { model: r.model } : {}),
    ...(r.engine_session_id ? { engineSessionId: r.engine_session_id } : {}),
    status: (r.status === "archived" ? "archived" : "active") as CodeSessionState,
    isolation: (r.isolation === "worktree" ? "worktree" : "clone") as CodeIsolation,
    includeUncommitted: r.include_uncommitted === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
    ...(r.last_snapshot_turn ? { lastSnapshotTurn: r.last_snapshot_turn } : {}),
    costUsd: r.cost_usd,
    activity: (ACTIVITIES as readonly string[]).includes(r.activity) ? (r.activity as CodeActivity) : "idle",
    runState: r.run_state === "running" ? "running" : "idle",
    turns: r.turns,
    runCostUsd: r.run_cost_usd,
    ...(r.run_started_at ? { runStartedAt: r.run_started_at } : {}),
    ...(r.pending_prompt ? { pendingPrompt: parseJson<StoredPrompt | undefined>(r.pending_prompt, undefined) } : {}),
    sessionRules: Array.isArray(rules)
      ? rules.filter((x): x is SessionRule => !!x && typeof (x as SessionRule).pattern === "string").map((x) => ({ pattern: x.pattern, hosts: Array.isArray(x.hosts) ? x.hosts.map(String) : [] }))
      : [],
    instructions: r.instructions,
    sessionDir: r.session_dir,
  };
}

/** camelCase field → column, for `update`. */
const FIELD_COLUMNS: Partial<Record<keyof CodeSessionRow, string>> = {
  chatId: "chat_id",
  parentChatId: "parent_chat_id",
  title: "title",
  repoName: "repo_name",
  repoPath: "repo_path",
  baseRef: "base_ref",
  baseSha: "base_sha",
  branch: "branch",
  slug: "slug",
  engine: "engine",
  model: "model",
  engineSessionId: "engine_session_id",
  status: "status",
  isolation: "isolation",
  includeUncommitted: "include_uncommitted",
  createdAt: "created_at",
  updatedAt: "updated_at",
  archivedAt: "archived_at",
  lastSnapshotTurn: "last_snapshot_turn",
  costUsd: "cost_usd",
  activity: "activity",
  runState: "run_state",
  turns: "turns",
  runCostUsd: "run_cost_usd",
  runStartedAt: "run_started_at",
  pendingPrompt: "pending_prompt",
  sessionRules: "session_rules",
  instructions: "instructions",
  sessionDir: "session_dir",
};

const NULLABLE = new Set<keyof CodeSessionRow>(["parentChatId", "model", "engineSessionId", "archivedAt", "lastSnapshotTurn", "runStartedAt", "pendingPrompt"]);

function toColumnValue(field: keyof CodeSessionRow, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (field === "pendingPrompt" || field === "sessionRules") return JSON.stringify(value);
  if (field === "includeUncommitted") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

export class CodeStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** Create what is missing; only ever adds tables and columns. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS code_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS code_commands (session_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (session_id, id));
    `);
    this.addColumns("code_sessions", COLUMNS);
    this.addColumns("code_commands", COMMAND_COLUMNS);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_code_sessions_chat ON code_sessions(chat_id);
      CREATE INDEX IF NOT EXISTS idx_code_commands_session ON code_commands(session_id, started_at);
    `);
    const current = Number(this.meta("schema_version") ?? 0);
    if (current < SCHEMA_VERSION) {
      this.db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
    }
  }

  private addColumns(table: string, columns: Array<[string, string]>): void {
    const have = new Set((this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, decl] of columns) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    }
  }

  meta(key: string): string | null {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }

  schemaVersion(): number {
    return Number(this.meta("schema_version") ?? 0);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  insert(row: CodeSessionRow): void {
    const fields = Object.keys(FIELD_COLUMNS) as Array<keyof CodeSessionRow>;
    const cols = ["id", ...fields.map((f) => FIELD_COLUMNS[f]!)];
    const values = [row.id, ...fields.map((f) => toColumnValue(f, row[f]))];
    // Columns with NOT NULL defaults get their default when the value is absent.
    const pairs = cols.map((c, i) => [c, values[i]] as const).filter(([, v]) => v !== null);
    this.db
      .query(`INSERT INTO code_sessions (${pairs.map(([c]) => c).join(", ")}) VALUES (${pairs.map(() => "?").join(", ")})`)
      .run(...pairs.map(([, v]) => v));
  }

  get(id: string): CodeSessionRow | null {
    const r = this.db.query("SELECT * FROM code_sessions WHERE id = ?").get(id) as SessionDbRow | null;
    return r ? toRow(r) : null;
  }

  getByChat(chatId: string): CodeSessionRow | null {
    const r = this.db.query("SELECT * FROM code_sessions WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1").get(chatId) as SessionDbRow | null;
    return r ? toRow(r) : null;
  }

  /** Newest first. */
  list(q: { status?: CodeSessionState | "all"; chat?: string } = {}): CodeSessionRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (q.status && q.status !== "all") {
      where.push("status = ?");
      args.push(q.status);
    }
    if (q.chat) {
      where.push("chat_id = ?");
      args.push(q.chat);
    }
    const sql = `SELECT * FROM code_sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id`;
    return (this.db.query(sql).all(...args) as SessionDbRow[]).map(toRow);
  }

  /** Set some fields; `undefined` clears a nullable one (pass only what changes). */
  update(id: string, patch: Partial<Omit<CodeSessionRow, "id">>): CodeSessionRow | null {
    // Clearing is only possible for nullable columns; an undefined required field is left as it is.
    const fields = (Object.keys(patch) as Array<keyof CodeSessionRow>).filter(
      (f) => FIELD_COLUMNS[f] && (patch[f as keyof typeof patch] !== undefined || NULLABLE.has(f)),
    );
    if (fields.length > 0) {
      const sets = fields.map((f) => `${FIELD_COLUMNS[f]} = ?`).join(", ");
      const values = fields.map((f) => toColumnValue(f, patch[f as keyof typeof patch]));
      this.db.query(`UPDATE code_sessions SET ${sets} WHERE id = ?`).run(...values, id);
    }
    return this.get(id);
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM code_commands WHERE session_id = ?").run(id);
      this.db.query("DELETE FROM code_sessions WHERE id = ?").run(id);
    })();
  }

  activeCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM code_sessions WHERE status = 'active'").get() as { n: number }).n;
  }

  // ── Commands (the Terminal tab) ───────────────────────────────────────────

  /** Insert or replace one command. */
  putCommand(sessionId: string, c: CodeCommandEntry): void {
    const output = c.output.length > MAX_COMMAND_OUTPUT ? c.output.slice(-MAX_COMMAND_OUTPUT) : c.output;
    this.db
      .query(
        `INSERT INTO code_commands (session_id, id, turn, command, argv, cwd, status, exit_code, started_at, duration_ms, output, output_truncated, denied_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, id) DO UPDATE SET turn = excluded.turn, command = excluded.command, argv = excluded.argv, cwd = excluded.cwd,
           status = excluded.status, exit_code = excluded.exit_code, started_at = excluded.started_at, duration_ms = excluded.duration_ms,
           output = excluded.output, output_truncated = excluded.output_truncated, denied_reason = excluded.denied_reason`,
      )
      .run(
        sessionId,
        c.id,
        c.turn,
        c.command,
        c.argv ? JSON.stringify(c.argv) : null,
        c.cwd,
        c.status,
        c.exitCode ?? null,
        c.startedAt,
        c.durationMs ?? null,
        output,
        c.outputTruncated || output.length < c.output.length ? 1 : 0,
        c.deniedReason ?? null,
      );
  }

  getCommand(sessionId: string, id: string): CodeCommandEntry | null {
    const r = this.db.query("SELECT * FROM code_commands WHERE session_id = ? AND id = ?").get(sessionId, id) as CommandDbRow | null;
    return r ? toCommand(r) : null;
  }

  /** Oldest first. */
  commands(sessionId: string): CodeCommandEntry[] {
    return (this.db.query("SELECT * FROM code_commands WHERE session_id = ? ORDER BY started_at, rowid").all(sessionId) as CommandDbRow[]).map(toCommand);
  }

  /** Commands left `running` by a crash or a stop. */
  settleRunningCommands(sessionId: string, now: number): void {
    this.db.query("UPDATE code_commands SET status = 'failed', duration_ms = COALESCE(duration_ms, ? - started_at) WHERE session_id = ? AND status = 'running'").run(now, sessionId);
  }
}

function toCommand(r: CommandDbRow): CodeCommandEntry {
  const status = (["running", "ok", "failed", "denied"] as const).find((s) => s === r.status) ?? "failed";
  return {
    id: r.id,
    turn: r.turn,
    command: r.command,
    ...(r.argv ? { argv: parseJson<string[]>(r.argv, []) } : {}),
    cwd: r.cwd,
    status,
    // Absent when unknown (engines don't all report it); null would mean "killed".
    ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
    startedAt: r.started_at,
    ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
    output: r.output,
    ...(r.output_truncated ? { outputTruncated: true } : {}),
    ...(r.denied_reason ? { deniedReason: r.denied_reason } : {}),
  };
}
