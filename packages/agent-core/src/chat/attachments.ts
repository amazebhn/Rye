/**
 * Files attached to chat messages: images, PDFs and text files.
 *
 * Each upload gets an id (`att_…`), its bytes on disk under `attachments/` in
 * the data directory, and a row in `attachments/attachments.db` with what Rye
 * knows about it: its kind, the text read from a PDF or text file, and for an
 * image a short description and tags written by a local vision model in the
 * background. Messages refer to attachments by id; the files are never put in
 * chats.db. An attachment no message refers to is deleted after a day
 * (`prune`), so one uploaded and never sent, or whose chat was deleted, goes.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { DATA_DIR } from "../config.js";
import { sniffImage } from "../agents/avatars.js";

export type AttachmentKind = "image" | "pdf" | "text";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  created_at: number;
  /** PDFs: page count. */
  pages: number | null;
  /** PDFs and text files: characters of text read from it. */
  chars: number | null;
  /** Images: a one or two sentence description, once the vision model has written it. */
  caption: string | null;
  tags: string[];
  /** Why the file's content can't be read, when it can't (a scanned PDF, no PDF reader installed). */
  note: string | null;
}

export const MAX_ATTACHMENT_BYTES: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  text: 2 * 1024 * 1024,
};
/** Text kept from one file; more than any model is shown at once. */
const MAX_TEXT_CHARS = 500_000;
const ID_RE = /^att_[a-z0-9]{16}$/;

const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;

const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".sql": "application/sql",
};

export type PdfReader = (path: string) => Promise<{ text: string; pages: number } | { error: string }>;
export type ImageCaptioner = (image: { data: string; mimeType: string }) => Promise<{ caption: string; tags: string[] } | null>;

/** A file name safe to show and store: no folders, no control characters, not too long. */
export function cleanName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "file").slice(0, 200);
}

/** Whether `bytes` are text: valid UTF-8 with no NUL bytes. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** What the file is, judged by its bytes (never by what the browser claimed). */
export function classify(name: string, bytes: Uint8Array): { kind: AttachmentKind; mime: string; ext: string } | null {
  const image = sniffImage(bytes);
  if (image) return { kind: "image", mime: IMAGE_MIME[image], ext: image };
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  if (asText(bytes) !== null) {
    const ext = extname(name).toLowerCase();
    return { kind: "text", mime: TEXT_MIME[ext] ?? "text/plain", ext: "txt" };
  }
  return null;
}

/** Read a PDF's text with poppler's pdftotext, when it is installed. */
export const readPdfWithPdftotext: PdfReader = async (path) => {
  const bin = Bun.which("pdftotext") ?? ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"].find((p) => existsSync(p));
  if (!bin) return { error: "Rye can't read PDF text here: pdftotext isn't installed (on a Mac: brew install poppler)." };
  try {
    const proc = Bun.spawn([bin, "-layout", "-enc", "UTF-8", path, "-"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const [text, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return { error: `The PDF couldn't be read (${err.trim().split("\n")[0] || `pdftotext exit ${code}`}).` };
    // pdftotext ends every page with a form feed.
    const pages = Math.max(1, (text.match(/\f/g) ?? []).length);
    return { text: text.replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim(), pages };
  } catch (err) {
    return { error: `The PDF couldn't be read (${err instanceof Error ? err.message : String(err)}).` };
  }
};

interface Row {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  ext: string;
  created_at: number;
  pages: number | null;
  chars: number | null;
  text: string | null;
  caption: string | null;
  tags: string;
  note: string | null;
}

const toAttachment = (r: Row): Attachment => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  kind: r.kind,
  size: r.size,
  created_at: r.created_at,
  pages: r.pages,
  chars: r.chars,
  caption: r.caption,
  tags: JSON.parse(r.tags || "[]") as string[],
  note: r.note,
});

export class AttachmentStore {
  private readonly db: Database;
  private readonly readPdf: PdfReader;
  private captioner: ImageCaptioner | null;
  private captionQueue: Promise<void> = Promise.resolve();
  /** Called when an image's description arrives, so search can pick it up. */
  onDescribed: ((att: Attachment) => void) | null = null;

  constructor(
    readonly dir = join(DATA_DIR, "attachments"),
    opts: { readPdf?: PdfReader; captioner?: ImageCaptioner | null } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "attachments.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        ext        TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        pages      INTEGER,
        chars      INTEGER,
        text       TEXT,
        caption    TEXT,
        tags       TEXT NOT NULL DEFAULT '[]',
        note       TEXT
      );
    `);
    this.readPdf = opts.readPdf ?? readPdfWithPdftotext;
    this.captioner = opts.captioner ?? null;
  }

  setCaptioner(captioner: ImageCaptioner | null): void {
    this.captioner = captioner;
  }

  private path(row: Pick<Row, "id" | "ext">): string {
    return join(this.dir, `${row.id}.${row.ext}`);
  }

  /** Store an upload. PDF text is read before this returns; an image's description follows in the background. */
  async add(rawName: string, bytes: Uint8Array): Promise<Attachment | { error: string }> {
    if (bytes.length === 0) return { error: "The file is empty." };
    const name = cleanName(rawName);
    const type = classify(name, bytes);
    if (!type) return { error: `${name}: Rye can read images (PNG, JPEG, GIF, WebP), PDFs and text files.` };
    const limit = MAX_ATTACHMENT_BYTES[type.kind];
    if (bytes.length > limit) return { error: `${name} is larger than ${limit / 1024 / 1024} MB.` };

    const id = `att_${randomBytes(8).toString("hex")}`;
    const row: Row = {
      id, name, mime: type.mime, kind: type.kind, size: bytes.length, ext: type.ext, created_at: Date.now(),
      pages: null, chars: null, text: null, caption: null, tags: "[]", note: null,
    };
    writeFileSync(this.path(row), bytes);

    if (type.kind === "text") {
      const text = asText(bytes) ?? "";
      row.text = text.slice(0, MAX_TEXT_CHARS);
      row.chars = text.length;
    } else if (type.kind === "pdf") {
      const read = await this.readPdf(this.path(row));
      if ("error" in read) row.note = read.error;
      else {
        row.pages = read.pages;
        row.chars = read.text.length;
        row.text = read.text.slice(0, MAX_TEXT_CHARS);
        if (read.text.trim().length < 20) row.note = "This PDF has no text layer (it is probably scanned), so its pages can't be read as text.";
      }
    }

    this.db
      .query(
        `INSERT INTO attachments (id, name, mime, kind, size, ext, created_at, pages, chars, text, caption, tags, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.mime, row.kind, row.size, row.ext, row.created_at, row.pages, row.chars, row.text, row.caption, row.tags, row.note);

    if (type.kind === "image") this.describeLater(row.id);
    return toAttachment(row);
  }

  private row(id: string): Row | null {
    if (!ID_RE.test(id)) return null;
    return (this.db.query("SELECT * FROM attachments WHERE id = ?").get(id) as Row | null) ?? null;
  }

  get(id: string): Attachment | null {
    const r = this.row(id);
    return r ? toAttachment(r) : null;
  }

  /** The stored file, for serving. */
  file(id: string): { path: string; mime: string; name: string; kind: AttachmentKind } | null {
    const r = this.row(id);
    if (!r) return null;
    const path = this.path(r);
    return existsSync(path) ? { path, mime: r.mime, name: r.name, kind: r.kind } : null;
  }

  /** Text read from a PDF or text file. */
  text(id: string): string | null {
    return this.row(id)?.text ?? null;
  }

  /** An image's bytes as base64, for a model that can see. */
  image(id: string): { data: string; mimeType: string } | null {
    const r = this.row(id);
    if (!r || r.kind !== "image") return null;
    const path = this.path(r);
    if (!existsSync(path)) return null;
    return { data: readFileSync(path).toString("base64"), mimeType: r.mime };
  }

  /** What search should find a message by: the file's name, an image's description and tags, the start of its text. */
  searchText(id: string): string {
    const r = this.row(id);
    if (!r) return "";
    const tags = JSON.parse(r.tags || "[]") as string[];
    return [r.name, r.caption ?? "", tags.join(" "), (r.text ?? "").slice(0, 2000)].filter(Boolean).join("\n");
  }

  /** Write an image's description in the background, one image at a time. */
  describeLater(id: string): void {
    const captioner = this.captioner;
    if (!captioner) return;
    this.captionQueue = this.captionQueue.then(async () => {
      const image = this.image(id);
      if (!image) return;
      try {
        const described = await captioner(image);
        if (!described || !this.row(id)) return;
        this.db.query("UPDATE attachments SET caption = ?, tags = ? WHERE id = ?").run(described.caption, JSON.stringify(described.tags), id);
        const att = this.get(id);
        if (att) this.onDescribed?.(att);
      } catch (err) {
        console.warn(`[attachments] describing ${id} failed:`, err instanceof Error ? err.message : err);
      }
    });
  }

  /** Images still without a description (written before a vision model was available), newest first. */
  undescribed(limit = 20): string[] {
    return (this.db.query("SELECT id FROM attachments WHERE kind = 'image' AND caption IS NULL ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ id: string }>).map((r) => r.id);
  }

  /** Wait for descriptions already queued (tests). */
  idle(): Promise<void> {
    return this.captionQueue;
  }

  remove(id: string): boolean {
    const r = this.row(id);
    if (!r) return false;
    rmSync(this.path(r), { force: true });
    this.db.query("DELETE FROM attachments WHERE id = ?").run(id);
    return true;
  }

  /** Delete attachments no message refers to, once they are older than `graceMs` (a fresh upload may not be sent yet). */
  prune(referenced: ReadonlySet<string>, graceMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
    const old = this.db.query("SELECT id FROM attachments WHERE created_at < ?").all(now - graceMs) as Array<{ id: string }>;
    let removed = 0;
    for (const { id } of old) if (!referenced.has(id) && this.remove(id)) removed++;
    return removed;
  }

  close(): void {
    this.db.close();
  }
}

/** Ids of attachments mentioned in `text` (message JSON, a tool argument). */
export function attachmentIdsIn(text: string): string[] {
  return [...new Set(text.match(/\batt_[a-z0-9]{16}\b/g) ?? [])];
}

export const isAttachmentId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);
