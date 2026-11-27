import React, { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { CodeBranchesResponse, CodeEngineId, CodeReposResponse } from "@rye/shared";
import { codeApi, CodeApiError, refreshCodeSessions, useCodeEngines } from "../../utils/codeApi";
import Modal, { ModalCancelButton } from "../shared/Modal";

interface Props {
  onClose: () => void;
  /** The session was created: open its chat. */
  onCreated: (chatId: string, title: string) => void;
}

const ERROR_TEXT: Partial<Record<NonNullable<CodeApiError["code"]>, string>> = {
  sandbox_unavailable: "The OS sandbox isn't available on this machine, so code sessions can't run. Settings → Code says why.",
  limit: "The most code sessions allowed at once are already open. Archive one from Settings → Code first.",
};

/**
 * "New code session…": the repo (allowed repos only), base branch, engine and model, whether to start
 * from the user's uncommitted changes, and the task. Several engines are listed with whether each can
 * be used here; one that can't is shown with the reason, not hidden.
 */
export default function NewCodeSessionDialog({ onClose, onCreated }: Props) {
  const engines = useCodeEngines();
  const [repos, setRepos] = useState<CodeReposResponse | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [branches, setBranches] = useState<CodeBranchesResponse | null>(null);
  const [base, setBase] = useState("");
  const [engine, setEngine] = useState<CodeEngineId | "">("");
  const [model, setModel] = useState("");
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    codeApi.repos(ctrl.signal).then(
      (r) => {
        setRepos(r);
        const first = r.repos.find((x) => x.available);
        if (first) setRepo((cur) => cur || first.name);
      },
      (e: Error) => { if (!ctrl.signal.aborted) setReposError(e.message); },
    );
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (!repo) return;
    const ctrl = new AbortController();
    setBranches(null);
    codeApi.branches(repo, ctrl.signal).then(
      (b) => {
        setBranches(b);
        setBase(b.defaultBase);
        if (!b.dirty) setIncludeUncommitted(false);
      },
      () => {
        const configured = repos?.repos.find((r) => r.name === repo)?.base ?? "";
        setBranches({ branches: configured ? [configured] : [], defaultBase: configured, dirty: false });
        setBase(configured);
      },
    );
    return () => ctrl.abort();
  }, [repo, repos]);

  const engineList = engines?.engines ?? [];
  useEffect(() => {
    if (engine || engineList.length === 0) return;
    const preferred = engineList.find((e) => e.id === engines?.defaultEngine && e.availability.available) ?? engineList.find((e) => e.availability.available);
    if (preferred) setEngine(preferred.id);
  }, [engine, engineList, engines?.defaultEngine]);
  const chosen = engineList.find((e) => e.id === engine);
  useEffect(() => setModel(""), [engine]);

  const repoInfo = repos?.repos.find((r) => r.name === repo);
  const canStart = Boolean(repoInfo?.available && base && chosen?.availability.available && task.trim()) && !busy;
  const dirty = Boolean(branches?.dirty);
  // The chosen base is a branch with no commits yet (a new repo): the session starts from an empty project.
  const unborn = Boolean(base) && (base === branches?.unbornBranch || Boolean(repoInfo?.unborn && base === repoInfo.base));
  const branchOptions = useMemo(() => {
    const list = branches?.branches ?? [];
    return base && !list.includes(base) ? [base, ...list] : list;
  }, [branches, base]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canStart || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const res = await codeApi.create({
        repo,
        task: task.trim(),
        base,
        engine: chosen.id,
        ...(model ? { model } : {}),
        ...(includeUncommitted ? { includeUncommitted: true } : {}),
      });
      void refreshCodeSessions();
      onCreated(res.chatId, res.session.title);
    } catch (err) {
      setError(err instanceof CodeApiError && err.code && ERROR_TEXT[err.code] ? ERROR_TEXT[err.code]! : err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const noRepos = repos && repos.repos.length === 0;

  return (
    <Modal
      title="New code session"
      description="A coding agent works on its own branch, in a sandboxed copy of the repo. Nothing reaches your checkout until you create a branch from it."
      className="modal--wide code-new-dialog"
      onClose={onClose}
      lockBackdrop
      guardDismiss={task.trim().length > 0 && !busy}
      guardMessage="The task you wrote hasn't been started. If you close now, it will be lost."
      footer={
        <>
          <ModalCancelButton />
          <button type="submit" form="code-new-form" className="btn btn--primary btn--sm" disabled={!canStart}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </>
      }
    >
      <form id="code-new-form" className="modal-form code-form" onSubmit={(e) => void submit(e)}>
        {reposError ? (
          <div className="settings-error" role="alert">Couldn’t load the allowed repos: {reposError}</div>
        ) : noRepos ? (
          <div className="code-empty-repos">
            <p className="code-dialog-text"><strong>No repos are allowed for code sessions yet.</strong> Add one under <code>[[code.repos]]</code> in <code>config.toml</code>; being listed for code search doesn’t allow changes.</p>
            {repos.candidates.length > 0 && (
              <p className="code-form-hint">Known to code search: {repos.candidates.map((c) => c.name).join(", ")}.</p>
            )}
          </div>
        ) : (
          <>
            <div className="code-form-row">
              <div className="code-form-field">
                <label className="form-label" htmlFor="code-new-repo">Repository</label>
                <select id="code-new-repo" className="form-input code-select-input" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos}>
                  {!repos && <option value="">Loading…</option>}
                  {repos?.repos.map((r) => (
                    <option key={r.name} value={r.name} disabled={!r.available}>
                      {r.name}{r.available ? "" : ` (${r.reason ?? "unavailable"})`}
                    </option>
                  ))}
                </select>
                {repoInfo && <span className="code-form-hint code-mono" title={repoInfo.path}>{repoInfo.path}</span>}
              </div>
              <div className="code-form-field">
                <label className="form-label" htmlFor="code-new-base">Base branch</label>
                <select id="code-new-base" className="form-input code-select-input" value={base} onChange={(e) => setBase(e.target.value)} disabled={!branches}>
                  {!branches && <option value="">Loading…</option>}
                  {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <span className="code-form-hint">The session branches off it as <code>rye/…</code>.</span>
              </div>
            </div>
            {unborn && (
              <p className="code-form-hint code-form-note" role="note">
                This repo has no commits yet. The session starts from an empty project; files you haven’t committed (like untracked folders) aren’t visible to the agent.
              </p>
            )}

            <span className="form-label" id="code-new-engine">Engine</span>
            <div className="code-engines" role="radiogroup" aria-labelledby="code-new-engine">
              {engineList.length === 0 && <p className="code-form-hint">Loading engines…</p>}
              {engineList.map((e) => {
                const on = e.id === engine;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!e.availability.available}
                    className={`code-engine${on ? " is-on" : ""}`}
                    onClick={() => setEngine(e.id)}
                  >
                    <span className="code-engine-check" aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</span>
                    <span className="code-engine-text">
                      <span className="code-engine-name">{e.title}{e.id === engines?.defaultEngine && <span className="settings-source">Default</span>}</span>
                      <span className="code-engine-detail">
                        {e.availability.available ? e.availability.account ?? "Ready" : e.availability.reason ?? "Not available here"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {chosen && chosen.models.length > 0 && (
              <>
                <label className="form-label" htmlFor="code-new-model">Model</label>
                <select id="code-new-model" className="form-input code-select-input" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Default{chosen.defaultModel ? ` (${chosen.defaultModel})` : ""}</option>
                  {chosen.models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </>
            )}

            <label className={`code-check${dirty ? "" : " is-disabled"}`}>
              <input type="checkbox" checked={includeUncommitted} disabled={!dirty} onChange={(e) => setIncludeUncommitted(e.target.checked)} />
              <span>
                Include my uncommitted changes
                <span className="code-form-hint">
                  {!dirty
                    ? "Your checkout has no uncommitted changes."
                    : unborn
                      ? "Starts from the files you’ve staged (git add). Untracked files like .env are never copied."
                      : "Starts from your checkout as it is now. Untracked files like .env are never copied."}
                </span>
              </span>
            </label>

            <label className="form-label" htmlFor="code-new-task">Task</label>
            <textarea
              id="code-new-task"
              className="form-input code-textarea"
              rows={5}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="What should the agent do? e.g. Search lags on long chats; find why and fix it, with a test."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </>
        )}
        {error && <div className="settings-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
