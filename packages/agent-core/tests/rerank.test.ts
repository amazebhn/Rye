import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ollamaRerankProblem, rerankRequest, rerankWithDecision, rerankWithOllama, rerankWithServer, yesProbability } from "../src/embeddings/rerank.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const lp = (token: string, p: number) => ({ token, logprob: Math.log(p) });

/** A stand-in for Ollama: answers "yes" with the probability `judge` gives for the prompt. */
function fakeOllama(judge: (prompt: string) => number | "garbage" | "down") {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const verdict = judge(String(body.prompt));
    if (verdict === "down") return new Response("no such model", { status: 404 });
    if (verdict === "garbage") return Response.json({ logprobs: [{ ...lp("The", 0.9), top_logprobs: [lp("The", 0.9), lp("A", 0.1)] }] });
    return Response.json({ logprobs: [{ ...lp("yes", verdict), top_logprobs: [lp("yes", verdict), lp("no", 1 - verdict)] }] });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

describe("yesProbability", () => {
  test("is the share of yes among the yes/no readings, whatever their case or spacing", () => {
    const first = { ...lp("Yes", 0.6), top_logprobs: [lp("Yes", 0.6), lp(" no", 0.2), lp("yes", 0.1), lp("Maybe", 0.1)] };
    expect(yesProbability(first)).toBeCloseTo(0.7 / 0.9, 5);
  });

  test("falls back to the chosen token when no alternatives are returned", () => {
    expect(yesProbability(lp("no", 0.8))).toBe(0);
    expect(yesProbability(lp("yes", 0.8))).toBe(1);
  });

  test("is unknown when the model said neither", () => {
    expect(yesProbability({ ...lp("The", 0.9), top_logprobs: [lp("The", 0.9)] })).toBeNull();
    expect(yesProbability(undefined)).toBeNull();
  });
});

describe("rerankRequest", () => {
  test("a Qwen3 reranker gets its own raw prompt; other models get a plain yes/no question", () => {
    const qwen = rerankRequest("dengcao/Qwen3-Reranker-0.6B:Q8_0", "why is it slow", "The replica lags.");
    expect(qwen.raw).toBe(true);
    expect(String(qwen.prompt)).toContain("<Query>: why is it slow");
    expect(String(qwen.prompt).endsWith("<think>\n\n</think>\n\n")).toBe(true);

    const chat = rerankRequest("llama3.2", "why is it slow", "The replica lags.");
    expect(chat.raw).toBeUndefined();
    expect(String(chat.system)).toContain("yes or no");
    expect((chat.options as { num_predict: number }).num_predict).toBe(1);
  });

  test("long passages are cut", () => {
    const body = rerankRequest("llama3.2", "q", "x".repeat(5000));
    expect(String(body.prompt).length).toBeLessThan(1800);
  });
});

describe("rerankWithOllama", () => {
  const using = (fetchFn: typeof fetch) => ({ fetch: fetchFn, model: "llama3.2", baseUrl: "http://ollama.test" });

  test("scores each passage in the order given", async () => {
    const { fetchFn, bodies } = fakeOllama((prompt) => (prompt.includes("replica") ? 0.9 : 0.1));
    const scores = await rerankWithOllama("why is it slow", ["Stripe webhooks", "The replica lags", "Lunch menu"], using(fetchFn));
    expect(scores!.map((s) => Number(s.toFixed(2)))).toEqual([0.1, 0.9, 0.1]);
    expect(bodies).toHaveLength(3);
  });

  test("is off when no model is named", async () => {
    const { fetchFn, bodies } = fakeOllama(() => 0.9);
    expect(await rerankWithOllama("q", ["a"], { fetch: fetchFn, model: "", baseUrl: "http://ollama.test" })).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  test("gives up cleanly when Ollama can't serve the model, or the model won't answer yes/no", async () => {
    expect(await rerankWithOllama("q", ["a", "b"], using(fakeOllama(() => "down").fetchFn))).toBeNull();
    expect(await rerankWithOllama("q", ["a", "b"], using(fakeOllama(() => "garbage").fetchFn))).toBeNull();
  });
});

describe("rerankWithDecision", () => {
  const settings = { decision: { provider: "ollama" } } as never;

  test("asks one yes/no question per note in a single request and returns the probabilities in order", async () => {
    const calls: Array<{ state: unknown; questions: Record<string, { type: string; instructions: string }> }> = [];
    const decideFn = (async (state: unknown, questions: Record<string, { type: string; instructions: string }>) => {
      calls.push({ state, questions });
      return { note_1: { type: "noul", noul: 0.1 }, note_2: { type: "noul", noul: 0.9 } };
    }) as never;
    const scores = await rerankWithDecision("why is it slow", ["Lunch menu", "The replica lags"], { decide: decideFn, settings });
    expect(scores).toEqual([0.1, 0.9]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual(["note_1", "note_2"]);
    expect((calls[0].state as { notes: Record<string, string> }).notes.note_2).toBe("The replica lags");
  });

  test("is unavailable when the decision model is off or fails", async () => {
    const never = (async () => { throw new Error("should not be called"); }) as never;
    expect(await rerankWithDecision("q", ["a"], { decide: never, settings: { decision: { provider: "off" } } as never })).toBeNull();
    const failing = (async () => { throw new Error("timed out"); }) as never;
    expect(await rerankWithDecision("q", ["a"], { decide: failing, settings })).toBeNull();
  });
});

describe("rerankWithServer", () => {
  const server = (results: unknown, status = 200) => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ results }, { status });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  };

  test("posts to /v1/rerank and puts scores back in passage order", async () => {
    const { fetchFn, seen } = server([{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }]);
    const scores = await rerankWithServer("q", ["a", "b"], { fetch: fetchFn, baseUrl: "http://rerank.test/", model: "zerank-2" });
    expect(scores).toEqual([0.2, 0.9]);
    expect(seen[0].url).toBe("http://rerank.test/v1/rerank");
    expect(seen[0].body).toMatchObject({ model: "zerank-2", query: "q", documents: ["a", "b"] });
  });

  test("raw logits are squashed so 0.5 still means leaning relevant", async () => {
    const { fetchFn } = server([{ index: 0, relevance_score: 5.4 }, { index: 1, relevance_score: -4.5 }]);
    const scores = (await rerankWithServer("q", ["a", "b"], { fetch: fetchFn, baseUrl: "http://rerank.test/v1/rerank" }))!;
    expect(scores[0]).toBeGreaterThan(0.9);
    expect(scores[1]).toBeLessThan(0.1);
  });

  test("gives up cleanly on an error or an empty answer", async () => {
    expect(await rerankWithServer("q", ["a"], { fetch: server([], 500).fetchFn, baseUrl: "http://rerank.test" })).toBeNull();
    expect(await rerankWithServer("q", ["a"], { fetch: server([]).fetchFn, baseUrl: "http://rerank.test" })).toBeNull();
  });
});

test("models Ollama can't score are named with what to do instead", () => {
  expect(ollamaRerankProblem("huggingface.co/mradermacher/zerank-2-GGUF:latest")).toContain("Rerank server");
  expect(ollamaRerankProblem("qllama/bge-reranker-v2-m3")).toContain("cross-encoder");
  expect(ollamaRerankProblem("llama3.2")).toBeNull();
});

describe("KnowledgeStore with a reranker", () => {
  const nullEmbedders = { embedBatch: async () => null, embedText: async () => null };

  async function withStore(rerank: (query: string, passages: string[]) => Promise<number[] | null>, fn: (store: KnowledgeStore) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "rye-rerank-"));
    const store = new KnowledgeStore(join(dir, "knowledge.db"), { ...nullEmbedders, rerank });
    try {
      await store.create({ title: "Replica runbook", content: "# Lag\nWhat to do when the orders replica falls behind." });
      await store.create({ title: "Replica naming", content: "# Names\nEvery replica is named after a river." });
      await fn(store);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const byTitle = (wanted: string) => async (_q: string, passages: string[]) => passages.map((p) => (p.startsWith(wanted) ? 0.95 : 0.05));

  test("search is reordered by the reranker and reports its score", async () => {
    await withStore(byTitle("Replica naming"), async (store) => {
      const hits = await store.search("replica");
      expect(hits.map((h) => h.title)).toEqual(["Replica naming", "Replica runbook"]);
      expect(hits[0].rerank_score).toBe(0.95);
    });
  });

  test("only notes the reranker finds relevant are attached to a message", async () => {
    await withStore(byTitle("Replica runbook"), async (store) => {
      // Both notes share the query's keywords, so without a reranker both would be attached.
      const hits = await store.searchForContext("replica names and replica lag");
      expect(hits.map((h) => h.title)).toEqual(["Replica runbook"]);
    });
    await withStore(async (_q, passages) => passages.map(() => 0.1), async (store) => {
      expect(await store.searchForContext("replica names and replica lag")).toEqual([]);
    });
  });

  test("a reranker that fails leaves search working as before", async () => {
    await withStore(async () => null, async (store) => {
      expect((await store.search("replica")).length).toBe(2);
      expect((await store.searchForContext("replica names and replica lag")).length).toBeGreaterThan(0);
    });
    await withStore(async () => { throw new Error("boom"); }, async (store) => {
      expect((await store.search("replica")).length).toBe(2);
    });
  });
});
