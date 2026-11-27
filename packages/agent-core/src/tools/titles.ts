/**
 * Human-readable titles for tools ("Run SQL query" for sql_query_tool), shown in Settings → Tools
 * and the composer's tool picker. The model keeps using the names. A tool not listed here (a custom
 * or MCP tool, or a new one) gets a title made from its name.
 */

export const TOOL_TITLES: Record<string, string> = {
  // Core
  remember_tool: "Remember a fact",
  forget_tool: "Forget a fact",
  list_memories_tool: "List saved facts",
  search_knowledge_tool: "Search the knowledge base",
  get_knowledge_tool: "Read a knowledge note",
  save_knowledge_tool: "Save a knowledge note",
  delete_knowledge_tool: "Delete a knowledge note",
  spawn_subagents_tool: "Run subagents",
  ask_user_tool: "Ask you a question",
  load_skill_tool: "Load a skill",
  read_skill_file_tool: "Read a skill file",
  run_skill_script_tool: "Run a skill script",
  load_sop_tool: "Open an SOP",
  search_sops_tool: "Search SOPs",
  switch_env_tool: "Switch environment",
  load_tools_tool: "Load more tools",
  // SQL
  sql_query_tool: "Run SQL query",
  sql_schema_tool: "Inspect database schema",
  sql_list_databases_tool: "List databases",
  // AWS
  cloudwatch_list_log_groups_tool: "List CloudWatch log groups",
  cloudwatch_search_tool: "Search CloudWatch logs",
  rds_list_instances_tool: "List RDS instances",
  ecs_list_clusters_tool: "List ECS clusters",
  ecs_list_services_tool: "List ECS services",
  ecs_describe_service_tool: "Describe an ECS service",
  ecs_list_tasks_tool: "List ECS tasks",
  ec2_list_instances_tool: "List EC2 instances",
  alb_list_load_balancers_tool: "List load balancers",
  alb_target_health_tool: "Check target health",
  s3_list_buckets_tool: "List S3 buckets",
  s3_list_objects_tool: "List S3 objects",
  s3_read_object_tool: "Read an S3 object",
  // Jira and git
  jira_ticket_tool: "Read a Jira ticket",
  git_log_tool: "Git history",
  git_blame_tool: "Git blame",
  // Code search
  list_repos_tool: "List repositories",
  code_search_tool: "Search code",
  symbol_search_tool: "Find a symbol",
  stack_trace_tool: "Trace a stack trace",
  file_search_tool: "Find a file",
  log_to_source_tool: "Find a log line's source",
  // Stored results, chats, attachments
  result_query_tool: "Query a stored result",
  result_aggregate_tool: "Summarise a stored result",
  search_chats_tool: "Search past chats",
  read_chat_tool: "Read a past chat",
  read_attachment_tool: "Read an attachment",
  // Authoring
  save_sop_tool: "Save an SOP",
  save_skill_tool: "Save a skill",
  save_agent_tool: "Save an agent",
  write_artifact_tool: "Write a file",
  read_artifact_tool: "Read a file",
  // Custom tools and admin
  propose_tool_tool: "Propose a custom tool",
  install_tool_tool: "Install a custom tool",
  list_custom_tools_tool: "List custom tools",
  delete_custom_tool_tool: "Delete a custom tool",
  add_mcp_server_tool: "Add an MCP server",
  set_model_pricing_tool: "Set model pricing",
  get_model_pricing_tool: "Get model pricing",
  // Code sessions
  start_code_session_tool: "Start code session",
  code_session_status_tool: "Check a code session",
  // Run by the Claude harness itself
  WebSearch: "Search the web",
  WebFetch: "Fetch a web page",
};

/** Words that read better in their usual form than title-cased. */
const WORDS: Record<string, string> = { sql: "SQL", aws: "AWS", s3: "S3", ec2: "EC2", ecs: "ECS", rds: "RDS", alb: "ALB", api: "API", id: "ID", ids: "IDs", url: "URL", json: "JSON", csv: "CSV", pr: "PR", prs: "PRs", ci: "CI", db: "DB", mcp: "MCP" };

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());

/** "list_open_prs" → "List open PRs". */
function fromName(name: string): string {
  const parts = words(name.replace(/_tool$/, ""));
  if (parts.length === 0) return name;
  return [parts[0][0].toUpperCase() + parts[0].slice(1), ...parts.slice(1)].join(" ");
}

/** A tool's title. MCP tools (mcp__<server>__<tool>) are titled from their tool part; the server shows as their group. */
export function toolTitle(name: string): string {
  if (TOOL_TITLES[name]) return TOOL_TITLES[name];
  const mcp = /^mcp__.+?__(.+)$/.exec(name);
  return fromName(mcp ? mcp[1] : name);
}

/** Titles for the tool groups in tools/groups.ts, as Settings → Tools and the composer's tool picker head them. */
export const GROUP_TITLES: Record<string, string> = {
  core: "Core",
  sql: "SQL databases",
  aws: "AWS",
  jira: "Jira",
  git: "Git",
  code_search: "Code search",
  results: "Stored results",
  chats: "Past chats",
  attachments: "Attachments",
  sop_authoring: "SOP authoring",
  skills: "Skills",
  agents: "Agents",
  artifacts: "Files",
  custom_tools: "Custom tools",
  admin: "Admin",
  code: "Code sessions",
};

/** A group's title. An MCP server's group ("mcp:grafana") is "MCP · grafana"; the server's own name is kept as written. */
export function groupTitle(id: string): string {
  if (GROUP_TITLES[id]) return GROUP_TITLES[id];
  if (id.startsWith("mcp:")) return `MCP · ${id.slice("mcp:".length)}`;
  return fromName(id);
}
