/**
 * LLM provider routing — with several providers enabled (e.g. Copilot and
 * Ollama), each model id is routed to the provider that serves it. The
 * `harness` setting takes precedence: with harness = "claude", Claude models
 * run through the Claude Agent SDK whichever providers are listed.
 */

import { createModels, createProvider, type ProviderAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { join } from "node:path";
import { DATA_DIR, getSettings, type LlmProvider, type Settings } from "./config.js";
import { getCopilotBearerToken } from "./copilot-auth.js";
import { CLAUDE_SDK_API, CLAUDE_WEB_TOOLS, claudeAgentSdkApi } from "./harness/claude-sdk.js";

const OLLAMA_CACHE_MS = 60_000;
let ollamaCache: { baseUrl: string; models: string[]; at: number } | null = null;

/** Installed Ollama model names; throws when Ollama is unreachable. */
export async function fetchOllamaModels(settings: Settings): Promise<string[]> {
  const baseUrl = settings.ollama.base_url;
  if (ollamaCache?.baseUrl === baseUrl && Date.now() - ollamaCache.at < OLLAMA_CACHE_MS) {
    return ollamaCache.models;
  }
  const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { models?: Array<{ name: string }> };
  const models = (data.models ?? []).map((m) => m.name);
  ollamaCache = { baseUrl, models, at: Date.now() };
  return models;
}

// Ollama treats "llama3.1" and "llama3.1:latest" as the same model.
const ollamaName = (id: string) => (id.includes(":") ? id : `${id}:latest`);

async function isOllamaModel(settings: Settings, id: string): Promise<boolean> {
  const name = ollamaName(id);
  if (name === ollamaName(settings.ollama.model)) return true;
  try {
    return (await fetchOllamaModels(settings)).some((m) => ollamaName(m) === name);
  } catch {
    return false;
  }
}

/** A Claude Code model alias ("sonnet", "opus[1m]", "default") or a Claude model id. */
export function isClaudeModelId(id: string): boolean {
  return /^(claude|sonnet|opus|haiku|fable|mythos|default\b)/i.test(id.trim());
}

/** Whether the Claude harness serves this model, ahead of any llm_provider that also lists it. */
export function usesClaudeHarness(settings: Settings, id: string): boolean {
  return settings.harness === "claude" && (isClaudeModelId(id) || id === settings.claude.model);
}

/** The harness or enabled provider that serves a model id. */
export async function providerForModel(settings: Settings, id: string): Promise<LlmProvider | "claude"> {
  if (usesClaudeHarness(settings, id)) return "claude";
  const providers = settings.llm_provider;
  if (providers.length === 1) return providers[0];
  if (providers.includes("ollama") && (await isOllamaModel(settings, id))) return "ollama";
  return providers.includes("copilot") ? "copilot" : providers[0];
}

export interface ResolvedModel {
  id: string;
  name: string;
  api: "openai-completions" | typeof CLAUDE_SDK_API;
  provider: "github-copilot" | "ollama" | "claude";
  baseUrl: string;
  headers?: Record<string, string>;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    supportsStore: boolean;
    supportsStrictMode: boolean;
    maxTokensField: "max_tokens";
    supportsUsageInStreaming: boolean;
  };
}

const SHARED = {
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  compat: {
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
    supportsUsageInStreaming: false,
  },
} satisfies Partial<ResolvedModel>;

// Callers pass the key on every request (apiKeyFor), so auth only marks the provider as configured.
const perRequestKeyAuth = (name: string): ProviderAuth => ({
  apiKey: { name, resolve: async () => ({ auth: {} }) },
});

/**
 * The Models collection every LLM call goes through. Copilot and Ollama speak
 * the OpenAI completions API at the baseUrl on each ResolvedModel, and the
 * Claude harness runs the Agent SDK, so the models list stays empty and
 * resolveModel builds definitions on demand.
 */
export const models = createModels();
for (const [id, name] of [["github-copilot", "GitHub Copilot"], ["ollama", "Ollama"]] as const) {
  models.setProvider(
    createProvider({ id, name, auth: perRequestKeyAuth(name), models: [], api: openAICompletionsApi() }),
  );
}
models.setProvider(
  createProvider({
    id: "claude",
    name: "Claude",
    // Claude Code authenticates itself (its own login, or ANTHROPIC_API_KEY).
    auth: perRequestKeyAuth("Claude"),
    models: [],
    api: claudeAgentSdkApi({
      cwd: () => join(DATA_DIR, "claude-harness"),
      builtinTools: () => (getSettings().claude.web_tools ? CLAUDE_WEB_TOOLS : []),
    }),
  }),
);

/** pi-ai model definition for a model id, on whichever harness or provider serves it. */
export async function resolveModel(settings: Settings, id: string): Promise<ResolvedModel> {
  const provider = await providerForModel(settings, id);
  if (provider === "claude") {
    return {
      ...SHARED,
      id,
      name: `Claude / ${id}`,
      api: CLAUDE_SDK_API,
      provider: "claude",
      baseUrl: "",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: settings.claude.context_window,
      maxTokens: 32000,
    };
  }
  if (provider === "copilot") {
    return {
      ...SHARED,
      id,
      name: "GitHub Copilot",
      provider: "github-copilot",
      baseUrl: settings.copilot.base_url,
      // pi-ai's "github-copilot" provider expects these Copilot integration headers.
      headers: {
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.90.0",
        "Editor-Plugin-Version": "copilot-chat/0.1.0",
      },
      maxTokens: 16384,
    };
  }
  return {
    ...SHARED,
    id,
    name: `Ollama / ${id}`,
    provider: "ollama",
    baseUrl: `${settings.ollama.base_url}/v1`,
    contextWindow: settings.ollama.context_window,
    maxTokens: 32000,
    // Ollama only reports token usage on streams when asked via stream_options.include_usage.
    compat: { ...SHARED.compat, supportsUsageInStreaming: true },
  };
}

/** API key for a resolved model: a Copilot bearer, or a placeholder for Ollama and the Claude harness. */
export async function apiKeyFor(model: Pick<ResolvedModel, "provider">, forceRefresh = false): Promise<string> {
  if (model.provider !== "github-copilot") return model.provider;
  const key = await getCopilotBearerToken(forceRefresh);
  // pi-ai's getEnvApiKey fallback for github-copilot reads this.
  process.env.COPILOT_GITHUB_TOKEN = key;
  return key;
}
