import { describe, expect, test } from "bun:test";
import { parseContextRefs, referencesForModel } from "../src/agent/references.js";
import type { ToolGroup } from "../src/tools/groups.js";

const groups = [
  { id: "core", description: "always loaded", tools: [{ name: "ask_user_tool" }] },
  { id: "sql", description: "SQL", tools: [{ name: "sql_query_tool" }, { name: "sql_schema_tool" }] },
] as unknown as ToolGroup[];
const sops = {
  get: (id: number) => (id === 7 ? { id: 7, title: "Replica lag runbook", content: "1. Check the IO thread.\n2. Kill long transactions." } : null),
} as never;

describe("SOPs and tools picked for a message", () => {
  test("requests are validated", () => {
    expect(parseContextRefs(undefined)).toEqual([]);
    expect(parseContextRefs([{ type: "sop", id: 7 }, { type: "tool", name: "sql_query_tool" }])).toHaveLength(2);
    expect(parseContextRefs([{ type: "sop", id: "7" }])).toBeNull();
    expect(parseContextRefs([{ type: "tool", name: "rm -rf /" }])).toBeNull();
    expect(parseContextRefs([{ type: "skill", name: "x" }])).toBeNull();
    expect(parseContextRefs(new Array(11).fill({ type: "sop", id: 1 }))).toBeNull();
  });

  test("an SOP's content is given to follow; a tool's group is loaded and its use asked for", () => {
    const out = referencesForModel([{ type: "sop", id: 7 }, { type: "tool", name: "sql_query_tool" }], { sops, toolGroups: groups });
    expect(out.groups).toEqual(["sql"]);
    expect(out.note).toContain('SOP [id 7] "Replica lag runbook"');
    expect(out.note).toContain("Kill long transactions");
    expect(out.note).toContain("asked you to use `sql_query_tool`");
  });

  test("an SOP or tool that's gone is named as missing", () => {
    const out = referencesForModel([{ type: "sop", id: 99 }, { type: "tool", name: "nope_tool" }], { sops, toolGroups: groups });
    expect(out.groups).toEqual([]);
    expect(out.note).toContain("SOP 99, which no longer exists");
    expect(out.note).toContain("`nope_tool`, which isn't available");
  });
});
