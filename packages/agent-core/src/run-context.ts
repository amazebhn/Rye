/**
 * Per-run state for a single /chat/ agent run, isolated via AsyncLocalStorage
 * so concurrent runs in different chats never see each other's env or drafts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SopDraftEvent } from "./tools/index.js";
import type { FilterCapture } from "./copilot-filter.js";

export interface RunContext {
  /** Environment key for this run; null means the base ("default") config. */
  envKey: string | null;
  sopDraftMode: boolean;
  pendingDraftEvents: SopDraftEvent[];
  /** Content-filter results from this run's latest Copilot chat request. */
  contentFilter?: FilterCapture;
  /** Aborted when the client disconnects (the Stop button); the run should wind down. */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<RunContext>();

export function getRunContext(): RunContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RunContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
