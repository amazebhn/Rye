import React, {
  useCallback,
  useEffect,
  useRef,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PendingPrompt } from "@rye/shared";
import type { MessageMeta, RenderMessage } from "../../utils/types";
import { isDenial, permissionOutcome } from "../../utils/approval";
import { formatModelName } from "../../utils/modelNames";
import ActivityTimeline from "./ActivityTimeline";
import PromptWidget from "./PromptWidget";
import ChatLink from "./ChatLink";
import CodeBlock from "./CodeBlock";
import MarkdownTable from "./MarkdownTable";
import { ChartSessionContext } from "./ChartBlock";
import ArtifactCard, { artifactRefs } from "../artifacts/ArtifactCard";
import TableFrame from "../shared/TableFrame";
import ResultDataGrid from "../results/ResultDataGrid";
import AgentAvatar from "../agents/AgentAvatar";
import AgentHoverCard, { AgentMentionText } from "../agents/AgentHoverCard";
import { useAgents } from "../../contexts/AgentContext";
import {
  ArrowDown,
  Check,
  CircleAlert,
  Copy,
  CornerDownRight,
  Info,
  Pencil,
  RotateCcw,
  Pause,
  Play,
  X,
} from "lucide-react";

// Distance from the bottom that still counts as "at the latest message".
const NEAR_BOTTOM_PX = 80;

function TypingIndicator() {
  return (
    <div
      className="typing-indicator"
      role="status"
      aria-label="Assistant is responding"
    >
      <span />
      <span />
      <span />
    </div>
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  "github-copilot": "GitHub Copilot",
  ollama: "Ollama",
  claude: "Claude",
};
const STATUS_LABELS: Record<NonNullable<MessageMeta["status"]>, string> = {
  done: "Completed",
  stopped: "Stopped",
  error: "Failed",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Single replies usually cost fractions of a cent, so "<$0.01" would hide the useful part.
function formatReplyCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return "<$0.0001";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// A failed run's partial answer and error. Older chats stored the error inside the content.
function runFailure(msg: RenderMessage): { answer: string; error: string } | null {
  if (msg.meta?.status !== "error") return null;
  if (msg.meta.error) return { answer: msg.content, error: msg.meta.error };
  const marker = msg.content.lastIndexOf("**Error:** ");
  if (marker !== -1) {
    return { answer: msg.content.slice(0, marker).trim(), error: msg.content.slice(marker + 11).trim() };
  }
  if (msg.content.startsWith("Error: ")) return { answer: "", error: msg.content.slice(7) };
  return { answer: msg.content, error: "The response failed." };
}

interface ErrorInfo {
  title: string;
  description: string;
  // Raw error text, shown small when the description is a rewrite of it.
  technical?: string;
}

function errorInfo(error: string): ErrorInfo {
  // The backend already explains content-filter blocks in plain language.
  if (/content.?filter/i.test(error)) {
    return {
      title: "Blocked by content filter.",
      description: error.replace(/^Copilot's content filter blocked this response\.\s*/, "") || "Copilot didn't say why.",
    };
  }
  if (/\b(401|403)\b|auth|unauthori[sz]ed|forbidden/i.test(error)) {
    const service = /^Claude:|\/login/.test(error) ? "Claude Code" : "GitHub Copilot";
    return { title: "Couldn't authenticate.", description: `Check that ${service} is signed in.`, technical: error };
  }
  if (/\b429\b|rate.?limit/i.test(error)) {
    return { title: "Rate limited.", description: "Try again in a moment.", technical: error };
  }
  if (/network|fetch|ECONN|timed? ?out|connection/i.test(error)) {
    return { title: "Connection lost.", description: "The reply was cut off before it finished.", technical: error };
  }
  return { title: "Something went wrong.", description: error };
}

function ErrorCard({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const { title, description, technical } = errorInfo(error);
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="error-notice">
      <CircleAlert size={14} className="error-notice-icon" aria-hidden="true" />
      <div className="error-notice-text">
        <span className="error-notice-title">{title}</span> {description}
        {technical && (
          <>
            {" "}
            <button
              type="button"
              className="error-notice-details-toggle"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((v) => !v)}
            >
              {showDetails ? "Hide details" : "Details"}
            </button>
            {showDetails && <code className="error-notice-technical">{technical}</code>}
          </>
        )}
      </div>
      {onRetry && (
        <button type="button" className="error-notice-retry" onClick={onRetry}>
          <RotateCcw size={13} aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
}

function MessageInfo({
  meta,
  toolCallCount,
  pauses,
}: {
  meta: MessageMeta;
  toolCallCount: number;
  pauses: number;
}) {
  const cardId = React.useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "below" | "above" } | null>(null);

  // Fixed coordinates escape the scrolling list's clipping, so the card draws over the composer.
  const place = useCallback(() => {
    const button = buttonRef.current;
    const card = cardRef.current;
    if (!button || !card) return;
    const b = button.getBoundingClientRect();
    const gap = 8;
    const margin = 12;
    const below = window.innerHeight - b.bottom - gap - margin;
    const above = b.top - gap - margin;
    const placement = below >= card.offsetHeight || below >= above ? "below" : "above";
    setPos({
      placement,
      top: placement === "below" ? b.bottom + gap : Math.max(margin, b.top - gap - card.offsetHeight),
      left: Math.max(margin, Math.min(b.left, window.innerWidth - card.offsetWidth - margin)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [active, place]);

  const rows: Array<[string, string]> = [];
  if (meta.model) {
    const provider = meta.provider
      ? (PROVIDER_NAMES[meta.provider] ?? meta.provider)
      : undefined;
    rows.push([
      "Model",
      formatModelName(meta.model) + (provider ? ` · ${provider}` : ""),
    ]);
  }
  if (meta.finishedAt)
    rows.push([
      "Response time",
      formatDuration(meta.finishedAt - meta.startedAt),
    ]);
  if (meta.firstTokenAt)
    rows.push([
      "First output",
      formatDuration(meta.firstTokenAt - meta.startedAt),
    ]);
  if (meta.inputTokens !== undefined || meta.outputTokens !== undefined) {
    rows.push([
      "Tokens",
      `${(meta.inputTokens ?? 0).toLocaleString()} in · ${(meta.outputTokens ?? 0).toLocaleString()} out`,
    ]);
  }
  if (meta.llmCalls) rows.push(["Model calls", String(meta.llmCalls)]);
  if (meta.costUsd !== undefined || meta.unpricedCalls) {
    const priced = meta.costUsd !== undefined;
    rows.push([
      "Est. cost",
      !priced
        ? "No pricing"
        : formatReplyCost(meta.costUsd!) + (meta.unpricedCalls ? " + unpriced" : ""),
    ]);
  }
  if (toolCallCount > 0) rows.push(["Tool calls", String(toolCallCount)]);
  if (pauses > 0)
    rows.push(["Paused for input", pauses === 1 ? "Once" : `${pauses} times`]);
  if (meta.env)
    rows.push(["Environment", meta.env === "default" ? "Default" : meta.env]);
  if (meta.status && meta.status !== "done")
    rows.push(["Status", STATUS_LABELS[meta.status]]);
  rows.push([
    "Sent",
    // Year only when it isn't this year, to keep the value short.
    new Date(meta.startedAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...(new Date(meta.startedAt).getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }),
  ]);

  return (
    <span
      className="message-info"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn copy message-action"
        aria-label="Message details"
        aria-describedby={cardId}
      >
        <Info size={14} />
      </button>
      <span
        ref={cardRef}
        id={cardId}
        role="tooltip"
        className="message-info-card"
        data-placement={pos?.placement ?? "below"}
        style={pos ? { top: pos.top, left: pos.left } : undefined}
      >
        <dl>
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </span>
    </span>
  );
}

// One reply's runs read as one: first start to last finish, summed usage, latest model/env/status.
function mergeMeta(segments: RenderMessage[]): MessageMeta | undefined {
  const metas = segments.flatMap((m) => (m.meta ? [m.meta] : []));
  if (metas.length <= 1) return metas[0];
  const first = metas[0];
  const last = metas[metas.length - 1];
  const sum = (key: "inputTokens" | "outputTokens" | "llmCalls" | "costUsd" | "unpricedCalls") =>
    metas.some((m) => m[key] !== undefined)
      ? metas.reduce((n, m) => n + (m[key] ?? 0), 0)
      : undefined;
  return {
    startedAt: first.startedAt,
    firstTokenAt: first.firstTokenAt,
    finishedAt: last.finishedAt,
    model: last.model,
    provider: last.provider,
    env: last.env,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    llmCalls: sum("llmCalls"),
    costUsd: sum("costUsd"),
    unpricedCalls: sum("unpricedCalls"),
    status: last.status,
  };
}

// Older chats stored a literal "continue" user turn and appended this notice to the reply text.
const LEGACY_PAUSE = /\s*Reached (?:(\d+) tool-call rounds|tool-call limit)\. Reply \*\*continue\*\* to keep investigating\.\s*$/;

function pauseInfo(msg: RenderMessage): { content: string; paused: boolean; rounds?: number } {
  const legacy = msg.content.match(LEGACY_PAUSE);
  return {
    content: legacy ? msg.content.slice(0, legacy.index) : msg.content,
    paused: Boolean(msg.paused || msg.pause || legacy),
    rounds: msg.pause?.rounds ?? (legacy?.[1] ? Number(legacy[1]) : undefined),
  };
}

const isContinue = (m?: RenderMessage) =>
  m?.role === "user" && (m.kind === "continue" || (!m.kind && /^continue[.!]?$/i.test(m.content.trim())));

// Turns that render inside the reply they extend rather than as a user bubble.
const isInline = (m?: RenderMessage) => Boolean(m?.kind) || isContinue(m);

function replyMarkdown(msgs: RenderMessage[]): string {
  return msgs
    .map((m) => {
      if (m.role === "assistant") return (runFailure(m)?.answer ?? pauseInfo(m).content).trim();
      if (isContinue(m)) return "";
      if (m.kind === "approval") return `> ${permissionOutcome(m.content)}`;
      return `> Answered: ${m.content.trim().split("\n").join("\n> ")}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function PromptAnswer({
  msg,
  inline,
  rounds,
}: {
  msg: RenderMessage;
  inline?: boolean;
  rounds?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (isContinue(msg)) {
    return (
      <div className="continue-divider" role="separator" aria-label="Continued">
        <span>Continued{rounds ? ` after ${rounds} rounds` : ""}</span>
      </div>
    );
  }
  const className = `approval-outcome${inline ? " approval-outcome--inline" : ""}`;
  if (msg.kind === "answer") {
    return (
      <div className={`${className} answer-outcome`}>
        <CornerDownRight size={12} aria-hidden="true" />
        <span className="answer-outcome-label">Answered</span>
        <button
          type="button"
          className={`answer-outcome-text${expanded ? " expanded" : ""}`}
          aria-expanded={expanded}
          title={expanded ? undefined : msg.content}
          onClick={() => setExpanded((v) => !v)}
        >
          {msg.content}
        </button>
      </div>
    );
  }
  const denied = isDenial(msg.content);
  return (
    <div className={`${className}${denied ? " denied" : ""}`}>
      {denied ? (
        <X size={12} aria-hidden="true" />
      ) : (
        <Check size={12} aria-hidden="true" />
      )}
      {permissionOutcome(msg.content)}
    </div>
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, string> };
}

function markdownNodeText(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(markdownNodeText).join("") ?? "";
}

/** Attach an immediately preceding Markdown heading to its table element. */
function remarkTableTitles() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      const children = parent.children ?? [];
      children.forEach((node, index) => {
        if (node.type === "table") {
          const preceding = children[index - 1];
          if (preceding?.type === "heading") {
            const title = markdownNodeText(preceding).trim();
            if (title) {
              node.data = {
                ...node.data,
                hProperties: {
                  ...node.data?.hProperties,
                  "data-table-title": title,
                },
              };
            }
          }
        }
        visit(node);
      });
    };
    visit(tree);
  };
}

function markdownTable(table: HTMLTableElement | null): string {
  if (!table) return "";
  const rows = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map(
      (entry) => entry.textContent?.trim().replace(/\|/g, "\\|") ?? "",
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalize = (row: string[]) => [
    ...row,
    ...Array(Math.max(0, width - row.length)).fill(""),
  ];
  const header = normalize(rows[0]);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${normalize(row).join(" | ")} |`),
  ].join("\n");
}

// A reply table opened full screen becomes the same grid stored results use: sortable, groupable, chartable.
function MarkdownTableGrid({ tableRef }: { tableRef: React.RefObject<HTMLTableElement> }) {
  const data = useMemo(() => {
    const table = tableRef.current;
    if (!table || table.rows.length === 0) return null;
    const cells = Array.from(table.rows).map((row) => Array.from(row.cells).map((entry) => entry.textContent?.trim() ?? ""));
    // Column names double as row keys, so repeats and blanks are made unique.
    const seen = new Map<string, number>();
    const columns = cells[0].map((name, index) => {
      const base = name || `Column ${index + 1}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base} (${count + 1})`;
    });
    const rows = cells.slice(1).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""])));
    return { columns, rows };
    // The table's DOM is complete by the time full screen can be opened.
  }, [tableRef]);
  if (!data) return null;
  return <ResultDataGrid columns={data.columns} rows={data.rows} />;
}

// The table as CSV, in the order it is currently sorted. Values a spreadsheet would run as a formula are quoted off.
function csvTable(table: HTMLTableElement | null): string {
  if (!table) return "";
  const escape = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) && Number.isNaN(Number(value)) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells).map((entry) => escape(entry.textContent?.trim() ?? "")).join(","))
    .join("\n");
}

function downloadCsv(contents: string, title?: string) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const filename =
    title
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "table";
  anchor.download = `${filename}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Renders a table centred in the .main container regardless of where the
// prose body happens to be positioned inside it.
function WideTable({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    function recalc() {
      const el = wrapRef.current;
      if (!el) return;
      // Walk up to find .main
      let main: Element | null = el;
      while (main && !main.classList.contains("main"))
        main = main.parentElement;
      if (!main) return;

      const marginX = 10;

      const mainRect = main.getBoundingClientRect();
      const messageRect = el?.parentElement?.getBoundingClientRect() ?? {
        width: 0,
        x: 0,
      };
      const TABLE_MAX = Math.min(mainRect.width, 1140) - marginX * 2;

      // Also fix the width so it matches what we measured
      el.style.width = TABLE_MAX + "px";
      setOffset(
        mainRect.x - messageRect.x + marginX + (mainRect.width - TABLE_MAX) / 2,
      );
    }
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="md-table-wrap"
      style={{ transform: `translateX(${offset}px)` }}
    >
      <TableFrame
        title={title}
        onCopy={() =>
          navigator.clipboard.writeText(markdownTable(tableRef.current))
        }
        onDownload={() => downloadCsv(csvTable(tableRef.current), title)}
        copyLabel="Copy as Markdown"
        downloadLabel="Download CSV"
        fullscreenContent={<MarkdownTableGrid tableRef={tableRef} />}
      >
        <div className="md-table-scroll">
          <MarkdownTable tableRef={tableRef}>{children}</MarkdownTable>
        </div>
      </TableFrame>
    </div>
  );
}

interface Props {
  messages: RenderMessage[];
  chatId?: string;
  sessionId: string;
  loading: boolean;
  isViewingInflight: boolean;
  onNewChat: (opts: { display: string; context: string }) => void;
  onOpenArtifact: (id: string, version: number) => void;
  onContinue: () => void;
  canResubmit: boolean;
  onResubmit: (userIndex: number, text: string) => void;
  pendingPrompt?: PendingPrompt;
  onPromptAnswer: (answer: string) => void;
}

interface MessageProps {
  // A user message, or an assistant reply: segments alternating with the prompt answers between them.
  msgs: RenderMessage[];
  sessionId: string;
  index: number;
  isLast: boolean;
  promptMessageIndex: number;
  loading: boolean;
  isViewingInflight: boolean;
  onNewChat: (opts: { display: string; context: string }) => void;
  onOpenArtifact: (id: string, version: number) => void;
  onContinue: () => void;
  canResubmit: boolean;
  onRetry?: () => void;
  onEdit?: (text: string) => void;
  pendingPrompt?: PendingPrompt;
  onPromptAnswer: (answer: string) => void;
  continuing: boolean;
  setContinuing: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function MessageList({
  messages,
  chatId,
  sessionId,
  loading,
  isViewingInflight,
  onNewChat,
  onOpenArtifact,
  onContinue,
  canResubmit,
  onResubmit,
  pendingPrompt,
  onPromptAnswer,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether growing content should keep the view pinned to the bottom.
  const followRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const jumpVisibleRef = useRef(false);
  const hasNewRef = useRef(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  // Guards the gap between click and `loading` turning true.
  const [continuing, setContinuing] = useState(false);

  const showJump = useCallback((visible: boolean) => {
    if (jumpVisibleRef.current === visible) return;
    jumpVisibleRef.current = visible;
    setJumpVisible(visible);
  }, []);

  const markNew = useCallback((value: boolean) => {
    if (hasNewRef.current === value) return;
    hasNewRef.current = value;
    setHasNew(value);
  }, []);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    followRef.current = true;
    markNew(false);
    showJump(false);
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  }, [markNew, showJump]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      const distance = el.scrollHeight - top - el.clientHeight;
      // Clamping after content shrinks lands exactly at the bottom, so only a real upward scroll detaches.
      if (distance <= 2) followRef.current = true;
      else if (top < lastScrollTopRef.current) followRef.current = false;
      else if (distance <= NEAR_BOTTOM_PX) followRef.current = true;
      lastScrollTopRef.current = top;
      if (followRef.current) markNew(false);
      showJump(distance > NEAR_BOTTOM_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Expanding a trace or tool call is reading in place: stop following so it grows downward instead of pinning to the bottom.
    const onToggle = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[aria-expanded]"))
        followRef.current = false;
    };
    el.addEventListener("click", onToggle, true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onToggle, true);
    };
  }, [markNew, showJump]);

  // Content (late markdown, tables, fetched results) and viewport (composer growth) resizes.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) {
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      } else {
        showJump(
          el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_BOTTOM_PX,
        );
      }
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showJump]);

  // Opening or switching chats lands on the latest message without animating.
  useLayoutEffect(() => {
    pinToBottom();
  }, [chatId, pinToBottom]);

  let lastUser: RenderMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = messages[i];
      break;
    }
  }
  const lastUserKey: unknown = lastUser?.id ?? lastUser;
  const lastUserKeyRef = useRef(lastUserKey);
  // A new user turn on screen is the user's own send: always follow it.
  useLayoutEffect(() => {
    if (lastUserKeyRef.current === lastUserKey) return;
    lastUserKeyRef.current = lastUserKey;
    if (lastUserKey !== undefined) pinToBottom();
  }, [lastUserKey, pinToBottom]);

  useLayoutEffect(() => {
    if (!followRef.current) markNew(true);
  }, [messages, markNew]);

  function jumpToLatest(e: React.MouseEvent<HTMLButtonElement>) {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    markNew(false);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
    // Keyboard activation (detail 0): the button disappears, so hand focus to the composer.
    if (e.detail === 0)
      document
        .querySelector<HTMLTextAreaElement>(".chat-input")
        ?.focus({ preventScroll: true });
  }

  React.useEffect(() => {
    if (loading) setContinuing(false);
  }, [loading]);

  let promptMessageIndex = -1;
  if (pendingPrompt) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i].role === "assistant" &&
        (messages[i].toolCalls?.length ?? 0) > 0
      ) {
        promptMessageIndex = i;
        break;
      }
    }
  }

  const lastIndex = messages.length - 1;
  // A reply is an assistant message plus any (prompt answer or continue, assistant) pairs that extend it.
  const items: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    let end = i;
    if (messages[i].role === "assistant") {
      while (isInline(messages[end + 1]) && messages[end + 2]?.role === "assistant")
        end += 2;
    }
    items.push({ start: i, end });
    i = end;
  }

  // Retry re-runs the last real user turn; approval answers in between are part of that turn.
  let retryUserIndex = -1;
  if (messages[lastIndex]?.role === "assistant") {
    for (let i = lastIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !isInline(messages[i])) {
        retryUserIndex = i;
        break;
      }
    }
  }

  const msgProps = {
    promptMessageIndex,
    sessionId,
    onNewChat,
    onOpenArtifact,
    pendingPrompt,
    onPromptAnswer,
    isViewingInflight,
    loading,
    onContinue,
    canResubmit,
    continuing,
    setContinuing,
  };

  return (
    <div className="message-list-shell">
      <div ref={scrollRef} className="message-list">
        <div ref={contentRef} className="message-list-content">
          {items.map(({ start, end }) =>
            isInline(messages[start]) ? (
              <PromptAnswer key={start} msg={messages[start]} rounds={start > 0 ? pauseInfo(messages[start - 1]).rounds : undefined} />
            ) : (
              <Message
                key={start}
                msgs={messages.slice(start, end + 1)}
                index={start}
                isLast={end === lastIndex}
                onRetry={
                  canResubmit && retryUserIndex !== -1 && end === lastIndex
                    ? () =>
                        onResubmit(
                          retryUserIndex,
                          messages[retryUserIndex].content,
                        )
                    : undefined
                }
                onEdit={
                  messages[start].role === "user"
                    ? (text) => onResubmit(start, text)
                    : undefined
                }
                {...msgProps}
              />
            ),
          )}
        </div>
      </div>
      {jumpVisible && (
        <button
          type="button"
          className="jump-to-latest"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={jumpToLatest}
        >
          <ArrowDown size={16} aria-hidden="true" />
          {hasNew && <span className="jump-to-latest-dot" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

// Module-level so renderers keep their identity (and link hover state) across streaming re-renders.
const ANSWER_COMPONENTS: Components = {
  table: ({ children, ...tableProps }) => {
    const title = (tableProps as Record<string, unknown>)["data-table-title"];
    return <WideTable title={typeof title === "string" ? title : undefined}>{children}</WideTable>;
  },
  a: ChatLink,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

interface AssistantSegmentProps {
  msg: RenderMessage;
  sessionId: string;
  onNewChat: (opts: { display: string; context: string }) => void;
  onOpenArtifact: (id: string, version: number) => void;
  pendingPrompt?: PendingPrompt;
  onPromptAnswer?: (answer: string) => void;
  streaming: boolean;
  showTyping: boolean;
  loading: boolean;
  continuing: boolean;
  resumed: boolean;
  onContinue: () => void;
  onRetry?: () => void;
}

// One assistant run's activity timeline and markdown.
function AssistantSegment({
  msg,
  sessionId,
  onNewChat,
  onOpenArtifact,
  pendingPrompt,
  onPromptAnswer,
  streaming,
  showTyping,
  loading,
  continuing,
  resumed,
  onContinue,
  onRetry,
}: AssistantSegmentProps) {
  const finishedAt = msg.meta?.finishedAt;
  const failure = runFailure(msg);
  const pause = pauseInfo(msg);
  const answer = failure ? failure.answer : pause.content;
  const artifacts = artifactRefs([...(msg.turns ?? []).flatMap((t) => t.toolCalls), ...(msg.toolCalls ?? [])]);
  return (
    <>
      <ActivityTimeline
        turns={msg.turns ?? []}
        toolCalls={msg.toolCalls ?? []}
        streaming={streaming}
        durationMs={
          finishedAt !== undefined && msg.meta
            ? finishedAt - msg.meta.startedAt
            : undefined
        }
        sessionId={sessionId}
        onNewChat={onNewChat}
        awaiting={Boolean(pendingPrompt && onPromptAnswer)}
      />
      <div className="md-body">
        {(!failure || answer) && (
          <ChartSessionContext.Provider value={sessionId}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkTableTitles]}
            components={ANSWER_COMPONENTS}
          >
            {answer + (streaming && !showTyping ? "▋" : "")}
          </ReactMarkdown>
          </ChartSessionContext.Provider>
        )}
        {failure && <ErrorCard error={failure.error} onRetry={onRetry} />}
        {artifacts.length > 0 && (
          <div className="artifact-cards">
            {artifacts.map((a) => (
              <ArtifactCard key={a.id} id={a.id} version={a.version} sessionId={sessionId} onOpen={onOpenArtifact} />
            ))}
          </div>
        )}
        {showTyping && <TypingIndicator />}
        {pause.paused && !resumed && !streaming && (
          <div className="limit-notice" role="status">
            <Pause size={13} aria-hidden="true" />
            <span className="limit-notice-text">
              Paused after {pause.rounds ? `${pause.rounds} tool-call rounds` : "the tool-call limit"}.
            </span>
            {msg.paused && !loading && (
              <button
                type="button"
                className="btn btn--sm btn--primary limit-notice-btn"
                onClick={onContinue}
                disabled={continuing}
                aria-label="Continue investigating"
              >
                <Play size={12} aria-hidden="true" />
                Continue
              </button>
            )}
          </div>
        )}
      </div>
      {pendingPrompt && onPromptAnswer && (
        <div className="message-prompt">
          <PromptWidget key={pendingPrompt.id} prompt={pendingPrompt} onAnswer={onPromptAnswer} />
        </div>
      )}
    </>
  );
}

export function Message({
  msgs,
  sessionId,
  index,
  isLast,
  promptMessageIndex,
  onNewChat,
  onOpenArtifact,
  pendingPrompt,
  onPromptAnswer,
  isViewingInflight,
  loading,
  onContinue,
  canResubmit,
  onRetry,
  onEdit,
  continuing,
  setContinuing,
}: MessageProps) {
  const msg = msgs[0];
  const lastMsg = msgs[msgs.length - 1];
  const isUserMessage = msg.role === "user";
  const { agentById } = useAgents();
  const respondingAgent = !isUserMessage && msg.agentId ? agentById.get(msg.agentId) : undefined;
  const streaming = isViewingInflight && loading && isLast && !isUserMessage;
  // Nothing visibly moving yet: no text, and no timeline step still showing its spinner.
  const showTyping =
    streaming &&
    !pendingPrompt &&
    !lastMsg.content.trim() &&
    (lastMsg.toolCalls ?? []).every((tc) => tc.result !== undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = editInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useLayoutEffect(() => {
    const el = editInputRef.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  function startEdit() {
    setDraft(msg.content);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  function submitEdit() {
    if (!onEdit || !canResubmit || !draft.trim()) return;
    setEditing(false);
    onEdit(draft);
  }

  function continueRun() {
    setContinuing(true);
    onContinue();
  }

  const segments = isUserMessage
    ? []
    : msgs.filter((m) => m.role === "assistant");
  const meta = mergeMeta(segments);

  return (
    <div className={`message-row${isUserMessage ? " user" : ""}`}>
      <span
        className={`message-role${isUserMessage ? " user" : " assistant"}`}
        aria-label={respondingAgent ? respondingAgent.name : undefined}
      >
        {isUserMessage ? (
          "You"
        ) : respondingAgent ? (
          <AgentHoverCard agent={respondingAgent} placement="right">
            <AgentAvatar agent={respondingAgent} size="md" hideTooltip />
          </AgentHoverCard>
        ) : (
          "Rye"
        )}
      </span>
      <div
        className={`message-body${isUserMessage ? " user" : ""}${editing ? " editing" : ""}`}
      >
        {!isUserMessage &&
          msgs.map((m, k) => {
            if (m.role !== "assistant")
              return <PromptAnswer key={k} msg={m} inline rounds={pauseInfo(msgs[k - 1]).rounds} />;
            const isPromptTarget = index + k === promptMessageIndex;
            const isLastSegment = k === msgs.length - 1;
            return (
              <AssistantSegment
                key={k}
                msg={m}
                sessionId={sessionId}
                onNewChat={onNewChat}
                onOpenArtifact={onOpenArtifact}
                pendingPrompt={isPromptTarget ? pendingPrompt : undefined}
                onPromptAnswer={isPromptTarget ? onPromptAnswer : undefined}
                streaming={streaming && isLastSegment}
                showTyping={showTyping && isLastSegment}
                loading={loading}
                continuing={continuing}
                resumed={isContinue(msgs[k + 1])}
                onContinue={continueRun}
                onRetry={isLastSegment ? onRetry : undefined}
              />
            );
          })}
        {isUserMessage &&
          (editing ? (
            <div className="user-edit">
              <textarea
                ref={editInputRef}
                className="user-edit-input"
                aria-label="Edit message"
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    submitEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              <div className="user-edit-actions">
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={cancelEdit}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={submitEdit}
                  disabled={!canResubmit || !draft.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="user-bubble"><AgentMentionText text={msg.content} /></div>
              {onEdit && canResubmit && (
                <div className="message-actions">
                  <button
                    ref={editButtonRef}
                    type="button"
                    className="icon-btn message-action"
                    aria-label="Edit message"
                    title="Edit"
                    onClick={startEdit}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              )}
            </>
          ))}
        {!isUserMessage && !streaming && replyMarkdown(msgs) && (
          <button
            className="icon-btn copy"
            onClick={() => {
              navigator.clipboard.writeText(replyMarkdown(msgs));
            }}
          >
            <Copy size={14} />
          </button>
        )}
        {onRetry && lastMsg.meta?.status !== "error" && (
          <button
            type="button"
            className="icon-btn copy message-action"
            aria-label="Retry response"
            title="Retry"
            onClick={onRetry}
          >
            <RotateCcw size={14} />
          </button>
        )}
        {!isUserMessage && meta && !streaming && (
          <MessageInfo
            meta={meta}
            toolCallCount={segments.reduce(
              (sum, m) =>
                sum +
                (m.turns ?? []).reduce((n, t) => n + t.toolCalls.length, 0) +
                (m.toolCalls?.length ?? 0),
              0,
            )}
            pauses={msgs.filter((m) => m.kind === "answer" || m.kind === "approval").length}
          />
        )}
      </div>
    </div>
  );
}
