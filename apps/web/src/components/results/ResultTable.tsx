import React, { useEffect, useState } from "react";
import { PanelRight, Table2 } from "lucide-react";
import ResultDataGrid from "./ResultDataGrid";
import TableFrame from "../shared/TableFrame";
import { useArtifactsPanel } from "../artifacts/ArtifactsPanelContext";

export interface StoredResult {
  id: string;
  createdAt: number;
  source: string;
  label: string;
  kind: "table" | "text";
  columns: string[];
  rows: Record<string, unknown>[];
}

const PAGE_SIZE = 50;
const FULLSCREEN_PAGE_SIZE = 500;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function toCsv(result: StoredResult): string {
  const escape = (v: unknown) => {
    const value = cell(v);
    const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safeValue.replace(/"/g, '""')}"`;
  };
  const header = result.columns.map(escape).join(",");
  const body = result.rows.map((r) => result.columns.map((c) => escape(r[c])).join(","));
  return [header, ...body].join("\n");
}

export function downloadText(contents: string, filename: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ResultContent({ result, rows, fullscreen = false }: {
  result: StoredResult;
  rows: Record<string, unknown>[];
  fullscreen?: boolean;
}) {
  return (
    <div className={fullscreen ? "result-table-scroll result-table-scroll--fullscreen" : "result-table-scroll"}>
      {result.kind === "text" ? (
        <pre className="result-table-text">{rows.map((row) => cell(row.line)).join("\n")}</pre>
      ) : (
        <table className="result-table-grid">
          <thead>
            <tr>{result.columns.map((column) => <th key={column}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {result.columns.map((column) => <td key={column}>{cell(row[column])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function FullscreenResultContent({ result }: { result: StoredResult }) {
  const [visible, setVisible] = useState(FULLSCREEN_PAGE_SIZE);

  if (result.kind === "table") {
    return <ResultDataGrid columns={result.columns} rows={result.rows} pageSize={FULLSCREEN_PAGE_SIZE} />;
  }

  const rows = result.rows.slice(0, visible);

  return (
    <div className="result-table-fullscreen-page">
      <ResultContent result={result} rows={rows} fullscreen />
      {visible < result.rows.length && (
        <button
          type="button"
          className="result-table-more result-table-more--fullscreen"
          onClick={() => setVisible((value) => value + FULLSCREEN_PAGE_SIZE)}
        >
          Show {Math.min(FULLSCREEN_PAGE_SIZE, result.rows.length - visible).toLocaleString()} more
          <span className="result-table-more-sub"> ({(result.rows.length - visible).toLocaleString()} remaining)</span>
        </button>
      )}
    </div>
  );
}

interface ResultTableProps {
  resultId: string;
  sessionId: string;
  openFullscreen?: boolean;
  onClose?: () => void;
}

export default function ResultTable({ resultId, sessionId, openFullscreen = false, onClose }: ResultTableProps) {
  const [result, setResult] = useState<StoredResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const panel = useArtifactsPanel();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/result/${resultId}?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "expired" : `HTTP ${r.status}`);
        return r.json() as Promise<StoredResult>;
      })
      .then((d) => { if (!cancelled) setResult(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [resultId, sessionId]);

  function download() {
    if (!result) return;
    downloadText(toCsv(result), `${result.id}.csv`, "text/csv;charset=utf-8");
  }

  if (!result) {
    const status = error === "expired"
      ? "This result has expired and is no longer available."
      : error
        ? `Couldn't load result: ${error}`
        : "Loading result…";
    const note = <div className="result-table-note">{status}</div>;
    if (!openFullscreen) return note;
    return (
      <TableFrame
        title={resultId}
        initialFullscreen
        fullscreenOnly
        onFullscreenClose={onClose}
        fullscreenContent={note}
      >
        {note}
      </TableFrame>
    );
  }

  const rows = result.rows.slice(0, visible);

  return (
    <TableFrame
      title={result.label}
      onCopy={() => navigator.clipboard.writeText(toCsv(result))}
      onDownload={download}
      copyLabel="Copy as CSV"
      downloadLabel="Download CSV"
      fullscreenContent={<FullscreenResultContent result={result} />}
      initialFullscreen={openFullscreen}
      fullscreenOnly={openFullscreen}
      onFullscreenClose={onClose}
    >
      <div className="result-table">
        <div className="result-table-header">
          <Table2 size={13} />
          <span className="result-table-count">
            {result.rows.length.toLocaleString()} {result.kind === "text" ? "line" : "row"}
            {result.rows.length === 1 ? "" : "s"}
          </span>
          <code className="result-table-label" title={result.label}>{result.label}</code>
          {panel && !openFullscreen && (
            <button
              type="button"
              className="result-table-open"
              onClick={() => panel.openResult(result.id)}
              title="Show in Artifacts"
              aria-label="Show in Artifacts"
            >
              <PanelRight size={13} aria-hidden="true" />
            </button>
          )}
        </div>

        <ResultContent result={result} rows={rows} />

        {visible < result.rows.length && (
          <button className="result-table-more" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, result.rows.length - visible)} more
            <span className="result-table-more-sub"> ({result.rows.length - visible} remaining)</span>
          </button>
        )}
      </div>
    </TableFrame>
  );
}
