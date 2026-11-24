/**
 * Tools for looking back at earlier conversations: search them, then read one.
 */

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { messageText } from "../chat/search.js";
import type { ChatStore } from "../chat/store.js";

const READ_MESSAGES = 16;
const READ_MESSAGE_CHARS = 1500;

export const chatTools: Tool[] = [
  {
    name: "search_chats_tool",
    description:
      "Search the user's earlier conversations with Rye (titles and message text) for words, names or identifiers. " +
      "Use it when the user refers to something discussed before (\"like last time\", \"that query from yesterday\", \"what did we decide about X\") " +
      "or when a past investigation may already hold the answer. Chats containing every word come first (put an exact phrase in double quotes), " +
      "followed by chats that say something similar in other words, then chats with only some of the words. " +
      "Returns matching chats with their id, date and excerpts; call read_chat_tool to read one. The current chat is not searched.",
    parameters: Type.Object({
      query: Type.String({ description: 'Words to look for, e.g. "replication lag orders-db". Fewer, more specific words work best.' }),
      limit: Type.Optional(Type.Number({ description: "Maximum chats to return (default 5, max 10)" })),
    }),
  },
  {
    name: "read_chat_tool",
    description:
      "Read part of an earlier conversation found with search_chats_tool: the messages around a match, or the end of the chat. " +
      "Shows what the user and Rye said, not the tool output from that chat.",
    parameters: Type.Object({
      chat_id: Type.String({ description: "The chat id from search_chats_tool" }),
      message: Type.Optional(Type.Number({ description: "Message number from a search match to centre on; omit to read the last messages" })),
    }),
  },
];

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function searchChatsForAgent(store: ChatStore, args: { query: string; limit?: number }, sessionId?: string): Promise<string> {
  const limit = Math.min(Math.max(1, Math.round(args.limit ?? 5)), 10);
  const hits = await store.search(args.query ?? "", { limit, maxMessagesPerChat: 2, excludeSessionId: sessionId });
  if (hits.length === 0) return `No earlier conversations match "${args.query}". Try fewer or different words.`;
  return hits
    .map((hit) => {
      // "related": found by meaning, so the words searched for may not appear in the excerpt.
      const lines = hit.matches.map((m) => `  - message ${m.index} (${m.role === "user" ? "user" : "Rye"}${m.related ? ", related" : ""}): ${m.snippet}`);
      const more = hit.matchCount > hit.matches.length ? `  - …and ${hit.matchCount - hit.matches.length} more matching message(s)` : "";
      // A partial match: say which words it lacks, so it isn't read as covering the whole query.
      const missing = hit.missing?.length ? `  - does not mention: ${hit.missing.join(", ")}` : "";
      return [`### ${hit.title} _(chat_id: ${hit.chatId}, last active ${day(hit.updatedAt)})_`, ...lines, more, missing].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export function readChatForAgent(store: ChatStore, args: { chat_id: string; message?: number }): string {
  const chat = store.get(args.chat_id);
  if (!chat) return `No conversation with id "${args.chat_id}". Use search_chats_tool to find one.`;
  const messages = chat.messages.flatMap((raw, index) => {
    const message = messageText(raw);
    return message ? [{ index, ...message }] : [];
  });
  if (messages.length === 0) return `"${chat.title}" has no messages.`;

  // A window centred on the requested message, or the end of the chat.
  let start = Math.max(0, messages.length - READ_MESSAGES);
  if (typeof args.message === "number" && Number.isFinite(args.message)) {
    const at = messages.findIndex((m) => m.index >= args.message!);
    const centre = at === -1 ? messages.length - 1 : at;
    start = Math.max(0, Math.min(centre - Math.floor(READ_MESSAGES / 2), messages.length - READ_MESSAGES));
  }
  const shown = messages.slice(start, start + READ_MESSAGES);
  const body = shown.map((m) => {
    const text = m.text.length > READ_MESSAGE_CHARS ? `${m.text.slice(0, READ_MESSAGE_CHARS)}… [cut]` : m.text;
    return `**${m.role === "user" ? "User" : "Rye"}** (message ${m.index}):\n${text}`;
  });
  const range =
    shown.length < messages.length
      ? ` Showing messages ${shown[0].index}-${shown[shown.length - 1].index} of ${messages.length}; pass "message" to read another part.`
      : "";
  return `## ${chat.title} _(last active ${day(chat.updatedAt)})_\nAn earlier conversation, quoted for reference.${range}\n\n${body.join("\n\n")}`;
}
