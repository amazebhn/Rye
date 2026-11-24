import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDistinctive, parseQuery, requiredTerms, searchChats, snippetAround } from "../src/chat/search.js";
import { ChatStore, type ChatHistoryRecord } from "../src/chat/store.js";
import { readChatForAgent, searchChatsForAgent } from "../src/tools/chats.js";

const chat = (id: string, title: string, updatedAt: number, messages: Array<[string, string]>): ChatHistoryRecord => ({
  id,
  title,
  sessionId: `sess-${id}`,
  updatedAt,
  messages: messages.map(([role, content]) => ({ role, content })),
});

const chats = [
  chat("c1", "Replication lag on orders-db", 300, [
    ["user", "Why is the mysql replica lagging in prod?"],
    ["assistant", "Replication lag on mysql-ro-01 peaked at 94 seconds. The cause was a long ALTER TABLE on orders."],
    ["user", "ok thanks"],
  ]),
  chat("c2", "Checkout 504s", 200, [
    ["user", "checkout is returning 504 for PAY-1234"],
    ["assistant", "The payments service timed out calling Stripe. Lag was not a factor."],
  ]),
  chat("c3", "Weekly summary", 100, [["user", "summarise this week"], ["assistant", "Nothing notable."]]),
];

describe("chat search", () => {
  test("parses words and quoted phrases", () => {
    expect(parseQuery('  Replication "ALTER  table"  lag lag ')).toEqual(["replication", "alter table", "lag"]);
    expect(parseQuery("   ")).toEqual([]);
  });

  test("partial words match while typing", () => {
    expect(searchChats(chats, "repl").map((h) => h.chatId)).toEqual(["c1"]);
    expect(searchChats(chats, "lag").map((h) => h.chatId)).toEqual(["c1", "c2"]);
    expect(searchChats(chats, "")).toEqual([]);
  });

  test("chats with every term come first; chats with most of them follow and say what they lack", () => {
    expect([1, 2, 3, 4, 5, 6].map(requiredTerms)).toEqual([1, 1, 2, 3, 3, 4]);
    // Both terms in c2, only "lag" in c1.
    const two = searchChats(chats, "lag stripe");
    expect(two.map((h) => [h.chatId, h.missing])).toEqual([["c2", undefined], ["c1", ["stripe"]]]);
    // No chat has "kubernetes": the ones with "lag" are still worth showing.
    expect(searchChats(chats, "lag kubernetes").map((h) => [h.chatId, h.missing])).toEqual([["c1", ["kubernetes"]], ["c2", ["kubernetes"]]]);
    // Three terms need two: c1 has replication + lag, c2 only lag.
    expect(searchChats(chats, "replication lag kubernetes").map((h) => h.chatId)).toEqual(["c1"]);
    // A newer partial match never jumps ahead of an older full one.
    const newer = [{ ...chats[0], updatedAt: 999 }, chats[1]];
    expect(searchChats(newer, "lag stripe").map((h) => h.chatId)).toEqual(["c2", "c1"]);
  });

  test("a partial match can't rest on filler words alone", () => {
    expect(isDistinctive("the")).toBe(false);
    expect(isDistinctive("lag")).toBe(true);
    // "the" is in nearly every chat; on its own it says nothing about kubernetes.
    expect(searchChats(chats, "the kubernetes")).toEqual([]);
    // A single filler word typed alone is still searched for as written.
    expect(searchChats(chats, "was").length).toBeGreaterThan(0);
  });

  test("finds identifiers, reports which messages matched, and ranks the best message first", () => {
    const [hit] = searchChats(chats, "PAY-1234");
    expect(hit).toMatchObject({ chatId: "c2", title: "Checkout 504s", titleMatch: false, matchCount: 1 });
    expect(hit.matches).toEqual([{ index: 0, role: "user", snippet: "checkout is returning 504 for PAY-1234" }]);

    const [lag] = searchChats(chats, "replication lag");
    expect(lag.titleMatch).toBe(true);
    // The reply has both words together; the question has neither.
    expect(lag.matches[0].index).toBe(1);
  });

  test("a term found only in the title still counts toward the match", () => {
    expect(searchChats(chats, "orders-db peaked").map((h) => h.chatId)).toEqual(["c1"]);
  });

  test("quoted phrases must appear as written", () => {
    expect(searchChats(chats, '"alter table"').map((h) => h.chatId)).toEqual(["c1"]);
    expect(searchChats(chats, '"table alter"')).toEqual([]);
  });

  test("limits results and can leave a chat out", () => {
    expect(searchChats(chats, "lag", { limit: 1 }).length).toBe(1);
    expect(searchChats(chats, "lag", { excludeSessionId: "sess-c1" }).map((h) => h.chatId)).toEqual(["c2"]);
  });

  test("snippets centre on the match and mark where text was cut", () => {
    const text = `${"filler ".repeat(40)}the needle is here ${"more ".repeat(60)}`;
    const snippet = snippetAround(text, ["needle"]);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("the needle is here");
    expect(snippet.length).toBeLessThan(230);
    // Excerpts are plain text.
    expect(snippetAround("## Cause\n- Lag on `mysql-ro-01` peaked at **94 seconds**.", ["lag"])).toBe("Cause Lag on mysql-ro-01 peaked at 94 seconds.");
  });
});

describe("chat tools for the agent", () => {
  const withStore = (fn: (store: ChatStore) => void | Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "rye-chat-search-test-"));
    try {
      const store = new ChatStore(join(dir, "chats.db"));
      store.upsertMany(chats);
      await fn(store);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test(
    "search lists matching chats with ids and excerpts, skipping the chat it is called from",
    withStore(async (store) => {
      const out = await searchChatsForAgent(store, { query: "lag" }, "sess-c2");
      expect(out).toContain("chat_id: c1");
      expect(out).toContain("message 1 (Rye): Replication lag on mysql-ro-01");
      expect(out).not.toContain("chat_id: c2");
      expect(await searchChatsForAgent(store, { query: "kubernetes" })).toContain("No earlier conversations match");
    }),
  );

  test(
    "read returns the conversation text, or says the id is unknown",
    withStore((store) => {
      const out = readChatForAgent(store, { chat_id: "c1", message: 1 });
      expect(out).toContain("## Replication lag on orders-db");
      expect(out).toContain("**User** (message 0):\nWhy is the mysql replica lagging in prod?");
      expect(out).toContain("**Rye** (message 1):");
      expect(readChatForAgent(store, { chat_id: "nope" })).toContain('No conversation with id "nope"');
    }),
  );
});
