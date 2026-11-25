import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as artifacts from "../src/artifacts/store.js";
import * as results from "../src/results/store.js";
import { ResultExportError, saveResultAsArtifact } from "../src/tools/artifacts.js";

const root = mkdtempSync(join(tmpdir(), "rye-result-export-test-"));

beforeAll(() => {
  artifacts.setArtifactsRoot(join(root, "artifacts"));
  results.setResultsRoot(join(root, "results"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const latestText = (a: artifacts.Artifact) => artifacts.readArtifactSource(a)?.content;

describe("saving a stored result as a file", () => {
  test("writes quoted CSV with a header, named from the query's table", () => {
    const stored = results.saveResult({
      sessionId: "chat-a",
      source: "sql_query_tool",
      label: "SELECT id, note FROM public.orders WHERE status = 'failed'",
      kind: "table",
      columns: ["id", "note"],
      rows: [{ id: 1, note: 'said "hi", then left' }, { id: 2, note: null }, { id: 3, note: "line\nbreak" }],
    });
    const saved = saveResultAsArtifact(stored.id, "chat-a");
    expect(saved.existing).toBe(false);
    expect(saved.artifact.format).toBe("csv");
    expect(saved.artifact.filename).toBe(`orders-${stored.id.slice(4)}.csv`);
    expect(saved.artifact.title).toBe("SELECT id, note FROM public.orders WHERE status = 'failed'");
    expect(latestText(saved.artifact)).toBe('id,note\r\n1,"said ""hi"", then left"\r\n2,\r\n3,"line\nbreak"\r\n');
    expect(artifacts.listArtifacts("chat-a").map((a) => a.id)).toEqual([saved.artifact.id]);
  });

  test("text results become one column", () => {
    const stored = results.saveTextResult("cloudwatch_logs_tool", '{"group":"/app"}', "first line\nsecond, with comma", "chat-a");
    const saved = saveResultAsArtifact(stored.id, "chat-a");
    expect(saved.artifact.filename).toBe(`cloudwatch_logs-${stored.id.slice(4)}.csv`);
    expect(latestText(saved.artifact)).toBe('line\r\nfirst line\r\n"second, with comma"\r\n');
  });

  test("saving the same result again returns the existing file", () => {
    const stored = results.saveResult({ sessionId: "chat-a", source: "sql_query_tool", label: "select 1", kind: "table", columns: ["x"], rows: [{ x: 1 }] });
    const first = saveResultAsArtifact(stored.id, "chat-a");
    const again = saveResultAsArtifact(stored.id, "chat-a");
    expect(again.existing).toBe(true);
    expect(again.artifact.id).toBe(first.artifact.id);
    expect(again.version.version).toBe(1);
  });

  test("refuses a result from another chat, or one that doesn't exist", () => {
    const stored = results.saveResult({ sessionId: "chat-b", source: "sql_query_tool", label: "q", kind: "table", columns: ["x"], rows: [{ x: 1 }] });
    expect(() => saveResultAsArtifact(stored.id, "chat-a")).toThrow(ResultExportError);
    expect(() => saveResultAsArtifact("res_00000000", "chat-a")).toThrow("may have expired");
    expect(artifacts.listArtifacts("chat-b")).toEqual([]);
  });

  test("refuses a result over the file size limit", () => {
    const big = "x".repeat(1024 * 1024);
    const stored = results.saveResult({
      sessionId: "chat-c",
      source: "sql_query_tool",
      label: "select * from huge",
      kind: "table",
      columns: ["blob"],
      rows: Array.from({ length: 6 }, () => ({ blob: big })),
    });
    let error: unknown;
    try {
      saveResultAsArtifact(stored.id, "chat-c");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ResultExportError);
    expect((error as ResultExportError).status).toBe(413);
    expect((error as Error).message).toContain("limit");
    expect(artifacts.listArtifacts("chat-c")).toEqual([]);
  });
});

describe("listing results", () => {
  test("lists a chat's results newest first with when they expire", () => {
    const older = results.saveResult({ sessionId: "chat-d", source: "s", label: "older", kind: "table", columns: ["a"], rows: [{ a: 1 }] });
    const newer = { ...results.saveTextResult("s", "newer", "a\nb\nc", "chat-d") };
    const listed = results.listResults("chat-d");
    expect(listed.map((r) => r.id).sort()).toEqual([older.id, newer.id].sort());
    const text = listed.find((r) => r.id === newer.id)!;
    expect(text.rowCount).toBe(3);
    expect(text.kind).toBe("text");
    expect(text.expiresAt - Date.now()).toBeGreaterThan(results.RESULT_RETENTION_MS - 60_000);
    expect(results.listResults("chat-nobody")).toEqual([]);
  });
});
