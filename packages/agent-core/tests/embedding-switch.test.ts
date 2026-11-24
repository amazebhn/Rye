import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/chat/store.js";
import { queryPrefix, type EmbeddingResult } from "../src/embeddings/index.js";
import { probeEmbeddingModel, sameModel } from "../src/embeddings/models.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

/** A stand-in embedder whose model can be switched, counting every text it is asked to embed. */
function switchableEmbedder(dims: Record<string, number>) {
  const state = { model: Object.keys(dims)[0], embedded: [] as string[], down: false };
  const vector = (text: string, size: number) => Array.from({ length: size }, (_, i) => ((text.charCodeAt(i % text.length) + i) % 17) / 17 + 0.01);
  const embedBatch = async (texts: string[]): Promise<EmbeddingResult[] | null> => {
    if (state.down) return null;
    state.embedded.push(...texts);
    return texts.map((t) => ({ vector: vector(t, dims[state.model]), provider: "ollama" as const, model: state.model }));
  };
  return { state, embedBatch, embedText: async (t: string) => (await embedBatch([t]))?.[0] ?? null, model: () => state.model };
}

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "rye-embed-switch-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("changing the knowledge base's embedding model", () => {
  test("the old vectors are kept as a backup and come back without embedding again", () =>
    inTemp(async (dir) => {
      const e = switchableEmbedder({ small: 4, big: 8 });
      const store = new KnowledgeStore(join(dir, "knowledge.db"), e);
      try {
        await store.create({ title: "Replicas", content: "# Lag\nCheck long transactions.\n\n# Names\nNamed after rivers." });
        await store.create({ title: "Payments", content: "# Webhooks\nStripe retries three times." });
        expect(store.embeddingStatus()).toMatchObject({ chunks: 3, models: [{ model: "small", chunks: 3 }], backup: null });

        // Switch: everything is embedded with the new model, the old vectors are set aside.
        e.state.model = "big";
        e.state.embedded = [];
        await store.reindexAll();
        expect(e.state.embedded).toHaveLength(3);
        expect(store.embeddingStatus()).toMatchObject({ models: [{ model: "big", chunks: 3 }], backup: { model: "small", chunks: 3 } });
        expect((await store.search("stripe webhooks"))[0].title).toBe("Payments");

        // A note written while on the new model has no backup under the old one.
        await store.create({ title: "Wifi", content: "# Guest\nRotates monthly." });

        // Switch back: the three old vectors are restored, only the new note is embedded.
        e.state.model = "small";
        e.state.embedded = [];
        await store.reindexAll();
        expect(e.state.embedded).toHaveLength(1);
        expect(e.state.embedded[0]).toContain("Wifi");
        expect(store.embeddingStatus()).toMatchObject({ models: [{ model: "small", chunks: 4 }], backup: { model: "big", chunks: 4 } });
      } finally {
        store.close();
      }
    }));

  test("reindexing with the same model embeds nothing that hasn't changed", () =>
    inTemp(async (dir) => {
      const e = switchableEmbedder({ small: 4 });
      const store = new KnowledgeStore(join(dir, "knowledge.db"), e);
      try {
        const doc = await store.create({ title: "Replicas", content: "# Lag\nCheck long transactions.\n\n# Names\nNamed after rivers." });
        e.state.embedded = [];
        await store.reindexAll();
        expect(e.state.embedded).toHaveLength(0);
        await store.update(doc.id, { content: "# Lag\nCheck long transactions.\n\n# Names\nNamed after mountains." });
        expect(e.state.embedded).toHaveLength(1);
        expect(store.embeddingStatus().backup).toBeNull();
      } finally {
        store.close();
      }
    }));

  test("an embedder that is down during a reindex doesn't lose the vectors", () =>
    inTemp(async (dir) => {
      const e = switchableEmbedder({ small: 4, big: 8 });
      const store = new KnowledgeStore(join(dir, "knowledge.db"), e);
      try {
        await store.create({ title: "Replicas", content: "# Lag\nCheck long transactions." });
        e.state.model = "big";
        e.state.down = true;
        const result = await store.reindexAll();
        expect(result.embedded).toBe(false);
        expect(store.embeddingStatus()).toMatchObject({ models: [], backup: { model: "small", chunks: 1 } });
        // Back on the old model, they are restored from the backup.
        e.state.model = "small";
        e.state.embedded = [];
        await store.reindexAll();
        expect(e.state.embedded).toHaveLength(0);
        expect(store.embeddingStatus().models).toEqual([{ model: "small", chunks: 1 }]);
      } finally {
        store.close();
      }
    }));

  test("vectors from another model are never compared with the query", () =>
    inTemp(async (dir) => {
      // Same size, different model: without the model check these would be scored as if comparable.
      const e = switchableEmbedder({ small: 4, other: 4 });
      const store = new KnowledgeStore(join(dir, "knowledge.db"), e);
      try {
        await store.create({ title: "Replicas", content: "# Lag\nCheck long transactions." });
        e.state.model = "other";
        const hits = await store.search("zzz qqq");
        expect(hits).toEqual([]);
      } finally {
        store.close();
      }
    }));
});

describe("changing the chat store's embedding model", () => {
  const chat = (id: string, texts: string[]) => ({
    id, title: id, sessionId: `s-${id}`, updatedAt: Date.now(),
    messages: texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content })),
  });

  test("message vectors are set aside, restored on switching back, and stay true to the messages", () =>
    inTemp(async (dir) => {
      const e = switchableEmbedder({ small: 4, big: 8 });
      const store = new ChatStore(join(dir, "chats.db"), null, e);
      try {
        store.upsert(chat("a", ["why is the replica lagging so badly today", "a long transaction on the primary is holding it"]) as never);
        await store.embedPending();
        expect(store.embeddingStatus()).toMatchObject({ model: "small", messages: 2, embedded: 2, backup: null });

        expect(store.useEmbeddingModel("big")).toBe(true);
        expect(store.embeddingStatus()).toMatchObject({ model: "big", embedded: 0, backup: { model: "small", messages: 2 } });
        e.state.model = "big";
        await store.embedPending();
        expect(store.embeddingStatus()).toMatchObject({ embedded: 2, backup: { model: "small", messages: 2 } });

        // A message removed while on the new model must not come back from the backup.
        store.remove("a");
        store.upsert(chat("b", ["how do I rotate the stripe webhook secret safely"]) as never);
        await store.embedPending();

        e.state.model = "small";
        e.state.embedded = [];
        expect(store.useEmbeddingModel("small")).toBe(true);
        expect(store.embeddingStatus()).toMatchObject({ model: "small", messages: 1, embedded: 0, backup: { model: "big", messages: 1 } });
        await store.embedPending();
        expect(e.state.embedded).toHaveLength(1);
        expect(store.useEmbeddingModel("small")).toBe(false);
      } finally {
        store.close();
      }
    }));

  test("switching with nothing embedded keeps an existing backup", () =>
    inTemp(async (dir) => {
      const e = switchableEmbedder({ small: 4, big: 8, third: 6 });
      const store = new ChatStore(join(dir, "chats.db"), null, e);
      try {
        store.upsert(chat("a", ["why is the replica lagging so badly today"]) as never);
        await store.embedPending();
        store.useEmbeddingModel("big");
        // Nothing embedded with "big" yet; moving on must not replace the "small" backup with nothing.
        store.useEmbeddingModel("third");
        expect(store.embeddingStatus().backup).toEqual({ model: "small", messages: 1 });
      } finally {
        store.close();
      }
    }));
});

describe("embedding model helpers", () => {
  test("instruction-style models get a query prefix; others don't", () => {
    expect(queryPrefix("huggingface.co/VelociQ8/F2LLM-v2-4B-Q8A64-GGUF:latest")).toStartWith("Instruct: ");
    expect(queryPrefix("dengcao/Qwen3-Embedding-0.6B")).toEndWith("Query: ");
    expect(queryPrefix("nomic-embed-text")).toBe("");
  });

  test(":latest is the same model", () => {
    expect(sameModel("nomic-embed-text", "nomic-embed-text:latest")).toBe(true);
    expect(sameModel("nomic-embed-text", "nomic-embed-text:v1.5")).toBe(false);
  });

  test("a model that fails to load is reported with Ollama's reason", async () => {
    const settings = { ollama: { base_url: "http://ollama.test" } } as never;
    const failing = (async () => Response.json({ error: "error loading model: unknown model architecture: 'a64b9e07'\nmore" }, { status: 500 })) as unknown as typeof fetch;
    expect(await probeEmbeddingModel(settings, "broken", failing)).toEqual({ ok: false, error: "error loading model: unknown model architecture: 'a64b9e07'" });
    const working = (async () => Response.json({ embeddings: [[0.1, 0.2, 0.3]] })) as unknown as typeof fetch;
    expect(await probeEmbeddingModel(settings, "fine", working)).toEqual({ ok: true, dimensions: 3 });
  });
});
