import React, { useEffect, useState } from "react";
import { ArrowRight, SquareCode } from "lucide-react";
import type { CodeSessionSummary } from "@rye/shared";
import type { ToolCall } from "../../utils/types";
import { codeApi, useCodeAvailable, useCodeSessionList } from "../../utils/codeApi";
import { ACTIVITY_LABEL } from "./codeFormat";

const MARKER = /\[rye:code-session:([A-Za-z0-9_-]+)\]/g;
export const CODE_SESSION_MARKER_ALL = /\n?\[rye:code-session:[A-Za-z0-9_-]+\]/g;

/** Code sessions started in these tool calls (`start_code_session_tool` results carry the marker). */
export function codeSessionRefs(toolCalls: ToolCall[]): string[] {
  const ids = new Set<string>();
  for (const tc of toolCalls) {
    for (const m of tc.result?.matchAll(MARKER) ?? []) ids.add(m[1]);
  }
  return [...ids];
}

/** Opens a chat by id, from anywhere: App.tsx refreshes its list first if it doesn't know the chat yet. */
export function openChatById(chatId: string) {
  window.dispatchEvent(new CustomEvent("rye:open-chat", { detail: { chatId } }));
}

/**
 * The card in the parent chat for a code session started from it: live status (from the shared
 * session list, refreshed while one is running) and Open. Hidden until code sessions exist here.
 */
export default function CodeSessionCard({ id }: { id: string }) {
  const available = useCodeAvailable();
  const listed = useCodeSessionList().find((s) => s.id === id);
  const [fetched, setFetched] = useState<CodeSessionSummary | null>(null);
  const [missing, setMissing] = useState(false);

  // Archived sessions aren't in the shared (active) list: read this one directly.
  useEffect(() => {
    if (!available || listed) return;
    let live = true;
    codeApi.detail(id).then((d) => { if (live) setFetched(d); }, () => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [available, listed, id]);

  if (!available) return null;
  const s = listed ?? fetched;
  if (!s) {
    return missing ? (
      <div className="artifact-card artifact-card--missing code-card">
        <span className="artifact-card-icon"><SquareCode size={16} aria-hidden="true" /></span>
        <span className="artifact-card-meta">This code session is no longer available.</span>
      </div>
    ) : (
      <div className="artifact-card artifact-card--loading code-card" aria-busy="true" />
    );
  }
  const open = () => openChatById(s.chatId);
  return (
    <div className="artifact-card code-card">
      <button type="button" className="artifact-card-main" onClick={open} title={`Open ${s.title}`}>
        <span className="artifact-card-icon"><SquareCode size={16} aria-hidden="true" /></span>
        <span className="artifact-card-text">
          <span className="artifact-card-title">Code session · {s.title}</span>
          <span className="artifact-card-meta">
            <span>{s.repo}</span>
            <span className="artifact-card-filename">{s.branch}</span>
            <span className={`code-card-activity code-card-activity--${s.state === "archived" ? "idle" : s.activity}`}>
              {s.state === "archived" ? "Archived" : ACTIVITY_LABEL[s.activity]}
            </span>
            <span>{s.stat.files} file{s.stat.files === 1 ? "" : "s"}</span>
          </span>
        </span>
      </button>
      <div className="artifact-card-actions">
        <button type="button" className="btn btn--sm btn--ghost" onClick={open}>
          Open
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
