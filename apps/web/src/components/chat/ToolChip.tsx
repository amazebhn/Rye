import React, { useEffect, useState } from "react";
import type { ToolCall } from "../../utils/types";
import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  Copy,
  Database,
  FileText,
  GitBranch,
  Globe,
  MessageCircleQuestion,
  Search,
  Ticket,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { isToolError, toolDetail, toolLabel } from "../../utils/toolLabel";
import ResultTable from "../results/ResultTable";
import { ARTIFACT_MARKER_ALL } from "../artifacts/ArtifactCard";
import Collapse from "../shared/Collapse";
import InlineMarkdown from "./InlineMarkdown";

const RESULT_MARKER = /\[rye:result:(res_[a-z0-9]+)\]/;
// Huge payloads are slow to lay out; Copy still gets the full text.
const RESULT_PREVIEW_CHARS = 20_000;
// A written file's body can be huge; the artifact card has the full text.
const ARG_PREVIEW_CHARS = 2_000;

export type ToolStatus = "running" | "done" | "error" | "awaiting" | "stopped";

export const STATUS_TEXT: Record<ToolStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  awaiting: "Waiting for you",
  stopped: "No result",
};

export function toolStatus(tc: ToolCall, live: boolean, awaiting: boolean): ToolStatus {
  if (awaiting) return "awaiting";
  if (tc.result === undefined) return live ? "running" : "stopped";
  return isToolError(tc) ? "error" : "done";
}

function toolIcon(name: string): LucideIcon {
  if (name.startsWith("mcp__") || name === "WebSearch" || name === "WebFetch") return Globe;
  if (/^(mysql|result)_/.test(name)) return Database;
  if (/^(cloudwatch|rds|ecs|ec2|alb)_/.test(name)) return Cloud;
  if (name.startsWith("git_")) return GitBranch;
  if (name.startsWith("jira_")) return Ticket;
  if (/search|symbol|list_repos/.test(name)) return Search;
  if (/sop|skill|artifact|stack_trace|log_to_source/.test(name)) return FileText;
  if (/memor|remember|forget/.test(name)) return Brain;
  if (name === "ask_user_tool") return MessageCircleQuestion;
  if (name === "spawn_subagents_tool") return Workflow;
  return Wrench;
}

function RowStatus({ status }: { status: ToolStatus }) {
  const text = STATUS_TEXT[status];
  if (status === "running") return <span className="activity-spinner" role="img" aria-label={text} title={text} />;
  if (status === "done" || status === "error") {
    const Icon = status === "done" ? Check : CircleAlert;
    return (
      <span className={`tool-row-status ${status}`} role="img" aria-label={text} title={text}>
        <Icon size={13} aria-hidden="true" />
      </span>
    );
  }
  return <span className={`tool-row-status ${status}`}>{text}</span>;
}

function ToolArgs({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="tool-args">
      {entries.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt>{key}</dt>
          <dd>
            {value !== null && typeof value === "object"
              ? <pre>{JSON.stringify(value, null, 2)}</pre>
              : typeof value === "string" && value.length > ARG_PREVIEW_CHARS
                ? `${value.slice(0, ARG_PREVIEW_CHARS)}… (${(value.length - ARG_PREVIEW_CHARS).toLocaleString()} more chars)`
                : String(value)}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const label = copied ? "Copied" : "Copy result";
  return (
    <button
      type="button"
      className="icon-btn tool-result-copy"
      aria-label={label}
      title={label}
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

interface ResultProps {
  tc: ToolCall;
  sessionId: string;
  onNewChat?: (opts: { display: string; context: string }) => void;
}

function ToolResult({ tc, sessionId, onNewChat }: ResultProps) {
  // The artifact marker is for the UI; the card under the reply renders it.
  const result = (tc.result ?? "").replace(ARTIFACT_MARKER_ALL, "");
  const storedResultId = result.match(RESULT_MARKER)?.[1];
  // The marker text is for the model; the user gets the real table instead.
  if (storedResultId) return <ResultTable resultId={storedResultId} sessionId={sessionId} />;

  const isSqlTool = tc.name === "mysql_query_tool" || tc.name === "mysql_schema_tool";

  function openInNewChat() {
    if (!onNewChat || !result) return;
    const args = tc.args as { query?: string; table?: string };
    const query = args.query ?? args.table ?? "";
    const context = query ? `SQL query: \`${query}\`\n\nResults:\n${result}` : `SQL results:\n${result}`;
    onNewChat({ display: result, context });
  }

  return (
    <div className="tool-result">
      <div className="tool-result-head">
        <span>Result</span>
        {result && <CopyButton text={result} />}
      </div>
      <pre className="tool-result-pre" tabIndex={0} aria-label="Tool result">
        {result.length > RESULT_PREVIEW_CHARS ? `${result.slice(0, RESULT_PREVIEW_CHARS)}\n…` : result || "(empty)"}
      </pre>
      {isSqlTool && onNewChat && result && (
        <button type="button" className="btn btn--sm btn--ghost tool-result-action" onClick={openInNewChat}>
          Open in new chat
        </button>
      )}
    </div>
  );
}

interface Props extends ResultProps {
  status: ToolStatus;
}

// A tool call's arguments and result.
export function ToolDetails({ tc, sessionId, status, onNewChat, className = "tool-row-body" }: Props & { className?: string }) {
  const argEntries = Object.entries(tc.args);
  // A pending approval's result is a placeholder for the model.
  const showResult = tc.result !== undefined && status !== "awaiting";
  if (argEntries.length === 0 && !showResult) return null;
  return (
    <div className={className}>
      {argEntries.length > 0 && <ToolArgs entries={argEntries} />}
      {showResult && <ToolResult tc={tc} sessionId={sessionId} onNewChat={onNewChat} />}
    </div>
  );
}

export function hasToolDetails(tc: ToolCall, status: ToolStatus): boolean {
  return Object.keys(tc.args).length > 0 || (tc.result !== undefined && status !== "awaiting");
}

// One tool call in a timeline step; expands to its arguments and result.
export default function ToolChip({ tc, sessionId, status, onNewChat }: Props) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tc.name);
  const detail = toolDetail(tc);
  const hasDetail = hasToolDetails(tc, status);

  const head = (
    <>
      <Icon size={14} className="tool-row-icon" aria-hidden="true" />
      <span className="tool-row-label">
        <InlineMarkdown text={toolLabel(tc)} />
      </span>
      {detail && <span className="tool-row-detail">{detail}</span>}
      <RowStatus status={status} />
      {hasDetail && <ChevronRight size={13} className="tool-row-caret" aria-hidden="true" />}
    </>
  );

  return (
    <li className={`tool-row tool-row--${status}${open ? " open" : ""}`}>
      {hasDetail ? (
        <button type="button" className="tool-row-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="tool-row-head">{head}</div>
      )}
      <Collapse open={open && hasDetail}>
        <ToolDetails tc={tc} sessionId={sessionId} status={status} onNewChat={onNewChat} />
      </Collapse>
    </li>
  );
}
