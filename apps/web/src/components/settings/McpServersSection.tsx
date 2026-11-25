import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import Modal, { ModalCancelButton } from "../shared/Modal";
import { SheetAction, SheetSection } from "../shared/MobileListControls";
import SettingsListHeader, { type SettingsListView } from "./SettingsListHeader";

/** A server definition as it is written in mcp.json. Secrets there are `${ENV}` references. */
interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  transport?: "http" | "sse";
  auth?: "oauth";
  oauth?: Record<string, string>;
  disabled?: boolean;
}

/** One row of `GET /mcp/servers`: the file's entry plus how its connection is doing. */
interface McpServer {
  name: string;
  disabled: boolean;
  problems: string[];
  config: McpServerConfig;
  transport: string;
  connected: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
  error?: string;
  auth?: "oauth";
  authRequired?: boolean;
  authorizeUrl?: string;
}

interface McpServersResponse {
  config_file: string;
  servers: McpServer[];
  error?: string;
}

async function mcpRequest(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<McpServersResponse> {
  const res = await fetch(path, {
    method,
    // Changes are only accepted as JSON (see refuseForeignMcpWrite on the server).
    ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<McpServersResponse>;
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { config_file: json.config_file ?? "", servers: json.servers ?? [], error: json.error };
}

const TRANSPORT_LABEL: Record<string, string> = { stdio: "Local command", http: "HTTP", sse: "SSE", unknown: "Unknown" };

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

interface Draft {
  name: string;
  kind: "command" | "url";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  transport: "http" | "sse";
  headers: string;
  oauth: boolean;
}

const EMPTY_DRAFT: Draft = { name: "", kind: "command", command: "", args: "", env: "", cwd: "", url: "", transport: "http", headers: "", oauth: false };

const pairsToLines = (record: Record<string, string> | undefined, sep: string) =>
  Object.entries(record ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");

/** "KEY=value" (or "Name: value") lines to an object; blank lines are skipped, a line without the separator is an error. */
function linesToPairs(text: string, sep: string, label: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(sep);
    if (at <= 0) throw new Error(`${label}: "${line}" should look like NAME${sep}value.`);
    out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Split an argument line the way a shell would: spaces separate, quotes group. */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const joinArgs = (args: string[] | undefined) => (args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

function draftFrom(server: McpServer): Draft {
  const c = server.config;
  return {
    name: server.name,
    kind: c.url ? "url" : "command",
    command: c.command ?? "",
    args: joinArgs(c.args),
    env: pairsToLines(c.env, "="),
    cwd: c.cwd ?? "",
    url: c.url ?? "",
    transport: c.transport ?? "http",
    headers: pairsToLines(c.headers, ": "),
    oauth: c.auth === "oauth",
  };
}

/** The definition to save. Fields the form doesn't show (OAuth details, the disabled flag) are kept from `existing`. */
function configFrom(draft: Draft, existing?: McpServerConfig): McpServerConfig {
  const keep = existing?.disabled ? { disabled: true } : {};
  if (draft.kind === "command") {
    const args = splitArgs(draft.args);
    const env = linesToPairs(draft.env, "=", "Environment");
    return {
      command: draft.command.trim(),
      ...(args.length ? { args } : {}),
      ...(env ? { env } : {}),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      ...keep,
    };
  }
  const headers = linesToPairs(draft.headers, ":", "Headers");
  return {
    url: draft.url.trim(),
    transport: draft.transport,
    ...(headers ? { headers } : {}),
    ...(draft.oauth ? { auth: "oauth" as const, ...(existing?.oauth ? { oauth: existing.oauth } : {}) } : {}),
    ...keep,
  };
}

function ServerForm({
  editing,
  onSaved,
  onClose,
}: {
  /** The server being edited, or null to add one. */
  editing: McpServer | null;
  onSaved: (data: McpServersResponse) => void;
  onClose: () => void;
}) {
  const initial = useMemo(() => (editing ? draftFrom(editing) : EMPTY_DRAFT), [editing]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const ready = draft.name.trim() !== "" && (draft.kind === "command" ? draft.command.trim() !== "" : draft.url.trim() !== "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const config = configFrom(draft, editing?.config);
      onSaved(
        editing
          ? await mcpRequest(`/mcp/servers/${encodeURIComponent(editing.name)}`, "PUT", { config })
          : await mcpRequest("/mcp/servers", "POST", { name: draft.name.trim(), config }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${editing.name}` : "Add MCP server"}
      description="Rye connects to it straight away and offers its tools to the agent."
      className="modal--compact settings-mcp-modal"
      onClose={onClose}
      lockBackdrop
      guardDismiss={dirty && !saving}
      guardMessage="This server hasn't been saved. If you close now, what you entered will be lost."
      footer={
        <>
          <ModalCancelButton />
          <button type="submit" form="settings-mcp-form" className="btn btn--primary btn--sm" disabled={!ready || saving}>
            {saving ? "Connecting…" : editing ? "Save" : "Add server"}
          </button>
        </>
      }
    >
      <form id="settings-mcp-form" className="modal-form" onSubmit={(e) => void submit(e)}>
        <label className="form-label" htmlFor="mcp-name">Name</label>
        <input
          id="mcp-name"
          className="form-input"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="grafana"
          // The name is the key in the file and part of every tool name, so it is fixed once saved.
          disabled={editing !== null}
          autoFocus={editing === null}
          autoComplete="off"
          spellCheck={false}
        />

        <span className="form-label" id="mcp-kind-label">Connects by</span>
        <div className="sop-diff-tabs settings-mcp-choice" role="radiogroup" aria-labelledby="mcp-kind-label">
          {([["command", "Running a command"], ["url", "A URL"]] as const).map(([kind, label]) => (
            <button key={kind} type="button" role="radio" aria-checked={draft.kind === kind} className={`sop-diff-tab${draft.kind === kind ? " active" : ""}`} onClick={() => set("kind", kind)}>
              {label}
            </button>
          ))}
        </div>

        {draft.kind === "command" ? (
          <>
            <label className="form-label" htmlFor="mcp-command">Command</label>
            <input id="mcp-command" className="form-input" value={draft.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" autoComplete="off" spellCheck={false} />
            <label className="form-label" htmlFor="mcp-args">Arguments <span className="form-label-hint">separated by spaces; quote one that contains a space</span></label>
            <input id="mcp-args" className="form-input" value={draft.args} onChange={(e) => set("args", e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" autoComplete="off" spellCheck={false} />
            <label className="form-label" htmlFor="mcp-env">Environment <span className="form-label-hint">one NAME=value per line</span></label>
            <textarea id="mcp-env" className="form-input settings-mcp-lines" rows={3} value={draft.env} onChange={(e) => set("env", e.target.value)} placeholder={"API_TOKEN=${MY_API_TOKEN}"} spellCheck={false} />
            <label className="form-label" htmlFor="mcp-cwd">Working directory <span className="form-label-hint">optional</span></label>
            <input id="mcp-cwd" className="form-input" value={draft.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="~/projects/tools" autoComplete="off" spellCheck={false} />
          </>
        ) : (
          <>
            <label className="form-label" htmlFor="mcp-url">URL</label>
            <input id="mcp-url" className="form-input" value={draft.url} onChange={(e) => set("url", e.target.value)} placeholder="https://mcp.example.com/mcp" autoComplete="off" spellCheck={false} />
            <span className="form-label" id="mcp-transport-label">Transport</span>
            <div className="sop-diff-tabs settings-mcp-choice" role="radiogroup" aria-labelledby="mcp-transport-label">
              {([["http", "HTTP (streamable)"], ["sse", "SSE"]] as const).map(([transport, label]) => (
                <button key={transport} type="button" role="radio" aria-checked={draft.transport === transport} className={`sop-diff-tab${draft.transport === transport ? " active" : ""}`} onClick={() => set("transport", transport)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="form-label" htmlFor="mcp-headers">Headers <span className="form-label-hint">one Name: value per line</span></label>
            <textarea id="mcp-headers" className="form-input settings-mcp-lines" rows={3} value={draft.headers} onChange={(e) => set("headers", e.target.value)} placeholder={"Authorization: Bearer ${MY_API_TOKEN}"} spellCheck={false} />
            <label className="settings-mcp-check">
              <input type="checkbox" checked={draft.oauth} onChange={(e) => set("oauth", e.target.checked)} />
              <span>Sign in with OAuth (Rye opens the provider's sign-in page when it connects)</span>
            </label>
          </>
        )}

        <p className="settings-mcp-hint">
          Don't paste tokens or passwords here. Put them in your environment or <code>.env</code> and refer to them as{" "}
          <code>{"${NAME}"}</code>; Rye refuses to save one written out.
        </p>
        {error && <div className="settings-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Row menu
// ---------------------------------------------------------------------------

function ServerMenu({ onEdit, onRemove }: { onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    // In grid view the card opens its details on click; the menu is not part of that.
    <div ref={ref} className="sop-menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="icon-btn sop-menu-btn" onClick={() => setOpen((v) => !v)} title="Options" aria-label="Server options" aria-expanded={open}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="sop-menu-dropdown">
          <button type="button" className="sop-menu-item" onClick={() => { setOpen(false); onEdit(); }}>
            <Pencil size={12} /> Edit
          </button>
          <button type="button" className="sop-menu-item sop-menu-item--danger" onClick={() => { setOpen(false); onRemove(); }}>
            <Trash2 size={12} /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces shared by the list and the grid
// ---------------------------------------------------------------------------

/** How a server is doing: the colour of its dot, a one-line summary, and where to sign in if it needs to. */
function serverStatus(server: McpServer) {
  const state = server.disabled ? "off" : server.connected ? "ok" : server.authRequired ? "warn" : "error";
  const summary = server.disabled
    ? "Turned off"
    : server.problems.length > 0
      ? `Can't be used: ${server.problems[0]}`
      : server.connected
        ? `Connected · ${toolCountLabel(server.toolCount)}`
        : server.authRequired
          ? "Sign-in required"
          : `Not connected${server.error ? `: ${server.error}` : ""}`;
  const authorizeUrl = server.authorizeUrl && /^https?:\/\//.test(server.authorizeUrl) ? server.authorizeUrl : null;
  const signIn = !server.disabled && !server.connected ? authorizeUrl : null;
  // A card shows the tool count in its footer, so its summary leaves it out.
  const cardSummary = !server.disabled && server.problems.length === 0 && server.connected ? "Connected" : summary;
  return { state, summary, cardSummary, signIn };
}

const toolCountLabel = (n: number) => `${n} ${n === 1 ? "tool" : "tools"}`;

function ServerBadges({ server }: { server: McpServer }) {
  return (
    <>
      <span className="settings-source">{TRANSPORT_LABEL[server.transport] ?? server.transport}</span>
      {server.auth === "oauth" && <span className="settings-source">OAuth</span>}
    </>
  );
}

function SignInLink({ url }: { url: string }) {
  return (
    <a className="settings-reset" href={url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
      Sign in <ExternalLink size={12} />
    </a>
  );
}

function ServerSwitch({ server, disabled, onChange }: { server: McpServer; disabled: boolean; onChange: (disabled: boolean) => void }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="settings-switch"
      checked={!server.disabled}
      disabled={disabled}
      aria-label={`${server.name} enabled`}
      title={server.disabled ? "Turn on" : "Turn off"}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(!e.target.checked)}
    />
  );
}

/** What a server runs, what went wrong, and its tools: under an expanded row, or in the dialog a card opens. */
function ServerDetails({ server }: { server: McpServer }) {
  return (
    <>
      <div className="settings-mcp-def">
        <code>{server.config.url ?? [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(" ")}</code>
      </div>
      {server.problems.length > 1 && <ul className="settings-mcp-problems">{server.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {!server.disabled && !server.connected && server.error && <pre className="settings-mcp-error">{server.error}</pre>}
      {server.tools.length > 0 ? (
        <ul className="settings-mcp-tools" aria-label={`Tools from ${server.name}`}>
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>
              {tool.readOnly && <span className="settings-source">read-only</span>}
              {tool.description && <span className="settings-mcp-tool-desc">{tool.description}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-task-desc">{server.connected ? "This server offers no tools." : "Its tools are listed here once it connects."}</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/** MCP servers: what is configured, how each connection is doing, and adding, editing, switching off and removing them. */
export default function McpServersSection() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [configFile, setConfigFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "reload", or the name of the server being changed
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<{ editing: McpServer | null } | null>(null);
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // A list by default, as on the Skills page.
  const [view, setView] = useState<SettingsListView>("list");
  // The server whose details are open from a card (grid view). Looked up by name so it follows reloads.
  const [detailsName, setDetailsName] = useState<string | null>(null);

  const apply = useCallback((data: McpServersResponse) => {
    setServers(data.servers);
    if (data.config_file) setConfigFile(data.config_file);
    setError(data.error ?? null);
  }, []);

  const run = useCallback(
    async (label: string, request: () => Promise<McpServersResponse>) => {
      setBusy(label);
      setError(null);
      try {
        apply(await request());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  useEffect(() => { void run("load", () => mcpRequest("/mcp/servers", "GET")); }, [run]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...(servers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return sorted;
    return sorted.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.config.command ?? s.config.url ?? "").toLowerCase().includes(q) || s.tools.some((t) => t.name.toLowerCase().includes(q)),
    );
  }, [servers, query]);

  const toggleExpanded = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const setDisabled = (server: McpServer, disabled: boolean) =>
    void run(server.name, () => mcpRequest(`/mcp/servers/${encodeURIComponent(server.name)}`, "PATCH", { disabled }));
  const details = detailsName === null ? null : servers?.find((s) => s.name === detailsName) ?? null;
  const detailsStatus = details && serverStatus(details);

  return (
    <section className="settings-section" aria-labelledby="settings-mcp-title">
      <SettingsListHeader
        id="settings-mcp-title"
        title="MCP servers"
        description="External tool servers Rye connects to and offers to the agent."
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search servers…"
        searchLabel="Search MCP servers"
        view={view}
        onViewChange={setView}
        actions={
          <button
            type="button"
            className="icon-btn faint"
            disabled={busy !== null}
            onClick={() => void run("reload", () => mcpRequest("/mcp/reload", "POST"))}
            title="Re-read the config file and reconnect every server"
            aria-label="Reload MCP servers"
          >
            <RefreshCw size={13} className={busy === "reload" ? "spin" : ""} />
          </button>
        }
        primary={{ label: "Add server", icon: Plus, onClick: () => setForm({ editing: null }) }}
        // Pulling the list re-reads the servers' status; reconnecting every server stays a deliberate action in the sheet.
        onRefresh={() => run("load", () => mcpRequest("/mcp/servers", "GET"))}
        mobileFilters={
          <SheetSection label="More">
            <div className="mlc-actions">
              <SheetAction
                icon={RefreshCw}
                label={busy === "reload" ? "Reconnecting…" : "Re-read config & reconnect all"}
                busy={busy === "reload"}
                disabled={busy !== null}
                onClick={() => void run("reload", () => mcpRequest("/mcp/reload", "POST"))}
              />
            </div>
          </SheetSection>
        }
      />

      {error && <div className="settings-error" role="alert">{error}</div>}

      {servers === null ? (
        !error && <p className="settings-placeholder">Loading MCP servers…</p>
      ) : servers.length === 0 ? (
        <p className="settings-placeholder">
          No MCP servers yet. Add one here, or ask Rye in a chat to set one up (it asks you to confirm before saving).
        </p>
      ) : shown.length === 0 ? (
        <p className="settings-placeholder">No server matches "{query.trim()}".</p>
      ) : view === "card" ? (
        <ul className="sop-card-grid settings-mcp-grid" aria-label="MCP servers">
          {shown.map((server) => {
            const { state, cardSummary, signIn } = serverStatus(server);
            return (
              // A click anywhere on the card opens its details; the name is the button keyboard users reach.
              <li
                className={`sop-card settings-mcp-card${server.disabled ? " is-off" : ""}`}
                key={server.name}
                onClick={() => setDetailsName(server.name)}
              >
                <div className="sop-card-header">
                  <button
                    type="button"
                    className="sop-card-title settings-mcp-card-open"
                    onClick={(e) => { e.stopPropagation(); setDetailsName(server.name); }}
                    aria-haspopup="dialog"
                    title="Show details"
                  >
                    <span className={`settings-mcp-dot is-${state}`} aria-hidden="true" />
                    <span className="settings-mcp-card-name">{server.name}</span>
                  </button>
                  <ServerMenu onEdit={() => setForm({ editing: server })} onRemove={() => setRemoving(server)} />
                </div>
                <div className="settings-mcp-card-badges"><ServerBadges server={server} /></div>
                <p className="sop-card-preview settings-mcp-detail">{cardSummary}</p>
                <div className="sop-card-footer">
                  <span>{server.connected ? toolCountLabel(server.toolCount) : server.disabled ? "" : "No tools yet"}</span>
                  <span className="settings-mcp-card-controls">
                    {signIn && <SignInLink url={signIn} />}
                    <ServerSwitch server={server} disabled={busy !== null} onChange={(off) => setDisabled(server, off)} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="settings-task-list settings-mcp-list" aria-label="MCP servers">
          {shown.map((server) => {
            const { state, summary, signIn } = serverStatus(server);
            const open = expanded.has(server.name);
            return (
              <li className={`settings-mcp-item${server.disabled ? " is-off" : ""}`} key={server.name}>
                <div className="settings-task">
                  <button type="button" className="settings-mcp-toggle" onClick={() => toggleExpanded(server.name)} aria-expanded={open} title={open ? "Hide details" : "Show details"}>
                    <ChevronRight size={13} className={open ? "is-open" : ""} aria-hidden="true" />
                    <span className="settings-task-text">
                      <span className="settings-task-name settings-mcp-name">
                        <span className={`settings-mcp-dot is-${state}`} aria-hidden="true" />
                        {server.name}
                        <ServerBadges server={server} />
                      </span>
                      <span className="settings-task-desc settings-mcp-detail">{summary}</span>
                    </span>
                  </button>
                  {signIn && <SignInLink url={signIn} />}
                  <ServerSwitch server={server} disabled={busy !== null} onChange={(off) => setDisabled(server, off)} />
                  <ServerMenu onEdit={() => setForm({ editing: server })} onRemove={() => setRemoving(server)} />
                </div>
                {open && (
                  <div className="settings-mcp-more">
                    <ServerDetails server={server} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {configFile && <p className="settings-list-foot">Saved in <code>{configFile}</code>.</p>}

      {details && detailsStatus && (
        <Modal
          title={details.name}
          className="modal--compact settings-mcp-modal"
          onClose={() => setDetailsName(null)}
          footer={
            <>
              <ModalCancelButton label="Close" />
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => { setDetailsName(null); setForm({ editing: details }); }}
              >
                <Pencil size={12} /> Edit
              </button>
            </>
          }
        >
          <div className="settings-mcp-details">
            <div className="settings-mcp-details-status">
              <span className="settings-mcp-name">
                <span className={`settings-mcp-dot is-${detailsStatus.state}`} aria-hidden="true" />
                <ServerBadges server={details} />
              </span>
              <span className="settings-mcp-card-controls">
                {detailsStatus.signIn && <SignInLink url={detailsStatus.signIn} />}
                <ServerSwitch server={details} disabled={busy !== null} onChange={(off) => setDisabled(details, off)} />
              </span>
            </div>
            <p className="settings-task-desc settings-mcp-detail">{detailsStatus.summary}</p>
            <ServerDetails server={details} />
          </div>
        </Modal>
      )}

      {form && <ServerForm editing={form.editing} onSaved={apply} onClose={() => setForm(null)} />}

      {removing && (
        <Modal
          title={`Remove “${removing.name}”?`}
          description="Its definition is deleted from the config file and the agent loses its tools. To keep it for later, turn it off instead."
          className="modal--compact"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <ModalCancelButton />
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={busy !== null}
                onClick={() => {
                  const name = removing.name;
                  setRemoving(null);
                  void run(name, () => mcpRequest(`/mcp/servers/${encodeURIComponent(name)}`, "DELETE"));
                }}
              >
                Remove
              </button>
            </>
          }
        >
          {null}
        </Modal>
      )}
    </section>
  );
}
