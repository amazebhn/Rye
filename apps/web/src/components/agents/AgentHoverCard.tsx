import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Cpu, MessageSquare, User, Wrench, X } from "lucide-react";
import type { AgentRecord } from "../../utils/types";
import { useAgents } from "../../contexts/AgentContext";
import { formatModelName } from "../../utils/modelNames";
import AgentAvatar, { AgentBanner, formatToolGroup } from "./AgentAvatar";

const MENTION_RE = /(^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})\b/g;

/** Extract unique matched agents tagged with @slug in text. */
export function extractMentionedAgents(
  text: string,
  agentBySlug: ReadonlyMap<string, AgentRecord>,
): AgentRecord[] {
  if (agentBySlug.size === 0 || !text.includes("@")) return [];
  const found: AgentRecord[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const slug = m[2].toLowerCase();
    if (seen.has(slug)) continue;
    const agent = agentBySlug.get(slug);
    if (agent) {
      seen.add(slug);
      found.push(agent);
    }
  }
  return found;
}

/** Inline styled pill for a tagged @agent, with hover contact card and optional remove button. */
export function AgentMentionPill({
  agent,
  showSlug = false,
  onRemove,
}: {
  agent: AgentRecord;
  showSlug?: boolean;
  onRemove?: () => void;
}) {
  return (
    <AgentHoverCard agent={agent} placement="bottom">
      <span className="agent-mention-pill">
        <AgentAvatar agent={agent} size="xs" hideTooltip />
        <span className="agent-mention-pill-label">{agent.name}</span>
        {showSlug && <span className="agent-mention-pill-slug">@{agent.slug}</span>}
        {onRemove && (
          <button
            type="button"
            className="agent-mention-pill-remove"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label={`Remove @${agent.slug}`}
            title={`Remove @${agent.slug}`}
          >
            <X size={10} />
          </button>
        )}
      </span>
    </AgentHoverCard>
  );
}

/** Renders text with any valid @slug mentions turned into interactive AgentMentionPills. */
export function AgentMentionText({ text }: { text: string }) {
  const { agentBySlug } = useAgents();
  if (agentBySlug.size === 0 || !text.includes("@")) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const m of text.matchAll(MENTION_RE)) {
    const fullIndex = m.index ?? 0;
    const prefix = m[1];
    const slug = m[2];
    const agent = agentBySlug.get(slug.toLowerCase());
    if (!agent) continue;

    const mentionStart = fullIndex + prefix.length;
    if (mentionStart > lastIndex) {
      parts.push(text.slice(lastIndex, mentionStart));
    }
    parts.push(<AgentMentionPill key={`${mentionStart}:${agent.id}`} agent={agent} />);
    lastIndex = fullIndex + m[0].length;
  }

  if (parts.length === 0) return <>{text}</>;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

const OPEN_DELAY_MS = 260;
const CLOSE_DELAY_MS = 180;
const CARD_WIDTH = 304;
const CARD_EST_HEIGHT = 240;

interface Props {
  agent: AgentRecord;
  children: React.ReactNode;
  /** Preferred side to open relative to the trigger. Auto-flips if near viewport edge. */
  placement?: "right" | "bottom";
}

function summaryFor(agent: AgentRecord): string {
  if (agent.description.trim()) return agent.description.trim();
  const plain = agent.instructions
    .replace(/^#+\s.*/gm, "")
    .replace(/\[\[(?:sop|skill|knowledge):[^|\]]+(?:\|([^\]]+))?\]\]/g, (_, label) => label || "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
}

export default function AgentHoverCard({ agent, children, placement = "bottom" }: Props) {
  const { openAgentChat, openAgentProfile } = useAgents();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  function computePosition(): { top: number; left: number } | null {
    const el = triggerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const gap = 10;

    if (placement === "right") {
      const fitsRight = rect.right + gap + CARD_WIDTH <= window.innerWidth - 12;
      const left = fitsRight
        ? rect.right + gap
        : Math.max(12, rect.left - CARD_WIDTH - gap);
      const top = Math.max(12, Math.min(rect.top - 10, window.innerHeight - CARD_EST_HEIGHT - 12));
      return { top, left };
    }

    const fitsBelow = rect.bottom + gap + CARD_EST_HEIGHT <= window.innerHeight - 12;
    const top = fitsBelow
      ? rect.bottom + gap
      : Math.max(12, rect.top - CARD_EST_HEIGHT - gap);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 12));
    return { top, left };
  }

  function scheduleOpen() {
    window.clearTimeout(closeTimer.current);
    if (pos) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      setPos(computePosition());
    }, OPEN_DELAY_MS);
  }

  function scheduleClose() {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPos(null), CLOSE_DELAY_MS);
  }

  function keepOpen() {
    window.clearTimeout(closeTimer.current);
  }

  function copyHandle(e: React.MouseEvent) {
    e.stopPropagation();
    void navigator.clipboard.writeText(`@${agent.slug}`).then(() => setCopied(true), () => {});
  }

  const summary = summaryFor(agent);

  return (
    <>
      <span
        ref={triggerRef}
        className="agent-card-trigger"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
      >
        {children}
      </span>

      {pos &&
        createPortal(
          <div
            className="agent-contact-card"
            role="dialog"
            aria-label={`${agent.name} contact card`}
            style={{ top: pos.top, left: pos.left, width: CARD_WIDTH }}
            onMouseEnter={keepOpen}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
          >
            <AgentBanner agent={agent} className="agent-contact-banner" />

            <div className="agent-contact-head">
              <div className="agent-contact-avatar-ring">
                <AgentAvatar agent={agent} size="xl" hideTooltip />
              </div>
              <div className="agent-contact-identity">
                <div className="agent-contact-name">{agent.name}</div>
                <div className="agent-contact-handle">@{agent.slug}</div>
              </div>
            </div>

            {summary && <p className="agent-contact-bio">{summary}</p>}

            {(agent.model || agent.tool_groups.length > 0) && (
              <div className="agent-contact-meta">
                {agent.model && (
                  <div className="agent-contact-meta-row">
                    <Cpu size={12} aria-hidden="true" />
                    <span>{formatModelName(agent.model)}</span>
                  </div>
                )}
                {agent.tool_groups.length > 0 && (
                  <div className="agent-contact-meta-row agent-contact-meta-row--top">
                    <Wrench size={12} style={{ marginTop: 3, flexShrink: 0 }} aria-hidden="true" />
                    <div className="agent-contact-tags">
                      {agent.tool_groups.map((g) => (
                        <span key={g} className="agent-contact-tag">{formatToolGroup(g)}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="agent-contact-actions">
              <button
                type="button"
                className="btn btn--primary btn--sm agent-contact-action-main"
                onClick={() => {
                  setPos(null);
                  openAgentChat(agent);
                }}
              >
                <MessageSquare size={13} />
                <span>Message</span>
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setPos(null);
                  openAgentProfile(agent);
                }}
                title="View agent profile & instructions"
              >
                <User size={13} />
                <span>Profile</span>
              </button>
              <button
                type="button"
                className="icon-btn faint"
                onClick={copyHandle}
                title={`Copy @${agent.slug}`}
                aria-label={`Copy @${agent.slug}`}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
