/**
 * What the model is given for the files attached to a message.
 *
 * Every attachment gets a line in the turn's context block (kept in history):
 * its id, name and kind, an image's description and tags when known, and the
 * text of a PDF or text file, up to a budget. Images themselves go to a model
 * that can see, on the turn they were attached only; the saved session keeps
 * the text line, and the model can call read_attachment_tool to look again.
 */

import type { ImageContent, Message } from "@earendil-works/pi-ai";
import type { Attachment, AttachmentStore } from "../chat/attachments.js";

/** Text of all attachments shown in one message, and of one file within it. */
export const ATTACHMENT_TEXT_BUDGET = 24_000;
const PER_FILE_TEXT = 16_000;

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

function describedAs(att: Attachment): string {
  if (!att.caption) return "";
  return ` Description: ${att.caption}${att.tags.length ? ` Tags: ${att.tags.join(", ")}.` : ""}`;
}

/** The context note for a message's attachments, and the images to send with it. */
export function attachmentsForModel(
  items: Attachment[],
  store: Pick<AttachmentStore, "text" | "image">,
  seesImages: boolean,
): { note: string; images: ImageContent[] } {
  if (items.length === 0) return { note: "", images: [] };
  const images: ImageContent[] = [];
  let budget = ATTACHMENT_TEXT_BUDGET;
  const lines = items.map((att) => {
    const head = `- \`${att.id}\` **${att.name}**`;
    if (att.kind === "image") {
      const image = seesImages ? store.image(att.id) : null;
      if (image) images.push({ type: "image", ...image });
      const how = image
        ? "shown to you with this message only; call read_attachment_tool to look at it again later."
        : "this model can't see images, so only its description (if any) is available.";
      return `${head} — image, ${sizeLabel(att.size)}; ${how}${describedAs(att)}`;
    }
    const kind = att.kind === "pdf" ? `PDF${att.pages ? `, ${att.pages} page${att.pages === 1 ? "" : "s"}` : ""}` : "text file";
    const text = store.text(att.id) ?? "";
    if (att.note && !text.trim()) return `${head} — ${kind}, ${sizeLabel(att.size)}. ${att.note}`;
    const shown = Math.max(0, Math.min(text.length, PER_FILE_TEXT, budget));
    budget -= shown;
    const rest = text.length - shown;
    const more =
      rest > 0
        ? `\n  (First ${shown.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters. Read more with read_attachment_tool(id="${att.id}", offset=${shown}).)`
        : "";
    const body = shown > 0 ? `\n\`\`\`\`\n${text.slice(0, shown)}\n\`\`\`\`${more}` : `\n  Read it with read_attachment_tool(id="${att.id}").`;
    return `${head} — ${kind}, ${sizeLabel(att.size)}, ${(att.chars ?? text.length).toLocaleString("en-US")} characters.${body}`;
  });
  return { note: `**Files the user attached to this message:**\n${lines.join("\n")}`, images };
}

/**
 * A copy of `messages` for saving: images in user messages and tool results are dropped, their text
 * reference stays. So an image is sent on the turn it was attached (or looked at) only, and the
 * session file doesn't fill up with base64.
 */
export function withoutImages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if ((m.role !== "user" && m.role !== "toolResult") || typeof m.content === "string" || !m.content.some((b) => b.type === "image")) return m;
    const text = m.content.filter((b) => b.type === "text");
    if (m.role === "toolResult") return { ...m, content: text.length > 0 ? text : [{ type: "text" as const, text: "[image]" }] };
    return { ...m, content: text.length === 1 && text[0].type === "text" ? text[0].text : text };
  });
}

/** Whether the conversation has attachments the model may want to read again. */
export function mentionsAttachments(messages: Message[]): boolean {
  return messages.some((m) => {
    if (m.role !== "user") return false;
    const text = typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return /\batt_[a-z0-9]{16}\b/.test(text);
  });
}
