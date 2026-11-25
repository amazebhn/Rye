import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Database, FileOutput, MoreVertical } from "lucide-react";
import StoredResultsPicker from "./StoredResultsPicker";
import SidebarButton from "../shell/SidebarButton";
import { useIsMobile } from "../../utils/viewport";
import AgentAvatar from "../agents/AgentAvatar";
import AgentHoverCard from "../agents/AgentHoverCard";
import type { AgentRecord } from "../../utils/types";

function ChatActionsMenu({ sessionId, onHandoff, onOpenResults }: {
  sessionId: string;
  onHandoff?: () => void;
  /** On a phone the stored results open from this menu instead of their own header button. */
  onOpenResults?: () => void;
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
          {onOpenResults && (
            <button
              type="button"
              className="sidebar-dropdown-item"
              role="menuitem"
              onClick={run(onOpenResults)}
            >
              <Database size={17} />
              <span>Stored results</span>
            </button>
          )}
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
  onOpenResult: (id: string) => void;
  onHandoff?: () => void; // absent until the chat has a session
}

export default function ChatHeader({
  chatTitle,
  activeAgent,
  displaySessionId,
  contextPct,
  onOpenResult,
  onHandoff,
}: Props) {
  const isMobile = useIsMobile();
  // On a phone the stored results move into the ⋯ menu, which (like any stored result) needs the chat to have a session.
  const resultsInMenu = isMobile && !!displaySessionId;
  const [resultsOpen, setResultsOpen] = useState(false);
  useEffect(() => {
    if (!resultsInMenu) setResultsOpen(false);
  }, [resultsInMenu]);
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
      {resultsInMenu ? (
        <StoredResultsPicker
          sessionId={displaySessionId}
          onSelect={onOpenResult}
          controlled={{
            open: resultsOpen,
            onOpenChange: (open) => {
              setResultsOpen(open);
              if (!open) document.querySelector<HTMLButtonElement>(".chat-header-menu > .chat-header-db-btn")?.focus();
            },
          }}
        />
      ) : isMobile ? null : (
        <StoredResultsPicker sessionId={displaySessionId} onSelect={onOpenResult} />
      )}
      {displaySessionId && (
        <ChatActionsMenu
          sessionId={displaySessionId}
          onHandoff={onHandoff}
          onOpenResults={resultsInMenu ? () => setResultsOpen(true) : undefined}
        />
      )}
      {contextPct !== undefined && (
        <span className="chat-header-session" style={{ color: ctxColor, marginLeft: 4 }} title="Context window usage">
          ctx {contextPct}%
        </span>
      )}
    </header>
  );
}
