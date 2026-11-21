import React, { useCallback, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentTurn, ToolCall } from "../../utils/types";
import { isToolError } from "../../utils/toolLabel";
import ThinkingBlock from "./ThinkingBlock";
import Collapse from "../shared/Collapse";

type NewChat = (opts: { display: string; context: string }) => void;

interface Props {
  turns: AgentTurn[];
  // The current iteration's calls, not yet folded into `turns`.
  toolCalls: ToolCall[];
  streaming: boolean;
  durationMs?: number;
  sessionId: string;
  onNewChat?: NewChat;
  // The run ended on a question the user hasn't answered yet.
  awaiting?: boolean;
}

function formatElapsed(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// An assistant run's reasoning and tool activity as a collapsible vertical timeline.
export default function ActivityTimeline({
  turns,
  toolCalls,
  streaming,
  durationMs,
  sessionId,
  onNewChat,
  awaiting = false,
}: Props) {
  // null until the user toggles; until then it follows the run (open while live, closed when done).
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const onNewChatRef = useRef(onNewChat);
  onNewChatRef.current = onNewChat;
  // Stable identity so memoised steps skip the per-token re-renders.
  const stableNewChat = useCallback<NewChat>((opts) => onNewChatRef.current?.(opts), []);

  const steps: AgentTurn[] = toolCalls.length > 0 ? [...turns, { thinking: "", toolCalls }] : turns;
  if (steps.length === 0) return null;

  const open = manualOpen ?? (streaming || awaiting);
  const failed = steps.filter((s) => s.toolCalls.some(isToolError)).length;
  const label = [
    streaming ? "Working…" : durationMs !== undefined ? `Worked for ${formatElapsed(durationMs)}` : null,
    `${steps.length} step${steps.length === 1 ? "" : "s"}`,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const liveIndex = toolCalls.length > 0 ? steps.length - 1 : -1;

  return (
    <div className={`activity${open ? " open" : ""}`}>
      <button type="button" className="activity-toggle" aria-expanded={open} onClick={() => setManualOpen(!open)}>
        {streaming && !open && <span className="activity-spinner" aria-hidden="true" />}
        <span>{label}</span>
        <ChevronRight size={13} className="activity-caret" aria-hidden="true" />
      </button>
      <Collapse open={open}>
        <ol className="timeline" aria-label="Agent activity">
          {steps.map((step, i) => (
            <ThinkingBlock
              key={i}
              thinking={step.thinking}
              toolCalls={step.toolCalls}
              summary={step.summary}
              live={i === liveIndex && streaming}
              awaiting={i === liveIndex && awaiting}
              sessionId={sessionId}
              onNewChat={onNewChat ? stableNewChat : undefined}
            />
          ))}
        </ol>
      </Collapse>
    </div>
  );
}
