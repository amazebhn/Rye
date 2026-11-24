import type { ToolCall } from "./types";

/** Short human-readable label for a single tool call. */
export function toolLabel(tc: ToolCall): string {
  return knownToolLabel(tc) ?? genericLabel(tc.name);
}

const KEY_ARGS = ["query", "q", "pattern", "search", "url", "path", "file", "id", "name", "title", "question"];

/** The key argument, for tools whose label doesn't already include it. */
export function toolDetail(tc: ToolCall): string | undefined {
  if (knownToolLabel(tc) !== undefined) return undefined;
  const a = tc.args;
  const isScalar = (k: string) => typeof a[k] === "string" || typeof a[k] === "number";
  const key = KEY_ARGS.find(isScalar) ?? Object.keys(a).find((k) => typeof a[k] === "string");
  if (!key) return undefined;
  const value = String(a[key]).replace(/\s+/g, " ").trim();
  return value.length > 80 ? `${value.slice(0, 80)}…` : value || undefined;
}

// Error shapes produced by the agent loop and by individual tools.
const ERROR_RESULT =
  /^\s*(error\b|tool execution error|tool timed out|mcp tool error|subagent execution error|mcp server proposal rejected|the user denied access)/i;

export function isToolError(tc: ToolCall): boolean {
  return tc.result !== undefined && ERROR_RESULT.test(tc.result);
}

const titleCase = (s: string) =>
  s.split(/[_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// Tools the Claude harness runs itself; their names aren't Rye's snake_case.
const HARNESS_TOOL_LABELS: Record<string, string> = { WebSearch: "Web search", WebFetch: "Fetch page" };

// mcp__glean_default__search → "Glean · search"
function genericLabel(name: string): string {
  if (HARNESS_TOOL_LABELS[name]) return HARNESS_TOOL_LABELS[name];
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const sep = rest.indexOf("__");
    if (sep !== -1) {
      const server = titleCase(rest.slice(0, sep).replace(/_default$/, ""));
      return `${server} · ${rest.slice(sep + 2).replace(/_/g, " ")}`;
    }
  }
  return name.replace(/_tool$/, "").replace(/_/g, " ");
}

function knownToolLabel(tc: ToolCall): string | undefined {
  const a = tc.args as Record<string, string | number | undefined>;

  switch (tc.name) {
    case "code_search_tool":
      return `Searched for \`${a.pattern ?? ""}\`${a.repo_name ? ` in ${a.repo_name}` : ""}`;
    case "file_search_tool":
      return `Found files matching \`${a.pattern ?? ""}\`${a.repo_name ? ` in ${a.repo_name}` : ""}`;
    case "symbol_search_tool":
      return `Looked up symbol \`${a.symbol ?? ""}\``;
    case "stack_trace_tool":
      return "Resolved stack trace";
    case "log_to_source_tool":
      return `Traced log to source`;
    case "list_repos_tool":
      return "Listed repositories";

    case "cloudwatch_search_tool":
      return `Searched logs${a.log_group ? ` in \`${String(a.log_group).split("/").pop()}\`` : ""}${a.query ? ` for \`${a.query}\`` : ""}`;
    case "cloudwatch_list_log_groups_tool":
      return `Listed log groups${a.prefix ? ` (${a.prefix})` : ""}`;
    case "rds_list_instances_tool":
      return "Listed RDS instances";
    case "ecs_list_clusters_tool":
      return "Listed ECS clusters";
    case "ecs_list_services_tool":
      return `Listed ECS services${a.cluster ? ` in \`${a.cluster}\`` : ""}`;
    case "ecs_describe_service_tool":
      return `Described ECS service \`${a.service ?? ""}\``;
    case "ecs_list_tasks_tool":
      return `Listed tasks in \`${a.service ?? a.cluster ?? ""}\``;
    case "ec2_list_instances_tool":
      return `Listed EC2 instances${a.filter ? ` matching '${a.filter}'` : ""}${a.state ? ` (${a.state})` : ""}`;
    case "alb_list_load_balancers_tool":
      return "Listed load balancers";
    case "alb_target_health_tool":
      return `Checked target health for \`${a.target_group_arn ? String(a.target_group_arn).split("/").slice(-2, -1)[0] : ""}\``;
    case "s3_list_buckets_tool":
      return `Listed S3 buckets${a.name_filter ? ` matching '${a.name_filter}'` : ""}`;
    case "s3_list_objects_tool":
      return `Listed \`s3://${a.bucket ?? ""}/${a.prefix ?? ""}\``;
    case "s3_read_object_tool":
      return `Read \`s3://${a.bucket ?? ""}/${a.key ?? ""}\``;

    // sql_* are the current names; mysql_* are what older chats recorded.
    case "sql_query_tool":
    case "mysql_query_tool": {
      const sql = String(a.query ?? a.sql ?? "").replace(/\s+/g, " ").slice(0, 60);
      // Which connection, and which database on it, when the call named them.
      const target = [a.connection, a.database].filter(Boolean).join(" / ");
      return `Queried DB${target ? ` (\`${target}\`)` : ""}: \`${sql}${sql.length === 60 ? "…" : ""}\``;
    }
    case "sql_schema_tool":
    case "mysql_schema_tool": {
      const target = [a.connection, a.database].filter(Boolean).join(" / ");
      return `Fetched schema${a.table ? ` for \`${a.table}\`` : ""}${target ? ` in \`${target}\`` : ""}`;
    }
    case "sql_list_databases_tool":
    case "mysql_list_databases_tool":
      return `Listed databases${a.connection ? ` on \`${a.connection}\`` : ""}`;

    case "jira_ticket_tool":
      return `Fetched Jira ticket \`${a.ticket_id ?? ""}\``;

    case "git_log_tool":
      return `Checked git log${a.path ? ` for \`${a.path}\`` : ""}`;
    case "git_blame_tool":
      return `Checked git blame on \`${a.path ?? ""}\``;

    case "remember_tool":
      return `Saved memory: \`${a.key ?? ""}\``;
    case "forget_tool":
      return `Deleted memory: \`${a.key ?? ""}\``;
    case "list_memories_tool":
      return "Listed memories";
    case "save_sop_tool":
      return `Saved SOP: \`${a.title ?? ""}\``;
    case "load_sop_tool":
      return `Read SOP #${a.id ?? ""}`;
    case "search_sops_tool":
      return `Searched SOPs for "${a.query ?? ""}"`;
    case "set_model_pricing_tool": {
      const entries = (tc.args as { entries?: unknown[] }).entries ?? [];
      return `Saved pricing for ${entries.length} model${entries.length !== 1 ? "s" : ""}`;
    }
    case "get_model_pricing_tool":
      return "Read model pricing";
    case "result_query_tool":
      return `Queried stored result \`${a.result_id ?? ""}\``;
    case "result_aggregate_tool":
      return `Aggregated stored result (${a.op ?? ""}${a.group_by ? ` by ${a.group_by}` : ""})`;

    case "write_artifact_tool": {
      const name = String(a.name ?? "file");
      const ext = `.${a.format ?? ""}`;
      return `Wrote \`${name.endsWith(ext) ? name : name + ext}\``;
    }
    case "read_artifact_tool":
      return a.name ? `Read file \`${a.name}\`` : "Listed saved files";

    case "spawn_subagents_tool": {
      const tasks = (tc.args as { tasks?: string[] }).tasks ?? [];
      return `Spawned ${tasks.length} subagent${tasks.length !== 1 ? "s" : ""}`;
    }

    case "ask_user_tool":
      return "Asked user a question";

    case "propose_tool_tool":
      return `Proposed tool \`${a.name ?? ""}\``;
    case "install_tool_tool":
      return `Installed tool \`${a.name ?? ""}\``;
    case "list_custom_tools_tool":
      return "Listed custom tools";
    case "delete_custom_tool_tool":
      return `Deleted tool \`${a.name ?? ""}\``;

    default:
      return undefined;
  }
}
