import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodeSessionDetail, CodeSessionStatus, PendingPrompt } from "@rye/shared";
import { refForServer, type AttachmentRef, type ContextRef } from "../../utils/attachments";
import type { ChatRecord, RenderMessage } from "../../utils/types";
import { codeApi, CodeApiError, noteCodeStatus, refreshCodeSessions, sendCodeMessage, subscribeCodeEvents } from "../../utils/codeApi";
import { useSyncRefresh } from "../../utils/sync";
import { assemble, EMPTY_TRANSCRIPT, foldCodeEvent, type CodeTranscript, type PendingUserMessage } from "./codeEvents";

// What a tab has rebuilt from a session's log, so reopening the chat (or reloading the tab) resumes with
// `?after=<seq>` instead of replaying the whole log. Session storage: per tab, survives a reload.
const memory = new Map<string, CodeTranscript>();
const STORE_PREFIX = "rye.code-log.";
const STORE_MAX = 1_500_000;

function readCached(id: string): CodeTranscript | null {
  const held = memory.get(id);
  if (held) return held;
  try {
    const raw = window.sessionStorage.getItem(STORE_PREFIX + id);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CodeTranscript;
    if (typeof parsed.seq !== "number" || !Array.isArray(parsed.turns)) return null;
    memory.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

let persistTimer: number | undefined;
const dirty = new Set<string>();
function writeCached(id: string, t: CodeTranscript) {
  memory.set(id, t);
  dirty.add(id);
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    for (const key of dirty) {
      const value = memory.get(key);
      if (!value) continue;
      try {
        const raw = JSON.stringify(value);
        if (raw.length <= STORE_MAX) window.sessionStorage.setItem(STORE_PREFIX + key, raw);
        else window.sessionStorage.removeItem(STORE_PREFIX + key);
      } catch {
        // Full or unavailable: the next open replays from the log instead.
      }
    }
    dirty.clear();
  }, 800);
}

/** The chat's stored user messages (the server saves each when its turn starts). */
async function fetchUserMessages(chatId: string): Promise<RenderMessage[]> {
  const res = await fetch(`/chat/history/${encodeURIComponent(chatId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const chat = (await res.json()) as ChatRecord;
  return (Array.isArray(chat.messages) ? chat.messages : []).filter((m) => m.role === "user" && !m.kind);
}

export type CodeSessionLoad =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready" };

export interface CodeSessionHandle {
  load: CodeSessionLoad;
  detail: CodeSessionDetail | null;
  status: CodeSessionStatus | null;
  messages: RenderMessage[];
  prompt: PendingPrompt | null;
  /** A run is going (or waiting on a live prompt). */
  running: boolean;
  /** Bumped on every `code_status`, so the Changes and Log tabs refetch. */
  version: number;
  /** The event stream dropped and is reconnecting. */
  reconnecting: boolean;
  /** `references`: the quotes picked for the message (a code session takes no SOPs or tools). */
  send: (text: string, attachments?: AttachmentRef[], references?: ContextRef[]) => Promise<void>;
  stop: () => Promise<void>;
  answer: (answer: string) => Promise<void>;
  /** Re-reads the session's detail (after archive/restore, a branch action…). */
  refresh: () => void;
  sendError: string | null;
  clearSendError: () => void;
}

export function useCodeSession(chat: ChatRecord): CodeSessionHandle {
  const chatId = chat.id;
  const [load, setLoad] = useState<CodeSessionLoad>({ state: "loading" });
  const [detail, setDetail] = useState<CodeSessionDetail | null>(null);
  const [transcript, setTranscript] = useState<CodeTranscript>(EMPTY_TRANSCRIPT);
  const [users, setUsers] = useState<RenderMessage[]>([]);
  const [pending, setPending] = useState<PendingUserMessage[]>([]);
  const [version, setVersion] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  // Bumped when the stored user messages may be behind (a turn started, a message was sent).
  const [usersStale, setUsersStale] = useState(0);
  const sessionId = detail?.id;

  // The session behind this chat, then its detail.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    (async () => {
      try {
        let id = detail?.chatId === chatId ? detail.id : undefined;
        if (!id) {
          const { sessions } = await codeApi.sessions({ chat: chatId, status: "all" }, ctrl.signal);
          id = sessions.find((s) => s.chatId === chatId)?.id;
        }
        if (!id) {
          setDetail(null);
          setLoad({ state: "missing" });
          return;
        }
        const d = await codeApi.detail(id, ctrl.signal);
        setDetail(d);
        setLoad({ state: "ready" });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof CodeApiError && err.status === 404) setLoad({ state: "missing" });
        else setLoad({ state: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => ctrl.abort();
    // `detail` is read only to skip the lookup when it is already this chat's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, detailKey]);

  // The conversation: cached turns first, then the log from where they stop.
  useEffect(() => {
    if (!sessionId || !detail) return;
    const cached = readCached(sessionId);
    // A cache from a log that was since rewritten (fewer events than it has seen) is dropped.
    const start = cached && cached.seq <= detail.lastSeq ? cached : EMPTY_TRANSCRIPT;
    let current = start;
    setTranscript(start);
    const replayedUpTo = detail.lastSeq;
    let frame = 0;
    const flush = () => {
      frame = 0;
      setTranscript(current);
      writeCached(sessionId, current);
    };
    const sub = subscribeCodeEvents(
      sessionId,
      start.seq,
      (event, seq) => {
        const before = current;
        current = foldCodeEvent(current, event, seq, seq > replayedUpTo);
        if (event.type === "code_status" && event.code_status) {
          noteCodeStatus(event.code_status);
          setVersion((v) => v + 1);
        }
        if (event.type === "done" || event.type === "error") {
          setVersion((v) => v + 1);
          void refreshCodeSessions();
        }
        if (current.turns.length !== before.turns.length) setUsersStale((n) => n + 1);
        // Tokens arrive fast: draw at most once a frame.
        if (!frame) frame = window.requestAnimationFrame(flush);
      },
      (s) => {
        setReconnecting(s === "retrying");
        if (s === "gone") setLoad({ state: "missing" });
      },
    );
    return () => {
      sub.close();
      if (frame) {
        window.cancelAnimationFrame(frame);
        flush();
      }
    };
    // Subscribes once per session; `detail` changes (refreshes) don't restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The stored user messages; fetched again when a turn starts that they don't cover yet.
  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      fetchUserMessages(chatId)
        .then((list) => {
          if (cancelled) return;
          setUsers(list);
          setPending((p) => p.filter((m) => !list.some((u) => u.id === m.id)));
        })
        .catch(() => {});
    }, usersStale === 0 ? 0 : 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [chatId, usersStale]);
  useSyncRefresh("chats", () => setUsersStale((n) => n + 1));
  useSyncRefresh("code", () => setDetailKey((k) => k + 1));

  const status = transcript.status ?? detail?.status ?? null;
  const running = transcript.open || status?.activity === "running" || status?.activity === "needs_approval";

  // The live prompt: from the log, or as the session stored it when the log hasn't reached it.
  const stored = detail?.pendingPrompt && detail.status.pendingPromptId === detail.pendingPrompt.id ? { ...detail.pendingPrompt, live: true as const } : null;
  const rawPrompt = transcript.prompt ?? (transcript.seq <= (detail?.lastSeq ?? 0) && status?.pendingPromptId === stored?.id ? stored : null);
  const prompt = rawPrompt && rawPrompt.id !== answered ? rawPrompt : null;

  const messages = useMemo(() => assemble(users, pending, transcript.turns), [users, pending, transcript.turns]);

  const send = useCallback(async (text: string, attachments: AttachmentRef[] = [], references: ContextRef[] = []) => {
    const turnId = crypto.randomUUID();
    const message: RenderMessage = {
      role: "user",
      content: text,
      id: turnId,
      ...(attachments.length ? { attachments } : {}),
      ...(references.length ? { references } : {}),
    };
    setPending((p) => [...p, { id: turnId, message }]);
    setSendError(null);
    try {
      await sendCodeMessage({
        chatId,
        sessionId: chat.sessionId || undefined,
        message: text,
        turnId,
        attachments: attachments.map((a) => a.id),
        references: references.map(refForServer),
      });
      setUsersStale((n) => n + 1);
    } catch (err) {
      setPending((p) => p.filter((m) => m.id !== turnId));
      setSendError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [chatId, chat.sessionId]);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    await codeApi.stop(sessionId).catch(() => {});
  }, [sessionId]);

  const answer = useCallback(async (value: string) => {
    if (!sessionId || !rawPrompt) return;
    const id = rawPrompt.id;
    try {
      await codeApi.answer(sessionId, id, { answer: value });
      setAnswered(id);
    } catch (err) {
      // Already answered elsewhere or timed out: it is gone either way.
      if (err instanceof CodeApiError && (err.code === "answered" || err.status === 404 || err.status === 409)) setAnswered(id);
      else throw err;
    }
  }, [sessionId, rawPrompt]);

  const refresh = useCallback(() => setDetailKey((k) => k + 1), []);
  const clearSendError = useCallback(() => setSendError(null), []);

  return { load, detail, status, messages, prompt, running, version, reconnecting, send, stop, answer, refresh, sendError, clearSendError };
}
