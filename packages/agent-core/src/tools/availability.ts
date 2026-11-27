/**
 * Whether each tool group can do its job in one environment, and why (Settings → Tools).
 *
 * This reads configuration only: it never connects to a database, AWS, Jira or an MCP server.
 * "ready" means the group has what it needs configured; it does not promise that the service
 * answers. Like the agent's own view of databases, it names connections, engines, default
 * databases and descriptions, never hosts or credentials.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../config.js";
import { describeProblems, engineName, listConnections } from "../db/connections.js";
import type { ToolGroup } from "./groups.js";
import { CORE_GROUP, LOAD_TOOLS_TOOL_NAME, MCP_GROUP_PREFIX, SQL_GROUP } from "./groups.js";
import { groupTitle, toolTitle } from "./titles.js";

export type AvailabilityState = "ready" | "partial" | "off";

export interface Availability {
  state: AvailabilityState;
  /** One short sentence for the user. */
  reason: string;
  /** What the group's state is made of, e.g. one line per database connection. */
  items?: Array<{ name: string; state: AvailabilityState; detail: string }>;
}

/** An MCP server as Settings lists it: from mcp.json plus how its connection is doing. */
export interface McpServerState {
  name: string;
  disabled: boolean;
  connected: boolean;
  toolCount: number;
  problems: string[];
  error?: string;
  authRequired?: boolean;
}

export interface AvailabilityInput {
  /** Settings with the environment's overrides already applied (`settingsForEnv`). */
  settings: Settings;
  /** The environment key, or "default" for none. */
  envKey: string;
  /** Repositories code search finds (configured entries and those under repos_root). */
  repos: Array<{ name: string }>;
  mcpServers: McpServerState[];
  /** Process environment, for database `password_env`. */
  processEnv?: NodeJS.ProcessEnv;
}

const MAX_ERROR = 160;

const ready = (reason: string, items?: Availability["items"]): Availability => ({ state: "ready", reason, ...(items ? { items } : {}) });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function sqlAvailability({ settings, processEnv = process.env }: AvailabilityInput): Availability {
  const { connections, problems } = listConnections(settings, processEnv);
  const items: NonNullable<Availability["items"]> = [
    ...connections.map((c) => ({
      name: c.name,
      state: "ready" as const,
      detail: [engineName(c.type), c.database ? `database ${c.database}` : "", c.description].filter(Boolean).join(" · "),
    })),
    ...problems.map((p) => ({ name: p.name, state: "off" as const, detail: p.problem })),
  ];
  if (connections.length === 0) {
    return {
      state: "off",
      reason: problems.length ? `No usable database connection: ${describeProblems(problems)}.` : "No database connections in this environment.",
      ...(items.length ? { items } : {}),
    };
  }
  const names = connections.map((c) => c.name).join(", ");
  if (problems.length) return { state: "partial", reason: `${plural(connections.length, "connection")} (${names}); ${problems.length} misconfigured.`, items };
  return ready(`${plural(connections.length, "connection")}: ${names}.`, items);
}

function awsAvailability({ settings }: AvailabilityInput): Availability {
  const aws = settings.aws;
  if (aws.access_key_id && aws.secret_access_key) return ready(`Access key, region ${aws.region}.`);
  if (aws.access_key_id || aws.secret_access_key) {
    return { state: "partial", reason: `Only half an access key is set (needs both access_key_id and secret_access_key); uses SSO profile "${aws.profile || "default"}", region ${aws.region}.` };
  }
  if (aws.profile) return ready(`SSO profile "${aws.profile}", region ${aws.region}.`);
  return { state: "partial", reason: `No profile or access key set: uses SSO profile "default", region ${aws.region}.` };
}

function jiraAvailability({ settings }: AvailabilityInput): Availability {
  const { url, email, api_token, project_keys } = settings.jira;
  const missing = [!url && "url", !email && "email", !api_token && "api_token"].filter(Boolean);
  if (missing.length === 3) return { state: "off", reason: "Jira is not configured (jira.url, jira.email, jira.api_token)." };
  if (missing.length) return { state: "off", reason: `Jira is missing ${missing.map((m) => `jira.${m}`).join(", ")}.` };
  return ready(project_keys.length ? `Configured; projects ${project_keys.join(", ")}.` : "Configured.");
}

function repoAvailability({ repos }: AvailabilityInput, what: string): Availability {
  if (repos.length === 0) {
    return { state: "off", reason: "No repositories configured (code_search.repos or code_search.repos_root)." };
  }
  const shown = repos.slice(0, 5).map((r) => r.name).join(", ");
  return ready(`${plural(repos.length, "repository", "repositories")} ${what}: ${shown}${repos.length > 5 ? ", …" : ""}.`);
}

function gitAvailability(input: AvailabilityInput): Availability {
  // git log/blame take a repository path per call; the code-search repositories are the ones the agent knows of.
  if (input.repos.length === 0) return { state: "partial", reason: "Works on any local repository path; none are configured for code search, so the agent must be given one." };
  return repoAvailability(input, "known");
}

/**
 * Code sessions: ready when `[code]` allows repos that exist; the sandbox is checked when a session
 * starts (no sandbox, no session). `settingsForEnv` leaves `[code]` alone, so this is the same in
 * every environment.
 */
function codeAvailability({ settings }: AvailabilityInput, exists: (path: string) => boolean = existsSync): Availability {
  const code = settings.code;
  if (!code.enabled) return { state: "off", reason: "Code sessions are turned off ([code] enabled = false)." };
  if (code.repos.length === 0) return { state: "off", reason: "No repositories are allowed for code sessions ([[code.repos]] in config.toml)." };
  const items = code.repos.map((r) => {
    const ok = exists(r.path) && exists(join(r.path, ".git"));
    return { name: r.name, state: ok ? ("ready" as const) : ("off" as const), detail: ok ? `${r.base ? `base ${r.base} · ` : ""}${r.isolation}` : `${r.path} is missing or not a git repository` };
  });
  const usable = items.filter((i) => i.state === "ready");
  if (usable.length === 0) return { state: "off", reason: "None of the allowed repositories can be found.", items };
  if (usable.length < items.length) return { state: "partial", reason: `${plural(usable.length, "repository", "repositories")} usable; ${items.length - usable.length} missing.`, items };
  return ready(`${plural(usable.length, "repository", "repositories")}: ${usable.map((i) => i.name).join(", ")}.`, items);
}

export function mcpAvailability(server: McpServerState | undefined): Availability {
  if (!server) return ready("Connected.");
  if (server.disabled) return { state: "off", reason: "Turned off in MCP servers." };
  if (server.problems.length) return { state: "off", reason: `Invalid definition: ${server.problems.join("; ")}` };
  if (server.authRequired) return { state: "off", reason: "Waiting for sign-in (MCP servers page)." };
  if (!server.connected) {
    const error = server.error ? `: ${server.error.replace(/\s+/g, " ").slice(0, MAX_ERROR)}` : "";
    return { state: "off", reason: `Not connected${error}` };
  }
  return ready("Connected.");
}

/** Availability of one group in the environment `input` describes. */
export function groupAvailability(groupId: string, input: AvailabilityInput): Availability {
  if (groupId.startsWith(MCP_GROUP_PREFIX)) {
    const name = groupId.slice(MCP_GROUP_PREFIX.length);
    return mcpAvailability(input.mcpServers.find((s) => s.name === name));
  }
  switch (groupId) {
    case SQL_GROUP:
      return sqlAvailability(input);
    case "aws":
      return awsAvailability(input);
    case "jira":
      return jiraAvailability(input);
    case "git":
      return gitAvailability(input);
    case "code_search":
      return repoAvailability(input, "searchable");
    case "code":
      return codeAvailability(input);
    case CORE_GROUP:
      return ready("Always loaded.");
    default:
      return ready("Needs no setup.");
  }
}

export interface ToolReport {
  name: string;
  /** Human title ("Run SQL query"); the model keeps using `name`. */
  title: string;
  /** First sentence, as the composer's tool picker shows it. */
  description: string;
  /** The whole description the model sees. */
  detail: string;
  state: AvailabilityState;
}

export interface GroupReport {
  id: string;
  /** Human title ("SQL databases", "MCP · grafana"). */
  title: string;
  description: string;
  tools: ToolReport[];
  availability: Availability;
}

const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0].slice(0, 200);

/**
 * Every group with its availability in one environment. MCP servers that are configured but have
 * no tools right now (turned off, failing, waiting for sign-in) are listed too, empty, so the
 * page can say why their tools are missing.
 */
export function toolGroupReport(groups: ToolGroup[], input: AvailabilityInput): GroupReport[] {
  const reports: GroupReport[] = groups
    .map((g) => {
      const availability = groupAvailability(g.id, input);
      return {
        id: g.id,
        title: groupTitle(g.id),
        description: g.id === CORE_GROUP ? "always available" : g.description,
        availability,
        tools: g.tools
          .filter((t) => t.name !== LOAD_TOOLS_TOOL_NAME)
          .map((t) => {
            const detail = (t.description ?? "").trim();
            return { name: t.name, title: toolTitle(t.name), description: firstSentence(detail), detail, state: availability.state };
          }),
      };
    })
    .filter((g) => g.tools.length > 0);
  const listed = new Set(reports.map((g) => g.id));
  for (const server of input.mcpServers) {
    const id = MCP_GROUP_PREFIX + server.name;
    if (listed.has(id)) continue;
    reports.push({ id, title: groupTitle(id), description: `MCP server "${server.name}"`, tools: [], availability: mcpAvailability(server) });
  }
  return reports;
}
