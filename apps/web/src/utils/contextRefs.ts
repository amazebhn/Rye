/**
 * Adding context to a chat from anywhere in the app: a quote selected in a reply, a diff or a
 * document, or any other `ContextRef`. `addContextToChat` dispatches a window event; App.tsx listens
 * and adds the ref to the right chat's draft (the same list the composer's + menu fills), then
 * focuses the composer. Callers need no access to App's state.
 */

import { capQuoteText, type ContextRef, type QuoteSource } from "./attachments";

export const ADD_CONTEXT_EVENT = "rye:add-context";

export interface AddContextOptions {
  /** The chat whose draft gets the ref; the open chat's (or the new chat's) draft when left out. */
  chatId?: string;
  /** Also open that chat if it isn't the one on screen (a code session switches its own tab instead). */
  focus?: boolean;
}

export interface AddContextDetail extends AddContextOptions {
  ref: ContextRef;
}

export function addContextToChat(ref: ContextRef, opts: AddContextOptions = {}): void {
  window.dispatchEvent(new CustomEvent<AddContextDetail>(ADD_CONTEXT_EVENT, { detail: { ref, ...opts } }));
}

/** A quote ref from selected text: trimmed of blank edges and capped like the server caps it. */
export function quoteRef(text: string, source: QuoteSource) {
  return { type: "quote" as const, text: capQuoteText(text.replace(/^\s*\n|\s+$/g, "")), source };
}
