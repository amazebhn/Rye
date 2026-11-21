import React, { useState } from "react";
import { ArrowUpRight, BookOpen, Database, ScrollText, Siren } from "lucide-react";
import { PROMPT_GROUPS } from "./examples";
import type { PromptGroup } from "../../utils/types";
import AiMark from "../shared/AiMark";

const GROUP_ICONS: Record<PromptGroup["id"], React.ReactNode> = {
  triage: <Siren size={13} />,
  logs: <ScrollText size={13} />,
  infra: <Database size={13} />,
  runbooks: <BookOpen size={13} />,
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function ChatHero() {
  return (
    <div className="chat-hero">
      <span className="ai-empty-icon chat-hero-mark" aria-hidden="true"><AiMark size={24} /></span>
      <h1 className="chat-hero-title">{greeting()}</h1>
    </div>
  );
}

/** Categorized starter prompts shown beneath the composer on an empty chat. */
export function ChatExamples({ onSelect }: { onSelect: (p: string) => void }) {
  const [activeId, setActiveId] = useState<PromptGroup["id"]>(PROMPT_GROUPS[0].id);
  const group = PROMPT_GROUPS.find((g) => g.id === activeId) ?? PROMPT_GROUPS[0];

  return (
    <section className="chat-examples" aria-label="Examples">
      <div className="chat-examples-head">
        <div className="prompt-tabs sop-diff-tabs" role="tablist" aria-label="Example categories">
          {PROMPT_GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              id={`prompt-tab-${g.id}`}
              aria-selected={g.id === activeId}
              aria-controls="prompt-cards"
              className={`sop-diff-tab${g.id === activeId ? " active" : ""}`}
              onClick={() => setActiveId(g.id)}
            >
              {GROUP_ICONS[g.id]}
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div className="prompt-cards" id="prompt-cards" role="tabpanel" aria-labelledby={`prompt-tab-${group.id}`}>
        {group.prompts.map((p) => (
          <button key={p.title} type="button" className="prompt-card" onClick={() => onSelect(p.prompt)} title={p.prompt}>
            <span className="prompt-card-title">{p.title}</span>
            <span className="prompt-card-text">{p.prompt}</span>
            <ArrowUpRight size={14} className="prompt-card-arrow" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}
