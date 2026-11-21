/**
 * Human-friendly model names and provider grouping.
 * Raw ids stay the source of truth; these helpers only affect display.
 */

export interface ModelProvider {
  id: "anthropic" | "openai" | "google" | "xai" | "meta" | "mistral" | "qwen" | "deepseek" | "microsoft" | "other";
  name: string;
}

const PROVIDERS: Array<ModelProvider & { test: RegExp }> = [
  { id: "anthropic", name: "Anthropic", test: /claude/ },
  { id: "openai", name: "OpenAI", test: /^(gpt|o\d|chatgpt|codex)/ },
  { id: "google", name: "Google", test: /gemini|gemma/ },
  { id: "xai", name: "xAI", test: /grok/ },
  { id: "meta", name: "Meta", test: /llama/ },
  { id: "mistral", name: "Mistral", test: /mistral|mixtral|codestral|devstral|magistral/ },
  { id: "qwen", name: "Qwen", test: /qwen|qwq/ },
  { id: "deepseek", name: "DeepSeek", test: /deepseek/ },
  { id: "microsoft", name: "Microsoft", test: /^phi/ },
];

const OTHER: ModelProvider = { id: "other", name: "Other" };

export const PROVIDER_ORDER: ModelProvider["id"][] = [...PROVIDERS.map((p) => p.id), "other"];

export function modelProvider(id: string): ModelProvider {
  const lower = id.toLowerCase();
  const match = PROVIDERS.find((p) => p.test.test(lower));
  return match ? { id: match.id, name: match.name } : OTHER;
}

const VERSION = /^\d+(\.\d+)*$/;
const LOWERCASE_WORDS = new Set(["mini", "nano"]);
const UPPERCASE_WORDS = new Set(["gpt", "ai", "llm", "vl"]);
const BRAND_WORDS: Record<string, string> = { deepseek: "DeepSeek", qwq: "QwQ" };

function titleWord(word: string): string {
  const lower = word.toLowerCase();
  if (BRAND_WORDS[lower]) return BRAND_WORDS[lower];
  if (UPPERCASE_WORDS.has(lower)) return lower.toUpperCase();
  if (LOWERCASE_WORDS.has(lower)) return lower;
  // "llama3.1" → "Llama 3.1", "qwen2.5" → "Qwen 2.5"; short tags like "r1" stay joined.
  const split = lower.match(/^([a-z]{2,})(\d[\d.]*)$/);
  if (split) return `${titleWord(split[1])} ${split[2]}`;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "qwen2.5-coder:7b" → tag " · 7B"; ":latest" is dropped. */
function formatTag(tag: string | undefined): string {
  if (!tag || tag === "latest") return "";
  return ` · ${/^\d+(\.\d+)?[bkm]$/i.test(tag) ? tag.toUpperCase() : tag}`;
}

export function formatModelName(id: string): string {
  if (!id) return id;
  const [base, tag] = id.split(":");
  const tokens = base.split(/[-_]/).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());

  // Claude: both "claude-sonnet-4.5" and legacy "claude-3.7-sonnet".
  if (lower[0] === "claude") {
    const family = lower.find((t) => ["sonnet", "opus", "haiku"].includes(t));
    const version = lower.filter((t) => VERSION.test(t)).join(".");
    const extras = lower.slice(1).filter((t) => t !== family && !VERSION.test(t)).map(titleWord);
    return ["Claude", family && titleWord(family), version, ...extras].filter(Boolean).join(" ") + formatTag(tag);
  }

  // GPT: "gpt-4.1" → "GPT-4.1", "gpt-4o-mini" → "GPT-4o mini".
  if (lower[0] === "gpt" && tokens[1]) {
    return [`GPT-${lower[1]}`, ...lower.slice(2).map(titleWord)].join(" ") + formatTag(tag);
  }

  // OpenAI reasoning models keep their own styling, e.g. "o3-mini".
  if (/^o\d/.test(lower[0])) return base + formatTag(tag);

  return tokens.map(titleWord).join(" ") + formatTag(tag);
}

/** Models grouped by provider, in a stable provider order. */
export function groupModelsByProvider(models: string[]): Array<{ provider: ModelProvider; models: string[] }> {
  const groups = new Map<ModelProvider["id"], { provider: ModelProvider; models: string[] }>();
  for (const id of models) {
    const provider = modelProvider(id);
    const group = groups.get(provider.id) ?? { provider, models: [] };
    group.models.push(id);
    groups.set(provider.id, group);
  }
  return PROVIDER_ORDER.flatMap((pid) => {
    const group = groups.get(pid);
    return group ? [group] : [];
  });
}
