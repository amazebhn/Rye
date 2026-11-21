import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Square, X } from "lucide-react";
import type { SSEEvent } from "@rye/shared";
import { EditContextCard, SuggestionChips, type EditSuggestion } from "./AiEmptyState";
import AiMark from "../shared/AiMark";

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

export interface AiEditorSheetProps {
  kind: string;
  title: string;
  content: string;
  badgeText: string;
  badgeTitle?: string;
  placeholder: string;
  ariaLabel: string;
  systemSuffix: string;
  buildFirstMessage: (userText: string) => string;
  suggestions: EditSuggestion[];
  suggestionsLoading?: boolean;
  suggestionsTailored?: boolean;
  onEvent?: (event: SSEEvent) => void | Promise<void>;
  onClose: () => void;
}

export default function AiEditorSheet({
  kind,
  title,
  content,
  badgeText,
  badgeTitle,
  placeholder,
  ariaLabel,
  systemSuffix,
  buildFirstMessage,
  suggestions,
  suggestionsLoading = false,
  suggestionsTailored = false,
  onEvent,
  onClose,
}: AiEditorSheetProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: `I've loaded **"${title}"** as context. What would you like to edit or improve?`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const sessionRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);

    const isFirstUserMsg = !messages.some((m) => m.role === "user");
    const serverText = isFirstUserMsg ? buildFirstMessage(text) : text;

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
          message: serverText,
          session_id: sessionRef.current,
          system_prompt_suffix: systemSuffix,
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
            if (onEvent) await onEvent(event);
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
    <div className="sop-chat-sheet">
      <div className="sop-chat-sheet-header">
        <AiMark size={16} />
        <h3 className="sop-chat-sheet-title">AI Editor</h3>
        <span className="sop-chat-sheet-badge" title={badgeTitle}>
          {badgeText}
        </span>
        <button className="modal-close" onClick={onClose} title="Close" aria-label="Close AI Editor">
          <X size={16} />
        </button>
      </div>

      <div className="sop-chat-messages">
        <EditContextCard kind={kind} title={title} content={content} />
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

      {messages.length === 1 && !loading && (
        <SuggestionChips
          suggestions={suggestions}
          loading={suggestionsLoading}
          tailored={suggestionsTailored}
          onPick={(prompt) => { setInput(prompt); inputRef.current?.focus(); }}
        />
      )}

      <div className="sop-chat-input-bar modal-composer">
        <textarea
          ref={inputRef}
          className="sop-chat-input modal-prompt-input"
          rows={2}
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
          <span className="modal-composer-hint">Enter to send · Shift+Enter for a new line</span>
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
