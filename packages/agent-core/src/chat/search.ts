/**
 * Search over saved conversations: chat titles and the text of every message.
 *
 * Plain substring matching on purpose. The whole history is a few hundred chats
 * held in memory, results need to update as the user types (so "repl" must find
 * "replication"), and exact identifiers such as PAY-1234 or mysql-ro-01 are what
 * people look for most.
 */

import type { ChatHistoryRecord } from "./store.js";

export interface ChatMessageMatch {
  /** Position of the message in the chat's message list. */
  index: number;
  role: "user" | "assistant";
  /** A short excerpt around the first matched term. */
  snippet: string;
  /** Found by meaning (embedding similarity), not by its words; the excerpt is the start of the message. */
  related?: boolean;
  /**
   * Text in the message that stood in for a search term without being it: another
   * form of the word ("lagging" for "lag") or the correct spelling of a typo.
   */
  matched?: string[];
}

export interface ChatSearchHit {
  chatId: string;
  title: string;
  updatedAt: number;
  agentId?: string;
  folderId?: string;
  titleMatch: boolean;
  /** Best-matching messages first, at most `maxMessagesPerChat`. */
  matches: ChatMessageMatch[];
  /** How many messages in the chat matched at all. */
  matchCount: number;
  /** The chat contains none of the words; it is here because a message means something similar. */
  related?: boolean;
  /** Search terms this chat does not contain: it matched most of the query, not all of it. */
  missing?: string[];
}

export interface ChatSearchOptions {
  /** Chats returned. */
  limit?: number;
  maxMessagesPerChat?: number;
  /** Leave this chat out (the agent searching from inside it). */
  excludeChatId?: string;
  excludeSessionId?: string;
  /** Corrected spellings to accept for a term, e.g. { replcation: ["replication"] }. */
  variants?: Record<string, readonly string[]>;
}

const MAX_TERMS = 8;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 140;

/** Lower-cased search terms: words, plus "quoted phrases" kept whole. */
export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (m[1] ?? m[2]).replace(/\s+/g, " ").trim();
    if (term && term !== '"' && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, MAX_TERMS);
}

/**
 * How many of a query's terms a chat must contain to be returned: all of one,
 * one of two, then about three in five (2 of 3, 3 of 4, 3 of 5, 4 of 6).
 * Chats with every term are always listed first.
 */
export function requiredTerms(count: number): number {
  return count <= 2 ? Math.min(count, 1) : Math.ceil(count * 0.6);
}

const FILLER = new Set(
  ("a an and are as at be but by can did do does for from had has have how i if in is it its me my no not of on or our so than that the " +
    "their them then there these they this to up us was we were what when where which who why will with would you your").split(" "),
);

/** A term that says something about the topic. A partial match resting only on filler words isn't one. */
export function isDistinctive(term: string): boolean {
  return term.length >= 3 && !FILLER.has(term);
}

/** The distinct lower-cased words of a text (runs of letters and digits). */
export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/**
 * A word reduced to a rough root, so different forms of it compare equal:
 * lagging/lagged/lags → lag, queries → query, caching/cached/cache → cach.
 * Deliberately light: it only undoes common English endings.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  const undouble = (s: string) => (s.length > 3 && s.at(-1) === s.at(-2) && !"aeiouls".includes(s.at(-1)!) ? s.slice(0, -1) : s);
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ing") && w.length > 5) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4) w = undouble(w.slice(0, -2));
  else if (/(s|x|z|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/**
 * Edit distance between two words, counting a swap of neighbouring letters as
 * one edit. Stops early and returns `max + 1` once the distance must exceed `max`.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, previous2[j - 2] + 1);
      current.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    previous2 = previous;
    previous = current;
  }
  return previous[b.length];
}

/** How many typos a word of this length may have and still count: none when short, one, then two. */
export function typoBudget(word: string): number {
  return word.length < 4 ? 0 : word.length < 8 ? 1 : 2;
}

/**
 * Where a search term is satisfied in a text: exactly (as written, anywhere),
 * as one of its corrected spellings, or as another form of the same word.
 * Returns the text that matched, for excerpts and highlighting.
 */
function findTerm(lower: string, words: () => string[], term: string, variants: readonly string[]): { text: string; exact: boolean } | null {
  if (lower.includes(term)) return { text: term, exact: true };
  for (const variant of variants) if (lower.includes(variant)) return { text: variant, exact: false };
  // A phrase is matched as written or not at all.
  if (term.includes(" ")) return null;
  const root = stem(term);
  for (const word of words()) if (stem(word) === root) return { text: word, exact: false };
  return null;
}

interface StoredMessage {
  role: "user" | "assistant";
  text: string;
}

/** The searchable text of a stored UI message: what the user typed or the reply shown, not tool output. */
export function messageText(raw: unknown): StoredMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as { role?: unknown; content?: unknown };
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) return null;
  return { role: m.role, text: m.content };
}

/** An excerpt of `text` around the earliest matched term, on one line. */
export function snippetAround(text: string, terms: string[]): string {
  // Excerpts are shown as plain text, so Markdown marks (bold, code ticks, headings, quotes, bullets) are dropped.
  const plain = text
    .replace(/```[\w-]*\n?/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, "");
  const flat = plain.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const positions = terms.map((t) => lower.indexOf(t)).filter((p) => p >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  // Start on a word boundary when cutting into the middle of the text.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  const end = Math.min(flat.length, first + SNIPPET_AFTER);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function searchChats(chats: readonly ChatHistoryRecord[], query: string, opts: ChatSearchOptions = {}): ChatSearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const limit = opts.limit ?? 20;
  const perChat = opts.maxMessagesPerChat ?? 3;
  const phrase = terms.join(" ");
  const required = requiredTerms(terms.length);

  const scored: Array<{ hit: ChatSearchHit; score: number }> = [];
  for (const chat of chats) {
    if (chat.id === opts.excludeChatId || (opts.excludeSessionId && chat.sessionId === opts.excludeSessionId)) continue;
    const variantsOf = (term: string) => opts.variants?.[term] ?? [];
    const title = chat.title.toLowerCase();
    let titleWords: string[] | undefined;
    const found = new Set(terms.filter((t) => findTerm(title, () => (titleWords ??= wordsOf(title)), t, variantsOf(t)) !== null));
    const titleTerms = found.size;

    const messages: Array<ChatMessageMatch & { score: number }> = [];
    chat.messages.forEach((raw, index) => {
      const message = messageText(raw);
      if (!message) return;
      const lower = message.text.toLowerCase();
      // Split into words only if some term isn't there as written.
      let words: string[] | undefined;
      const hits = terms.flatMap((term) => {
        const at = findTerm(lower, () => (words ??= wordsOf(lower)), term, variantsOf(term));
        return at ? [{ term, ...at }] : [];
      });
      if (hits.length === 0) return;
      hits.forEach((h) => found.add(h.term));
      // A message holding every term beats several that hold one each; the words in order beat both.
      // A term found as written counts a little more than one found as another form or spelling.
      const score =
        hits.reduce((sum, h) => sum + (h.exact ? 1 : 0.8), 0) + (hits.length === terms.length ? 2 : 0) + (terms.length > 1 && lower.includes(phrase) ? 3 : 0);
      const matched = [...new Set(hits.map((h) => h.text))];
      const other = matched.filter((text) => !terms.includes(text));
      messages.push({ index, role: message.role, snippet: snippetAround(message.text, matched), ...(other.length ? { matched: other } : {}), score });
    });

    // Most of the terms have to appear somewhere in the chat (title or any message).
    if (found.size < required) continue;
    const missing = terms.filter((t) => !found.has(t));
    // A chat missing some terms has to have a real word among the ones it does contain, not only filler.
    if (missing.length > 0 && ![...found].some(isDistinctive)) continue;
    messages.sort((a, b) => b.score - a.score || b.index - a.index);
    scored.push({
      // Chats with every term always outrank partial ones; among partial ones, more terms found wins.
      score: found.size * 1000 + (missing.length === 0 ? 100_000 : 0) + (messages[0]?.score ?? 0) * 10 + titleTerms * 6 + (titleTerms === terms.length ? 8 : 0),
      hit: {
        chatId: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt,
        ...(chat.agentId ? { agentId: chat.agentId } : {}),
        ...(chat.folderId ? { folderId: chat.folderId } : {}),
        titleMatch: titleTerms > 0,
        matches: messages.slice(0, perChat).map(({ score: _score, ...match }) => match),
        matchCount: messages.length,
        ...(missing.length ? { missing } : {}),
      },
    });
  }

  scored.sort((a, b) => b.score - a.score || b.hit.updatedAt - a.hit.updatedAt);
  return scored.slice(0, limit).map((s) => s.hit);
}
