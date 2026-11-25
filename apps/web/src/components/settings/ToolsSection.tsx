import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Server } from "lucide-react";
import SettingsListHeader, { type SettingsListView } from "./SettingsListHeader";
import { useEnv } from "../../contexts/EnvContext";
import { openAppPath, settingsPath } from "../../utils/routes";
import { useIsMobile } from "../../utils/viewport";
import { SheetOptions, SheetSection } from "../shared/MobileListControls";

type AvailabilityState = "ready" | "partial" | "off";

interface ToolReport {
  name: string;
  /** Human title ("Run SQL query"); older servers leave it out. */
  title?: string;
  description: string;
  detail: string;
  state: AvailabilityState;
}

/** One group of `GET /chat/tools?env=<key>` (see tools/availability.ts on the server). */
interface ToolGroupReport {
  id: string;
  /** Human title ("SQL databases", "MCP · grafana"); older servers leave it out. */
  title?: string;
  description: string;
  tools: ToolReport[];
  availability: {
    state: AvailabilityState;
    reason: string;
    items?: Array<{ name: string; state: AvailabilityState; detail: string }>;
  };
}

interface ToolsResponse {
  env: { key: string; name: string };
  groups: ToolGroupReport[];
  error?: string;
}

/** A tool to scroll to and highlight (from /settings/tools/<name>); a new token highlights it again. */
export interface ToolFocus {
  name: string;
  token: number;
}

const MCP_PREFIX = "mcp:";
const STATES: AvailabilityState[] = ["ready", "partial", "off"];
const STATE_LABEL: Record<AvailabilityState, string> = { ready: "Available", partial: "Needs setup", off: "Off" };
const DOT: Record<AvailabilityState, string> = { ready: "ok", partial: "warn", off: "off" };
/** Lines of description shown before "Show more", per view (matches the CSS clamp). */
const CLAMP_LINES: Record<SettingsListView, number> = { list: 2, card: 3 };
const HIGHLIGHT_MS = 2400;

const groupTitle = (g: ToolGroupReport) => g.title ?? (g.id.startsWith(MCP_PREFIX) ? `MCP · ${g.id.slice(MCP_PREFIX.length)}` : g.id);
const toolTitle = (t: ToolReport) => t.title ?? t.name;
/** The description to show; an MCP tool's "[MCP: server]" prefix (for the model) is left out, since its group says so. */
const toolText = (t: ToolReport) => (t.detail || t.description).replace(/^\[MCP: [^\]]*\]\s*/, "");
/** A code name that may wrap after its underscores rather than mid-word. */
const breakable = (name: string) =>
  name.split(/(?<=_)/).map((part, i) => (
    <React.Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </React.Fragment>
  ));
const countLabel =(n: number) => (n === 0 ? "No tools" : n === 1 ? "1 tool" : `${n} tools`);

/**
 * The line under a group's title: why it is (not) available, or, while the group is closed and the reason
 * says nothing, what its tools do (once it is open they are listed below).
 */
function groupSummary(g: ToolGroupReport, open: boolean): string {
  const { reason } = g.availability;
  const titles = open ? "" : g.tools.map(toolTitle).join(", ");
  if (reason === "Needs no setup." && titles) return titles;
  if (reason === "Always loaded." && titles) return `Always loaded: ${titles}`;
  return reason;
}

/** A description cut to a few lines, with "Show more" when there is more to read. */
function ToolDescription({ text, lines, open, onToggle }: { text: string; lines: number; open: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 19;
      setLong(el.scrollHeight > lineHeight * lines + 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, lines]);
  if (!text) return <p className="settings-tools-desc is-empty">No description.</p>;
  return (
    <>
      <p ref={ref} className={`settings-tools-desc${open ? " is-open" : ""}`}>{text}</p>
      {long && (
        <button type="button" className="settings-tools-more" onClick={onToggle} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/**
 * Settings → Tools: every tool the agent can have, by group, and whether each group can work in the
 * chosen environment. Availability is worked out from configuration on the server; nothing is contacted.
 */
export default function ToolsSection({ focus }: { focus?: ToolFocus | null }) {
  const { envs, activeEnv, refreshEnvs } = useEnv();
  const [envKey, setEnvKey] = useState<string>(() => activeEnv?.key ?? "default");
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<AvailabilityState | null>(null);
  const [view, setView] = useState<SettingsListView>("list");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [foldedCards, setFoldedCards] = useState<Set<string>>(new Set());
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ToolFocus | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Until the user picks one, the picker follows the chat's default environment once it is known.
  const pickedEnv = useRef(false);
  const isMobile = useIsMobile();
  // Pull to refresh (phone): settles once the check it started has finished loading.
  const refreshDone = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (loading || !refreshDone.current) return;
    refreshDone.current();
    refreshDone.current = null;
  }, [loading]);
  const checkAgain = () =>
    new Promise<void>((resolve) => {
      refreshDone.current = resolve;
      setReloadToken((n) => n + 1);
    });

  useEffect(() => {
    if (envs.length === 0) void refreshEnvs().catch(() => {});
  }, []);
  useEffect(() => {
    if (!pickedEnv.current && activeEnv?.key) setEnvKey(activeEnv.key);
  }, [activeEnv?.key]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/chat/tools?env=${encodeURIComponent(envKey)}`)
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as Partial<ToolsResponse>;
        if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json as ToolsResponse;
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [envKey, reloadToken]);

  // /settings/tools/<name>: open that tool's group and its whole description, scroll to it and light it up for a moment.
  const focusGroup = useMemo(
    () => (focus && data ? data.groups.find((g) => g.tools.some((t) => t.name === focus.name))?.id : undefined),
    [focus, data],
  );
  const missingFocus = Boolean(focus && data && !focusGroup);
  useEffect(() => {
    if (!focus || !focusGroup) return;
    setQuery("");
    setStateFilter(null);
    setExpanded((prev) => (prev.has(focusGroup) ? prev : new Set(prev).add(focusGroup)));
    setFoldedCards((prev) => {
      if (!prev.has(focusGroup)) return prev;
      const next = new Set(prev);
      next.delete(focusGroup);
      return next;
    });
    setOpenTools((prev) => (prev.has(focus.name) ? prev : new Set(prev).add(focus.name)));
    setHighlight(focus.name);
    setScrollTarget({ name: focus.name, token: focus.token });
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [focus?.token, focusGroup]);
  // Scrolls once the render that opened the tool's group (and its description) is on screen.
  useEffect(() => {
    if (!scrollTarget) return;
    const frame = requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-tool="${CSS.escape(scrollTarget.name)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget]);

  const stateCounts = useMemo(() => {
    const counts: Record<AvailabilityState, number> = { ready: 0, partial: 0, off: 0 };
    for (const g of data?.groups ?? []) counts[g.availability.state] += 1;
    return counts;
  }, [data]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const groups = (data?.groups ?? []).filter((g) => !stateFilter || g.availability.state === stateFilter);
    if (!q) return groups.map((g) => ({ group: g, tools: g.tools }));
    const has = (text: string | undefined) => Boolean(text && text.toLowerCase().includes(q));
    return groups
      .map((g) => {
        const groupHit = has(groupTitle(g)) || has(g.id) || has(g.description);
        const tools = groupHit ? g.tools : g.tools.filter((t) => has(t.title) || has(t.name) || has(t.detail) || has(t.description));
        return { group: g, tools, hit: groupHit || tools.length > 0 };
      })
      .filter((g) => g.hit);
  }, [data, q, stateFilter]);

  // The list starts with every group closed (an overview); the grid starts with every group open (all the cards).
  const flip = (prev: Set<string>, id: string) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const toggle = (id: string) => (view === "card" ? setFoldedCards((prev) => flip(prev, id)) : setExpanded((prev) => flip(prev, id)));
  const isOpen = (id: string) => Boolean(q) || (view === "card" ? !foldedCards.has(id) : expanded.has(id));
  const toggleTool = (name: string) => setOpenTools((prev) => flip(prev, name));

  const envOptions = envs.length > 0 ? envs : [{ key: "default", name: "Default" }];
  const groupCount = data?.groups.length ?? 0;

  return (
    <section className="settings-section" aria-labelledby="settings-tools-title">
      <SettingsListHeader
        id="settings-tools-title"
        title="Tools"
        description="Everything the agent can use, and whether it works in an environment."
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search tools…"
        searchLabel="Search tools"
        view={view}
        onViewChange={setView}
        actions={
          <>
            <button
              type="button"
              className="icon-btn faint"
              disabled={loading}
              onClick={() => setReloadToken((n) => n + 1)}
              title="Check again"
              aria-label="Check tools again"
            >
              <RefreshCw size={13} className={loading ? "spin" : ""} />
            </button>
            <label className="settings-tools-env" title="Environment to check the tools in">
              <Server size={13} aria-hidden="true" />
              <select
                className="settings-select"
                value={envKey}
                onChange={(e) => {
                  pickedEnv.current = true;
                  setEnvKey(e.target.value);
                }}
                aria-label="Environment"
              >
                {envOptions.map((env) => (
                  <option key={env.key} value={env.key}>{env.name}</option>
                ))}
              </select>
            </label>
          </>
        }
        onRefresh={checkAgain}
        mobileActiveFilters={stateFilter ? 1 : 0}
        onResetFilters={() => setStateFilter(null)}
        mobileFilters={
          <>
            <SheetSection label="Environment">
              <div className="mlc-sheet-field">
                <select
                  className="settings-select"
                  value={envKey}
                  onChange={(e) => {
                    pickedEnv.current = true;
                    setEnvKey(e.target.value);
                  }}
                  aria-label="Environment"
                >
                  {envOptions.map((env) => (
                    <option key={env.key} value={env.key}>{env.name}</option>
                  ))}
                </select>
              </div>
            </SheetSection>
            {data !== null && groupCount > 0 && (
              <SheetOptions
                label="Show groups"
                value={stateFilter ?? "all"}
                onChange={(v) => setStateFilter(v === "all" ? null : v)}
                options={[
                  { value: "all" as const, label: "All", count: groupCount },
                  ...STATES.filter((s) => stateCounts[s] > 0).map((s) => ({ value: s, label: STATE_LABEL[s], count: stateCounts[s] })),
                ]}
              />
            )}
          </>
        }
      />

      {error && <div className="settings-error" role="alert">{error}</div>}
      {missingFocus && focus && (
        <p className="settings-placeholder" role="status">
          There is no tool called <code>{focus.name}</code> right now. An MCP server's tools are listed only while it is connected.
        </p>
      )}

      {/* On a phone these live in the filter sheet. */}
      {data !== null && groupCount > 0 && !isMobile && (
        <div className="settings-tools-filter" role="group" aria-label="Show groups">
          <span className="settings-tools-filter-env" aria-live="polite">
            In <strong>{data.env.name}</strong>
          </span>
          <button
            type="button"
            className={`settings-tools-chip${stateFilter === null ? " is-active" : ""}`}
            aria-pressed={stateFilter === null}
            onClick={() => setStateFilter(null)}
          >
            All <span className="settings-tools-chip-n">{groupCount}</span>
          </button>
          {STATES.filter((s) => stateCounts[s] > 0).map((s) => (
            <button
              key={s}
              type="button"
              className={`settings-tools-chip${stateFilter === s ? " is-active" : ""}`}
              aria-pressed={stateFilter === s}
              onClick={() => setStateFilter((prev) => (prev === s ? null : s))}
            >
              <span className={`settings-mcp-dot is-${DOT[s]}`} aria-hidden="true" />
              {STATE_LABEL[s]} <span className="settings-tools-chip-n">{stateCounts[s]}</span>
            </button>
          ))}
        </div>
      )}

      {data === null ? (
        !error && <p className="settings-placeholder">Loading tools…</p>
      ) : shown.length === 0 ? (
        <p className="settings-placeholder">
          {q ? `No tool matches "${query.trim()}".` : "No tool groups to show."}
        </p>
      ) : (
        <div className={`settings-tools is-${view}${loading ? " is-loading" : ""}`} ref={listRef}>
          {shown.map(({ group, tools }) => {
            const open = isOpen(group.id);
            const { availability } = group;
            const { state } = availability;
            const title = groupTitle(group);
            const isMcp = group.id.startsWith(MCP_PREFIX);
            const bodyId = `settings-tools-body-${group.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
            const filtered = q && tools.length < group.tools.length;
            return (
              <div className={`settings-tools-group is-${state}${open ? " is-open" : ""}`} key={group.id}>
                <button
                  type="button"
                  className="settings-tools-head"
                  onClick={() => toggle(group.id)}
                  aria-expanded={open}
                  aria-controls={open ? bodyId : undefined}
                >
                  <ChevronRight size={13} className={open ? "is-open" : ""} aria-hidden="true" />
                  <span className="settings-tools-head-text">
                    <span className="settings-tools-head-line">
                      <span className="settings-tools-group-title">{title}</span>
                      <span className="settings-tools-count">
                        {filtered ? `${tools.length} of ${group.tools.length}` : countLabel(group.tools.length)}
                      </span>
                    </span>
                    <span className="settings-tools-reason">{groupSummary(group, open)}</span>
                  </span>
                  <span className={`settings-tools-status is-${state}`}>
                    <span className={`settings-mcp-dot is-${DOT[state]}`} aria-hidden="true" />
                    {STATE_LABEL[state]}
                  </span>
                </button>
                {open && (
                  <div className="settings-tools-body" id={bodyId}>
                    {availability.items && availability.items.length > 0 && (
                      <div className="settings-tools-conns">
                        <span className="settings-tools-caption">Connections in {data.env.name}</span>
                        <ul aria-label={`${title} connections`}>
                          {availability.items.map((item) => (
                            <li key={item.name} className={`is-${item.state}`}>
                              <span className={`settings-mcp-dot is-${item.state === "ready" ? "ok" : "warn"}`} aria-hidden="true" />
                              <code>{item.name}</code>
                              <span className="settings-tools-conn-detail">
                                <span className="settings-sr-only">{item.state === "ready" ? "Ready: " : "Not usable: "}</span>
                                {item.detail}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(isMcp || tools.length === 0) && (
                      <div className="settings-tools-note">
                        {tools.length === 0 && <p>Its tools are listed here while it is connected.</p>}
                        {isMcp && (
                          <button type="button" className="settings-reset settings-tools-link" onClick={() => openAppPath(settingsPath("mcp"))}>
                            Manage MCP servers
                          </button>
                        )}
                      </div>
                    )}
                    {tools.length > 0 && (
                      <ul className="settings-tools-tools" aria-label={`${title} tools`}>
                        {tools.map((tool) => (
                          <li
                            key={tool.name}
                            data-tool={tool.name}
                            className={`settings-tools-tool${highlight === tool.name ? " is-highlighted" : ""}`}
                          >
                            <div className="settings-tools-tool-head">
                              {view === "card" && (
                                <span className={`settings-mcp-dot is-${DOT[state]}`} title={STATE_LABEL[state]} aria-hidden="true" />
                              )}
                              <span className="settings-tools-tool-title">{toolTitle(tool)}</span>
                              <code className="settings-tools-code" title="The name the agent uses">{breakable(tool.name)}</code>
                            </div>
                            <ToolDescription
                              text={toolText(tool)}
                              lines={CLAMP_LINES[view]}
                              open={openTools.has(tool.name)}
                              onToggle={() => toggleTool(tool.name)}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="settings-list-foot">
        Worked out from <code>config.toml</code> and <code>mcp.json</code>; no service is contacted. Databases, AWS and
        Jira can differ per environment; code search, git and MCP servers are the same in all of them.
      </p>
    </section>
  );
}
