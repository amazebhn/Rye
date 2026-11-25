import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronLeft, Copy, Download, FileCheck2, FilePlus2, FileText, Layers, Maximize2, Pin, PinOff, Search, Table2, X } from "lucide-react";
import type { Artifact, StoredResultSummary } from "../../utils/types";
import { useIsMobile } from "../../utils/viewport";
import ResultDataGrid from "../results/ResultDataGrid";
import { FullscreenResultContent, downloadText, toCsv, type StoredResult } from "../results/ResultTable";
import TableFrame from "../shared/TableFrame";
import { ArtifactIcon } from "./ArtifactCard";
import ArtifactFileView from "./ArtifactFileView";
import type { ChatArtifacts } from "./useChatArtifacts";

export type ArtifactsView =
  | { kind: "list" }
  | { kind: "file"; id: string; version?: number }
  | { kind: "result"; id: string };

const DAY = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 7 * DAY;

function ago(ts: number): string {
  const elapsed = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "7d left" / "3h left": the row's short form of expiresIn. */
function expiresShort(result: { createdAt: number; expiresAt?: number }): string {
  const left = (result.expiresAt ?? result.createdAt + RESULT_RETENTION_MS) - Date.now();
  if (left <= 60 * 60 * 1000) return "<1h left";
  if (left < DAY) return `${Math.floor(left / (60 * 60 * 1000))}h left`;
  return `${Math.max(1, Math.round(left / DAY))}d left`;
}

function expiresIn(result: { createdAt: number; expiresAt?: number }): string {
  const left = (result.expiresAt ?? result.createdAt + RESULT_RETENTION_MS) - Date.now();
  if (left <= 60 * 60 * 1000) return "expires within the hour";
  if (left < DAY) {
    const hours = Math.floor(left / (60 * 60 * 1000));
    return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.max(1, Math.round(left / DAY));
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

function sourceLabel(source: string): string {
  return source.replace(/_tool$/, "").replace(/_/g, " ");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shapeLabel(r: { kind: "table" | "text"; rowCount: number; columns: string[] }): string {
  if (r.kind === "text") return `${r.rowCount.toLocaleString()} line${r.rowCount === 1 ? "" : "s"}`;
  const cols = r.columns.length;
  return `${r.rowCount.toLocaleString()} row${r.rowCount === 1 ? "" : "s"} × ${cols} col${cols === 1 ? "" : "s"}`;
}

/** POST /result/:id/save: the result as a CSV file in the same chat (it then no longer expires). */
async function saveResultAsFile(sessionId: string, resultId: string): Promise<{ artifact: Artifact; existing: boolean }> {
  const res = await fetch(`/result/${encodeURIComponent(resultId)}/save?session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = (await res.json().catch(() => ({}))) as { artifact?: Artifact; existing?: boolean; error?: string };
  if (!res.ok || !body.artifact) throw new Error(body.error ?? `Couldn’t save the file (HTTP ${res.status}).`);
  return { artifact: body.artifact, existing: !!body.existing };
}

type Notice = { tone: "ok" | "error"; text: string; file?: Artifact; token: number };

function NoticeBar({ notice, onOpenFile, onDismiss }: { notice: Notice; onOpenFile: (a: Artifact) => void; onDismiss: () => void }) {
  useEffect(() => {
    if (notice.tone === "error") return;
    const t = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(t);
  }, [notice, onDismiss]);
  return (
    <div className={`artifacts-notice artifacts-notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      {notice.tone === "ok" && <Check size={14} aria-hidden="true" />}
      <span className="artifacts-notice-text">{notice.text}</span>
      {notice.file && (
        <button type="button" className="artifacts-notice-action" onClick={() => onOpenFile(notice.file!)}>
          Open
        </button>
      )}
      <button type="button" className="artifacts-notice-close" onClick={onDismiss} aria-label="Dismiss">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function savedText(saved: { artifact: Artifact; existing: boolean }): string {
  return saved.existing ? `Already saved as ${saved.artifact.filename}` : `Saved as ${saved.artifact.filename}`;
}

// ── One stored result: inline grid, full screen, save as file ─────────────────

function ResultItemView({ sessionId, resultId, summary, savedFile, onSaved, onError, onOpenFile }: {
  sessionId: string;
  resultId: string;
  summary?: StoredResultSummary;
  savedFile?: Artifact;
  onSaved: (saved: { artifact: Artifact; existing: boolean }) => void;
  onError: (message: string) => void;
  onOpenFile: (file: Artifact) => void;
}) {
  const [result, setResult] = useState<StoredResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/result/${encodeURIComponent(resultId)}?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This result has expired and is no longer available." : `Couldn’t load this result (HTTP ${r.status}).`);
        return r.json() as Promise<StoredResult>;
      })
      .then((d) => { if (!cancelled) setResult(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [resultId, sessionId]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const shown = result ?? summary;
  const label = shown ? oneLine(shown.label) || shown.id : resultId;
  const meta = shown && {
    source: sourceLabel(shown.source),
    shape: result ? shapeLabel({ kind: result.kind, rowCount: result.rows.length, columns: result.columns }) : summary ? shapeLabel(summary) : "",
    created: ago(shown.createdAt),
    expires: expiresIn({ createdAt: shown.createdAt, expiresAt: summary?.expiresAt }),
  };

  const save = () => {
    setSaving(true);
    saveResultAsFile(sessionId, resultId)
      .then(onSaved, (e: Error) => onError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="artifact-view">
      <div className="artifact-view-head">
        <span className="artifact-card-icon">
          {shown?.kind === "text" ? <FileText size={16} aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />}
        </span>
        <div className="artifact-sheet-heading">
          <h3 className="artifact-sheet-title artifact-view-query" title={shown?.label}>{label}</h3>
          {/* Header and toolbar are drawn from the first frame (empty while loading), so nothing below moves. */}
          <span className="artifact-card-meta artifact-view-meta artifact-view-meta-line">
            {meta && (
              <>
                <span>{meta.source}</span>
                {meta.shape && <span>{meta.shape}</span>}
                <span>{meta.created}</span>
                <span className="artifacts-expiry">{meta.expires}</span>
              </>
            )}
          </span>
        </div>
      </div>
      <div className="artifact-sheet-toolbar">
      {result && (
        <>
          {savedFile ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpenFile(savedFile)} title={`Saved as ${savedFile.filename}`}>
              <FileCheck2 size={14} aria-hidden="true" />
              Open saved file
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={save} disabled={saving} title="Keep it as a CSV file in this chat, so it doesn’t expire">
              <FilePlus2 size={14} aria-hidden="true" />
              {saving ? "Saving…" : "Save as file"}
            </button>
          )}
          <span className="artifact-sheet-spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setFullscreen(true)} title="Full screen">
            <Maximize2 size={14} aria-hidden="true" />
            <span className="artifact-btn-label">Full screen</span>
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void navigator.clipboard.writeText(toCsv(result)).then(() => setCopied(true), () => {})}
            title="Copy as CSV"
            aria-label={copied ? "Copied" : "Copy as CSV"}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span className="artifact-btn-label">{copied ? "Copied" : "Copy"}</span>
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => downloadText(toCsv(result), `${result.id}.csv`, "text/csv;charset=utf-8")}
            title="Download CSV"
            aria-label="Download CSV"
          >
            <Download size={14} aria-hidden="true" />
            <span className="artifact-btn-label">Download</span>
          </button>
        </>
      )}
      </div>
      <div className="artifact-sheet-body artifact-sheet-body--grid">
        {error ? (
          <p className="artifact-sheet-state">{error}</p>
        ) : !result ? (
          <p className="artifact-sheet-state">Loading…</p>
        ) : result.kind === "table" ? (
          <ResultDataGrid columns={result.columns} rows={result.rows} pageSize={200} />
        ) : (
          <pre className="artifact-sheet-pre">{result.rows.map((row) => String(row.line ?? "")).join("\n")}</pre>
        )}
      </div>
      {result && fullscreen && (
        <TableFrame
          title={result.label}
          fullscreenOnly
          initialFullscreen
          onFullscreenClose={() => setFullscreen(false)}
          onCopy={() => navigator.clipboard.writeText(toCsv(result))}
          onDownload={() => downloadText(toCsv(result), `${result.id}.csv`, "text/csv;charset=utf-8")}
          copyLabel="Copy as CSV"
          downloadLabel="Download CSV"
          fullscreenContent={<FullscreenResultContent result={result} />}
        >
          {null}
        </TableFrame>
      )}
    </div>
  );
}

// ── The list ──────────────────────────────────────────────────────────────────

function FileRow({ file, onOpen }: { file: Artifact; onOpen: () => void }) {
  const latest = file.versions[file.versions.length - 1];
  return (
    <div className="artifacts-row" data-artifact-key={`file:${file.id}`}>
      <button type="button" className="artifacts-row-main" onClick={onOpen}>
        <span className={`artifacts-row-icon artifact-card-icon--${file.format}`}>
          <ArtifactIcon format={file.format} size={15} />
        </span>
        <span className="artifacts-row-text">
          <span className="artifacts-row-title">{file.title}</span>
          {/* One quiet line, like the app's other lists; the size is in the file's own view. */}
          <span className="artifacts-row-meta">
            {file.filename !== file.title && <span className="artifacts-row-shrink">{file.filename}</span>}
            {latest && latest.version > 1 && <span>v{latest.version}</span>}
            <span>{ago(file.updatedAt)}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

/** The file "Save as file" made from this result, if any (the server names it <stem>-<result id>.csv). */
function savedFileFor(files: Artifact[], resultId: string): Artifact | undefined {
  const suffix = `-${resultId.replace(/^res_/, "")}.csv`;
  return files.find((f) => f.format === "csv" && f.filename.endsWith(suffix));
}

function ResultRow({ result, saving, savedFile, onOpen, onSave, onOpenFile }: {
  result: StoredResultSummary;
  saving: boolean;
  savedFile?: Artifact;
  onOpen: () => void;
  onSave: () => void;
  onOpenFile: (file: Artifact) => void;
}) {
  const label = oneLine(result.label) || result.id;
  return (
    <div className="artifacts-row" data-artifact-key={`result:${result.id}`}>
      <button type="button" className="artifacts-row-main" onClick={onOpen} title={result.label}>
        <span className="artifacts-row-icon">
          {result.kind === "text" ? <FileText size={15} aria-hidden="true" /> : <Table2 size={15} aria-hidden="true" />}
        </span>
        <span className="artifacts-row-text">
          <span className="artifacts-row-title artifacts-row-title--query">{label}</span>
          {/* One line: where it came from, its shape, and when it goes (or that it was saved as a file). */}
          <span className="artifacts-row-meta">
            <span className="artifacts-row-shrink">{sourceLabel(result.source)}</span>
            <span>{shapeLabel(result)}</span>
            {savedFile ? <span>Saved</span> : <span className="artifacts-expiry" title={expiresIn(result)}>{expiresShort(result)}</span>}
          </span>
        </span>
      </button>
      {savedFile ? (
        <button
          type="button"
          className="artifacts-row-action"
          onClick={() => onOpenFile(savedFile)}
          title={`Open ${savedFile.filename}`}
          aria-label={`Open the saved file ${savedFile.filename}`}
        >
          <FileCheck2 size={15} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="artifacts-row-action"
          onClick={onSave}
          disabled={saving}
          title="Save as file (a CSV in this chat that doesn’t expire)"
          aria-label={`Save ${label} as a file`}
        >
          <FilePlus2 size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function matchesQuery(needle: string, values: string[]): boolean {
  return values.some((v) => v.toLowerCase().includes(needle));
}

function ListView({ data, query, onQuery, savingId, onOpen, onSave, searchRef }: {
  data: ChatArtifacts;
  query: string;
  onQuery: (q: string) => void;
  savingId: string | null;
  onOpen: (view: ArtifactsView) => void;
  onSave: (id: string) => void;
  searchRef: React.RefObject<HTMLInputElement>;
}) {
  const needle = query.trim().toLowerCase();
  const files = useMemo(
    () => (needle ? data.files.filter((f) => matchesQuery(needle, [f.title, f.filename, f.format])) : data.files),
    [data.files, needle],
  );
  const results = useMemo(
    () => (needle ? data.results.filter((r) => matchesQuery(needle, [r.label, r.id, r.source, sourceLabel(r.source), ...r.columns])) : data.results),
    [data.results, needle],
  );
  const total = data.files.length + data.results.length;

  if (total === 0) {
    return (
      <div className="artifacts-empty">
        <span className="artifacts-empty-icon"><Layers size={20} aria-hidden="true" /></span>
        {data.error ? (
          <>
            <p className="artifacts-empty-title">Couldn’t load this chat’s artifacts.</p>
            <button type="button" className="btn btn--sm btn--ghost" onClick={data.refresh}>Try again</button>
          </>
        ) : (
          <>
            <p className="artifacts-empty-title">Nothing here yet</p>
            <p className="artifacts-empty-text">Files the agent writes in this chat, and query results too large to show in a reply, will be listed here.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="artifacts-list">
      <label className="artifacts-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              onQuery("");
            }
          }}
          placeholder="Search files and results"
          aria-label="Search artifacts"
        />
      </label>
      {needle && files.length === 0 && results.length === 0 && (
        <p className="artifacts-state">No files or results match “{query.trim()}”.</p>
      )}
      {files.length > 0 && (
        <section className="artifacts-section" aria-labelledby="artifacts-files-heading">
          <h3 className="artifacts-section-heading" id="artifacts-files-heading">
            Files <span className="artifacts-section-count">{files.length}</span>
          </h3>
          {files.map((f) => (
            <FileRow key={f.id} file={f} onOpen={() => onOpen({ kind: "file", id: f.id })} />
          ))}
        </section>
      )}
      {results.length > 0 && (
        <section className="artifacts-section" aria-labelledby="artifacts-results-heading">
          <h3 className="artifacts-section-heading" id="artifacts-results-heading">
            Query results <span className="artifacts-section-count">{results.length}</span>
          </h3>
          {results.map((r) => (
            <ResultRow
              key={r.id}
              result={r}
              saving={savingId === r.id}
              savedFile={savedFileFor(data.files, r.id)}
              onOpen={() => onOpen({ kind: "result", id: r.id })}
              onSave={() => onSave(r.id)}
              onOpenFile={(file) => onOpen({ kind: "file", id: file.id })}
            />
          ))}
        </section>
      )}
    </div>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────

const PIN_STORAGE_KEY = "rye.artifacts-pinned";
/** Docking the panel beside the chat needs room for both: from this width up. */
const PIN_QUERY = "(min-width: 1024px)";

export function readArtifactsPinned(): boolean {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberArtifactsPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(PIN_STORAGE_KEY, pinned ? "1" : "0");
  } catch {
    // Private mode: the choice lasts this page only.
  }
}

function subscribePinQuery(onChange: () => void): () => void {
  const media = window.matchMedia(PIN_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** True while the window is wide enough to dock the panel beside the chat. */
export function useCanPinArtifacts(): boolean {
  return useSyncExternalStore(subscribePinQuery, () => window.matchMedia(PIN_QUERY).matches, () => false);
}

interface Props {
  /** Undefined only while pinned on a chat that has no session yet (it shows the empty state). */
  sessionId: string | undefined;
  data: ChatArtifacts;
  view: ArtifactsView;
  onViewChange: (view: ArtifactsView) => void;
  onClose: () => void;
  /** Docked beside the chat; otherwise a floating card over it (a full-screen sheet on a phone). */
  pinned: boolean;
  /** Absent when the window is too narrow to dock it. */
  onTogglePin?: () => void;
  /** Pinned and on its way out: it slides shut (artifacts.css) before App unmounts it. */
  leaving?: boolean;
}

/**
 * A chat's files and stored results: a floating card over the chat, or docked beside it when pinned
 * (a full-screen sheet on a phone). A searchable list, and each item opened in place with a way back.
 * Its width, header and body frame never change while it loads or moves between list and item.
 */
export default function ArtifactsPanel({ sessionId, data, view, onViewChange, onClose, pinned, onTogglePin, leaving = false }: Props) {
  const isMobile = useIsMobile();
  const floating = !pinned || isMobile;
  const rootRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  // The row an item was opened from, focused again on the way back.
  const returnKeyRef = useRef<string | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  // Closing hands focus back to the header button, when focus was in here.
  const close = useCallback(() => {
    const inside = rootRef.current?.contains(document.activeElement);
    onClose();
    if (inside) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".chat-header-artifacts-btn")?.focus());
  }, [onClose]);

  const viewKey = view.kind === "list" ? "list" : `${view.kind}:${view.id}:${view.kind === "file" ? view.version ?? "" : ""}`;
  useEffect(() => {
    if (view.kind === "list" && returnKeyRef.current) {
      const row = rootRef.current?.querySelector<HTMLButtonElement>(`[data-artifact-key="${returnKeyRef.current}"] .artifacts-row-main`);
      returnKeyRef.current = null;
      if (row) return void row.focus();
    }
    navRef.current?.focus();
  }, [viewKey]);

  // Floating (not on a phone), the card ends 8px above the chat composer so it never covers the send button.
  // The composer grows with its text and attachment chips, and can be swapped or missing (loading), so its top
  // is re-read whenever it resizes, the window resizes, or the chat's content changes; the card's height is the
  // only thing that follows. Without a composer the card keeps its default 12px inset (CSS fallback).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !floating || isMobile) return;
    let composer: Element | null = null;
    let frame = 0;
    let last = "";
    const resize = new ResizeObserver(() => measure());
    function measure() {
      const found = document.querySelector(".main .input-bar-wrap");
      if (found !== composer) {
        if (composer) resize.unobserve(composer);
        composer = found;
        if (composer) resize.observe(composer);
      }
      const value = composer ? `${Math.max(12, Math.round(window.innerHeight - composer.getBoundingClientRect().top + 8))}px` : "";
      if (value === last) return;
      last = value;
      if (value) root!.style.setProperty("--artifacts-float-bottom", value);
      else root!.style.removeProperty("--artifacts-float-bottom");
    }
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    const main = document.querySelector(".main");
    const mutations = new MutationObserver(schedule);
    if (main) mutations.observe(main, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      root.style.removeProperty("--artifacts-float-bottom");
    };
  }, [floating, isMobile]);

  // A floating panel closes on Escape and on a click outside it; a docked one only with ✕ (closing it resizes
  // the chat). Escape is left to anything else that wants it: a dialog over the panel (the full-screen table),
  // a field that used it (search), or focus somewhere else (the composer).
  useEffect(() => {
    if (!floating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".table-fullscreen, .modal-overlay")) return;
      const active = document.activeElement;
      const here = rootRef.current?.contains(active);
      const idle = !active || active === document.body || (active as HTMLElement).closest?.(".chat-header-artifacts-btn, .artifact-card");
      if (!here && !idle) return;
      e.preventDefault();
      close();
    };
    // Not on clicks that open something in it (header button, message cards) or happen over it (dialogs, menus).
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || rootRef.current?.contains(target)) return;
      if (target.closest?.(".chat-header-artifacts-btn, .artifact-card, .result-table-open, .table-fullscreen, .modal-overlay, [role=menu], [role=listbox], [role=dialog]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, floating, onClose]);

  const open = (next: ArtifactsView) => {
    if (next.kind !== "list") returnKeyRef.current = `${next.kind}:${next.id}`;
    onViewChange(next);
  };

  const onSaved = useCallback((saved: { artifact: Artifact; existing: boolean }) => {
    setNotice({ tone: "ok", text: savedText(saved), file: saved.artifact, token: Date.now() });
    data.refresh();
  }, [data]);
  const onSaveError = useCallback((message: string) => setNotice({ tone: "error", text: message, token: Date.now() }), []);

  const saveFromList = (id: string) => {
    if (!sessionId) return;
    setSavingId(id);
    saveResultAsFile(sessionId, id)
      .then(onSaved, (e: Error) => onSaveError(e.message))
      .finally(() => setSavingId(null));
  };

  const loaded = data.sessionId === sessionId;
  const summary = view.kind === "result" ? data.results.find((r) => r.id === view.id) : undefined;
  const back = () => onViewChange({ kind: "list" });

  return (
    <aside
      ref={rootRef}
      className={`artifact-sheet artifacts-panel ${floating ? "artifact-sheet--floating" : "artifact-sheet--pinned"}${leaving && !floating ? " is-leaving" : ""}`}
      id="artifacts-panel"
      aria-label="Artifacts"
      role={isMobile ? "dialog" : "complementary"}
      aria-modal={isMobile ? true : undefined}
    >
      <header className="artifacts-panel-header">
        {view.kind !== "list" ? (
          <button ref={navRef} type="button" className="artifacts-back" onClick={back} aria-label="Back to all artifacts">
            <ChevronLeft size={16} aria-hidden="true" />
            <span>Artifacts</span>
          </button>
        ) : (
          <>
            {isMobile && (
              <button ref={navRef} type="button" className="artifacts-back artifacts-back--icon" onClick={close} aria-label="Close Artifacts">
                <ChevronLeft size={19} aria-hidden="true" />
              </button>
            )}
            <h2 className="artifacts-panel-title">
              Artifacts
            </h2>
          </>
        )}
        {!isMobile && (
          <span className="artifacts-panel-actions">
            {onTogglePin && (
              <button
                type="button"
                className={`artifacts-icon-btn${pinned ? " active" : ""}`}
                onClick={onTogglePin}
                title={pinned ? "Unpin: float over the chat" : "Pin beside the chat"}
                aria-label={pinned ? "Unpin Artifacts" : "Pin Artifacts beside the chat"}
                aria-pressed={pinned}
              >
                {pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
              </button>
            )}
            <button
              ref={view.kind === "list" ? navRef : undefined}
              type="button"
              className="artifacts-icon-btn"
              onClick={close}
              title={floating ? "Close (Esc)" : "Close"}
              aria-label="Close Artifacts"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        )}
      </header>
      {view.kind === "list" ? (
        loaded ? (
          <ListView
            data={data}
            query={query}
            onQuery={setQuery}
            savingId={savingId}
            onOpen={open}
            onSave={saveFromList}
            searchRef={searchRef}
          />
        ) : (
          <div className="artifacts-list">
            <p className="artifacts-state">Loading…</p>
          </div>
        )
      ) : !sessionId ? null : view.kind === "file" ? (
        <ArtifactFileView key={`${view.id}:${view.version ?? ""}`} id={view.id} sessionId={sessionId} version={view.version} />
      ) : (
        <ResultItemView
          key={view.id}
          sessionId={sessionId}
          resultId={view.id}
          summary={summary}
          savedFile={savedFileFor(data.files, view.id)}
          onSaved={onSaved}
          onError={onSaveError}
          onOpenFile={(file) => open({ kind: "file", id: file.id })}
        />
      )}
      {notice && (
        <NoticeBar
          key={notice.token}
          notice={notice}
          onDismiss={dismissNotice}
          onOpenFile={(file) => {
            setNotice(null);
            open({ kind: "file", id: file.id });
          }}
        />
      )}
    </aside>
  );
}
