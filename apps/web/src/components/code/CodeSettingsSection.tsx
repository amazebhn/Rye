import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArchiveRestore, ArrowRight, Plus, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import type { CodePolicyResponse, CodeReposResponse, CodeSessionDetail, CodeSessionSummary } from "@rye/shared";
import { codeApi, refreshCodeSessions, useCodeEngines } from "../../utils/codeApi";
import SettingsListHeader, { type SettingsListView } from "../settings/SettingsListHeader";
import { SheetAction, SheetSection } from "../shared/MobileListControls";
import Modal, { ModalCancelButton } from "../shared/Modal";
import NewCodeSessionDialog from "./NewCodeSessionDialog";
import { openChatById } from "./CodeSessionCard";
import { loadPolicy } from "./BranchChip";
import { ACTIVITY_LABEL, ago, formatBytes, formatCost } from "./codeFormat";

const VERDICT_LABEL = { allow: "Allow", ask: "Ask", deny: "Deny" } as const;
const SOURCE_LABEL = { builtin: "Built in", config: "config.toml", repo: "Repo", session: "This session" } as const;

/** The folder sessions live in: the parent of `<id>/repo` in a session's workspace path. */
function worktreeRoot(detail: CodeSessionDetail | null): string | null {
  const path = detail?.workspacePath;
  if (!path) return null;
  const m = /^(.*)[/\\][^/\\]+[/\\]repo[/\\]?$/.exec(path);
  return m ? m[1] : null;
}

/**
 * Settings → Code: the allowed repos, the engines and their availability, the effective policy and the
 * sandbox, and every session with its disk use (archive, restore, delete). A list page like MCP servers.
 */
export default function CodeSettingsSection() {
  const engines = useCodeEngines();
  const [repos, setRepos] = useState<CodeReposResponse | null>(null);
  const [policy, setPolicy] = useState<CodePolicyResponse | null>(null);
  const [sessions, setSessions] = useState<CodeSessionSummary[] | null>(null);
  const [sample, setSample] = useState<CodeSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<SettingsListView>("list");
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CodeSessionSummary | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, p, s] = await Promise.all([codeApi.repos(), loadPolicy(true), codeApi.sessions({ status: "all" })]);
      setRepos(r);
      setPolicy(p);
      setSessions(s.sessions);
      const active = s.sessions.find((x) => x.state === "active");
      if (active) codeApi.detail(active.id).then(setSample, () => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      void refreshCodeSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const shownSessions = useMemo(
    () => (sessions ?? []).filter((s) => !needle || `${s.title} ${s.repo} ${s.branch} ${s.engine}`.toLowerCase().includes(needle)),
    [sessions, needle],
  );
  const shownRepos = useMemo(
    () => (repos?.repos ?? []).filter((r) => !needle || `${r.name} ${r.path}`.toLowerCase().includes(needle)),
    [repos, needle],
  );
  const disk = (sessions ?? []).reduce((sum, s) => sum + (s.diskBytes ?? 0), 0);
  const root = worktreeRoot(sample);

  return (
    <section className="settings-section code-settings" aria-labelledby="settings-code-title">
      <SettingsListHeader
        id="settings-code-title"
        title="Code"
        description="Coding agents that work on a branch in a sandboxed copy of an allowed repo."
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search repos and sessions…"
        searchLabel="Search repos and code sessions"
        view={view}
        onViewChange={setView}
        actions={
          <button type="button" className="icon-btn faint" onClick={() => void act("load", async () => {})} disabled={busy !== null} title="Reload" aria-label="Reload code settings">
            <RefreshCw size={13} className={busy === "load" ? "spin" : ""} />
          </button>
        }
        primary={{ label: "New session", icon: Plus, onClick: () => setCreating(true), disabled: !repos?.repos.some((r) => r.available) }}
        onRefresh={load}
        mobileFilters={
          <SheetSection label="More">
            <div className="mlc-actions">
              <SheetAction icon={RefreshCw} label="Reload" busy={busy === "load"} disabled={busy !== null} onClick={() => void act("load", async () => {})} />
            </div>
          </SheetSection>
        }
      />

      {error && <div className="settings-error" role="alert">{error}</div>}

      <div className="code-settings-group">
        <h4 className="code-settings-heading">Repos</h4>
        {!repos ? (
          <p className="settings-placeholder">Loading repos…</p>
        ) : repos.repos.length === 0 ? (
          <p className="settings-placeholder">No repos are allowed yet. Add one under <code>[[code.repos]]</code> in <code>config.toml</code>; being listed for code search doesn’t allow changes.</p>
        ) : shownRepos.length === 0 ? (
          <p className="settings-placeholder">No repo matches “{query.trim()}”.</p>
        ) : (
          <ul className="settings-task-list" aria-label="Allowed repos">
            {shownRepos.map((r) => (
              <li key={r.name} className="settings-task">
                <span className="settings-task-text">
                  <span className="settings-task-name code-settings-name">
                    <span className={`settings-mcp-dot is-${r.available ? "ok" : "error"}`} aria-hidden="true" />
                    {r.name}
                    <span className="settings-source">base {r.base}</span>
                    {r.isolation === "worktree" && <span className="settings-source">worktree</span>}
                  </span>
                  <span className="settings-task-desc code-mono" title={r.path}>{r.path}</span>
                  <span className="settings-task-desc">
                    {r.available ? `${r.setup.length} setup step${r.setup.length === 1 ? "" : "s"} · ${r.checks.length} check${r.checks.length === 1 ? "" : "s"}` : r.reason ?? "Not available"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {repos && repos.candidates.length > 0 && (
          <p className="settings-list-foot">
            Known to code search but not allowed for sessions: {repos.candidates.map((c) => c.name).join(", ")}. Add them under <code>[[code.repos]]</code> to enable them.
          </p>
        )}
      </div>

      <div className="code-settings-group">
        <h4 className="code-settings-heading">Engines</h4>
        {!engines ? (
          <p className="settings-placeholder">Loading engines…</p>
        ) : (
          <ul className="settings-task-list" aria-label="Code engines">
            {engines.engines.map((e) => (
              <li key={e.id} className="settings-task">
                <span className="settings-task-text">
                  <span className="settings-task-name code-settings-name">
                    <span className={`settings-mcp-dot is-${e.availability.available ? "ok" : "off"}`} aria-hidden="true" />
                    {e.title}
                    {e.id === engines.defaultEngine && <span className="settings-source settings-source--settings">Default</span>}
                  </span>
                  <span className="settings-task-desc">
                    {e.availability.available
                      ? [e.availability.account, e.defaultModel ? `model ${e.defaultModel}` : null, `${e.models.length} model${e.models.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
                      : e.availability.reason ?? "Not available here"}
                  </span>
                  <span className="settings-task-desc">
                    {[e.capabilities.liveApprovals ? "asks before risky steps" : "can't ask before risky steps", e.capabilities.ownSandbox ? "sandboxes its own commands" : "runs wholly in Rye's sandbox", e.capabilities.resume ? "resumable" : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="settings-list-foot">The default engine and model are <code>engine</code> and <code>model</code> under <code>[code]</code> in <code>config.toml</code>.</p>
      </div>

      <div className="code-settings-group">
        <h4 className="code-settings-heading">Sandbox and policy</h4>
        {!policy ? (
          <p className="settings-placeholder">Loading policy…</p>
        ) : (
          <>
            <p className={`code-settings-sandbox${policy.sandbox.available ? "" : " is-off"}`}>
              {policy.sandbox.available ? <ShieldCheck size={15} aria-hidden="true" /> : <ShieldOff size={15} aria-hidden="true" />}
              {policy.sandbox.available
                ? `Commands run in the OS sandbox (${policy.sandbox.mechanism === "seatbelt" ? "Seatbelt" : "bubblewrap"}).`
                : `No OS sandbox, so code sessions can't run: ${policy.sandbox.reason ?? "unavailable on this machine"}.`}
            </p>
            <div className="code-settings-table-wrap">
              <table className="code-settings-table">
                <thead>
                  <tr><th scope="col">Rule</th><th scope="col">Verdict</th><th scope="col">From</th></tr>
                </thead>
                <tbody>
                  {policy.rules.map((rule, i) => (
                    <tr key={i}>
                      <td>
                        <code className="code-settings-pattern">{rule.pattern}</code>
                        {rule.reason && <span className="code-settings-reason">{rule.reason}</span>}
                      </td>
                      <td><span className={`code-verdict code-verdict--${rule.verdict}`}>{VERDICT_LABEL[rule.verdict]}</span></td>
                      <td className="code-settings-from">{SOURCE_LABEL[rule.source]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="settings-list-foot">
              Hosts allowed without asking: {policy.allowedDomains.length ? policy.allowedDomains.join(", ") : "none"}. Your own rules go under <code>[code.policy]</code>; the built-in deny list can’t be removed.
            </p>
          </>
        )}
      </div>

      <div className="code-settings-group">
        <h4 className="code-settings-heading">
          Sessions and disk
          {sessions && sessions.length > 0 && <span className="code-settings-sub">{formatBytes(disk)} in all</span>}
        </h4>
        <p className="settings-list-foot">
          Workspaces live in {root ? <code>{root}</code> : <>the folder set by <code>worktree_root</code> under <code>[code]</code> (blank: <code>code/</code> in Rye’s data folder)</>}. Archiving removes a workspace and keeps its snapshots, so it can be restored; deleting also drops the snapshots, but never a branch you created.
        </p>
        {!sessions ? (
          <p className="settings-placeholder">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="settings-placeholder">No code sessions yet.</p>
        ) : shownSessions.length === 0 ? (
          <p className="settings-placeholder">No session matches “{query.trim()}”.</p>
        ) : (
          <ul className={view === "card" ? "sop-card-grid code-settings-cards" : "settings-task-list"} aria-label="Code sessions">
            {shownSessions.map((s) => {
              const archived = s.state === "archived";
              const meta = [s.repo, s.branch, archived ? `archived ${ago(s.archivedAt ?? s.updatedAt)}` : ACTIVITY_LABEL[s.activity], s.diskBytes !== undefined ? formatBytes(s.diskBytes) : null, s.costUsd ? formatCost(s.costUsd) : null].filter(Boolean).join(" · ");
              const actions = (
                <span className="code-settings-actions">
                  {archived ? (
                    <button type="button" className="btn btn--sm btn--ghost" disabled={busy !== null} onClick={() => void act(s.id, () => codeApi.restore(s.id))}>
                      <ArchiveRestore size={13} aria-hidden="true" /> {busy === s.id ? "Restoring…" : "Restore"}
                    </button>
                  ) : (
                    <button type="button" className="btn btn--sm btn--ghost" disabled={busy !== null || s.activity === "running"} onClick={() => void act(s.id, () => codeApi.archive(s.id))}>
                      {busy === s.id ? "Archiving…" : "Archive"}
                    </button>
                  )}
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => openChatById(s.chatId)} title="Open its chat">
                    Open <ArrowRight size={13} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn code-settings-delete" disabled={busy !== null || s.activity === "running"} onClick={() => setDeleting(s)} aria-label={`Delete ${s.title}`} title="Delete">
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </span>
              );
              return view === "card" ? (
                <li key={s.id} className={`sop-card code-settings-card${archived ? " is-off" : ""}`}>
                  <div className="sop-card-header"><span className="sop-card-title">{s.title}</span></div>
                  <p className="sop-card-preview">{meta}</p>
                  <div className="sop-card-footer"><span>{ago(s.updatedAt)}</span>{actions}</div>
                </li>
              ) : (
                <li key={s.id} className={`settings-task${archived ? " is-off" : ""}`}>
                  <span className="settings-task-text">
                    <span className="settings-task-name">{s.title}</span>
                    <span className="settings-task-desc">{meta}</span>
                  </span>
                  {actions}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {creating && (
        <NewCodeSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(chatId) => {
            setCreating(false);
            openChatById(chatId);
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`Delete “${deleting.title}”?`}
          description="Its workspace and snapshots are removed for good. Branches you created from it stay in your repo; its chat stays too."
          className="modal--compact"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <ModalCancelButton autoFocus />
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={() => {
                  const s = deleting;
                  setDeleting(null);
                  void act(s.id, () => codeApi.remove(s.id));
                }}
              >
                Delete session
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
