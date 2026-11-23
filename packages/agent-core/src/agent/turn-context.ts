/**
 * Per-turn context: things Rye knows that change from one message to the next
 * (the time, knowledge-base notes found for this message, one-off results).
 *
 * These ride along with the user's message instead of living in the system
 * prompt, so the system prompt and every earlier message stay byte-identical
 * between turns. Providers can then reuse their cached prompt prefix, and the
 * Claude harness can keep its session instead of restarting it.
 */

import type { Message } from "@earendil-works/pi-ai";

const OPEN = "<rye_context>";
const CLOSE = "</rye_context>";
const INTRO = "Added by Rye for this turn; the user did not write it.";
const BLOCK_RE = /\n*<rye_context>[\s\S]*?<\/rye_context>/g;
const CHUNK_KEY_RE = /\((kn_[a-z0-9]+#\d+),/g;

export interface TurnContextParts {
  now?: Date;
  timeZone?: string;
  /** Short one-off notes, e.g. the outcome of an approval the user just answered. */
  notes?: string[];
  /** Already-formatted knowledge hits (KnowledgeStore.formatHitsForPrompt). */
  knowledge?: string;
}

/** "Mon, Nov 23, 2026, 14:03 (America/New_York); UTC 2026-11-23T19:03Z" */
export function formatNow(now: Date, timeZone: string): string {
  const local = now.toLocaleString("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${local} (${timeZone}); UTC ${now.toISOString().slice(0, 16)}Z`;
}

export function buildTurnContext(parts: TurnContextParts): string {
  const now = parts.now ?? new Date();
  const timeZone = parts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sections = [`${INTRO}\nCurrent date/time: ${formatNow(now, timeZone)}`];
  for (const note of parts.notes ?? []) if (note.trim()) sections.push(note.trim());
  if (parts.knowledge?.trim()) sections.push(parts.knowledge.trim());
  return `${OPEN}\n${sections.join("\n\n")}\n${CLOSE}`;
}

/** The user's text with Rye's context after it, as sent to the model and kept in history. */
export function attachTurnContext(userMessage: string, context: string): string {
  return context ? `${userMessage}\n\n${context}` : userMessage;
}

/** What the user actually typed. */
export function stripTurnContext(text: string): string {
  return text.replace(BLOCK_RE, "").trimEnd();
}

const userText = (m: Message): string | null =>
  m.role !== "user" ? null : typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");

/** Knowledge chunks already shown in this conversation, so each is sent once. */
export function shownChunkKeys(history: Message[]): Set<string> {
  const keys = new Set<string>();
  for (const m of history) {
    const text = userText(m);
    if (!text || !text.includes(OPEN)) continue;
    for (const block of text.match(BLOCK_RE) ?? []) {
      for (const hit of block.matchAll(CHUNK_KEY_RE)) keys.add(hit[1]);
    }
  }
  return keys;
}

/** The last thing the user typed before this turn, skipping Rye's own bracketed notes and summaries. */
export function previousUserText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const text = userText(history[i]);
    if (text === null) continue;
    const typed = stripTurnContext(text).trim();
    if (typed && !typed.startsWith("[")) return typed;
  }
  return "";
}
