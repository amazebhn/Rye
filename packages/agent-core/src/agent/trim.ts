/**
 * Shrinks old tool output in the copy of the conversation sent to the model.
 * The persisted session keeps the full text.
 */

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";

export const OLD_TOOL_RESULT_MAX_CHARS = 2_000;
const KEEP_HEAD_CHARS = 1_200;
const RESULT_ID_RE = /\bres_[a-z0-9]{8}\b/gi;

function shrinkText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.min(KEEP_HEAD_CHARS, maxChars));
  const omitted = text.length - head.length;
  const ids = [...new Set(text.slice(head.length).match(RESULT_ID_RE) ?? [])].filter((id) => !head.includes(id));
  const refs = ids.length > 0
    ? `\nStored result id(s): ${ids.join(", ")} — query with result_query_tool / result_aggregate_tool.`
    : "";
  return `${head}\n[… ${omitted.toLocaleString("en-US")} chars omitted from an earlier tool result. Re-run the tool if you need the full output.]${refs}`;
}

/**
 * Returns a new array where tool results before the latest assistant message
 * are cut to `maxChars`. Never drops a message, so every toolCall keeps its toolResult.
 * Earlier write_artifact_tool calls lose their file body too: it is saved on disk
 * and would otherwise be resent on every call.
 */
export function shrinkOldToolResults(messages: Message[], maxChars = OLD_TOOL_RESULT_MAX_CHARS): Message[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant <= 0) return messages;

  return messages.map((msg, i) => {
    if (i >= lastAssistant) return msg;
    if (msg.role === "assistant") return shrinkArtifactArgs(msg, maxChars);
    if (msg.role !== "toolResult") return msg;
    const textLen = msg.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
    if (textLen <= maxChars) return msg;
    const text = msg.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    const others = msg.content.filter((c) => c.type !== "text");
    return { ...msg, content: [{ type: "text", text: shrinkText(text, maxChars) }, ...others] } satisfies ToolResultMessage;
  });
}

function shrinkArtifactArgs(msg: AssistantMessage, maxChars: number): AssistantMessage {
  let changed = false;
  const content = msg.content.map((block) => {
    if (block.type !== "toolCall" || block.name !== "write_artifact_tool") return block;
    const body = block.arguments.content;
    if (typeof body !== "string" || body.length <= maxChars) return block;
    changed = true;
    const note = `[${body.length.toLocaleString("en-US")} chars saved to the file; use read_artifact_tool to read it]`;
    return { ...block, arguments: { ...block.arguments, content: note } };
  });
  return changed ? { ...msg, content } : msg;
}
