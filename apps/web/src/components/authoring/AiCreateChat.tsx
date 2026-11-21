import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Square } from "lucide-react";
import type { SSEEvent } from "@rye/shared";
import AiEmptyState from "./AiEmptyState";
import AiMark from "../shared/AiMark";
import ModelSelect from "../shared/ModelSelect";

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

export interface AiCreateChatProps {
  emptyTitle: string;
  suggestions: string[];
  placeholder: string;
  ariaLabel: string;
  systemSuffix: string;
  /** Called for each SSE event; return `true` when creation completed to stop reading the stream. */
  onEvent: (event: SSEEvent) => Promise<boolean | void> | boolean | void;
  /** Reports whether the user has typed or started a conversation (for modal close guard). */
  onProgressChange?: (hasProgress: boolean) => void;
}

/**
 * Shared "Generate with AI" chat pane used by NewSopModal, NewSkillModal, and NewAgentModal.
 */
export default function AiCreateChat({
  emptyTitle,
  suggestions,
  placeholder,
  ariaLabel,
  systemSuffix,
  onEvent,
  onProgressChange,
}: AiCreateChatProps) {
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: "" }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState<string | undefined>();
  const sessionRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Discarding mid-generation must not still create the resource.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    onProgressChange?.(loading || input.trim().length > 0 || messages.length > 1);
  }, [loading, input, messages.length, onProgressChange]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", streaming: true },
    ]);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let buffer = "";

    try {
      const resp = await fetch("/chat/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          session_id: sessionRef.current,
          system_prompt_suffix: systemSuffix,
          model,
        }),
        signal: controller.signal,
      });

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent;
            if (event.type === "session" && event.session_id) {
              sessionRef.current = event.session_id;
            } else if (event.type === "token" && event.content) {
              buffer += event.content;
              const snap = buffer;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { ...updated[updated.length - 1], content: snap };
                return updated;
              });
            } else if (event.type === "done") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { ...updated[updated.length - 1], streaming: false };
                return updated;
              });
            }
            const finished = await onEvent(event);
            if (finished) {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { ...updated[updated.length - 1], streaming: false };
                return updated;
              });
              return;
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: `Error: ${err}`, streaming: false };
        return updated;
      });
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  return (
    <div className="nsop-ai">
      <div className="nsop-ai-messages">
        {messages.length === 1 && !loading && (
          <AiEmptyState
            title={emptyTitle}
            suggestions={suggestions}
            onPick={(prompt) => { setInput(prompt); inputRef.current?.focus(); }}
          />
        )}
        {messages.slice(1).map((msg, i) => (
          <div key={i} className={`sop-chat-msg sop-chat-msg--${msg.role}`}>
            {msg.role === "user" ? (
              <div className="sop-chat-bubble">{msg.content}</div>
            ) : (
              <div className="modal-ai-turn">
                <span className="modal-ai-avatar" aria-hidden="true"><AiMark size={16} /></span>
                <div className={`sop-chat-md${msg.streaming && loading && msg.content ? " is-streaming" : ""}`}>
                  {msg.streaming && loading && !msg.content ? (
                    <span className="modal-ai-thinking" role="status">
                      Thinking<span className="modal-ai-dots" aria-hidden="true"><i /><i /><i /></span>
                    </span>
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="sop-chat-input-bar modal-composer">
        <textarea
          ref={inputRef}
          className="sop-chat-input modal-prompt-input"
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={loading}
        />
        <div className="modal-composer-actions">
          <ModelSelect value={model} onChange={setModel} disabled={loading} />
          {loading ? (
            <button className="sop-chat-stop-btn" onClick={() => abortRef.current?.abort()} aria-label="Stop generating">
              <Square size={10} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button className="sop-chat-send-btn" onClick={() => void send()} disabled={!input.trim()} aria-label="Send">
              <ArrowUp size={16} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
