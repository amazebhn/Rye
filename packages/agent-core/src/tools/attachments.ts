/**
 * read_attachment_tool: read a file the user attached to a message again — more of a
 * PDF's or text file's text, or an image (the agent loop adds the image itself for a
 * model that can see; see agent/loop.ts).
 */

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AttachmentStore } from "../chat/attachments.js";

export const READ_ATTACHMENT_TOOL = "read_attachment_tool";
const DEFAULT_LENGTH = 16_000;
const MAX_LENGTH = 40_000;

export const attachmentTools: Tool[] = [
  {
    name: READ_ATTACHMENT_TOOL,
    description:
      "Read a file the user attached to a message in this chat, by its id (att_…, listed where it was attached). " +
      "For a PDF or text file, returns its text from `offset`; for an image, shows you the image again (when you can see images) with its description.",
    parameters: Type.Object({
      id: Type.String({ description: "The attachment id, e.g. att_3f9c0a1b2d4e5f60" }),
      offset: Type.Optional(Type.Number({ description: "Character to start from in a PDF or text file (default 0)" })),
      length: Type.Optional(Type.Number({ description: `Characters to return (default ${DEFAULT_LENGTH}, max ${MAX_LENGTH})` })),
    }),
  },
];

export function readAttachmentForAgent(store: AttachmentStore, args: { id: string; offset?: number; length?: number }): string {
  const att = store.get(String(args.id ?? ""));
  if (!att) return `Error: no attachment with id "${args.id}".`;
  if (att.kind === "image") {
    const described = att.caption ? `Description: ${att.caption}${att.tags.length ? `\nTags: ${att.tags.join(", ")}` : ""}` : "No description has been written for it yet.";
    return `Image ${att.name} (${att.id}).\n${described}`;
  }
  const text = store.text(att.id) ?? "";
  if (!text) return `${att.name}: ${att.note ?? "no text could be read from this file."}`;
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const length = Math.min(MAX_LENGTH, Math.max(1, Math.floor(Number(args.length) || DEFAULT_LENGTH)));
  if (offset >= text.length) return `${att.name} has ${text.length.toLocaleString("en-US")} characters; offset ${offset} is past the end.`;
  const part = text.slice(offset, offset + length);
  const end = offset + part.length;
  const next = end < text.length ? `\n\n(Characters ${offset}–${end} of ${text.length}. Continue with offset=${end}.)` : `\n\n(End of file; characters ${offset}–${end} of ${text.length}.)`;
  return `${att.name}${att.pages ? ` (${att.pages} pages)` : ""}:\n${part}${next}`;
}
