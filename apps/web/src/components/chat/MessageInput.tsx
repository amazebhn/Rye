import React from "react";
import { Square, ArrowUp, Clock, Pencil, X } from "lucide-react";
import ModelSelect from "../shared/ModelSelect";
import MentionComposer from "./MentionComposer";
import { AgentMentionText } from "../agents/AgentHoverCard";
import type { AgentRecord } from "../../utils/types";

interface Props {
  /** "hero" renders the larger, centered composer used on an empty chat. */
  variant?: "dock" | "hero";
  input: string;
  loading: boolean;
  isViewingInflight: boolean;
  queued?: string[];
  onEditQueued?: (index: number) => void;
  onRemoveQueued?: (index: number) => void;
  onStop: () => void;
  currentModel?: string;
  onModelChange: (model: string) => void;
  activeAgentId?: string;
  onSelectAgent?: (agent: AgentRecord | null) => void;
  onInput: (value: string) => void;
  onSend: () => void;
  // "question": sending answers the agent's question; "approval": sending declines the tool call.
  promptPending?: "question" | "approval";
}

export default function MessageInput({
  variant = "dock",
  input,
  loading,
  isViewingInflight,
  queued = [],
  onEditQueued,
  onRemoveQueued,
  onStop,
  currentModel,
  onModelChange,
  activeAgentId,
  onSelectAgent,
  onInput,
  onSend,
  promptPending,
}: Props) {
  const canSend = input.trim().length > 0;
  const sendDisabled = !canSend;

  const placeholder =
    loading && isViewingInflight
      ? "Type to queue a message…"
      : promptPending === "question"
        ? "Type your answer to Rye's question…"
        : promptPending === "approval"
          ? "Reply to decline and tell Rye what to do instead…"
          : variant === "hero"
            ? "Describe the incident, paste an error, or ask a question…"
            : "Describe the incident or ask a question...";

  return (
    <div className={`input-bar-wrap${variant === "hero" ? " input-bar-wrap--hero" : ""}`}>
      <div className="input-bar">
        {queued.length > 0 && (
          <ul className="queued-list" aria-label="Queued messages">
            {queued.map((text, i) => (
              <li key={`${i}:${text}`} className="queued-item">
                <span className="queued-label">
                  <Clock size={12} aria-hidden="true" />
                  Queued
                </span>
                <div className="user-bubble user-bubble--queued" title={text}>
                  <AgentMentionText text={text} />
                </div>
                {onEditQueued && (
                  <button type="button" className="icon-btn message-action" aria-label="Edit queued message" title="Edit" onClick={() => onEditQueued(i)}>
                    <Pencil size={14} />
                  </button>
                )}
                {onRemoveQueued && (
                  <button type="button" className="icon-btn message-action" aria-label="Remove queued message" title="Remove" onClick={() => onRemoveQueued(i)}>
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="input-box" style={{ position: "relative" }}>
          <MentionComposer
            value={input}
            onChange={onInput}
            onSend={onSend}
            placeholder={placeholder}
            ariaLabel={promptPending === "question" ? "Answer Rye's question" : "Chat message"}
            autoFocusTrigger={!loading && !promptPending}
          />
          <div className="input-box-actions">
            <div className="input-box-actions-left">
              <ModelSelect
                value={currentModel}
                onChange={onModelChange}
                activeAgentId={activeAgentId}
                onSelectAgent={onSelectAgent}
              />
            </div>
            <div className="input-box-actions-right">
              {isViewingInflight && loading && (
                <button className="stop-btn" onClick={onStop} title="Stop current response" aria-label="Stop current response">
                  <Square size={10} fill="currentColor" strokeWidth={0} />
                </button>
              )}
              <button className="send-btn" onClick={() => onSend()} disabled={sendDisabled} aria-label={promptPending === "question" ? "Send answer" : "Send"}>
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
