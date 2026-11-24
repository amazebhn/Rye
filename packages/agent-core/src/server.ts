/**
 * Hono HTTP server — replaces FastAPI.
 *
 * Routes:
 *   POST /chat/            — SSE agent stream
 *   DELETE /chat/session/:id — clear session
 *   POST /chat/sop         — extract + save SOP from description
 *   GET  /sop/             — list SOPs
 *   GET  /sop/search       — semantic search
 *   GET  /sop/:id          — get SOP
 *   POST /sop/             — create SOP
 *   DELETE /sop/:id        — delete SOP
 *   GET  /health           — health check
 *   ALL  /copilot/*        — transparent proxy → api.githubcopilot.com (adds auth headers)
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { stream as honoStream } from "hono/streaming";
import { z } from "zod";
import { runWithContext, type RunContext } from "./run-context.js";
import { SOPStore } from "./sop/store.js";
import { SkillStore } from "./skill/store.js";
import { skillErrorResponse, skillRoutes, skillToJson } from "./skill/routes.js";
import { migrateLegacySkills } from "./skill/migrate.js";
import { MemoryStore, type MemoryKind } from "./memory/store.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { AgentStore, type AgentDefinition } from "./agents/store.js";
import { agentRoutes } from "./agents/routes.js";
import { speechRoutes } from "./speech/routes.js";
import { LEGACY_MYSQL_NAME, engineName, listConnections } from "./db/connections.js";
import { driverFor, errorText } from "./db/drivers.js";
import { readAgentSettings, chattinessPolicy } from "./agents/settings.js";
import { pickAutoRoutedAgent, pickFollowUpAgent, type RecentTurn } from "./agents/router.js";
import { ChatStore } from "./chat/store.js";
import { ChatFolderStore } from "./chat/folders.js";
import { chatFolderRoutes } from "./chat/folder-routes.js";
import { UsageStore } from "./usage/store.js";
import type { LlmUsageEvent, ToolUsageEvent } from "./usage/store.js";
import { readPricing, upsertPricing, removePricing, estimateCost } from "./usage/pricing.js";
import type { PriceInput } from "./usage/pricing.js";
import { deleteResultsForSession, getResult, listResults } from "./results/store.js";
import { deleteArtifactsForSession, getArtifact, listArtifacts, readArtifactSource, type ArtifactFormat } from "./artifacts/store.js";
import { markdownToDocx } from "./artifacts/docx.js";
import { getLinkPreview, LinkPreviewError } from "./link-preview/preview.js";
import { markSessionDeleted } from "./session/lifecycle.js";
import {
  cancelMcpOAuth,
  completeMcpOAuth,
  getMcpOAuthAuthorization,
  getServerStatuses,
  getServerTools,
  initMcp,
  reloadMcp,
} from "./mcp/client.js";
import {
  MCP_CONFIG_FILE,
  listMcpServerEntries,
  removeMcpServer,
  setMcpServerDisabled,
  writeMcpServer,
  type McpServerDefinition,
  type McpServerEntry,
} from "./mcp/config.js";
import { extractSopFromChat } from "./sop/extractor.js";
import { extractSkillFromChat } from "./skill/extractor.js";
import { runAgent, clearSession, generateChatTitle, generateEditSuggestions, rewindSession } from "./agent/loop.js";
import type { RewindTurn } from "./agent/loop.js";
import { turnMessage } from "./agent/continue.js";
import { editSuggestionKey, getCachedEditSuggestions, setCachedEditSuggestions } from "./edit-suggestions/cache.js";
import { resolveTaskModelId, resolveTierModelId } from "./model-tiers.js";
import { getPendingDraft, clearPendingDraft, setAgentStore, setChatStore } from "./tools/index.js";
import { getSettings, settings, CONFIG_FILE, getEffectiveSettings, getActiveEnv, setActiveEnv, setRuntimeModel, MODEL_TIERS, MODEL_SETTINGS_FILE, ModelOverridesSchema, readModelOverrides, writeModelOverrides } from "./config.js";
import type { LlmProvider, ModelOverrides } from "./config.js";
import { CLEF_MODELS, clefTarget, ollamaDecisionModelsOrEmpty, resolveDecisionModelId, warmOllamaDecisionModel } from "./decision/index.js";
import { listOllamaModels, probeEmbeddingModel, sameModel } from "./embeddings/models.js";
import { ollamaRerankProblem } from "./embeddings/rerank.js";
import { getCopilotBearerToken } from "./copilot-auth.js";
import { copilotFetch, fetchCopilotModels, readModelsCache, supportsChatCompletions } from "./copilot-models.js";
import { fetchOllamaModels } from "./llm-provider.js";
import { CLAUDE_MODEL_ALIASES, claudeHarnessInfo } from "./harness/claude-sdk.js";

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

const app = new Hono();

// Shared SOP store instance (singleton for the process lifetime)
const sopStore = new SOPStore();

// Shared skill store instance; legacy SQLite skills are copied into folders once (non-destructive).
const skillStore = new SkillStore();
{
  const migration = migrateLegacySkills(skillStore);
  if (migration.status !== "already-done") console.log(`[skill] legacy migration: ${migration.status} (${migration.migrated} skill(s))${migration.error ? ` — ${migration.error}` : ""}`);
}

// Shared memory, RAG knowledge, and custom agents store instances
const memoryStore = new MemoryStore();
const knowledgeStore = new KnowledgeStore();
const agentStore = new AgentStore();
setAgentStore(agentStore);

// Shared chat history store instance
const chatStore = new ChatStore();
setChatStore(chatStore);
const chatFolderStore = new ChatFolderStore();

// Shared usage tracking store instance
const usageStore = new UsageStore();

// Request logger
app.use("*", async (c, next) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] [http] --> ${c.req.method} ${c.req.path}`);
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] [http] <-- ${c.req.method} ${c.req.path} ${c.res.status} (${ms}ms)`);
});

// CORS
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

// ---------------------------------------------------------------------------
// GitHub Copilot transparent proxy
// pi-ai sends its own Authorization: Bearer <token> (fetched via apiKey).
// This proxy forwards that auth and injects required Copilot metadata headers.
// ---------------------------------------------------------------------------

app.all("/copilot/*", async (c) => {
  const upstream =
    "https://api.githubcopilot.com/" +
    c.req.path.replace(/^\/copilot\//, "");

  const body = c.req.method !== "GET" ? await c.req.text() : undefined;

  let upstream_resp: Response;
  try {
    upstream_resp = await copilotFetch(
      upstream,
      {
        method: c.req.method,
        body,
        // @ts-ignore — Bun supports duplex for streaming
        duplex: "half",
      },
      {
        "Content-Type": "application/json",
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.90.0",
        "Editor-Plugin-Version": "copilot-chat/0.1.0",
      }
    );
  } catch (err) {
    return c.json(
      { error: `Copilot auth failed: ${err instanceof Error ? err.message : String(err)}` },
      503
    );
  }

  const respHeaders: Record<string, string> = {};
  upstream_resp.headers.forEach((v, k) => {
    if (!["transfer-encoding", "connection"].includes(k.toLowerCase())) {
      respHeaders[k] = v;
    }
  });

  return new Response(upstream_resp.body, {
    status: upstream_resp.status,
    headers: respHeaders,
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/health", (c) => {
  const cfg = getSettings();
  const primary = cfg.llm_provider[0];
  const providerSource = process.env.RYE_LLM_PROVIDER ? "env" : "config/default";
  const modelSource =
    primary === "copilot"
      ? process.env.RYE_COPILOT_MODEL
        ? "env"
        : "config/default"
      : process.env.RYE_OLLAMA_MODEL
        ? "env"
        : "config/default";
  const model =
    cfg.harness === "claude" ? cfg.claude.model : primary === "copilot" ? cfg.copilot.model : cfg.ollama.model;
  return c.json({
    status: "ok",
    harness: cfg.harness,
    provider: primary,
    providers: cfg.llm_provider,
    model,
    provider_source: providerSource,
    model_source: modelSource,
    config_file: CONFIG_FILE,
    pid: process.pid,
  });
});

// ---------------------------------------------------------------------------
// Chat — SSE stream
// ---------------------------------------------------------------------------

const TurnIdSchema = z.string().min(1).max(128).optional();
const ChatEnvSchema = z.string().min(1).max(128).optional();
const RewindSchema = z.object({
  chat_id: z.string().min(1).max(128),
  index: z.number().int().nonnegative(),
});

function toRewindTurn(raw: unknown): RewindTurn | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { role, content, id } = raw as Record<string, unknown>;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
  return { role, content, id: typeof id === "string" ? id : undefined };
}

/** Cut the chat record and agent session before the user message at `index`. Returns an error message on bad input. */
function rewindChat(raw: unknown, sessionId: string): string | null {
  const parsed = RewindSchema.safeParse(raw);
  if (!parsed.success) return "Invalid rewind: expected { chat_id: string, index: integer >= 0 }";
  const { chat_id, index } = parsed.data;

  const chat = chatStore.get(chat_id);
  if (!chat || chat.sessionId !== sessionId) return "Chat not found for this session";
  const turns = chat.messages.map(toRewindTurn);
  if (index >= turns.length || turns[index]?.role !== "user") return "Rewind index must point at a user message";

  const kept = turns.slice(0, index).filter((t): t is RewindTurn => t !== null);
  const exact = turns.slice(index).every((t) => t?.role !== "user" || t.id !== undefined);
  const outcome = rewindSession(sessionId, kept, exact);
  console.log(`[${new Date().toISOString()}] [chat] rewind chat=${chat_id} index=${index} session=${outcome}`);

  chatStore.upsert({ ...chat, messages: chat.messages.slice(0, index), pendingPrompt: undefined, updatedAt: Date.now() });
  return null;
}

app.post("/chat/", async (c) => {
  const body = await c.req.json<{
    message?: string;
    // Continue after the tool-round limit; replaces `message`.
    continue?: boolean;
    session_id?: string;
    system_prompt_suffix?: string;
    model?: string;
    turn_id?: string;
    rewind?: unknown;
    env?: string;
    agent_id?: string;
  }>();

  const sessionId = body.session_id ?? crypto.randomUUID();
  const message = turnMessage(body);
  if (message === undefined) return c.json({ error: "message is required" }, 400);

  const isDedicatedAgentChat = Boolean(body.agent_id);
  const allAgents = agentStore.list();
  const collabSettings = readAgentSettings();

  // Extract recent turns from persisted chat history (for decision-model routing context)
  const existingChat = chatStore.getBySession(sessionId);
  const recentTurns: RecentTurn[] = (existingChat?.messages ?? [])
    .slice(-6)
    .flatMap((m): RecentTurn[] => {
      if (typeof m !== "object" || m === null) return [];
      const rec = m as { role?: string; content?: string; agentId?: string };
      if ((rec.role !== "user" && rec.role !== "assistant") || typeof rec.content !== "string" || !rec.content.trim()) {
        return [];
      }
      const speaker =
        rec.role === "user"
          ? "User"
          : (rec.agentId ? agentStore.get(rec.agentId)?.name : undefined) ?? "Rye";
      return [{ role: rec.role, speaker, content: rec.content }];
    });

  // Resolve active agent: explicit agent_id → @slug mention → optional decision-model auto-routing
  let activeAgent: AgentDefinition | null = body.agent_id
    ? agentStore.get(body.agent_id)
    : (agentStore.resolveMentions(message)[0] ?? null);

  const turnId = TurnIdSchema.safeParse(body.turn_id);
  if (!turnId.success) return c.json({ error: "Invalid turn_id" }, 400);
  const env = ChatEnvSchema.safeParse(body.env);
  if (!env.success) return c.json({ error: "Invalid env" }, 400);
  if (env.data !== undefined && env.data !== "default" && !Object.hasOwn(getSettings().environments, env.data)) {
    return c.json({ error: `Unknown environment "${env.data}"` }, 400);
  }
  // Snapshot the env for this run; omitted falls back to the global default.
  const abort = new AbortController();
  const runCtx: RunContext = {
    envKey: env.data === undefined ? getActiveEnv() : env.data === "default" ? null : env.data,
    sopDraftMode: false,
    pendingDraftEvents: [],
    signal: abort.signal,
  };
  if (body.rewind !== undefined) {
    const error = rewindChat(body.rewind, sessionId);
    if (error) return c.json({ error }, 400);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Session-ID", sessionId);

  return honoStream(c, (stream) => runWithContext(runCtx, async () => {
    // Stop in the UI closes this connection; cancel the run rather than keep working unseen.
    stream.onAbort(() => abort.abort());
    const send = async (event: Record<string, unknown>) => {
      await stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Long tool calls or model loads emit nothing; an SSE comment keeps the server idle timeout and proxies from dropping the stream.
    const heartbeat = setInterval(() => {
      void stream.write(": ping\n\n").catch(() => {});
    }, 15_000);

    const streamOneTurn = async (
      turnMessageText: string,
      agent: AgentDefinition | null,
      emitDone: boolean,
      currentTurnId?: string,
    ): Promise<{ text: string; stoppedEarly: boolean; finalSessionId: string }> => {
      let text = "";
      let stoppedEarly = false;
      let finalSessionId = sessionId;

      for await (const ev of runAgent(
        sessionId,
        turnMessageText,
        sopStore,
        memoryStore,
        body.system_prompt_suffix,
        skillStore,
        body.model,
        currentTurnId,
        knowledgeStore,
        agent,
      )) {
        switch (ev.type) {
          case "session":
            finalSessionId = ev.session_id;
            await send({ type: "session", session_id: ev.session_id });
            break;
          case "iter_start":
            await send({ type: "iter_start" });
            break;
          case "token":
            text += ev.content;
            await send({ type: "token", content: ev.content });
            break;
          case "tool_start":
            await send({ type: "tool_start", name: ev.name, args: ev.args });
            break;
          case "tool_result":
            await send({ type: "tool_result", name: ev.name, content: ev.content });
            break;
          case "usage":
            await send({ type: "usage", input_tokens: ev.input_tokens, output_tokens: ev.output_tokens, context_pct: ev.context_pct, model: ev.model, provider: ev.provider, cost_usd: ev.cost_usd });
            break;
          case "pause":
            stoppedEarly = true;
            await send({ type: "pause", content: ev.message, rounds: ev.rounds });
            break;
          case "prompt":
            stoppedEarly = true;
            await send({ type: "prompt", prompt_id: ev.prompt_id, prompt_type: ev.prompt_type, question: ev.question, options: ev.options, multi_select: ev.multi_select });
            break;
          case "iter_summary":
            await send({ type: "iter_summary", content: ev.content });
            break;
          case "sop_draft":
            await send({
              type: "sop_draft",
              sop_id: ev.sop_id,
              title: ev.title,
              proposed_content: ev.proposed_content,
              original_content: ev.original_content,
            });
            break;
          case "env_changed":
            await send({ type: "env_changed", env_key: ev.env_key, env_name: ev.env_name });
            break;
          case "done":
            finalSessionId = ev.session_id;
            if (emitDone) await send({ type: "done", session_id: ev.session_id });
            break;
          case "error":
            stoppedEarly = true;
            await send({ type: "error", error: ev.message });
            break;
        }
      }
      return { text, stoppedEarly, finalSessionId };
    };

    try {
      // Optional decision-model auto-routing for untagged messages in generic chats
      if (!isDedicatedAgentChat && !activeAgent && !body.continue && collabSettings.autoRoute && allAgents.length > 0) {
        activeAgent = await pickAutoRoutedAgent({
          message,
          recentTurns,
          agents: allAgents,
          signal: abort.signal,
        });
      }

      if (activeAgent) {
        await send({ type: "agent", agent_id: activeAgent.id, slug: activeAgent.slug, name: activeAgent.name });
      }

      const canFollowUp =
        !isDedicatedAgentChat &&
        !body.continue &&
        collabSettings.allowAgentReplies &&
        chattinessPolicy(collabSettings.chattiness).maxHops > 0 &&
        allAgents.length > 0;

      const first = await streamOneTurn(message, activeAgent, !canFollowUp, turnId.data);
      let lastSessionId = first.finalSessionId;

      if (canFollowUp && !first.stoppedEarly && !abort.signal.aborted) {
        const convo: RecentTurn[] = [
          ...recentTurns,
          { role: "user", speaker: "User", content: message },
          { role: "assistant", speaker: activeAgent?.name ?? "Rye", content: first.text },
        ];
        let lastSpeakerId: string | null = activeAgent?.id ?? null;
        let lastSpeakerName = activeAgent?.name ?? "Rye";
        const maxHops = chattinessPolicy(collabSettings.chattiness).maxHops;

        for (let hop = 0; hop < maxHops; hop++) {
          if (abort.signal.aborted) break;
          const nextAgent = await pickFollowUpAgent({
            recentTurns: convo,
            lastSpeakerId,
            agents: allAgents,
            chattiness: collabSettings.chattiness,
            hopIndex: hop,
            signal: abort.signal,
          });
          if (!nextAgent || abort.signal.aborted) break;

          await send({
            type: "agent_turn_start",
            agent_id: nextAgent.id,
            slug: nextAgent.slug,
            name: nextAgent.name,
          });

          const handoffPrompt = `[Agent-to-agent follow-up] ${lastSpeakerName} just responded above. Contribute only your specialized perspective, corrections, or additional checks relevant to the user's request — stay concise and don't repeat what was already said.`;
          const follow = await streamOneTurn(handoffPrompt, nextAgent, false);
          lastSessionId = follow.finalSessionId;
          convo.push({ role: "assistant", speaker: nextAgent.name, content: follow.text });
          lastSpeakerId = nextAgent.id;
          lastSpeakerName = nextAgent.name;
          if (follow.stoppedEarly) break;
        }

        if (!abort.signal.aborted) {
          await send({ type: "done", session_id: lastSessionId });
        }
      }
    } catch (err) {
      await send({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(heartbeat);
    }
  }));
});

// The chat list. With ?summary=1 each chat comes without its messages (and with a messageCount),
// which is what the web app loads at start; a chat's messages are fetched when it is opened.
app.get("/chat/history", (c) => {
  return c.json(c.req.query("summary") ? chatStore.summaries() : chatStore.list());
});

app.get("/chat/history/:id", (c) => {
  const chat = chatStore.get(c.req.param("id"));
  return chat ? c.json(chat) : c.json({ error: "Chat not found" }, 404);
});

// Search chat titles and message text; the sidebar calls this as the user types.
app.get("/chat/search", async (c) => {
  const limit = Math.min(Math.max(1, Number(c.req.query("limit")) || 20), 50);
  return c.json({ hits: await chatStore.search(c.req.query("q") ?? "", { limit }) });
});

app.put("/chat/history", async (c) => {
  const body = await c.req.json<unknown>();

  const chats = Array.isArray(body)
    ? body
    : (typeof body === "object" && body !== null && Array.isArray((body as { chats?: unknown }).chats)
      ? ((body as { chats: unknown[] }).chats)
      : null);

  if (!chats) {
    return c.json({ error: "Expected an array of chats or { chats: [...] }" }, 400);
  }

  // Saves the chats given; chats left out are kept (only DELETE /chat/history/:id removes one).
  const saved = chatStore.upsertMany(chats);
  return c.json({ status: "saved", count: saved.length });
});

// Single-chat upsert — avoids shipping the whole history on every change.
app.put("/chat/history/:id", async (c) => {
  const id = c.req.param("id");
  if (chatStore.isDeleted(id)) return c.json({ error: "Chat was deleted" }, 410);
  const body = await c.req.json<Record<string, unknown>>();
  const saved = chatStore.upsert({ ...body, id });
  if (!saved) return c.json({ error: "Invalid chat record" }, 400);
  return c.json({ status: "saved", id });
});

app.delete("/chat/history/:id", (c) => {
  const id = c.req.param("id");
  const chat = chatStore.get(id);
  const sessionId = chat?.sessionId || c.req.query("session_id");
  if (sessionId) markSessionDeleted(sessionId);
  const deletedResults = sessionId ? deleteResultsForSession(sessionId) : 0;
  if (sessionId) deleteArtifactsForSession(sessionId);
  if (sessionId) clearSession(sessionId);
  const removed = chatStore.remove(id);
  return c.json({ status: removed ? "deleted" : "not_found", id, deleted_results: deletedResults });
});

app.route("/chat", chatFolderRoutes(chatStore, chatFolderStore));

app.delete("/chat/session/:id", (c) => {
  const id = c.req.param("id");
  markSessionDeleted(id);
  const deletedResults = deleteResultsForSession(id);
  deleteArtifactsForSession(id);
  clearSession(id);
  return c.json({ status: "cleared", session_id: id, deleted_results: deletedResults });
});

app.post("/chat/title", async (c) => {
  const body = await c.req.json<{ user_message: string; assistant_response: string }>();
  const title = await generateChatTitle(body.user_message, body.assistant_response);
  return c.json({ title });
});

app.post("/chat/edit-suggestions", async (c) => {
  const body = await c.req.json<{ kind?: unknown; title?: unknown; content?: unknown }>().catch(() => ({}));
  const { kind, title, content } = body as { kind?: unknown; title?: unknown; content?: unknown };
  if ((kind !== "sop" && kind !== "skill") || typeof title !== "string" || typeof content !== "string") {
    return c.json({ error: "kind ('sop' | 'skill'), title and content are required" }, 400);
  }
  if (title.length > 500 || content.length > 200_000) return c.json({ error: "document too large" }, 413);

  const modelId = await resolveTaskModelId(getSettings(), "doc_review");
  const key = editSuggestionKey(kind, title, content, modelId);
  const cached = getCachedEditSuggestions(key);
  if (cached) return c.json({ suggestions: cached, cached: true });

  const suggestions = await generateEditSuggestions(kind, title, content, modelId);
  if (suggestions.length > 0) setCachedEditSuggestions(key, suggestions);
  return c.json({ suggestions, cached: false });
});

app.post("/chat/sop", async (c) => {
  const body = await c.req.json<{ description: string }>();
  try {
    const sopData = await extractSopFromChat(body.description);
    const id = await sopStore.save({
      title: sopData.title,
      description: sopData.description,
      content: sopData.content,
      steps: sopData.steps.map((s) => s.action),
      tags: sopData.tags,
    });
    return c.json({ sop_id: id, title: sopData.title, status: "saved" });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "SOP extraction failed" },
      500
    );
  }
});

// ---------------------------------------------------------------------------
// SOP CRUD
// ---------------------------------------------------------------------------

app.get("/sop/", (c) => {
  const sops = sopStore.list();
  console.log(`[sop] list() → ${sops.length} SOPs`);
  return c.json(sops);
});

app.get("/sop/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const limit = parseInt(c.req.query("limit") ?? "5", 10);
  const results = await sopStore.search(q, limit);
  return c.json(results);
});

app.get("/sop/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const sop = sopStore.get(id);
  if (!sop) return c.json({ error: "SOP not found" }, 404);
  return c.json(sop);
});

app.post("/sop/", async (c) => {
  const body = await c.req.json<{
    title: string;
    description?: string;
    content: string;
    steps?: string[];
    tags?: string[];
  }>();
  const id = await sopStore.save(body);
  return c.json({ sop_id: id, status: "created" }, 201);
});

app.delete("/sop/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const deleted = sopStore.delete(id);
  if (!deleted) return c.json({ error: "SOP not found" }, 404);
  return c.json({ status: "deleted", sop_id: id });
});

app.patch("/sop/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{
    title?: string;
    description?: string;
    content?: string;
    steps?: string[];
    tags?: string[];
  }>();
  const updated = await sopStore.update(id, body);
  if (!updated) return c.json({ error: "SOP not found" }, 404);
  return c.json({ status: "updated", sop_id: id });
});

app.post("/sop/:id/duplicate", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const newId = await sopStore.duplicate(id);
  if (newId === null) return c.json({ error: "SOP not found" }, 404);
  return c.json({ status: "duplicated", sop_id: newId }, 201);
});

app.post("/sop/:id/approve-draft", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const draft = getPendingDraft(id);
  if (!draft) return c.json({ error: "No pending draft for this SOP" }, 404);
  const updated = await sopStore.update(id, draft);
  if (!updated) return c.json({ error: "SOP not found" }, 404);
  clearPendingDraft(id);
  const sop = sopStore.get(id);
  return c.json({ status: "approved", sop_id: id, sop });
});

app.delete("/sop/:id/draft", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  clearPendingDraft(id);
  return c.json({ status: "discarded", sop_id: id });
});

// ---------------------------------------------------------------------------
// Environment CRUD
// ---------------------------------------------------------------------------

app.get("/env/", (c) => {
  const cfg = getSettings();
  const activeKey = getActiveEnv() ?? "default";
  const envs = [
    {
      key: "default",
      name: "Default",
      isActive: activeKey === "default",
      overrides: [] as string[],
    },
    ...Object.entries(cfg.environments).map(([key, env]) => ({
      key,
      name: env.name ?? key,
      isActive: activeKey === key,
      overrides: Object.keys(env).filter((k) => k !== "name"),
    })),
  ];
  return c.json(envs);
});

app.get("/env/active", (c) => {
  const cfg = getSettings();
  const activeKey = getActiveEnv() ?? "default";
  const env = activeKey === "default" ? null : cfg.environments[activeKey];
  return c.json({
    key: activeKey,
    name: env?.name ?? activeKey,
  });
});

app.post("/env/active", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const cfg = getSettings();
  if (body.key !== "default" && !cfg.environments[body.key]) {
    return c.json({ error: `Unknown environment "${body.key}"` }, 400);
  }
  setActiveEnv(body.key === "default" ? null : body.key);
  return c.json({ ok: true, key: body.key });
});

// ---------------------------------------------------------------------------
// Skills (folders on disk; see skill/routes.ts)
// ---------------------------------------------------------------------------

// Trailing slash so the list/create routes answer at /skill/ (matching /sop/).
app.route("/skill/", skillRoutes(skillStore));

// Auto-capture: extract a structured Skill from a description or chat transcript.
app.post("/chat/skill", async (c) => {
  const body = await c.req.json<{ description: string }>();
  try {
    const skillData = await extractSkillFromChat(body.description);
    const created = skillStore.create({
      title: skillData.title,
      description: skillData.description,
      content: skillData.content,
    });
    return c.json(skillToJson(created), 201);
  } catch (err) {
    return skillErrorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Memory CRUD
// ---------------------------------------------------------------------------

app.get("/memory/", (c) => {
  return c.json(memoryStore.all());
});

app.post("/memory/", async (c) => {
  const body = await c.req.json<{ key: string; value: string; kind?: MemoryKind; category?: string; tags?: string[] }>();
  if (!body.key || !body.value) {
    return c.json({ error: "key and value are required" }, 400);
  }
  memoryStore.save(body.key, body.value, body.tags ?? [], body.category ?? "general", { kind: body.kind });
  return c.json({ status: "saved", key: body.key }, 201);
});

app.delete("/memory/:key", (c) => {
  const key = c.req.param("key");
  const deleted = memoryStore.forget(key);
  if (!deleted) return c.json({ error: "Memory not found" }, 404);
  return c.json({ status: "deleted", key });
});

// ---------------------------------------------------------------------------
// Knowledge Base (RAG) & Custom Agents
// ---------------------------------------------------------------------------

// Trailing slashes so list/create routes answer at /knowledge/ and /agents/ (matching /sop/ and /skill/).
app.route("/knowledge/", knowledgeRoutes(knowledgeStore));
app.route("/agents/", agentRoutes(agentStore));
app.route("/speech/", speechRoutes());

// ---------------------------------------------------------------------------
// Connector status
// ---------------------------------------------------------------------------

interface ConnectorStatus {
  name: string;
  ok: boolean;
  error?: string;
}

/** One status per SQL connection of the active environment (MySQL and Postgres alike). */
async function checkDatabases(cfg: ReturnType<typeof getSettings>): Promise<ConnectorStatus[]> {
  const { connections, problems } = listConnections(cfg);
  // The old [mysql] section keeps the label it always had.
  const label = (name: string, type: "mysql" | "postgres") => (name === LEGACY_MYSQL_NAME ? "MySQL" : `${engineName(type)} · ${name}`);
  const broken: ConnectorStatus[] = problems.map((p) => ({ name: `Database · ${p.name}`, ok: false, error: p.problem }));
  const configured = connections.filter((c) => c.name !== LEGACY_MYSQL_NAME || c.database);
  if (configured.length === 0 && broken.length === 0) return [{ name: "Databases", ok: false, error: "Not configured" }];
  const checked = await Promise.all(
    configured.map(async (conn): Promise<ConnectorStatus> => {
      const looksUnresolved = /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|^[A-Z_][A-Z0-9_]*$/.test(conn.password);
      console.log(
        `[checkDatabase] ${conn.name} type=${conn.type} host=${conn.host} port=${conn.port} user=${conn.user} password_set=${conn.password ? "yes" : "no"} password_placeholder=${looksUnresolved} database=${conn.database} ssl=${conn.ssl}`,
      );
      try {
        await driverFor(conn.type).ping(conn, 4000);
        return { name: label(conn.name, conn.type), ok: true };
      } catch (err) {
        return { name: label(conn.name, conn.type), ok: false, error: errorText(err) };
      }
    }),
  );
  return [...checked, ...broken];
}

async function checkAWS(cfg: ReturnType<typeof getSettings>["aws"]): Promise<ConnectorStatus> {
  const profile = cfg.profile || "default";
  const usingExplicit = !!(cfg.access_key_id && cfg.secret_access_key);
  console.log(`[checkAWS] region=${cfg.region} profile=${profile} explicit_key=${usingExplicit}`);
  try {
    const { CloudWatchLogsClient, DescribeLogGroupsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
    const { fromSSO } = await import("@aws-sdk/credential-provider-sso");
    const baseCredentials = usingExplicit
      ? { accessKeyId: cfg.access_key_id!, secretAccessKey: cfg.secret_access_key! }
      : fromSSO({ profile });
    // wrap to log what credentials actually resolve to
    const credentials = usingExplicit ? baseCredentials : async () => {
      const creds = await (baseCredentials as () => Promise<{ accessKeyId: string; sessionToken?: string; expiration?: Date }>)();
      console.log(`[checkAWS] resolved key=${creds.accessKeyId.slice(0, 8)}... session=${!!creds.sessionToken} expires=${creds.expiration?.toISOString() ?? "n/a"}`);
      return creds;
    };
    const client = new CloudWatchLogsClient({ region: cfg.region, credentials: credentials as never });
    await client.send(new DescribeLogGroupsCommand({ limit: 1 }));
    console.log("[checkAWS] ✓ success");
    return { name: "AWS", ok: true };
  } catch (err) {
    console.log(`[checkAWS] ✗ error: ${err instanceof Error ? err.message : String(err)}`);
    return { name: "AWS", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkJira(cfg: ReturnType<typeof getSettings>["jira"]): Promise<ConnectorStatus> {
  console.log(`[checkJira] url=${cfg.url}`);
  if (!cfg.url || !cfg.email || !cfg.api_token) return { name: "Jira", ok: false, error: "Not configured" };
  try {
    const auth = Buffer.from(`${cfg.email}:${cfg.api_token}`).toString("base64");
    // const resp = await fetch(`${cfg.url.replace(/\/$/, "")}/rest/api/3/myself`, {
    const resp = await fetch(`${cfg.url.replace(/\/$/, "")}/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS%2CEDIT_ISSUES`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { name: "Jira", ok: true };
  } catch (err) {
    return { name: "Jira", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkGit(cfg: ReturnType<typeof getSettings>["git"]): Promise<ConnectorStatus> {
  if (!cfg.bitbucket_url || !cfg.bitbucket_token) return { name: "Git/Bitbucket", ok: false, error: "Not configured" };
  try {
    const resp = await fetch(`${cfg.bitbucket_url.replace(/\/$/, "")}/rest/api/1.0/application-properties`, {
      headers: { Authorization: `Bearer ${cfg.bitbucket_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { name: "Git/Bitbucket", ok: true };
  } catch (err) {
    return { name: "Git/Bitbucket", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkLLM(cfg: ReturnType<typeof getSettings>, provider: LlmProvider): Promise<ConnectorStatus> {
  if (provider === "ollama") {
    try {
      const resp = await fetch(`${cfg.ollama.base_url}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { name: "Ollama", ok: true };
    } catch (err) {
      return { name: "Ollama", ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // Copilot — check token fetch
  try {
    await getCopilotBearerToken();
    return { name: "Copilot", ok: true };
  } catch (err) {
    return { name: "Copilot", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Claude harness — Claude Code must start and be signed in. */
async function checkClaudeHarness(): Promise<ConnectorStatus> {
  try {
    const { account } = await claudeHarnessInfo();
    return account
      ? { name: "Claude", ok: true }
      : { name: "Claude", ok: false, error: "Claude Code isn't signed in. Run `claude` and use /login, or set ANTHROPIC_API_KEY." };
  } catch (err) {
    return { name: "Claude", ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

app.get("/status", async (c) => {
  const cfg = getEffectiveSettings();
  const results = await Promise.allSettled([
    ...(cfg.harness === "claude" ? [checkClaudeHarness()] : []),
    ...cfg.llm_provider.map((p) => checkLLM(cfg, p)),
    checkDatabases(cfg),
    checkAWS(cfg.aws),
    checkJira(cfg.jira),
    checkGit(cfg.git),
  ]);
  // The database check returns one status per connection; the others return one each.
  const statuses = results.flatMap((r): ConnectorStatus[] =>
    r.status === "fulfilled" ? [r.value].flat() : [{ name: "unknown", ok: false, error: String(r.reason) }],
  );
  return c.json(statuses);
});

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/** Every server in mcp.json (disabled and invalid ones included) with how its connection is doing. */
function mcpServerList() {
  const statuses = new Map(getServerStatuses().map((s) => [s.name, s]));
  let entries: McpServerEntry[] = [];
  let fileError: string | undefined;
  try {
    entries = listMcpServerEntries();
  } catch (err) {
    fileError = err instanceof Error ? err.message : String(err);
  }
  const servers = entries.map((entry) => {
    const status = statuses.get(entry.name);
    return {
      name: entry.name,
      disabled: entry.disabled,
      problems: entry.problems,
      // As written in the file: secrets there are ${ENV} references, which is what the editor should show.
      config: entry.config,
      transport: entry.config.url ? entry.config.transport ?? "http" : entry.config.command ? "stdio" : "unknown",
      connected: status?.connected ?? false,
      toolCount: status?.toolCount ?? 0,
      tools: getServerTools(entry.name),
      ...(status?.error ? { error: status.error } : {}),
      ...(entry.config.auth ? { auth: entry.config.auth } : {}),
      ...(status?.authRequired ? { authRequired: true, authorizeUrl: status.authorizeUrl } : {}),
    };
  });
  return { config_file: MCP_CONFIG_FILE, servers, ...(fileError ? { error: fileError } : {}) };
}

/**
 * Changing mcp.json decides which commands this machine runs, so these routes only answer the
 * app itself: a JSON body (which a web page on another site can't send without a preflight
 * that CORS refuses) and, when the browser says where the request came from, a local origin.
 */
function refuseForeignMcpWrite(c: Context): Response | null {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Send application/json." }, 415);
  }
  const origin = c.req.header("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      // not a URL: refused below
    }
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return c.json({ error: "Not allowed from this origin." }, 403);
  }
  return null;
}

app.get("/mcp/servers", (c) => {
  return c.json(mcpServerList());
});

app.post("/mcp/reload", async (c) => {
  await reloadMcp();
  return c.json({ status: "reloaded", ...mcpServerList() });
});

// Add a server, or replace one (PUT). The definition is validated the same way as when the agent proposes one.
const saveMcpServer = async (c: Context, name: string, replace: boolean) => {
  const refused = refuseForeignMcpWrite(c);
  if (refused) return refused;
  const body = (await c.req.json().catch(() => null)) as { config?: unknown } | null;
  if (!body || typeof body.config !== "object" || body.config === null) return c.json({ error: "Expected { config: { … } }." }, 400);
  try {
    writeMcpServer({ name, config: body.config as McpServerDefinition, replace });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  await reloadMcp();
  return c.json(mcpServerList(), replace ? 200 : 201);
};

app.post("/mcp/servers", async (c) => {
  const body = (await c.req.raw.clone().json().catch(() => null)) as { name?: unknown } | null;
  return saveMcpServer(c, typeof body?.name === "string" ? body.name.trim() : "", false);
});

app.put("/mcp/servers/:name", (c) => saveMcpServer(c, c.req.param("name"), true));

// Turn a server off or on without losing its definition.
app.patch("/mcp/servers/:name", async (c) => {
  const refused = refuseForeignMcpWrite(c);
  if (refused) return refused;
  const body = (await c.req.json().catch(() => null)) as { disabled?: unknown } | null;
  if (typeof body?.disabled !== "boolean") return c.json({ error: "Expected { disabled: true | false }." }, 400);
  try {
    if (!setMcpServerDisabled(c.req.param("name"), body.disabled)) return c.json({ error: "No such MCP server." }, 404);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  await reloadMcp();
  return c.json(mcpServerList());
});

app.delete("/mcp/servers/:name", async (c) => {
  const refused = refuseForeignMcpWrite(c);
  if (refused) return refused;
  try {
    if (!removeMcpServer(c.req.param("name"))) return c.json({ error: "No such MCP server." }, 404);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  await reloadMcp();
  return c.json(mcpServerList());
});

app.get("/mcp/oauth/start/:server", (c) => {
  const pending = getMcpOAuthAuthorization(c.req.param("server"));
  if (!pending) return c.text("No OAuth authorization is pending for this MCP server.", 404);
  return c.redirect(pending.authorizationUrl, 302);
});

app.get("/mcp/oauth/callback", async (c) => {
  const state = c.req.query("state") ?? "";
  const error = c.req.query("error");
  const code = c.req.query("code");
  const escapeHtml = (value: string) => value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
  );
  const page = (title: string, message: string, ok: boolean) => c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font:16px system-ui;max-width:640px;margin:80px auto;padding:0 24px;background:#faf9f6;color:#24221f">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${ok ? "<p>You can close this tab and return to Rye.</p><script>setTimeout(() => window.close(), 1500)</script>" : ""}</body></html>`,
    ok ? 200 : 400
  );

  if (!state) return page("OAuth failed", "The callback did not include a state value.", false);
  if (error) {
    const server = cancelMcpOAuth(state);
    return page("Authorization declined", server ? `Authorization for ${server} was not completed.` : "The OAuth state was invalid or expired.", false);
  }
  if (!code) return page("OAuth failed", "The callback did not include an authorization code.", false);

  try {
    const status = await completeMcpOAuth(state, code);
    return page(
      "MCP connected",
      `${status.name} connected successfully with ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}.`,
      true
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return page("OAuth failed", message, false);
  }
});

// ---------------------------------------------------------------------------
// Stored query results
// ---------------------------------------------------------------------------

app.get("/result", (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return c.json({ error: "session_id is required" }, 400);
  return c.json({ results: listResults(sessionId) });
});

app.get("/result/:id", (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return c.json({ error: "session_id is required" }, 400);
  const result = getResult(c.req.param("id"), sessionId);
  if (!result) return c.json({ error: "Result not found or expired" }, 404);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Artifacts (files the agent wrote for the user)
// ---------------------------------------------------------------------------

const ARTIFACT_MIME: Record<ArtifactFormat, string> = {
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html; charset=utf-8",
};

// Agent-written HTML runs in an opaque origin; scripts can't make requests, only <img> may load from https.
const ARTIFACT_HTML_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data: 'self'",
  "media-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

const ARTIFACT_FONT_PATH = "/artifact-font/allo.woff2";
const ARTIFACT_FONT_FILE = Bun.fileURLToPath(import.meta.resolve("allo-font/fonts/webfonts/AlloVariable.woff2"));
// :where() has zero specificity, so any font the page sets wins.
const ARTIFACT_FONT_STYLE =
  `<style>@font-face{font-family:"Allo";src:url("${ARTIFACT_FONT_PATH}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}` +
  `:where(html){font-family:"Allo",system-ui,sans-serif}</style>`;

// Insert after <head>, <html> or the doctype; anything before the doctype would put the page in quirks mode.
function withArtifactFont(html: string): string {
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return html.slice(0, at) + ARTIFACT_FONT_STYLE + html.slice(at);
    }
  }
  return ARTIFACT_FONT_STYLE + html;
}

function artifactRequest(c: { req: { query: (k: string) => string | undefined; param: (k: string) => string } }) {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return { error: "session_id is required", status: 400 as const };
  const artifact = getArtifact(c.req.param("id"), sessionId);
  if (!artifact) return { error: "Artifact not found", status: 404 as const };
  const v = c.req.query("version");
  const version = v === undefined ? undefined : Number(v);
  if (version !== undefined && !Number.isInteger(version)) return { error: "Invalid version", status: 400 as const };
  const source = readArtifactSource(artifact, version);
  if (!source) return { error: "Version not found or expired", status: 404 as const };
  return { artifact, source };
}

app.get("/artifact", (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return c.json({ error: "session_id is required" }, 400);
  return c.json({ artifacts: listArtifacts(sessionId) });
});

app.get("/artifact/:id", (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return c.json({ error: "session_id is required" }, 400);
  const artifact = getArtifact(c.req.param("id"), sessionId);
  if (!artifact) return c.json({ error: "Artifact not found" }, 404);
  return c.json(artifact);
});

app.get("/artifact/:id/content", (c) => {
  const r = artifactRequest(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ version: r.source.version, content: r.source.content });
});

app.get("/artifact/:id/view", (c) => {
  const r = artifactRequest(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  if (r.artifact.format !== "html") return c.json({ error: "Only HTML files can be viewed" }, 400);
  return c.body(withArtifactFont(r.source.content), 200, {
    "Content-Type": ARTIFACT_MIME.html,
    "Content-Security-Policy": ARTIFACT_HTML_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
});

// Sandboxed previews have an opaque origin, so the font request is cross-origin and needs CORS.
app.get(ARTIFACT_FONT_PATH, async (c) =>
  c.body(new Uint8Array(await Bun.file(ARTIFACT_FONT_FILE).arrayBuffer()), 200, {
    "Content-Type": "font/woff2",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  })
);

app.get("/artifact/:id/download", async (c) => {
  const r = artifactRequest(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const { artifact, source } = r;
  const body = artifact.format === "docx" ? await markdownToDocx(source.content, artifact.title) : source.content;
  // Filenames are slugs ([a-z0-9._-]), so they are safe in the header as-is.
  const latest = source.version.version === artifact.versions.at(-1)?.version;
  const filename = latest ? artifact.filename : artifact.filename.replace(/(\.[a-z]+)$/, `-v${source.version.version}$1`);
  return c.body(new Uint8Array(typeof body === "string" ? Buffer.from(body, "utf8") : body), 200, {
    "Content-Type": ARTIFACT_MIME[artifact.format],
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
});

// ---------------------------------------------------------------------------
// Link previews (hover cards for links in chat)
// ---------------------------------------------------------------------------

app.get("/link-preview", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url is required" }, 400);
  try {
    return c.json(await getLinkPreview(url), 200, { "Cache-Control": "private, max-age=3600" });
  } catch (err) {
    if (err instanceof LinkPreviewError) return c.json({ error: err.message }, err.status);
    return c.json({ error: "Preview failed" }, 502);
  }
});

// ---------------------------------------------------------------------------
// Usage analytics
// ---------------------------------------------------------------------------

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Every day in the window, so the chart keeps a continuous x-axis. */
function emptyDayRange(days: number): Map<string, { date: string; inputTokens: number; outputTokens: number; cost: number; calls: number }> {
  const out = new Map<string, { date: string; inputTokens: number; outputTokens: number; cost: number; calls: number }>();
  const today = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(today - i * 24 * 60 * 60 * 1000);
    out.set(date, { date, inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 });
  }
  return out;
}

app.get("/usage/summary", (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "30", 10) || 30, 1), 90);
  const events = usageStore.since(days);

  const llm = events.filter((e): e is LlmUsageEvent => e.kind === "llm");
  const tools = events.filter((e): e is ToolUsageEvent => e.kind === "tool");

  const byDay = emptyDayRange(days);
  const byModel = new Map<string, { model: string; inputTokens: number; outputTokens: number; cost: number; calls: number }>();
  let totalCost = 0;
  let pricedCalls = 0;

  for (const e of llm) {
    const cost = estimateCost(e.model, e.inputTokens, e.outputTokens);
    if (cost !== null) {
      totalCost += cost;
      pricedCalls++;
    }

    const day = byDay.get(dayKey(e.ts)) ?? { date: dayKey(e.ts), inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
    day.inputTokens += e.inputTokens;
    day.outputTokens += e.outputTokens;
    day.cost += cost ?? 0;
    day.calls++;
    byDay.set(day.date, day);

    const m = byModel.get(e.model) ?? { model: e.model, inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
    m.inputTokens += e.inputTokens;
    m.outputTokens += e.outputTokens;
    m.cost += cost ?? 0;
    m.calls++;
    byModel.set(e.model, m);
  }

  const byTool = new Map<string, { tool: string; calls: number; errors: number; totalMs: number }>();
  for (const e of tools) {
    const t = byTool.get(e.tool) ?? { tool: e.tool, calls: 0, errors: 0, totalMs: 0 };
    t.calls++;
    if (e.isError) t.errors++;
    t.totalMs += e.durationMs;
    byTool.set(e.tool, t);
  }

  // Context-window trace: one point per agent LLM call (decision-model calls excluded), newest sessions first.
  const contextTimeline = llm.filter((e) => e.source !== "decision").slice(-300).map((e) => ({
    ts: e.ts,
    sessionId: e.sessionId,
    model: e.model,
    contextPct: e.contextPct,
    inputTokens: e.inputTokens,
    contextWindow: e.contextWindow,
  }));

  return c.json({
    days,
    totals: {
      calls: llm.length,
      inputTokens: llm.reduce((sum, e) => sum + e.inputTokens, 0),
      outputTokens: llm.reduce((sum, e) => sum + e.outputTokens, 0),
      toolCalls: tools.length,
      cost: totalCost,
      // Lets the UI flag partial cost coverage instead of showing a misleading total.
      pricedCalls,
    },
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls),
    contextTimeline,
  });
});

app.get("/usage/pricing", (c) => c.json(readPricing()));

app.put("/usage/pricing", async (c) => {
  const body = await c.req.json<{ entries?: PriceInput[] }>();
  const { saved, skipped } = upsertPricing(body.entries ?? []);
  return c.json({ status: "saved", saved, skipped });
});

app.delete("/usage/pricing/:model", (c) => {
  const model = decodeURIComponent(c.req.param("model"));
  return c.json({ status: removePricing(model) ? "deleted" : "not_found", model });
});

// ---------------------------------------------------------------------------
// Model listing + selection
// ---------------------------------------------------------------------------

/** Models from every enabled provider, with per-provider fallbacks when one is unreachable. */
async function listProviderModels(cfg: ReturnType<typeof getSettings>, chatOnly: boolean) {
  const models: string[] = [];
  const errors: string[] = [];
  let cachedAt: number | undefined;
  // The Claude harness's models come first; it serves them ahead of any provider.
  if (cfg.harness === "claude") {
    try {
      models.push(...(await claudeHarnessInfo()).models);
    } catch (err) {
      models.push(...CLAUDE_MODEL_ALIASES);
      errors.push(`Claude: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const provider of cfg.llm_provider) {
    if (provider === "copilot") {
      try {
        const live = await fetchCopilotModels();
        models.push(...(chatOnly ? live.filter(supportsChatCompletions) : live));
      } catch (err) {
        // Serve the last successful fetch rather than a stale hardcoded list.
        const cached = readModelsCache();
        models.push(...(cached?.models ?? []).filter((m) => !chatOnly || supportsChatCompletions(m)));
        cachedAt = cached?.fetchedAt;
        errors.push(`Copilot: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      try {
        // Decision models (e.g. Clef) can't chat, so keep them out of chat model lists.
        const decisionOnly = new Set(await ollamaDecisionModelsOrEmpty(cfg));
        models.push(...(await fetchOllamaModels(cfg)).filter((m) => !decisionOnly.has(m)));
      } catch (err) {
        models.push(cfg.ollama.model);
        errors.push(`Ollama: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { models: [...new Set(models)], error: errors.join("; ") || undefined, cachedAt };
}

app.get("/models", async (c) => {
  const cfg = getSettings();
  const current = await resolveTaskModelId(cfg, "chat");
  const { models, error, cachedAt } = await listProviderModels(cfg, false);
  if (current && !models.includes(current)) models.unshift(current);
  return c.json({
    harness: cfg.harness,
    provider: cfg.llm_provider[0],
    providers: cfg.llm_provider,
    current,
    models,
    auto: cfg.harness === "pi" && cfg.llm_provider[0] === "copilot" && !cfg.copilot.model,
    ...(error ? { error, stale: cachedAt !== undefined, cached_at: cachedAt } : {}),
  });
});

// Runtime model override — survives until the process restarts
app.post("/models/select", async (c) => {
  const { model } = await c.req.json<{ model: string }>();
  if (!model) return c.json({ error: "model required" }, 400);
  setRuntimeModel(model);
  return c.json({ ok: true, model });
});

// ---------------------------------------------------------------------------
// Model tiers — which model backs low/medium/high, and which tier each task uses
// ---------------------------------------------------------------------------

// Re-embedding the knowledge base and SOPs after the embedding model changes. One at a time, in the
// background: a large model can take minutes, and the Settings page polls this while it runs.
const reindexJob: { running: boolean; done: number; total: number; model: string | null; error: string | null; finished_at: number | null } = {
  running: false, done: 0, total: 0, model: null, error: null, finished_at: null,
};

function startReindex(): boolean {
  if (reindexJob.running) return false;
  Object.assign(reindexJob, { running: true, done: 0, total: 0, model: getSettings().ollama.embedding_model, error: null, finished_at: null });
  void (async () => {
    try {
      const result = await knowledgeStore.reindexAll((done, total) => Object.assign(reindexJob, { done, total }));
      reindexJob.done = reindexJob.total = result.docs;
      if (result.docs > 0 && !result.embedded) reindexJob.error = "The embedding model didn't answer, so notes are searchable by keyword only. Check that Ollama is running, then reindex again.";
      else await sopStore.reembedAll();
      // Message vectors swap to the new model at once and are filled in the background (by the local model only).
      chatStore.useEmbeddingModel(getSettings().ollama.embedding_model);
    } catch (err) {
      reindexJob.error = err instanceof Error ? err.message : String(err);
    } finally {
      Object.assign(reindexJob, { running: false, finished_at: Date.now() });
    }
  })();
  return true;
}

async function retrievalPayload(cfg: ReturnType<typeof getSettings>, overrides: ModelOverrides) {
  const installed = await listOllamaModels(cfg);
  const model = cfg.ollama.embedding_model;
  const knowledge = knowledgeStore.embeddingStatus();
  const chats = chatStore.embeddingStatus();
  // Notes indexed with another model can't be found by meaning until they are re-embedded. Only said when
  // Ollama has the chosen model: without it a hosted fallback embeds, under its own model name.
  const stale = knowledge.models.filter((m) => !sameModel(m.model, model)).reduce((n, m) => n + m.chunks, 0);
  const usable = installed.some((m) => sameModel(m.name, model));
  return {
    embedding: {
      model,
      source: overrides.embedding_model ? "settings" : "config",
      ollama_models: installed.filter((m) => m.capabilities.includes("embedding")).map((m) => m.name),
      needs_reindex: usable && stale > 0,
      knowledge,
      chats,
      reindex: reindexJob,
    },
    rerank: {
      provider: cfg.rerank.provider,
      model: cfg.rerank.model,
      url: cfg.rerank.url,
      source: overrides.rerank?.provider != null ? "settings" : cfg.rerank.provider !== "off" ? "config" : "default",
      ollama_models: installed.filter((m) => m.capabilities.includes("completion")).map((m) => m.name),
      problem: cfg.rerank.provider === "ollama" && cfg.rerank.model ? ollamaRerankProblem(cfg.rerank.model) : null,
      decision_ready: cfg.decision.provider !== "off",
    },
  };
}

async function modelSettingsPayload() {
  const cfg = getSettings();
  const overrides = readModelOverrides();
  const { models: available } = await listProviderModels(cfg, true);

  const tiers = Object.fromEntries(
    await Promise.all(
      MODEL_TIERS.map(async (tier) => [
        tier,
        {
          configured: cfg.models[tier],
          effective: await resolveTierModelId(cfg, tier),
          source: overrides[tier] !== undefined ? "settings" : cfg.models[tier] ? "config" : "auto",
        },
      ])
    )
  );

  return {
    harness: cfg.harness,
    provider: cfg.llm_provider[0],
    providers: cfg.llm_provider,
    available,
    tiers,
    tasks: cfg.models.tasks,
    decision: {
      provider: cfg.decision.provider,
      model: cfg.decision.model,
      effective_model: await resolveDecisionModelId(cfg).catch(() => ""),
      source: {
        provider: overrides.decision?.provider != null ? "settings" : cfg.decision.provider !== "off" ? "config" : "default",
        model: overrides.decision?.model != null ? "settings" : cfg.decision.model ? "config" : "default",
      },
      clef_models: CLEF_MODELS,
      ollama_models: await ollamaDecisionModelsOrEmpty(cfg),
      // Never return the Cloudflare token or URLs; only whether Clef is reachable.
      clef_configured: clefTarget(cfg.decision.clef) !== null,
      clef_target: clefTarget(cfg.decision.clef),
      timeout_ms: cfg.decision.timeout_ms,
      tool_threshold: cfg.decision.tool_threshold,
    },
    retrieval: await retrievalPayload(cfg, overrides),
    settings_file: MODEL_SETTINGS_FILE,
    config_file: CONFIG_FILE,
  };
}

// null in a PUT clears that decision override.
function mergeDecisionOverrides<T extends object>(current: T | undefined, patch: T | undefined): T | undefined {
  const merged = Object.fromEntries(Object.entries({ ...current, ...patch }).filter(([, v]) => v != null));
  return Object.keys(merged).length > 0 ? (merged as T) : undefined;
}

app.get("/models/settings", async (c) => c.json(await modelSettingsPayload()));

app.put("/models/settings", async (c) => {
  const parsed = ModelOverridesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid settings" }, 400);
  const current = readModelOverrides();
  const before = getSettings().ollama.embedding_model;
  const wanted = parsed.data.embedding_model;
  if (wanted && !sameModel(wanted, before)) {
    if (reindexJob.running) return c.json({ error: "Reindexing is still running. Change the embedding model when it has finished." }, 409);
    // A model that can't load would leave search with no vectors at all, so it is tried before it is saved.
    const probe = await probeEmbeddingModel(getSettings(), wanted);
    if (!probe.ok) return c.json({ error: `Ollama can't embed with ${wanted}: ${probe.error}` }, 400);
  }
  const next: ModelOverrides = {
    ...current,
    ...parsed.data,
    tasks: { ...current.tasks, ...parsed.data.tasks },
    decision: mergeDecisionOverrides(current.decision, parsed.data.decision),
    rerank: mergeDecisionOverrides(current.rerank, parsed.data.rerank),
  };
  // null clears the override, so config.toml's model applies again.
  if (next.embedding_model == null) delete next.embedding_model;
  writeModelOverrides(next);
  if (parsed.data.decision) warmOllamaDecisionModel(getSettings());
  // The old vectors are set aside and the new model's are made (or brought back from the backup) straight away.
  if (!sameModel(getSettings().ollama.embedding_model, before)) startReindex();
  return c.json(await modelSettingsPayload());
});

// Embed the knowledge base again with the current model (also the way back to a previous model's backup).
app.post("/models/embeddings/reindex", async (c) => {
  if (!startReindex()) return c.json({ error: "Reindexing is already running." }, 409);
  return c.json(await modelSettingsPayload());
});

// Drop UI overrides so config.toml and env vars apply again.
app.delete("/models/settings", async (c) => {
  writeModelOverrides({});
  return c.json(await modelSettingsPayload());
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export default app;

if (import.meta.main) {
  const { host, port } = settings;
  // Fire and forget: MCP tools appear as soon as each server handshakes.
  void initMcp();
  warmOllamaDecisionModel(getSettings());
  console.log(`Rye agent listening on http://${host}:${port}`);
  Bun.serve({
    fetch: app.fetch,
    hostname: host,
    port,
    idleTimeout: 60,
  });
}
