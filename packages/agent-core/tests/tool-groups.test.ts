import { describe, expect, test } from "bun:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { TOOLS } from "../src/tools/index.js";
import {
  CORE_GROUP,
  LOAD_TOOLS_TOOL_NAME,
  buildToolGroups,
  defaultToolGroupSelector,
  groupsUsedInHistory,
  resolveGroupNames,
  toolsForExactGroups,
  toolsForGroups,
} from "../src/tools/groups.js";

const mcpTool: Tool = { name: "mcp__grafana__query_dashboard", description: "x", parameters: {} as never };
const groups = buildToolGroups([...TOOLS, mcpTool]);
const optional = groups.filter((g) => g.id !== CORE_GROUP);

const select = (userMessage: string, extra: Partial<Parameters<typeof defaultToolGroupSelector>[0]> = {}) =>
  defaultToolGroupSelector({ userMessage, history: [], availableGroups: optional, previouslyEnabled: [], ...extra });

describe("toolsForExactGroups", () => {
  const names = (enabled: string[]) => toolsForExactGroups(groups, enabled).map((t) => t.name);

  test("a low-context agent gets only the groups picked for it", () => {
    expect(names([])).toEqual([]);
    expect(names(["jira"])).toEqual(["jira_ticket_tool"]);
    // Unlike toolsForGroups, core is not added automatically.
    expect(toolsForGroups(groups, ["jira"]).map((t) => t.name)).toContain("ask_user_tool");
  });

  test("core can be picked, but never brings load_tools_tool", () => {
    const core = names([CORE_GROUP]);
    expect(core).toContain("ask_user_tool");
    expect(core).not.toContain(LOAD_TOOLS_TOOL_NAME);
  });
});

describe("buildToolGroups", () => {
  test("every tool lands in exactly one group, plus load_tools_tool in core", () => {
    const names = groups.flatMap((g) => g.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(TOOLS.length + 2);
    const core = groups.find((g) => g.id === CORE_GROUP)!.tools.map((t) => t.name);
    expect(core).toContain(LOAD_TOOLS_TOOL_NAME);
    expect(core).toContain("ask_user_tool");
    expect(core).not.toContain("mysql_query_tool");
  });

  test("MCP servers get their own group", () => {
    expect(groups.find((g) => g.id === "mcp:grafana")?.tools).toEqual([mcpTool]);
  });

  test("toolsForGroups sends core plus enabled only", () => {
    const names = toolsForGroups(groups, ["jira"]).map((t) => t.name);
    expect(names).toContain("jira_ticket_tool");
    expect(names).not.toContain("mysql_query_tool");
  });
});

describe("resolveGroupNames", () => {
  test("accepts group ids, bare MCP server names and tool names", () => {
    const { enabled, unknown } = resolveGroupNames(groups, ["MySQL", "grafana", "git_log_tool", "nope"]);
    // "MySQL" is the SQL group's former name and still resolves to it.
    expect(enabled.sort()).toEqual(["git", "mcp:grafana", "sql"]);
    expect(unknown).toEqual(["nope"]);
  });
});

describe("defaultToolGroupSelector", () => {
  test("no keywords means core only", async () => {
    expect(await select("hello there")).toEqual([]);
  });

  test("keyword matches", async () => {
    expect(await select("run a sql query on the orders table")).toContain("sql");
    expect(await select("check the postgres replica")).toContain("sql");
    expect(await select("check cloudwatch for the payments ecs service")).toContain("aws");
    expect(await select("look at PAY-1234")).toContain("jira");
    expect(await select("which commit touched this branch")).toContain("git");
    expect(await select("check the grafana dashboard")).toContain("mcp:grafana");
    expect(await select("at com.acme.Foo.bar(Foo.java:42)")).toContain("code_search");
  });

  test("references to earlier conversations enable the chats group", async () => {
    expect(await select("what did we decide last time about the orders table")).toContain("chats");
    expect(await select("find that in a previous chat")).toContain("chats");
    expect(await select("we already looked into the replica lag, what was the cause?")).toContain("chats");
    expect(await select("why is checkout slow right now")).not.toContain("chats");
  });

  test("asking for code changes enables the code group", async () => {
    expect(groups.find((g) => g.id === "code")?.tools.map((t) => t.name)).toEqual(["start_code_session_tool", "code_session_status_tool"]);
    expect(await select("implement retries in the search client")).toContain("code");
    expect(await select("can you fix it in the code and open a branch")).toContain("code");
    expect(await select("refactor the chat store")).toContain("code");
    expect(await select("how is [rye:code-session:cs_123] doing?")).toContain("code");
    expect(await select("why is checkout slow right now")).not.toContain("code");
    expect(resolveGroupNames(groups, ["code"]).enabled).toEqual(["code"]);
  });

  test("keeps previously enabled groups and drops unknown ones", async () => {
    expect((await select("thanks", { previouslyEnabled: ["aws", "gone"] }))).toEqual(["aws"]);
  });

  test("tool names in the mode suffix enable their group", async () => {
    expect(await select("tighten step 3", { systemPromptSuffix: "call save_sop_tool with id=4" })).toContain("sop_authoring");
  });

  test("stored results in history enable the results group", async () => {
    const history: Message[] = [
      { role: "toolResult", toolCallId: "a", toolName: "x", content: [{ type: "text", text: "stored as `res_a1b2c3d4`" }], isError: false, timestamp: 0 },
    ];
    expect(await select("show me more", { history })).toContain("results");
  });
});

describe("groupsUsedInHistory", () => {
  test("collects called tools and load_tools_tool requests", () => {
    const history = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "1", name: "jira_ticket_tool", arguments: {} },
          { type: "toolCall", id: "2", name: LOAD_TOOLS_TOOL_NAME, arguments: { groups: ["aws"] } },
          { type: "toolCall", id: "3", name: "remember_tool", arguments: {} },
        ],
      },
    ] as unknown as Message[];
    expect(groupsUsedInHistory(history, groups).sort()).toEqual(["aws", "jira"]);
  });
});
