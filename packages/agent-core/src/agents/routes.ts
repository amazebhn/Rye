/**
 * HTTP routes for custom Agents.
 * Mounted at /agents in server.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AgentStore } from "./store.js";
import {
  AGENT_CHATTINESS_LEVELS,
  readAgentSettings,
  writeAgentSettings,
} from "./settings.js";

const UpdateSettingsSchema = z.object({
  autoRoute: z.boolean().optional(),
  allowAgentReplies: z.boolean().optional(),
  chattiness: z.enum(AGENT_CHATTINESS_LEVELS).optional(),
});

const AvatarSchema = z.object({
  kind: z.enum(["gradient", "image"]),
  // Allow preset ids, CSS gradients, URLs, or base64 data URIs (capped at ~512KB)
  value: z.string().min(1).max(600_000),
});

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(64).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1).max(50_000),
  avatar: AvatarSchema.optional(),
  model: z.string().max(200).nullable().optional(),
  env: z.string().max(128).nullable().optional(),
  tool_groups: z.array(z.string().max(100)).max(50).optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1).max(50_000).optional(),
  avatar: AvatarSchema.optional(),
  model: z.string().max(200).nullable().optional(),
  env: z.string().max(128).nullable().optional(),
  tool_groups: z.array(z.string().max(100)).max(50).optional(),
  chat_id: z.string().max(128).nullable().optional(),
});

export function agentRoutes(store: AgentStore): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    return c.json(store.list());
  });

  r.get("/settings", (c) => {
    return c.json(readAgentSettings());
  });

  r.put("/settings", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = UpdateSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid settings payload", details: parsed.error.flatten() }, 400);
    }
    return c.json(writeAgentSettings(parsed.data));
  });

  r.get("/:id", (c) => {
    const agent = store.get(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
  });

  r.post("/", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = CreateAgentSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid agent payload", details: parsed.error.flatten() }, 400);
    }
    const agent = store.create(parsed.data);
    return c.json(agent, 201);
  });

  r.put("/:id", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = UpdateAgentSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid agent payload", details: parsed.error.flatten() }, 400);
    }
    const updated = store.update(c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "Agent not found" }, 404);
    return c.json(updated);
  });

  r.delete("/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "Agent not found" }, 404);
    return c.json({ status: "deleted", id: c.req.param("id") });
  });

  return r;
}
