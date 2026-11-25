import React, { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Clock } from "lucide-react";
import ProviderLogo from "./ProviderLogo";
import AgentAvatar from "../agents/AgentAvatar";
import { useAgents } from "../../contexts/AgentContext";
import type { AgentRecord } from "../../utils/types";
import { formatModelName, groupModelsByProvider } from "../../utils/modelNames";

interface ModelInfo {
  provider: string;
  current: string;
  models: string[];
}

type RecentEntry =
  | { kind: "model"; id: string }
  | { kind: "agent"; id: string };

const RECENT_STORAGE_KEY = "rye.recent-model-agents";
const MAX_RECENT = 3;
const SUBMENU_WIDTH = 236;

function readRecent(): RecentEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEntry =>
        typeof e === "object" &&
        e !== null &&
        ((e as RecentEntry).kind === "model" || (e as RecentEntry).kind === "agent") &&
        typeof (e as RecentEntry).id === "string" &&
        (e as RecentEntry).id.length > 0,
    );
  } catch {
    return [];
  }
}

function recordRecent(entry: RecentEntry): RecentEntry[] {
  const prev = readRecent();
  const next = [entry, ...prev.filter((e) => !(e.kind === entry.kind && e.id === entry.id))].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors in private mode.
  }
  return next;
}

interface Props {
  value: string | undefined;
  onChange: (model: string) => void;
  disabled?: boolean;
  /** When provided (chat composer), shows the Agents popout submenu and recent agents. */
  activeAgentId?: string;
  onSelectAgent?: (agent: AgentRecord | null) => void;
  /** Shown while nothing is picked, when the server will use something other than the chat model. */
  defaultModel?: string;
}

export default function ModelSelect({ value, onChange, disabled, activeAgentId, onSelectAgent, defaultModel }: Props) {
  const { agents, agentById } = useAgents();
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>(readRecent);
  const [agentSubmenuPos, setAgentSubmenuPos] = useState<
    { left: number; width: number; maxHeight?: number } & ({ top: number } | { bottom: number })
  | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeSubmenuTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/models")
      .then((r) => (r.ok ? (r.json() as Promise<ModelInfo>) : null))
      .then((d) => {
        if (cancelled) return;
        if (d) setInfo(d);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) {
      setAgentSubmenuPos(null);
      return;
    }
    setRecent(readRecent());
    function handler(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => () => window.clearTimeout(closeSubmenuTimer.current), []);

  const validRecent = useMemo(() => {
    const modelSet = new Set(info?.models ?? []);
    return recent.filter((item) => {
      if (item.kind === "model") return modelSet.has(item.id);
      if (!onSelectAgent) return false;
      return agentById.has(item.id);
    });
  }, [recent, info, onSelectAgent, agentById]);

  if (!info) {
    if (failed) return null;
    return (
      <div className="model-select">
        <span className="model-select-skeleton" role="status" aria-busy="true" aria-label="Loading models" />
      </div>
    );
  }

  const selected = value ?? defaultModel ?? info.current;
  const activeAgent = activeAgentId ? agentById.get(activeAgentId) : undefined;
  const showAgents = Boolean(onSelectAgent);
  const agentList = agents ?? [];

  function openAgentsSubmenu(triggerEl: HTMLElement) {
    window.clearTimeout(closeSubmenuTimer.current);
    const rect = triggerEl.getBoundingClientRect();
    const gap = 6;
    const fitsRight = rect.right + gap + SUBMENU_WIDTH <= window.innerWidth - 8;
    const fitsLeft = rect.left - SUBMENU_WIDTH - gap >= 8;
    // No room beside the menu (a phone): stack the list above the menu, which opens upward from the composer.
    const menu = triggerEl.closest(".model-select-menu")?.getBoundingClientRect();
    if (!fitsRight && !fitsLeft && menu && menu.top - gap - 8 >= 120) {
      const width = Math.min(window.innerWidth - 16, Math.max(SUBMENU_WIDTH, menu.width));
      const left = Math.max(8, Math.min(menu.left, window.innerWidth - 8 - width));
      setAgentSubmenuPos({ left, width, bottom: window.innerHeight - menu.top + gap, maxHeight: menu.top - gap - 8 });
      return;
    }
    const left = fitsRight ? rect.right + gap : Math.max(8, rect.left - SUBMENU_WIDTH - gap);
    const estHeight = Math.min(320, Math.max(110, (agentList.length + 2) * 38));
    const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - estHeight - 8));
    setAgentSubmenuPos({ top, left, width: SUBMENU_WIDTH });
  }

  function scheduleCloseSubmenu() {
    window.clearTimeout(closeSubmenuTimer.current);
    closeSubmenuTimer.current = window.setTimeout(() => setAgentSubmenuPos(null), 140);
  }

  function cancelCloseSubmenu() {
    window.clearTimeout(closeSubmenuTimer.current);
  }

  function pickModel(m: string) {
    setRecent(recordRecent({ kind: "model", id: m }));
    onChange(m);
    setOpen(false);
  }

  function pickAgent(agent: AgentRecord | null) {
    if (agent) setRecent(recordRecent({ kind: "agent", id: agent.id }));
    onSelectAgent?.(agent);
    setOpen(false);
  }

  return (
    <div
      className="model-select"
      ref={rootRef}
      onKeyDown={(e) => {
        // Keep Escape from also reaching the modal's close guard.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          if (agentSubmenuPos) setAgentSubmenuPos(null);
          else setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="model-select-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeAgent ? `${activeAgent.name} (@${activeAgent.slug}) · ${selected}` : selected}
      >
        {activeAgent ? (
          <>
            <AgentAvatar agent={activeAgent} size="xs" />
            <span className="model-select-label">{activeAgent.name}</span>
            <span className="model-select-pill-sep" aria-hidden="true">·</span>
            <span className="model-select-pill-sub">{formatModelName(selected)}</span>
          </>
        ) : (
          <>
            <ProviderLogo model={selected} size={13} />
            <span className="model-select-label">{formatModelName(selected)}</span>
          </>
        )}
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="model-select-menu" role="listbox" aria-label="Model and agent">
          {/* 1. Last used model / agent */}
          {validRecent.length > 0 && (
            <div className="model-select-group" role="group" aria-label="Recent">
              <div className="model-select-group-label" aria-hidden="true">
                <Clock size={11} />
                Last used
              </div>
              {validRecent.map((item) => {
                if (item.kind === "agent") {
                  const agent = agentById.get(item.id);
                  if (!agent) return null;
                  const isActive = agent.id === activeAgentId;
                  return (
                    <button
                      key={`agent:${agent.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`model-select-option${isActive ? " is-active" : ""}`}
                      onMouseEnter={() => setAgentSubmenuPos(null)}
                      onClick={() => pickAgent(agent)}
                      title={`${agent.name} (@${agent.slug})`}
                    >
                      <span className="model-select-option-main">
                        <AgentAvatar agent={agent} size="xs" />
                        <span className="model-select-option-text">{agent.name}</span>
                        <span className="model-select-meta">@{agent.slug}</span>
                      </span>
                      {isActive && <Check size={13} />}
                    </button>
                  );
                }
                const isActive = !activeAgentId && item.id === selected;
                return (
                  <button
                    key={`model:${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`model-select-option${isActive ? " is-active" : ""}`}
                    onMouseEnter={() => setAgentSubmenuPos(null)}
                    onClick={() => pickModel(item.id)}
                    title={item.id}
                  >
                    <span className="model-select-option-main">
                      <ProviderLogo model={item.id} size={12} />
                      <span className="model-select-option-text">{formatModelName(item.id)}</span>
                    </span>
                    {isActive && <Check size={13} />}
                  </button>
                );
              })}
            </div>
          )}

          {/* 2. Agents popout submenu */}
          {showAgents && (
            <div className="model-select-group" role="group" aria-label="Agents">
              <button
                type="button"
                className={`model-select-option model-select-submenu-trigger${agentSubmenuPos ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={agentSubmenuPos !== null}
                onMouseEnter={(e) => openAgentsSubmenu(e.currentTarget)}
                onMouseLeave={scheduleCloseSubmenu}
                onClick={(e) => {
                  if (agentSubmenuPos) setAgentSubmenuPos(null);
                  else openAgentsSubmenu(e.currentTarget);
                }}
              >
                <span className="model-select-option-main">
                  <Bot size={13} />
                  <span>Agents</span>
                  {agentList.length > 0 && <span className="model-select-meta">{agentList.length}</span>}
                </span>
                <ChevronRight size={13} />
              </button>
            </div>
          )}

          {/* 3. Models grouped by provider */}
          {groupModelsByProvider(info.models).map((group) => (
            <div key={group.provider.id} className="model-select-group" role="group" aria-label={group.provider.name}>
              <div className="model-select-group-label" aria-hidden="true">
                <ProviderLogo provider={group.provider.id} size={12} />
                {group.provider.name}
              </div>
              {group.models.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={m === selected}
                  className={`model-select-option${m === selected ? " is-active" : ""}`}
                  onMouseEnter={() => setAgentSubmenuPos(null)}
                  onClick={() => pickModel(m)}
                  title={m}
                >
                  <span>{formatModelName(m)}</span>
                  {m === selected && <Check size={13} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Fixed-position Agents popout so menu scrolling never clips it */}
      {open && showAgents && agentSubmenuPos && (
        <div
          className="model-select-submenu"
          role="menu"
          aria-label="Agents"
          style={{
            ...("top" in agentSubmenuPos ? { top: agentSubmenuPos.top } : { bottom: agentSubmenuPos.bottom }),
            left: agentSubmenuPos.left,
            width: agentSubmenuPos.width,
            maxHeight: agentSubmenuPos.maxHeight,
          }}
          onMouseEnter={cancelCloseSubmenu}
          onMouseLeave={scheduleCloseSubmenu}
        >
          <div className="model-select-group">
            {agentList.length === 0 ? (
              <div className="model-select-empty">No agents yet. Create one in the Agents tab.</div>
            ) : (
              agentList.map((agent) => {
                const isActive = agent.id === activeAgentId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={`model-select-option${isActive ? " is-active" : ""}`}
                    onClick={() => pickAgent(agent)}
                    title={agent.description || `@${agent.slug}`}
                  >
                    <span className="model-select-option-main">
                      <AgentAvatar agent={agent} size="xs" />
                      <span className="model-select-option-text">{agent.name}</span>
                      <span className="model-select-meta">@{agent.slug}</span>
                    </span>
                    {isActive && <Check size={13} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
