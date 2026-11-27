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

/** Put the caret after a pill and the character that follows it (adding that character if it's missing). */
function placeCaretAfterPill(pill: HTMLElement, trailingChar: string) {
  const sel = window.getSelection();
  if (!sel) return;
  let next = pill.nextSibling;
  const hasTrailing =
    !trailingChar ||
    (next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "").replace(/[^\S\r\n]/g, " ").startsWith(trailingChar)); // any space, incl. no-break
  if (!hasTrailing) {
    next = document.createTextNode(trailingChar);
    pill.after(next);
  }
  const range = document.createRange();
  if (trailingChar && next) range.setStart(next, trailingChar.length);
  else range.setStartAfter(pill);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The pills directly before and after a collapsed caret inside `root` (null when there's none). */
function pillsBesideCaret(root: HTMLElement): { before: HTMLElement | null; after: HTMLElement | null } {
  const none = { before: null, after: null };
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return none;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return none;
  const { startContainer: node, startOffset: offset } = range;
  let before: Node | null = null;
  let after: Node | null = null;
  if (node.nodeType === Node.TEXT_NODE) {
    const length = (node.textContent ?? "").length;
    if (offset === 0 || (node.textContent ?? "").replace(/\p{Cf}/gu, "") === "") before = node.previousSibling;
    if (offset >= length) after = node.nextSibling;
  } else {
    before = node.childNodes[offset - 1] ?? null;
    after = node.childNodes[offset] ?? null;
  }
  return { before: isMentionPill(before) ? before : null, after: isMentionPill(after) ? after : null };
}

/** Collapse the caret just before or just after a node. */
function placeCaretBeside(node: Node, side: "before" | "after") {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (side === "before") range.setStartBefore(node);
  else range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/*
 * Edits made by changing the DOM directly never reach the browser's undo history, so a later
 * Cmd/Ctrl+Z replays its own steps against text that has moved and scrambles the draft. Every edit
 * the composer makes itself (paste, Shift+Enter, turning @slug into a pill) goes through
 * execCommand instead, which records it as one undo step. execCommand is deprecated but is still
 * the only way to edit a contentEditable undoably; each caller keeps a direct-DOM fallback for a
 * browser that refuses it.
 */

/** Markup for a fragment, as insertHTML wants it. */
function fragmentHtml(frag: DocumentFragment): string {
  const box = document.createElement("div");
  box.appendChild(frag);
  return box.innerHTML;
}

/** Replace the selection with markup as one undoable edit; false if the browser refused. */
function insertHtmlUndoable(html: string): boolean {
  try {
    return document.execCommand("insertHTML", false, html);
  } catch {
    return false;
  }
}

/** Insert a line break at the caret as one undoable edit; false if the browser refused. */
function insertLineBreakUndoable(): boolean {
  try {
    return document.execCommand("insertLineBreak");
  } catch {
    return false;
  }
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  ariaLabel: string;
  autoFocusTrigger?: unknown;
  /** Escape (with no tag suggestions open) calls this, e.g. to leave the inline message editor. */
  onCancel?: () => void;
  /** Classes for the editable field; the chat composer's by default. */
  className?: string;
  /** Files pasted into the field (a screenshot, files copied in Finder). Without it, pasting files does nothing. */
  onPasteFiles?: (files: File[]) => void;
}

export default function MentionComposer({
  value,
  onChange,
  onSend,
  placeholder,
  ariaLabel,
  autoFocusTrigger,
  onCancel,
  className = "chat-input",
  onPasteFiles,
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
    // Note that the agents have loaded even when nothing is redrawn now. Otherwise the first "@" typed
    // or pasted later looks like "agents just loaded" and redraws the field, which moves the caret to
    // the end and leaves the browser's undo history pointing at nodes that are gone.
    lastHydratedAgentCountRef.current = agentBySlug.size;
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

  /*
   * Arrowing through a tag takes three steps: the caret beside it, then "in" it (the tag ringed, the
   * caret hidden: the ring is the caret), then out the other side; the opposite arrow backs out the way
   * it came. In it, Backspace/Delete removes the tag. The caret itself stays beside the tag meanwhile;
   * the step is remembered here and dropped as soon as the caret moves anywhere else.
   */
  const focusedPillRef = useRef<HTMLElement | null>(null);
  const focusPill = useCallback((pill: HTMLElement | null) => {
    const el = editorRef.current;
    const previous = focusedPillRef.current;
    if (previous && previous !== pill) previous.classList.remove("is-caret");
    focusedPillRef.current = pill;
    pill?.classList.add("is-caret");
    el?.classList.toggle("has-caret-pill", Boolean(pill));
  }, []);

  useEffect(() => {
    const update = () => {
      const el = editorRef.current;
      const pill = focusedPillRef.current;
      if (!el || !pill) return;
      const beside = pillsBesideCaret(el);
      const stillThere =
        document.activeElement === el && el.contains(pill) && (beside.before === pill || beside.after === pill);
      if (!stillThere) focusPill(null);
    };
    document.addEventListener("selectionchange", update);
    const el = editorRef.current;
    el?.addEventListener("blur", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      el?.removeEventListener("blur", update);
    };
  }, [focusPill]);

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

      // Undoably: select the typed "@query" and replace it with the pill (see insertHtmlUndoable).
      const current = window.getSelection();
      if (current) {
        const typed = document.createRange();
        typed.setStart(textNode, atOffset);
        typed.setEnd(textNode, endOffset);
        current.removeAllRanges();
        current.addRange(typed);
        const replacement = document.createDocumentFragment();
        const marked = createMentionPillNode(agent);
        marked.dataset.mentionNew = "1";
        replacement.appendChild(marked);
        replacement.appendChild(document.createTextNode(trailingChar));
        if (insertHtmlUndoable(fragmentHtml(replacement))) {
          // insertHTML may drop the trailing space and can leave the caret before the uneditable pill,
          // so put the caret after the pill and its space ourselves.
          const inserted = editorRef.current?.querySelector<HTMLElement>("[data-mention-new]");
          if (inserted) {
            delete inserted.dataset.mentionNew;
            placeCaretAfterPill(inserted, trailingChar);
          }
          setActiveQuery(null);
          setMentionIndex(0);
          setDismissed(false);
          emitChange();
          return;
        }
      }

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

    // Stepping into and out of a tag with the arrows (see focusPill).
    const plainKey = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    const focused = focusedPillRef.current;
    if (focused && plainKey) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        focusPill(null);
        placeCaretBeside(focused, e.key === "ArrowLeft" ? "before" : "after");
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        const after = focused.nextSibling;
        focusPill(null);
        focused.remove();
        if (after) placeCaretBeside(after, "before");
        emitChange();
        refreshQuery();
        return;
      }
    }
    if (focused && e.key !== "Shift") focusPill(null);
    if (!focused && plainKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const el = editorRef.current;
      const beside = el ? pillsBesideCaret(el) : { before: null, after: null };
      const next = e.key === "ArrowRight" ? beside.after : beside.before;
      if (next) {
        e.preventDefault();
        focusPill(next);
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

    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
      return;
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
      if (insertLineBreakUndoable()) {
        emitChange();
        return;
      }
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
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0 && onPasteFiles) {
      onPasteFiles(files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    // One undo step for the whole paste (see insertHtmlUndoable); the editor is pre-wrap, so spacing survives.
    if (!insertHtmlUndoable(fragmentHtml(buildNodesFromText(text, agentBySlug)))) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const frag = buildNodesFromText(text, agentBySlug);
      const lastInserted = frag.lastChild;
      range.insertNode(frag);
      if (lastInserted) placeCaretAfter(lastInserted);
    }
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
        className={`${className} chat-input--rich`}
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
