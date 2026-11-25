import React from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import AiMark from "../shared/AiMark";
import HeroMark from "../chat/HeroMark";

interface Props {
  title: string;
  suggestions: string[];
  onPick: (prompt: string) => void;
}

export interface EditSuggestion {
  label: string;
  prompt: string;
}

/** Shows which document the AI Editor has loaded, so the conversation has an anchor. */
export function EditContextCard({ kind, title, content }: { kind: string; title: string; content: string }) {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  return (
    <div className="ai-context-card">
      <span className="ai-context-icon" aria-hidden="true"><FileText size={16} /></span>
      <div className="ai-context-text">
        <span className="ai-context-title" title={title}>{title}</span>
        <span className="ai-context-meta">{kind} · {words.toLocaleString()} words · loaded as context</span>
      </div>
    </div>
  );
}

/** Short prompt chips that sit directly above the composer. */
export function SuggestionChips({
  suggestions,
  loading = false,
  tailored = false,
  onPick,
}: {
  suggestions: EditSuggestion[];
  loading?: boolean;
  tailored?: boolean;
  onPick: (prompt: string) => void;
}) {
  const label = loading ? "Reviewing this document…" : tailored ? "Suggested for this document" : "Suggested edits";
  return (
    <div className="ai-chips">
      <div className="ai-chips-label" aria-live="polite">
        <AiMark size={12} />
        {label}
      </div>
      <div className="ai-chip-row" aria-busy={loading}>
        {loading
          ? [92, 124, 80, 108].map((width) => (
              <span key={width} className="ai-chip ai-chip--skeleton" style={{ width }} aria-hidden="true" />
            ))
          : suggestions.map((s) => (
              <button key={s.label} type="button" className="ai-chip" onClick={() => onPick(s.prompt)} title={s.prompt}>
                {s.label}
              </button>
            ))}
      </div>
    </div>
  );
}

export default function AiEmptyState({ title, suggestions, onPick }: Props) {
  return (
    <div className="ai-empty">
      <HeroMark className="ai-empty-icon" iconSize={22} />
      <h4 className="ai-empty-title">{title}</h4>
      <div className="ai-empty-label">Start from an example</div>
      <div className="ai-empty-suggestions">
        {suggestions.map((s) => (
          <button key={s} type="button" className="ai-empty-card" onClick={() => onPick(s)}>
            <span className="ai-empty-card-text">{s}</span>
            <ArrowUpRight size={14} className="ai-empty-card-arrow" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
