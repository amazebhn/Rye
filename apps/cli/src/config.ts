import Conf from "conf";
import { DEFAULT_AGENT_URL } from "@rye/shared";
import { parse as parseToml } from "smol-toml";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

type ConfigSchema = {
  agentUrl?: string;
  llmProvider?: string;
};

let _conf: Conf<ConfigSchema> | null = null;

export const RYE_CONFIG_DIR =
  process.env.RYE_CONFIG_DIR ?? join(homedir(), ".config", "rye");
export const RYE_CONFIG_FILE = join(RYE_CONFIG_DIR, "config.toml");

type RyeTomlConfig = {
  host?: unknown;
  port?: unknown;
  llm_provider?: unknown;
};

function loadRyeToml(): RyeTomlConfig {
  try {
    const text = readFileSync(RYE_CONFIG_FILE, "utf8");
    return parseToml(text) as RyeTomlConfig;
  } catch {
    return {};
  }
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseTomlNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTomlString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveAgentUrlFromRyeConfig(): string | undefined {
  if (process.env.RYE_AGENT_URL) return process.env.RYE_AGENT_URL;

  const raw = loadRyeToml();

  const envHost = process.env.RYE_HOST;
  const envPort = parseNumber(process.env.RYE_PORT);

  const host = envHost ?? parseTomlString(raw.host);
  const port = envPort ?? parseTomlNumber(raw.port);

  if (host === undefined && port === undefined) return undefined;

  const finalHost = host ?? "127.0.0.1";
  const finalPort = port ?? 7337;
  return `http://${finalHost}:${finalPort}`;
}

type LlmProvider = "ollama" | "copilot";

/** Accepts "ollama", "github,ollama", or ["github", "ollama"]; "github" means Copilot. */
function parseProviders(value: unknown): LlmProvider[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const providers = items.flatMap((item): LlmProvider[] => {
    const p = typeof item === "string" ? item.trim() : "";
    if (p === "github" || p === "copilot") return ["copilot"];
    return p === "ollama" ? ["ollama"] : [];
  });
  return providers.length > 0 ? [...new Set(providers)] : undefined;
}

function resolveLlmProviderFromRyeConfig(): LlmProvider[] | undefined {
  return parseProviders(process.env.RYE_LLM_PROVIDER) ?? parseProviders(loadRyeToml().llm_provider);
}

export function getConfig(): Conf<ConfigSchema> {
  if (!_conf) {
    // No llmProvider default here — it would mask the value in config.toml.
    _conf = new Conf<ConfigSchema>({ projectName: "rye" });
  }
  return _conf;
}

export function getEffectiveAgentUrl(): string {
  const config = getConfig();
  return config.get("agentUrl") ?? resolveAgentUrlFromRyeConfig() ?? DEFAULT_AGENT_URL;
}

export function getEffectiveLlmProvider(): string {
  const config = getConfig();
  return config.get("llmProvider") ?? resolveLlmProviderFromRyeConfig()?.join(", ") ?? "ollama";
}
