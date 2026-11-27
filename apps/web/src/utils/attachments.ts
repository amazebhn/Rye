/**
 * Files attached to chat messages: uploaded to the server as soon as they are
 * picked (POST /chat/attachments/), then sent with the message by id.
 */

export type AttachmentKind = "image" | "pdf" | "text";

/** An uploaded file, as stored on a message. */
export interface AttachmentRef {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  pages?: number | null;
}

/** A file in the composer: uploading, ready to send, or refused. */
export interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  ref?: AttachmentRef;
  error?: string;
  /** Local preview of an image while (and after) it uploads. */
  previewUrl?: string;
}

export const MAX_ATTACHMENTS = 10;

/** What the file picker offers: images, PDFs and text files. The server checks the bytes either way. */
export const ATTACHMENT_ACCEPT = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/*",
  ".md", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yaml", ".yml", ".xml", ".sql", ".txt", ".toml", ".ini", ".conf",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".sh", ".tf", ".html", ".css",
].join(",");

export const attachmentUrl = (id: string) => `/chat/attachments/${encodeURIComponent(id)}`;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  const res = await fetch("/chat/attachments/", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
    body: file,
  });
  const json = (await res.json().catch(() => ({}))) as Partial<AttachmentRef> & { error?: string };
  if (!res.ok || !json.id) throw new Error(json.error ?? `Upload failed (HTTP ${res.status})`);
  return { id: json.id, name: json.name ?? file.name, kind: json.kind ?? "text", mime: json.mime ?? "", size: json.size ?? file.size, pages: json.pages ?? null };
}

/** Where a quoted excerpt came from. `label` is what the chip shows ("fingerprint.js", "Rye's reply"). */
export interface QuoteSource {
  kind: "diff" | "message" | "document" | "other";
  label: string;
  path?: string;
  lines?: { start: number; end: number };
  side?: "old" | "new";
}

/** An excerpt the user selected somewhere and added to the chat (`SelectionActions`, `addContextToChat`). */
export interface QuoteContextRef {
  type: "quote";
  text: string;
  source: QuoteSource;
}

/**
 * What the user points a message at: an SOP or tool (the + menu's "Use an SOP" / "Use a tool"),
 * or a quote (text selected in a reply, a diff or a document; see utils/contextRefs.ts).
 */
export type ContextRef =
  | { type: "sop"; id: number; title: string }
  | { type: "tool"; name: string; group?: string }
  | QuoteContextRef;

/** Characters of a quote kept (the server cuts at the same length). */
export const QUOTE_CHARS = 4_000;

/** The quote's text cut to `QUOTE_CHARS`, saying how much was left out. */
export function capQuoteText(text: string): string {
  if (text.length <= QUOTE_CHARS) return text;
  return `${text.slice(0, QUOTE_CHARS)}\n...(cut: ${text.length - QUOTE_CHARS} more characters)`;
}

/** A short stable hash, so two quotes of different text never share a key. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const refKey = (ref: ContextRef): string => {
  if (ref.type === "sop") return `sop:${ref.id}`;
  if (ref.type === "tool") return `tool:${ref.name}`;
  const { source } = ref;
  const where = [source.kind, source.path ?? source.label, source.side ?? "", source.lines ? `${source.lines.start}-${source.lines.end}` : ""].join(":");
  return `quote:${where}:${hashText(ref.text)}`;
};

/** What the server needs: no titles. A quote goes whole (its text is the point). */
export const refForServer = (ref: ContextRef) => {
  if (ref.type === "sop") return { type: "sop", id: ref.id };
  if (ref.type === "tool") return { type: "tool", name: ref.name };
  return { type: "quote", text: capQuoteText(ref.text), source: ref.source };
};

/** "L12–18" / "L12": the lines a quote covers, for its chip. */
export function quoteLines(source: QuoteSource): string | null {
  if (!source.lines) return null;
  const { start, end } = source.lines;
  return start === end ? `L${start}` : `L${start}–${end}`;
}

/** The chip's name for a quote: "fingerprint.js · L12–18", or the label and the text's first words. */
export function quoteTitle(ref: QuoteContextRef): string {
  const lines = quoteLines(ref.source);
  if (lines) return `${ref.source.label} · ${lines}`;
  return ref.source.label;
}

/** The first words of a quote, one line, for its chip. */
export function quoteSnippet(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The name of any ref, for a queued message's summary or a label. */
export const refLabel = (ref: ContextRef): string =>
  ref.type === "sop" ? ref.title : ref.type === "tool" ? ref.name : quoteTitle(ref);

/** The refs of composer attachments that finished uploading. */
export const readyRefs = (items: PendingAttachment[]): AttachmentRef[] =>
  items.flatMap((a) => (a.status === "ready" && a.ref ? [a.ref] : []));
