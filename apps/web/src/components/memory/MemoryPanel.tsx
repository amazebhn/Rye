import React, { useEffect, useState } from "react";
import { RefreshCw, Search, Brain, BookMarked, Plus, Trash2, X, Pencil, Sparkles, Database } from "lucide-react";
import { useMemories } from "../../contexts/MemoryContext";
import type { KnowledgeDoc, KnowledgeSearchHit, Memory, MemoryKind } from "../../contexts/MemoryContext";

type MemoryTab = "facts" | "knowledge";

function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "Fact",
  acronym: "Acronym",
  term: "Term",
};

// ── Add-memory inline form ─────────────────────────────────────────────────
function AddMemoryForm({ onClose }: { onClose: () => void }) {
  const { saveMemory } = useMemories();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!key.trim() || !value.trim() || saving) return;
    setSaving(true);
    try {
      await saveMemory({
        key: key.trim(),
        value: value.trim(),
        kind,
        category: category.trim() || (kind === "fact" ? "general" : "glossary"),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-form" style={{ padding: "12px 16px", borderBottom: "1px solid var(--main-border)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select
          className="form-input"
          style={{ flex: "0 0 115px" }}
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
          aria-label="Entry type"
        >
          <option value="fact">Fact</option>
          <option value="acronym">Acronym</option>
          <option value="term">Term</option>
        </select>
        <input
          className="form-input"
          style={{ flex: "1 1 160px" }}
          placeholder={kind === "acronym" ? "acronym (e.g. OMS)" : kind === "term" ? "term (e.g. cold_path)" : "key (e.g. redis_host)"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
        />
        <input className="form-input" style={{ flex: "0 1 140px" }} placeholder="category" value={category} onChange={(e) => setCategory(e.target.value)} />
        <input className="form-input" style={{ flex: "0 1 160px" }} placeholder="tags (comma-sep)" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <input
        className="form-input"
        style={{ marginTop: 8 }}
        placeholder={kind === "fact" ? "value / the fact to remember" : "definition / meaning"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <div className="modal-actions" style={{ marginTop: 8 }}>
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={onClose}>Cancel</button>
        <button className="btn btn--primary btn--sm" onClick={() => void submit()} disabled={!key.trim() || !value.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Knowledge note inline form (create or edit) ────────────────────────────
function KnowledgeForm({
  initial,
  onClose,
}: {
  initial?: KnowledgeDoc;
  onClose: () => void;
}) {
  const { createKnowledge, updateKnowledge } = useMemories();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [tags, setTags] = useState(initial?.tags.join(", ") ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        content: content.trim(),
        category: category.trim() || "general",
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      };
      if (initial) await updateKnowledge(initial.id, payload);
      else await createKnowledge(payload);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-form" style={{ padding: "12px 16px", borderBottom: "1px solid var(--main-border)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="form-input"
          style={{ flex: "2 1 220px" }}
          placeholder="Title (e.g. Payments Service Architecture)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <input
          className="form-input"
          style={{ flex: "0 1 140px" }}
          placeholder="category (e.g. services)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <input
          className="form-input"
          style={{ flex: "1 1 160px" }}
          placeholder="tags (comma-sep)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </div>
      <textarea
        className="form-input"
        style={{ marginTop: 8, minHeight: 130, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
        placeholder="Markdown notes about systems, schemas, topologies, or quirks. Automatically chunked & embedded for RAG retrieval…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="modal-actions" style={{ marginTop: 8 }}>
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={onClose}>Cancel</button>
        <button className="btn btn--primary btn--sm" onClick={() => void submit()} disabled={!title.trim() || !content.trim() || saving}>
          {saving ? "Indexing…" : initial ? "Save & Re-index" : "Save & Index"}
        </button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export default function MemoryPanel() {
  const {
    memories,
    memoriesLoading,
    refreshMemories,
    deleteMemory,
    knowledgeDocs,
    knowledgeLoading,
    embeddingStatus,
    refreshKnowledge,
    deleteKnowledge,
    searchKnowledge,
    reindexKnowledge,
  } = useMemories();

  const [tab, setTab] = useState<MemoryTab>("facts");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryKind | "all">("all");
  const [adding, setAdding] = useState(false);
  const [editingDoc, setEditingDoc] = useState<KnowledgeDoc | null>(null);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);

  // Live RAG search state
  const [ragHits, setRagHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [ragSearching, setRagSearching] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  useEffect(() => {
    if (memories === null) void refreshMemories();
    if (knowledgeDocs === null) void refreshKnowledge();
  }, []);

  // Debounced live hybrid search when typing in the Knowledge tab
  useEffect(() => {
    if (tab !== "knowledge") return;
    const q = query.trim();
    if (!q) {
      setRagHits(null);
      setRagSearching(false);
      return;
    }
    let cancelled = false;
    setRagSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const hits = await searchKnowledge(q);
        if (!cancelled) setRagHits(hits);
      } finally {
        if (!cancelled) setRagSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tab, query, searchKnowledge]);

  async function handleReindex() {
    if (reindexing) return;
    setReindexing(true);
    try {
      await reindexKnowledge();
    } finally {
      setReindexing(false);
    }
  }

  const filteredMemories = (memories ?? []).filter((m) => {
    const kind: MemoryKind = m.kind ?? "fact";
    if (kindFilter !== "all" && kind !== kindFilter) return false;
    if (query.trim() === "") return true;
    const q = query.toLowerCase();
    return (
      m.key.toLowerCase().includes(q) ||
      m.value.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  // Group facts by category
  const byCategory = new Map<string, Memory[]>();
  for (const m of filteredMemories) {
    const cat = m.category || "general";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(m);
  }
  const groups = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const embeddingBadge =
    embeddingStatus?.available && embeddingStatus.model
      ? `${embeddingStatus.provider === "ollama" ? "Ollama" : "Copilot"} · ${embeddingStatus.model}`
      : "Keyword search (FTS5)";

  const isLoading = tab === "facts" ? memoriesLoading : knowledgeLoading;

  return (
    <div className="sop-panel">
      <div className="sop-panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h2 className="sop-panel-title">Memory</h2>
          <div style={{ display: "inline-flex", gap: 4, background: "var(--main-surface)", padding: 3, borderRadius: 8, border: "1px solid var(--main-border)" }}>
            <button
              className={`btn btn--sm ${tab === "facts" ? "btn--primary" : "btn--ghost"}`}
              onClick={() => { setTab("facts"); setAdding(false); setEditingDoc(null); }}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Brain size={12} />
              <span>Facts & Glossary</span>
              {memories !== null && <span style={{ opacity: 0.75, fontSize: 11 }}>({memories.length})</span>}
            </button>
            <button
              className={`btn btn--sm ${tab === "knowledge" ? "btn--primary" : "btn--ghost"}`}
              onClick={() => { setTab("knowledge"); setAdding(false); setEditingDoc(null); }}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <BookMarked size={12} />
              <span>Knowledge Base</span>
              {knowledgeDocs !== null && <span style={{ opacity: 0.75, fontSize: 11 }}>({knowledgeDocs.length})</span>}
            </button>
          </div>
        </div>

        <div className="sop-panel-toolbar">
          <div className="sop-search-wrap">
            <Search size={13} className="sop-search-icon" />
            <input
              className="sop-search-input"
              placeholder={tab === "facts" ? "Filter facts & glossary…" : "Semantic + keyword search…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {tab === "knowledge" && (
            <button
              className="icon-btn faint"
              onClick={() => void handleReindex()}
              disabled={reindexing}
              title={`Re-index & re-embed all knowledge notes (${embeddingBadge})`}
            >
              <Sparkles size={13} className={reindexing ? "spin" : ""} />
            </button>
          )}
          <button
            className="icon-btn faint"
            onClick={() => void (tab === "facts" ? refreshMemories() : refreshKnowledge())}
            disabled={isLoading}
            title="Refresh"
          >
            <RefreshCw size={13} className={isLoading ? "spin" : ""} />
          </button>
          <div className="sop-toolbar-divider" />
          <button
            className="sop-new-btn"
            onClick={() => { setEditingDoc(null); setAdding((v) => !v); }}
          >
            {adding ? <X size={13} /> : <Plus size={13} />}
            {adding ? "Close" : tab === "facts" ? "New Fact" : "New Note"}
          </button>
        </div>
      </div>

      {/* Sub-bar: type filter for Facts, embedding status for Knowledge */}
      {tab === "facts" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderBottom: "1px solid var(--main-border)", fontSize: 12 }}>
          <span style={{ color: "var(--main-fg-faint)", marginRight: 4 }}>Always in prompt:</span>
          {(["all", "fact", "acronym", "term"] as const).map((k) => (
            <button
              key={k}
              className={`btn btn--sm ${kindFilter === k ? "btn--primary" : "btn--ghost"}`}
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={() => setKindFilter(k)}
            >
              {k === "all" ? "All" : `${KIND_LABELS[k]}s`}
            </button>
          ))}
        </div>
      )}

      {tab === "knowledge" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px", borderBottom: "1px solid var(--main-border)", fontSize: 12, color: "var(--main-fg-faint)" }}>
          <span>Retrieved automatically via hybrid RAG on relevant turns — keeps system prompts lean.</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
            <Database size={12} />
            {embeddingBadge}
          </span>
        </div>
      )}

      {adding && tab === "facts" && <AddMemoryForm onClose={() => setAdding(false)} />}
      {adding && tab === "knowledge" && <KnowledgeForm onClose={() => setAdding(false)} />}
      {editingDoc && tab === "knowledge" && (
        <KnowledgeForm initial={editingDoc} onClose={() => setEditingDoc(null)} />
      )}

      <div className="sop-panel-body">
        {/* ── TAB 1: FACTS & GLOSSARY ──────────────────────────────────────── */}
        {tab === "facts" && (
          <>
            {memoriesLoading && <div className="sop-panel-empty">Loading…</div>}

            {!memoriesLoading && (memories?.length ?? 0) === 0 && (
              <div className="sop-panel-zero">
                <Brain size={32} className="sop-panel-zero-icon" />
                <p>No facts or glossary entries yet.</p>
                <p className="sop-panel-zero-sub">
                  Add short ground-truth facts, acronyms, or custom terms here so every chat and agent knows them automatically.
                </p>
              </div>
            )}

            {!memoriesLoading && (memories?.length ?? 0) > 0 && filteredMemories.length === 0 && (
              <div className="sop-panel-empty">No entries match "{query}".</div>
            )}

            {!memoriesLoading && groups.map(([cat, items]) => (
              <div key={cat} style={{ marginBottom: 18 }}>
                <div className="sidebar-time-group" style={{ textTransform: "capitalize" }}>{cat}</div>
                <table className="sop-table">
                  <tbody>
                    {items.map((m) => {
                      const kind: MemoryKind = m.kind ?? "fact";
                      return (
                        <tr key={m.id} className="sop-table-row">
                          <td className="sop-table-td" style={{ width: 84, verticalAlign: "top" }}>
                            <span className="sop-card-tag" style={{ fontSize: 10, textTransform: "capitalize" }}>
                              {KIND_LABELS[kind]}
                            </span>
                          </td>
                          <td className="sop-table-td" style={{ width: "22%", fontWeight: 600, verticalAlign: "top" }}>
                            {m.key}
                            {m.tags.length > 0 && (
                              <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {m.tags.map((t) => (
                                  <span key={t} className="sop-card-tag" style={{ fontSize: 10 }}>{t}</span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="sop-table-td" style={{ verticalAlign: "top" }}>{m.value}</td>
                          <td className="sop-table-td" style={{ width: 110, whiteSpace: "nowrap", color: "var(--main-fg-faint)", verticalAlign: "top" }}>
                            {formatDate(m.updated_at)}
                          </td>
                          <td className="sop-table-td" style={{ width: 32, textAlign: "right", verticalAlign: "top" }}>
                            <button
                              className="icon-btn faint"
                              title="Forget this entry"
                              onClick={() => void deleteMemory(m.key)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}

        {/* ── TAB 2: KNOWLEDGE BASE (RAG) ──────────────────────────────────── */}
        {tab === "knowledge" && (
          <>
            {query.trim() !== "" && (
              <div style={{ marginBottom: 20 }}>
                <div className="sidebar-time-group">
                  {ragSearching ? "Searching…" : `RAG matches (${ragHits?.length ?? 0})`}
                </div>
                {!ragSearching && ragHits && ragHits.length === 0 && (
                  <div className="sop-panel-empty">No matching knowledge chunks for "{query}".</div>
                )}
                {!ragSearching && ragHits && ragHits.length > 0 && (
                  <table className="sop-table">
                    <tbody>
                      {ragHits.map((hit, i) => (
                        <tr key={`${hit.doc_id}:${i}`} className="sop-table-row">
                          <td className="sop-table-td" style={{ width: "24%", verticalAlign: "top" }}>
                            <div style={{ fontWeight: 600 }}>{hit.title}</div>
                            {hit.heading && (
                              <div style={{ fontSize: 11, color: "var(--main-fg-faint)", marginTop: 2 }}>{hit.heading}</div>
                            )}
                            <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                              <span className="sop-card-tag" style={{ fontSize: 10 }}>{hit.match_type}</span>
                              <span className="sop-card-tag" style={{ fontSize: 10 }}>{hit.category}</span>
                            </div>
                          </td>
                          <td className="sop-table-td" style={{ verticalAlign: "top", whiteSpace: "pre-wrap", fontSize: 12.5 }}>
                            {hit.snippet.length > 420 ? `${hit.snippet.slice(0, 420)}…` : hit.snippet}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {knowledgeLoading && <div className="sop-panel-empty">Loading…</div>}

            {!knowledgeLoading && (knowledgeDocs?.length ?? 0) === 0 && (
              <div className="sop-panel-zero">
                <BookMarked size={32} className="sop-panel-zero-icon" />
                <p>No system knowledge notes yet.</p>
                <p className="sop-panel-zero-sub">
                  Add architecture notes, service mappings, or database docs here — or let agents save learnings with <code>save_knowledge_tool</code>.
                </p>
              </div>
            )}

            {!knowledgeLoading && (knowledgeDocs?.length ?? 0) > 0 && query.trim() === "" && (
              <table className="sop-table">
                <tbody>
                  {(knowledgeDocs ?? []).map((doc) => {
                    const expanded = expandedDocId === doc.id;
                    return (
                      <tr key={doc.id} className="sop-table-row">
                        <td
                          className="sop-table-td"
                          style={{ width: "26%", fontWeight: 600, verticalAlign: "top", cursor: "pointer" }}
                          onClick={() => setExpandedDocId(expanded ? null : doc.id)}
                        >
                          <div>{doc.title}</div>
                          <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap", fontWeight: 400 }}>
                            <span className="sop-card-tag" style={{ fontSize: 10 }}>{doc.category}</span>
                            <span className="sop-card-tag" style={{ fontSize: 10 }}>{doc.source}</span>
                            <span className="sop-card-tag" style={{ fontSize: 10 }}>
                              {doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"}
                            </span>
                            {doc.tags.map((t) => (
                              <span key={t} className="sop-card-tag" style={{ fontSize: 10 }}>{t}</span>
                            ))}
                          </div>
                        </td>
                        <td
                          className="sop-table-td"
                          style={{ verticalAlign: "top", whiteSpace: "pre-wrap", cursor: "pointer", fontSize: 12.5 }}
                          onClick={() => setExpandedDocId(expanded ? null : doc.id)}
                        >
                          {expanded || doc.content.length <= 220
                            ? doc.content
                            : `${doc.content.slice(0, 220)}…`}
                        </td>
                        <td className="sop-table-td" style={{ width: 110, whiteSpace: "nowrap", color: "var(--main-fg-faint)", verticalAlign: "top" }}>
                          {formatDate(doc.updated_at)}
                        </td>
                        <td className="sop-table-td" style={{ width: 64, textAlign: "right", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          <button
                            className="icon-btn faint"
                            title="Edit note"
                            onClick={() => { setAdding(false); setEditingDoc(doc); }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="icon-btn faint"
                            title="Delete note"
                            onClick={() => void deleteKnowledge(doc.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
