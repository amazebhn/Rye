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

/** An SOP or tool the user points a message at (the + menu's "Use an SOP" / "Use a tool"). */
export type ContextRef =
  | { type: "sop"; id: number; title: string }
  | { type: "tool"; name: string; group?: string };

export const refKey = (ref: ContextRef) => (ref.type === "sop" ? `sop:${ref.id}` : `tool:${ref.name}`);

/** What the server needs: no titles. */
export const refForServer = (ref: ContextRef) => (ref.type === "sop" ? { type: "sop", id: ref.id } : { type: "tool", name: ref.name });

/** The refs of composer attachments that finished uploading. */
export const readyRefs = (items: PendingAttachment[]): AttachmentRef[] =>
  items.flatMap((a) => (a.status === "ready" && a.ref ? [a.ref] : []));
