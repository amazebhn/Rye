import React, { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Eye, FileCode, FileJson, FileSpreadsheet, FileText } from "lucide-react";
import type { Artifact, ToolCall } from "../../utils/types";

const MARKER = /\[rye:artifact:(art_[a-f0-9]{8}):v(\d+)\]/;
export const ARTIFACT_MARKER_ALL = /\n?\[rye:artifact:art_[a-f0-9]{8}:v\d+\]/g;

/** Files written in these tool calls, one per artifact at its newest version. */
export function artifactRefs(toolCalls: ToolCall[]): Array<{ id: string; version: number }> {
  const byId = new Map<string, number>();
  for (const tc of toolCalls) {
    if (tc.name !== "write_artifact_tool") continue;
    const m = tc.result?.match(MARKER);
    if (m) byId.set(m[1], Math.max(byId.get(m[1]) ?? 0, Number(m[2])));
  }
  return [...byId].map(([id, version]) => ({ id, version }));
}

export function artifactUrl(id: string, sessionId: string, path: "" | "/content" | "/download" | "/view" = "", version?: number): string {
  const q = new URLSearchParams({ session_id: sessionId });
  if (version !== undefined) q.set("version", String(version));
  return `/artifact/${encodeURIComponent(id)}${path}?${q}`;
}

export async function fetchArtifactContent(id: string, sessionId: string, version?: number): Promise<string> {
  const res = await fetch(artifactUrl(id, sessionId, "/content", version));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { content: string }).content;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ArtifactIcon({ format, size = 16 }: { format: Artifact["format"]; size?: number }) {
  const Icon = format === "csv" ? FileSpreadsheet : format === "json" ? FileJson : format === "html" ? FileCode : FileText;
  return <Icon size={size} aria-hidden="true" />;
}

// The page is served sandboxed (see the server's CSP), so it runs without access to the app.
export function OpenInBrowserLink({ id, sessionId, version }: { id: string; sessionId: string; version?: number }) {
  return (
    <a
      className="btn btn--sm btn--ghost"
      href={artifactUrl(id, sessionId, "/view", version)}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in a new browser tab"
      aria-label="Open in a new browser tab"
    >
      <ExternalLink size={14} aria-hidden="true" />
      Open
    </a>
  );
}

export function CopyArtifactButton({ id, sessionId, version, format }: { id: string; sessionId: string; version?: number; format: Artifact["format"] }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);
  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : format === "docx" ? "Copy Markdown" : "Copy";
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost"
      title={label}
      onClick={() =>
        fetchArtifactContent(id, sessionId, version)
          .then((text) => navigator.clipboard.writeText(text))
          .then(() => setState("copied"), () => setState("failed"))
      }
    >
      {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {/* Shown on message cards; read by screen readers only inside the Artifacts panel (icon buttons there). */}
      <span className="artifact-btn-label">{label}</span>
    </button>
  );
}

interface Props {
  id: string;
  version: number;
  sessionId: string;
  onOpen: (id: string, version: number) => void;
}

// Download card for a file the agent wrote in this reply.
export default function ArtifactCard({ id, version, sessionId, onOpen }: Props) {
  const [meta, setMeta] = useState<Artifact | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(artifactUrl(id, sessionId))
      .then((res) => (res.ok ? (res.json() as Promise<Artifact>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => { if (!cancelled) setMeta(data); })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [id, version, sessionId]);

  if (missing) {
    return (
      <div className="artifact-card artifact-card--missing">
        <span className="artifact-card-icon"><FileText size={16} aria-hidden="true" /></span>
        <span className="artifact-card-meta">This file is no longer available.</span>
      </div>
    );
  }
  if (!meta) return <div className="artifact-card artifact-card--loading" aria-busy="true" />;

  const latest = meta.versions[meta.versions.length - 1];
  // This reply's version may have expired; fall back to the latest.
  const shown = meta.versions.find((v) => v.version === version) ?? latest;
  const newer = latest.version > shown.version ? latest.version : undefined;

  return (
    <div className="artifact-card">
      <button type="button" className="artifact-card-main" onClick={() => onOpen(id, shown.version)} title={`Preview ${meta.title}`}>
        <span className={`artifact-card-icon artifact-card-icon--${meta.format}`}>
          <ArtifactIcon format={meta.format} />
        </span>
        <span className="artifact-card-text">
          <span className="artifact-card-title">{meta.title}</span>
          <span className="artifact-card-meta">
            {meta.filename !== meta.title && <span className="artifact-card-filename">{meta.filename}</span>}
            <span>{formatBytes(shown.size)}</span>
            {meta.versions.length > 1 || shown.version > 1 ? <span>v{shown.version}</span> : null}
            {newer && <span className="artifact-card-newer">v{newer} available</span>}
          </span>
        </span>
      </button>
      <div className="artifact-card-actions">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpen(id, shown.version)}>
          <Eye size={14} aria-hidden="true" />
          Preview
        </button>
        {meta.format === "html" ? (
          <OpenInBrowserLink id={id} sessionId={sessionId} version={shown.version} />
        ) : (
          <CopyArtifactButton id={id} sessionId={sessionId} version={shown.version} format={meta.format} />
        )}
        <a className="btn btn--sm btn--ghost" href={artifactUrl(id, sessionId, "/download", shown.version)} download>
          <Download size={14} aria-hidden="true" />
          Download
        </a>
      </div>
    </div>
  );
}
