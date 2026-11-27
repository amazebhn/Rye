/**
 * Config — loads ~/.config/rye/config.toml, merges env vars, validates with zod.
 * Priority: env vars > config.toml > defaults  (same as the Python version)
 */

import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getRunContext } from "./run-context.js";

// Load .env values before reading config so ${VAR} interpolation works even
// when Rye is started from a package subdirectory.
loadDotEnvFiles();

function parseDotEnvValue(raw: string): string {
  let v = raw.trim();
  const isDoubleQuoted = v.startsWith('"') && v.endsWith('"');
  const isSingleQuoted = v.startsWith("'") && v.endsWith("'");

  if (isDoubleQuoted || isSingleQuoted) {
    v = v.slice(1, -1);
    if (isDoubleQuoted) {
      v = v
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"');
    }
    return v;
  }

  // Strip trailing inline comments for unquoted values.
  const commentIdx = v.search(/\s#/);
  if (commentIdx >= 0) v = v.slice(0, commentIdx).trim();
  return v;
}

function loadDotEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  let text = "";
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // explicit shell env wins
    process.env[key] = parseDotEnvValue(m[2]);
  }
}

function loadDotEnvFiles(): void {
  const candidates = new Set<string>();

  // Walk cwd -> filesystem root so monorepo-root .env is discovered even if
  // process starts from packages/agent-core.
  let dir = process.cwd();
  while (true) {
    candidates.add(join(dir, ".env"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Also allow colocating a .env beside the Rye config.toml.
  const cfgDir = process.env.RYE_CONFIG_DIR ?? join(homedir(), ".config", "rye");
  candidates.add(join(cfgDir, ".env"));

  for (const filePath of candidates) loadDotEnvFile(filePath);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const CONFIG_DIR =
  process.env.RYE_CONFIG_DIR ?? join(homedir(), ".config", "rye");
export const DATA_DIR =
  process.env.RYE_DATA_DIR ?? join(homedir(), ".local", "share", "rye");
export const CONFIG_FILE = join(CONFIG_DIR, "config.toml");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RepoEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
});

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const CodeSearchSchema = z.object({
  repos_root: z.string().optional(),
  repos: z.array(RepoEntrySchema).default([]),
  use_ripgrep: z.boolean().default(true),
  max_results: z.number().int().default(100),
  file_excludes: z
    .array(z.string())
    .default([
      "node_modules",
      ".venv",
      "venv",
      "__pycache__",
      ".git",
      "dist",
      "build",
      ".turbo",
      "coverage",
    ]),
});

const OllamaSchema = z.object({
  base_url: z.string().default("http://localhost:11434"),
  model: z.string().default("llama3.1"),
  embedding_model: z.string().default("nomic-embed-text"),
  // Tokens; drives when compaction starts. Should match Ollama's num_ctx / OLLAMA_CONTEXT_LENGTH.
  context_window: z.number().int().positive().default(32768),
});

const CopilotSchema = z.object({
  api_key: z.string().default(""),
  base_url: z.string().default("https://api.githubcopilot.com"),
  // Blank means auto-select the newest Sonnet from the live catalog.
  model: z.string().default(""),
});

const ClaudeSchema = z.object({
  // A Claude Code model alias ("sonnet", "opus", "haiku") or full model id.
  model: z.string().default("sonnet"),
  // Tokens; used for the context meter and for when Rye compacts its own saved history.
  context_window: z.number().int().positive().default(200000),
  // Let Claude use Claude Code's WebSearch and WebFetch tools.
  web_tools: z.boolean().default(true),
});

// What Rye adds to the prompt from its own stores.
const ContextSchema = z.object({
  // Estimated tokens of saved memories shown every turn; older entries beyond it are listed by key only.
  memory_budget_tokens: z.number().int().positive().default(3000),
  // Show knowledge-base notes that match the user's message without the agent searching for them.
  auto_knowledge: z.boolean().default(true),
  // Embedding similarity (0-1) that is enough on its own for a note to be shown. Depends on the embedding model.
  knowledge_min_similarity: z.number().min(0).max(1).default(0.5),
});

const AttachmentsSchema = z.object({
  // The Ollama vision model that describes attached images (for later turns and for search).
  // Blank: the smallest installed model Ollama says has vision. "off": no descriptions.
  vision_model: z.string().default(""),
});

const SpeechSchema = z.object({
  // Command that transcribes a dictation recording. {input} is the audio file and {output_dir} a
  // scratch folder; the transcript is a .txt written there, or else the command's output.
  // Blank: use mlx_whisper if it is installed.
  stt_command: z.string().default(""),
});

const AWSSchema = z.object({
  region: z.string().default("us-east-1"),
  profile: z.string().optional(),
  access_key_id: z.string().optional(),
  secret_access_key: z.string().optional(),
});

const MySQLSchema = z.object({
  host: z.string().default("localhost"),
  port: z.number().int().default(3306),
  user: z.string().default("root"),
  password: z.string().default(""),
  database: z.string().default(""),
});

export const DATABASE_TYPES = ["mysql", "postgres"] as const;
export type DatabaseType = (typeof DATABASE_TYPES)[number];

// One named SQL connection, e.g. [databases.orders]. An environment can change any field of a
// connection ([environments.prod.databases.orders]) or add connections of its own.
const DatabaseSchema = z.object({
  type: z.enum(DATABASE_TYPES),
  // A connection URL (postgres://user:pass@host:5432/db?sslmode=require or mysql://…) instead of the fields below.
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  // Name of an environment variable holding the password, so it needn't sit in config.toml.
  password_env: z.string().optional(),
  // The database (Postgres) or schema (MySQL) used when a query doesn't name one.
  database: z.string().optional(),
  // Connect over TLS. Hosted Postgres usually requires it.
  ssl: z.boolean().optional(),
  // What this database holds, in a few words; shown to the agent so it picks the right one.
  description: z.string().optional(),
});
export type DatabaseConfig = z.infer<typeof DatabaseSchema>;
const DatabaseNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "use letters, digits, - and _");

const JiraSchema = z.object({
  url: z.string().default(""),
  email: z.string().default(""),
  api_token: z.string().default(""),
  project_keys: z.array(z.string()).default([]),
});

const GitSchema = z.object({
  bitbucket_url: z.string().default(""),
  bitbucket_token: z.string().default(""),
  default_workspace: z.string().default(""),
});

const SkillsSchema = z.object({
  // Read-only roots of installed skills (the `skills` CLI installs to ~/.agents/skills).
  dirs: z.array(z.string()).default(["~/.agents/skills"]),
});

// Code sessions (docs/design/code-sessions.md §7; the shapes are `CodeConfig` in code/types.ts).
// Nothing about code sessions is visible until at least one [[code.repos]] entry is listed.
const CodePolicySchema = z.object({
  // Hosts sandboxed commands may reach without asking; empty denies the network.
  allowed_domains: z.array(z.string()).default([]),
  // Command patterns (`bun test *`) added to the built-in policy, which can't be loosened past its denials.
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});
const CodeEngineIdSchema = z
  .string()
  .regex(/^(claude|pi|acp:[a-z0-9][a-z0-9_-]{0,31})$/, 'use "claude" or "acp:copilot" (later "pi" and other "acp:<cli>")')
  .transform((v) => v as "claude" | "pi" | `acp:${string}`);
const CodeRepoSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use letters, digits, ., - and _"),
  path: z.string().min(1),
  base: z.string().optional(),
  isolation: z.enum(["clone", "worktree"]).default("clone"),
  setup: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
  policy: CodePolicySchema.optional(),
  allow_write: z.array(z.string()).optional(),
});
const CodeSchema = z.object({
  enabled: z.boolean().default(true),
  engine: CodeEngineIdSchema.default("claude"),
  // Blank: claude.model for the Claude engine, else the engine's default.
  model: z.string().default(""),
  // Blank: DATA_DIR/code.
  worktree_root: z.string().default(""),
  max_sessions: z.number().int().min(1).default(6),
  archive_after_days: z.number().int().min(1).default(14),
  approval_timeout_minutes: z.number().positive().default(30),
  max_turns: z.number().int().min(1).default(200),
  max_cost_usd: z.number().positive().default(5),
  editor: z.enum(["vscode", "cursor", "zed", "none"]).default("vscode"),
  // The GitHub Copilot CLI for the "acp:copilot" engine. Blank: `copilot` on PATH.
  copilot_path: z.string().default(""),
  policy: CodePolicySchema.default({}),
  repos: z.array(CodeRepoSchema).default([]),
});

export const MODEL_TIERS = ["low", "medium", "high"] as const;
const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof ModelTierSchema>;

const ModelTaskRoutingSchema = z.object({
  chat: ModelTierSchema.default("medium"),
  subagent: ModelTierSchema.default("medium"),
  compaction: ModelTierSchema.default("medium"),
  extraction: ModelTierSchema.default("medium"),
  doc_review: ModelTierSchema.default("low"),
  labels: ModelTierSchema.default("low"),
});
export type ModelTask = keyof z.infer<typeof ModelTaskRoutingSchema>;
export const MODEL_TASKS = Object.keys(ModelTaskRoutingSchema.shape) as ModelTask[];

const ModelIdSchema = z.string().max(200).regex(/^[\w.:/@+-]*$/, "invalid model id");

const ModelsSchema = z.object({
  // Blank means auto-select a model of that class from the live catalog.
  low: ModelIdSchema.default(""),
  medium: ModelIdSchema.default(""),
  high: ModelIdSchema.default(""),
  tasks: ModelTaskRoutingSchema.default({}),
});

export const DECISION_PROVIDERS = ["off", "ollama", "clef", "chat"] as const;
const DecisionProviderSchema = z.enum(DECISION_PROVIDERS);

/**
 * What re-reads retrieved knowledge notes against the question (see embeddings/rerank.ts):
 *   off      — nothing; notes are ranked by keyword and embedding only
 *   ollama   — a chat model in Ollama, asked yes/no per note (`model`)
 *   decision — the decision model, asked about every note in one request
 *   server   — a rerank server speaking the /v1/rerank protocol (`url`, optional `model`), e.g.
 *              llama-server --rerank; the way to run cross-encoders and zerank, which Ollama can't score
 */
export const RERANK_PROVIDERS = ["off", "ollama", "decision", "server"] as const;
export type RerankProvider = (typeof RERANK_PROVIDERS)[number];
const RerankProviderSchema = z.enum(RERANK_PROVIDERS);
const RerankSchema = z.object({
  provider: RerankProviderSchema.default("off"),
  model: z.string().default(""),
  url: z.string().default(""),
});
export type DecisionProvider = z.infer<typeof DecisionProviderSchema>;

const ClefSchema = z.object({
  // Self-hosted Jev/SystemOne server; when blank, Cloudflare Workers AI is used.
  base_url: z.string().default(""),
  account_id: z.string().default(""),
  api_token: z.string().default(""),
});

const DecisionSchema = z.object({
  provider: DecisionProviderSchema.default("off"),
  // ollama: an Ollama decision model, e.g. "clef-flash:9b" (blank = first installed);
  // chat: any chat model id (blank = low tier); clef: "clef" or "clef-flash".
  model: ModelIdSchema.default(""),
  timeout_ms: z.number().int().positive().default(2500),
  tool_threshold: z.number().min(0).max(1).default(0.5),
  clef: ClefSchema.default({}),
});

// "github" is an alias for "copilot" (GitHub Copilot).
const LlmProviderSchema = z
  .enum(["ollama", "copilot", "github"])
  .transform((p) => (p === "github" ? "copilot" : p));
export type LlmProvider = z.output<typeof LlmProviderSchema>;

// What runs the model. "pi" is Rye's own loop over the llm_provider APIs. An
// external harness takes precedence over llm_provider for the models it serves:
// "claude" runs every Claude model through the Claude Agent SDK (Claude Code's login).
export const HARNESSES = ["pi", "claude"] as const;
export type Harness = (typeof HARNESSES)[number];

const SettingsSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().default(7337),
  harness: z.enum(HARNESSES).default("pi"),
  // One provider or several, e.g. ["github", "ollama"]. The first is the default
  // for blank model tiers; any listed provider's models can be picked.
  llm_provider: z
    .union([LlmProviderSchema, z.array(LlmProviderSchema).min(1)])
    .default("ollama")
    .transform((v): LlmProvider[] => [...new Set(Array.isArray(v) ? v : [v])]),

  ollama: OllamaSchema.default({}),
  copilot: CopilotSchema.default({}),
  claude: ClaudeSchema.default({}),
  context: ContextSchema.default({}),
  speech: SpeechSchema.default({}),
  attachments: AttachmentsSchema.default({}),
  models: ModelsSchema.default({}),
  decision: DecisionSchema.default({}),
  rerank: RerankSchema.default({}),
  aws: AWSSchema.default({}),
  mysql: MySQLSchema.default({}),
  // Named SQL connections (MySQL or Postgres). The [mysql] section above still works and is
  // treated as a connection called "mysql"; see db/connections.ts.
  databases: z.record(DatabaseNameSchema, DatabaseSchema).default({}),
  jira: JiraSchema.default({}),
  git: GitSchema.default({}),
  code_search: CodeSearchSchema.default({}),
  skills: SkillsSchema.default({}),
  // Code sessions; settingsForEnv leaves this alone (a code session ignores the chat's environment).
  code: CodeSchema.default({}),

  data_dir: z.string().default(DATA_DIR),
  db_path: z.string().default(join(DATA_DIR, "knowledge.db")),

  // Named environments. Each entry can override any subset of connector settings.
  // The key is the environment ID (e.g. "qa", "prod"). An optional `name` field
  // provides a human-readable display name.
  environments: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      aws:   AWSSchema.partial().optional(),
      mysql: MySQLSchema.partial().optional(),
      databases: z.record(DatabaseNameSchema, DatabaseSchema.partial()).optional(),
      jira:  JiraSchema.partial().optional(),
      git:   GitSchema.partial().optional(),
    })
  ).default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type CodeSearchConfig = z.infer<typeof CodeSearchSchema>;
export type RepoEntry = z.infer<typeof RepoEntrySchema>;
/** `[code]`; the same shape as `CodeConfig` (code/types.ts). */
export type CodeSettings = z.infer<typeof SettingsSchema>["code"];
export type EnvironmentOverride = z.infer<typeof SettingsSchema>["environments"][string];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function loadToml(): Record<string, unknown> {
  try {
    const text = readFileSync(CONFIG_FILE, "utf8");
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Recursively walks a parsed TOML value and replaces ${VAR_NAME} patterns
 * in string fields with the corresponding process.env value.
 * Unset variables are left as-is (empty string substitution would hide typos).
 */
function interpolateEnvVars(val: unknown): unknown {
  if (typeof val === "string") {
    // If the full string is an env key (e.g. "QA_DB_PASSWORD"), resolve it.
    if (/^[A-Z_][A-Z0-9_]*$/.test(val) && process.env[val] !== undefined) {
      return process.env[val];
    }

    // Support both ${VAR} and $VAR interpolation forms.
    return val.replace(
      /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, bracedName: string | undefined, bareName: string | undefined) => {
        const name = bracedName ?? bareName ?? "";
        const envVal = process.env[name];
        if (envVal !== undefined) return envVal;
        // Keep unresolved references visible for easier debugging.
        return bracedName ? `\${${name}}` : `$${name}`;
      }
    );
  }
  if (Array.isArray(val)) return val.map(interpolateEnvVars);
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = interpolateEnvVars(v);
    }
    return out;
  }
  return val;
}

/** Apply RYE_* environment variable overrides into a raw config object. */
function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(raw) as Record<string, unknown>;

  const str = (k: string) => process.env[k];
  const num = (k: string) => {
    const v = process.env[k];
    return v !== undefined ? parseInt(v, 10) : undefined;
  };
  const bool = (k: string) => {
    const v = process.env[k];
    if (v === undefined) return undefined;
    return v === "1" || v.toLowerCase() === "true";
  };

  const setPath = (obj: Record<string, unknown>, path: string[], val: unknown) => {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (typeof cur[path[i]] !== "object" || cur[path[i]] === null)
        cur[path[i]] = {};
      cur = cur[path[i]] as Record<string, unknown>;
    }
    cur[path[path.length - 1]] = val;
  };

  const maybe = (val: unknown, path: string[]) => {
    if (val !== undefined) setPath(out, path, val);
  };

  // Top-level
  maybe(str("RYE_HOST"), ["host"]);
  maybe(num("RYE_PORT"), ["port"]);
  maybe(str("RYE_HARNESS"), ["harness"]);
  // Comma-separated for several providers, e.g. RYE_LLM_PROVIDER=github,ollama
  maybe(str("RYE_LLM_PROVIDER")?.split(",").map((p) => p.trim()).filter(Boolean), ["llm_provider"]);

  // Context
  maybe(num("RYE_CONTEXT_MEMORY_BUDGET_TOKENS"), ["context", "memory_budget_tokens"]);
  maybe(bool("RYE_CONTEXT_AUTO_KNOWLEDGE"), ["context", "auto_knowledge"]);
  maybe(num("RYE_CONTEXT_KNOWLEDGE_MIN_SIMILARITY"), ["context", "knowledge_min_similarity"]);

  // Speech
  maybe(str("RYE_SPEECH_STT_COMMAND"), ["speech", "stt_command"]);

  // Ollama
  maybe(str("RYE_OLLAMA_BASE_URL"), ["ollama", "base_url"]);
  maybe(str("RYE_OLLAMA_MODEL"), ["ollama", "model"]);
  maybe(str("RYE_OLLAMA_EMBEDDING_MODEL"), ["ollama", "embedding_model"]);
  maybe(str("RYE_RERANK_PROVIDER"), ["rerank", "provider"]);
  maybe(str("RYE_RERANK_MODEL"), ["rerank", "model"]);
  maybe(str("RYE_RERANK_URL"), ["rerank", "url"]);
  maybe(str("RYE_VISION_MODEL"), ["attachments", "vision_model"]);
  maybe(num("RYE_OLLAMA_CONTEXT_WINDOW"), ["ollama", "context_window"]);

  // Copilot
  maybe(str("RYE_COPILOT_API_KEY"), ["copilot", "api_key"]);
  maybe(str("RYE_COPILOT_BASE_URL"), ["copilot", "base_url"]);
  maybe(str("RYE_COPILOT_MODEL"), ["copilot", "model"]);

  // Claude harness
  maybe(str("RYE_CLAUDE_MODEL"), ["claude", "model"]);
  maybe(num("RYE_CLAUDE_CONTEXT_WINDOW"), ["claude", "context_window"]);
  maybe(bool("RYE_CLAUDE_WEB_TOOLS"), ["claude", "web_tools"]);

  // Model tiers
  maybe(str("RYE_MODEL_LOW"), ["models", "low"]);
  maybe(str("RYE_MODEL_MEDIUM"), ["models", "medium"]);
  maybe(str("RYE_MODEL_HIGH"), ["models", "high"]);

  // Decision model
  maybe(str("RYE_DECISION_PROVIDER"), ["decision", "provider"]);
  maybe(str("RYE_DECISION_MODEL"), ["decision", "model"]);
  maybe(str("RYE_CLEF_BASE_URL"), ["decision", "clef", "base_url"]);
  maybe(str("RYE_CLEF_ACCOUNT_ID"), ["decision", "clef", "account_id"]);
  maybe(str("RYE_CLEF_API_TOKEN"), ["decision", "clef", "api_token"]);

  // AWS
  maybe(str("RYE_AWS_REGION"), ["aws", "region"]);
  maybe(str("RYE_AWS_PROFILE"), ["aws", "profile"]);
  maybe(str("RYE_AWS_ACCESS_KEY_ID"), ["aws", "access_key_id"]);
  maybe(str("RYE_AWS_SECRET_ACCESS_KEY"), ["aws", "secret_access_key"]);

  // MySQL
  maybe(str("RYE_MYSQL_HOST"), ["mysql", "host"]);
  maybe(num("RYE_MYSQL_PORT"), ["mysql", "port"]);
  maybe(str("RYE_MYSQL_USER"), ["mysql", "user"]);
  maybe(str("RYE_MYSQL_PASSWORD"), ["mysql", "password"]);
  maybe(str("RYE_MYSQL_DATABASE"), ["mysql", "database"]);

  // Jira
  maybe(str("RYE_JIRA_URL"), ["jira", "url"]);
  maybe(str("RYE_JIRA_EMAIL"), ["jira", "email"]);
  maybe(str("RYE_JIRA_API_TOKEN"), ["jira", "api_token"]);

  // Code search
  maybe(str("RYE_CODE_SEARCH_REPOS_ROOT"), ["code_search", "repos_root"]);
  maybe(bool("RYE_CODE_SEARCH_USE_RIPGREP"), ["code_search", "use_ripgrep"]);
  maybe(num("RYE_CODE_SEARCH_MAX_RESULTS"), ["code_search", "max_results"]);

  // Skills — comma-separated list of read-only skill roots
  maybe(str("RYE_SKILLS_DIRS")?.split(",").map((d) => d.trim()).filter(Boolean), ["skills", "dirs"]);

  return out;
}

// Runtime model override — set via POST /models/select. Because settings are
// reloaded from disk on every getSettings() call, an in-memory override is the
// only way a UI model switch can survive until the process restarts.
let runtimeModelOverride: string | null = null;

/** Override the active model for the current process lifetime. */
export function setRuntimeModel(model: string | null): void {
  runtimeModelOverride = model || null;
}

/** The current runtime model override, if any. */
export function getRuntimeModel(): string | null {
  return runtimeModelOverride;
}

// ---------------------------------------------------------------------------
// Model settings saved from the UI — persisted to DATA_DIR/model-settings.json
// and applied on top of config.toml and env vars.
// ---------------------------------------------------------------------------

export const MODEL_SETTINGS_FILE = join(DATA_DIR, "model-settings.json");

export const ModelOverridesSchema = z
  .object({
    low: ModelIdSchema.optional(),
    medium: ModelIdSchema.optional(),
    high: ModelIdSchema.optional(),
    tasks: z.object(
      Object.fromEntries(MODEL_TASKS.map((t) => [t, ModelTierSchema.optional()])) as Record<ModelTask, z.ZodOptional<typeof ModelTierSchema>>
    ).strict().optional(),
    // null clears an override. Secrets never go here; they stay in config.toml / env.
    decision: z
      .object({
        provider: DecisionProviderSchema.nullable().optional(),
        model: ModelIdSchema.nullable().optional(),
      })
      .strict()
      .optional(),
    // The Ollama model that turns notes and messages into vectors. Changing it means reindexing.
    embedding_model: ModelIdSchema.nullable().optional(),
    rerank: z
      .object({
        provider: RerankProviderSchema.nullable().optional(),
        model: z.string().max(200).nullable().optional(),
        url: z.string().max(500).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;

export function readModelOverrides(): ModelOverrides {
  try {
    const parsed = ModelOverridesSchema.safeParse(JSON.parse(readFileSync(MODEL_SETTINGS_FILE, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeModelOverrides(overrides: ModelOverrides): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MODEL_SETTINGS_FILE, JSON.stringify(overrides, null, 2), "utf8");
}

function applyModelOverrides(s: Settings): void {
  const overrides = readModelOverrides();
  for (const tier of MODEL_TIERS) {
    const value = overrides[tier];
    if (value !== undefined) s.models[tier] = value;
  }
  for (const task of MODEL_TASKS) {
    const tier = overrides.tasks?.[task];
    if (tier) s.models.tasks[task] = tier;
  }
  if (overrides.decision?.provider != null) s.decision.provider = overrides.decision.provider;
  if (overrides.decision?.model != null) s.decision.model = overrides.decision.model;
  if (overrides.embedding_model) s.ollama.embedding_model = overrides.embedding_model;
  if (overrides.rerank?.provider != null) s.rerank.provider = overrides.rerank.provider;
  if (overrides.rerank?.model != null) s.rerank.model = overrides.rerank.model;
  if (overrides.rerank?.url != null) s.rerank.url = overrides.rerank.url;
}

function loadSettings(): Settings {
  const raw = applyEnvOverrides(interpolateEnvVars(loadToml()) as Record<string, unknown>);
  const s = SettingsSchema.parse(raw);
  // Expand ~ in paths post-parse (Zod transforms on optional fields are unreliable)
  if (s.code_search.repos_root) {
    s.code_search.repos_root = expandHome(s.code_search.repos_root);
  }
  for (const repo of s.code_search.repos) {
    repo.path = expandHome(repo.path);
  }
  s.skills.dirs = s.skills.dirs.map(expandHome);
  if (s.code.worktree_root) s.code.worktree_root = expandHome(s.code.worktree_root);
  if (s.code.copilot_path) s.code.copilot_path = expandHome(s.code.copilot_path);
  for (const repo of s.code.repos) {
    repo.path = expandHome(repo.path);
    if (repo.allow_write) repo.allow_write = repo.allow_write.map(expandHome);
  }
  applyModelOverrides(s);
  // Apply the in-memory model override so UI selections persist across reloads.
  if (runtimeModelOverride) {
    if (s.harness === "claude") s.claude.model = runtimeModelOverride;
    else if (s.llm_provider[0] === "copilot") s.copilot.model = runtimeModelOverride;
    else s.ollama.model = runtimeModelOverride;
  }
  return s;
}

export function getSettings(): Settings {
  return loadSettings();
}

export const settings: Settings = loadSettings();

// ---------------------------------------------------------------------------
// Active environment — persisted to DATA_DIR/active-env
// ---------------------------------------------------------------------------

export const ACTIVE_ENV_FILE = join(DATA_DIR, "active-env");

/**
 * Returns the active environment key, or null for "default". Inside an agent
 * run this is the run's own env; outside a run it is the global default.
 */
export function getActiveEnv(): string | null {
  const ctx = getRunContext();
  if (ctx) return ctx.envKey;
  return getGlobalActiveEnv();
}

/** The persisted global default env, ignoring any run context. */
export function getGlobalActiveEnv(): string | null {
  try {
    const v = readFileSync(ACTIVE_ENV_FILE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Persist the global default environment. Pass null to clear (revert to default). */
export function setActiveEnv(name: string | null): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ACTIVE_ENV_FILE, name ?? "", "utf8");
}

/**
 * Returns settings with the active environment's overrides merged on top of
 * the base connector settings. This is what tools should use instead of the
 * static `settings` singleton, because it reflects runtime env switches.
 */
/**
 * An environment's database connections: the base ones with the environment's changes
 * applied field by field, plus any it defines itself. One it defines without a `type`
 * (and with no base connection to inherit it from) is left out.
 */
export function mergeDatabases(
  base: Settings["databases"],
  override: Record<string, Partial<DatabaseConfig>> | undefined,
): Settings["databases"] {
  if (!override) return base;
  const merged: Settings["databases"] = { ...base };
  for (const [name, changes] of Object.entries(override)) {
    const combined = { ...base[name], ...changes };
    if (combined.type) merged[name] = combined as DatabaseConfig;
  }
  return merged;
}

export function getEffectiveSettings(): Settings {
  return settingsForEnv(loadSettings(), getActiveEnv());
}

/** `base` with one environment's overrides applied; `null`, "default" or an unknown key leave it as it is. */
export function settingsForEnv(base: Settings, envKey: string | null): Settings {
  if (!envKey) return base;

  const override = base.environments[envKey];
  if (!override) return base;

  return {
    ...base,
    aws:   override.aws   ? { ...base.aws,   ...override.aws   } : base.aws,
    mysql: override.mysql ? { ...base.mysql, ...override.mysql } : base.mysql,
    databases: mergeDatabases(base.databases, override.databases),
    jira:  override.jira  ? { ...base.jira,  ...override.jira  } : base.jira,
    git:   override.git   ? { ...base.git,   ...override.git   } : base.git,
  };
}

// Ensure data directories exist
await Bun.write(join(settings.data_dir, ".keep"), "").catch(() => {});
