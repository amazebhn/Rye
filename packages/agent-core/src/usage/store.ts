/**
 * Usage tracking — append-only JSONL log of LLM calls and tool calls.
 *
 * One line per event so writes stay cheap during streaming. Records older
 * than the retention window are pruned lazily on read.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

const USAGE_FILE = join(DATA_DIR, "usage.jsonl");
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface LlmUsageEvent {
  kind: "llm";
  ts: number;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  contextPct: number;
  contextWindow: number;
  /** Absent for chat/agent calls; "decision" for decision-model calls. */
  source?: "decision";
}

export interface ToolUsageEvent {
  kind: "tool";
  ts: number;
  sessionId: string;
  tool: string;
  durationMs: number;
  isError: boolean;
}

export type UsageEvent = LlmUsageEvent | ToolUsageEvent;

function isUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.kind === "llm" || v.kind === "tool") && typeof v.ts === "number";
}

export class UsageStore {
  private pruned = false;

  record(event: UsageEvent): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(USAGE_FILE, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Usage tracking must never break a run.
    }
  }

  /** All retained events, newest last. Prunes expired records once per process. */
  all(): UsageEvent[] {
    let events: UsageEvent[] = [];
    try {
      if (!existsSync(USAGE_FILE)) return [];
      events = readFileSync(USAGE_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter(isUsageEvent);
    } catch {
      return [];
    }

    const cutoff = Date.now() - RETENTION_MS;
    const kept = events.filter((e) => e.ts >= cutoff);

    if (!this.pruned && kept.length !== events.length) {
      this.pruned = true;
      try {
        writeFileSync(USAGE_FILE, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      } catch {
        // Pruning is best-effort.
      }
    }

    return kept;
  }

  since(days: number): UsageEvent[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.all().filter((e) => e.ts >= cutoff);
  }
}
