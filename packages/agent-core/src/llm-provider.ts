/**
 * LLM provider routing — with several providers enabled (e.g. Copilot and
 * Ollama), each model id is routed to the provider that serves it.
 */

import { createModels, createProvider, type ProviderAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LlmProvider, Settings } from "./config.js";
import { getCopilotBearerToken } from "./copilot-auth.js";

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

/** The enabled provider that serves a model id. */
export async function providerForModel(settings: Settings, id: string): Promise<LlmProvider> {
  const providers = settings.llm_provider;
  if (providers.length === 1) return providers[0];
  if (providers.includes("ollama") && (await isOllamaModel(settings, id))) return "ollama";
  return providers.includes("copilot") ? "copilot" : providers[0];
}

export interface ResolvedModel {
  id: string;
  name: string;
  api: "openai-completions";
  provider: "github-copilot" | "ollama";
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
  api: "openai-completions",
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
 * The Models collection every LLM call goes through. Both providers speak the
 * OpenAI completions API at the baseUrl on each ResolvedModel, so the models
 * list stays empty and resolveModel builds definitions on demand.
 */
export const models = createModels();
for (const [id, name] of [["github-copilot", "GitHub Copilot"], ["ollama", "Ollama"]] as const) {
  models.setProvider(
    createProvider({ id, name, auth: perRequestKeyAuth(name), models: [], api: openAICompletionsApi() }),
  );
}

/** pi-ai model definition for a model id, on whichever provider serves it. */
export async function resolveModel(settings: Settings, id: string): Promise<ResolvedModel> {
  if ((await providerForModel(settings, id)) === "copilot") {
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

/** API key for a resolved model: a Copilot bearer, or a placeholder for Ollama. */
export async function apiKeyFor(model: Pick<ResolvedModel, "provider">, forceRefresh = false): Promise<string> {
  if (model.provider !== "github-copilot") return "ollama";
  const key = await getCopilotBearerToken(forceRefresh);
  // pi-ai's getEnvApiKey fallback for github-copilot reads this.
  process.env.COPILOT_GITHUB_TOKEN = key;
  return key;
}
