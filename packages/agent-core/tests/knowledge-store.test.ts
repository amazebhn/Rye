import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, chunkMarkdown } from "../src/knowledge/store.js";
import { MemoryStore } from "../src/memory/store.js";
import type { EmbeddingResult } from "../src/embeddings/index.js";

function withTempDir(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "rye-knowledge-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Deterministic toy embedder mapping keywords into a 4D vector space. */
function toyVector(text: string): number[] {
  const t = text.toLowerCase();
  const v = [
    t.includes("payment") || t.includes("stripe") || t.includes("billing") ? 1 : 0,
    t.includes("mysql") || t.includes("database") || t.includes("replica") ? 1 : 0,
    t.includes("redis") || t.includes("cache") || t.includes("session") ? 1 : 0,
    t.includes("kafka") || t.includes("queue") || t.includes("event") ? 1 : 0,
  ];
  // Avoid zero vector
  return v.every((x) => x === 0) ? [0.1, 0.1, 0.1, 0.1] : v;
}

const mockEmbedders = {
  embedBatch: async (texts: string[]): Promise<EmbeddingResult[]> =>
    texts.map((t) => ({ vector: toyVector(t), provider: "ollama", model: "toy-embed" })),
  embedText: async (text: string): Promise<EmbeddingResult> => ({
    vector: toyVector(text),
    provider: "ollama",
    model: "toy-embed",
  }),
};

const nullEmbedders = {
  embedBatch: async () => null,
  embedText: async () => null,
};

describe("chunkMarkdown", () => {
  test("splits sections by markdown heading and preserves headings", () => {
    const md = [
      "# Payments",
      "Handles card charges via Stripe.",
      "",
      "## Retries",
      "Exponential backoff up to 5 attempts.",
    ].join("\n");

    const chunks = chunkMarkdown(md, 500, 50);
    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe("Payments");
    expect(chunks[0].content).toContain("Stripe");
    expect(chunks[1].heading).toBe("Retries");
    expect(chunks[1].content).toContain("Exponential backoff");
  });

  test("splits oversized sections with overlap", () => {
    const longPara = "word ".repeat(120).trim();
    const chunks = chunkMarkdown(`## Big\n${longPara}`, 200, 40);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.heading === "Big")).toBe(true);
    expect(chunks.every((c) => c.content.length <= 200)).toBe(true);
  });
});

describe("KnowledgeStore", () => {
  test(
    "hybrid search ranks semantic + keyword matches and falls back cleanly without embeddings",
    withTempDir(async (dir) => {
      const store = new KnowledgeStore(join(dir, "knowledge.db"), mockEmbedders);
      try {
        const pay = await store.create({
          title: "Payments Architecture",
          category: "services",
          tags: ["billing"],
          content: "# Overview\nProcesses billing and Stripe webhooks.\n\n## Failover\nQueues failed charges.",
        });
        const db = await store.create({
          title: "MySQL Topology",
          category: "database",
          tags: ["mysql"],
          content: "# Replicas\nRead traffic routes to mysql-ro-01 replica.",
        });

        expect(pay.chunk_count).toBe(2);
        expect(pay.embedding_model).toBe("toy-embed");
        expect(db.chunk_count).toBe(1);

        // Semantic-only query ("payment" isn't in body except title, "stripe" is)
        const hits = await store.search("stripe billing issue");
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].doc_id).toBe(pay.id);
        expect(hits[0].match_type).toBe("hybrid");

        // Update doc and verify search reflects new content
        await store.update(db.id, { content: "# Cache\nRedis session store runs on port 6379." });
        const redisHits = await store.search("redis session");
        expect(redisHits[0]?.doc_id).toBe(db.id);

        // Format for prompt
        const promptBlock = store.formatHitsForPrompt(redisHits);
        expect(promptBlock).toContain("Relevant System Knowledge (RAG)");
        expect(promptBlock).toContain(db.id);

        // Delete doc
        expect(store.delete(pay.id)).toBe(true);
        expect(store.get(pay.id)).toBeNull();
      } finally {
        store.close();
      }
    }),
  );

  test(
    "degrades cleanly to FTS5 keyword search when no embedding provider is reachable",
    withTempDir(async (dir) => {
      const store = new KnowledgeStore(join(dir, "knowledge-kw.db"), nullEmbedders);
      try {
        const doc = await store.create({
          title: "Order Service",
          content: "The OMS_RETRY_WORKER consumes dead-letter messages every 5 minutes.",
        });
        expect(doc.embedding_model).toBeNull();
        expect(doc.chunk_count).toBe(1);

        const hits = await store.search("OMS_RETRY_WORKER");
        expect(hits.length).toBe(1);
        expect(hits[0].doc_id).toBe(doc.id);
        expect(hits[0].match_type).toBe("keyword");
      } finally {
        store.close();
      }
    }),
  );
});

describe("MemoryStore (Facts & Glossary)", () => {
  test(
    "stores fact/acronym/term kinds and formats Glossary separately from Facts",
    withTempDir((dir) => {
      const store = new MemoryStore(join(dir, "memory.db"));
      store.save("OMS", "Order Management Service", ["core"], "glossary", { kind: "acronym" });
      store.save("cold_path", "Async S3 archival pipeline", [], "glossary", { kind: "term" });
      store.save("prod_region", "us-east-1", ["aws"], "infra", { kind: "fact" });

      const all = store.all();
      expect(all.length).toBe(3);
      expect(all.find((m) => m.key === "oms")?.kind).toBe("acronym");
      expect(all.find((m) => m.key === "cold_path")?.kind).toBe("term");
      expect(all.find((m) => m.key === "prod_region")?.kind).toBe("fact");

      const prompt = store.formatForPrompt();
      expect(prompt).toContain("## Glossary & Acronyms");
      expect(prompt).toContain("| `oms` | acronym | Order Management Service |");
      expect(prompt).toContain("| `cold_path` | term | Async S3 archival pipeline |");
      expect(prompt).toContain("## Saved Facts");
      expect(prompt).toContain("**prod_region**");
    }),
  );
});
