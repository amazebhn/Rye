/**
 * Names for a new code session: its chat title and the words of its branch (`rye/<words>-<id>`).
 *
 * The title comes from the "Titles & step labels" model when it answers in time (`suggestTitle` in
 * agent/loop.ts, wired in code/service.ts), else from the task itself: `<repo>: <a few of its words>`.
 * The branch words come from the title with filler and the repo's name taken out, so a task like
 * "Let's see what additional fingerprinting is available" gives `rye/fingerprinting-…`, never
 * `rye/let-s-see-what-additional-…`. Existing sessions keep the names they were given.
 */

/** Words that say nothing about the work: dropped from branch names and from the fallback title. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  // Asking and hedging.
  "lets", "let", "see", "what", "please", "pls", "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "you", "your", "i", "im", "ive", "me", "my", "we", "us", "our", "want", "wanna", "need", "like", "try", "help", "think",
  "maybe", "just", "also", "really", "actually", "kindly", "hey", "hi", "thanks", "ok", "okay", "so", "now", "then",
  "look", "looking", "check", "find", "out", "figure", "know", "tell", "go", "get", "make", "do", "does", "did",
  "add", "adding", "implement", "some", "any", "additional", "more", "other", "available", "possible",
  // Grammar.
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "for", "in", "on", "at", "by", "with", "from", "into", "onto",
  "about", "as", "up", "it", "its", "this", "that", "these", "those", "there", "here", "is", "are", "was", "were", "be",
  "been", "being", "am", "has", "have", "had", "which", "who", "how", "why", "when", "where", "all", "each", "every",
  "beyond", "than", "too", "very", "not", "no",
]);

/** Most words a branch name keeps (the meaningful ones, in order). */
export const BRANCH_WORDS = 4;
/** Most characters of words before the `-<id>` tail. */
const BRANCH_CHARS = 40;
/** Most words of a title. */
export const TITLE_WORDS = 6;

/** Lowercase ASCII words: accents folded, apostrophes closed up ("let's" → "lets"), everything else a break. */
function asciiWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\w)['’](\w)/g, "$1$2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The words of a name for `text`, filler and `drop` (the repo's name) taken out. */
function meaningful(text: string, drop: readonly string[] = []): string[] {
  const dropped = new Set(drop.flatMap((d) => asciiWords(d)));
  return asciiWords(text).filter((w) => !FILLER_WORDS.has(w) && !dropped.has(w));
}

/**
 * `please add a dark mode toggle to settings` → `dark-mode-toggle-settings`: lowercase, hyphenated, at
 * most four meaningful words, filler (and `drop`, e.g. the repo's name) removed. `session` when nothing
 * is left. Always matches `SLUG_RE` once the `-<id>` tail is added.
 */
export function branchSlug(text: string, drop: readonly string[] = []): string {
  let out = "";
  for (const w of meaningful(text, drop).slice(0, BRANCH_WORDS)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > BRANCH_CHARS) {
      if (!out) out = w.slice(0, BRANCH_CHARS);
      break;
    }
    out = next;
  }
  return out || "session";
}

/**
 * "Fraud Fingerprinting Signals" → "Fraud fingerprinting signals"; only when the words were title-cased
 * (every word capitalised but small ones like "for"), so names and acronyms in a sentence-case title stay.
 */
function sentenceCase(words: string[]): string[] {
  const titleCased = words.length > 1 && words.every((w) => /^[A-Z][a-z]/.test(w) || !/[a-z]/i.test(w) || FILLER_WORDS.has(w));
  const out = titleCased ? words.map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)) : words;
  return out.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w));
}

/**
 * A model's answer as a session title: its first line, without quotes, a "Title:" lead, markdown or end
 * punctuation, sentence case, at most six words. Null when nothing usable is left.
 */
export function cleanAiTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const text = line
    .replace(/^(?:title|session title)\s*:\s*/i, "")
    .replace(/[*_`#]/g, "")
    .replace(/^["'“”‘’\s]+|["'“”‘’.!?:;,\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(" ").filter(Boolean).slice(0, TITLE_WORDS);
  if (words.length === 0 || !/[\p{L}\p{N}]/u.test(text)) return null;
  const title = sentenceCase(words).join(" ");
  return title.length > 80 ? null : title;
}

/**
 * The title when no model names the session: `<repo>: <the task's meaningful words>` (filler dropped, at
 * most six words, sentence case), or `<repo>: <the task's start>` when the task is all filler.
 */
export function fallbackTitle(repo: string, task: string): string {
  const line = task.trim().split("\n")[0].trim().replace(/\s+/g, " ");
  // The task's own words (case kept), filler skipped.
  const kept = line
    .split(" ")
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w && asciiWords(w).some((a) => !FILLER_WORDS.has(a)))
    .slice(0, TITLE_WORDS);
  const short = kept.length > 0 ? sentenceCase(kept).join(" ") : line.length > 40 ? `${line.slice(0, 37).trimEnd()}…` : line;
  return short ? `${repo}: ${short}` : `${repo}: Code session`;
}

/** The prompt that asks the title model for a session title. */
export function titleInstruction(): string {
  return (
    "Write a title for this coding task in 2-6 words, in sentence case (capitalise only the first word and proper names). " +
    "Name the work itself, not the request: no \"Let's\", \"Please\" or \"Help me\". No punctuation, no quotes. Just the title."
  );
}

/** The named model's answer within `ms`, or null (timed out, failed, or nothing usable). Aborts the request when it gives up. */
export async function nameWithin(
  name: (signal: AbortSignal) => Promise<string | null>,
  ms: number,
): Promise<string | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, ms);
  });
  try {
    const raw = await Promise.race([name(ctrl.signal).catch(() => null), timeout]);
    return cleanAiTitle(raw);
  } finally {
    clearTimeout(timer);
  }
}
