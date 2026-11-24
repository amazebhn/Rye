import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatStore, migrateLegacyChats } from "../src/chat/store.js";
import { editDistance, stem, typoBudget } from "../src/chat/search.js";

const files: string[] = [];

function temporaryStore(): { path: string; store: ChatStore } {
  const path = join(tmpdir(), `rye-chat-test-${crypto.randomUUID()}.db`);
  // SQLite keeps its write-ahead log beside the database.
  files.push(path, `${path}-wal`, `${path}-shm`);
  return { path, store: new ChatStore(path) };
}

afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

function withTempDir(fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "rye-chat-store-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const sample = (id: string, updatedAt: number, messages: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  title: `Chat ${id}`,
  sessionId: `sess-${id}`,
  updatedAt,
  messages,
  ...extra,
});

describe("ChatStore in SQLite", () => {
  test("round-trips a chat exactly, including messages that aren't plain text", () => {
    const { path, store } = temporaryStore();
    const messages = [
      { role: "user", content: "why is checkout slow?", kind: undefined },
      { role: "assistant", content: "Looking.", toolCalls: [{ name: "mysql_query_tool", args: { sql: "select 1" }, result: "1" }], meta: { startedAt: 5 } },
      { role: "assistant", content: "", turns: [{ thinking: "hm", toolCalls: [] }] },
      null,
    ];
    store.upsert(sample("a", 10, messages, { model: "sonnet", env: "prod", unread: true, agentId: "agt_1" }));
    store.close();

    const reopened = new ChatStore(path);
    const chat = reopened.get("a");
    expect(chat).toMatchObject({ id: "a", title: "Chat a", sessionId: "sess-a", updatedAt: 10, model: "sonnet", env: "prod", unread: true, agentId: "agt_1" });
    // What comes back is what JSON would have kept.
    expect(chat?.messages).toEqual(JSON.parse(JSON.stringify(messages)));
    expect(reopened.getBySession("sess-a")?.id).toBe("a");
    expect(reopened.summaries()).toMatchObject([{ id: "a", messageCount: 4 }]);
  });

  test("saving again rewrites only what changed, and shrinks when messages are removed", async () => {
    const { store } = temporaryStore();
    const first = [{ role: "user", content: "one" }, { role: "assistant", content: "tw" }];
    store.upsert(sample("a", 1, first));
    store.upsert(sample("a", 2, [first[0], { role: "assistant", content: "two, finished" }, { role: "user", content: "three" }]));
    expect(store.get("a")?.messages).toEqual([first[0], { role: "assistant", content: "two, finished" }, { role: "user", content: "three" }]);
    // The edited reply is found by its new text and no longer by nothing-but-the-old.
    expect((await store.search("finished")).map((h) => h.chatId)).toEqual(["a"]);

    store.upsert(sample("a", 3, [first[0]]));
    expect(store.get("a")?.messages).toEqual([first[0]]);
    expect(await store.search("finished")).toEqual([]);
    expect(await store.search("three")).toEqual([]);
  });

  test("a save without a messages list updates details only and keeps the stored messages", async () => {
    const { store } = temporaryStore();
    const messages = [{ role: "user", content: "keep me" }, { role: "assistant", content: "kept" }];
    store.upsert(sample("a", 1, messages));
    // What a client that never loaded the messages sends for a rename.
    const { messages: _omitted, ...details } = sample("a", 2, [], { title: "Renamed", unread: true });
    const saved = store.upsert(details);
    expect(saved?.messages).toEqual(messages);
    expect(store.get("a")).toMatchObject({ title: "Renamed", unread: true, updatedAt: 2, messages });
    expect((await store.search("keep")).map((h) => h.chatId)).toEqual(["a"]);
    // A malformed list is treated the same way, never as "no messages".
    store.upsert({ ...details, messages: "oops" });
    expect(store.get("a")?.messages).toEqual(messages);
    // An explicit empty list is a real instruction (a chat rewound to nothing).
    store.upsert(sample("a", 3, []));
    expect(store.get("a")?.messages).toEqual([]);
    // For a chat the store has never seen there is nothing to keep.
    expect(store.upsert({ id: "fresh", title: "Fresh", sessionId: "", updatedAt: 1 })?.messages).toEqual([]);
  });

  test("saving several chats never deletes the ones left out", () => {
    const { store } = temporaryStore();
    store.upsertMany([sample("a", 1), sample("b", 2)]);
    store.upsertMany([sample("c", 3)]);
    expect(store.list().map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  test("search uses the index: word starts, identifiers, titles, text inside a word, and removed chats", async () => {
    const { store } = temporaryStore();
    store.upsertMany([
      sample("a", 3, [{ role: "user", content: "Why is the mysql replica lagging?" }, { role: "assistant", content: "Lag on mysql-ro-01 peaked at 94 seconds." }]),
      sample("b", 2, [{ role: "user", content: "checkout returns 504 for PAY-1234" }], { title: "Checkout errors" }),
      sample("c", 1, [{ role: "assistant", content: "Nothing notable.", toolCalls: [{ name: "x", result: "replica output is not searched" }] }]),
    ]);
    expect((await store.search("repl")).map((h) => h.chatId)).toEqual(["a"]);
    expect((await store.search("pay-1234")).map((h) => h.chatId)).toEqual(["b"]);
    expect((await store.search("ro-01 peaked"))[0].matches[0]).toMatchObject({ index: 1, role: "assistant" });
    expect((await store.search("checkout errors")).map((h) => h.chatId)).toEqual(["b"]);
    // Not at the start of a word, so the index misses it and the slower scan finds it.
    expect((await store.search("ysql")).map((h) => h.chatId)).toEqual(["a"]);
    expect(await store.search("lag", { excludeSessionId: "sess-a" })).toEqual([]);
    store.remove("a");
    expect(await store.search("replica")).toEqual([]);
  });
});

describe("fuzzy word search", () => {
  const seed = (store: ChatStore) =>
    store.upsertMany([
      sample("a", 3, [{ role: "user", content: "the replica lag is growing" }, { role: "assistant", content: "Replication stalled on a long query against the orders table." }]),
      sample("b", 2, [{ role: "user", content: "we are caching sessions in redis" }], { title: "Deploying the cache" }),
      sample("c", 1, [{ role: "assistant", content: "Nothing notable this week." }]),
    ]);

  test("stems and edit distance behave as described", () => {
    expect(["lagging", "lagged", "lags", "lag"].map(stem)).toEqual(["lag", "lag", "lag", "lag"]);
    expect(["queries", "query", "caching", "cached", "cache", "tables", "deploying"].map(stem)).toEqual(["query", "query", "cach", "cach", "cach", "tabl", "deploy"]);
    // Short words and ones that only look plural are left alone.
    expect(["bus", "status", "class", "its"].map(stem)).toEqual(["bus", "status", "class", "its"]);
    expect(editDistance("replcation", "replication")).toBe(1);
    expect(editDistance("repilcation", "replication")).toBe(1); // two letters swapped
    expect(editDistance("lag", "log")).toBe(1);
    expect(editDistance("orders", "payments")).toBe(3); // capped at max + 1
    expect([typoBudget("lag"), typoBudget("redis"), typoBudget("replication")]).toEqual([0, 1, 2]);
  });

  test("other forms of a word match in both directions, and say which text matched", async () => {
    const { store } = temporaryStore();
    seed(store);
    // The search word is longer than what was written...
    const lagging = await store.search("lagging");
    expect(lagging.map((h) => h.chatId)).toEqual(["a"]);
    expect(lagging[0].matches[0]).toMatchObject({ index: 0, matched: ["lag"] });
    expect(lagging[0].matches[0].snippet).toContain("replica lag");
    // ...or shorter, or a different ending.
    expect((await store.search("queries")).map((h) => h.chatId)).toEqual(["a"]);
    expect((await store.search("cached session")).map((h) => h.chatId)).toEqual(["b"]);
    // In a title too.
    expect((await store.search("deployed")).map((h) => [h.chatId, h.titleMatch])).toEqual([["b", true]]);
    // A word found as written has nothing extra to report.
    expect((await store.search("replica"))[0].matches[0].matched).toBeUndefined();
  });

  test("a misspelt word finds what the nearest real spelling would", async () => {
    const { store } = temporaryStore();
    seed(store);
    const typo = await store.search("replcation");
    expect(typo.map((h) => h.chatId)).toEqual(["a"]);
    expect(typo[0].matches[0]).toMatchObject({ index: 1, matched: ["replication"] });
    expect((await store.search("reids sesions")).map((h) => h.chatId)).toEqual(["b"]);
    // A correctly spelt word that exists is never "corrected" to a neighbour.
    expect((await store.search("lag")).map((h) => h.chatId)).toEqual(["a"]);
    // Too far from anything, and short words, are left as they are.
    expect(await store.search("kubernetes")).toEqual([]);
    expect(await store.search("lgg")).toEqual([]);
    // A quoted phrase is exact.
    expect(await store.search('"replica lagging"')).toEqual([]);
  });

  test("the store returns partial matches after full ones, and after chats found by meaning", async () => {
    const { store } = temporaryStore();
    seed(store);
    // "replica" is only in a; "redis" only in b: each has one of the two words.
    const split = await store.search("replica redis");
    expect(split.map((h) => [h.chatId, h.missing])).toEqual([["a", ["redis"]], ["b", ["replica"]]]);
    // "orders" and "table" are both in a; b and c have neither, so they aren't listed.
    expect((await store.search("orders table")).map((h) => [h.chatId, h.missing])).toEqual([["a", undefined]]);
    // Typo correction and partial matching combine: "sesions" is corrected, "kubernetes" is simply missing.
    expect((await store.search("sesions kubernetes")).map((h) => [h.chatId, h.missing])).toEqual([["b", ["kubernetes"]]]);
  });

  test(
    "a database from before is switched to the new index when opened, with every message still findable",
    withTempDir(async (dir) => {
      const path = join(dir, "chats.db");
      const first = new ChatStore(path, null, null);
      seed(first);
      first.close();

      // Put it back the way it was before word roots: the old text index and no vocabulary.
      const raw = new Database(path);
      raw.exec(`
        DROP TABLE messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
        INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
        DELETE FROM words;
        DELETE FROM meta WHERE key = 'search_index';
      `);
      const before = raw.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
      raw.close();

      const reopened = new ChatStore(path, null, null);
      expect(reopened.count()).toBe(3);
      expect((await reopened.search("lagging")).map((h) => h.chatId)).toEqual(["a"]);
      expect((await reopened.search("replcation")).map((h) => h.chatId)).toEqual(["a"]);
      expect((await reopened.search("redis")).map((h) => h.chatId)).toEqual(["b"]);
      reopened.close();

      const check = new Database(path, { readonly: true });
      expect(check.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual(before);
      expect((check.query("SELECT value FROM meta WHERE key = 'search_index'").get() as { value: string }).value).toBe("2");
      expect((check.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
      check.close();
    }),
  );
});

describe("finding messages by meaning", () => {
  // A toy embedder: one axis per topic, so "slow database" is close to "replication lag" without sharing a word.
  const topics: Array<[RegExp, number]> = [
    [/replica|replication|lag|database|db|slow quer/i, 0],
    [/checkout|payment|stripe|charge|billing/i, 1],
    [/deploy|release|rollback|rollout/i, 2],
    [/log ?in|auth|session|password/i, 3],
  ];
  const toy = (text: string): number[] => {
    const v = [0, 0, 0, 0, 0.05];
    for (const [pattern, axis] of topics) if (pattern.test(text)) v[axis] = 1;
    return v;
  };
  let calls = 0;
  const embedders = {
    embedBatch: async (texts: string[]) => {
      calls++;
      return texts.map((t) => ({ vector: toy(t), provider: "ollama" as const, model: "toy" }));
    },
    embedText: async (text: string) => ({ vector: toy(text), provider: "ollama" as const, model: "toy" }),
  };
  const seed = (store: ChatStore) =>
    store.upsertMany([
      sample("db", 5, [{ role: "user", content: "Why is the replica so far behind today?" }, { role: "assistant", content: "Replication lag peaked at 94 seconds." }]),
      sample("pay", 4, [{ role: "user", content: "Stripe charges are failing for some customers" }, { role: "assistant", content: "The payment provider timed out." }]),
      sample("rel", 3, [{ role: "user", content: "How do I do a rollback of the search service?" }, { role: "assistant", content: "Re-run the previous release from the pipeline." }]),
      sample("auth", 2, [{ role: "user", content: "Users can't log in to the admin console" }, { role: "assistant", content: "The session store was full; logins recovered." }]),
      // Too short to mean anything: never offered as related, whatever it happens to sit close to.
      sample("tiny", 1, [{ role: "user", content: "db?" }]),
    ]);
  const open = (dir: string, withEmbedders: typeof embedders | null = embedders) => new ChatStore(join(dir, "chats.db"), null, withEmbedders);

  test(
    "messages are embedded in the background and found by a query that shares no words with them",
    withTempDir(async (dir) => {
      const store = open(dir);
      seed(store);
      expect(store.pendingEmbeddings()).toBe(9);
      // Nothing is embedded yet, so this is the plain word search (and no model call is spent on the query).
      expect(await store.search("slow database")).toEqual([]);

      expect(await store.embedPending()).toBe(9);
      expect(store.pendingEmbeddings()).toBe(0);
      const hits = await store.search("slow database");
      expect(hits.map((h) => h.chatId)).toEqual(["db"]);
      expect(hits[0]).toMatchObject({ related: true, titleMatch: false, matchCount: 2 });
      expect(hits[0].matches[0]).toMatchObject({ related: true });
      expect(hits[0].matches.map((m) => m.index).sort()).toEqual([0, 1]);
      // A query about nothing in the history finds nothing by meaning either.
      expect(await store.search("what is the weather in lisbon")).toEqual([]);
      store.close();
    }),
  );

  test(
    "chats containing the words come first; related chats follow and are marked",
    withTempDir(async (dir) => {
      const store = open(dir);
      seed(store);
      store.upsert(sample("word", 1, [{ role: "user", content: "remind me what billing means here" }]));
      await store.embedPending();
      const hits = await store.search("billing");
      expect(hits.map((h) => [h.chatId, Boolean(h.related)])).toEqual([["word", false], ["pay", true]]);
      // The chat that has the word lists it as an ordinary match, not a second time as related.
      expect(hits[0].matches).toHaveLength(1);
      expect(hits[0].matches[0].related).toBeUndefined();
      expect((await store.search("billing", { excludeSessionId: "sess-pay" })).map((h) => h.chatId)).toEqual(["word"]);
      expect((await store.search("billing", { limit: 1 })).map((h) => h.chatId)).toEqual(["word"]);
      store.close();
    }),
  );

  test(
    "an edited message is embedded again, a removed one is forgotten, and unchanged ones are left alone",
    withTempDir(async (dir) => {
      const store = open(dir);
      seed(store);
      await store.embedPending();
      const before = calls;
      // Same text, different details (as when a reply's metadata is filled in): nothing to re-embed.
      store.upsert(sample("db", 6, [{ role: "user", content: "Why is the replica so far behind today?" }, { role: "assistant", content: "Replication lag peaked at 94 seconds.", meta: { finishedAt: 9 } }]));
      expect(store.pendingEmbeddings()).toBe(0);
      // The reply now talks about something else.
      store.upsert(sample("db", 7, [{ role: "user", content: "Why is the replica so far behind today?" }, { role: "assistant", content: "Actually the deploy caused it; do a rollback." }]));
      expect(store.pendingEmbeddings()).toBe(1);
      expect(await store.embedPending()).toBe(1);
      expect(calls).toBe(before + 1);
      expect((await store.search("how to release safely")).map((h) => h.chatId).sort()).toEqual(["db", "rel"]);

      store.remove("rel");
      expect((await store.search("how to release safely")).map((h) => h.chatId)).toEqual(["db"]);
      store.close();
    }),
  );

  test(
    "without an embedder, or when it is unreachable, search is the word search and nothing breaks",
    withTempDir(async (dir) => {
      const none = open(dir, null);
      seed(none);
      expect(await none.embedPending()).toBe(0);
      expect((await none.search("replica")).map((h) => h.chatId)).toEqual(["db"]);
      expect(await none.search("slow database")).toEqual([]);
      none.close();

      const down = new ChatStore(join(dir, "chats.db"), null, { embedBatch: async () => null, embedText: async () => null });
      expect(await down.embedPending()).toBe(0);
      expect(down.pendingEmbeddings()).toBe(9);
      expect((await down.search("replica")).map((h) => h.chatId)).toEqual(["db"]);
      down.close();
    }),
  );

  test(
    "a different embedding model replaces the old vectors instead of mixing with them",
    withTempDir(async (dir) => {
      const store = open(dir);
      seed(store);
      await store.embedPending();
      store.close();

      const other = {
        embedBatch: async (texts: string[]) => texts.map((t) => ({ vector: [...toy(t), 0, 0], provider: "ollama" as const, model: "toy-v2" })),
        embedText: async (text: string) => ({ vector: [...toy(text), 0, 0], provider: "ollama" as const, model: "toy-v2" }),
      };
      const reopened = new ChatStore(join(dir, "chats.db"), null, other);
      // Old vectors are a different size, so they can't match; a new message triggers the switch.
      expect(await reopened.search("slow database")).toEqual([]);
      reopened.upsert(sample("new", 9, [{ role: "user", content: "another slow database question" }]));
      await reopened.embedPending();
      expect(reopened.pendingEmbeddings()).toBe(0);
      expect((await reopened.search("replication trouble")).map((h) => h.chatId).sort()).toEqual(["db", "new"]);
      reopened.close();
    }),
  );
});

describe("importing the old chats.json", () => {
  const legacy = [
    sample("old1", 100, [{ role: "user", content: "first question" }, { role: "assistant", content: "first answer" }], { folderId: "f1" }),
    sample("old2", 200, [{ role: "user", content: "second question" }], { agentId: "agt_9", pendingPrompt: { id: "p1", type: "yesno", question: "Go?" } }),
    { title: "no id, not a usable chat", messages: [{ role: "user", content: "orphan" }] },
  ];

  test(
    "imports every chat with all its messages, leaves the file untouched, and keeps unusable entries",
    withTempDir(async (dir) => {
      const json = join(dir, "chats.json");
      writeFileSync(json, JSON.stringify(legacy));
      const before = readFileSync(json, "utf8");

      const store = new ChatStore(join(dir, "chats.db"), null);
      const report = migrateLegacyChats(store, json);
      expect(report).toEqual({ status: "imported", found: 2, imported: 2, updated: 0, kept: 0, deleted: 0, rejected: 1 });

      expect(store.get("old1")).toMatchObject({ title: "Chat old1", folderId: "f1", messages: legacy[0].messages });
      expect(store.get("old2")).toMatchObject({ agentId: "agt_9", pendingPrompt: { id: "p1", type: "yesno", question: "Go?" } });
      // old2 has both words; old1 only "question", so it follows as a partial match.
      expect((await store.search("second question")).map((h) => [h.chatId, h.missing])).toEqual([["old2", undefined], ["old1", ["second"]]]);
      // The original is the backup: same bytes, still there.
      expect(readFileSync(json, "utf8")).toBe(before);
      // The entry with no id is kept verbatim rather than thrown away.
      const raw = new Database(join(dir, "chats.db"), { readonly: true });
      expect((raw.query("SELECT raw FROM legacy_rejects").all() as Array<{ raw: string }>).map((r) => JSON.parse(r.raw))).toEqual([legacy[2]]);
      raw.close();
      store.close();
    }),
  );

  test(
    "runs once, and opening the store does it automatically",
    withTempDir((dir) => {
      const json = join(dir, "chats.json");
      writeFileSync(json, JSON.stringify({ chats: legacy.slice(0, 2) }));
      const store = new ChatStore(join(dir, "chats.db"), json);
      expect(store.count()).toBe(2);
      // Work done after the import is not overwritten by importing again.
      store.upsert(sample("old1", 500, [{ role: "user", content: "edited later" }]));
      store.remove("old2");
      expect(migrateLegacyChats(store, json).status).toBe("unchanged");
      store.close();

      const reopened = new ChatStore(join(dir, "chats.db"), json);
      expect(reopened.get("old1")?.messages).toEqual([{ role: "user", content: "edited later" }]);
      expect(reopened.get("old2")).toBeNull();
      reopened.close();
    }),
  );

  test(
    "if the file changes later, newer copies are merged in; newer or deleted chats in the database win",
    withTempDir((dir) => {
      const json = join(dir, "chats.json");
      writeFileSync(json, JSON.stringify(legacy.slice(0, 2)));
      const store = new ChatStore(join(dir, "chats.db"), json);
      store.upsert(sample("old1", 900, [{ role: "user", content: "newer in the database" }]));
      store.setFolderFields(["old2"], { folderId: "f7" });
      store.upsert(sample("gone", 1));
      store.remove("gone");

      writeFileSync(
        json,
        JSON.stringify([
          sample("old1", 150, [{ role: "user", content: "older in the file" }]),
          sample("old2", 300, [{ role: "user", content: "second question" }, { role: "assistant", content: "answered by the older Rye" }]),
          sample("old3", 250, [{ role: "user", content: "made by the older Rye" }]),
          sample("gone", 400),
        ]),
      );
      expect(migrateLegacyChats(store, json)).toEqual({ status: "imported", found: 4, imported: 1, updated: 1, kept: 1, deleted: 1, rejected: 0 });
      expect(store.get("old1")?.messages).toEqual([{ role: "user", content: "newer in the database" }]);
      expect(store.get("old2")?.messages).toHaveLength(2);
      // Folders are assigned in the database, so a refreshed chat stays where it was filed.
      expect(store.get("old2")?.folderId).toBe("f7");
      expect(store.get("old3")).not.toBeNull();
      expect(store.get("gone")).toBeNull();
      store.close();
    }),
  );

  test(
    "an unreadable file changes nothing and is tried again next time",
    withTempDir((dir) => {
      const json = join(dir, "chats.json");
      writeFileSync(json, '[{"id":"a","title":"cut off');
      const store = new ChatStore(join(dir, "chats.db"), null);
      store.upsert(sample("mine", 1));
      const report = migrateLegacyChats(store, json);
      expect(report.status).toBe("failed");
      expect(report.error).toBeTruthy();
      expect(store.list().map((c) => c.id)).toEqual(["mine"]);
      expect(readFileSync(json, "utf8")).toBe('[{"id":"a","title":"cut off');

      // Once the file is repaired the same call imports it.
      writeFileSync(json, JSON.stringify([sample("a", 2)]));
      expect(migrateLegacyChats(store, json)).toMatchObject({ status: "imported", imported: 1 });
      expect(migrateLegacyChats(store, join(dir, "missing.json")).status).toBe("none");
      store.close();
    }),
  );
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