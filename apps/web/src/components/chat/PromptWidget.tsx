import React, { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import type { PendingPrompt } from "@rye/shared";
import { isDenial, isPermissionPrompt, SESSION_PATTERN_OPTION } from "../../utils/approval";
import InlineMarkdown from "./InlineMarkdown";

interface Props {
  prompt: PendingPrompt;
  onAnswer: (answer: string) => void;
}

const DECIDE_ANSWER = "No preference — use your judgement and continue.";

// Keys are the backend's approval option strings (see utils/approval.ts).
const APPROVAL_COPY: Record<string, { title: string; detail?: string }> = {
  "Allow once": { title: "Allow once", detail: "This request only" },
  "Allow this tool for this session": { title: "Allow this tool", detail: "For this session" },
  "Allow read-only tools from this server for this session": { title: "Allow read-only tools", detail: "From this server · this session" },
  Deny: { title: "Deny", detail: "Block this request" },
  "Add MCP server": { title: "Add MCP server" },
  Cancel: { title: "Cancel" },
};

const isTextField = (el: EventTarget) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

export default function PromptWidget({ prompt, onAnswer }: Props) {
  const titleId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const approval = isPermissionPrompt(prompt);
  const options = prompt.type === "yesno" ? ["Yes", "No"] : prompt.type === "choice" ? (prompt.options ?? []) : [];
  const multi = !approval && prompt.type === "choice" && Boolean(prompt.multiSelect);
  const question = prompt.question;

  const optionButtons = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-option], .prompt-other-input") ?? [])];

  // Approvals focus the card, not "Allow", so a stray Enter can't approve.
  useEffect(() => {
    const target = approval ? rootRef.current : optionButtons()[0];
    target?.focus({ preventScroll: true });
  }, []);

  const argumentMarker = "\n\nArguments:";
  const argumentIndex = question.indexOf(argumentMarker);
  const questionText = argumentIndex === -1 ? question : question.slice(0, argumentIndex);
  const rawArguments = argumentIndex === -1
    ? undefined
    : question.slice(argumentIndex + argumentMarker.length).trim();

  let formattedArguments = rawArguments;
  if (rawArguments) {
    try {
      formattedArguments = JSON.stringify(JSON.parse(rawArguments), null, 2);
    } catch {
      // Keep non-JSON tool arguments readable as plain text.
    }
  }

  const optionCopy = (option: string) => {
    if (!approval) return { title: option };
    const pattern = SESSION_PATTERN_OPTION.exec(option);
    // Code sessions: `Allow "<pattern>" for this session`, shown like "Allow this tool".
    if (pattern) return { title: `Allow \`${pattern[1]}\``, detail: "For this session" };
    return APPROVAL_COPY[option] ?? { title: option };
  };

  const answer = (value: string) => {
    if (submitting || !value.trim()) return;
    setSubmitting(true);
    if (!multi) setPicked([value]);
    onAnswer(value.trim());
  };

  const typed = other.trim();
  const submitValue = multi ? [...picked, ...(typed ? [typed] : [])].join(", ") : typed;
  const submit = () => answer(submitValue);
  const toggle = (option: string) =>
    setPicked((prev) => (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]));

  // 1–9 jump to an option (and toggle it in a multi-select); arrows move between options and the text field.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (submitting || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = optionButtons();
    const at = items.indexOf(e.target as HTMLElement);
    if (/^[1-9]$/.test(e.key) && !isTextField(e.target)) {
      const index = Number(e.key) - 1;
      if (index >= options.length) return;
      e.preventDefault();
      items[index]?.focus();
      if (multi) toggle(options[index]);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length > 0) {
      if (isTextField(e.target) && e.key === "ArrowDown") return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = at === -1 ? (step === 1 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
      items[next]?.focus();
    } else if (
      e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing &&
      // Single-choice buttons answer through their own click.
      (isTextField(e.target) || (multi && at !== -1))
    ) {
      e.preventDefault();
      submit();
    }
  };

  const kicker = approval ? "Approval required" : "Input required";
  const showOptionsHint = options.length > 1;

  return (
    <section
      ref={rootRef}
      className={`prompt-widget${approval ? " prompt-widget--approval" : ""}`}
      aria-labelledby={titleId}
      aria-busy={submitting}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="prompt-kicker">
        {approval ? <ShieldAlert size={13} aria-hidden="true" /> : <MessageCircleQuestion size={13} aria-hidden="true" />}
        {kicker}
      </div>
      <div className="prompt-question" id={titleId}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {questionText}
        </ReactMarkdown>
      </div>
      {formattedArguments && (
        <div className="prompt-payload-wrap">
          <div className="prompt-payload-label">Arguments</div>
          <pre className="prompt-payload">{formattedArguments}</pre>
        </div>
      )}
      {options.length > 0 && (
        <div
          className={`prompt-options prompt-options--${approval ? "approval" : prompt.type}`}
          role="group"
          aria-label={approval ? "Approval options" : multi ? "Options, pick any" : "Options"}
        >
          {options.map((opt, i) => {
            const copy = optionCopy(opt);
            const on = picked.includes(opt);
            const tone = approval ? (isDenial(opt) ? " prompt-option--deny" : i === 0 ? " prompt-option--primary" : "") : "";
            return (
              <button
                key={opt}
                type="button"
                data-option
                className={`prompt-option${on ? " is-selected" : ""}${tone}`}
                {...(multi ? { role: "checkbox", "aria-checked": on } : {})}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                disabled={submitting}
                onClick={() => (multi ? toggle(opt) : answer(opt))}
              >
                <span className="prompt-option-key" aria-hidden="true">
                  {multi ? on && <Check size={11} strokeWidth={3} /> : i < 9 ? i + 1 : ""}
                </span>
                <span className="prompt-option-text">
                  <span className="prompt-option-title"><InlineMarkdown text={copy.title} /></span>
                  {copy.detail && <span className="prompt-option-detail">{copy.detail}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {prompt.live && (
        <p className="prompt-live-note">The agent is waiting on this step; if it isn’t answered in time, it’s denied.</p>
      )}
      {!approval && (
        <div className="prompt-answer-row">
          <input
            className="prompt-other-input"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder={prompt.type === "text" ? "Type your answer…" : multi ? "Add something else…" : "Something else…"}
            aria-label={prompt.type === "text" ? "Your answer" : "Other answer"}
            disabled={submitting}
          />
          <button type="button" className="btn btn--sm btn--primary prompt-submit" onClick={submit} disabled={!submitValue || submitting}>
            Submit
          </button>
        </div>
      )}
      {(showOptionsHint || !approval) && (
      <div className="prompt-footer">
        {showOptionsHint && (
          <span className="prompt-hint" aria-hidden="true">
            <kbd>1</kbd>–<kbd>{Math.min(options.length, 9)}</kbd> {multi ? "toggle" : "pick"} · <kbd>Enter</kbd> {multi ? "submit" : "confirm"}
          </span>
        )}
        {!approval && (
          <button type="button" className="prompt-skip" onClick={() => answer(DECIDE_ANSWER)} disabled={submitting}>
            Let Rye decide
          </button>
        )}
      </div>
      )}
    </section>
  );
}
