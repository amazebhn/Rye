/**
 * ChatStore — saved conversations, in SQLite (`chats.db`).
 *
 * Each chat is a row and each message its own row, so saving a chat costs only
 * the messages that changed, however much history there is, and message text is
 * full-text indexed for search. Nothing is ever dropped for being old.
 *
 * Chats used to live in one JSON file (`chats.json`) that was rewritten whole on
 * every save and capped at 50 unfiled chats. `migrateLegacyChats` imports that
 * file; see there for what it guarantees.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingPrompt, PromptType } from "@rye/shared";
import { DATA_DIR } from "../config.js";
import { embedBatchLocal, embedQueryLocal, embedTextLocal, type EmbeddingResult } from "../embeddings/index.js";
import { VectorIndex, blobToVector, quantise, standsOut, vectorToBlob } from "../embeddings/vector-index.js";
import {
  editDistance,
  isDistinctive,
  messageText,
  parseQuery,
  requiredTerms,
  searchChats,
  snippetAround,
  stem,
  typoBudget,
  wordsOf,
  type ChatSearchHit,
  type ChatSearchOptions,
} from "./search.js";

/** How message text is turned into vectors. The default is the local model only: chat history is never sent to a hosted embedder. */
export interface ChatEmbedders {
  embedBatch: (texts: string[]) => Promise<EmbeddingResult[] | null>;
  embedText: (text: string) => Promise<EmbeddingResult | null>;
  /** For search queries, when the model words them differently from stored text; `embedText` otherwise. */
  embedQuery?: (text: string) => Promise<EmbeddingResult | null>;
}

/** Wait this long after the last save before embedding, so a reply still streaming isn't embedded over and over. */
const EMBED_DELAY_MS = 5000;
/** Try again this long after the embedder was unreachable. */
const EMBED_RETRY_MS = 60_000;
const EMBED_BATCH = 32;
/** Text embedded per message; the start of a long reply says what it is about. */
const EMBED_CHARS = 4000;
/** Messages considered per search for "says something similar". */
const RELATED_CANDIDATES = 40;
/** Shorter queries are too vague to compare by meaning. */
const RELATED_MIN_QUERY_CHARS = 4;
// How close a message must be to count as "says something similar". Tuned on nomic-embed-text with short
// chat messages: unrelated queries peaked 0.05-0.11 above the background level, real paraphrases 0.12-0.36.
// The band keeps only matches near the best one, which is where the unrelated tail gets cut.
const RELATED_MARGIN = 0.12;
const RELATED_BAND = 0.06;
/** Messages shorter than this are not offered as "related" (see relatedMessages). */
const RELATED_MIN_MESSAGE_CHARS = 30;
/** With too few messages to know the background level, only a strong match counts. */
const RELATED_MIN_ALONE = 0.6;

const CHAT_DB_FILE = join(DATA_DIR, "chats.db");
const LEGACY_CHAT_FILE = join(DATA_DIR, "chats.json");
/** Chats scored per search. The index narrows to chats containing the words; the newest of those are ranked. */
const SEARCH_CANDIDATES = 300;

export interface ChatHistoryRecord {
  id: string;
  title: string;
  sessionId: string;
  messages: unknown[];
  updatedAt: number;
  model?: string;
  pendingPrompt?: PendingPrompt;
  env?: string;
  unread?: boolean;
  folderId?: string;
  folderSuggestionDismissed?: boolean;
  agentId?: string;
}

/** A chat without its messages, for listings. */
export type ChatSummary = Omit<ChatHistoryRecord, "messages"> & { messageCount: number };

// Changed only through the folder endpoints; client record writes keep the stored values.
type FolderFields = Pick<ChatHistoryRecord, "folderId" | "folderSuggestionDismissed">;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePendingPrompt(raw: unknown): PendingPrompt | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" ? raw.id : null;
  const type = raw.type;
  const question = typeof raw.question === "string" ? raw.question : null;
  const options = raw.options === undefined
    ? undefined
    : (Array.isArray(raw.options) && raw.options.every((option) => typeof option === "string")
      ? raw.options
      : null);

  const validTypes: PromptType[] = ["yesno", "choice", "text"];
  if (!id || !question || !validTypes.includes(type as PromptType) || options === null) return undefined;
  return { id, type: type as PromptType, question, options, ...(raw.multiSelect === true ? { multiSelect: true } : {}) };
}

export function normalizeChat(raw: unknown): ChatHistoryRecord | null {
  if (!isObject(raw)) return null;

  const id = typeof raw.id === "string" ? raw.id : null;
  const title = typeof raw.title === "string" ? raw.title : null;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
    ? raw.updatedAt
    : Date.now();
  const model = typeof raw.model === "string" ? raw.model : undefined;
  const pendingPrompt = normalizePendingPrompt(raw.pendingPrompt);
  const env = typeof raw.env === "string" ? raw.env : undefined;
  const unread = raw.unread === true ? true : undefined;
  const folderId = typeof raw.folderId === "string" && raw.folderId ? raw.folderId : undefined;
  const folderSuggestionDismissed = raw.folderSuggestionDismissed === true ? true : undefined;
  const agentId = typeof raw.agentId === "string" && raw.agentId ? raw.agentId : undefined;

  if (!id || !title || sessionId === null) return null;

  return {
    id,
    title,
    sessionId,
    messages,
    updatedAt,
    model,
    pendingPrompt,
    env,
    unread,
    folderId,
    folderSuggestionDismissed,
    agentId,
  };
}

interface ChatRow {
  id: string;
  title: string;
  session_id: string;
  updated_at: number;
  model: string | null;
  pending_prompt: string | null;
  env: string | null;
  unread: number;
  folder_id: string | null;
  folder_suggestion_dismissed: number;
  agent_id: string | null;
  message_count: number;
}

function rowToSummary(row: ChatRow): ChatSummary {
  let pendingPrompt: PendingPrompt | undefined;
  if (row.pending_prompt) {
    try {
      pendingPrompt = normalizePendingPrompt(JSON.parse(row.pending_prompt));
    } catch {
      pendingPrompt = undefined;
    }
  }
  return {
    id: row.id,
    title: row.title,
    sessionId: row.session_id,
    updatedAt: row.updated_at,
    model: row.model ?? undefined,
    pendingPrompt,
    env: row.env ?? undefined,
    unread: row.unread ? true : undefined,
    folderId: row.folder_id ?? undefined,
    folderSuggestionDismissed: row.folder_suggestion_dismissed ? true : undefined,
    agentId: row.agent_id ?? undefined,
    messageCount: row.message_count,
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/**
 * An FTS5 query for one search term: its words as a phrase, the last one a
 * prefix, so "repl" finds "replication" and "pay-1234" finds PAY-1234.
 * Null when the term has no letters or digits to index.
 */
function ftsQuery(term: string): string | null {
  const tokens = term.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return null;
  // The index stores word roots (porter), so "lagging" and "lag" meet there. The plain phrase is
  // matched through that; the starred one is the as-you-type prefix ("repl" for "replication").
  const phrase = `"${tokens.join(" ")}"`;
  return `${phrase} * OR ${phrase}`;
}

/** Bump to rebuild the search index (text index and vocabulary) from the stored messages on next open. */
const SEARCH_INDEX_VERSION = "2";
/** Corrected spellings tried for a word that matches nothing. */
const MAX_CORRECTIONS = 5;

export interface LegacyMigrationReport {
  /** "imported": the file was read; "none": there was no file; "unchanged": already imported; "failed": see `error`. */
  status: "imported" | "none" | "unchanged" | "failed";
  /** Chats in the file. */
  found: number;
  /** Added to the database. */
  imported: number;
  /** In the file and the database, the file's copy newer: the database copy was replaced. */
  updated: number;
  /** Already in the database, same or newer there. */
  kept: number;
  /** Deleted in the database since; not brought back. */
  deleted: number;
  /** Entries that aren't usable chats (no id or title); saved verbatim in the `legacy_rejects` table. */
  rejected: number;
  error?: string;
}

export class ChatStore {
  private readonly db: Database;

  /**
   * @param dbPath        the SQLite file
   * @param legacyJsonPath the old chats.json to import on open; by default only the real data directory's file
   */
  constructor(
    dbPath = CHAT_DB_FILE,
    legacyJsonPath: string | null = dbPath === CHAT_DB_FILE ? LEGACY_CHAT_FILE : null,
    // Only the real store embeds by default; anything else (tests) must pass its own embedders.
    embedders: ChatEmbedders | null = dbPath === CHAT_DB_FILE ? { embedBatch: embedBatchLocal, embedText: embedTextLocal, embedQuery: embedQueryLocal } : null,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id                          TEXT PRIMARY KEY,
        title                       TEXT NOT NULL,
        session_id                  TEXT NOT NULL,
        updated_at                  INTEGER NOT NULL,
        model                       TEXT,
        pending_prompt              TEXT,
        env                         TEXT,
        unread                      INTEGER NOT NULL DEFAULT 0,
        folder_id                   TEXT,
        folder_suggestion_dismissed INTEGER NOT NULL DEFAULT 0,
        agent_id                    TEXT,
        message_count               INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id);
      CREATE INDEX IF NOT EXISTS idx_chats_folder ON chats(folder_id);

      -- One row per message. "data" is the message exactly as the client sent it (JSON);
      -- "text" is what search looks at (what the user or Rye said), "hash" lets a save skip unchanged rows.
      CREATE TABLE IF NOT EXISTS messages (
        id      INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        idx     INTEGER NOT NULL,
        role    TEXT NOT NULL DEFAULT '',
        text    TEXT NOT NULL DEFAULT '',
        hash    TEXT NOT NULL,
        data    TEXT NOT NULL,
        UNIQUE (chat_id, idx)
      );

      -- "porter" indexes word roots, so "lagging" and "lag" are the same entry. A database made before
      -- that is switched over by rebuildSearchIndex below (this line only applies to a new one).
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
      -- Every word seen in a title or message, as written: what a misspelt search word is corrected against.
      -- Words are only added; one left over from deleted text just corrects to something that finds nothing.
      CREATE TABLE IF NOT EXISTS words (word TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Chats the user deleted: a save still in flight must not bring one back.
      CREATE TABLE IF NOT EXISTS deleted_chats (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Entries of the old chats.json that could not be read as chats, kept as they were.
      CREATE TABLE IF NOT EXISTS legacy_rejects (id INTEGER PRIMARY KEY, imported_at INTEGER NOT NULL, raw TEXT NOT NULL);

      -- An embedding per message (one byte per dimension), for finding messages by meaning.
      -- Derived data: filled in the background, dropped when the message's text changes, safe to delete.
      CREATE TABLE IF NOT EXISTS message_vectors (message_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
      CREATE TRIGGER IF NOT EXISTS message_vectors_ad AFTER DELETE ON messages BEGIN
        DELETE FROM message_vectors WHERE message_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS message_vectors_au AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN
        DELETE FROM message_vectors WHERE message_id = old.id;
      END;

      -- The vectors of the embedding model used before the current one, kept so that switching back
      -- restores them. They stay true the same way: a deleted or reworded message loses its row.
      CREATE TABLE IF NOT EXISTS message_vectors_prev (message_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
      CREATE TRIGGER IF NOT EXISTS message_vectors_prev_ad AFTER DELETE ON messages BEGIN
        DELETE FROM message_vectors_prev WHERE message_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS message_vectors_prev_au AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN
        DELETE FROM message_vectors_prev WHERE message_id = old.id;
      END;
    `);
    this.embedders = embedders;
    // Once per index version. Chats imported from the old file further down are indexed as they are written.
    if (this.meta("search_index") !== SEARCH_INDEX_VERSION) {
      const started = performance.now();
      this.rebuildSearchIndex();
      const indexed = (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE text != ''").get() as { n: number }).n;
      if (indexed > 0) console.log(`[${new Date().toISOString()}] [chat] rebuilt the search index for ${indexed} message(s) in ${Math.round(performance.now() - started)} ms`);
    }
    // Anything saved while no embedder was reachable (or before this existed) is picked up now.
    this.scheduleEmbedding();

    if (legacyJsonPath) {
      const report = migrateLegacyChats(this, legacyJsonPath);
      if (report.status === "imported") {
        console.log(
          `[${new Date().toISOString()}] [chat] imported ${legacyJsonPath}: ${report.found} chat(s) found, ` +
            `${report.imported} added, ${report.updated} updated, ${report.kept} already present, ${report.deleted} previously deleted, ` +
            `${report.rejected} unreadable (kept in legacy_rejects). The file was left in place as a backup.`,
        );
      } else if (report.status === "failed") {
        console.error(`[${new Date().toISOString()}] [chat] could not import ${legacyJsonPath}: ${report.error}. The file was not changed; it will be tried again on the next start.`);
      }
    }
  }

  close(): void {
    if (this.embedTimer) clearTimeout(this.embedTimer);
    this.embedTimer = null;
    this.closed = true;
    this.db.close();
  }

  // ── Message embeddings ─────────────────────────────────────────────────────

  private readonly embedders: ChatEmbedders | null;
  private embedTimer: ReturnType<typeof setTimeout> | null = null;
  private embedRunning = false;
  private closed = false;
  // Every message vector, packed in memory. Built on first use and dropped whenever messages or vectors change.
  private vectors: VectorIndex | null = null;

  /** Embed what is missing once saving has gone quiet. Each call pushes the start back. */
  private scheduleEmbedding(delayMs = EMBED_DELAY_MS): void {
    if (!this.embedders || this.closed) return;
    if (this.embedTimer) clearTimeout(this.embedTimer);
    this.embedTimer = setTimeout(() => {
      this.embedTimer = null;
      void this.embedPending().catch((err) => console.error(`[${new Date().toISOString()}] [chat] embedding failed:`, err));
    }, delayMs);
    // Never keep the process alive just for this.
    (this.embedTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Switch message vectors to `model`. The vectors of the model being left are
   * kept in `message_vectors_prev` (one previous model at a time); when `model`
   * is the one kept there, its vectors come back and only messages written since
   * need embedding. Returns whether anything changed.
   */
  useEmbeddingModel(model: string): boolean {
    if (!model || this.meta("embedding_model") === model) return false;
    this.db.transaction(() => {
      const current = (this.db.query("SELECT COUNT(*) AS n FROM message_vectors").get() as { n: number }).n;
      const kept = (this.db.query("SELECT model FROM message_vectors_prev LIMIT 1").get() as { model: string } | null)?.model ?? null;
      if (kept === model) {
        this.db.exec(`
          CREATE TEMP TABLE IF NOT EXISTS message_vectors_swap (message_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
          DELETE FROM message_vectors_swap;
          INSERT INTO message_vectors_swap SELECT message_id, model, vec FROM message_vectors;
          DELETE FROM message_vectors;
          INSERT INTO message_vectors SELECT message_id, model, vec FROM message_vectors_prev;
          DELETE FROM message_vectors_prev;
          INSERT INTO message_vectors_prev SELECT message_id, model, vec FROM message_vectors_swap;
          DROP TABLE message_vectors_swap;
        `);
      } else if (current > 0) {
        this.db.exec(`
          DELETE FROM message_vectors_prev;
          INSERT INTO message_vectors_prev SELECT message_id, model, vec FROM message_vectors;
          DELETE FROM message_vectors;
        `);
      }
      this.db.query("INSERT INTO meta (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(model);
    })();
    this.vectors = null;
    this.scheduleEmbedding(250);
    return true;
  }

  /** Which model message vectors come from, how many there are, and what is kept from the previous model. */
  embeddingStatus(): { model: string | null; messages: number; embedded: number; backup: { model: string; messages: number } | null } {
    const one = (sql: string) => (this.db.query(sql).get() as { n: number }).n;
    const backup = this.db.query("SELECT model, COUNT(*) AS messages FROM message_vectors_prev GROUP BY model ORDER BY messages DESC LIMIT 1").get() as { model: string; messages: number } | null;
    return {
      model: this.meta("embedding_model") || null,
      messages: one("SELECT COUNT(*) AS n FROM messages WHERE text != ''"),
      embedded: one("SELECT COUNT(*) AS n FROM message_vectors"),
      backup: backup ?? null,
    };
  }

  /** How many messages have text but no embedding yet. */
  pendingEmbeddings(): number {
    return (this.db
      .query("SELECT COUNT(*) AS n FROM messages m LEFT JOIN message_vectors v ON v.message_id = m.id WHERE m.text != '' AND v.message_id IS NULL")
      .get() as { n: number }).n;
  }

  /**
   * Embed messages that have no vector yet, newest first. Returns how many were
   * embedded. Stops quietly when the embedder is unreachable and tries again later.
   */
  async embedPending(maxBatches = 25): Promise<number> {
    if (!this.embedders || this.embedRunning || this.closed) return 0;
    this.embedRunning = true;
    let done = 0;
    try {
      for (let batch = 0; batch < maxBatches && !this.closed; batch++) {
        const rows = this.db
          .query(
            `SELECT m.id, m.text FROM messages m LEFT JOIN message_vectors v ON v.message_id = m.id
             WHERE m.text != '' AND v.message_id IS NULL ORDER BY m.id DESC LIMIT ?`,
          )
          .all(EMBED_BATCH) as Array<{ id: number; text: string }>;
        if (rows.length === 0) return done;
        const results = await this.embedders.embedBatch(rows.map((r) => r.text.slice(0, EMBED_CHARS)));
        if (this.closed) return done;
        if (!results || results.length !== rows.length) {
          this.scheduleEmbedding(EMBED_RETRY_MS);
          return done;
        }
        const model = results[0].model;
        this.db.transaction(() => {
          // Vectors from another model can't be compared with these: the old ones are set aside.
          this.useEmbeddingModel(model);
          // Only for messages that still say what was embedded; one edited meanwhile is picked up next round.
          const put = this.db.query(
            "INSERT OR REPLACE INTO message_vectors (message_id, model, vec) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND text = ?)",
          );
          rows.forEach((row, i) => put.run(row.id, model, vectorToBlob(quantise(results[i].vector)), row.id, row.text));
        })();
        this.vectors = null;
        done += rows.length;
      }
      // More than one run's worth (a first backfill): carry on shortly.
      if (this.pendingEmbeddings() > 0) this.scheduleEmbedding(250);
      return done;
    } finally {
      this.embedRunning = false;
    }
  }

  private vectorIndex(dimensions: number): VectorIndex {
    if (this.vectors?.dimensions === dimensions) return this.vectors;
    const rows = this.db.query("SELECT message_id, vec FROM message_vectors WHERE length(vec) = ?").all(dimensions) as Array<{ message_id: number; vec: Uint8Array }>;
    const index = new VectorIndex(dimensions, rows.length);
    for (const row of rows) index.add(Number(row.message_id), blobToVector(new Uint8Array(row.vec)));
    this.vectors = index;
    return index;
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  private messagesOf(id: string): unknown[] {
    const rows = this.db.query("SELECT data FROM messages WHERE chat_id = ? ORDER BY idx").all(id) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as unknown);
  }

  private toRecord(row: ChatRow): ChatHistoryRecord {
    const { messageCount: _count, ...summary } = rowToSummary(row);
    return { ...summary, messages: this.messagesOf(row.id) };
  }

  /** Every chat with its messages, newest first. Prefer `summaries` when the messages aren't needed. */
  list(): ChatHistoryRecord[] {
    const rows = this.db.query("SELECT * FROM chats ORDER BY updated_at DESC, id").all() as ChatRow[];
    return rows.map((row) => this.toRecord(row));
  }

  /** Every chat without its messages, newest first. */
  summaries(): ChatSummary[] {
    return (this.db.query("SELECT * FROM chats ORDER BY updated_at DESC, id").all() as ChatRow[]).map(rowToSummary);
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n;
  }

  get(id: string): ChatHistoryRecord | null {
    const row = this.db.query("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | null;
    return row ? this.toRecord(row) : null;
  }

  /** The most recently active chat bound to an agent session. */
  getBySession(sessionId: string): ChatHistoryRecord | null {
    if (!sessionId) return null;
    const row = this.db.query("SELECT * FROM chats WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1").get(sessionId) as ChatRow | null;
    return row ? this.toRecord(row) : null;
  }

  isDeleted(id: string): boolean {
    return this.db.query("SELECT 1 FROM deleted_chats WHERE id = ?").get(id) !== null;
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  /** Write one chat and whichever of its messages changed. Caller holds the transaction. */
  private write(chat: ChatHistoryRecord): void {
    this.db
      .query(
        `INSERT INTO chats (id, title, session_id, updated_at, model, pending_prompt, env, unread, folder_id, folder_suggestion_dismissed, agent_id, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, session_id = excluded.session_id, updated_at = excluded.updated_at, model = excluded.model,
           pending_prompt = excluded.pending_prompt, env = excluded.env, unread = excluded.unread, folder_id = excluded.folder_id,
           folder_suggestion_dismissed = excluded.folder_suggestion_dismissed, agent_id = excluded.agent_id, message_count = excluded.message_count`,
      )
      .run(
        chat.id,
        chat.title,
        chat.sessionId,
        chat.updatedAt,
        chat.model ?? null,
        chat.pendingPrompt ? JSON.stringify(chat.pendingPrompt) : null,
        chat.env ?? null,
        chat.unread ? 1 : 0,
        chat.folderId ?? null,
        chat.folderSuggestionDismissed ? 1 : 0,
        chat.agentId ?? null,
        chat.messages.length,
      );

    // While a reply streams, a chat is saved again and again with only its last message different.
    const stored = new Map(
      (this.db.query("SELECT idx, hash FROM messages WHERE chat_id = ?").all(chat.id) as Array<{ idx: number; hash: string }>).map((r) => [r.idx, r.hash]),
    );
    const put = this.db.query(
      `INSERT INTO messages (chat_id, idx, role, text, hash, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, idx) DO UPDATE SET role = excluded.role, text = excluded.text, hash = excluded.hash, data = excluded.data`,
    );
    let changed = false;
    const seenWords = new Set(wordsOf(chat.title));
    chat.messages.forEach((message, idx) => {
      const data = JSON.stringify(message ?? null);
      const hash = Bun.hash(data).toString(36);
      if (stored.get(idx) === hash) return;
      const said = messageText(message);
      put.run(chat.id, idx, said?.role ?? "", said?.text ?? "", hash, data);
      if (said) for (const word of wordsOf(said.text)) seenWords.add(word);
      changed = true;
    });
    this.rememberWords(seenWords);
    if (stored.size > chat.messages.length) {
      this.db.query("DELETE FROM messages WHERE chat_id = ? AND idx >= ?").run(chat.id, chat.messages.length);
      changed = true;
    }
    if (changed) {
      // Rows changed under the packed vectors; they are reloaded on the next search, and new text is embedded soon.
      this.vectors = null;
      this.scheduleEmbedding();
    }
  }

  private folderFields(id: string): FolderFields {
    const row = this.db.query("SELECT folder_id, folder_suggestion_dismissed FROM chats WHERE id = ?").get(id) as
      | { folder_id: string | null; folder_suggestion_dismissed: number }
      | null;
    return { folderId: row?.folder_id ?? undefined, folderSuggestionDismissed: row?.folder_suggestion_dismissed ? true : undefined };
  }

  /**
   * Save a chat. A record that carries no `messages` list updates the chat's
   * details only (title, model, unread…) and leaves its stored messages alone:
   * that is how a client that never loaded the messages saves a rename, and it
   * means a save can only replace messages by actually sending them.
   */
  upsert(raw: unknown): ChatHistoryRecord | null {
    const parsed = normalizeChat(raw);
    if (!parsed || this.isDeleted(parsed.id)) return null;
    const detailsOnly = !(isObject(raw) && Array.isArray(raw.messages));
    const stored = detailsOnly ? this.get(parsed.id) : null;
    const chat = { ...parsed, ...(stored ? { messages: stored.messages } : {}), ...this.folderFields(parsed.id) };
    this.db.transaction(() => this.write(chat))();
    return chat;
  }

  /**
   * Save several chats at once. Chats not in the list are left alone: only
   * `remove` deletes, so a client holding a partial list can't wipe the rest.
   */
  upsertMany(rawChats: unknown[]): ChatHistoryRecord[] {
    const saved: ChatHistoryRecord[] = [];
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const raw of rawChats) {
        const parsed = normalizeChat(raw);
        if (!parsed || seen.has(parsed.id) || this.isDeleted(parsed.id)) continue;
        seen.add(parsed.id);
        const chat = { ...parsed, ...this.folderFields(parsed.id) };
        this.write(chat);
        saved.push(chat);
      }
    })();
    return saved;
  }

  /** Sets folder fields on existing chats without touching updatedAt. Returns the ids changed. */
  setFolderFields(ids: readonly string[], fields: FolderFields): string[] {
    const changed: string[] = [];
    const update = this.db.query("UPDATE chats SET folder_id = ?, folder_suggestion_dismissed = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const id of new Set(ids)) {
        const current = this.db.query("SELECT 1 FROM chats WHERE id = ?").get(id);
        if (!current) continue;
        const next = { ...this.folderFields(id), ...fields };
        update.run(next.folderId ?? null, next.folderSuggestionDismissed ? 1 : 0, id);
        changed.push(id);
      }
    })();
    return changed;
  }

  unfileFolder(folderId: string): number {
    return this.db.query("UPDATE chats SET folder_id = NULL WHERE folder_id = ?").run(folderId).changes;
  }

  /** Delete a chat for good. Returns whether it existed; either way the id can't be saved again. */
  remove(id: string): boolean {
    let existed = false;
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO deleted_chats (id, deleted_at) VALUES (?, ?)").run(id, Date.now());
      this.db.query("DELETE FROM messages WHERE chat_id = ?").run(id);
      existed = this.db.query("DELETE FROM chats WHERE id = ?").run(id).changes > 0;
    })();
    this.vectors = null;
    return existed;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /** Add words to the vocabulary used for typo correction. Caller holds the transaction. */
  private rememberWords(words: Iterable<string>): void {
    const add = this.db.query("INSERT OR IGNORE INTO words (word) VALUES (?)");
    // Very short words can't be corrected to, and very long ones are ids or hashes nobody misspells.
    for (const word of words) if (word.length >= 4 && word.length <= 40) add.run(word);
  }

  /**
   * Rebuild everything search derives from the stored messages: the text index
   * (dropped and recreated, since its word-root setting can't be changed in place)
   * and the vocabulary. Chats and messages themselves are only read. One
   * transaction, so a failure leaves the previous index in place.
   */
  private rebuildSearchIndex(): void {
    this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
        INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
        DELETE FROM words;
      `);
      const words = new Set<string>();
      for (const row of this.db.query("SELECT title FROM chats").all() as Array<{ title: string }>) for (const w of wordsOf(row.title)) words.add(w);
      for (const row of this.db.query("SELECT text FROM messages WHERE text != ''").all() as Array<{ text: string }>) for (const w of wordsOf(row.text)) words.add(w);
      this.rememberWords(words);
      this.db.query("INSERT INTO meta (key, value) VALUES ('search_index', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SEARCH_INDEX_VERSION);
    })();
  }

  /** Words from the history within a typo or two of `word`, closest first. */
  private corrections(word: string): string[] {
    const budget = typoBudget(word);
    if (budget === 0 || !/^[\p{L}\p{N}]+$/u.test(word)) return [];
    const candidates = this.db
      .query("SELECT word FROM words WHERE length(word) BETWEEN ? AND ?")
      .all(word.length - budget, word.length + budget) as Array<{ word: string }>;
    return candidates
      .map(({ word: other }) => ({ other, distance: other === word ? 0 : editDistance(word, other, budget) }))
      .filter((c) => c.distance > 0 && c.distance <= budget)
      .sort((a, b) => a.distance - b.distance || Math.abs(a.other.length - word.length) - Math.abs(b.other.length - word.length) || a.other.localeCompare(b.other))
      .slice(0, MAX_CORRECTIONS)
      .map((c) => c.other);
  }

  /**
   * Ids of chats whose title or messages contain one search term, as written or as
   * another form of the word. If nothing does, the term is treated as a typo: chats
   * containing a near spelling are returned, with the spellings that were used.
   */
  private chatsContaining(term: string, titles: ReadonlyArray<{ id: string; lower: string; words: string[] }>): { ids: Set<string>; variants: string[] } {
    const ids = new Set<string>();
    const root = term.includes(" ") ? null : stem(term);
    const collect = (text: string, allowForms: boolean) => {
      for (const title of titles) {
        if (title.lower.includes(text) || (allowForms && root !== null && title.words.some((w) => stem(w) === root))) ids.add(title.id);
      }
      const match = ftsQuery(text);
      if (!match) return;
      try {
        (this.db
          .query("SELECT DISTINCT m.chat_id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?")
          .all(match) as Array<{ chat_id: string }>).forEach((r) => ids.add(r.chat_id));
      } catch {
        // An unusual term the index can't parse: the scan below covers it.
      }
    };
    collect(term, true);
    if (ids.size > 0) return { ids, variants: [] };

    // Nothing has the word: try the spellings closest to it that the history does contain.
    const variants: string[] = [];
    for (const correction of this.corrections(term)) {
      const before = ids.size;
      collect(correction, false);
      if (ids.size > before) variants.push(correction);
    }
    if (ids.size > 0) return { ids, variants };

    // Still nothing: the index matches from the start of a word, and the term may sit inside
    // one ("sql" in "mysql") or have no letters or digits to index at all.
    (this.db
      .query("SELECT DISTINCT chat_id FROM messages WHERE text LIKE ? ESCAPE '\\'")
      .all(`%${escapeLike(term)}%`) as Array<{ chat_id: string }>).forEach((r) => ids.add(r.chat_id));
    return { ids, variants: [] };
  }

  /**
   * Search chats two ways and merge: by their words (titles and message text),
   * then by meaning (messages whose embedding is close to the query's). Chats
   * that contain the words always come first; chats found by meaning alone
   * follow, marked `related`. Without a local embedder it is the word search.
   */
  async search(query: string, opts: ChatSearchOptions = {}): Promise<ChatSearchHit[]> {
    const limit = opts.limit ?? 20;
    const perChat = opts.maxMessagesPerChat ?? 3;
    const hits = this.keywordSearch(query, opts);
    const related = await this.relatedMessages(query).catch(() => []);
    if (related.length === 0) return hits;

    const byChat = new Map(hits.map((hit) => [hit.chatId, hit]));
    const chatRow = this.db.query("SELECT * FROM chats WHERE id = ?");
    for (const message of related) {
      let hit = byChat.get(message.chat_id);
      if (!hit) {
        const row = chatRow.get(message.chat_id) as ChatRow | null;
        if (!row || row.id === opts.excludeChatId || (opts.excludeSessionId && row.session_id === opts.excludeSessionId)) continue;
        hit = {
          chatId: row.id,
          title: row.title,
          updatedAt: row.updated_at,
          ...(row.agent_id ? { agentId: row.agent_id } : {}),
          ...(row.folder_id ? { folderId: row.folder_id } : {}),
          titleMatch: false,
          matches: [],
          matchCount: 0,
          related: true,
        };
        byChat.set(row.id, hit);
        hits.push(hit);
      }
      if (hit.matches.some((m) => m.index === message.idx)) continue;
      // A chat found by its words keeps its own count; one found by meaning counts these.
      if (hit.related) hit.matchCount++;
      if (hit.matches.length < perChat) {
        hit.matches.push({ index: message.idx, role: message.role === "user" ? "user" : "assistant", snippet: snippetAround(message.text, []), related: true });
      }
    }
    // Chats with every word first; then ones that say something similar; then ones with only some of the words.
    const tier = (hit: ChatSearchHit) => (hit.related ? 1 : !hit.missing ? 0 : hit.matches.some((m) => m.related) ? 1 : 2);
    return hits
      .map((hit, position) => ({ hit, position }))
      .sort((a, b) => tier(a.hit) - tier(b.hit) || a.position - b.position)
      .slice(0, limit)
      .map(({ hit }) => hit);
  }

  /** Messages whose meaning is close to the query, best first; empty when that can't be judged. */
  private async relatedMessages(query: string): Promise<Array<{ chat_id: string; idx: number; role: string; text: string }>> {
    const text = query.trim();
    if (!this.embedders || text.length < RELATED_MIN_QUERY_CHARS) return [];
    // Nothing embedded yet (or no embedder so far): don't spend a model call on the query.
    if (!this.meta("embedding_model")) return [];
    const embedded = await (this.embedders.embedQuery ?? this.embedders.embedText)(text);
    if (!embedded || this.closed) return [];
    // The stored vectors are another model's (it was just changed): they can't be compared with this query.
    if (embedded.model !== this.meta("embedding_model")) {
      this.useEmbeddingModel(embedded.model);
      return [];
    }
    const { matches, background } = this.vectorIndex(embedded.vector.length).search(embedded.vector, { limit: RELATED_CANDIDATES });
    const best = matches[0]?.similarity ?? 0;
    const close = matches.filter(
      (m) => m.similarity >= best - RELATED_BAND && standsOut(m.similarity, background, { margin: RELATED_MARGIN, minWithoutBackground: RELATED_MIN_ALONE }),
    );
    if (close.length === 0) return [];
    const rows = this.db
      .query(`SELECT id, chat_id, idx, role, text FROM messages WHERE id IN (${close.map(() => "?").join(",")})`)
      .all(...close.map((m) => m.id)) as Array<{ id: number; chat_id: string; idx: number; role: string; text: string }>;
    // Very short messages ("thanks", "ok, try that") carry almost no meaning, and that is exactly
    // why nonsense and off-topic queries land closest to them. They are never offered as related.
    const byId = new Map(rows.filter((r) => r.text.trim().length >= RELATED_MIN_MESSAGE_CHARS).map((r) => [Number(r.id), r]));
    return close.flatMap((m) => byId.get(m.id) ?? []);
  }

  /**
   * Search titles and message text by their words. The full-text index picks out
   * the chats that contain every term; the newest of those are then ranked and
   * excerpted by `searchChats`, so results read the same however large the history is.
   */
  private keywordSearch(query: string, opts: ChatSearchOptions = {}): ChatSearchHit[] {
    const terms = parseQuery(query);
    if (terms.length === 0) return [];
    const titles = (this.db.query("SELECT id, title FROM chats").all() as Array<{ id: string; title: string }>).map((row) => {
      const lower = row.title.toLowerCase();
      return { id: row.id, lower, words: wordsOf(lower) };
    });
    // How many of the terms each chat has, and whether any of them is more than a filler word.
    const termsFound = new Map<string, number>();
    const distinctive = new Set<string>();
    const variants: Record<string, string[]> = {};
    for (const term of terms) {
      const withTerm = this.chatsContaining(term, titles);
      if (withTerm.variants.length > 0) variants[term] = withTerm.variants;
      for (const id of withTerm.ids) {
        termsFound.set(id, (termsFound.get(id) ?? 0) + 1);
        if (isDistinctive(term)) distinctive.add(id);
      }
    }
    // A chat needs most of the terms, not all (searchChats applies the same rule and ranks full matches first).
    const required = requiredTerms(terms.length);
    const rows = (this.db.query("SELECT * FROM chats ORDER BY updated_at DESC, id").all() as ChatRow[])
      .filter((row) => {
        const found = termsFound.get(row.id) ?? 0;
        // A chat with every term always qualifies; one with only some needs a real word among them, not just filler.
        return found >= required && (found === terms.length || distinctive.has(row.id));
      })
      // With more candidates than can be scored, keep those with the most terms; newest first among equals.
      .sort((a, b) => (termsFound.get(b.id) ?? 0) - (termsFound.get(a.id) ?? 0))
      .slice(0, SEARCH_CANDIDATES);
    if (rows.length === 0) return [];

    // Only the searchable text is loaded, placed at each message's own position so match indexes line up.
    const texts = this.db.query("SELECT idx, role, text FROM messages WHERE chat_id = ? AND text != '' ORDER BY idx");
    const chats: ChatHistoryRecord[] = rows.map((row) => {
      const { messageCount, ...summary } = rowToSummary(row);
      const messages: unknown[] = new Array(messageCount).fill(null);
      for (const m of texts.all(row.id) as Array<{ idx: number; role: string; text: string }>) messages[m.idx] = { role: m.role, content: m.text };
      return { ...summary, messages };
    });
    return searchChats(chats, query, { ...opts, variants });
  }

  // ── Import of the old chats.json ───────────────────────────────────────────

  /** @internal used by migrateLegacyChats */
  meta(key: string): string | null {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }

  /** @internal used by migrateLegacyChats */
  importLegacy(rawChats: unknown[], signature: string): Omit<LegacyMigrationReport, "status" | "error"> {
    const report = { found: 0, imported: 0, updated: 0, kept: 0, deleted: 0, rejected: 0 };
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const raw of rawChats) {
        const chat = normalizeChat(raw);
        if (!chat) {
          // Not a usable chat, but still the user's data: keep it as it was.
          this.db.query("INSERT INTO legacy_rejects (imported_at, raw) VALUES (?, ?)").run(Date.now(), JSON.stringify(raw ?? null));
          report.rejected++;
          continue;
        }
        if (seen.has(chat.id)) continue;
        seen.add(chat.id);
        report.found++;
        if (this.isDeleted(chat.id)) {
          report.deleted++;
          continue;
        }
        const existing = this.db.query("SELECT updated_at FROM chats WHERE id = ?").get(chat.id) as { updated_at: number } | null;
        if (existing && existing.updated_at >= chat.updatedAt) {
          report.kept++;
          continue;
        }
        // The file's folder assignment is the one to keep for a chat the database hasn't seen.
        this.write(existing ? { ...chat, ...this.folderFields(chat.id) } : chat);
        if (existing) report.updated++;
        else report.imported++;
      }

      // Check the import before committing: every chat from the file must now be readable with all its messages.
      for (const raw of rawChats) {
        const chat = normalizeChat(raw);
        if (!chat || this.isDeleted(chat.id)) continue;
        const row = this.db.query("SELECT updated_at, message_count FROM chats WHERE id = ?").get(chat.id) as { updated_at: number; message_count: number } | null;
        if (!row) throw new Error(`chat ${chat.id} is missing after import`);
        const stored = (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(chat.id) as { n: number }).n;
        if (stored !== row.message_count) throw new Error(`chat ${chat.id} has ${stored} of ${row.message_count} messages after import`);
        if (row.updated_at <= chat.updatedAt && stored !== chat.messages.length) {
          throw new Error(`chat ${chat.id} has ${stored} messages after import, the file has ${chat.messages.length}`);
        }
      }
      this.db.query("INSERT INTO meta (key, value) VALUES ('legacy_json', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(signature);
    })();
    return report;
  }
}

/**
 * Import the old `chats.json` into the database.
 *
 * - The file is only read, never changed, moved or deleted: it stays as a backup.
 * - The import runs in one transaction and is checked before it commits (every
 *   chat present with all of its messages); on any error nothing is written and
 *   it is tried again on the next start.
 * - It only adds or refreshes: a chat already in the database is replaced only
 *   when the file's copy is newer, and chats deleted since are not brought back.
 * - Entries that aren't usable chats are stored verbatim in `legacy_rejects`.
 * - It is remembered by the file's size and modification time, so it runs once,
 *   and again only if the file changes (an older Rye writing to it).
 */
export function migrateLegacyChats(store: ChatStore, jsonPath: string): LegacyMigrationReport {
  const empty = { found: 0, imported: 0, updated: 0, kept: 0, deleted: 0, rejected: 0 };
  if (!existsSync(jsonPath)) return { status: "none", ...empty };
  try {
    const stat = statSync(jsonPath);
    const signature = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (store.meta("legacy_json") === signature) return { status: "unchanged", ...empty };

    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
    const rawChats = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.chats) ? parsed.chats : null;
    if (!rawChats) throw new Error("the file is not a list of chats");
    return { status: "imported", ...store.importLegacy(rawChats, signature) };
  } catch (err) {
    return { status: "failed", ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
