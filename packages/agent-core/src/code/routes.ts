/**
 * The `/code/` routes (docs/design/code-sessions.md; the route table is in the header of
 * `packages/shared/src/code.ts`). Mounted at `/code/` in server.ts.
 *
 * - **Enable gating.** While `[code]` lists no repos (or `enabled = false`), every route answers
 *   404, `/code/engines` included, so the web app keeps every code-session entry point hidden and
 *   nothing about the app changes until the user configures code sessions.
 * - **Local-origin guard.** Every route that changes anything accepts only a JSON body and, when
 *   the browser names an origin, a local one (`refuseForeignWrite`, the `refuseForeignMcpWrite`
 *   rule of server.ts): a page on another site can't send JSON without a preflight CORS refuses.
 * - Every answer is JSON, errors `{ error, code }` (`codeErrorResponse`), except `/events`, an SSE
 *   stream whose frames are `id: <seq>` and `data: <SSEEvent with seq>`.
 */

import { Hono, type Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import type { SSEEvent } from "@rye/shared";
import { CodeError, codeErrorResponse, type CodeRunner } from "./runner.js";
import type { CodeLogEntry } from "./types.js";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** JSON only, and a local origin when the browser says where the request came from. */
export function refuseForeignWrite(c: Context): Response | null {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Send application/json.", code: "invalid" }, 415);
  }
  const origin = c.req.header("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      // not a URL: refused below
    }
    if (!LOCAL_HOSTS.includes(host)) return c.json({ error: "Not allowed from this origin.", code: "invalid" }, 403);
  }
  return null;
}

/** A path parameter (always present on the routes that read it). */
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

function fail(c: Context, err: unknown): Response {
  const { status, body } = codeErrorResponse(err);
  if (status >= 500) console.error(`[${new Date().toISOString()}] [code] ${c.req.method} ${c.req.path} failed:`, err);
  return c.json(body, status as 400);
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json<unknown>().catch(() => undefined);
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new CodeError("The body must be a JSON object.", "invalid");
  return body as Record<string, unknown>;
}

/**
 * Write a code session's events as SSE: each frame `id: <seq>` then `data: <event>`, with a
 * heartbeat comment so idle timeouts and proxies keep the stream. Closing it stops only the
 * subscription, never the run.
 */
export function streamCodeEvents(c: Context, open: (signal: AbortSignal) => AsyncIterable<CodeLogEntry>, first?: SSEEvent): Response {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return honoStream(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    const heartbeat = setInterval(() => {
      void stream.write(": ping\n\n").catch(() => ctrl.abort());
    }, 15_000);
    try {
      if (first) await stream.write(`data: ${JSON.stringify(first)}\n\n`);
      for await (const entry of open(ctrl.signal)) {
        await stream.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.event)}\n\n`);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) await stream.write(`data: ${JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) })}\n\n`).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      ctrl.abort();
    }
  });
}

export interface CodeRoutesOptions {
  /** The runner (built lazily, on the first request that needs it). */
  runner: () => CodeRunner;
  /** Whether code sessions are on: `[code] enabled` and at least one `[[code.repos]]`. */
  enabled: () => boolean;
}

export function codeRoutes(o: CodeRoutesOptions): Hono {
  const r = new Hono();

  // Off: as if the routes didn't exist.
  r.use("*", async (c, next) => {
    if (!o.enabled()) return c.json({ error: "Code sessions are not set up ([code] with [[code.repos]] in config.toml).", code: "not_found" }, 404);
    await next();
  });

  /** A read route: JSON or `{ error, code }`. */
  const read = (handler: (c: Context, runner: CodeRunner) => Promise<unknown> | unknown) => async (c: Context) => {
    try {
      return c.json((await handler(c, o.runner())) as object);
    } catch (err) {
      return fail(c, err);
    }
  };
  /** A write route: the local-origin guard first, then JSON or `{ error, code }`. */
  const write = (handler: (c: Context, runner: CodeRunner, body: Record<string, unknown>) => Promise<unknown> | unknown) => async (c: Context) => {
    const refused = refuseForeignWrite(c);
    if (refused) return refused;
    try {
      const body = await jsonBody(c);
      return c.json((await handler(c, o.runner(), body)) as object);
    } catch (err) {
      return fail(c, err);
    }
  };

  r.get("/repos", read((_c, runner) => runner.repos()));
  r.get("/repos/:name/branches", read((c, runner) => runner.branches(param(c, "name"))));
  r.get("/engines", read((_c, runner) => runner.engines()));
  r.get("/policy", read((_c, runner) => runner.policy()));

  r.get("/sessions", read(async (c, runner) => {
    const status = c.req.query("status") as "active" | "archived" | "all" | undefined;
    return { sessions: await runner.list({ ...(status ? { status } : {}), ...(c.req.query("chat") ? { chat: c.req.query("chat") } : {}) }) };
  }));
  r.post("/sessions", write(async (_c, runner, body) => {
    const parentChatId = typeof body.parentChatId === "string" && body.parentChatId ? body.parentChatId : undefined;
    const { session, chatId } = await runner.create(body as never, parentChatId ? { parentChatId } : {});
    return { session, chatId };
  }));
  r.get("/sessions/:id", read((c, runner) => runner.detail(param(c, "id"))));
  r.get("/sessions/:id/status", read((c, runner) => runner.status(param(c, "id"))));

  r.get("/sessions/:id/events", async (c) => {
    const id = param(c, "id");
    const raw = c.req.query("after");
    const after = raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(after) || after < 0) return fail(c, new CodeError("after must be a sequence number.", "invalid"));
    const runner = o.runner();
    try {
      await runner.status(id); // 404 before the stream opens
    } catch (err) {
      return fail(c, err);
    }
    return streamCodeEvents(c, (signal) => runner.subscribe(id, after, signal));
  });

  r.post("/sessions/:id/stop", write(async (c, runner) => {
    await runner.stop(param(c, "id"));
    return { ok: true };
  }));
  r.post("/sessions/:id/approvals/:promptId", write((c, runner, body) => {
    runner.answer(param(c, "id"), param(c, "promptId"), body.answer);
    return { ok: true };
  }));

  r.get("/sessions/:id/changes", read((c, runner) => runner.changes(param(c, "id"), c.req.query("since"))));
  r.get("/sessions/:id/diff", read((c, runner) => runner.fileDiff(param(c, "id"), c.req.query("path"), c.req.query("since"))));
  r.get("/sessions/:id/snapshots", read((c, runner) => runner.snapshots(param(c, "id"))));
  r.get("/sessions/:id/commands", read((c, runner) => runner.commands(param(c, "id"))));

  r.post("/sessions/:id/files/stage", write((c, runner, body) => runner.stage(param(c, "id"), body.paths, body.staged)));
  r.post("/sessions/:id/files/discard", write((c, runner, body) => runner.discard(param(c, "id"), body.paths)));
  r.post("/sessions/:id/branch/message", write((c, runner) => runner.draftBranchMessage(param(c, "id"))));
  r.post("/sessions/:id/branch", write((c, runner, body) => runner.createBranch(param(c, "id"), body as never)));
  r.post("/sessions/:id/merge", write((c, runner, body) => runner.merge(param(c, "id"), body as never)));
  r.post("/sessions/:id/archive", write((c, runner) => runner.archive(param(c, "id"))));
  r.post("/sessions/:id/restore", write((c, runner) => runner.restore(param(c, "id"))));
  r.delete("/sessions/:id", write((c, runner) => runner.remove(param(c, "id"))));

  r.notFound((c) => c.json({ error: "Not found.", code: "not_found" }, 404));
  return r;
}
