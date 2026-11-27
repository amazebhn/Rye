import { describe, expect, test } from "bun:test";
import type { Tool } from "@earendil-works/pi-ai";
import { getSettings, settingsForEnv, type Settings } from "../src/config.js";
import { buildToolGroups } from "../src/tools/groups.js";
import { TOOLS } from "../src/tools/index.js";
import { groupAvailability, toolGroupReport, type AvailabilityInput, type McpServerState } from "../src/tools/availability.js";

// Every field the report reads is set here, so whatever the developer's own config.toml holds doesn't matter.
const loaded = getSettings();
const settings: Settings = {
  ...loaded,
  aws: { region: "us-east-1" },
  mysql: { host: "localhost", port: 3306, user: "root", password: "", database: "" },
  databases: {
    orders: { type: "postgres", host: "pg.staging.internal", password: "hunter2", database: "orders", description: "Orders service" },
  },
  jira: { url: "", email: "", api_token: "", project_keys: [] },
  environments: {
    staging: {
      name: "Staging",
      aws: { profile: "staging-ro", region: "eu-west-1" },
      jira: { url: "https://jira.example", email: "me@example.com", api_token: "jira-token-xyz", project_keys: ["OPS"] },
    },
    prod: {
      name: "Production",
      aws: { access_key_id: "AKIA_SECRET_ID", secret_access_key: "very-secret" },
      databases: {
        orders: { host: "pg.prod.internal", password_env: "RYE_TEST_ORDERS_PW" },
        billing: { type: "mysql", url: "mysql://ro:pw@my.prod.internal:3307/billing" },
        broken: { type: "postgres" },
      },
    },
  },
};

const input = (envKey: string, extra: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  settings: settingsForEnv(settings, envKey === "default" ? null : envKey),
  envKey,
  repos: [],
  mcpServers: [],
  processEnv: {},
  ...extra,
});

describe("tool availability per environment", () => {
  test("SQL lists the environment's own connections, usable and misconfigured", () => {
    const def = groupAvailability("sql", input("default"));
    expect(def.state).toBe("ready");
    expect(def.items).toEqual([{ name: "orders", state: "ready", detail: "PostgreSQL · database orders · Orders service" }]);

    const prod = groupAvailability("sql", input("prod"));
    expect(prod.state).toBe("partial");
    expect(prod.items?.map((i) => [i.name, i.state])).toEqual([
      ["billing", "ready"],
      ["orders", "off"],
      ["broken", "off"],
    ]);
    expect(prod.items?.find((i) => i.name === "orders")?.detail).toContain("RYE_TEST_ORDERS_PW");

    // With the password variable set, the prod orders connection works again.
    expect(groupAvailability("sql", input("prod", { processEnv: { RYE_TEST_ORDERS_PW: "x" } })).items?.find((i) => i.name === "orders")?.state).toBe("ready");
  });

  test("SQL with no connections at all is off", () => {
    const none = { ...settings, databases: {}, mysql: { ...settings.mysql, database: "" } };
    // The legacy [mysql] section stands in when nothing else is configured, as the SQL tools do.
    expect(groupAvailability("sql", { ...input("default"), settings: none }).items?.map((i) => i.name)).toEqual(["mysql"]);
    const onlyBroken = { ...settings, databases: { broken: { type: "postgres" as const } } };
    const result = groupAvailability("sql", { ...input("default"), settings: onlyBroken });
    expect(result.state).toBe("off");
    expect(result.reason).toContain("no host");
  });

  test("never reports hosts, passwords or keys", () => {
    for (const env of ["default", "staging", "prod"]) {
      const text = JSON.stringify(toolGroupReport(buildToolGroups(TOOLS), input(env)));
      for (const secret of ["pg.staging.internal", "pg.prod.internal", "my.prod.internal", "hunter2", "AKIA_SECRET_ID", "very-secret", "jira-token-xyz","jira.example", "me@example.com", ":pw@"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  test("AWS, Jira, code search and git follow the environment's settings", () => {
    expect(groupAvailability("aws", input("default"))).toMatchObject({ state: "partial", reason: expect.stringContaining('SSO profile "default"') });
    expect(groupAvailability("aws", input("staging"))).toMatchObject({ state: "ready", reason: 'SSO profile "staging-ro", region eu-west-1.' });
    expect(groupAvailability("aws", input("prod"))).toMatchObject({ state: "ready", reason: "Access key, region us-east-1." });

    expect(groupAvailability("jira", input("default")).state).toBe("off");
    expect(groupAvailability("jira", input("staging"))).toEqual({ state: "ready", reason: "Configured; projects OPS." });

    expect(groupAvailability("code_search", input("prod")).state).toBe("off");
    expect(groupAvailability("git", input("prod")).state).toBe("partial");
    const repos = [{ name: "api" }, { name: "web" }];
    expect(groupAvailability("code_search", input("prod", { repos })).reason).toContain("2 repositories searchable: api, web");
    expect(groupAvailability("git", input("prod", { repos })).state).toBe("ready");

    // Groups that need no setup.
    for (const id of ["core", "results", "chats", "artifacts"]) expect(groupAvailability(id, input("prod")).state).toBe("ready");
  });

  test("code sessions: off without allowed repos or when disabled, ready with repos that exist, the same in every environment", () => {
    const withCode = (code: Partial<Settings["code"]>): AvailabilityInput => ({ ...input("prod"), settings: { ...settings, code: { ...settings.code, enabled: true, repos: [], ...code } } });
    expect(groupAvailability("code", withCode({}))).toMatchObject({ state: "off", reason: expect.stringContaining("[[code.repos]]") });
    const here = { name: "rye", path: process.cwd().replace(/\/packages\/agent-core$/, ""), isolation: "clone" as const, setup: [], checks: [], base: "main" };
    const gone = { name: "gone", path: "/nonexistent/repo", isolation: "clone" as const, setup: [], checks: [] };
    expect(groupAvailability("code", withCode({ repos: [here], enabled: false })).state).toBe("off");
    expect(groupAvailability("code", withCode({ repos: [gone] })).state).toBe("off");
    const partial = groupAvailability("code", withCode({ repos: [here, gone] }));
    expect(partial.state).toBe("partial");
    expect(partial.items?.map((i) => [i.name, i.state])).toEqual([["rye", "ready"], ["gone", "off"]]);
    expect(groupAvailability("code", withCode({ repos: [here] }))).toMatchObject({ state: "ready", reason: "1 repository: rye." });
  });

  test("MCP servers: connected, off, failing, waiting for sign-in, and listed even without tools", () => {
    const servers: McpServerState[] = [
      { name: "grafana", disabled: false, connected: true, toolCount: 1, problems: [] },
      { name: "github", disabled: true, connected: false, toolCount: 0, problems: [] },
      { name: "sentry", disabled: false, connected: false, toolCount: 0, problems: [], error: "spawn sentry-mcp ENOENT" },
      { name: "linear", disabled: false, connected: false, toolCount: 0, problems: [], authRequired: true },
    ];
    const mcpTool: Tool = { name: "mcp__grafana__query_dashboard", description: "Query a dashboard. Returns panels.", parameters: {} as never };
    const report = toolGroupReport(buildToolGroups([...TOOLS, mcpTool]), input("staging", { mcpServers: servers }));
    const byId = new Map(report.map((g) => [g.id, g]));
    expect(byId.get("mcp:grafana")?.availability.state).toBe("ready");
    expect(byId.get("mcp:grafana")?.tools).toEqual([
      { name: "mcp__grafana__query_dashboard", title: "Query dashboard", description: "Query a dashboard.", detail: "Query a dashboard. Returns panels.", state: "ready" },
    ]);
    expect(byId.get("mcp:grafana")?.title).toBe("MCP · grafana");
    expect(byId.get("mcp:github")?.title).toBe("MCP · github");
    expect(byId.get("sql")?.title).toBe("SQL databases");
    expect(byId.get("mcp:github")).toMatchObject({ tools: [], availability: { state: "off", reason: "Turned off in MCP servers." } });
    expect(byId.get("mcp:sentry")?.availability.reason).toBe("Not connected: spawn sentry-mcp ENOENT");
    expect(byId.get("mcp:linear")?.availability.reason).toContain("sign-in");
  });

  test("every tool carries its group's state and its whole description; load_tools_tool is left out", () => {
    const report = toolGroupReport(buildToolGroups(TOOLS), input("default"));
    const tools = report.flatMap((g) => g.tools.map((t) => ({ ...t, group: g })));
    expect(tools.some((t) => t.name === "load_tools_tool")).toBe(false);
    for (const t of tools) expect(t.state).toBe(t.group.availability.state);
    const sql = tools.find((t) => t.name === "sql_query_tool")!;
    expect(sql.detail.length).toBeGreaterThanOrEqual(sql.description.length);
    expect(report.find((g) => g.id === "core")?.description).toBe("always available");
  });

  test("an unknown environment key leaves the base settings as they are", () => {
    expect(settingsForEnv(settings, "nope")).toBe(settings);
    expect(settingsForEnv(settings, null)).toBe(settings);
  });
});
