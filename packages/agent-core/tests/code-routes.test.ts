/**
 * The `/code/` routes (code/routes.ts) over a temporary data dir and a temporary git repo, with a
 * scripted engine. No real agent, no sandbox-exec.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { SSEEvent } from "@rye/shared";
import type { FakeScript } from "../src/code/engines/fake.js";
import { codeRoutes } from "../src/code/routes.js";
import { cleanup, codeHarness, git, type CodeHarness } from "./code-test-utils.js";

afterAll(cleanup);
const TIMEOUT = 60_000;

const script: FakeScript = async function* (ctx) {
  yield { type: "engine_session", id: "eng-routes" };
  yield { type: "text", delta: "Adding a file. " };
  const id = `install-${ctx.options.input.text.length}`;
  yield { type: "tool_start", id, name: "Bash", args: { command: "bun add left-pad" } };
  const d = await ctx.options.approve({ id: `ask-${id}`, sessionId: ctx.options.workspace.sessionId, toolName: "Bash", toolUseId: id, kind: "command", category: "install", reason: "installs packages from registry.npmjs.org", command: "bun add left-pad", cwd: "", hosts: ["registry.npmjs.org"], pattern: "bun add *" });
  writeFileSync(join(ctx.options.workspace.repoDir, "src", "feature.ts"), `export const allowed = ${d.behavior === "allow"};\n`);
  yield { type: "tool_result", id, content: d.behavior === "allow" ? "installed" : "refused", isError: d.behavior !== "allow" };
  yield { type: "usage", inputTokens: 5, outputTokens: 5, costUsd: 0.5 };
  yield { type: "done", reason: "end" };
};

function app(h: CodeHarness, enabled = () => true): Hono {
  const a = new Hono();
  a.route("/code/", codeRoutes({ runner: () => h.runner, enabled }));
  return a;
}

const JSON_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:8080" };
const post = (a: Hono, path: string, body: unknown = {}, headers: Record<string, string> = JSON_HEADERS) =>
  a.request(path, { method: "POST", headers, body: JSON.stringify(body) });

/** Read SSE frames until `stop` says so; returns [id, event] pairs. */
async function readEvents(res: Response, stop: (e: SSEEvent) => boolean): Promise<Array<{ id: number; event: SSEEvent }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: Array<{ id: number; event: SSEEvent }> = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const id = /^id: (\d+)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!data) continue;
      const event = JSON.parse(data) as SSEEvent;
      out.push({ id: Number(id), event });
      if (stop(event)) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

describe("/code/ routes", () => {
  test("off without repos: every route is a JSON 404, engines included", async () => {
    const h = codeHarness(script);
    const a = app(h, () => false);
    for (const [method, path] of [["GET", "/code/engines"], ["GET", "/code/repos"], ["GET", "/code/sessions"], ["POST", "/code/sessions"], ["GET", "/code/sessions/x/events"], ["DELETE", "/code/sessions/x"]] as const) {
      const res = await a.request(path, { method, headers: JSON_HEADERS, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    }
  });

  test("the local-origin guard: JSON only, and only from a local origin", async () => {
    const h = codeHarness(script);
    const a = app(h);
    const form = await a.request("/code/sessions", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ repo: "demo", task: "x" }) });
    expect(form.status).toBe(415);
    const foreign = await post(a, "/code/sessions", { repo: "demo", task: "x" }, { "Content-Type": "application/json", Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const del = await a.request("/code/sessions/x", { method: "DELETE", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(del.status).toBe(403);
    // Nothing was created by the refused requests.
    expect(h.store.list({ status: "all" })).toHaveLength(0);
    // Reads need no guard.
    expect((await a.request("/code/engines", { headers: { Accept: "application/json" } })).status).toBe(200);
  });

  test("create → events → approve → changes → stage → create branch → merge", async () => {
    const h = codeHarness(script);
    const a = app(h);

    const engines = await (await a.request("/code/engines", { headers: { Accept: "application/json" } })).json() as { engines: Array<{ id: string }>; defaultEngine: string };
    expect(engines.engines.map((e) => e.id)).toEqual(["claude"]);
    expect(engines.defaultEngine).toBe("claude");
    const repos = await (await a.request("/code/repos")).json() as { repos: Array<{ name: string; available: boolean; base: string }> };
    expect(repos.repos).toEqual([expect.objectContaining({ name: "demo", available: true, base: "main" })]);
    const branches = await (await a.request("/code/repos/demo/branches")).json() as { branches: string[]; defaultBase: string; dirty: boolean };
    expect(branches).toEqual({ branches: ["main"], defaultBase: "main", dirty: false });
    expect((await (await a.request("/code/policy")).json() as { rules: unknown[] }).rules.length).toBeGreaterThan(0);

    const created = await post(a, "/code/sessions", { repo: "demo", task: "Add a feature" });
    expect(created.status).toBe(200);
    const { session, chatId } = (await created.json()) as { session: { id: string; chatId: string; lastSeq: number; branch: string }; chatId: string };
    expect(session.chatId).toBe(chatId);
    expect(h.chats.get(chatId)?.kind).toBe("code");

    const listed = await (await a.request(`/code/sessions?chat=${chatId}&status=all`)).json() as { sessions: Array<{ id: string }> };
    expect(listed.sessions.map((s) => s.id)).toEqual([session.id]);

    // The event stream: SSE ids are the seqs, every event has its seq; wait for the live prompt.
    const events = await a.request(`/code/sessions/${session.id}/events?after=0`, { headers: { Accept: "text/event-stream" } });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readEvents(events, (e) => e.type === "prompt");
    expect(frames.every((f) => f.id === f.event.seq)).toBe(true);
    const prompt = frames.at(-1)!.event;
    expect(prompt.live).toBe(true);
    expect(prompt.options).toEqual(["Allow once", 'Allow "bun add *" for this session', "Deny"]);

    // Busy while it waits.
    const busy = await post(a, `/code/sessions/${session.id}/files/stage`, { paths: ["src/app.ts"], staged: true });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { code: string }).code).toBe("busy");

    const ok = await post(a, `/code/sessions/${session.id}/approvals/${prompt.prompt_id}`, { answer: "Allow once" });
    expect(await ok.json()).toEqual({ ok: true });
    const again = await post(a, `/code/sessions/${session.id}/approvals/${prompt.prompt_id}`, { answer: "Allow once" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("answered");

    // Resume strictly after the prompt, up to the turn's end.
    const rest = await readEvents(await a.request(`/code/sessions/${session.id}/events?after=${prompt.seq}`), (e) => e.type === "done");
    expect(rest[0].id).toBe(prompt.seq! + 1);
    expect(rest.map((f) => f.event.type)).toContain("tool_result");
    await h.runner.idle(session.id);

    const detail = await (await a.request(`/code/sessions/${session.id}`)).json() as { lastSeq: number; status: { activity: string; costUsd: number }; costUsd: number; editorUrl: string; workspacePath: string };
    expect(detail.status.activity).toBe("ready");
    expect(detail.costUsd).toBeCloseTo(0.5);
    expect(detail.editorUrl).toBe(`vscode://file${encodeURI(detail.workspacePath)}`);
    expect(detail.lastSeq).toBe(h.store.get(session.id) ? (await h.runner.detail(session.id)).lastSeq : -1);

    const changes = await (await a.request(`/code/sessions/${session.id}/changes`)).json() as { since: string; files: Array<{ path: string; stage: string }> };
    expect(changes.since).toBe("base");
    expect(changes.files.map((f) => f.path)).toEqual(["src/feature.ts"]);
    const diff = await (await a.request(`/code/sessions/${session.id}/diff?path=src/feature.ts`)).json() as { file: { hunks: Array<{ lines: Array<{ text: string }> }> } };
    expect(diff.file.hunks[0].lines[0].text).toBe("export const allowed = true;");
    expect((await a.request(`/code/sessions/${session.id}/diff?path=nope.ts`)).status).toBe(404);
    expect((await a.request(`/code/sessions/${session.id}/changes?since=bogus`)).status).toBe(400);
    const commands = await (await a.request(`/code/sessions/${session.id}/commands`)).json() as { commands: Array<{ command: string; status: string }> };
    expect(commands.commands).toEqual([expect.objectContaining({ command: "bun add left-pad", status: "ok" })]);
    const snaps = await (await a.request(`/code/sessions/${session.id}/snapshots`)).json() as { snapshots: Array<{ turn: number }> };
    expect(snaps.snapshots.map((s) => s.turn)).toEqual([1]);

    const staged = await (await post(a, `/code/sessions/${session.id}/files/stage`, { paths: ["src/feature.ts"], staged: true })).json() as { files: Array<{ stage: string }> };
    expect(staged.files[0].stage).toBe("staged");

    const message = await (await post(a, `/code/sessions/${session.id}/branch/message`)).json() as { message: string };
    expect(message.message).toContain("src/feature.ts");
    const branch = await (await post(a, `/code/sessions/${session.id}/branch`, { mode: "squash", message: message.message })).json() as { status: string; branch: string; commits: number };
    expect(branch.status).toBe("created");
    expect(branch.commits).toBe(1);
    expect(git(h.repo, ["branch", "--list", "rye/*", "--format=%(refname:short)"])).toBe(branch.branch);
    expect(git(h.repo, ["log", "-1", "--format=%an <%ae>", branch.branch])).toBe("Ada User <ada@example.com>");
    expect(git(h.repo, ["show", `${branch.branch}:src/feature.ts`])).toBe("export const allowed = true;");
    const bad = await post(a, `/code/sessions/${session.id}/branch`, { name: "main" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("invalid");

    writeFileSync(join(h.repo, "README.md"), "# Demo\n\nThe base moved on.\n");
    git(h.repo, ["commit", "-q", "-am", "base moves"]);
    const merged = await (await post(a, `/code/sessions/${session.id}/merge`, { name: "rye/with-main" })).json() as { status: string; branch: string; baseTip: string };
    expect(merged.status).toBe("merged");
    expect(merged.baseTip).toBe(git(h.repo, ["rev-parse", "main"]));
    expect(git(h.repo, ["show", "rye/with-main:README.md"])).toContain("The base moved on.");
    // The user's checkout and branches are as they were, plus the two new rye/* branches.
    expect(git(h.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(h.repo, ["status", "--porcelain"])).toBe("");

    // Archive, restore, delete (Settings → Code); never the user's rye/* branches.
    expect(((await (await post(a, `/code/sessions/${session.id}/archive`)).json()) as { state: string }).state).toBe("archived");
    expect((await a.request(`/code/sessions/${session.id}/changes`)).status).toBe(409);
    expect(((await (await post(a, `/code/sessions/${session.id}/restore`)).json()) as { state: string }).state).toBe("active");
    const removed = await (await a.request(`/code/sessions/${session.id}`, { method: "DELETE", headers: JSON_HEADERS, body: "{}" })).json() as { status: string; removedRefs: number };
    expect(removed.status).toBe("deleted");
    expect(removed.removedRefs).toBeGreaterThan(0);
    expect(git(h.repo, ["for-each-ref", `refs/rye/${session.id}/`])).toBe("");
    expect(git(h.repo, ["branch", "--list", "rye/*", "--format=%(refname:short)"]).split("\n").sort()).toEqual([branch.branch, "rye/with-main"].sort());
    expect((await a.request(`/code/sessions/${session.id}`)).status).toBe(404);
  }, TIMEOUT);

  test("bad bodies and unknown sessions answer { error, code }", async () => {
    const h = codeHarness(script);
    const a = app(h);
    const missing = await post(a, "/code/sessions", { repo: "nope", task: "x" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: expect.any(String), code: "not_found" });
    const invalid = await post(a, "/code/sessions", { repo: "demo" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: string }).code).toBe("invalid");
    const notJson = await a.request("/code/sessions", { method: "POST", headers: JSON_HEADERS, body: "[1,2]" });
    expect(notJson.status).toBe(400);
    for (const path of ["/code/sessions/cs_none", "/code/sessions/cs_none/status", "/code/sessions/cs_none/events"]) {
      const res = await a.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });
});
