import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATED_ID_KEY, legacyIdToName, markerPath, migrateLegacySkills } from "../src/skill/migrate.js";
import { cleanupTmp, makeFixture, writeSkill } from "./skill-test-utils.js";

afterAll(cleanupTmp);

type Row = { title: string; description?: string | null; content?: string | null; updated_at?: string | null };

function legacyDb(dir: string, rows: Row[]): string {
  const path = join(dir, "knowledge.db");
  const db = new Database(path);
  db.run("CREATE TABLE skills (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, content TEXT, updated_at TEXT)");
  const ins = db.prepare("INSERT INTO skills (title, description, content, updated_at) VALUES (?, ?, ?, ?)");
  for (const r of rows) ins.run(r.title, r.description ?? null, r.content ?? null, r.updated_at ?? "2024-01-02 03:04:05");
  db.close();
  return path;
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("migrateLegacySkills", () => {
  test("copies rows into Rye-owned folders and writes the marker", () => {
    const { store, rye, base } = makeFixture();
    const db = legacyDb(base, [
      { title: "Restart Service", description: "When it crashes", content: "# Steps\n1. restart" },
      { title: "Check: Disk", description: "Disk full", content: "du -sh" },
    ]);
    const res = migrateLegacySkills(store, db);
    expect(res).toEqual({ status: "migrated", migrated: 2 });
    expect(existsSync(markerPath(store))).toBe(true);

    const names = store.list().map((s) => s.name).sort();
    expect(names).toEqual(["check-disk", "restart-service"]);
    const s = store.get("restart-service")!;
    expect(s).toMatchObject({ source: "rye", editable: true, description: "When it crashes", title: "Restart Service" });
    expect(s.body).toBe("# Steps\n1. restart\n");
    expect(s.frontmatter[MIGRATED_ID_KEY]).toBe(1);
    expect(readdirSync(rye).sort()).toEqual([".migrated-from-db.json", "check-disk", "restart-service"]);
    expect(legacyIdToName(store, 2)).toBe("check-disk");
    expect(legacyIdToName(store, 99)).toBeNull();
  });

  test("is idempotent: a second run creates nothing", () => {
    const { store, base } = makeFixture();
    const db = legacyDb(base, [{ title: "One", content: "a" }, { title: "Two", content: "b" }]);
    migrateLegacySkills(store, db);
    const again = migrateLegacySkills(store, db);
    expect(again).toEqual({ status: "already-done", migrated: 0 });
    expect(store.list()).toHaveLength(2);
  });

  test("still idempotent after new legacy rows appear (marker wins)", () => {
    const { store, base } = makeFixture();
    const db = legacyDb(base, [{ title: "One", content: "a" }]);
    migrateLegacySkills(store, db);
    const conn = new Database(db);
    conn.run("INSERT INTO skills (title, description, content) VALUES ('Late', '', 'x')");
    conn.close();
    expect(migrateLegacySkills(store, db).status).toBe("already-done");
    expect(store.list()).toHaveLength(1);
  });

  test("is non-destructive: the database file is byte-identical and rows remain", () => {
    const { store, base } = makeFixture();
    const db = legacyDb(base, [{ title: "Keep Me", content: "x" }]);
    const before = sha(db);
    migrateLegacySkills(store, db);
    expect(sha(db)).toBe(before);
    const conn = new Database(db, { readonly: true });
    expect((conn.prepare("SELECT count(*) AS n FROM skills").get() as { n: number }).n).toBe(1);
    conn.close();
  });

  test("duplicate titles and clashes with existing skills get unique slugs", () => {
    const { store, ext, base } = makeFixture();
    writeSkill(ext, "deploy", { description: "installed" });
    const db = legacyDb(base, [
      { title: "Deploy", content: "1" },
      { title: "Deploy", content: "2" },
      { title: "deploy", content: "3" },
      { title: "Install", content: "reserved" },
    ]);
    expect(migrateLegacySkills(store, db).migrated).toBe(4);
    const names = store.list().map((s) => s.name).sort();
    expect(names).toEqual(["deploy", "deploy-2", "deploy-3", "deploy-4", "install-2"]);
    expect(store.summary("deploy")!.source).toBe("installed"); // never shadowed/overwritten
  });

  test("blank titles, null fields and odd content survive", () => {
    const { store, base } = makeFixture();
    const db = legacyDb(base, [
      { title: "   ", content: null, description: null },
      { title: "Frontmatter-looking", content: "---\nnot: frontmatter\n---\nbody" },
    ]);
    expect(migrateLegacySkills(store, db).migrated).toBe(2);
    expect(store.get("skill-1")!.body).toBe("\n");
    expect(store.get("skill-1")!.title).toBe("Skill 1");
    expect(store.get("frontmatter-looking")!.body).toBe("---\nnot: frontmatter\n---\nbody\n");
  });

  test("resumes an interrupted run without duplicating", () => {
    const { store, base } = makeFixture();
    const db = legacyDb(base, [{ title: "First", content: "a" }, { title: "Second", content: "b" }]);
    // Row 1 was written before a crash: it carries its legacy id but there is no marker yet.
    store.create({ title: "First", content: "a", extras: { [MIGRATED_ID_KEY]: 1 } });
    const res = migrateLegacySkills(store, db);
    expect(res).toEqual({ status: "migrated", migrated: 1 });
    expect(store.list().map((s) => s.name).sort()).toEqual(["first", "second"]);
    expect(legacyIdToName(store, 1)).toBe("first");
  });

  test("updated_at becomes the SKILL.md mtime (recent first)", () => {
    const { store, base } = makeFixture();
    const db = legacyDb(base, [
      { title: "Old", content: "a", updated_at: "2020-01-01 00:00:00" },
      { title: "New", content: "b", updated_at: "2025-06-01 00:00:00" },
    ]);
    migrateLegacySkills(store, db);
    expect(store.list().map((s) => s.name)).toEqual(["new", "old"]);
  });

  test("missing database or table migrates nothing but still records completion", () => {
    const a = makeFixture();
    expect(migrateLegacySkills(a.store, join(a.base, "nope.db"))).toEqual({ status: "migrated", migrated: 0 });
    expect(existsSync(markerPath(a.store))).toBe(true);

    const b = makeFixture();
    const path = join(b.base, "other.db");
    const conn = new Database(path);
    conn.run("CREATE TABLE sops (id INTEGER)");
    conn.close();
    expect(migrateLegacySkills(b.store, path)).toEqual({ status: "migrated", migrated: 0 });
  });

  test("a corrupt database reports failure and writes no marker", () => {
    const { store, base } = makeFixture();
    const path = join(base, "bad.db");
    writeFileSync(path, "this is not a sqlite database at all, just text".repeat(50));
    const res = migrateLegacySkills(store, path);
    expect(res.status).toBe("failed");
    expect(existsSync(markerPath(store))).toBe(false);
  });
});
