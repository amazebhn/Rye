/**
 * KnowledgeStore — hybrid RAG store (SQLite FTS5 + vector cosine similarity)
 * for durable system knowledge, architecture notes, and agent learnings.
 *
 * Uses Reciprocal Rank Fusion (RRF) to combine BM25 keyword search with
 * dense embeddings (via Ollama or Copilot), degrading cleanly to FTS5 when
 * no embedding provider is reachable.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.js";
import {
  configuredEmbeddingModel,
  embedBatch,
  embedQuery,
  embedText,
  float32ToBlob,
  type EmbeddingResult,
} from "../embeddings/index.js";
import { VectorIndex, quantise } from "../embeddings/vector-index.js";
import { RELEVANT_SCORE, rerank, type RerankFn } from "../embeddings/rerank.js";
import { createHash } from "node:crypto";

/** Identifies the exact text a vector was made from. */
const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** How many fused candidates the reranker reads for one search; each costs a model call. */
const RERANK_POOL = 12;

export type KnowledgeSource = "manual" | "agent";

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  category: string;
  tags: string[];
  agent_id: string | null;
  embedding_model: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchHit {
  doc_id: string;
  title: string;
  category: string;
  tags: string[];
  source: KnowledgeSource;
  heading: string;
  snippet: string;
  score: number;
  match_type: "hybrid" | "semantic" | "keyword";
  /** The reranker's relevance for this chunk (0 to 1), when one was asked. */
  rerank_score?: number;
  /** Row id of the matched chunk; `${doc_id}#${chunk_id}` identifies it in a conversation. */
  chunk_id: number;
  /** Cosine similarity to the query, when both sides had an embedding. */
  similarity: number | null;
  /** How many distinct meaningful query words appear in the chunk. */
  keyword_terms: number;
  /**
   * Median similarity of the query to every chunk: what "unrelated" scores for
   * this query and embedding model. Null when too few chunks to tell.
   */
  background_similarity: number | null;
}

export interface ContextSearchOptions {
  limit?: number;
  agentId?: string | null;
  /** Chunk keys (`doc_id#chunk_id`) already shown in this conversation. */
  exclude?: Iterable<string>;
  /**
   * Similarity that is enough on its own while the knowledge base is too small
   * to tell what "unrelated" scores. Depends on the embedding model.
   */
  minSimilarity?: number;
}

export const chunkKey = (hit: Pick<KnowledgeSearchHit, "doc_id" | "chunk_id">): string => `${hit.doc_id}#${hit.chunk_id}`;

export interface Chunk {
  heading: string;
  content: string;
}

export type EmbedBatchFn = (texts: string[]) => Promise<EmbeddingResult[] | null>;
export type EmbedTextFn = (text: string) => Promise<EmbeddingResult | null>;

const DEFAULT_MAX_CHUNK_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 180;
const RRF_K = 60;
const MIN_SEMANTIC_SIMILARITY = 0.28;

/**
 * Split Markdown/plain text into semantically coherent chunks, preserving
 * section headings so retrieved snippets carry their context.
 */
export function chunkMarkdown(
  content: string,
  maxChars = DEFAULT_MAX_CHUNK_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
): Chunk[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const sections: Array<{ heading: string; body: string }> = [];
  const lines = normalized.split("\n");
  let currentHeading = "";
  let buffer: string[] = [];

  const flushSection = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ heading: currentHeading, body });
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flushSection();

  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (section.body.length <= maxChars) {
      chunks.push({ heading: section.heading, content: section.body });
      continue;
    }

    const paragraphs = section.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let acc = "";
    for (const para of paragraphs) {
      if (acc && acc.length + 2 + para.length > maxChars) {
        chunks.push({ heading: section.heading, content: acc });
        const tail = overlapChars > 0 ? acc.slice(-overlapChars).trim() : "";
        acc = tail ? `${tail}\n\n${para}` : para;
      } else {
        acc = acc ? `${acc}\n\n${para}` : para;
      }

      while (acc.length > maxChars) {
        chunks.push({ heading: section.heading, content: acc.slice(0, maxChars).trim() });
        const step = Math.max(1, maxChars - overlapChars);
        acc = acc.slice(step).trim();
      }
    }
    if (acc) chunks.push({ heading: section.heading, content: acc });
  }

  return chunks;
}

/** Words that say nothing about the topic; matching on them only adds noise. */
const STOPWORDS = new Set(
  (
    "a about after again all also am an and any are as at be because been before being but by can could did do does doing " +
    "done down for from get got had has have having he her here him his how i if in into is it its just like me more most my " +
    "need no not now of off on once one only or other our out over please same she should so some such than thanks thank that " +
    "the their them then there these they this those to too up us use very want was we were what when where which while who " +
    "why will with would yes yeah ok okay sure you your can't don't it's i'm let lets make show tell give look check see"
  ).split(" "),
);

const tokenise = (raw: string): string[] =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);

/** Distinct topic-bearing words of a query, most 12. */
export function meaningfulTokens(raw: string): string[] {
  return [...new Set(tokenise(raw).filter((t) => !STOPWORDS.has(t)))].slice(0, 12);
}

/** Build a safe FTS5 MATCH query from arbitrary user text. */
function buildFtsQuery(raw: string): string | null {
  const tokens = meaningfulTokens(raw);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

// Gate for showing a chunk unasked (searchForContext). Raw cosine similarity means
// different things per embedding model (nomic-embed-text scores unrelated text around
// 0.35-0.5), so the main test is how far a chunk stands out from the background.
const DEFAULT_CONTEXT_MIN_SIMILARITY = 0.5;
/** Chunks needed before the median similarity is a usable background level. */
const MIN_CHUNKS_FOR_BACKGROUND = 5;
/** How far above the background a chunk must score on similarity alone. */
const STANDOUT_MARGIN = 0.08;
/** ...and when it also shares a keyword with the query. */
const KEYWORD_BACKED_MARGIN = 0.05;

export class KnowledgeStore {
  private db: Database;
  private readonly embedBatchFn: EmbedBatchFn;
  private readonly embedTextFn: EmbedTextFn;
  // Every chunk embedding, packed in memory. Built on first search and dropped whenever chunks change.
  private vectors: VectorIndex | null = null;

  private vectorsModel: string | null = null;
  /** The model new vectors should come from, when known up front; "" when it isn't. */
  private readonly targetModel: () => string;

  /** Only vectors from the model that embedded the query are comparable with it. */
  private vectorIndex(dimensions: number, model: string): VectorIndex {
    if (this.vectors?.dimensions === dimensions && this.vectorsModel === model) return this.vectors;
    this.vectorsModel = model;
    const rows = this.db.query("SELECT id, embedding FROM knowledge_chunks WHERE embedding IS NOT NULL AND embedding_model = ?").all(model) as Array<{
      id: number;
      embedding: Uint8Array;
    }>;
    const index = new VectorIndex(dimensions, rows.length);
    for (const row of rows) {
      // Stored as little-endian float32; embeddings from another model (a different size) are left out.
      if (row.embedding.byteLength !== dimensions * 4) continue;
      const bytes = new Uint8Array(row.embedding);
      index.add(Number(row.id), quantise(new Float32Array(bytes.buffer, 0, dimensions)));
    }
    this.vectors = index;
    return index;
  }

  private readonly rerankFn: RerankFn | undefined;
  private readonly embedQueryFn: EmbedTextFn;

  constructor(
    dbPath = join(DATA_DIR, "knowledge.db"),
    embedders?: { embedBatch?: EmbedBatchFn; embedText?: EmbedTextFn; embedQuery?: EmbedTextFn; rerank?: RerankFn; model?: () => string },
  ) {
    // Only the real knowledge base reranks and reads the configured model by default; a store on another path (a test) passes its own.
    const real = dbPath === join(DATA_DIR, "knowledge.db");
    this.rerankFn = embedders?.rerank ?? (real ? rerank : undefined);
    this.targetModel = embedders?.model ?? (real ? configuredEmbeddingModel : () => "");
    // Queries may be worded differently from documents for the model (see queryPrefix); a supplied embedText serves both.
    this.embedQueryFn = embedders?.embedQuery ?? embedders?.embedText ?? embedQuery;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.embedBatchFn = embedders?.embedBatch ?? embedBatch;
    this.embedTextFn = embedders?.embedText ?? embedText;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_docs (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'manual',
        category        TEXT NOT NULL DEFAULT 'general',
        tags            TEXT NOT NULL DEFAULT '[]',
        agent_id        TEXT,
        embedding_model TEXT,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id          TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
        chunk_index     INTEGER NOT NULL,
        heading         TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL,
        embedding       BLOB,
        embedding_model TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_id ON knowledge_chunks(doc_id);

      -- Vectors from the embedding model used before the current one, keyed by the text they were made
      -- from, so switching back restores them instead of embedding everything again. Derived data.
      CREATE TABLE IF NOT EXISTS knowledge_embedding_backup (
        model     TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY (model, text_hash)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        doc_id UNINDEXED,
        title,
        heading,
        content
      );
    `);
  }

  async create(opts: {
    title: string;
    content: string;
    source?: KnowledgeSource;
    category?: string;
    tags?: string[];
    agentId?: string | null;
  }): Promise<KnowledgeDoc> {
    const id = `kn_${randomUUID().slice(0, 8)}`;
    const title = opts.title.trim();
    const content = opts.content.trim();
    const source: KnowledgeSource = opts.source ?? "manual";
    const category = (opts.category ?? "general").trim() || "general";
    const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
    const agentId = opts.agentId ?? null;

    this.db.run(
      `INSERT INTO knowledge_docs (id, title, content, source, category, tags, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, title, content, source, category, JSON.stringify(tags), agentId],
    );

    await this.indexDoc(id, title, content);
    return this.get(id)!;
  }

  async update(
    id: string,
    opts: {
      title?: string;
      content?: string;
      category?: string;
      tags?: string[];
      agentId?: string | null;
    },
  ): Promise<KnowledgeDoc | null> {
    const existing = this.get(id);
    if (!existing) return null;

    const title = opts.title !== undefined ? opts.title.trim() : existing.title;
    const content = opts.content !== undefined ? opts.content.trim() : existing.content;
    const category = opts.category !== undefined ? (opts.category.trim() || "general") : existing.category;
    const tags = opts.tags !== undefined ? opts.tags.map((t) => t.trim()).filter(Boolean) : existing.tags;
    const agentId = opts.agentId !== undefined ? opts.agentId : existing.agent_id;

    this.db.run(
      `UPDATE knowledge_docs
       SET title = ?, content = ?, category = ?, tags = ?, agent_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [title, content, category, JSON.stringify(tags), agentId, id],
    );

    await this.indexDoc(id, title, content);
    return this.get(id);
  }

  get(id: string): KnowledgeDoc | null {
    const row = this.db
      .query("SELECT * FROM knowledge_docs WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? this.rowToDoc(row) : null;
  }

  list(opts?: { agentId?: string | null; category?: string; source?: KnowledgeSource }): KnowledgeDoc[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts?.agentId !== undefined) {
      if (opts.agentId === null) {
        clauses.push("agent_id IS NULL");
      } else {
        clauses.push("(agent_id IS NULL OR agent_id = ?)");
        params.push(opts.agentId);
      }
    }
    if (opts?.category) {
      clauses.push("category = ?");
      params.push(opts.category);
    }
    if (opts?.source) {
      clauses.push("source = ?");
      params.push(opts.source);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM knowledge_docs ${where} ORDER BY updated_at DESC`)
      .all(...(params as string[])) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDoc(r));
  }

  delete(id: string): boolean {
    this.vectors = null;
    this.db.run("DELETE FROM knowledge_chunks_fts WHERE doc_id = ?", [id]);
    const res = this.db.run("DELETE FROM knowledge_docs WHERE id = ?", [id]);
    return res.changes > 0;
  }

  async reindexAll(onProgress?: (done: number, total: number) => void): Promise<{ docs: number; chunks: number; embedded: boolean; model: string | null }> {
    const docs = this.list();
    let totalChunks = 0;
    let model: string | null = null;
    for (const [n, doc] of docs.entries()) {
      onProgress?.(n, docs.length);
      const info = await this.indexDoc(doc.id, doc.title, doc.content);
      totalChunks += info.chunks;
      if (info.model) model = info.model;
    }
    // Everything is on `model` now; what the backup held for it has been put back in place.
    if (model) this.db.run("DELETE FROM knowledge_embedding_backup WHERE model = ?", [model]);
    return { docs: docs.length, chunks: totalChunks, embedded: model !== null, model };
  }

  /**
   * Hybrid search: runs FTS5 BM25 + dense vector cosine similarity and combines
   * ranks with Reciprocal Rank Fusion (RRF).
   */
  async search(
    query: string,
    opts?: { limit?: number; agentId?: string | null; category?: string; maxChunksPerDoc?: number; rerank?: boolean },
  ): Promise<KnowledgeSearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = opts?.limit ?? 5;
    // With a reranker, gather a wider pool and let it pick the best `limit` of them.
    const rerank = opts?.rerank !== false && this.rerankFn !== undefined;
    const pool = rerank ? Math.max(limit, RERANK_POOL) : limit;
    const maxPerDoc = opts?.maxChunksPerDoc ?? 2;

    const ftsRank = new Map<number, number>();
    const ftsQuery = buildFtsQuery(trimmed);
    if (ftsQuery) {
      try {
        const ftsRows = this.db
          .query(
            `SELECT chunk_id
             FROM knowledge_chunks_fts
             WHERE knowledge_chunks_fts MATCH ?
             ORDER BY bm25(knowledge_chunks_fts, 0, 0, 2.5, 1.5, 1.0)
             LIMIT ?`,
          )
          .all(ftsQuery, Math.max(limit * 6, 30)) as Array<{ chunk_id: number }>;
        ftsRows.forEach((r, idx) => ftsRank.set(Number(r.chunk_id), idx + 1));
      } catch {
        // Ignore FTS parse issues on unusual inputs.
      }
    }

    const whereParts: string[] = [];
    const params: string[] = [];
    if (opts?.agentId !== undefined && opts.agentId !== null) {
      whereParts.push("(d.agent_id IS NULL OR d.agent_id = ?)");
      params.push(opts.agentId);
    }
    if (opts?.category) {
      whereParts.push("d.category = ?");
      params.push(opts.category);
    }
    // With a filter (an agent's notes, one category), only these chunks may be returned. Ids only: cheap.
    const allowed =
      whereParts.length > 0
        ? new Set(
            (this.db
              .query(`SELECT c.id FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id WHERE ${whereParts.join(" AND ")}`)
              .all(...params) as Array<{ id: number }>).map((r) => Number(r.id)),
          )
        : null;
    if (allowed && allowed.size === 0) return [];

    const vecRank = new Map<number, number>();
    const similarity = new Map<number, number>();
    let background: number | null = null;
    const queryTokens = meaningfulTokens(trimmed);
    const queryEmbed = await this.embedQueryFn(trimmed);
    if (queryEmbed) {
      // One pass over the packed index scores every chunk; nothing is read from the database for this.
      const scored = this.vectorIndex(queryEmbed.vector.length, queryEmbed.model).search(queryEmbed.vector, {
        limit: Infinity,
        allow: allowed ? (id) => allowed.has(id) : undefined,
        minForBackground: MIN_CHUNKS_FOR_BACKGROUND,
      });
      background = scored.background;
      for (const match of scored.matches) similarity.set(match.id, match.similarity);
      scored.matches
        .filter((match) => match.similarity >= MIN_SEMANTIC_SIMILARITY)
        .slice(0, Math.max(limit * 6, 30))
        .forEach((match, idx) => vecRank.set(match.id, idx + 1));
    }

    const candidateIds = new Set<number>([...ftsRank.keys(), ...vecRank.keys()].filter((id) => !allowed || allowed.has(id)));
    if (candidateIds.size === 0) return [];
    // Text and document details are fetched for the candidates only, not for every chunk.
    const chunkRows = this.db
      .query(
        `SELECT c.id, c.doc_id, c.heading, c.content, d.title, d.category, d.tags, d.source
         FROM knowledge_chunks c
         JOIN knowledge_docs d ON d.id = c.doc_id
         WHERE c.id IN (${[...candidateIds].map(() => "?").join(",")})`,
      )
      .all(...candidateIds) as Array<{
        id: number;
        doc_id: string;
        heading: string;
        content: string;
        title: string;
        category: string;
        tags: string;
        source: string;
      }>;
    const byId = new Map(chunkRows.map((r) => [Number(r.id), r]));
    const fused: Array<{
      id: number;
      score: number;
      matchType: "hybrid" | "semantic" | "keyword";
    }> = [];

    for (const id of candidateIds) {
      if (!byId.has(id)) continue;
      const rFts = ftsRank.get(id);
      const rVec = vecRank.get(id);
      const score =
        (rVec !== undefined ? 1 / (RRF_K + rVec) : 0) +
        (rFts !== undefined ? 1 / (RRF_K + rFts) : 0);
      const matchType = rVec !== undefined && rFts !== undefined ? "hybrid" : rVec !== undefined ? "semantic" : "keyword";
      fused.push({ id, score, matchType });
    }

    fused.sort((a, b) => b.score - a.score);

    const perDocCount = new Map<string, number>();
    const hits: KnowledgeSearchHit[] = [];
    for (const item of fused) {
      const row = byId.get(item.id)!;
      const seen = perDocCount.get(row.doc_id) ?? 0;
      if (seen >= maxPerDoc) continue;
      perDocCount.set(row.doc_id, seen + 1);
      const words = new Set(tokenise(`${row.title} ${row.heading} ${row.content}`));
      hits.push({
        chunk_id: item.id,
        similarity: similarity.get(item.id) ?? null,
        background_similarity: background,
        keyword_terms: queryTokens.filter((t) => words.has(t)).length,
        doc_id: row.doc_id,
        title: row.title,
        category: row.category,
        tags: JSON.parse(row.tags || "[]") as string[],
        source: (row.source as KnowledgeSource) || "manual",
        heading: row.heading,
        snippet: row.content,
        score: Number(item.score.toFixed(5)),
        match_type: item.matchType,
      });
      if (hits.length >= pool) break;
    }

    // A search someone asked for is reordered, not filtered: they get `limit` results, best first.
    const scores = rerank && hits.length > 1 ? await this.rerankHits(trimmed, hits) : null;
    if (!scores) return hits.slice(0, limit);
    return hits
      .map((hit, i) => ({ ...hit, rerank_score: scores[i] }))
      .sort((a, b) => b.rerank_score - a.rerank_score)
      .slice(0, limit);
  }

  /** Relevance of each hit to the query from the reranker, or null when there is none to ask. */
  private async rerankHits(query: string, hits: KnowledgeSearchHit[]): Promise<number[] | null> {
    if (!this.rerankFn) return null;
    try {
      const scores = await this.rerankFn(query, hits.map((h) => `${h.title}${h.heading ? ` — ${h.heading}` : ""}\n${h.snippet}`));
      return scores && scores.length === hits.length ? scores : null;
    } catch {
      return null;
    }
  }

  /**
   * Search on the agent's behalf, for notes to show it without being asked.
   * Unlike `search`, this returns nothing rather than a weak match: a chunk
   * must stand out from the rest of the knowledge base on similarity (by less
   * if it also shares a keyword), or contain a good share of the query's words.
   */
  async searchForContext(query: string, opts: ContextSearchOptions = {}): Promise<KnowledgeSearchHit[]> {
    const tokens = meaningfulTokens(query);
    if (tokens.length === 0) return [];
    const limit = opts.limit ?? 3;
    const minSimilarity = opts.minSimilarity ?? DEFAULT_CONTEXT_MIN_SIMILARITY;
    const exclude = new Set(opts.exclude ?? []);
    const wantedTerms = Math.max(Math.min(2, tokens.length), Math.ceil(tokens.length / 3));

    const candidates = (await this.search(query, { limit: limit * 4, agentId: opts.agentId, rerank: false })).filter((h) => !exclude.has(chunkKey(h)));

    // With a reranker, it decides: it reads the question and each note together, which tells
    // related from unrelated far better than the similarity gap below can.
    const scores = candidates.length > 0 ? await this.rerankHits(query, candidates) : null;
    if (scores) {
      return candidates
        .map((hit, i) => ({ ...hit, rerank_score: scores[i] }))
        .filter((h) => h.rerank_score >= RELEVANT_SCORE)
        .sort((a, b) => b.rerank_score - a.rerank_score)
        .slice(0, limit);
    }

    return candidates
      .filter((h) => {
        if (h.keyword_terms >= wantedTerms) return true;
        if (h.similarity === null) return false;
        if (h.background_similarity === null) return h.similarity >= minSimilarity;
        const standout = h.similarity - h.background_similarity;
        return standout >= STANDOUT_MARGIN || (standout >= KEYWORD_BACKED_MARGIN && h.keyword_terms > 0);
      })
      .slice(0, limit);
  }

  /** Format retrieved knowledge hits to show the agent alongside a user message. */
  formatHitsForPrompt(hits: KnowledgeSearchHit[]): string {
    if (hits.length === 0) return "";
    const blocks = hits.map((h) => {
      const heading = h.heading ? ` > ${h.heading}` : "";
      const tags = h.tags.length > 0 ? ` [${h.tags.join(", ")}]` : "";
      return `### ${h.title}${heading} _(${chunkKey(h)}, ${h.category}${tags})_\n${h.snippet}`;
    });
    return (
      `## Knowledge base notes that may be relevant\n` +
      `Saved earlier, so verify live state with tools before relying on them. ` +
      `Use get_knowledge_tool with the id before the # to read a full note, or search_knowledge_tool to look for more.\n\n` +
      blocks.join("\n\n")
    );
  }

  close(): void {
    this.db.close();
  }

  /** Which models the stored vectors came from, and what is set aside from the previous one. */
  embeddingStatus(): { chunks: number; models: Array<{ model: string; chunks: number }>; backup: { model: string; chunks: number } | null } {
    const chunks = (this.db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number }).n;
    const models = this.db
      .query("SELECT embedding_model AS model, COUNT(*) AS chunks FROM knowledge_chunks WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL GROUP BY embedding_model ORDER BY chunks DESC")
      .all() as Array<{ model: string; chunks: number }>;
    const backup = this.db
      .query("SELECT model, COUNT(*) AS chunks FROM knowledge_embedding_backup GROUP BY model ORDER BY chunks DESC LIMIT 1")
      .get() as { model: string; chunks: number } | null;
    return { chunks, models, backup: backup ?? null };
  }

  private async indexDoc(
    docId: string,
    title: string,
    content: string,
  ): Promise<{ chunks: number; model: string | null }> {
    const chunks = chunkMarkdown(content);
    const textOf = (heading: string, body: string) => `${title}${heading ? ` — ${heading}` : ""}\n${body}`;
    const textsToEmbed = chunks.map((c) => textOf(c.heading, c.content));
    const hashes = textsToEmbed.map(textHash);
    const target = this.targetModel();

    // What this document has now: reused when the text and model are unchanged, set aside when the model is changing.
    const old = (this.db
      .query("SELECT heading, content, embedding, embedding_model FROM knowledge_chunks WHERE doc_id = ? AND embedding IS NOT NULL AND embedding_model IS NOT NULL")
      .all(docId) as Array<{ heading: string; content: string; embedding: Uint8Array; embedding_model: string }>
    ).map((row) => ({ model: row.embedding_model, hash: textHash(textOf(row.heading, row.content)), embedding: row.embedding }));

    // Vectors already made by the wanted model for exactly this text, here or in the backup, need no model call.
    let blobs: Array<Uint8Array | null> = textsToEmbed.map(() => null);
    if (target) {
      const kept = new Map(old.filter((o) => o.model === target).map((o) => [o.hash, o.embedding]));
      const fromBackup = this.db.query("SELECT embedding FROM knowledge_embedding_backup WHERE model = ? AND text_hash = ?");
      blobs = hashes.map((hash) => kept.get(hash) ?? (fromBackup.get(target, hash) as { embedding: Uint8Array } | null)?.embedding ?? null);
    }
    const reused = blobs.filter(Boolean).length;
    let model: string | null = reused > 0 ? target : null;
    const missing = blobs.flatMap((blob, i) => (blob ? [] : [i]));
    if (missing.length > 0) {
      let embedded = await this.embedBatchFn(missing.map((i) => textsToEmbed[i]));
      let into = missing;
      // Another model answered than the one the reused vectors came from (a hosted fallback): one document, one model.
      if (embedded && reused > 0 && embedded[0]?.model !== target) {
        embedded = await this.embedBatchFn(textsToEmbed);
        into = textsToEmbed.map((_, i) => i);
      }
      if (embedded && embedded.length === into.length) {
        model = embedded[0]?.model ?? model;
        into.forEach((i, n) => { blobs[i] = float32ToBlob(embedded![n].vector); });
      }
    }

    // Vectors from a model that is being replaced are kept, one previous model at a time, so switching back needs no re-embedding.
    const outgoing = old.filter((o) => o.model !== model);
    if (outgoing.length > 0) {
      this.db.run("DELETE FROM knowledge_embedding_backup WHERE model NOT IN (?, ?)", [outgoing[0].model, model ?? ""]);
      const keep = this.db.prepare("INSERT OR REPLACE INTO knowledge_embedding_backup (model, text_hash, embedding) VALUES (?, ?, ?)");
      for (const o of outgoing) keep.run(o.model, o.hash, o.embedding);
    }

    // The chunks below replace this document's old ones, so the packed index is rebuilt on the next search.
    this.vectors = null;

    this.db.run("DELETE FROM knowledge_chunks_fts WHERE doc_id = ?", [docId]);
    this.db.run("DELETE FROM knowledge_chunks WHERE doc_id = ?", [docId]);

    const insertChunk = this.db.prepare(
      `INSERT INTO knowledge_chunks (doc_id, chunk_index, heading, content, embedding, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO knowledge_chunks_fts (chunk_id, doc_id, title, heading, content)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const res = insertChunk.run(docId, i, c.heading, c.content, blobs[i], blobs[i] ? model : null);
      const chunkId = Number(res.lastInsertRowid);
      insertFts.run(chunkId, docId, title, c.heading, c.content);
    }

    this.db.run(
      "UPDATE knowledge_docs SET chunk_count = ?, embedding_model = ? WHERE id = ?",
      [chunks.length, model, docId],
    );

    return { chunks: chunks.length, model };
  }

  private rowToDoc(row: Record<string, unknown>): KnowledgeDoc {
    return {
      id: row.id as string,
      title: row.title as string,
      content: row.content as string,
      source: ((row.source as string) === "agent" ? "agent" : "manual") as KnowledgeSource,
      category: (row.category as string) ?? "general",
      tags: JSON.parse((row.tags as string) || "[]") as string[],
      agent_id: (row.agent_id as string | null) ?? null,
      embedding_model: (row.embedding_model as string | null) ?? null,
      chunk_count: Number(row.chunk_count ?? 0),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
