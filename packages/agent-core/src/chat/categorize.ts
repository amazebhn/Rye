import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getSettings } from "../config.js";
import { apiKeyFor, models, resolveModel } from "../llm-provider.js";
import { resolveTaskModelId } from "../model-tiers.js";
import { MAX_FOLDER_NAME } from "./folders.js";

export const MAX_PROPOSED_FOLDERS = 8;
const MAX_TITLE_CHARS = 120;
const MAX_EXCERPT_CHARS = 300;
const DEFAULT_TIMEOUT_MS = 20_000;
// A catch-all folder just hides unfiled chats somewhere else.
const CATCH_ALL_FOLDER = /^(misc(ellaneous)?|general|others?|uncategori[sz]ed|unsorted|random|various|other (topics|chats))$/i;

export interface CategorizeChat {
  id: string;
  title: string;
  messages: unknown[];
}

/** Returns the model's raw text reply. */
export type CompleteFn = (systemPrompt: string, prompt: string, signal: AbortSignal) => Promise<string>;

export interface CategorizeOptions {
  complete?: CompleteFn;
  timeoutMs?: number;
}

// Same model and plumbing as chat titles.
const completeWithLabelsModel: CompleteFn = async (systemPrompt, prompt, signal) => {
  const settings = getSettings();
  const model = await resolveModel(settings, await resolveTaskModelId(settings, "labels"));
  const apiKey = await apiKeyFor(model);
  const result = (await models.complete(
    model,
    { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { apiKey, signal, temperature: 0, maxTokens: 1500 },
  )) as AssistantMessage;
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? `model call ${result.stopReason}`);
  return result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};

/** First user messages of a chat, whitespace-collapsed and capped. */
export function chatExcerpt(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const { role, content, kind } = m as Record<string, unknown>;
    if (role !== "user" || kind !== undefined || typeof content !== "string") continue;
    parts.push(content);
    if (parts.length === 2) break;
  }
  return parts.join(" / ").replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function chatList(chats: CategorizeChat[]): string {
  return chats
    .map((c, i) => `[${i + 1}] Title: ${oneLine(c.title, MAX_TITLE_CHARS)}\n    Excerpt: ${chatExcerpt(c.messages) || "(empty)"}`)
    .join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Maps a model reply to a folder index per chat; anything not a valid 1-based folder number becomes null. */
export function parseAssignments(text: string, chatCount: number, folderCount: number): (number | null)[] {
  const result: (number | null)[] = Array(chatCount).fill(null);
  const assignments = parseJsonObject(text)?.assignments;
  if (typeof assignments !== "object" || assignments === null || Array.isArray(assignments)) return result;
  for (const [key, value] of Object.entries(assignments)) {
    const chat = Number(key);
    if (!Number.isInteger(chat) || chat < 1 || chat > chatCount) continue;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= folderCount) result[chat - 1] = value - 1;
  }
  return result;
}

/** New folder names (deduped, capped, on top of `existing`) and a name or null per chat. */
export function parseProposal(
  text: string,
  chatCount: number,
  existing: readonly string[],
): { folders: string[]; assignments: (string | null)[] } {
  const parsed = parseJsonObject(text);
  const names = [...existing];
  const byKey = new Map(existing.map((n) => [n.toLocaleLowerCase(), n]));
  for (const raw of Array.isArray(parsed?.folders) ? parsed.folders : []) {
    if (names.length >= MAX_PROPOSED_FOLDERS || typeof raw !== "string") continue;
    const name = oneLine(raw, MAX_FOLDER_NAME);
    if (!name || /[\p{Cc}\p{Cf}]/u.test(name) || CATCH_ALL_FOLDER.test(name) || byKey.has(name.toLocaleLowerCase())) continue;
    byKey.set(name.toLocaleLowerCase(), name);
    names.push(name);
  }
  const assignments: (string | null)[] = Array(chatCount).fill(null);
  const raw = parsed?.assignments;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const chat = Number(key);
      if (!Number.isInteger(chat) || chat < 1 || chat > chatCount || typeof value !== "string") continue;
      assignments[chat - 1] = byKey.get(oneLine(value, MAX_FOLDER_NAME).toLocaleLowerCase()) ?? null;
    }
  }
  const used = new Set(assignments);
  return { folders: names.filter((n) => existing.includes(n) || used.has(n)), assignments };
}

async function run(prompt: string, systemPrompt: string, opts: CategorizeOptions): Promise<string> {
  const complete = opts.complete ?? completeWithLabelsModel;
  return complete(systemPrompt, prompt, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
}

/** Picks one of `folders` (or null) per chat. Throws on model failure or timeout. */
export async function suggestFolders(
  chats: CategorizeChat[],
  folders: readonly { id: string; name: string }[],
  opts: CategorizeOptions = {},
): Promise<(string | null)[]> {
  if (chats.length === 0 || folders.length === 0) return chats.map(() => null);
  const prompt =
    `Folders:\n${folders.map((f, i) => `${i + 1}. ${oneLine(f.name, MAX_FOLDER_NAME)}`).join("\n")}\n\n` +
    `Chats:\n${chatList(chats)}\n\n` +
    `For each chat, pick the number of the folder it clearly belongs to, or null if none fits or you are unsure. ` +
    `Many chats won't fit any folder; that's expected, and null is better than a loose fit. ` +
    `Only use the folders listed; never invent one.\n` +
    `Reply with only JSON: {"assignments": {"<chat number>": <folder number or null>}}`;
  const text = await run(prompt, "You sort chat conversations into the user's existing folders. Output only valid JSON.", opts);
  return parseAssignments(text, chats.length, folders.length).map((i) => (i === null ? null : folders[i].id));
}

/** Proposes up to MAX_PROPOSED_FOLDERS folder names (reusing `existing`) and assigns chats to them. */
export async function proposeFolders(
  chats: CategorizeChat[],
  existing: readonly string[],
  opts: CategorizeOptions = {},
): Promise<{ folders: string[]; assignments: (string | null)[] }> {
  if (chats.length === 0) return { folders: [...existing], assignments: [] };
  const prompt =
    (existing.length ? `Folders already proposed (reuse them when they fit):\n${existing.map((n) => `- ${n}`).join("\n")}\n\n` : "") +
    `Chats:\n${chatList(chats)}\n\n` +
    `Group related chats into a small set of folders (at most ${MAX_PROPOSED_FOLDERS} in total, including any already proposed). ` +
    `Folder names are 1-3 words, Title Case, describing a topic or system. ` +
    `Only create a folder for a topic that several chats share. Leave one-off chats unfiled (null); it's fine if many chats stay unfiled. ` +
    `Never make a catch-all folder such as Misc, General or Other.\n` +
    `Reply with only JSON: {"folders": ["<name>", ...], "assignments": {"<chat number>": "<folder name>" or null}}`;
  const text = await run(prompt, "You organize chat conversations into a few topical folders. Output only valid JSON.", opts);
  return parseProposal(text, chats.length, existing);
}
