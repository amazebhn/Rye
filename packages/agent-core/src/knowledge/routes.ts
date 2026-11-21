/**
 * HTTP routes for the Knowledge Base (RAG).
 * Mounted at /knowledge in server.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { KnowledgeStore } from "./store.js";
import { getLastEmbeddingStatus, probeEmbeddingStatus } from "../embeddings/index.js";

const CreateKnowledgeSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(200_000),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(64)).max(30).optional(),
  source: z.enum(["manual", "agent"]).optional(),
  agent_id: z.string().max(128).nullable().optional(),
});

const UpdateKnowledgeSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.string().min(1).max(200_000).optional(),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(64)).max(30).optional(),
  agent_id: z.string().max(128).nullable().optional(),
});

export function knowledgeRoutes(store: KnowledgeStore): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const category = c.req.query("category") || undefined;
    const source = c.req.query("source");
    const docs = store.list({
      category,
      source: source === "manual" || source === "agent" ? source : undefined,
    });
    return c.json({ docs, embedding: getLastEmbeddingStatus() });
  });

  r.get("/status", async (c) => {
    const probe = c.req.query("probe") === "1" || c.req.query("probe") === "true";
    const status = probe ? await probeEmbeddingStatus() : getLastEmbeddingStatus();
    return c.json(status);
  });

  r.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const limit = Math.min(20, Math.max(1, Number(c.req.query("limit") ?? 5) || 5));
    const category = c.req.query("category") || undefined;
    const agentId = c.req.query("agent_id") || undefined;
    if (!q) return c.json({ hits: [] });
    const hits = await store.search(q, { limit, category, agentId });
    return c.json({ hits, embedding: getLastEmbeddingStatus() });
  });

  r.post("/reindex", async (c) => {
    const result = await store.reindexAll();
    return c.json({ ...result, embedding: getLastEmbeddingStatus() });
  });

  r.get("/:id", (c) => {
    const doc = store.get(c.req.param("id"));
    if (!doc) return c.json({ error: "Knowledge document not found" }, 404);
    return c.json(doc);
  });

  r.post("/", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = CreateKnowledgeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }
    const doc = await store.create({
      title: parsed.data.title,
      content: parsed.data.content,
      category: parsed.data.category,
      tags: parsed.data.tags,
      source: parsed.data.source ?? "manual",
      agentId: parsed.data.agent_id ?? null,
    });
    return c.json(doc, 201);
  });

  r.put("/:id", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = UpdateKnowledgeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }
    const updated = await store.update(c.req.param("id"), {
      title: parsed.data.title,
      content: parsed.data.content,
      category: parsed.data.category,
      tags: parsed.data.tags,
      agentId: parsed.data.agent_id,
    });
    if (!updated) return c.json({ error: "Knowledge document not found" }, 404);
    return c.json(updated);
  });

  r.delete("/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "Knowledge document not found" }, 404);
    return c.json({ status: "deleted", id: c.req.param("id") });
  });

  return r;
}
