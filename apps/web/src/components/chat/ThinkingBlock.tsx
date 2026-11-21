import React, { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, CircleAlert } from "lucide-react";
import type { ToolCall } from "../../utils/types";
import { toolLabel } from "../../utils/toolLabel";
import InlineMarkdown from "./InlineMarkdown";
import ToolChip, { STATUS_TEXT, ToolDetails, hasToolDetails, toolStatus, type ToolStatus } from "./ToolChip";
import Collapse from "../shared/Collapse";

const REMARK_PLUGINS = [remarkGfm];
const STATUS_PRIORITY: ToolStatus[] = ["running", "awaiting", "error", "stopped"];

interface Props {
  thinking: string;
  toolCalls: ToolCall[];
  summary?: string;
  // Calls without a result are still running (otherwise they were cut short).
  live: boolean;
  // The last call is waiting on the user's answer to a prompt.
  awaiting: boolean;
  sessionId: string;
  onNewChat?: (opts: { display: string; context: string }) => void;
}

function StepMarker({ status }: { status: ToolStatus }) {
  const text = STATUS_TEXT[status];
  return (
    <span className={`timeline-marker ${status}`} role="img" aria-label={text} title={text}>
      {status === "running" ? (
        <span className="activity-spinner" />
      ) : status === "error" ? (
        <CircleAlert size={13} aria-hidden="true" />
      ) : (
        <span className="timeline-dot" />
      )}
    </span>
  );
}

function stepTitle(summary: string | undefined, toolCalls: ToolCall[], running: ToolCall | undefined, thinking: string, live: boolean) {
  if (summary?.trim()) return summary.trim();
  if (running) return toolLabel(running);
  if (toolCalls.length > 0) {
    const more = toolCalls.length - 1;
    return toolLabel(toolCalls[0]) + (more > 0 ? ` and ${more} more` : "");
  }
  return thinking.trim().split("\n")[0] || (live ? "Thinking…" : "Reasoned");
}

// One agent iteration in the activity timeline.
function ThinkingBlock({ thinking, toolCalls, summary, live, awaiting, sessionId, onNewChat }: Props) {
  // Steps stay collapsed (even the live one) until the user opens them.
  const [open, setOpen] = useState(false);
  const statuses = toolCalls.map((tc, i) => toolStatus(tc, live, awaiting && i === toolCalls.length - 1));
  const status = STATUS_PRIORITY.find((s) => statuses.includes(s)) ?? "done";
  const hasThinking = thinking.trim().length > 0;
  // A lone tool call is the step itself: show its details directly instead of a nested row repeating the title.
  const soloTool = toolCalls.length === 1 ? toolCalls[0] : undefined;
  const expandable = hasThinking || (soloTool ? hasToolDetails(soloTool, statuses[0]) : toolCalls.length > 0);
  const title = (
    <span className="timeline-step-title">
      <InlineMarkdown text={stepTitle(summary, toolCalls, toolCalls[statuses.indexOf("running")], thinking, live)} />
    </span>
  );

  return (
    <li className={`timeline-step timeline-step--${status}${open ? " open" : ""}`}>
      <StepMarker status={status} />
      {expandable ? (
        <button type="button" className="timeline-step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          {title}
          <ChevronRight size={13} className="timeline-caret" aria-hidden="true" />
        </button>
      ) : (
        <div className="timeline-step-head">{title}</div>
      )}
      <Collapse open={open && expandable}>
        <div className="timeline-step-body">
          {hasThinking && (
            <div className="md-body timeline-thinking">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                components={{
                  a: ({ children, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {thinking}
              </ReactMarkdown>
            </div>
          )}
          {soloTool ? (
            <ToolDetails
              tc={soloTool}
              sessionId={sessionId}
              status={statuses[0]}
              onNewChat={onNewChat}
              className="tool-details"
            />
          ) : toolCalls.length > 0 && (
            <ul className="tool-rows">
              {toolCalls.map((tc, i) => (
                <ToolChip key={i} tc={tc} status={statuses[i]} sessionId={sessionId} onNewChat={onNewChat} />
              ))}
            </ul>
          )}
        </div>
      </Collapse>
    </li>
  );
}

export default memo(ThinkingBlock);

