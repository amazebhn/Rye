/**
 * Upload and serve chat attachments.
 *
 *   POST /chat/attachments/   raw file bytes, with the name in X-Filename (URI-encoded)
 *   GET  /chat/attachments/:id  the file
 *
 * The custom header is required: a page on another site can't send it without
 * a CORS preflight this server refuses, so it can't drop files in here.
 */

import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore } from "./attachments.js";

const MAX_UPLOAD = Math.max(...Object.values(MAX_ATTACHMENT_BYTES));

export function attachmentRoutes(store: AttachmentStore): Hono {
  const r = new Hono();

  r.post("/", async (c) => {
    const rawName = c.req.header("x-filename");
    if (!rawName) return c.json({ error: "X-Filename header is required" }, 400);
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD) {
      return c.json({ error: `The file is larger than ${MAX_UPLOAD / 1024 / 1024} MB.` }, 413);
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
    const saved = await store.add(name, new Uint8Array(await c.req.arrayBuffer()));
    if ("error" in saved) return c.json(saved, 400);
    return c.json(saved, 201);
  });

  r.get("/:id", (c) => {
    const found = store.file(c.req.param("id"));
    if (!found) return c.json({ error: "Attachment not found" }, 404);
    // Text is always served as plain text (an attached .html must not run as a page here), and text and
    // images may not run script even when opened directly. PDFs are left to the browser's own viewer,
    // which won't render under a sandbox policy.
    const type = found.kind === "text" ? "text/plain; charset=utf-8" : found.mime;
    return c.body(readFileSync(found.path), 200, {
      "Content-Type": type,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(found.name)}`,
      ...(found.kind === "pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
      "X-Content-Type-Options": "nosniff",
      // An id always names the same bytes.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  return r;
}
