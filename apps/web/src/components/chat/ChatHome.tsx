import React, { useState } from "react";
import { ArrowUpRight, BookOpen, Database, ScrollText, Siren } from "lucide-react";
import { PROMPT_GROUPS } from "./examples";
import type { PromptGroup } from "../../utils/types";
import { firstName, useUserProfile } from "../../utils/profile";
import HeroMark from "./HeroMark";
import AgentAvatar from "../agents/AgentAvatar";
import type { AgentRecord } from "../../utils/types";

const GROUP_ICONS: Record<PromptGroup["id"], React.ReactNode> = {
  triage: <Siren size={13} />,
  logs: <ScrollText size={13} />,
  infra: <Database size={13} />,
  runbooks: <BookOpen size={13} />,
};

/** "Good afternoon", or "Good afternoon, Sam" when the user has set their name in Settings. */
function greeting(name = ""): string {
  const hour = new Date().getHours();
  const base = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = firstName(name);
  return first ? `${base}, ${first}` : base;
}

/** The empty-chat greeting. In an agent's chat (e.g. one picked from the model picker) the agent's picture replaces the orb. */
export function ChatHero({ agent }: { agent?: AgentRecord }) {
  const { name } = useUserProfile();
  return (
    <div className="chat-hero">
      {agent ? (
        <span className="chat-hero-agent">
          <AgentAvatar agent={agent} size="hero" hideTooltip />
        </span>
      ) : (
        <HeroMark className="ai-empty-icon chat-hero-mark" iconSize={24} />
      )}
      <h1 className="chat-hero-title">{greeting(name)}</h1>
      {agent && <p className="chat-hero-sub">You're chatting with {agent.name}</p>}
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
              onClick={(e) => {
                setActiveId(g.id);
                // On a phone the tabs are one scrolling row: bring the chosen one fully into view.
                e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
              }}
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
