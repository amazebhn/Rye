import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download } from "lucide-react";
import type { Artifact } from "../../utils/types";
import CodeBlock from "../chat/CodeBlock";
import { ChartSessionContext } from "../chat/ChartBlock";
import { ArtifactIcon, CopyArtifactButton, OpenInBrowserLink, artifactUrl, fetchArtifactContent, formatBytes } from "./ArtifactCard";

const MAX_CSV_ROWS = 2000;

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > MAX_CSV_ROWS) break;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function CsvPreview({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <p className="artifact-sheet-state">Empty file.</p>;
  const [header, ...body] = rows;
  const shown = body.slice(0, MAX_CSV_ROWS);
  return (
    <>
      {/* md-body: drawn like a table in a reply or a Markdown file. */}
      <div className="artifact-sheet-table md-body">
        <table className="md-table-grid">
          <thead><tr>{header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => <tr key={i}>{header.map((_, j) => <td key={j}>{r[j] ?? ""}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      {body.length > MAX_CSV_ROWS && <p className="artifact-sheet-state">Showing the first {MAX_CSV_ROWS.toLocaleString()} rows. Download for the full file.</p>}
    </>
  );
}

function Preview({ format, text }: { format: Artifact["format"]; text: string }) {
  if (format === "md" || format === "docx") {
    return (
      <div className="md-body artifact-sheet-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
            // Same code blocks as chat replies, so a ```chart block in a document is drawn.
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  }
  if (format === "csv") return <CsvPreview text={text} />;
  let body = text;
  if (format === "json") {
    try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show as written */ }
  }
  return <pre className="artifact-sheet-pre">{body}</pre>;
}

interface Props {
  id: string;
  sessionId: string;
  version?: number;
}

/** A file the agent wrote, in the Artifacts panel: its name, version history, copy/download and a preview. */
export default function ArtifactFileView({ id, sessionId, version: initialVersion }: Props) {
  const [meta, setMeta] = useState<Artifact | null>(null);
  const [version, setVersion] = useState<number | undefined>(initialVersion);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(artifactUrl(id, sessionId))
      .then((res) => (res.ok ? (res.json() as Promise<Artifact>) : Promise.reject(new Error("This file is no longer available."))))
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setVersion((v) => (v !== undefined && data.versions.some((x) => x.version === v) ? v : data.versions[data.versions.length - 1]?.version));
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [id, sessionId]);

  useEffect(() => {
    if (!meta || version === undefined) return;
    let cancelled = false;
    setContent(null);
    fetchArtifactContent(id, sessionId, version)
      .then((text) => { if (!cancelled) setContent(text); })
      .catch(() => { if (!cancelled) setError("Couldn’t load this version."); });
    return () => { cancelled = true; };
  }, [id, sessionId, meta, version]);

  const current = meta?.versions.find((v) => v.version === version);

  return (
    <div className="artifact-view">
      <div className="artifact-view-head">
        <span className={`artifact-card-icon${meta ? ` artifact-card-icon--${meta.format}` : ""}`}>
          {meta && <ArtifactIcon format={meta.format} />}
        </span>
        <div className="artifact-sheet-heading">
          <h3 className="artifact-sheet-title" title={meta?.title}>{meta?.title ?? "File"}</h3>
          {/* Always drawn (empty while loading), so the preview below doesn't move when the details arrive. */}
          <span className="artifact-card-meta artifact-view-meta-line">
            {meta && meta.filename !== meta.title && <span className="artifact-card-filename">{meta.filename}</span>}
            {current && <span>{formatBytes(current.size)}</span>}
            {meta?.format === "docx" && <span>Downloads as Word</span>}
          </span>
        </div>
      </div>
      <div className="artifact-sheet-toolbar">
      {meta && version !== undefined && (
        <>
          {meta.versions.length > 1 && (
            <select
              className="artifact-sheet-version"
              aria-label="Version"
              value={version}
              onChange={(e) => setVersion(Number(e.target.value))}
            >
              {[...meta.versions].reverse().map((v, i) => (
                <option key={v.version} value={v.version}>
                  v{v.version}{i === 0 ? " (latest)" : ""} · {new Date(v.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </option>
              ))}
            </select>
          )}
          <span className="artifact-sheet-spacer" />
          {meta.format === "html" && <OpenInBrowserLink id={id} sessionId={sessionId} version={version} />}
          <CopyArtifactButton id={id} sessionId={sessionId} version={version} format={meta.format} />
          <a className="btn btn--sm btn--ghost" href={artifactUrl(id, sessionId, "/download", version)} download title="Download">
            <Download size={14} aria-hidden="true" />
            <span className="artifact-btn-label">Download</span>
          </a>
        </>
      )}
      </div>
      <div className={`artifact-sheet-body${meta?.format === "html" && !error ? " artifact-sheet-body--frame" : ""}`}>
        {error ? (
          <p className="artifact-sheet-state">{error}</p>
        ) : meta?.format === "html" && version !== undefined ? (
          <iframe
            key={version}
            className="artifact-sheet-frame"
            title={`Preview of ${meta.filename}`}
            src={artifactUrl(id, sessionId, "/view", version)}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
            referrerPolicy="no-referrer"
          />
        ) : content === null || !meta ? (
          <p className="artifact-sheet-state">Loading…</p>
        ) : (
          <ChartSessionContext.Provider value={sessionId}>
            <Preview format={meta.format} text={content} />
          </ChartSessionContext.Provider>
        )}
      </div>
    </div>
  );
}
