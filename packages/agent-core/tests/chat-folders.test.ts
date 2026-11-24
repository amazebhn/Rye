import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/chat/store.js";
import { ChatFolderStore } from "../src/chat/folders.js";
import { chatFolderRoutes } from "../src/chat/folder-routes.js";
import { chatExcerpt, parseAssignments, parseProposal, type CompleteFn } from "../src/chat/categorize.js";

const root = join(homedir(), ".cache", `rye-folder-test-${crypto.randomUUID()}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup(complete?: CompleteFn) {
  const dir = join(root, crypto.randomUUID());
  const chats = new ChatStore(join(dir, "chats.json"));
  const folders = new ChatFolderStore(join(dir, "chat-folders.json"));
  const app = chatFolderRoutes(chats, folders, { complete, timeoutMs: 1000 });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { dir, chats, folders, call };
}

function chat(id: string, title = id, firstMessage = `question about ${id}`) {
  return { id, title, sessionId: `s-${id}`, messages: [{ role: "user", content: firstMessage }], updatedAt: 1 };
}

describe("ChatFolderStore", () => {
  test("creates, renames and persists folders with case-insensitive unique names", () => {
    const { dir, folders } = setup();
    const infra = folders.create("  Infra  ");
    expect(infra.name).toBe("Infra");
    expect(() => folders.create("infra")).toThrow(/already exists/);
    const db = folders.create("Databases");
    expect(() => folders.update(db.id, { name: "INFRA" })).toThrow(/already exists/);
    expect(folders.update(db.id, { name: "DB" }).name).toBe("DB");
    expect(folders.update(infra.id, { name: "infra" }).name).toBe("infra");
    expect(new ChatFolderStore(join(dir, "chat-folders.json")).list().map((f) => f.name)).toEqual(["infra", "DB"]);
  });

  test("rejects empty, long and control-character names", () => {
    const { folders } = setup();
    expect(() => folders.create("   ")).toThrow();
    expect(() => folders.create("x".repeat(61))).toThrow();
    expect(() => folders.create("bad\u0000name")).toThrow();
    expect(() => folders.create(42)).toThrow();
  });
});

describe("ChatStore folder fields", () => {
  test("client upserts cannot change folder fields", () => {
    const { chats } = setup();
    chats.upsert(chat("a"));
    chats.setFolderFields(["a"], { folderId: "f1" });
    chats.upsert({ ...chat("a", "renamed"), folderId: undefined, folderSuggestionDismissed: true });
    expect(chats.get("a")).toMatchObject({ title: "renamed", folderId: "f1" });
    expect(chats.get("a")?.folderSuggestionDismissed).toBeUndefined();
  });

  test("no chat is dropped for being old, filed or not", () => {
    const { chats } = setup();
    chats.upsert({ ...chat("old"), updatedAt: 0 });
    chats.setFolderFields(["old"], { folderId: "f1" });
    for (let i = 0; i < 55; i++) chats.upsert({ ...chat(`c${i}`), updatedAt: 10 + i });
    expect(chats.get("old")?.folderId).toBe("f1");
    expect(chats.list().filter((c) => !c.folderId)).toHaveLength(55);
  });
});

describe("folder routes", () => {
  test("create, move, rename and delete (deleting unfiles, never deletes chats)", async () => {
    const { chats, call } = setup();
    chats.upsert(chat("a"));
    chats.upsert(chat("b"));

    const created = await call("POST", "/folders", { name: "Incidents" });
    expect(created.status).toBe(201);
    const folder = (await created.json()) as { id: string };
    expect((await call("POST", "/folders", { name: "incidents" })).status).toBe(409);

    const moved = await call("POST", "/folders/move", { chat_ids: ["a", "b", "missing"], folder_id: folder.id });
    expect(((await moved.json()) as { moved: string[] }).moved.sort()).toEqual(["a", "b"]);
    expect(chats.get("a")?.folderId).toBe(folder.id);
    await call("POST", "/folders/move", { chat_ids: ["b"], folder_id: null });
    expect(chats.get("b")).toMatchObject({ folderSuggestionDismissed: true });
    expect(chats.get("b")?.folderId).toBeUndefined();
    await call("POST", "/folders/move", { chat_ids: ["b"], folder_id: folder.id });

    expect((await call("PATCH", `/folders/${folder.id}`, { name: "Outages" })).status).toBe(200);
    expect(((await (await call("GET", "/folders")).json()) as { name: string }[])[0].name).toBe("Outages");

    const removed = await call("DELETE", `/folders/${folder.id}`);
    expect(await removed.json()).toMatchObject({ status: "deleted", unfiled: 2 });
    expect(chats.list()).toHaveLength(2);
    expect(chats.get("a")?.folderId).toBeUndefined();
  });

  test("validates ids and bodies", async () => {
    const { chats, call } = setup();
    chats.upsert(chat("a"));
    expect((await call("POST", "/folders/move", { chat_ids: ["a"], folder_id: "nope" })).status).toBe(400);
    expect((await call("POST", "/folders/move", { chat_ids: ["../etc"], folder_id: null })).status).toBe(400);
    expect((await call("POST", "/folders/move", { chat_ids: [], folder_id: null })).status).toBe(400);
    expect((await call("PATCH", "/folders/..%2Fx", { name: "x" })).status).toBe(400);
    expect((await call("DELETE", "/folders/unknown")).status).toBe(404);
    expect((await call("POST", "/folders", { name: "" })).status).toBe(400);
    expect((await call("POST", "/folders/dismiss", { chat_ids: ["a"] })).status).toBe(200);
    expect(chats.get("a")?.folderSuggestionDismissed).toBe(true);
  });
});

describe("categorize", () => {
  test("parseAssignments keeps only valid folder numbers", () => {
    const reply = 'Sure! {"assignments": {"1": 2, "2": null, "3": 7, "4": "1", "9": 1, "x": 1}}';
    expect(parseAssignments(reply, 4, 2)).toEqual([1, null, null, null]);
    expect(parseAssignments("not json", 2, 2)).toEqual([null, null]);
  });

  test("parseProposal caps names, drops unused ones and maps case-insensitively", () => {
    const names = Array.from({ length: 12 }, (_, i) => `Topic ${i}`);
    const reply = JSON.stringify({ folders: ["Kafka", "kafka", ...names], assignments: { "1": "KAFKA", "2": "Unknown", "3": "Topic 0" } });
    const result = parseProposal(reply, 3, ["Existing"]);
    expect(result.assignments).toEqual(["Kafka", null, "Topic 0"]);
    expect(result.folders).toEqual(["Existing", "Kafka", "Topic 0"]);
  });

  test("parseProposal drops catch-all folders and leaves their chats unfiled", () => {
    const reply = JSON.stringify({ folders: ["Kafka", "Misc", "Other"], assignments: { "1": "Kafka", "2": "Misc", "3": "other" } });
    const result = parseProposal(reply, 3, []);
    expect(result.assignments).toEqual(["Kafka", null, null]);
    expect(result.folders).toEqual(["Kafka"]);
  });

  test("chatExcerpt uses the first user messages, capped", () => {
    const excerpt = chatExcerpt([
      { role: "assistant", content: "hi" },
      { role: "user", content: "first\n\nline" },
      { role: "user", kind: "answer", content: "Yes" },
      { role: "user", content: "x".repeat(1000) },
    ]);
    expect(excerpt.startsWith("first line / x")).toBe(true);
    expect(excerpt.length).toBe(300);
  });

  test("endpoint maps model picks to real folder ids and only sends titles and excerpts", async () => {
    let prompt = "";
    const { chats, folders, call } = setup(async (_system, p) => {
      prompt = p;
      return '{"assignments": {"1": 2, "2": 5}}';
    });
    const kafka = folders.create("Kafka");
    const mysql = folders.create("MySQL");
    chats.upsert(chat("a", "Replica lag", "why is replica lag high"));
    chats.upsert(chat("b", "Lunch"));
    chats.upsert(chat("c"));
    chats.setFolderFields(["c"], { folderId: kafka.id });

    const res = await call("POST", "/categorize", { chat_ids: ["a", "b", "c"] });
    expect(await res.json()).toEqual({
      suggestions: [
        { chat_id: "a", folder_id: mysql.id },
        { chat_id: "b", folder_id: null },
      ],
    });
    expect(prompt).toContain("Replica lag");
    expect(prompt).toContain("why is replica lag high");
    expect(prompt).not.toContain("s-a");
  });

  test("model failure or timeout returns no suggestions quietly", async () => {
    const { chats, folders, call } = setup((_s, _p, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    folders.create("Kafka");
    chats.upsert(chat("a"));
    const res = await call("POST", "/categorize", { chat_ids: ["a"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [], failed: true });
  });

  test("propose mode only when no folders exist", async () => {
    const { chats, call } = setup(async () => '{"folders": ["Kafka"], "assignments": {"1": "Kafka"}}');
    chats.upsert(chat("a"));
    const res = await call("POST", "/categorize", { chat_ids: ["a"], propose: true, proposed: ["Bad\u0000", "Infra"] });
    expect(await res.json()).toEqual({
      new_folders: ["Infra", "Kafka"],
      suggestions: [{ chat_id: "a", folder_name: "Kafka" }],
    });
  });
});
