import React, { useEffect, useMemo, useState } from "react";
import { MessageSquare, MessagesSquare, PenLine } from "lucide-react";
import type { AgentRecord, ChatRecord } from "../../utils/types";
import { useAgents } from "../../contexts/AgentContext";
import AgentAvatar from "../agents/AgentAvatar";

/*
 * What the search dialog (ChatSearch.tsx) can find, one "section" per kind of thing.
 *
 * To make a new kind searchable (artifacts, SOPs, ...):
 *   1. Write a `useXxxSection(input)` hook here that returns a `SearchSection`: its rows as `options`
 *      (each knows how to open itself) and a `render` that draws them. Match in the browser like agents do,
 *      or fetch like chats do and report `pending` / `error`.
 *   2. Call it in ChatSearch.tsx and add the result to its `sections` array, at the position it should be drawn.
 * Arrow keys, Enter, hover, the empty state, the spinner and the footer count all follow from the section.
 */

/** One row Enter can open. */
export interface SearchOption {
  /** Unique across every section. */
  key: string;
  open: () => void;
}

/** Props that make an element a selectable row; spread them on the row for the option with this key. */
export type OptionProps = (key: string) => React.HTMLAttributes<HTMLElement> & { role: "option" };

export interface SearchSection {
  id: string;
  /** Heading drawn above the rows. */
  label: string;
  /** Rows in the order `render` draws them: this is the order the arrow keys follow. */
  options: SearchOption[];
  render: (optionProps: OptionProps) => React.ReactNode;
  /** A search for the current query is still running; any rows shown belong to an earlier query. */
  pending?: boolean;
  /** This kind could not be searched just now. */
  error?: string;
  /** For the footer, e.g. "3 chats". */
  summary?: string;
  /** Keep the heading for screen readers only (a section that is one self-explanatory row). */
  hideLabel?: boolean;
}

// ── Start a new chat ─────────────────────────────────────────────────────

/**
 * "New chat": first before anything is typed, last once there is a query (so Enter still opens the
 * best match), where it starts a new chat with the query already in the box.
 */
export function useNewChatSection({ query: q, onNewChat }: { query: string; onNewChat: (draft?: string) => void }): SearchSection {
  const label = q ? `New chat: “${q.length > 60 ? `${q.slice(0, 60)}…` : q}”` : "New chat";
  return {
    id: "new-chat",
    label: "Start",
    hideLabel: true,
    options: [{ key: "new-chat", open: () => onNewChat(q || undefined) }],
    render: (optionProps) => (
      <div {...optionProps("new-chat")} data-kind="action">
        <PenLine size={15} aria-hidden="true" />
        <span className="chat-search-title-text">{label}</span>
      </div>
    ),
  };
}

/** What every section is given. */
export interface SearchInput {
  /** The query, trimmed; empty before anything is typed. */
  query: string;
  /** The query's words and "quoted phrases", lower-cased. */
  terms: string[];
}

/** Words and "quoted phrases", the same way the server reads the query. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (m[1] ?? m[2]).replace(/\s+/g, " ").trim();
    if (term && term !== '"' && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every matched term wrapped in <mark>. */
export function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const pattern = useMemo(
    // Longest first, so "replication lag" wins over "lag" where both could match.
    () => (terms.length ? new RegExp(`(${[...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "gi") : null),
    [terms],
  );
  if (!pattern) return <>{text}</>;
  return (
    <>
      {text.split(pattern).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  );
}

function when(ms: number): string {
  const date = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(days > 300 ? { year: "numeric" } : {}) });
}

// ── Chats and messages (GET /chat/search) ────────────────────────────────

interface MessageMatch {
  index: number;
  role: "user" | "assistant";
  snippet: string;
  /** Found by meaning, not by its words: the query may not appear in the excerpt. */
  related?: boolean;
  /** Text that matched a search term without being it (another word form, or a corrected typo). */
  matched?: string[];
}

interface Hit {
  chatId: string;
  title: string;
  updatedAt: number;
  agentId?: string;
  titleMatch: boolean;
  matches: MessageMatch[];
  matchCount: number;
  /** Search terms this chat doesn't contain: it matched most of the query, not all. */
  missing?: string[];
}

const RECENT_COUNT = 8;
/** How long typing has to pause before a search is sent. */
const SEARCH_DEBOUNCE_MS = 250;

interface ChatSectionInput extends SearchInput {
  /** All chats, newest first; shown as "Recent" before anything is typed. */
  chats: ChatRecord[];
  /** Display name for a chat that belongs to an agent (its title is the agent's name). */
  agentName: (agentId: string) => string | undefined;
  /** Open a chat, at a particular message when a message excerpt was chosen. */
  onOpen: (chatId: string, messageIndex?: number) => void;
}

/** Recent chats before anything is typed, then chats and messages matching the query, ranked by the server. */
export function useChatSection({ query: q, terms, chats, agentName, onOpen }: ChatSectionInput): SearchSection {
  // A chat with a custom agent shows that agent's avatar, not the generic chat icon, and its replies are labelled with the agent's name.
  const { agentById } = useAgents();
  const chatIcon = (agentId?: string) => {
    const agent = agentId ? agentById.get(agentId) : undefined;
    return agent ? <AgentAvatar agent={agent} size="xs" hideTooltip /> : <MessagesSquare size={15} aria-hidden="true" />;
  };
  const replier = (agentId?: string) => (agentId ? agentById.get(agentId)?.name : undefined) ?? "Rye";
  const [result, setResult] = useState<{ query: string; hits: Hit[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    // Typing fires a request per pause, not per key, and a search still running for an earlier query is dropped.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/chat/search?q=${encodeURIComponent(q)}&limit=30`, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ hits: Hit[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data) => {
          if (cancelled) return;
          setFailed(false);
          setResult({ query: q, hits: data.hits });
        })
        .catch(() => { if (!cancelled) setFailed(true); });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  const recent = useMemo(() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_COUNT), [chats]);

  if (!q) {
    return {
      id: "chats",
      label: "Recent",
      options: recent.map((chat) => ({ key: `chat:${chat.id}`, open: () => onOpen(chat.id) })),
      render: (optionProps) =>
        recent.map((chat) => (
          <div key={chat.id} {...optionProps(`chat:${chat.id}`)} data-kind="chat">
            {chatIcon(chat.agentId)}
            <span className="chat-search-title-text">{(chat.agentId && agentName(chat.agentId)) || chat.title}</span>
            <span className="chat-search-when">{when(chat.updatedAt)}</span>
          </div>
        )),
    };
  }

  const hits = failed || !result ? [] : result.hits;
  const pending = !failed && (!result || result.query !== q);
  return {
    id: "chats",
    label: "Chats",
    pending,
    error: failed ? "Chat search isn't available right now." : undefined,
    summary: hits.length > 0 ?`${hits.length} ${hits.length === 1 ? "chat" : "chats"}` : undefined,
    // A chat that matched on its title alone is one row; otherwise each matching message is a row.
    options: hits.flatMap((hit) =>
      hit.matches.length > 0
        ? hit.matches.map((match) => ({ key: `chat:${hit.chatId}:${match.index}`, open: () => onOpen(hit.chatId, match.index) }))
        : [{ key: `chat:${hit.chatId}`, open: () => onOpen(hit.chatId) }],
    ),
    render: (optionProps) =>
      hits.map((hit) => {
        const title = (hit.agentId && agentName(hit.agentId)) || hit.title;
        const extra = hit.matchCount - hit.matches.length;
        const heading = (
          <>
            {chatIcon(hit.agentId)}
            <span className="chat-search-title-text"><Highlighted text={title} terms={terms} /></span>
            <span className="chat-search-when">{when(hit.updatedAt)}</span>
          </>
        );
        return (
          <section key={hit.chatId} className="chat-search-hit">
            {hit.matches.length === 0 ? (
              // Matched on its title alone: the heading is the thing to open.
              <div {...optionProps(`chat:${hit.chatId}`)} data-kind="chat">{heading}</div>
            ) : (
              <div className="chat-search-heading">{heading}</div>
            )}
            {hit.matches.map((match) => (
              <div key={match.index} {...optionProps(`chat:${hit.chatId}:${match.index}`)} data-kind="message">
                <MessageSquare size={13} aria-hidden="true" />
                <span className="chat-search-snippet-text">
                  <span className="chat-search-role">{match.role === "user" ? "You" : replier(hit.agentId)}</span>
                  {match.related && <span className="chat-search-related" title="Says something similar, in other words">Related</span>}
                  {/* Also what stood in for a term: another form of the word, or the right spelling of a typo. */}
                  <Highlighted text={match.snippet} terms={match.matched ? [...terms, ...match.matched] : terms} />
                </span>
              </div>
            ))}
            {extra > 0 && <div className="chat-search-more">+{extra} more matching {extra === 1 ? "message" : "messages"}</div>}
            {hit.missing && hit.missing.length > 0 && (
              <div className="chat-search-more">
                Missing: {hit.missing.map((term, i) => <React.Fragment key={term}>{i > 0 && ", "}<s>{term}</s></React.Fragment>)}
              </div>
            )}
          </section>
        );
      }),
  };
}

// ── Custom agents (matched in the browser) ───────────────────────────────

const AGENT_LIMIT = 8;
const EXCERPT_BEFORE = 40;
const EXCERPT_LENGTH = 160;

interface AgentMatch {
  agent: AgentRecord;
  score: number;
  /** The line under the name: the description, or the part of the instructions that matched. */
  detail: string;
}

/** An agent matches when every term is somewhere in its name, handle, description or instructions. */
function matchAgent(agent: AgentRecord, terms: string[]): AgentMatch | null {
  const name = agent.name.toLowerCase();
  const slug = agent.slug.toLowerCase();
  const description = agent.description.toLowerCase();
  const instructions = agent.instructions.replace(/\s+/g, " ");
  const instructionsLower = instructions.toLowerCase();
  let score = 0;
  let excerptAt = -1;
  for (const term of terms) {
    // "@handle" is how agents are written in a chat.
    const handle = term.replace(/^@/, "");
    if (name.startsWith(term)) score += 5;
    else if (name.includes(term)) score += 4;
    else if (handle && slug.includes(handle)) score += 3;
    else if (description.includes(term)) score += 2;
    else {
      const at = instructionsLower.indexOf(term);
      if (at < 0) return null;
      score += 1;
      if (excerptAt < 0) excerptAt = at;
    }
  }
  let detail = agent.description;
  if (excerptAt >= 0) {
    let start = Math.max(0, excerptAt - EXCERPT_BEFORE);
    // Begin at a word, not part-way through one.
    if (start > 0) start = instructions.lastIndexOf(" ", excerptAt - 1) < start ? excerptAt : instructions.indexOf(" ", start) + 1;
    const end = Math.min(instructions.length, start + EXCERPT_LENGTH);
    detail = `${start > 0 ? "…" : ""}${instructions.slice(start, end).trim()}${end < instructions.length ? "…" : ""}`;
  }
  return { agent, score, detail };
}

interface AgentSectionInput extends SearchInput {
  /** Open the agent's dedicated chat. */
  onOpenAgent: (agent: AgentRecord) => void;
}

/** Custom agents whose name, handle, description or instructions contain the query. Nothing before a query is typed. */
export function useAgentSection({ query: q, terms, onOpenAgent }: AgentSectionInput): SearchSection {
  const { agents } = useAgents();
  const matches = useMemo(() => {
    if (!q || !agents) return [];
    return agents
      .map((agent) => matchAgent(agent, terms))
      .filter((m): m is AgentMatch => m !== null)
      .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name))
      .slice(0, AGENT_LIMIT);
  }, [q, terms, agents]);

  return {
    id: "agents",
    label: "Agents",
    summary: matches.length > 0 ? `${matches.length} ${matches.length === 1 ? "agent" : "agents"}` : undefined,
    options: matches.map(({ agent }) => ({ key: `agent:${agent.id}`, open: () => onOpenAgent(agent) })),
    render: (optionProps) =>
      matches.map(({ agent, detail }) => (
        <div key={agent.id} {...optionProps(`agent:${agent.id}`)} data-kind="agent">
          <AgentAvatar agent={agent} size="md" hideTooltip />
          <span className="chat-search-agent-text">
            <span className="chat-search-agent-name">
              <span className="chat-search-title-text"><Highlighted text={agent.name} terms={terms} /></span>
              <span className="chat-search-agent-handle">@<Highlighted text={agent.slug} terms={terms.map((t) => t.replace(/^@/, "")).filter(Boolean)} /></span>
            </span>
            {detail && <span className="chat-search-agent-detail"><Highlighted text={detail} terms={terms} /></span>}
          </span>
        </div>
      )),
  };
}
