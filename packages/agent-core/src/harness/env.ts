/**
 * The environment Rye gives Claude Code: an allowlist, never `process.env` as a whole.
 *
 * Rye loads its `.env` into `process.env`, so passing that on would hand Claude Code (and every
 * command it runs) Rye's database passwords, Jira and Copilot tokens, AWS keys and `RYE_*`
 * settings. Only what Claude Code needs to start, find its login and reach its model goes through.
 * Used by the chat harness (`harness/claude-sdk.ts`) and the code engine (`code/engines/claude.ts`,
 * which adds the workspace's own variables through `overrides`). `copilotEnv` is the same idea for
 * the GitHub Copilot CLI (code engine `acp:copilot`).
 */

/** Identifies Rye in Claude Code's User-Agent. */
export const CLAUDE_CLIENT_APP = "rye/0.1.0";

/** The basics a process needs: where things are, who the user is, how to print text. */
const BASE_VARS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM", "TZ"];

/** Where Claude Code keeps its state and login on Linux; on macOS the login is in the keychain. */
const STATE_VARS = ["CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

/** Reaching the API from behind a corporate proxy or TLS inspection. */
const NETWORK_VARS = [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

/** Claude Code's own switches that aren't prefixed. */
const CLAUDE_CODE_SWITCHES = [
  "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER", "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "MAX_THINKING_TOKENS", "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT",
];

/**
 * Every variable with these prefixes is Claude Code's own: auth (`ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`), endpoints and models (`ANTHROPIC_BASE_URL`,
 * `ANTHROPIC_MODEL`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`,
 * `ANTHROPIC_FOUNDRY_*`), and switches (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
 * `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_DISABLE_*`, …).
 */
const CLAUDE_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];

/** Locale variables (`LC_ALL`, `LC_CTYPE`, …). */
const LOCALE_PREFIX = "LC_";

/**
 * Amazon Bedrock auth, passed only when Claude Code is set to use Bedrock
 * (`CLAUDE_CODE_USE_BEDROCK`). Otherwise AWS credentials are Rye's (its AWS tools) and stay with Rye.
 */
const BEDROCK_VARS = [
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
];

/** Google Vertex AI auth, passed only when Claude Code is set to use Vertex (`CLAUDE_CODE_USE_VERTEX`). */
const VERTEX_VARS = ["CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CONFIG"];
/** Per-model Vertex regions (`VERTEX_REGION_CLAUDE_3_5_SONNET`, …). */
const VERTEX_PREFIX = "VERTEX_REGION_";

/** Rye's own settings never reach Claude Code, even through a prefix above. */
const NEVER_PREFIXES = ["RYE_"];

const isOn = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

export interface ClaudeEnvOptions {
  /** The environment to pick from. Default `process.env`. */
  source?: Record<string, string | undefined>;
  /** Set on top of the allowlisted variables (a code session's TMPDIR, caches, PATH). */
  overrides?: Record<string, string>;
}

/** True when `name` from `source` may be passed to Claude Code. */
export function claudeEnvAllows(name: string, source: Record<string, string | undefined> = process.env): boolean {
  if (NEVER_PREFIXES.some((p) => name.startsWith(p))) return false;
  if (BASE_VARS.includes(name) || STATE_VARS.includes(name) || NETWORK_VARS.includes(name) || CLAUDE_CODE_SWITCHES.includes(name)) return true;
  if (name.startsWith(LOCALE_PREFIX)) return true;
  if (CLAUDE_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (isOn(source.CLAUDE_CODE_USE_BEDROCK) && BEDROCK_VARS.includes(name)) return true;
  if (isOn(source.CLAUDE_CODE_USE_VERTEX) && (VERTEX_VARS.includes(name) || name.startsWith(VERTEX_PREFIX))) return true;
  return false;
}

/** The scrubbed environment for a Claude Code process, with Rye's client id set. */
export function claudeEnv(options: ClaudeEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && claudeEnvAllows(name, source)) env[name] = value;
  }
  return { ...env, ...options.overrides, CLAUDE_AGENT_SDK_CLIENT_APP: CLAUDE_CLIENT_APP };
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI (code engine `acp:copilot`)
// ---------------------------------------------------------------------------

/**
 * What the Copilot CLI may get from Rye's environment. Sources:
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
 * (token order `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`; host from `COPILOT_GH_HOST`, `GH_HOST`)
 * and https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
 * (`COPILOT_HOME`, `COPILOT_CACHE_HOME`).
 *
 * Only `COPILOT_GITHUB_TOKEN` is passed as a token: it is the variable meant for Copilot alone (a
 * fine-grained PAT with just the "Copilot Requests" permission). `GH_TOKEN` and `GITHUB_TOKEN` are
 * general GitHub tokens (repo access, Rye's own tools) and never reach the agent. Every other
 * `COPILOT_*` variable is dropped too, notably `COPILOT_ALLOW_ALL` (approve everything) and the
 * telemetry switches; Rye sets what it wants itself (`COPILOT_DEFAULTS`).
 */
const COPILOT_VARS = ["COPILOT_GITHUB_TOKEN", "COPILOT_GH_HOST", "GH_HOST", "COPILOT_HOME"];

/** Set for every Copilot process: no self-update while sandboxed, and Node's fetch honours the sandbox's proxy variables. */
export const COPILOT_DEFAULTS: Readonly<Record<string, string>> = {
  COPILOT_AUTO_UPDATE: "false",
  // Node 24+: fetch() uses HTTP(S)_PROXY, which is the only way out of the sandbox. Older Node ignores it.
  NODE_USE_ENV_PROXY: "1",
};

/** True when `name` may be passed to the Copilot CLI. */
export function copilotEnvAllows(name: string): boolean {
  if (NEVER_PREFIXES.some((p) => name.startsWith(p))) return false;
  if (BASE_VARS.includes(name) || NETWORK_VARS.includes(name) || name.startsWith(LOCALE_PREFIX)) return true;
  // The XDG dirs other than the cache (which the workspace sets): Copilot migrates old XDG locations.
  if (name === "XDG_CONFIG_HOME" || name === "XDG_STATE_HOME" || name === "XDG_DATA_HOME") return true;
  return COPILOT_VARS.includes(name);
}

/** The scrubbed environment for a Copilot CLI process. `overrides` (the workspace's TMPDIR, caches, PATH) win over the allowlist. */
export function copilotEnv(options: ClaudeEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && copilotEnvAllows(name)) env[name] = value;
  }
  return { ...env, ...options.overrides, ...COPILOT_DEFAULTS };
}
