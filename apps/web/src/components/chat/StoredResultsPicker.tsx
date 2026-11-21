import React, { useEffect, useMemo, useRef, useState } from "react";
import { Database, FileText, Search, Table2 } from "lucide-react";

interface StoredResultSummary {
  id: string;
  createdAt: number;
  source: string;
  label: string;
  kind: "table" | "text";
  columns: string[];
  rowCount: number;
}

interface Props {
  sessionId?: string;
  onSelect: (id: string) => void;
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sourceLabel(source: string): string {
  return source.replace(/_tool$/, "").replace(/_/g, " ");
}

export default function StoredResultsPicker({ sessionId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StoredResultSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (!sessionId) {
      setResults([]);
      setLoading(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void fetch(`/result?session_id=${encodeURIComponent(sessionId)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ results?: StoredResultSummary[] }>;
      })
      .then((data) => {
        if (!cancelled) setResults(Array.isArray(data.results) ? data.results : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => { cancelled = true; };
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return results;
    return results.filter((result) =>
      [result.id, result.label, result.source, ...result.columns]
        .some((value) => value.toLowerCase().includes(needle))
    );
  }, [query, results]);

  return (
    <div className="stored-results-picker" ref={rootRef}>
      <button
        type="button"
        className={`chat-header-db-btn${open ? " active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Stored queries and results"
        aria-label="Browse stored queries and results"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Database size={16} />
      </button>

      {open && (
        <section className="stored-results-popover" role="dialog" aria-label="Stored queries and results">
          <div className="stored-results-heading">
            <div>
              <strong>Stored results</strong>
              <span>Open results from this chat</span>
            </div>
            <span className="stored-results-count">{results.length}</span>
          </div>
          <label className="stored-results-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search labels, IDs, columns…"
              aria-label="Search stored results"
            />
          </label>

          <div className="stored-results-list">
            {loading ? (
              <div className="stored-results-state">Loading stored results…</div>
            ) : error ? (
              <div className="stored-results-state">Couldn’t load stored results.</div>
            ) : filtered.length === 0 ? (
              <div className="stored-results-state">{query ? "No matching results." : "No stored results yet."}</div>
            ) : filtered.map((result) => (
              <button
                type="button"
                className="stored-result-option"
                key={result.id}
                onClick={() => {
                  onSelect(result.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="stored-result-icon">
                  {result.kind === "table" ? <Table2 size={15} /> : <FileText size={15} />}
                </span>
                <span className="stored-result-content">
                  <span className="stored-result-label">{result.label || result.id}</span>
                  <span className="stored-result-meta">
                    <code>{result.id}</code>
                    <span>{result.rowCount.toLocaleString()} {result.kind === "text" ? "lines" : "rows"}</span>
                    <span>{relativeTime(result.createdAt)}</span>
                  </span>
                  <span className="stored-result-source">{sourceLabel(result.source)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="stored-results-footer">Select a result to open it · expires after 7 days</div>
        </section>
      )}
    </div>
  );
}