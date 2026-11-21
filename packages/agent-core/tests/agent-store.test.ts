import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, slugifyAgentName } from "../src/agents/store.js";
import { ChatStore } from "../src/chat/store.js";
import { pickAutoRoutedAgent, pickFollowUpAgent } from "../src/agents/router.js";
import { chattinessPolicy, readAgentSettings, writeAgentSettings } from "../src/agents/settings.js";

function withTempDir(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "rye-agent-store-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("AgentStore", () => {
  test("slugifyAgentName normalizes names and strips @", () => {
    expect(slugifyAgentName("Database Specialist")).toBe("database-specialist");
    expect(slugifyAgentName("@Payments_Ops")).toBe("payments_ops");
  });

  test(
    "creates, updates, deduplicates slugs, resolves @mentions, and deletes agents",
    withTempDir((dir) => {
      const store = new AgentStore(join(dir, "agents.db"));
      try {
        const db = store.create({
          name: "Database Specialist",
          description: "MySQL and query tuning",
          instructions: "Always inspect EXPLAIN plans before recommending indexes.",
          avatar: { kind: "gradient", value: "ocean" },
          tool_groups: ["mysql", "results"],
        });
        expect(db.slug).toBe("database-specialist");
        expect(db.avatar).toEqual({ kind: "gradient", value: "ocean" });
        expect(db.tool_groups).toEqual(["mysql", "results"]);

        // Duplicate name gets a unique slug suffix
        const db2 = store.create({
          name: "Database Specialist",
          instructions: "Second DB helper.",
        });
        expect(db2.slug).toBe("database-specialist-2");

        // Update slug and model
        const updated = store.update(db.id, { slug: "db", model: "claude-sonnet-4.6" });
        expect(updated?.slug).toBe("db");
        expect(updated?.model).toBe("claude-sonnet-4.6");

        // Mention resolution
        const hits = store.resolveMentions("Hey @db and @unknown, can you check slow queries? Also @db again.");
        expect(hits.map((a) => a.id)).toEqual([db.id]);

        // Delete
        expect(store.delete(db2.id)).toBe(true);
        expect(store.list().map((a) => a.id)).toEqual([db.id]);
      } finally {
        store.close();
      }
    }),
  );

  test(
    "ChatStore preserves agentId and exempts agent chats from the 50-chat unfiled cap",
    withTempDir((dir) => {
      const chatStore = new ChatStore(join(dir, "chats.json"));
      const agentChat = {
        id: "chat_agt_1234",
        title: "DB Specialist",
        sessionId: "sess-1",
        messages: [],
        updatedAt: 1, // oldest timestamp
        agentId: "agt_1234",
      };
      const regularChats = Array.from({ length: 55 }, (_, i) => ({
        id: `chat_reg_${i}`,
        title: `Regular ${i}`,
        sessionId: `sess-reg-${i}`,
        messages: [],
        updatedAt: 1000 + i,
      }));

      const saved = chatStore.replace([agentChat, ...regularChats]);
      expect(saved.some((c) => c.id === "chat_agt_1234" && c.agentId === "agt_1234")).toBe(true);
      // 50 regular + 1 agent chat = 51
      expect(saved.length).toBe(51);
    }),
  );

  test(
    "AgentRouter auto-routes and enforces chattiness thresholds & hop limits",
    withTempDir((dir) => {
      const settingsPath = join(dir, "agent-settings.json");
      expect(readAgentSettings(settingsPath)).toEqual({
        autoRoute: false,
        allowAgentReplies: false,
        chattiness: "low",
      });
      const updated = writeAgentSettings(
        { autoRoute: true, allowAgentReplies: true, chattiness: "medium" },
        settingsPath,
      );
      expect(updated.chattiness).toBe("medium");
      expect(chattinessPolicy("low").maxHops).toBe(1);
      expect(chattinessPolicy("medium").maxHops).toBe(2);
      expect(chattinessPolicy("high").maxHops).toBe(4);
    }),
  );

  test(
    "pickAutoRoutedAgent and pickFollowUpAgent respect confidence thresholds and exclude last speaker",
    withTempDir(async (dir) => {
      const store = new AgentStore(join(dir, "agents.db"));
      try {
        const db = store.create({ name: "DB", description: "MySQL specialist", instructions: "Check MySQL." });
        const aws = store.create({ name: "AWS", description: "CloudWatch & ECS", instructions: "Check AWS." });
        const agents = [db, aws];

        // High-confidence auto-route picks db
        const picked = await pickAutoRoutedAgent({
          message: "Why is mysql replication lagging?",
          recentTurns: [],
          agents,
          decideFn: async () => ({
            responder: { type: "choice", choice: "db", confidence: 0.9, probabilities: { db: 0.9, rye: 0.1 } },
          }),
        });
        expect(picked?.id).toBe(db.id);

        // Low-confidence falls back to null (Rye)
        const lowConf = await pickAutoRoutedAgent({
          message: "hello",
          recentTurns: [],
          agents,
          decideFn: async () => ({
            responder: { type: "choice", choice: "db", confidence: 0.4, probabilities: { db: 0.4, rye: 0.6 } },
          }),
        });
        expect(lowConf).toBeNull();

        // Follow-up agent excludes lastSpeakerId and respects chattiness threshold
        const follow = await pickFollowUpAgent({
          recentTurns: [{ role: "assistant", speaker: "DB", content: "RDS CPU is 99%." }],
          lastSpeakerId: db.id,
          agents,
          chattiness: "medium",
          hopIndex: 0,
          decideFn: async (_state, questions) => {
            // Confirm DB was excluded from criteria
            expect("db" in (questions.next_speaker as { criteria: Record<string, unknown> }).criteria).toBe(false);
            return {
              next_speaker: { type: "choice", choice: "aws", confidence: 0.72, probabilities: { aws: 0.72, none: 0.28 } },
            };
          },
        });
        expect(follow?.id).toBe(aws.id);

        // Exceeding maxHops stops immediately
        const overLimit = await pickFollowUpAgent({
          recentTurns: [],
          lastSpeakerId: db.id,
          agents,
          chattiness: "low",
          hopIndex: 1,
          decideFn: async () => {
            throw new Error("should not be called");
          },
        });
        expect(overLimit).toBeNull();
      } finally {
        store.close();
      }
    }),
  );
});
