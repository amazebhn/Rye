import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  RefreshCw,
  Search,
  LayoutGrid,
  List,
  ArrowLeft,
  BookOpen,
  ChevronUp,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  FilePlus,
  Download,
  Trash2,
  Copy,
  Check,
  XCircle,
} from "lucide-react";
import AiMark from "../shared/AiMark";
import { useSops } from "../../contexts/SopContext";
import type { SOP } from "../../contexts/SopContext";
import SopChatSheet, { type PendingDraft } from "./SopChatSheet";
import NewSopModal from "./NewSopModal";
import SidebarButton from "../shell/SidebarButton";
import MobileListControls, { PullToRefresh, SheetOptions } from "../shared/MobileListControls";
import { useIsMobile } from "../../utils/viewport";

type ViewMode = "card" | "list";
type SortField = "title" | "updated_at" | "created_at";
type SortDir = "asc" | "desc";

// ── Unified diff ──────────────────────────────────────────────────────────
type DiffLine =
  | { type: "same";   oldLine: number; newLine: number; text: string }
  | { type: "add";    oldLine: null;   newLine: number; text: string }
  | { type: "remove"; oldLine: number; newLine: null;   text: string };

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // Remove single trailing empty string caused by a terminal newline
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length, n = b.length;
  // LCS DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  // Backtrack to full diff (all lines, no filtering)
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: "same", oldLine: i, newLine: j, text: a[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", oldLine: null, newLine: j, text: b[j - 1] }); j--;
    } else {
      result.unshift({ type: "remove", oldLine: i, newLine: null, text: a[i - 1] }); i--;
    }
  }
  return result;
}

/** Strip leading headings that repeat the SOP title from rendered markdown */
function stripLeadingTitle(content: string, title: string): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const headingText = line.replace(/^#+\s+/, "").trim();
    if (headingText === title.trim()) { i++; continue; }
    break;
  }
  return lines.slice(i).join("\n").trimStart();
}

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Three-dot context menu ────────────────────────────────────────────────
interface SopMenuProps {
  sop: SOP;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function SopMenu({ sop, onRename, onDelete, onDuplicate }: SopMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div
      ref={ref}
      className="sop-menu-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn sop-menu-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Options"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="sop-menu-dropdown">
          <button className="sop-menu-item" onClick={() => { setOpen(false); onRename(); }}>
            <Pencil size={12} /> Rename
          </button>
          <button className="sop-menu-item" onClick={() => { setOpen(false); onDuplicate(); }}>
            <Copy size={12} /> Duplicate
          </button>
          <button className="sop-menu-item sop-menu-item--danger" onClick={() => { setOpen(false); onDelete(); }}>
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────
interface SopPanelProps {
  /** The SOP the address names (/sops/<id>), or null for the list. Left out, the panel keeps its own. */
  openId?: number | null;
  /** Called when the user opens an SOP or goes back to the list; `replace` when the address named one that doesn't exist. */
  onOpenChange?: (id: number | null, replace?: boolean) => void;
}

export default function SopPanel({ openId, onOpenChange }: SopPanelProps = {}) {
  const { sops, sopsLoading, refreshSops, deleteSop, renameSop, duplicateSop } = useSops();
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [activeSop, setActiveSop] = useState<SOP | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [approving, setApproving] = useState(false);
  const [diffMode, setDiffMode] = useState<"diff" | "preview">("diff");
  const [creating, setCreating] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (sops === null) void refreshSops();
  }, []);

  useEffect(() => {
    if (renamingId !== null) renameRef.current?.focus();
  }, [renamingId]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  }

  function showSop(sop: SOP | null) { setActiveSop(sop); setChatOpen(false); setPendingDraft(null); }
  function openSop(sop: SOP) { showSop(sop); onOpenChange?.(sop.id); }
  function closeSop() { showSop(null); onOpenChange?.(null); }

  // Follow the address: /sops/<id> shows that SOP, /sops the list.
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeSop?.id ?? null;
  useEffect(() => {
    if (openId === undefined || openId === activeIdRef.current) return;
    if (openId === null) {
      showSop(null);
      return;
    }
    let cancelled = false;
    void fetch(`/sop/${openId}`)
      .then((r) => (r.ok ? (r.json() as Promise<SOP>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((sop) => { if (!cancelled) showSop(sop); })
      .catch(() => {
        if (cancelled) return;
        showSop(null);
        onOpenChange?.(null, true);
      });
    return () => { cancelled = true; };
  }, [openId]);

  function handleCreated(sop: SOP) {
    void refreshSops();
    setCreating(false);
    openSop(sop);
  }

  function exportSop(sop: SOP) {
    const blob = new Blob([sop.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sop.title.replace(/[^a-z0-9]+/gi, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = async () => {
      const text = reader.result as string;
      let title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      let content = text;
      if (file.name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(text) as { title?: string; content?: string };
          if (parsed.title) title = parsed.title;
          if (parsed.content) content = parsed.content;
        } catch { /* use raw text */ }
      }
      const res = await fetch("/sop/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sop_id: number };
        await refreshSops();
        const sopRes = await fetch(`/sop/${data.sop_id}`);
        if (sopRes.ok) openSop((await sopRes.json()) as SOP);
      }
    };
    reader.readAsText(file);
  }

  async function approveDraft() {
    if (!pendingDraft || approving) return;
    setApproving(true);
    try {
      const res = await fetch(`/sop/${pendingDraft.sop_id}/approve-draft`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { sop: SOP };
        setActiveSop(data.sop);
        setPendingDraft(null);
        await refreshSops();
      }
    } finally {
      setApproving(false);
    }
  }

  async function discardDraft() {
    if (!pendingDraft) return;
    await fetch(`/sop/${pendingDraft.sop_id}/draft`, { method: "DELETE" });
    setPendingDraft(null);
  }

  function startRename(sop: SOP) { setRenamingId(sop.id); setRenameValue(sop.title); }

  async function commitRename() {
    if (renamingId !== null && renameValue.trim()) {
      await renameSop(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }

  const filtered = (sops ?? []).filter(
    (s) =>
      query.trim() === "" ||
      s.title.toLowerCase().includes(query.toLowerCase()) ||
      s.content.toLowerCase().includes(query.toLowerCase())
  ).sort((a, b) => {
    let cmp = 0;
    if (sortField === "title") cmp = a.title.localeCompare(b.title);
    else {
      const da = new Date(a[sortField] ?? 0).getTime();
      const db = new Date(b[sortField] ?? 0).getTime();
      cmp = da - db;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  // Phone width: the toolbar's view toggle, sort and import move to the filter sheet (MobileListControls).
  const sortChanged = sortField !== "title" || sortDir !== "asc";
  const mobileFilters = (
    <>
      <SheetOptions
        label="View"
        value={viewMode}
        onChange={setViewMode}
        options={[
          { value: "card", label: "Cards", icon: LayoutGrid },
          { value: "list", label: "List", icon: List },
        ]}
      />
      <SheetOptions
        label="Sort by"
        value={sortField}
        onChange={setSortField}
        options={[
          { value: "title", label: "Name" },
          { value: "updated_at", label: "Updated" },
          { value: "created_at", label: "Created" },
        ]}
      />
      <SheetOptions
        label="Order"
        value={sortDir}
        onChange={setSortDir}
        options={[
          { value: "asc", label: sortField === "title" ? "A to Z" : "Oldest first" },
          { value: "desc", label: sortField === "title" ? "Z to A" : "Newest first" },
        ]}
      />
    </>
  );

  // ── Detail view ───────────────────────────────────────────────────────
  if (activeSop) {
    const diff = pendingDraft ? lineDiff(pendingDraft.original_content, pendingDraft.proposed_content) : null;

    return (
      <div className="sop-panel">
        <div className="sop-panel-header sop-panel-header--detail">
          <SidebarButton />
          <button
            className="sop-header-icon-btn"
            onClick={closeSop}
            title="Back to SOPs"
            aria-label="Back to SOPs"
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="sop-panel-title sop-detail-title">{activeSop.title}</h2>
          {pendingDraft && <div className="sop-draft-badge">AI draft ready</div>}
          <button
            className="sop-header-icon-btn"
            onClick={() => exportSop(activeSop)}
            title="Export as Markdown"
            aria-label="Export as Markdown"
          >
            <Download size={16} />
          </button>
          <button
            className={`sop-ai-btn${chatOpen ? " sop-ai-btn--active" : ""}`}
            onClick={() => setChatOpen((v) => !v)}
            title="Chat with SOP creator agent"
          >
            <AiMark size={14} />
            {chatOpen ? "Hide AI Editor" : "Edit with AI"}
          </button>
        </div>

        <div className="sop-detail-split">
          <div className="sop-detail-body">
            {pendingDraft && diff ? (
              <div className="sop-detail-diff-view">
                <div className="sop-detail-diff-toolbar">
                  <div className="sop-diff-tabs" role="tablist" aria-label="Draft view">
                    <button
                      role="tab"
                      aria-selected={diffMode === "diff"}
                      className={`sop-diff-tab${diffMode === "diff" ? " active" : ""}`}
                      onClick={() => setDiffMode("diff")}
                    >Changes</button>
                    <button
                      role="tab"
                      aria-selected={diffMode === "preview"}
                      className={`sop-diff-tab${diffMode === "preview" ? " active" : ""}`}
                      onClick={() => setDiffMode("preview")}
                    >Preview</button>
                  </div>
                  <div className="sop-diff-spacer" />
                  <button className="sop-diff-approve-btn" onClick={() => void approveDraft()} disabled={approving}>
                    <Check size={13} /> {approving ? "Saving…" : "Approve"}
                  </button>
                  <button className="sop-diff-discard-btn" onClick={() => void discardDraft()}>
                    <XCircle size={13} /> Discard
                  </button>
                </div>

                {diffMode === "diff" ? (
                  <div className="sop-diff-body">
                    {diff.map((line, i) => (
                      <div key={i} className={`sop-diff-line sop-diff-line--${line.type}`}>
                        <span className="sop-diff-ln sop-diff-ln--old">
                          {line.oldLine ?? ""}
                        </span>
                        <span className="sop-diff-ln sop-diff-ln--new">
                          {line.newLine ?? ""}
                        </span>
                        <span className="sop-diff-gutter">
                          {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
                        </span>
                        <span className="sop-diff-text">{line.text || "\u00a0"}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="sop-detail-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {pendingDraft.proposed_content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            ) : (
              <div className="sop-detail-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {stripLeadingTitle(activeSop.content, activeSop.title)}
                </ReactMarkdown>
              </div>
            )}
          </div>

          {chatOpen && (
            <SopChatSheet
              sop={activeSop}
              onClose={() => setChatOpen(false)}
              onDraftReady={(draft) => { setPendingDraft(draft); setDiffMode("diff"); }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── List / Card view ──────────────────────────────────────────────────
  return (
    <div className="sop-panel">
      {creating && (
        <NewSopModal
          onCreated={handleCreated}
          onClose={() => setCreating(false)}
          onImport={() => {
            // Open the chooser inside the click (browsers only allow it during a user gesture), then close.
            importRef.current?.click();
            setCreating(false);
          }}
        />
      )}
      <div className="sop-panel-header">
        <SidebarButton />
        <h2 className="sop-panel-title">SOPs</h2>
        {isMobile ? (
          <>
            <button type="button" className="sop-new-btn mlc-primary" onClick={() => setCreating(true)}>
              <FilePlus size={15} aria-hidden="true" />
              New SOP
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".md,.json"
              style={{ display: "none" }}
              onChange={handleImport}
            />
          </>
        ) : (
        <div className="sop-panel-toolbar">
          <div className="sop-search-wrap">
            <Search size={13} className="sop-search-icon" />
            <input
              className="sop-search-input"
              placeholder="Search SOPs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className={`icon-btn sop-view-btn${viewMode === "card" ? " active" : " faint"}`}
            onClick={() => setViewMode("card")}
            title="Card view"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            className={`icon-btn sop-view-btn${viewMode === "list" ? " active" : " faint"}`}
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List size={14} />
          </button>
          <button
            className="icon-btn faint"
            onClick={() => void refreshSops()}
            disabled={sopsLoading}
            title="Refresh"
          >
            <RefreshCw size={13} className={sopsLoading ? "spin" : ""} />
          </button>
          <div className="sop-toolbar-divider" />
          {/* Import is an option in the New SOP dialog; this is the file chooser it opens. */}
          <input
            ref={importRef}
            type="file"
            accept=".md,.json"
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <button
            className="sop-new-btn"
            onClick={() => setCreating(true)}
          >
            <FilePlus size={13} />
            New SOP
          </button>
        </div>
        )}
      </div>

      <div className="sop-panel-body">
        <PullToRefresh onRefresh={refreshSops} />
        {sopsLoading && <div className="sop-panel-empty">Loading…</div>}

        {!sopsLoading && (sops?.length ?? 0) === 0 && (
          <div className="sop-panel-zero">
            <BookOpen size={32} className="sop-panel-zero-icon" />
            <p>No SOPs saved yet.</p>
            <p className="sop-panel-zero-sub">
              Ask the agent to document a process and it will appear here.
            </p>
          </div>
        )}

        {!sopsLoading && (sops?.length ?? 0) > 0 && filtered.length === 0 && (
          <div className="sop-panel-empty">No SOPs match "{query}".</div>
        )}

        {!sopsLoading && filtered.length > 0 && (
          viewMode === "card" ? (
            <div className="sop-card-grid">
              {filtered.map((sop) => (
                <div key={sop.id} className="sop-card" onClick={() => openSop(sop)}>
                  <div className="sop-card-header">
                    {renamingId !== null && renamingId === sop.id ? (
                      <input
                        ref={renameRef}
                        className="sop-inline-rename"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenamingId(null);
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="sop-card-title">{sop.title}</div>
                    )}
                    <SopMenu
                      sop={sop}
                      onRename={() => startRename(sop)}
                      onDelete={() => void deleteSop(sop.id)}
                      onDuplicate={() => void duplicateSop(sop.id)}
                    />
                  </div>
                  <div className="sop-card-preview">
                    {sop.content.replace(/^#+\s.*/gm, "").trim().slice(0, 120)}
                    {sop.content.length > 120 ? "…" : ""}
                  </div>
                  <div className="sop-card-footer">
                    <span className="sop-card-date">{formatDate(sop.updated_at)}</span>
                    <span className="sop-card-ai-hint">
                      <AiMark size={11} className="sop-card-ai-icon" />
                      Edit with AI
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table className="sop-table">
              <thead>
                <tr>
                  <th className="sop-table-th sop-table-th--name" onClick={() => toggleSort("title")}>
                    <span>Name</span>
                    <span className="sop-table-sort-icon">
                      {sortField === "title" ? (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronUp size={11} className="sop-table-sort-idle" />}
                    </span>
                  </th>
                  <th className="sop-table-th" onClick={() => toggleSort("updated_at")}>
                    <span>Updated</span>
                    <span className="sop-table-sort-icon">
                      {sortField === "updated_at" ? (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronUp size={11} className="sop-table-sort-idle" />}
                    </span>
                  </th>
                  <th className="sop-table-th sop-table-col--secondary" onClick={() => toggleSort("created_at")}>
                    <span>Created</span>
                    <span className="sop-table-sort-icon">
                      {sortField === "created_at" ? (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronUp size={11} className="sop-table-sort-idle" />}
                    </span>
                  </th>
                  <th className="sop-table-th sop-table-th--action" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((sop) => (
                  <tr key={sop.id} className="sop-table-row" onClick={() => openSop(sop)}>
                    <td className="sop-table-td sop-table-td--name">
                      <BookOpen size={12} className="sop-table-icon" />
                      {renamingId !== null && renamingId === sop.id ? (
                        <input
                          ref={renameRef}
                          className="sop-inline-rename sop-inline-rename--table"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => void commitRename()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                            e.stopPropagation();
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        sop.title
                      )}
                    </td>
                    <td className="sop-table-td">{formatDate(sop.updated_at)}</td>
                    <td className="sop-table-td sop-table-col--secondary">{formatDate(sop.created_at)}</td>
                    <td className="sop-table-td sop-table-td--action" onClick={(e) => e.stopPropagation()}>
                      <SopMenu
                        sop={sop}
                        onRename={() => startRename(sop)}
                        onDelete={() => void deleteSop(sop.id)}
                        onDuplicate={() => void duplicateSop(sop.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        <MobileListControls
          query={query}
          onQueryChange={setQuery}
          searchLabel="Search SOPs"
          searchPlaceholder="Search SOPs…"
          filters={mobileFilters}
          activeFilters={sortChanged ? 1 : 0}
          onResetFilters={() => { setSortField("title"); setSortDir("asc"); }}
        />
      </div>
    </div>
  );
}
