import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import * as store from "../src/artifacts/store.js";
import * as tools from "../src/tools/artifacts.js";
import * as docx from "../src/artifacts/docx.js";
import * as trim from "../src/agent/trim.js";

const dataDir = mkdtempSync(join(tmpdir(), "rye-artifacts-test-"));
store.setArtifactsRoot(dataDir);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const marker = (text: string) => text.match(/\[rye:artifact:(art_[a-f0-9]{8}):v(\d+)\]/);

describe("artifact store", () => {
  test("slugs names and rejects empty ones", () => {
    expect(store.artifactFilename("Incident Handoff.md", "md")).toBe("incident-handoff.md");
    expect(store.artifactFilename("  orders/2024 ", "csv")).toBe("orders-2024.csv");
    expect(() => store.artifactFilename("../..", "md")).toThrow();
  });

  test("same filename in a session adds versions; other sessions are isolated", () => {
    const first = store.saveArtifact({ sessionId: "s1", filename: "notes.md", title: "Notes", format: "md", content: "one" });
    const second = store.saveArtifact({ sessionId: "s1", filename: "notes.md", title: "Notes", format: "md", content: "two" });
    const other = store.saveArtifact({ sessionId: "s2", filename: "notes.md", title: "Notes", format: "md", content: "x" });
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(second.version.version).toBe(2);
    expect(other.artifact.id).not.toBe(first.artifact.id);
    const meta = store.getArtifact(first.artifact.id, "s1")!;
    expect(store.readArtifactSource(meta)?.content).toBe("two");
    expect(store.readArtifactSource(meta, 1)?.content).toBe("one");
    expect(store.getArtifact(first.artifact.id, "s2")).toBeNull();
    expect(store.getArtifact("../../etc", "s1")).toBeNull();
  });

  test("caps prior versions and keeps the latest", () => {
    for (let i = 0; i < 15; i++) store.saveArtifact({ sessionId: "s3", filename: "big.txt", title: "t", format: "txt", content: `v${i}` });
    const meta = store.findArtifactByFilename("s3", "big.txt")!;
    expect(meta.versions.length).toBe(10);
    expect(meta.versions.at(-1)?.version).toBe(15);
    expect(store.readArtifactSource(meta, 1)).toBeNull();
    expect(store.readArtifactSource(meta)?.content).toBe("v14");
  });

  test("deleteArtifactsForSession removes only that session", () => {
    store.saveArtifact({ sessionId: "gone", filename: "a.md", title: "a", format: "md", content: "a" });
    expect(store.deleteArtifactsForSession("gone")).toBe(1);
    expect(store.listArtifacts("gone")).toEqual([]);
    expect(store.listArtifacts("s1").length).toBe(1);
  });
});

describe("artifact tools", () => {
  test("write returns a marker and read returns the content", () => {
    const out = tools.writeArtifact({ name: "Handoff", format: "md", content: "# Hi" }, "t1");
    expect(out).toContain("handoff.md");
    expect(marker(out)?.[2]).toBe("1");
    expect(tools.readArtifact({ name: "handoff" }, "t1")).toContain("# Hi");
    expect(tools.readArtifact({}, "t1")).toContain("handoff.md");
  });

  test("saves html pages", () => {
    const out = tools.writeArtifact({ name: "Error Dashboard", format: "html", content: "<!doctype html><h1>Hi</h1>" }, "t1");
    expect(out).toContain("error-dashboard.html");
    expect(tools.readArtifact({ name: "error-dashboard.html" }, "t1")).toContain("<h1>Hi</h1>");
  });

  test("validates input", () => {
    expect(tools.writeArtifact({ name: "x", format: "exe", content: "a" }, "t1")).toStartWith("Error");
    expect(tools.writeArtifact({ name: "x", format: "json", content: "{nope" }, "t1")).toStartWith("Error");
    expect(tools.writeArtifact({ name: "x", format: "md" }, "t1")).toStartWith("Error");
    expect(tools.writeArtifact({ name: "x", format: "md", content: "a" }, undefined)).toStartWith("Error");
  });

  test("csv cells are quoted", () => {
    expect(tools.rowsToCsv(["a", "b"], [{ a: 'say "hi"', b: "x,y" }, { a: null, b: 1 }])).toBe('a,b\r\n"say ""hi""","x,y"\r\n,1\r\n');
  });
});

describe("docx conversion", () => {
  test("produces a zip for typical markdown", async () => {
    const md = "# Title\n\nSome **bold** and `code` with [a link](https://example.com).\n\n- one\n  - nested\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sql\nSELECT 1;\n```\n\n> quoted\n\n---\n";
    const buf = await docx.markdownToDocx(md, "Title");
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });
});

describe("context trimming", () => {
  test("drops the body of earlier write_artifact_tool calls", () => {
    const call: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "write_artifact_tool", arguments: { name: "h", format: "md", content: "x".repeat(5000) } }],
      api: "openai-completions",
      provider: "p",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    };
    const messages: Message[] = [
      { role: "user", content: "write it", timestamp: 0 },
      call,
      { role: "toolResult", toolCallId: "c1", toolName: "write_artifact_tool", content: [{ type: "text", text: "Saved" }], isError: false, timestamp: 0 },
      { ...call, content: [{ type: "text", text: "done" }] },
    ];
    const out = trim.shrinkOldToolResults(messages);
    const block = (out[1] as AssistantMessage).content[0];
    expect(block.type === "toolCall" && String(block.arguments.content)).toContain("read_artifact_tool");
    expect((call.content[0] as { arguments: { content: string } }).arguments.content.length).toBe(5000);
  });
});
