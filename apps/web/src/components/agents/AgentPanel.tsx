import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bot,
  LayoutGrid,
  List,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useAgents } from "../../contexts/AgentContext";
import type { AgentRecord } from "../../utils/types";
import AgentAvatar, { AgentBanner, formatToolGroup } from "./AgentAvatar";
import NewAgentModal from "./NewAgentModal";
import AgentChatSheet from "./AgentChatSheet";
import AiMark from "../shared/AiMark";
import { formatReferencesForMarkdown } from "../shared/MarkdownEditor";
import { formatModelName } from "../../utils/modelNames";

type ViewMode = "card" | "list";

function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function AgentMenu({
  onOpenChat,
  onEdit,
  onDelete,
}: {
  onOpenChat: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="sop-menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        className="icon-btn sop-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Options"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="sop-menu-dropdown">
          <button className="sop-menu-item" onClick={() => { setOpen(false); onOpenChat(); }}>
            <MessageSquare size={12} /> Open chat
          </button>
          <button className="sop-menu-item" onClick={() => { setOpen(false); onEdit(); }}>
            <Pencil size={12} /> Edit details
          </button>
          <button className="sop-menu-item sop-menu-item--danger" onClick={() => { setOpen(false); onDelete(); }}>
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  onOpenAgentChat: (agent: AgentRecord) => void;
}

export default function AgentPanel({ onOpenAgentChat }: Props) {
  const { agents, agentsLoading, refreshAgents, deleteAgent, pendingProfileId, clearPendingProfileId } = useAgents();
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [activeAgent, setActiveAgent] = useState<AgentRecord | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentRecord | null>(null);

  useEffect(() => {
    if (!pendingProfileId || !agents) return;
    const match = agents.find((a) => a.id === pendingProfileId);
    if (match) {
      setActiveAgent(match);
      setChatOpen(false);
    }
    clearPendingProfileId();
  }, [pendingProfileId, agents, clearPendingProfileId]);

  // Keep detail view synced when agent list updates (e.g. from AI Editor or another tab)
  const resolvedActive = activeAgent
    ? (agents?.find((a) => a.id === activeAgent.id) ?? activeAgent)
    : null;

  function openAgent(agent: AgentRecord) {
    setActiveAgent(agent);
    setChatOpen(false);
  }

  function handleCreated(agent: AgentRecord) {
    setCreating(false);
    openAgent(agent);
  }

  function handleEdited(agent: AgentRecord) {
    setEditing(null);
    if (activeAgent?.id === agent.id) setActiveAgent(agent);
  }

  async function handleDelete(id: string) {
    await deleteAgent(id);
    if (activeAgent?.id === id) {
      setActiveAgent(null);
      setChatOpen(false);
    }
  }

  const filtered = (agents ?? []).filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      a.slug.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.instructions.toLowerCase().includes(q)
    );
  });

  // ── Detail / Editor view (matches SopPanel) ────────────────────────────
  if (resolvedActive) {
    return (
      <div className="sop-panel">
        {editing && (
          <NewAgentModal
            initial={editing}
            onSaved={handleEdited}
            onClose={() => setEditing(null)}
          />
        )}

        <div className="sop-panel-header sop-panel-header--detail">
          <button
            className="sop-header-icon-btn"
            onClick={() => { setActiveAgent(null); setChatOpen(false); }}
            title="Back to Agents"
            aria-label="Back to Agents"
          >
            <ArrowLeft size={17} />
          </button>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 9, flex: 1, minWidth: 0 }}>
            <AgentAvatar agent={resolvedActive} size="sm" />
            <h2 className="sop-panel-title sop-detail-title" style={{ flex: "0 1 auto" }}>
              {resolvedActive.name}
            </h2>
            <span style={{ fontSize: 12, color: "var(--main-fg-faint)" }}>@{resolvedActive.slug}</span>
          </div>

          <button
            className="btn btn--ghost btn--sm"
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            onClick={() => onOpenAgentChat(resolvedActive)}
            title={`Open dedicated chat with ${resolvedActive.name}`}
          >
            <MessageSquare size={13} />
            Open Chat
          </button>

          <button
            className="sop-header-icon-btn"
            onClick={() => setEditing(resolvedActive)}
            title="Edit agent details"
            aria-label="Edit agent details"
          >
            <Pencil size={15} />
          </button>

          <button
            className={`sop-ai-btn${chatOpen ? " sop-ai-btn--active" : ""}`}
            onClick={() => setChatOpen((v) => !v)}
            title="Refine instructions with AI Editor"
          >
            <AiMark size={14} />
            {chatOpen ? "Hide AI Editor" : "Edit with AI"}
          </button>
        </div>

        <div className="sop-detail-split">
          <div className="sop-detail-body">
            <div className="sop-detail-md">
              <div className="agent-hero">
                <AgentBanner agent={resolvedActive} className="agent-hero-banner" />
                <div className="agent-hero-head">
                  <div className="agent-contact-avatar-ring">
                    <AgentAvatar agent={resolvedActive} size="xl" hideTooltip />
                  </div>
                  <div className="agent-hero-identity">
                    <h1 className="agent-hero-name">{resolvedActive.name}</h1>
                    <div className="agent-hero-handle">@{resolvedActive.slug}</div>
                  </div>
                </div>
                {(resolvedActive.description || resolvedActive.model || resolvedActive.tool_groups.length > 0) && (
                  <div className="agent-hero-meta">
                    {resolvedActive.description && (
                      <p className="agent-hero-desc">{resolvedActive.description}</p>
                    )}
                    {(resolvedActive.model || resolvedActive.tool_groups.length > 0) && (
                      <div className="agent-contact-tags">
                        {resolvedActive.model && (
                          <span className="agent-contact-tag">Model: {formatModelName(resolvedActive.model)}</span>
                        )}
                        {resolvedActive.tool_groups.map((g) => (
                          <span key={g} className="agent-contact-tag">{formatToolGroup(g)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {formatReferencesForMarkdown(resolvedActive.instructions)}
              </ReactMarkdown>
            </div>
          </div>

          {chatOpen && (
            <AgentChatSheet
              agent={resolvedActive}
              onClose={() => setChatOpen(false)}
              onAgentUpdated={(updated) => {
                setActiveAgent(updated);
                void refreshAgents();
              }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── List / Card view ───────────────────────────────────────────────────
  return (
    <div className="sop-panel">
      {creating && (
        <NewAgentModal
          onSaved={handleCreated}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <NewAgentModal
          initial={editing}
          onSaved={handleEdited}
          onClose={() => setEditing(null)}
        />
      )}

      <div className="sop-panel-header">
        <h2 className="sop-panel-title">Agents</h2>
        <div className="sop-panel-toolbar">
          <div className="sop-search-wrap">
            <Search size={13} className="sop-search-icon" />
            <input
              className="sop-search-input"
              placeholder="Search agents…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className={`icon-btn sop-view-btn${viewMode === "card" ? " active" : " faint"}`}
            onClick={() => setViewMode("card")}
            title="Card view"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            className={`icon-btn sop-view-btn${viewMode === "list" ? " active" : " faint"}`}
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List size={14} />
          </button>
          <button
            className="icon-btn faint"
            onClick={() => void refreshAgents()}
            disabled={agentsLoading}
            title="Refresh"
          >
            <RefreshCw size={13} className={agentsLoading ? "spin" : ""} />
          </button>
          <div className="sop-toolbar-divider" />
          <button className="sop-new-btn" onClick={() => setCreating(true)}>
            <Plus size={13} />
            New Agent
          </button>
        </div>
      </div>

      <div className="sop-panel-body">
        {agentsLoading && agents === null && <div className="sop-panel-empty">Loading…</div>}

        {!agentsLoading && (agents?.length ?? 0) === 0 && (
          <div className="sop-panel-zero">
            <Bot size={32} className="sop-panel-zero-icon" />
            <p>No custom agents yet.</p>
            <p className="sop-panel-zero-sub">
              Create specialized agents with their own instruction sets, profile avatars, and dedicated 1:1 chats — or tag them with <code>@handle</code> in any chat.
            </p>
          </div>
        )}

        {!agentsLoading && (agents?.length ?? 0) > 0 && filtered.length === 0 && (
          <div className="sop-panel-empty">No agents match "{query}".</div>
        )}

        {filtered.length > 0 &&
          (viewMode === "card" ? (
            <div className="sop-card-grid">
              {filtered.map((agent) => (
                <div key={agent.id} className="sop-card" onClick={() => openAgent(agent)}>
                  <div className="sop-card-header">
                    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0, flex: 1 }}>
                      <AgentAvatar agent={agent} size="md" />
                      <div style={{ minWidth: 0 }}>
                        <div className="sop-card-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {agent.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--main-fg-faint)" }}>@{agent.slug}</div>
                      </div>
                    </div>
                    <AgentMenu
                      onOpenChat={() => onOpenAgentChat(agent)}
                      onEdit={() => setEditing(agent)}
                      onDelete={() => void handleDelete(agent.id)}
                    />
                  </div>
                  <div className="sop-card-preview">
                    {(agent.description || agent.instructions.replace(/^#+\s.*/gm, "").trim()).slice(0, 120)}
                    {(agent.description || agent.instructions).length > 120 ? "…" : ""}
                  </div>
                  <div className="sop-card-footer">
                    <span className="sop-card-date">{formatDate(agent.updated_at)}</span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ fontSize: 11, padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenAgentChat(agent);
                      }}
                    >
                      <MessageSquare size={11} />
                      Chat
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table className="sop-table">
              <thead>
                <tr>
                  <th className="sop-table-th sop-table-th--name">Agent</th>
                  <th className="sop-table-th">Description</th>
                  <th className="sop-table-th">Updated</th>
                  <th className="sop-table-th sop-table-th--action" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((agent) => (
                  <tr key={agent.id} className="sop-table-row" onClick={() => openAgent(agent)}>
                    <td className="sop-table-td sop-table-td--name">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <AgentAvatar agent={agent} size="sm" />
                        <span>{agent.name}</span>
                        <span style={{ fontSize: 11.5, color: "var(--main-fg-faint)", fontWeight: 400 }}>
                          @{agent.slug}
                        </span>
                      </span>
                    </td>
                    <td className="sop-table-td" style={{ color: "var(--main-fg-muted)" }}>
                      {(agent.description || agent.instructions.replace(/^#+\s.*/gm, "").trim()).slice(0, 90)}
                    </td>
                    <td className="sop-table-td" style={{ whiteSpace: "nowrap", color: "var(--main-fg-faint)" }}>
                      {formatDate(agent.updated_at)}
                    </td>
                    <td className="sop-table-td" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <AgentMenu
                        onOpenChat={() => onOpenAgentChat(agent)}
                        onEdit={() => setEditing(agent)}
                        onDelete={() => void handleDelete(agent.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </div>
  );
}
