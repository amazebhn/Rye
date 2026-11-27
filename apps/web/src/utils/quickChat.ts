/**
 * The quick chat (components/quick/QuickChat.tsx), a small floating panel over the app, can be opened
 * from anywhere: `openQuickChat` dispatches a window event that the panel (mounted once in App.tsx)
 * listens for, so callers need no access to its state. Cmd/Ctrl+J toggles it.
 */

import type { ContextRef } from "./attachments";

export const QUICK_CHAT_EVENT = "rye:quick-chat";

export interface QuickChatOptions {
  /** Added as a chip in the quick chat's composer, e.g. `quoteRef(text, source)` (utils/contextRefs.ts). */
  quote?: ContextRef;
  /** Put in the composer (after anything already typed there). */
  text?: string;
}

export interface QuickChatDetail extends QuickChatOptions {
  action: "open" | "toggle";
}

/** Opens the quick chat (it keeps its conversation), adds the quote and text if given, and focuses its composer. */
export function openQuickChat(opts: QuickChatOptions = {}): void {
  window.dispatchEvent(new CustomEvent<QuickChatDetail>(QUICK_CHAT_EVENT, { detail: { action: "open", ...opts } }));
}

/** Shows the quick chat, or hides it (keeping the conversation) when it is showing. */
export function toggleQuickChat(): void {
  window.dispatchEvent(new CustomEvent<QuickChatDetail>(QUICK_CHAT_EVENT, { detail: { action: "toggle" } }));
}
