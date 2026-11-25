import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, Search } from "lucide-react";
import type { AgentRecord, ChatRecord } from "../../utils/types";
import { queryTerms, useAgentSection, useChatSection, useNewChatSection, type OptionProps, type SearchSection } from "./searchSections";

interface Props {
  /** All chats, newest first; shown as "Recent" before anything is typed. */
  chats: ChatRecord[];
  /** The chat list hasn't arrived from the server yet. */
  chatsLoading?: boolean;
  /** Display name for a chat that belongs to an agent (its title is the agent's name). */
  agentName: (agentId: string) => string | undefined;
  /** Open a chat, at a particular message when a message excerpt was chosen. */
  onOpen: (chatId: string, messageIndex?: number) => void;
  /** Open an agent's dedicated chat. */
  onOpenAgent: (agent: AgentRecord) => void;
  /** Start a new chat, with `draft` in the composer when given. Without it, no "New chat" row is offered. */
  onNewChat?: (draft?: string) => void;
  onClose: () => void;
}

/**
 * Search in a dialog over the app (Cmd/Ctrl+K): chats and messages, and custom agents.
 * Each kind of result is a section from searchSections.tsx; this component only lays them out and handles the keys.
 */
export default function ChatSearchModal({ chats, chatsLoading = false, agentName, onOpen, onOpenAgent, onNewChat, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const terms = useMemo(() => queryTerms(query), [query]);
  const q = query.trim();

  // Every kind of result, in the order drawn. A new kind is one more hook from searchSections.tsx, added here.
  // Agents first: they match instantly, while chat results arrive after a debounce and a fetch.
  // The other way round, the agent row appeared and was then pushed down under the chats.
  const agentSection = useAgentSection({ query: q, terms, onOpenAgent });
  const chatSection = useChatSection({ query: q, terms, chats, agentName, onOpen });
  const newChat = useNewChatSection({ query: q, onNewChat: onNewChat ?? (() => {}) });
  // "New chat" leads before anything is typed, and follows the results once there is a query, so Enter opens the best match.
  const sections: SearchSection[] = [
    ...(onNewChat && !q ? [newChat] : []),
    agentSection,
    chatSection,
    ...(onNewChat && q ? [newChat] : []),
  ];
  const shown = sections.filter((section) => section.options.length > 0);
  // Everything the arrow keys step through, in the order it is drawn.
  const options = shown.flatMap((section) => section.options);
  const waiting = sections.some((section) => section.pending);
  const errors = sections.flatMap((section) => (section.error ? [section.error] : []));
  const summary = shown.flatMap((section) => (section.summary ? [section.summary] : [])).join(" · ");

  // Put focus back where it was when the dialog closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, []);

  // A different set of rows starts again from the first.
  const optionKeys = options.map((option) => option.key).join("\n");
  useEffect(() => { setActive(0); }, [optionKeys]);
  const activeIndex = Math.min(active, options.length - 1);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    option.open();
    onClose();
  };

  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, optionKeys]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      setActive((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Tab") {
      // The search field is the only stop; keep focus in the dialog.
      event.preventDefault();
    }
  };

  const optionProps: OptionProps = (key) => {
    const index = options.findIndex((o) => o.key === key);
    return {
      role: "option",
      "aria-selected": index === activeIndex,
      className: index === activeIndex ? "is-active" : undefined,
      onMouseMove: () => setActive(index),
      onClick: () => choose(index),
    };
  };

  const empty = !q
    ? chatsLoading ? "Loading chats…" : "No conversations yet."
    : waiting ? "Searching…" : errors[0] ?? `Nothing matches "${q}".`;

  return createPortal(
    <div
      className="chat-search-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="chat-search-dialog" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={onKeyDown}>
        <label className="chat-search-field">
          <Search size={17} aria-hidden="true" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats, messages and agents"
            aria-label="Search chats, messages and agents"
            aria-controls="chat-search-list"
            autoComplete="off"
            spellCheck={false}
          />
          {/* Results on screen belong to an earlier query until the new ones arrive. */}
          {waiting && <span className="chat-search-spinner" role="status" aria-label="Searching" />}
          <kbd>esc</kbd>
        </label>

        <div
          ref={listRef}
          id="chat-search-list"
          className="chat-search-list"
          role="listbox"
          aria-label={q ? "Results" : "Recent chats"}
          aria-busy={waiting}
        >
          {shown.length === 0 ? (
            <div className="chat-search-empty" role="status">{empty}</div>
          ) : (
            <>
              {shown.map((section) => (
                <div
                  key={section.id}
                  className={`chat-search-section${section.pending ? " is-stale" : ""}`}
                  role="group"
                  aria-labelledby={`chat-search-group-${section.id}`}
                  data-section={section.id}
                >
                  <div className={`chat-search-group${section.hideLabel ? " chat-search-group--hidden" : ""}`} id={`chat-search-group-${section.id}`}>{section.label}</div>
                  {section.render(optionProps)}
                </div>
              ))}
              {/* A kind that couldn't be searched, said under the ones that could. */}
              {errors.map((error) => <div key={error} className="chat-search-more" role="status">{error}</div>)}
            </>
          )}
        </div>

        <div className="chat-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd><CornerDownLeft size={11} /></kbd> to open</span>
          {q && summary && <span className="chat-search-count">{summary}</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
