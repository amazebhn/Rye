import React, { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, GitBranchPlus, GitMerge } from "lucide-react";
import type { CodeSessionDetail, CodeSessionStatus, CreateBranchResponse, MergeResult } from "@rye/shared";
import { codeApi } from "../../utils/codeApi";
import Modal, { ModalCancelButton } from "../shared/Modal";

const CONFLICT_KIND: Record<string, string> = {
  content: "Both sides changed the same lines",
  add_add: "Added on both sides",
  modify_delete: "Changed on one side, deleted on the other",
  rename: "Renamed differently",
  other: "Conflict",
};

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Create branch: a new `rye/…` branch in the user's repo, the session's commits kept or squashed with a drafted message. */
function CreateBranchDialog({ detail, onClose, onDone }: { detail: CodeSessionDetail; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(detail.branch);
  const [mode, setMode] = useState<"keep" | "squash">("keep");
  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateBranchResponse | null>(null);
  const drafted = useRef(false);

  useEffect(() => {
    if (mode !== "squash" || drafted.current) return;
    drafted.current = true;
    setDrafting(true);
    codeApi.draftBranchMessage(detail.id).then(
      (r) => setMessage((m) => m || r.message),
      () => {},
    ).finally(() => setDrafting(false));
  }, [mode, detail.id]);

  const valid = /^rye\/[\w./-]+$/.test(name.trim()) && (mode === "keep" || message.trim().length > 0);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await codeApi.createBranch(detail.id, { name: name.trim(), mode, ...(mode === "squash" ? { message: message.trim() } : {}) });
      setResult(r);
      if (r.status === "created") onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (result?.status === "created") {
    return (
      <Modal
        title="Branch created"
        className="modal--compact"
        onClose={onClose}
        footer={<button type="button" className="btn btn--primary btn--sm" onClick={onClose} autoFocus>Done</button>}
      >
        <p className="code-dialog-text">
          <code>{result.branch}</code> now points at <code>{result.sha.slice(0, 7)}</code> in <strong>{detail.repo}</strong>, with {result.commits} commit{result.commits === 1 ? "" : "s"} on top of {detail.base}. Your checkout and its other branches weren’t touched.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Create branch"
      description={`A new branch in ${detail.repo}, from this session's work. An existing branch is never changed.`}
      className="modal--compact code-dialog"
      onClose={onClose}
      lockBackdrop
      footer={
        <>
          <ModalCancelButton />
          <button type="submit" form="code-branch-form" className="btn btn--primary btn--sm" disabled={!valid || busy}>
            {busy ? "Creating…" : "Create branch"}
          </button>
        </>
      }
    >
      <form id="code-branch-form" className="modal-form code-form" onSubmit={(e) => void submit(e)}>
        <label className="form-label" htmlFor="code-branch-name">Branch name</label>
        <input id="code-branch-name" className="form-input code-mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" aria-describedby="code-branch-hint" />
        <span id="code-branch-hint" className="code-form-hint">Must start with <code>rye/</code>.</span>
        <span className="form-label" id="code-branch-mode">Commits</span>
        <div className="sop-diff-tabs code-form-tabs" role="radiogroup" aria-labelledby="code-branch-mode">
          {([["keep", "Keep as they are"], ["squash", "Squash into one"]] as const).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className={`sop-diff-tab${mode === value ? " active" : ""}`} onClick={() => setMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {mode === "squash" && (
          <>
            <label className="form-label" htmlFor="code-branch-message">Commit message {drafting && <span className="code-form-hint">drafting…</span>}</label>
            <textarea
              id="code-branch-message"
              className="form-input code-textarea"
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={drafting ? "The model is drafting a message…" : "Describe the change"}
            />
          </>
        )}
        {result?.status === "branch_exists" && (
          <div className="settings-error" role="alert">A branch named <code>{result.branch}</code> already exists. Nothing was written; pick another name.</div>
        )}
        {error && <div className="settings-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}

/** Merge with latest base: merged on objects only onto a new branch; conflicts are listed, nothing is written. */
function MergeDialog({ detail, onClose, onDone }: { detail: CodeSessionDetail; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(`${detail.branch}-merged`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const valid = /^rye\/[\w./-]+$/.test(name.trim());

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await codeApi.merge(detail.id, { name: name.trim() });
      setResult(r);
      if (r.status === "merged") onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (result?.status === "merged") {
    return (
      <Modal title="Merged with latest base" className="modal--compact" onClose={onClose} footer={<button type="button" className="btn btn--primary btn--sm" onClick={onClose} autoFocus>Done</button>}>
        <p className="code-dialog-text">
          <code>{result.branch}</code> holds this session’s work merged with {detail.base} at <code>{result.baseTip.slice(0, 7)}</code> (merge commit <code>{result.sha.slice(0, 7)}</code>). Your checkout wasn’t touched.
        </p>
      </Modal>
    );
  }

  if (result?.status === "conflicts") {
    return (
      <Modal
        title={`${result.conflicts.length} file${result.conflicts.length === 1 ? "" : "s"} conflict with ${detail.base}`}
        description={`Merging ${detail.base} at ${result.baseTip.slice(0, 7)} into this session's work didn't go cleanly. Nothing was written.`}
        className="modal--compact code-dialog"
        onClose={onClose}
        footer={<button type="button" className="btn btn--primary btn--sm" onClick={onClose} autoFocus>Close</button>}
      >
        <ul className="code-conflicts" aria-label="Conflicting files">
          {result.conflicts.map((c) => (
            <li key={c.path} className="code-conflict">
              <span className="code-conflict-path">{c.path}</span>
              <span className="code-conflict-kind">{CONFLICT_KIND[c.kind] ?? c.kind}</span>
              {c.message && <span className="code-conflict-message">{c.message}</span>}
            </li>
          ))}
        </ul>
        <p className="code-form-hint">Resolve them by asking the agent to merge {detail.base} into its branch, then try again. A one-click “Ask the agent to resolve” comes in a later update.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Merge with latest base"
      description={`Merges the newest ${detail.base} into this session's work, onto a new branch. Your checkout and existing branches aren't changed.`}
      className="modal--compact code-dialog"
      onClose={onClose}
      lockBackdrop
      footer={
        <>
          <ModalCancelButton />
          <button type="submit" form="code-merge-form" className="btn btn--primary btn--sm" disabled={!valid || busy}>
            {busy ? "Merging…" : "Merge"}
          </button>
        </>
      }
    >
      <form id="code-merge-form" className="modal-form code-form" onSubmit={(e) => void submit(e)}>
        <label className="form-label" htmlFor="code-merge-name">New branch</label>
        <input id="code-merge-name" className="form-input code-mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" />
        <span className="code-form-hint">Must start with <code>rye/</code>.</span>
        {result?.status === "branch_exists" && (
          <div className="settings-error" role="alert">A branch named <code>{result.branch}</code> already exists. Nothing was written; pick another name.</div>
        )}
        {error && <div className="settings-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}

/**
 * The header's split button: Create branch, with Merge with latest base and Archive in its menu.
 * These are Rye's own actions behind buttons, never agent tools. Desktop only (doc §9).
 */
export default function BranchActions({ detail, status, running, onChanged }: { detail: CodeSessionDetail; status: CodeSessionStatus | null; running: boolean; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"branch" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const branch = (status ?? detail.status).branch;
  const empty = (branch?.stat.files ?? detail.stat.files) === 0 && (branch?.ahead ?? 0) === 0;
  // The base still has no commits (the session started from an empty project): nothing to merge in.
  const mergeBlocked = branch ? branch.baseUnborn === true : detail.baseUnborn === true;
  const mergeReason = mergeBlocked ? `${detail.base} has no commits yet; use Create branch` : undefined;

  useEffect(() => {
    if (!menu) return;
    rootRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (detail.state === "archived") return null;

  const archive = async () => {
    setMenu(false);
    try {
      await codeApi.archive(detail.id);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="code-split" ref={rootRef}>
      <button
        type="button"
        className="code-split-main"
        onClick={() => setDialog("branch")}
        disabled={running || empty}
        title={running ? "Wait for the run to finish" : empty ? "Nothing to put on a branch yet" : "Create a new branch in your repo from this session"}
      >
        <GitBranchPlus size={14} aria-hidden="true" />
        Create branch
      </button>
      <button
        type="button"
        className={`code-split-more${menu ? " is-open" : ""}`}
        onClick={() => setMenu((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="More branch actions"
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {menu && (
        <div className="sidebar-dropdown code-split-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="sidebar-dropdown-item"
            disabled={running || mergeBlocked}
            title={mergeReason}
            onClick={() => { setMenu(false); setDialog("merge"); }}
          >
            <GitMerge size={17} aria-hidden="true" />
            <span>Merge with latest base…</span>
          </button>
          {mergeReason && <p className="code-split-menu-note">{mergeReason}.</p>}
          <div className="sidebar-dropdown-separator" role="separator" />
          <button type="button" role="menuitem" className="sidebar-dropdown-item" disabled={running} onClick={() => void archive()}>
            <Archive size={17} aria-hidden="true" />
            <span>Archive session</span>
          </button>
        </div>
      )}
      {error && (
        <Modal title="That didn't work" description={error} className="modal--compact" onClose={() => setError(null)} footer={<ModalCancelButton label="Close" autoFocus />}>
          {null}
        </Modal>
      )}
      {dialog === "branch" && <CreateBranchDialog detail={detail} onClose={() => setDialog(null)} onDone={onChanged} />}
      {dialog === "merge" && <MergeDialog detail={detail} onClose={() => setDialog(null)} onDone={onChanged} />}
    </div>
  );
}
