import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatStore } from "../src/chat/store.js";

const files: string[] = [];

function temporaryStore(): { path: string; store: ChatStore } {
  const path = join(tmpdir(), `rye-chat-test-${crypto.randomUUID()}.json`);
  files.push(path);
  return { path, store: new ChatStore(path) };
}

afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

describe("ChatStore pending prompts", () => {
  test("persists a pending confirmation across store reloads", () => {
    const { path, store } = temporaryStore();
    const saved = store.upsert({
      id: "chat-1",
      title: "MCP request",
      sessionId: "session-1",
      messages: [],
      updatedAt: 1,
      pendingPrompt: {
        id: "prompt-1",
        type: "choice",
        question: "Allow this tool?",
        options: ["Allow once", "Deny"],
      },
    });

    expect(saved?.pendingPrompt?.id).toBe("prompt-1");
    expect(new ChatStore(path).list()[0].pendingPrompt).toEqual(saved?.pendingPrompt);
  });

  test("drops malformed pending prompt data", () => {
    const { store } = temporaryStore();
    const saved = store.upsert({
      id: "chat-1",
      title: "Invalid prompt",
      sessionId: "session-1",
      messages: [],
      updatedAt: 1,
      pendingPrompt: {
        id: "prompt-1",
        type: "unsupported",
        question: "Ignore me",
      },
    });

    expect(saved?.pendingPrompt).toBeUndefined();
  });
});

describe("ChatStore deletion tombstones", () => {
  test("rejects a stale upsert after chat deletion", () => {
    const { store } = temporaryStore();
    const record = {
      id: "chat-1",
      title: "Query results",
      sessionId: "session-1",
      messages: [],
      updatedAt: 1,
    };

    expect(store.upsert(record)?.id).toBe("chat-1");
    expect(store.remove("chat-1")).toBe(true);
    expect(store.isDeleted("chat-1")).toBe(true);
    expect(store.upsert({ ...record, updatedAt: 2 })).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test("tombstones an unknown chat so an in-flight first upsert is rejected", () => {
    const { store } = temporaryStore();

    expect(store.remove("chat-new")).toBe(false);
    expect(store.upsert({
      id: "chat-new",
      title: "Still running",
      sessionId: "session-new",
      messages: [],
      updatedAt: 1,
    })).toBeNull();
  });
});