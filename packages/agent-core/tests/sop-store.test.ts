/**
 * Unit tests for the SOP store (bun:sqlite, no Ollama required).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { SOPStore } from "../src/sop/store.js";

let store: SOPStore;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `rye-sop-test-${Date.now()}.db`);
  store = new SOPStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

describe("SOPStore", () => {
  test("save and get a SOP", async () => {
    const id = await store.save({
      title: "Restart failing service",
      description: "How to recover when the API pod crashes",
      content: "1. Check pod logs\n2. Restart deployment",
      steps: ["Check pod logs", "Restart deployment"],
      tags: ["kubernetes", "ops"],
    });
    expect(id).toBeGreaterThan(0);

    const sop = store.get(id);
    expect(sop).not.toBeNull();
    expect(sop!.title).toBe("Restart failing service");
    expect(sop!.tags).toContain("kubernetes");
    expect(sop!.steps).toHaveLength(2);
  });

  test("list returns saved SOPs in descending order", async () => {
    await store.save({ title: "SOP A", content: "content A" });
    await store.save({ title: "SOP B", content: "content B" });
    const list = store.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Most recently inserted should come first
    expect(list[0].title).toBe("SOP B");
  });

  test("delete removes a SOP", async () => {
    const id = await store.save({ title: "Temp SOP", content: "temp content" });
    const deleted = store.delete(id);
    expect(deleted).toBe(true);
    expect(store.get(id)).toBeNull();
  });

  test("delete returns false for nonexistent id", () => {
    expect(store.delete(99999)).toBe(false);
  });

  test("search falls back to LIKE when no embeddings (no Ollama)", async () => {
    await store.save({ title: "Database connection pooling", content: "Use pg_bouncer to pool connections." });
    await store.save({ title: "Redis cache invalidation", content: "Flush specific cache keys with SCAN." });

    const results = await store.search("database");
    // At least the database SOP should come back
    expect(results.some((s) => s.title.toLowerCase().includes("database"))).toBe(true);
  });

  test("get returns null for nonexistent id", () => {
    expect(store.get(99999)).toBeNull();
  });
});
