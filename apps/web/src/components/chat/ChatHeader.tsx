import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, FileOutput, Layers, MoreVertical } from "lucide-react";
import SidebarButton from "../shell/SidebarButton";
import AgentAvatar from "../agents/AgentAvatar";
import AgentHoverCard from "../agents/AgentHoverCard";
import type { AgentRecord } from "../../utils/types";

function ChatActionsMenu({ sessionId, onHandoff }: {
  sessionId: string;
  onHandoff?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => { setCopied(false); setOpen(false); }, 1000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copyId = () => {
    void navigator.clipboard.writeText(sessionId).then(() => setCopied(true), () => setOpen(false));
  };

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="chat-header-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`chat-header-db-btn${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-label="More chat actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="sidebar-dropdown chat-header-dropdown" role="menu">
          <button
            type="button"
            className="sidebar-dropdown-item"
            role="menuitem"
            onClick={copyId}
            title={sessionId}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
            <span>{copied ? "Copied" : "Copy chat ID"}</span>
            <code className="chat-header-dropdown-id">{sessionId.slice(0, 8)}</code>
          </button>
          {onHandoff && (
            <button
              type="button"
              className="sidebar-dropdown-item"
              role="menuitem"
              onClick={run(onHandoff)}
              title="Write a handoff doc another engineer's agent can pick up"
            >
              <FileOutput size={17} />
              <span>Export handoff doc</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  chatTitle: string | undefined;
  activeAgent?: AgentRecord;
  displaySessionId: string | undefined;
  contextPct: number | undefined;
  /** The chat's files and stored results; the Artifacts button shows only when there are some. */
  artifactCount: number;
  artifactsOpen: boolean;
  onToggleArtifacts: () => void;
  onHandoff?: () => void; // absent until the chat has a session
}

export default function ChatHeader({
  chatTitle,
  activeAgent,
  displaySessionId,
  contextPct,
  artifactCount,
  artifactsOpen,
  onToggleArtifacts,
  onHandoff,
}: Props) {
  const ctxColor =
    contextPct === undefined ? undefined
    : contextPct >= 85 ? "#dc2626"
    : contextPct >= 60 ? "#d97706"
    : "var(--main-fg-faint)";

  return (
    <header className="chat-header">
      <SidebarButton />
      <span className="chat-header-title" style={activeAgent ? { display: "inline-flex", alignItems: "center", gap: 8 } : undefined}>
        {activeAgent ? (
          <AgentHoverCard agent={activeAgent} placement="bottom">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <AgentAvatar agent={activeAgent} size="sm" hideTooltip />
              <span>{activeAgent.name}</span>
            </span>
          </AgentHoverCard>
        ) : (
          <span>{chatTitle ?? "Rye Agent"}</span>
        )}
      </span>
      {/* Its slot is kept while the chat has nothing yet (hidden, not removed), so it appears without moving anything. */}
      {displaySessionId && (
        <button
          type="button"
          className={`chat-header-db-btn chat-header-artifacts-btn${artifactsOpen ? " active" : ""}${artifactCount > 0 || artifactsOpen ? "" : " is-empty"}`}
          onClick={onToggleArtifacts}
          title={artifactsOpen ? "Hide this chat’s files and results" : "This chat’s files and results"}
          aria-label="Artifacts"
          aria-expanded={artifactsOpen}
          aria-controls={artifactsOpen ? "artifacts-panel" : undefined}
          aria-hidden={artifactCount > 0 || artifactsOpen ? undefined : true}
          tabIndex={artifactCount > 0 || artifactsOpen ? undefined : -1}
        >
          <Layers size={16} aria-hidden="true" />
        </button>
      )}
      {displaySessionId && <ChatActionsMenu sessionId={displaySessionId} onHandoff={onHandoff} />}
      {contextPct !== undefined && (
        <span className="chat-header-session" style={{ color: ctxColor, marginLeft: 4 }} title="Context window usage">
          ctx {contextPct}%
        </span>
      )}
    </header>
  );
}
