/**
 * Edit and retry: a `/chat/` request with `rewind` drops the user message at `index` and everything
 * after it, from the agent session (server.ts `rewindSession`) before the new message runs.
 *
 * A stored chat names itself (`{chat_id, index}`) and the server reads its messages from chats.db.
 * The quick chat isn't stored, so it sends its own messages instead (`{index, messages}`); only
 * `role`, `content` and `id` are read from them, and nothing is written but the session.
 */

import { z } from "zod";
import type { RewindTurn } from "../agent/loop.js";

export const StoredRewindSchema = z.object({
  chat_id: z.string().min(1).max(128),
  index: z.number().int().nonnegative(),
});

export const QuickRewindSchema = z.object({
  index: z.number().int().nonnegative(),
  messages: z.array(z.unknown()).max(10_000),
});

export function toRewindTurn(raw: unknown): RewindTurn | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { role, content, id } = raw as Record<string, unknown>;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
  return { role, content, id: typeof id === "string" ? id : undefined };
}

/** The turns to keep, and whether every dropped user turn is tagged (so the session can be sliced exactly). */
export function rewindPlan(messages: unknown[], index: number): { kept: RewindTurn[]; exact: boolean } | { error: string } {
  const turns = messages.map(toRewindTurn);
  if (index >= turns.length || turns[index]?.role !== "user") return { error: "Rewind index must point at a user message" };
  const kept = turns.slice(0, index).filter((t): t is RewindTurn => t !== null);
  const exact = turns.slice(index).every((t) => t?.role !== "user" || t.id !== undefined);
  return { kept, exact };
}
