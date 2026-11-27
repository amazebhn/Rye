/**
 * Chat kinds on the server (docs/design/code-sessions.md §4.2). A chat's kind (`chats.kind`,
 * server-owned) decides what `POST /chat/` does with a message: a plain `chat` takes today's path
 * in server.ts, unchanged; another kind registers a `ChatKindServer` here and gets the turn.
 *
 * `kindChatTurn` is the whole of the dispatch: it answers only for a request naming a `chat_id`
 * whose stored kind has a registered server, and returns null for everything else, so a normal
 * chat never sees a difference. Deleting a chat of another kind calls its `onRemove` (for code:
 * archive the session; work is never deleted), through `ChatStore.onRemoveKind`.
 */

import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import type { ChatKind, SSEEvent } from "@rye/shared";
import { parseContextRefs, REFERENCES_ERROR, type QuoteRef } from "../agent/references.js";
import { codeErrorResponse, CodeError } from "../code/runner.js";
import type { CodeService } from "../code/service.js";
import type { ChatKindServer, ChatKindTurnInput } from "../code/types.js";
import type { Attachment } from "./attachments.js";
import type { ChatHistoryRecord, ChatStore } from "./store.js";

/** `ChatKindTurnInput` plus the client's turn id (the user message's id) and the excerpts the user pointed at. */
export type KindTurnInput = ChatKindTurnInput & { turnId?: string; quotes?: QuoteRef[] };

export class ChatKindRegistry {
  private readonly kinds = new Map<ChatKind, ChatKindServer>();

  register(kind: ChatKindServer): void {
    if (kind.id === "chat") throw new Error("The plain chat kind is server.ts's own path; it isn't registered.");
    this.kinds.set(kind.id, kind);
  }

  get(id: ChatKind | undefined): ChatKindServer | undefined {
    return id ? this.kinds.get(id) : undefined;
  }

  /** The kind server for a stored chat of another kind; null for a plain chat or an unknown id. */
  forChat(chats: Pick<ChatStore, "kindFields">, chatId: unknown): ChatKindServer | null {
    if (typeof chatId !== "string" || !chatId || chatId.length > 128) return null;
    return this.get(chats.kindFields(chatId).kind) ?? null;
  }

  /** For `ChatStore.onRemoveKind`. */
  onRemove(chat: ChatHistoryRecord): void {
    void Promise.resolve(this.get(chat.kind)?.onRemove?.(chat)).catch((err) => console.error(`[chat] cleanup for ${chat.kind} chat ${chat.id} failed:`, err));
  }
}

/** The `code` kind: a message starts or steers the session's run; the stream follows its log until the turn ends. */
export function codeChatKind(service: Pick<CodeService, "enabled" | "runner">): ChatKindServer {
  return {
    id: "code",
    async *run(chat, input, ctx) {
      if (!service.enabled()) throw new CodeError("Code sessions are turned off ([code] in config.toml).", "not_found");
      const runner = service.runner();
      const turn = input as KindTurnInput;
      const { sessionId, after } = await runner.send(chat.id, {
        message: turn.message,
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        ...(turn.attachments.length ? { attachments: turn.attachments.map((a) => a.id) } : {}),
        ...(turn.quotes?.length ? { quotes: turn.quotes } : {}),
      });
      yield { type: "session", session_id: sessionId };
      for await (const entry of runner.subscribe(sessionId, after, ctx.signal, { untilTurnEnds: true })) yield entry.event;
    },
    onRemove(chat) {
      if (!service.enabled() && !service.runner().sessionForChat(chat.id)) return;
      return service.runner().onChatRemoved(chat.id);
    },
  };
}

interface ChatTurnBody {
  chat_id?: unknown;
  message?: unknown;
  turn_id?: unknown;
  model?: unknown;
  attachments?: unknown;
  /** As for a plain chat; a code session takes the quotes (it has no SOPs or tool groups to load). */
  references?: unknown;
}

/**
 * `POST /chat/` for a chat of another kind: the kind's stream as SSE (`id: <seq>` when the event
 * has one). Null when the request isn't for such a chat, and server.ts carries on as before.
 * Errors before the stream starts answer with the kind's `{ error, code }`.
 */
export async function kindChatTurn(
  c: Context,
  chats: Pick<ChatStore, "kindFields" | "get">,
  kinds: ChatKindRegistry,
  body: ChatTurnBody,
  resolveAttachment: (id: string) => Attachment | null,
): Promise<Response | null> {
  const kind = kinds.forChat(chats, body.chat_id);
  if (!kind) return null;
  const chat = chats.get(body.chat_id as string);
  if (!chat) return null;
  const fail = (err: unknown) => {
    const { status, body: errBody } = codeErrorResponse(err);
    return c.json(errBody, status as 400);
  };
  let attachments: Attachment[] = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments) || body.attachments.length > 10 || !body.attachments.every((x) => typeof x === "string")) {
      return fail(new CodeError("attachments must be up to 10 attachment ids", "invalid"));
    }
    const found = body.attachments.map((id) => resolveAttachment(id as string));
    if (found.some((a) => !a)) return fail(new CodeError("Unknown attachment", "invalid"));
    attachments = found as Attachment[];
  }
  const refs = parseContextRefs(body.references);
  if (refs === null) return fail(new CodeError(REFERENCES_ERROR, "invalid"));
  const quotes = refs.filter((r): r is QuoteRef => r.type === "quote");
  const input: KindTurnInput = {
    message: typeof body.message === "string" ? body.message : "",
    attachments,
    ...(quotes.length ? { quotes } : {}),
    ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
    ...(typeof body.turn_id === "string" && body.turn_id ? { turnId: body.turn_id } : {}),
  };
  const ctrl = new AbortController();
  const events = kind.run(chat, input, { signal: ctrl.signal })[Symbol.asyncIterator]();
  // The first event is awaited here, so a refusal (busy, archived, off) is an HTTP error, not a stream.
  let first: IteratorResult<SSEEvent>;
  try {
    first = await events.next();
  } catch (err) {
    ctrl.abort();
    return fail(err);
  }
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  return honoStream(c, async (stream) => {
    // Closing this stream ends the subscription only; a code run is detached and keeps going.
    stream.onAbort(() => ctrl.abort());
    const heartbeat = setInterval(() => {
      void stream.write(": ping\n\n").catch(() => ctrl.abort());
    }, 15_000);
    const frame = (e: SSEEvent) => `${typeof e.seq === "number" ? `id: ${e.seq}\n` : ""}data: ${JSON.stringify(e)}\n\n`;
    try {
      let next = first;
      while (!next.done) {
        await stream.write(frame(next.value));
        next = await events.next();
      }
    } catch (err) {
      if (!ctrl.signal.aborted) await stream.write(frame({ type: "error", error: err instanceof Error ? err.message : String(err) })).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      ctrl.abort();
      await events.return?.(undefined).catch(() => {});
    }
  });
}
