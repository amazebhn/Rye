import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRecord } from "../../utils/types";
import { useAgents } from "../../contexts/AgentContext";
import AgentAvatar, { resolveGradientCss } from "../agents/AgentAvatar";

const MENTION_TOKEN_RE = /(^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})\b/g;
const ACTIVE_QUERY_RE = /(?:^|[\s(])@([a-zA-Z0-9_-]*)$/;
const COMPLETED_MENTION_RE = /(?:^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})([\s])$/;

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function createMentionPillNode(agent: AgentRecord): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.className = "agent-mention-pill agent-mention-pill--inline";
  pill.contentEditable = "false";
  pill.dataset.mentionSlug = agent.slug;
  pill.title = `${agent.name} (@${agent.slug})`;

  const avatarWrap = document.createElement("span");
  avatarWrap.className = "agent-mention-pill-avatar";
  if (agent.avatar.kind === "image" && agent.avatar.value) {
    const img = document.createElement("img");
    img.src = agent.avatar.value;
    img.alt = "";
    avatarWrap.appendChild(img);
  } else {
    avatarWrap.style.background = resolveGradientCss(agent.avatar.value);
    avatarWrap.textContent = initialsFor(agent.name);
  }
  pill.appendChild(avatarWrap);

  const label = document.createElement("span");
  label.className = "agent-mention-pill-label";
  label.textContent = agent.name;
  pill.appendChild(label);

  return pill;
}

/** Serialize contentEditable DOM back to plain text with @slug tokens. */
function serializeEditor(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node, isRootChild: boolean, isLastChild: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\u00A0/g, " ").replace(/\u200B/g, "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const slug = el.dataset.mentionSlug;
    if (slug) {
      out += `@${slug}`;
      return;
    }
    if (el.tagName === "BR") {
      // Ignore a solitary trailing <br> browsers insert as a line-end sentinel.
      if (isRootChild && isLastChild && (out === "" || out.endsWith("\n"))) return;
      out += "\n";
      return;
    }
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    const kids = Array.from(el.childNodes);
    kids.forEach((child, idx) => walk(child, false, idx === kids.length - 1));
  };

  const kids = Array.from(root.childNodes);
  kids.forEach((child, idx) => walk(child, true, idx === kids.length - 1));
  return out;
}

/** Append plain text (upgrading any valid @slug mentions into inline pills) to a fragment. */
function buildNodesFromText(
  text: string,
  agentBySlug: ReadonlyMap<string, AgentRecord>,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) frag.appendChild(document.createElement("br"));
    if (!line) return;

    let last = 0;
    for (const m of line.matchAll(MENTION_TOKEN_RE)) {
      const idx = m.index ?? 0;
      const prefix = m[1];
      const slug = m[2];
      const agent = agentBySlug.get(slug.toLowerCase());
      if (!agent) continue;

      const mentionStart = idx + prefix.length;
      if (mentionStart > last) {
        frag.appendChild(document.createTextNode(line.slice(last, mentionStart)));
      }
      frag.appendChild(createMentionPillNode(agent));
      last = idx + m[0].length;
    }
    if (last < line.length) {
      frag.appendChild(document.createTextNode(line.slice(last)));
    }
  });
  return frag;
}

function isMentionPill(node: Node | null): node is HTMLElement {
  return Boolean(
    node &&
      node.nodeType === Node.ELEMENT_NODE &&
      (node as HTMLElement).dataset.mentionSlug,
  );
}

interface ActiveQuery {
  textNode: Text;
  atOffset: number;
  endOffset: number;
  query: string;
}

function getActiveQueryAtCaret(root: HTMLElement): ActiveQuery | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const textNode = range.startContainer as Text;
  const before = (textNode.textContent ?? "").slice(0, range.startOffset).replace(/\u00A0/g, " ");
  const m = before.match(ACTIVE_QUERY_RE);
  if (!m) return null;
  const atOffset = range.startOffset - m[1].length - 1;
  return { textNode, atOffset, endOffset: range.startOffset, query: m[1] };
}

function placeCaretAfter(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    const len = (node.textContent ?? "").length;
    range.setStart(node, len);
    range.collapse(true);
  } else {
    range.setStartAfter(node);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  ariaLabel: string;
  autoFocusTrigger?: unknown;
}

export default function MentionComposer({
  value,
  onChange,
  onSend,
  placeholder,
  ariaLabel,
  autoFocusTrigger,
}: Props) {
  const { agents, agentBySlug } = useAgents();
  const editorRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string>("");
  const lastHydratedAgentCountRef = useRef<number>(0);

  const [activeQuery, setActiveQuery] = useState<ActiveQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const matches =
    !dismissed && activeQuery && agents && agents.length > 0
      ? agents
          .filter((a) => {
            const q = activeQuery.query.toLowerCase();
            return a.slug.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
          })
          .slice(0, 6)
      : [];

  // Focus when requested (e.g. after streaming completes)
  useEffect(() => {
    if (autoFocusTrigger) editorRef.current?.focus();
  }, [autoFocusTrigger]);

  // Hydrate DOM only on external value changes (send clear, chat switch, starter pick, queued edit)
  // or when the agent list finishes loading while a draft already contains @mentions.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const agentsJustLoaded =
      lastHydratedAgentCountRef.current === 0 && agentBySlug.size > 0 && value.includes("@");
    if (value === lastEmittedRef.current && !agentsJustLoaded) return;

    lastEmittedRef.current = value;
    lastHydratedAgentCountRef.current = agentBySlug.size;

    el.innerHTML = "";
    if (value) {
      el.appendChild(buildNodesFromText(value, agentBySlug));
      // If focused, keep caret at the end after external insertion (e.g. clicking an example).
      if (document.activeElement === el && el.lastChild) {
        placeCaretAfter(el.lastChild);
      }
    }
    setActiveQuery(null);
  }, [value, agentBySlug]);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = serializeEditor(el);
    // Keep empty editor truly :empty so CSS placeholder renders reliably.
    if (next === "" && el.innerHTML !== "") el.innerHTML = "";
    lastEmittedRef.current = next;
    onChange(next);
  }, [onChange]);

  const refreshQuery = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const q = getActiveQueryAtCaret(el);
    setActiveQuery(q);
    if (!q) setDismissed(false);
  }, []);

  /** Replace an @query range inside a text node with an atomic pill + trailing space. */
  const replaceWithPill = useCallback(
    (textNode: Text, atOffset: number, endOffset: number, agent: AgentRecord, trailingChar = " ") => {
      const full = textNode.textContent ?? "";
      const before = full.slice(0, atOffset);
      const after = full.slice(endOffset);

      const parent = textNode.parentNode;
      if (!parent) return;

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      const pill = createMentionPillNode(agent);
      frag.appendChild(pill);
      const afterText = document.createTextNode(`${trailingChar}${after}`);
      frag.appendChild(afterText);

      parent.replaceChild(frag, textNode);

      // Put caret right after the trailing space
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(afterText, trailingChar.length);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      setActiveQuery(null);
      setMentionIndex(0);
      setDismissed(false);
      emitChange();
    },
    [emitChange],
  );

  /** Auto-upgrade a manually typed `@slug ` into an inline pill on space. */
  const tryAutoUpgradeTypedMention = useCallback(() => {
    const el = editorRef.current;
    if (!el || agentBySlug.size === 0) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return false;

    const textNode = range.startContainer as Text;
    const before = (textNode.textContent ?? "").slice(0, range.startOffset).replace(/\u00A0/g, " ");
    const m = before.match(COMPLETED_MENTION_RE);
    if (!m) return false;
    const agent = agentBySlug.get(m[1].toLowerCase());
    if (!agent) return false;

    const atOffset = range.startOffset - m[1].length - m[2].length - 1;
    replaceWithPill(textNode, atOffset, range.startOffset, agent, m[2]);
    return true;
  }, [agentBySlug, replaceWithPill]);

  function handleInput() {
    if (tryAutoUpgradeTypedMention()) return;
    emitChange();
    setDismissed(false);
    setMentionIndex(0);
    refreshQuery();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Autocomplete navigation
    if (matches.length > 0 && activeQuery) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const picked = matches[mentionIndex % matches.length];
        replaceWithPill(activeQuery.textNode, activeQuery.atOffset, activeQuery.endOffset, picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    // Atomic backspace on inline mention pill
    if (e.key === "Backspace") {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (el && sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        let pillToRemove: HTMLElement | null = null;
        if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
          if (isMentionPill(range.startContainer.previousSibling)) {
            pillToRemove = range.startContainer.previousSibling;
          }
        } else if (range.startContainer === el && range.startOffset > 0) {
          const prev = el.childNodes[range.startOffset - 1] ?? null;
          if (isMentionPill(prev)) pillToRemove = prev;
        }
        if (pillToRemove) {
          e.preventDefault();
          pillToRemove.remove();
          emitChange();
          refreshQuery();
          return;
        }
      }
    }

    // Enter sends; Shift+Enter inserts newline
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
      return;
    }

    if (e.key === "Enter" && e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const sel = window.getSelection();
      const el = editorRef.current;
      if (!sel || sel.rangeCount === 0 || !el) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const br = document.createElement("br");
      range.insertNode(br);
      // If inserting at the very end, add a trailing <br> sentinel so caret moves onto the new blank line.
      const needsSentinel = !br.nextSibling;
      if (needsSentinel) {
        const sentinel = document.createElement("br");
        br.after(sentinel);
      }
      const nextRange = document.createRange();
      nextRange.setStartAfter(br);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      emitChange();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = buildNodesFromText(text, agentBySlug);
    const lastInserted = frag.lastChild;
    range.insertNode(frag);
    if (lastInserted) placeCaretAfter(lastInserted);
    emitChange();
    refreshQuery();
  }

  return (
    <>
      {matches.length > 0 && activeQuery && (
        <div
          role="listbox"
          aria-label="Tag an agent"
          className="mention-popover"
        >
          {matches.map((agent, i) => {
            const active = i === mentionIndex % matches.length;
            return (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`mention-popover-item${active ? " is-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  replaceWithPill(activeQuery.textNode, activeQuery.atOffset, activeQuery.endOffset, agent);
                }}
              >
                <AgentAvatar agent={agent} size="sm" hideTooltip />
                <div className="mention-popover-text">
                  <div className="mention-popover-head">
                    <span className="mention-popover-name">{agent.name}</span>
                    <span className="mention-popover-slug">@{agent.slug}</span>
                  </div>
                  {agent.description && (
                    <div className="mention-popover-desc">{agent.description}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={editorRef}
        className="chat-input chat-input--rich"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={refreshQuery}
        onClick={refreshQuery}
        onPaste={handlePaste}
      />
    </>
  );
}
