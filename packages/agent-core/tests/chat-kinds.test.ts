/**
 * Chat kinds: the additive `chats.kind` / `chats.parent_chat_id` columns (chat/store.ts), the
 * server-side kind registry and `POST /chat/` dispatch (chat/kinds.ts). Scripted engine only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { ChatKindRegistry, codeChatKind, kindChatTurn } from "../src/chat/kinds.js";
import { ChatStore } from "../src/chat/store.js";
import type { FakeScript } from "../src/code/engines/fake.js";
import { cleanup, codeHarness, tmp } from "./code-test-utils.js";

afterAll(cleanup);
const TIMEOUT = 60_000;

/** The chats and messages tables as they were before chat kinds (no kind, no parent_chat_id). */
const OLD_SCHEMA = `
  CREATE TABLE chats (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
    model TEXT, pending_prompt TEXT, env TEXT, unread INTEGER NOT NULL DEFAULT 0, folder_id TEXT,
    folder_suggestion_dismissed INTEGER NOT NULL DEFAULT 0, agent_id TEXT, message_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (chat_id, idx)
  );
  CREATE TABLE deleted_chats (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
`;

describe("chats.db migration", () => {
  test("an old-schema chats.db gains the kind columns and keeps every chat as it was", () => {
    const path = join(tmp("rye-kinds-old-"), "chats.db");
    const old = new Database(path);
    old.exec(OLD_SCHEMA);
    old.query("INSERT INTO chats (id, title, session_id, updated_at, folder_id, agent_id, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)").run("a", "Alpha", "s-a", 100, "f1", null, 2);
    old.query("INSERT INTO chats (id, title, session_id, updated_at, message_count) VALUES (?, ?, ?, ?, ?)").run("b", "Beta", "s-b", 200, 1);
    const msg = (chat: string, idx: number, role: string, content: string) =>
      old.query("INSERT INTO messages (chat_id, idx, role, text, hash, data) VALUES (?, ?, ?, ?, ?, ?)").run(chat, idx, role, content, `h${idx}`, JSON.stringify({ role, content }));
    msg("a", 0, "user", "hello there");
    msg("a", 1, "assistant", "hi");
    msg("b", 0, "user", "second chat");
    old.query("INSERT INTO deleted_chats (id, deleted_at) VALUES ('gone', 1)").run();
    old.close();

    const store = new ChatStore(path, null, null);
    const cols = (new Database(path).query("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("kind");
    expect(cols).toContain("parent_chat_id");
    expect(store.summaries().map((s) => [s.id, s.title, s.kind, s.folderId, s.messageCount])).toEqual([
      ["b", "Beta", undefined, undefined, 1],
      ["a", "Alpha", undefined, "f1", 2],
    ]);
    expect(store.get("a")!.messages).toEqual([{ role: "user", content: "hello there" }, { role: "assistant", content: "hi" }]);
    expect(store.isDeleted("gone")).toBe(true);
    store.close();
    // Opening again is a no-op.
    const again = new ChatStore(path, null, null);
    expect(again.count()).toBe(2);
    again.close();
  });

  test("kind fields are server-owned: client saves keep them and can't set them; code chat messages are the server's", () => {
    const store = new ChatStore(join(tmp("rye-kinds-own-"), "chats.db"), null, null);
    store.createKindChat({ id: "c1", title: "Fix it", sessionId: "cs_1", messages: [], updatedAt: 10 }, { kind: "code", parentChatId: "p1" });
    store.appendMessage("c1", { role: "user", content: "task", id: "t1" });
    // A client PUT (with or without messages) keeps the kind and the server's messages.
    store.upsert({ id: "c1", title: "Renamed", sessionId: "cs_1", updatedAt: 20, kind: "chat", messages: [{ role: "user", content: "overwritten?" }] });
    store.upsertMany([{ id: "c1", title: "Renamed again", sessionId: "cs_1", updatedAt: 30, messages: [] }]);
    const c1 = store.get("c1")!;
    expect(c1.kind).toBe("code");
    expect(c1.parentChatId).toBe("p1");
    expect(c1.title).toBe("Renamed again");
    expect(c1.messages).toEqual([{ role: "user", content: "task", id: "t1" }]);
    expect(store.summaries()[0]).toMatchObject({ id: "c1", kind: "code", parentChatId: "p1" });
    // A client can't create a chat of another kind.
    store.upsert({ id: "c2", title: "Sneaky", sessionId: "s", updatedAt: 1, kind: "code", messages: [] });
    expect(store.get("c2")!.kind).toBeUndefined();
    // Plain chats are saved exactly as before.
    store.upsert({ id: "c3", title: "Plain", sessionId: "s3", updatedAt: 1, messages: [{ role: "user", content: "a" }] });
    store.upsert({ id: "c3", title: "Plain", sessionId: "s3", updatedAt: 2, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
    expect(store.get("c3")!.messages).toHaveLength(2);
    store.close();
  });
});

const script: FakeScript = async function* (ctx) {
  yield { type: "text", delta: `echo: ${ctx.options.input.text.split("\n")[0]}` };
  writeFileSync(join(ctx.options.workspace.repoDir, "out.txt"), "x\n");
  yield { type: "done", reason: "end" };
};

describe("POST /chat/ dispatch by kind", () => {
  function setup() {
    const h = codeHarness(script);
    const kinds = new ChatKindRegistry();
    kinds.register(codeChatKind({ enabled: () => true, runner: () => h.runner }));
    h.chats.onRemoveKind = (chat) => kinds.onRemove(chat);
    const app = new Hono();
    app.post("/chat/", async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      const handled = await kindChatTurn(c, h.chats, kinds, body, () => null);
      return handled ?? c.json({ path: "normal chat" });
    });
    const send = (body: unknown) => app.request("/chat/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { h, kinds, send };
  }

  test("normal chats are untouched: no chat_id, a plain chat, an unknown id", async () => {
    const { h, kinds, send } = setup();
    h.chats.upsert({ id: "plain", title: "Plain", sessionId: "s1", updatedAt: 1, messages: [] });
    expect(kinds.forChat(h.chats, undefined)).toBeNull();
    expect(kinds.forChat(h.chats, "plain")).toBeNull();
    expect(kinds.forChat(h.chats, "nope")).toBeNull();
    for (const body of [{ message: "hi" }, { message: "hi", chat_id: "plain" }, { message: "hi", chat_id: "nope" }, { message: "hi", chat_id: 42 }]) {
      expect(await (await send(body)).json()).toEqual({ path: "normal chat" });
    }
    expect(h.chats.get("plain")!.messages).toEqual([]);
  });

  test("a code chat's message starts a turn and streams it; the server stores the user message", async () => {
    const { h, send } = setup();
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "first" });
    await h.runner.idle(session.id);
    const res = await send({ message: "second", chat_id: chatId, session_id: session.id, turn_id: "turn-2" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text(); // ends with the turn
    const events = text.split("\n\n").filter((f) => f.includes("data: ")).map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
    expect(events[0]).toEqual({ type: "session", session_id: session.id });
    expect(events.map((e) => e.type)).toContain("token");
    expect(events.at(-1).type).toBe("done");
    expect(events.find((e) => e.type === "token").content).toBe("echo: second");
    expect(text).toMatch(/^id: \d+$/m);
    const users = h.chats.get(chatId)!.messages as Array<{ role: string; content: string; id: string }>;
    expect(users.map((m) => [m.content, m.id])).toEqual([["first", expect.any(String)], ["second", "turn-2"]]);
  }, TIMEOUT);

  test("a quote the user pointed at reaches the engine in the turn's context and stays on the user message", async () => {
    const { h, send } = setup();
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "first" });
    await h.runner.idle(session.id);
    const quote = { type: "quote", text: "export const said = 1;", source: { kind: "diff", label: "new.ts", path: "src/new.ts", lines: { start: 1, end: 1 }, side: "new" } };
    const res = await send({ message: "why this?", chat_id: chatId, turn_id: "turn-q", references: [quote, { type: "sop", id: 3 }] });
    await res.text();
    const input = h.engine.runs.at(-1)!.options.input.text;
    expect(input.startsWith("why this?")).toBe(true);
    expect(input).toContain("<rye_context>");
    expect(input).toContain("The user pointed at this excerpt (new.ts, new side, line 1):");
    expect(input).toContain("```\nexport const said = 1;\n```");
    const last = h.chats.get(chatId)!.messages.at(-1) as { id: string; content: string; references?: unknown[] };
    expect(last).toMatchObject({ id: "turn-q", content: "why this?", references: [quote] });
    // A wrong shape is refused before the turn starts.
    const bad = await send({ message: "x", chat_id: chatId, references: [{ type: "quote", text: "x", source: { kind: "nope", label: "a" } }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid");
  }, TIMEOUT);

  test("refusals come back as { error, code } before any stream", async () => {
    const { h, send } = setup();
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "first" });
    await h.runner.idle(session.id);
    await h.runner.archive(session.id);
    const res = await send({ message: "more", chat_id: chatId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.any(String), code: "archived" });
    const off = new ChatKindRegistry();
    off.register(codeChatKind({ enabled: () => false, runner: () => h.runner }));
    const app = new Hono();
    app.post("/chat/", async (c) => (await kindChatTurn(c, h.chats, off, await c.req.json(), () => null)) ?? c.json({}));
    const r2 = await app.request("/chat/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x", chat_id: chatId }) });
    expect(r2.status).toBe(404);
  }, TIMEOUT);

  test("deleting a code chat archives its session; the work stays", async () => {
    const { h } = setup();
    const { session, chatId } = await h.runner.create({ repo: "demo", task: "keep" });
    await h.runner.idle(session.id);
    expect(h.chats.remove(chatId)).toBe(true);
    await Bun.sleep(0);
    for (let i = 0; i < 200 && h.store.get(session.id)!.status !== "archived"; i++) await Bun.sleep(20);
    expect(h.store.get(session.id)!.status).toBe("archived");
    expect((await h.runner.snapshots(session.id)).snapshots.length).toBeGreaterThan(0);
  }, TIMEOUT);
});
