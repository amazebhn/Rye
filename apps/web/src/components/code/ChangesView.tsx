import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ExternalLink, FileDiff, MessageSquarePlus, Minus, Plus, RotateCcw, X, Zap } from "lucide-react";
import { openQuickChat } from "../../utils/quickChat";
import type { ChangesSince, CodeChangesResponse, DiffFile, SnapshotRef } from "@rye/shared";
import { codeApi } from "../../utils/codeApi";
import type { QuoteContextRef, QuoteSource } from "../../utils/attachments";
import { quoteRef } from "../../utils/contextRefs";
import Modal, { ModalCancelButton } from "../shared/Modal";
import SelectionActions, { type SelectionAction } from "../shared/SelectionActions";
import CodeMenu from "./CodeMenu";
import DiffView, { readDiffSelection, type DiffMode, type DiffSelection } from "./DiffView";
import { SENSITIVE_LABEL, SENSITIVE_WHY, STATUS_LETTER, STATUS_WORD, shortPath } from "./codeFormat";

/**
 * A modified file's diff is split side by side when the diff has about 900px (and no choice was made):
 * at 1440px with the sidebar open it has 880px, which still gives each side ~390px of code.
 */
const SPLIT_MIN_WIDTH = 860;
const modeKey = (sessionId: string) => `rye.code-diff-mode.${sessionId}`;

function readMode(sessionId: string): DiffMode | null {
  try {
    const v = window.localStorage.getItem(modeKey(sessionId));
    return v === "split" || v === "unified" ? v : null;
  } catch {
    return null;
  }
}

/** Added and deleted files have one side only: split would leave half the width empty. */
function oneSided(f: Pick<DiffFile, "status">) {
  return f.status === "added" || f.status === "deleted";
}
function canStage(f: DiffFile) {
  return f.stage === "unstaged" || f.stage === "untracked" || f.stage === "partly_staged";
}
function canUnstage(f: DiffFile) {
  return f.stage === "staged" || f.stage === "partly_staged";
}
function canDiscard(f: DiffFile) {
  return f.stage !== "committed";
}

export function Stat({ file }: { file: Pick<DiffFile, "additions" | "deletions" | "binary"> }) {
  if (file.binary) return <span className="code-stat code-stat--binary">binary</span>;
  return (
    <span className="code-stat" aria-label={`${file.additions} added, ${file.deletions} removed`}>
      <span className={file.additions > 0 ? "code-stat-add" : "code-stat-none"}>+{file.additions}</span>
      <span className={file.deletions > 0 ? "code-stat-del" : "code-stat-none"}>−{file.deletions}</span>
    </span>
  );
}

function StatusBadge({ file }: { file: Pick<DiffFile, "status"> }) {
  return (
    <span className={`code-file-status code-file-status--${file.status}`} title={STATUS_WORD[file.status]} aria-label={STATUS_WORD[file.status]}>
      {STATUS_LETTER[file.status]}
    </span>
  );
}

/** A path as the list shows it: the folder dim (cut from its start when narrow), the file's name bright. */
function PathText({ path, oldPath }: { path: string; oldPath?: string }) {
  const { dir, name } = shortPath(path);
  return (
    <span className="code-file-path">
      {/* The folder is cut from its start (rtl), its text kept in order inside (ltr). */}
      {dir && <span className="code-file-dir"><bdi dir="ltr">{oldPath ? `${oldPath} → ${dir}` : dir}</bdi></span>}
      <span className="code-file-name">{name}</span>
    </span>
  );
}

function flagText(file: DiffFile): string {
  return file.sensitive.map((s) => `${SENSITIVE_WHY[s.kind]}${s.detail ? ` (${s.detail})` : ""}`).join("\n");
}

function FileRow({ file, selected, onOpen }: { file: DiffFile; selected: boolean; onOpen: () => void }) {
  return (
    <li className="code-file-item" data-code-file={file.path}>
      <button
        type="button"
        className={`code-file-row${selected ? " is-selected" : ""}`}
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <StatusBadge file={file} />
        <PathText path={file.path} oldPath={file.oldPath} />
        {file.sensitive.length > 0 && (
          <span className="code-flag" title={flagText(file)}>
            <AlertTriangle size={13} aria-hidden="true" />
            <span className="diff-sr">{SENSITIVE_LABEL[file.sensitive[0].kind]}: review closely</span>
          </span>
        )}
        <Stat file={file} />
      </button>
    </li>
  );
}

interface Props {
  sessionId: string;
  /** Bumped when the session's state changed (code_status): everything here refetches. */
  version: number;
  base?: string;
  editorUrl?: string;
  /** Phone: the list, then one file with ‹ back; review only (no stage or discard) and unified diffs. */
  phone: boolean;
  archived: boolean;
  since: ChangesSince;
  onSince: (since: ChangesSince) => void;
  /** The file shown (null: none yet; on a wider screen the first file is picked). */
  selected: string | null;
  onSelect: (path: string | null) => void;
  /** Code selected in the diff, quoted with its file, lines and side ("Add to chat"); left out, no bar. */
  onQuote?: (ref: QuoteContextRef) => void;
}

// `describe` and `textOf` are asked about the same range one after the other: read it once.
const readCache = new WeakMap<Range, DiffSelection | null>();
function readOnce(range: Range): DiffSelection | null {
  if (!readCache.has(range)) readCache.set(range, readDiffSelection(range));
  return readCache.get(range) ?? null;
}
const diffSelectionText = (range: Range) => readOnce(range)?.text ?? "";
function describeDiffSelection(range: Range): QuoteSource | null {
  const read = readOnce(range);
  if (!read) return null;
  return { kind: "diff", label: shortPath(read.path).name, path: read.path, lines: read.lines, ...(read.side ? { side: read.side } : {}) };
}

const QUOTE_ACTIONS = (onQuote: (ref: QuoteContextRef) => void): SelectionAction<QuoteSource>[] => [
  { id: "add-to-chat", label: "Add to chat", icon: MessageSquarePlus, onSelect: (sel) => onQuote(quoteRef(sel.text, sel.meta)) },
  { id: "ask-quick-chat", label: "Ask in quick chat", icon: Zap, onSelect: (sel) => openQuickChat({ quote: quoteRef(sel.text, sel.meta) }) },
];

/**
 * The Changes tab: the changed files on the left (one summary line with the compare menu, then status,
 * folder + name and ± counts per row) and the chosen file's diff filling the rest, under a head with its
 * path, Unified/Split, Open in editor, Stage/Unstage and Discard…. On a phone the list comes first and a
 * file opens in its place with ‹ back. Discard asks first and is undoable from the snapshot the server
 * takes before it.
 */
export default function ChangesView({ sessionId, version, base, editorUrl, phone, archived, since, onSince, selected, onSelect, onQuote }: Props) {
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const quoteActions = useMemo(() => (onQuote ? QUOTE_ACTIONS(onQuote) : []), [onQuote]);
  const [changes, setChanges] = useState<CodeChangesResponse | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; file: DiffFile } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  // The layout picked for files with both sides, remembered per session; null: chosen by the room there is.
  const [choice, setChoice] = useState<DiffMode | null>(() => readMode(sessionId));
  // A layout picked for one added or deleted file (not remembered: it says nothing about the others).
  const [fileChoice, setFileChoice] = useState<{ path: string; mode: DiffMode } | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<DiffFile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // Phone: the row a file was opened from, focused again on the way back.
  const returnRef = useRef<string | null>(null);

  useEffect(() => {
    setChoice(readMode(sessionId));
    setFileChoice(null);
  }, [sessionId]);

  // The diff's width decides the default layout; measured before paint so a diff never flips once shown.
  const observer = useRef<ResizeObserver | null>(null);
  const paneRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setPaneWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  useEffect(() => {
    if (archived) return;
    const ctrl = new AbortController();
    codeApi.changes(sessionId, since, ctrl.signal).then(
      (c) => {
        setChanges(c);
        setError(null);
      },
      (e: Error) => { if (!ctrl.signal.aborted) setError(e.message); },
    );
    codeApi.snapshots(sessionId, ctrl.signal).then((s) => setSnapshots(s.snapshots), () => {});
    return () => ctrl.abort();
  }, [sessionId, since, version, reload, archived]);

  const files = changes?.files ?? [];
  const currentFile = selected ? files.find((f) => f.path === selected) ?? null : null;

  // A file no longer changed (discarded, or not in this comparison) is let go of; on a wider screen the
  // first file is shown whenever none is.
  useEffect(() => {
    if (!changes) return;
    if (selected && !changes.files.some((f) => f.path === selected)) onSelect(phone ? null : changes.files[0]?.path ?? null);
    else if (!selected && !phone && changes.files.length > 0) onSelect(changes.files[0].path);
  }, [selected, changes, onSelect, phone]);

  // Phone, back on the list: focus the row the file was opened from.
  useEffect(() => {
    if (selected || !returnRef.current) return;
    const path = returnRef.current;
    returnRef.current = null;
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-code-file="${CSS.escape(path)}"] .code-file-row`)?.focus();
  }, [selected]);

  const diffKey = selected ? `${selected}|${since}|${version}|${reload}` : null;
  useEffect(() => {
    if (!selected || !diffKey) return;
    const ctrl = new AbortController();
    setDiffError(null);
    codeApi.diff(sessionId, selected, since, ctrl.signal).then(
      (d) => setDiff({ key: diffKey, file: d.file }),
      (e: Error) => { if (!ctrl.signal.aborted) setDiffError(e.message); },
    );
    return () => ctrl.abort();
  }, [sessionId, selected, since, diffKey]);

  const stage = useCallback(async (file: DiffFile, staged: boolean) => {
    setBusy(true);
    try {
      setChanges(await codeApi.stage(sessionId, [file.path], staged));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const discard = useCallback(async (file: DiffFile) => {
    setBusy(true);
    try {
      const res = await codeApi.discard(sessionId, [file.path]);
      setChanges(res.changes);
      setNotice(`Discarded ${shortPath(file.path).name}. Turn ${res.snapshot.turn}’s snapshot can bring it back.`);
      setReload((n) => n + 1);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  if (archived) {
    return (
      <div className="code-tab-empty">
        <FileDiff size={20} aria-hidden="true" />
        <p className="artifacts-empty-title">This session is archived</p>
        <p className="artifacts-empty-text">Its workspace was removed. Restore it from Settings → Code to see its changes again.</p>
      </div>
    );
  }

  const open = (path: string) => {
    if (phone) returnRef.current = path;
    onSelect(path);
  };

  const mode: DiffMode = !currentFile || phone
    ? "unified"
    : oneSided(currentFile)
      ? fileChoice?.path === currentFile.path ? fileChoice.mode : "unified"
      : choice ?? (paneWidth >= SPLIT_MIN_WIDTH ? "split" : "unified");
  const setMode = (m: DiffMode) => {
    if (!currentFile) return;
    if (oneSided(currentFile)) {
      setFileChoice({ path: currentFile.path, mode: m });
      return;
    }
    setChoice(m);
    try {
      window.localStorage.setItem(modeKey(sessionId), m);
    } catch {
      // Not remembered in private mode.
    }
  };

  const shownDiff = diff && diff.key === diffKey ? diff.file : null;
  const sinceLabel = since === "base" ? (base ? `since ${base}` : "since the base") : `since turn ${since.slice(5)}`;
  const totals = changes?.stat;

  const compareMenu = (
    <CodeMenu
      label={`Compare with: ${sinceLabel}`}
      title="Compare with…"
      trigger={<><span>{sinceLabel}</span><ChevronDown size={13} aria-hidden="true" /></>}
      triggerClassName="code-compare-btn"
      menuClassName="code-compare-menu"
    >
      {(close) => (
        <>
          <p className="code-menu-heading">Compare with</p>
          {([["base", base ? `Base (${base})` : "Base"], ...snapshots.map((s) => [`turn-${s.turn}`, `End of turn ${s.turn}`])] as Array<[ChangesSince, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={since === value}
              className="sidebar-dropdown-item code-menu-check"
              onClick={() => { close(); onSince(value); }}
            >
              <span>{label}</span>
              {since === value && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </>
      )}
    </CodeMenu>
  );

  const summary = (
    <div className="code-changes-summary">
      <span className="code-changes-total">
        {totals ? (
          <>
            <span>{totals.files} file{totals.files === 1 ? "" : "s"}</span>
            <span className="code-changes-sep" aria-hidden="true">·</span>
            <Stat file={{ ...totals, binary: false }} />
          </>
        ) : null}
      </span>
      {compareMenu}
    </div>
  );

  if (error && !changes) return <p className="diff-note" role="alert">{error}</p>;
  if (!changes) return <p className="diff-note">Loading changes…</p>;
  if (files.length === 0) {
    return (
      <div className="code-changes code-changes--empty">
        {summary}
        <div className="code-tab-empty">
          <FileDiff size={20} aria-hidden="true" />
          <p className="artifacts-empty-title">No changes {sinceLabel}</p>
          <p className="artifacts-empty-text">Files the agent edits in its workspace are listed here for review.</p>
        </div>
      </div>
    );
  }

  const list = (
    <nav className="code-files" aria-label="Changed files">
      {summary}
      <ul className="code-file-list">
        {files.map((f) => (
          <FileRow key={f.path} file={f} selected={!phone && f.path === selected} onOpen={() => open(f.path)} />
        ))}
      </ul>
      {phone && <p className="code-phone-note">Creating branches, merging and discarding need a larger screen.</p>}
    </nav>
  );

  const pathTitle = currentFile ? (currentFile.oldPath ? `${currentFile.oldPath} → ${currentFile.path}` : currentFile.path) : "";
  const item = currentFile && (
    <section className="code-diff-pane" ref={paneRef} aria-label={`Changes to ${currentFile.path}`}>
      {phone && (
        <button type="button" className="artifacts-back code-item-back" onClick={() => onSelect(null)} aria-label="Back to the changed files">
          <ChevronLeft size={16} aria-hidden="true" />
          <span>Changes</span>
        </button>
      )}
      <div className="code-item-head">
        <span className="code-item-path" title={pathTitle}>
          <StatusBadge file={currentFile} />
          <PathText path={currentFile.path} oldPath={currentFile.oldPath} />
          {phone && <Stat file={currentFile} />}
        </span>
        {!phone && (
          <span className="code-item-actions">
            <div className="sop-diff-tabs code-seg" role="group" aria-label="Diff layout">
              {(["unified", "split"] as const).map((m) => (
                <button key={m} type="button" className={`sop-diff-tab${mode === m ? " active" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {m === "unified" ? "Unified" : "Split"}
                </button>
              ))}
            </div>
            {editorUrl && (
              <a className="code-btn" href={`${editorUrl.replace(/\/$/, "")}/${currentFile.path}`} title="Open this file in your editor">
                <ExternalLink size={13} aria-hidden="true" />
                <span>Open in editor</span>
              </a>
            )}
            {canStage(currentFile) && (
              <button type="button" className="code-btn" disabled={busy} onClick={() => void stage(currentFile, true)} title="Stage this file in the session's workspace">
                <Plus size={13} aria-hidden="true" />
                <span>Stage</span>
              </button>
            )}
            {canUnstage(currentFile) && (
              <button type="button" className="code-btn" disabled={busy} onClick={() => void stage(currentFile, false)} title="Unstage this file">
                <Minus size={13} aria-hidden="true" />
                <span>Unstage</span>
              </button>
            )}
            {canDiscard(currentFile) && (
              <button type="button" className="code-btn code-btn--danger" disabled={busy} onClick={() => setConfirmDiscard(currentFile)} title="Drop this file's uncommitted changes">
                <RotateCcw size={13} aria-hidden="true" />
                <span>Discard…</span>
              </button>
            )}
          </span>
        )}
      </div>
      {currentFile.sensitive.length > 0 && (
        <ul className="code-flags" aria-label="Review flags">
          {currentFile.sensitive.map((s, i) => (
            <li key={i} className="code-flags-item">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                <strong>{SENSITIVE_WHY[s.kind]}</strong>
                {s.detail && <span className="code-flags-detail"> · {s.detail}</span>}
              </span>
            </li>
          ))}
          {currentFile.resolvedHosts && currentFile.resolvedHosts.length > 0 && (
            <li className="code-flags-item code-flags-hosts">
              <span className="code-flags-detail">Packages from: {currentFile.resolvedHosts.join(", ")}</span>
            </li>
          )}
        </ul>
      )}
      <div className="code-diff-body" ref={diffBodyRef}>
        {diffError ? (
          <p className="diff-note" role="alert">{diffError}</p>
        ) : shownDiff ? (
          <DiffView file={shownDiff} mode={mode} />
        ) : (
          <p className="diff-note">Loading diff…</p>
        )}
      </div>
      {onQuote && shownDiff && (
        <SelectionActions
          containerRef={diffBodyRef}
          actions={quoteActions}
          describe={describeDiffSelection}
          textOf={diffSelectionText}
          label="Diff selection"
        />
      )}
    </section>
  );

  return (
    <div className={`code-changes${phone ? " code-changes--phone" : ""}`} ref={rootRef}>
      {phone ? item || list : (
        <>
          {list}
          {item || <div className="code-diff-pane" ref={paneRef} />}
        </>
      )}
      {notice && (
        <div className="artifacts-notice code-notice" role="status">
          <span className="artifacts-notice-text">{notice}</span>
          <button type="button" className="artifacts-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={13} aria-hidden="true" /></button>
        </div>
      )}
      {confirmDiscard && (
        <Modal
          title={`Discard changes to ${shortPath(confirmDiscard.path).name}?`}
          description="Its uncommitted changes in the session's workspace are dropped. Rye takes a snapshot first, so this can be undone from it."
          className="modal--compact"
          onClose={() => setConfirmDiscard(null)}
          footer={
            <>
              <ModalCancelButton autoFocus />
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={() => {
                  const f = confirmDiscard;
                  setConfirmDiscard(null);
                  void discard(f);
                }}
              >
                Discard changes
              </button>
            </>
          }
        >
          {null}
        </Modal>
      )}
    </div>
  );
}
