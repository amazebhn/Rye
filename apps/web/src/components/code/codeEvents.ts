/**
 * A code session's conversation, rebuilt from its event log (`/code/sessions/:id/events`).
 *
 * The log speaks the chat's own SSE vocabulary, so each assistant turn is built exactly as App.tsx
 * builds a streaming reply (tokens, iterations, tool calls and results, usage). A turn opens with the
 * first event after the previous `done` (or `error`) and closes with the next one. User messages are
 * not in the log: they come from the chat's stored messages (the server saves each one when its turn
 * starts) and are paired with the turns in order (`assemble`).
 */

import type { CodeSessionStatus, PendingPrompt, SSEEvent } from "@rye/shared";
import type { RenderMessage } from "../../utils/types";

export interface CodeTranscript {
  /** The last sequence number folded in. */
  seq: number;
  /** One assistant message per turn, oldest first. */
  turns: RenderMessage[];
  /** The last turn is still going. */
  open: boolean;
  /** The live prompt waiting for an answer. */
  prompt: PendingPrompt | null;
  /** The latest `code_status`. */
  status: CodeSessionStatus | null;
}

export const EMPTY_TRANSCRIPT: CodeTranscript = { seq: 0, turns: [], open: false, prompt: null, status: null };

const IGNORED = new Set<SSEEvent["type"]>(["session", "code_status", "agent", "env_changed", "sop_draft", "pause"]);

function patchLast(t: CodeTranscript, fn: (m: RenderMessage) => RenderMessage): CodeTranscript {
  const turns = [...t.turns];
  turns[turns.length - 1] = fn(turns[turns.length - 1]);
  return { ...t, turns };
}

/**
 * Folds one event in. `live` is false for events replayed from the log (so no timings are invented
 * for them) and true for ones arriving as they happen.
 */
export function foldCodeEvent(t: CodeTranscript, event: SSEEvent, seq: number, live: boolean): CodeTranscript {
  let next: CodeTranscript = { ...t, seq: Math.max(t.seq, seq) };

  if (event.type === "code_status" && event.code_status) {
    const status = event.code_status;
    // A later status without the prompt means it was answered (here or elsewhere) or timed out.
    const prompt = next.prompt && status.pendingPromptId !== next.prompt.id ? null : next.prompt;
    return { ...next, status, prompt };
  }
  if (event.type === "done" || event.type === "error") {
    if (!next.open) {
      // An error outside a turn (the run never started) still says why.
      if (event.type !== "error") return { ...next, prompt: null };
      next = { ...next, turns: [...next.turns, { role: "assistant", content: "", toolCalls: [] }], open: true };
    }
    const now = Date.now();
    next = patchLast(next, (m) => ({
      ...m,
      meta: {
        ...(m.meta ?? { startedAt: now }),
        ...(live && m.meta ? { finishedAt: now } : {}),
        status: event.type === "done" ? "done" : "error",
        ...(event.type === "error" ? { error: event.error ?? event.content ?? "The run failed." } : {}),
      },
    }));
    return { ...next, open: false, prompt: null };
  }
  if (IGNORED.has(event.type)) return next;

  if (!next.open) {
    const opened: RenderMessage = { role: "assistant", content: "", toolCalls: [], ...(live ? { meta: { startedAt: Date.now() } } : {}) };
    next = { ...next, turns: [...next.turns, opened], open: true };
  }

  switch (event.type) {
    case "token":
      if (!event.content) return next;
      return patchLast(next, (m) => ({
        ...m,
        content: m.content + event.content,
        ...(live && m.meta && !m.meta.firstTokenAt ? { meta: { ...m.meta, firstTokenAt: Date.now() } } : {}),
      }));
    case "iter_start":
      return patchLast(next, (m) => {
        const has = m.content.trim() || (m.toolCalls ?? []).length > 0;
        return has ? { ...m, turns: [...(m.turns ?? []), { thinking: m.content, toolCalls: m.toolCalls ?? [] }], content: "", toolCalls: [] } : m;
      });
    case "iter_summary":
      if (!event.content) return next;
      return patchLast(next, (m) => {
        const turns = [...(m.turns ?? [])];
        if (turns.length === 0) return m;
        turns[turns.length - 1] = { ...turns[turns.length - 1], summary: event.content };
        return { ...m, turns };
      });
    case "tool_start":
      if (!event.name) return next;
      return patchLast(next, (m) => ({ ...m, toolCalls: [...(m.toolCalls ?? []), { name: event.name!, args: event.args ?? {} }] }));
    case "tool_result": {
      if (!event.name) return next;
      return patchLast(next, (m) => {
        const calls = [...(m.toolCalls ?? [])];
        for (let i = calls.length - 1; i >= 0; i--) {
          if (calls[i].name === event.name && calls[i].result === undefined) {
            calls[i] = { ...calls[i], result: event.content ?? "" };
            break;
          }
        }
        return { ...m, toolCalls: calls };
      });
    }
    case "usage":
      return patchLast(next, (m) => {
        const meta = m.meta ?? { startedAt: Date.now() };
        return {
          ...m,
          meta: {
            ...meta,
            inputTokens: (meta.inputTokens ?? 0) + (event.input_tokens ?? 0),
            outputTokens: (meta.outputTokens ?? 0) + (event.output_tokens ?? 0),
            llmCalls: (meta.llmCalls ?? 0) + 1,
            ...(typeof event.cost_usd === "number" ? { costUsd: (meta.costUsd ?? 0) + event.cost_usd } : {}),
            model: event.model ?? meta.model,
            provider: event.provider ?? meta.provider,
          },
        };
      });
    case "prompt":
      if (!event.prompt_type || !event.question) return next;
      return {
        ...next,
        prompt: {
          id: event.prompt_id ?? `prompt-${seq}`,
          type: event.prompt_type,
          question: event.question,
          ...(event.options ? { options: event.options } : {}),
          ...(event.multi_select ? { multiSelect: true } : {}),
          live: true,
        },
      };
    default:
      return next;
  }
}

/** A user message sent from this tab that the stored messages don't have yet. */
export interface PendingUserMessage {
  id: string;
  message: RenderMessage;
}

/**
 * The conversation MessageList draws: the n-th user message, then the n-th turn. User messages the
 * server hasn't stored yet (just sent from here) follow the ones it has.
 */
export function assemble(users: RenderMessage[], pending: PendingUserMessage[], turns: RenderMessage[]): RenderMessage[] {
  const known = new Set(users.map((u) => u.id).filter(Boolean));
  const all = [...users, ...pending.filter((p) => !known.has(p.id)).map((p) => p.message)];
  const out: RenderMessage[] = [];
  const n = Math.max(all.length, turns.length);
  for (let i = 0; i < n; i++) {
    if (all[i]) out.push(all[i]);
    if (turns[i]) out.push(turns[i]);
  }
  return out;
}
