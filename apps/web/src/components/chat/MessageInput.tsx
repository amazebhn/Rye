import React from "react";
import { Square, ArrowUp, Clock, LoaderCircle, Mic, Pencil, X } from "lucide-react";
import { useDictation } from "../../utils/useDictation";
import DictationWave from "./DictationWave";
import ModelSelect from "../shared/ModelSelect";
import MentionComposer from "./MentionComposer";
import { AgentMentionText } from "../agents/AgentHoverCard";
import type { AgentRecord } from "../../utils/types";
import type { ContextRef, PendingAttachment } from "../../utils/attachments";
import AttachMenu from "./AttachMenu";
import AttachmentChips from "./AttachmentChips";

interface Props {
  /** "hero" renders the larger, centered composer used on an empty chat; "compact" fits a small card (the quick chat). */
  variant?: "dock" | "hero" | "compact";
  input: string;
  loading: boolean;
  isViewingInflight: boolean;
  queued?: string[];
  onEditQueued?: (index: number) => void;
  onRemoveQueued?: (index: number) => void;
  onStop: () => void;
  currentModel?: string;
  /** Needed for the model/agent picker; left out (or with `hideModelPicker`) there is none. */
  onModelChange?: (model: string) => void;
  /** No model/agent picker: the chat's model is fixed (the quick chat runs on the low tier). */
  hideModelPicker?: boolean;
  activeAgentId?: string;
  onSelectAgent?: (agent: AgentRecord | null) => void;
  onInput: (value: string) => void;
  onSend: () => void;
  // "question": sending answers the agent's question; "approval": sending declines the tool call.
  promptPending?: "question" | "approval";
  /** Files picked for this message (uploading or ready). */
  attachments?: PendingAttachment[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (key: string) => void;
  /** SOPs and tools picked for this message. */
  references?: ContextRef[];
  onAddReference?: (ref: ContextRef) => void;
  onRemoveReference?: (key: string) => void;
  /** Shown in place of the model picker (a code chat shows its engine and model, which it can't change). */
  modelSlot?: React.ReactNode;
  /** Replaces the default placeholder. */
  placeholder?: string;
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
  hideModelPicker = false,
  activeAgentId,
  onSelectAgent,
  onInput,
  onSend,
  promptPending,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  references = [],
  onAddReference,
  onRemoveReference,
  modelSlot,
  placeholder: placeholderOverride,
}: Props) {
  const uploading = attachments.some((a) => a.status === "uploading");
  const ready = attachments.some((a) => a.status === "ready") || references.length > 0;
  // A message may be only files, but not while any of them is still uploading.
  const canSend = (input.trim().length > 0 || ready) && !uploading;
  const sendDisabled = !canSend;
  const [dragging, setDragging] = React.useState(false);
  const dropFiles = (e: React.DragEvent) => {
    if (!onAddFiles || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onAddFiles(files);
  };
  const dictation = useDictation();
  const send = () => {
    // Stop listening first (dropping an unfinished recording) so late words don't land in the emptied box.
    dictation.stop(true);
    onSend();
  };

  const placeholder = placeholderOverride ??
    (loading && isViewingInflight
      ? "Type to queue a message…"
      : promptPending === "question"
        ? "Type your answer to Rye's question…"
        : promptPending === "approval"
          ? "Reply to decline and tell Rye what to do instead…"
          : variant === "hero"
            ? "Describe the incident, paste an error, or ask a question…"
            : "Describe the incident or ask a question...");

  return (
    <div className={`input-bar-wrap${variant === "dock" ? "" : ` input-bar-wrap--${variant}`}`}>
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
        <div
          className={`input-box${dragging ? " is-dropping" : ""}`}
          style={{ position: "relative" }}
          onDragOver={(e) => {
            if (!onAddFiles || !Array.from(e.dataTransfer.types).includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={dropFiles}
        >
          {(attachments.length > 0 || references.length > 0) && (
            <AttachmentChips
              pending={attachments}
              onRemove={onRemoveAttachment}
              refs={references}
              onRemoveRef={onRemoveReference}
              className="attachment-chips--composer"
            />
          )}
          <MentionComposer
            value={input}
            onChange={onInput}
            onSend={() => { if (canSend) send(); }}
            placeholder={placeholder}
            ariaLabel={promptPending === "question" ? "Answer Rye's question" : "Chat message"}
            autoFocusTrigger={!loading && !promptPending}
            onPasteFiles={onAddFiles}
          />
          <div className="input-box-actions">
            <div className="input-box-actions-left">
              {modelSlot ?? (!hideModelPicker && onModelChange && (
                <ModelSelect
                  value={currentModel}
                  onChange={onModelChange}
                  activeAgentId={activeAgentId}
                  onSelectAgent={onSelectAgent}
                />
              ))}
              {onAddFiles && <AttachMenu onFiles={onAddFiles} onRef={onAddReference} picked={references} />}
            </div>
            <div className="input-box-actions-right">
              {dictation.error && <span className="dictation-error" role="status">{dictation.error}</span>}
              {dictation.listening && <DictationWave levels={dictation.levels} />}
              {dictation.supported && (
                <button
                  type="button"
                  className={`mic-btn${dictation.listening ? " mic-btn--on" : ""}${dictation.transcribing ? " mic-btn--busy" : ""}`}
                  onClick={() => (dictation.listening ? dictation.stop() : dictation.start(input, onInput))}
                  disabled={dictation.transcribing}
                  aria-pressed={dictation.listening}
                  aria-label={dictation.transcribing ? "Transcribing" : dictation.listening ? "Stop dictation" : "Dictate"}
                  title={dictation.transcribing ? "Transcribing…" : dictation.listening ? "Stop and transcribe" : "Dictate"}
                >
                  {dictation.transcribing ? <LoaderCircle size={15} className="mic-btn-spinner" /> : <Mic size={15} />}
                </button>
              )}
              {isViewingInflight && loading && (
                <button className="stop-btn" onClick={onStop} title="Stop current response" aria-label="Stop current response">
                  <Square size={10} fill="currentColor" strokeWidth={0} />
                </button>
              )}
              <button className="send-btn" onClick={send} disabled={sendDisabled} aria-label={promptPending === "question" ? "Send answer" : "Send"}>
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
