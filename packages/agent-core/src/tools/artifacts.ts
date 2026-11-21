/**
 * Artifact tools — let the agent hand the user a file (handoff doc, CSV export,
 * report) instead of pasting it into the chat. The tool result carries a
 * [rye:artifact:<id>:v<N>] marker the web UI turns into a download card.
 */

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  ARTIFACT_FORMATS,
  ArtifactError,
  artifactFilename,
  findArtifactByFilename,
  isArtifactFormat,
  listArtifacts,
  readArtifactSource,
  saveArtifact,
} from "../artifacts/store.js";
import { getResult } from "../results/store.js";

export const WRITE_ARTIFACT_TOOL_NAME = "write_artifact_tool";
export const READ_ARTIFACT_TOOL_NAME = "read_artifact_tool";
const READ_MAX_CHARS = 100_000;

export const artifactTools: Tool[] = [
  {
    name: WRITE_ARTIFACT_TOOL_NAME,
    description:
      "Save a file the user can preview, copy and download from the chat: a handoff doc, report, runbook draft, CSV export, etc. " +
      "Use it when the user asks for a document/file/export, or when the output is long enough that they will want to keep or share it. " +
      "Write the complete file in one call. Calling again with the same name and format saves a new version (older versions are kept for 7 days). " +
      "Formats: md (Markdown), csv, txt, json, docx (Word — write Markdown in content; it is converted on download), " +
      "html (a single self-contained page the user can preview and open in the browser, e.g. a visual report or dashboard; " +
      "inline all CSS, JS and data; images may be https URLs or data: URLs, but other external URLs, CDNs and network requests are blocked; " +
      'the page font defaults to the variable sans "Allo" (weights 100–900), so leave font-family unset unless you need monospace). ' +
      "For a CSV of a stored result (res_…), pass result_id instead of content so the rows don't pass through the conversation. " +
      "The user sees a card for the file under your reply, so don't paste the content again — summarise it in a sentence or two.",
    parameters: Type.Object({
      name: Type.String({ description: 'File name without extension, e.g. "incident-handoff" or "failed-orders".' }),
      format: Type.Union(ARTIFACT_FORMATS.map((f) => Type.Literal(f)), { description: "File format." }),
      title: Type.Optional(Type.String({ description: "Human-readable title; defaults to the name." })),
      content: Type.Optional(Type.String({ description: "Full file content. Markdown for md and docx." })),
      result_id: Type.Optional(Type.String({ description: "csv only: export this stored result (res_…) instead of content." })),
    }),
  },
  {
    name: READ_ARTIFACT_TOOL_NAME,
    description:
      "Read back a file saved with write_artifact_tool in this chat (latest version), e.g. to revise it. Omit name to list this chat's files.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'File name, e.g. "incident-handoff.md" or "incident-handoff" with format.' })),
      format: Type.Optional(Type.Union(ARTIFACT_FORMATS.map((f) => Type.Literal(f)))),
    }),
  },
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return [columns.map(csvCell).join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function writeArtifact(args: Record<string, unknown>, sessionId: string | undefined): string {
  if (!sessionId) return "Error: artifacts can only be saved inside a chat session.";
  const { name, format, title, content, result_id } = args as {
    name?: unknown; format?: unknown; title?: unknown; content?: unknown; result_id?: unknown;
  };
  if (!isArtifactFormat(format)) return `Error: format must be one of ${ARTIFACT_FORMATS.join(", ")}.`;
  if (typeof name !== "string" || !name.trim()) return "Error: name is required.";

  let body: string;
  if (typeof result_id === "string" && result_id) {
    if (format !== "csv") return "Error: result_id is only supported with format csv.";
    const result = getResult(result_id, sessionId);
    if (!result) return `Error: no stored result ${result_id} in this chat (results expire after 7 days).`;
    body = rowsToCsv(result.columns, result.rows);
  } else if (typeof content === "string" && content.trim()) {
    body = content;
  } else {
    return "Error: content is required (or result_id for a csv export).";
  }
  if (format === "json") {
    try {
      JSON.parse(body);
    } catch (err) {
      return `Error: content is not valid JSON (${err instanceof Error ? err.message : String(err)}).`;
    }
  }

  try {
    const filename = artifactFilename(name, format);
    const displayTitle = typeof title === "string" && title.trim() ? title.trim() : filename;
    const { artifact, version } = saveArtifact({ sessionId, filename, title: displayTitle, format, content: body });
    const revised = version.version > 1 ? ` (version ${version.version}; previous versions kept for 7 days)` : "";
    return (
      `Saved ${filename}${revised}, ${formatSize(version.size)}. ` +
      `The user has a preview/download card for it under your reply.\n[rye:artifact:${artifact.id}:v${version.version}]`
    );
  } catch (err) {
    if (err instanceof ArtifactError) return `Error: ${err.message}`;
    throw err;
  }
}

export function readArtifact(args: Record<string, unknown>, sessionId: string | undefined): string {
  if (!sessionId) return "Error: artifacts are only available inside a chat session.";
  const { name, format } = args as { name?: unknown; format?: unknown };
  const all = listArtifacts(sessionId);
  if (typeof name !== "string" || !name.trim()) {
    if (all.length === 0) return "No files saved in this chat yet.";
    return all.map((a) => `- ${a.filename} — "${a.title}", v${a.versions.at(-1)?.version}`).join("\n");
  }

  let meta = all.find((a) => a.filename === name.trim().toLowerCase()) ?? null;
  if (!meta) {
    try {
      if (isArtifactFormat(format)) meta = findArtifactByFilename(sessionId, artifactFilename(name, format));
      else meta = all.find((a) => a.filename === artifactFilename(name, a.format)) ?? null;
    } catch {
      meta = null;
    }
  }
  if (!meta) return `Error: no file named ${JSON.stringify(name)} in this chat. Files: ${all.map((a) => a.filename).join(", ") || "none"}.`;

  const source = readArtifactSource(meta);
  if (!source) return `Error: ${meta.filename} could not be read.`;
  const text = source.content.length > READ_MAX_CHARS
    ? `${source.content.slice(0, READ_MAX_CHARS)}\n[… ${(source.content.length - READ_MAX_CHARS).toLocaleString("en-US")} more chars]`
    : source.content;
  return `${meta.filename} (v${source.version.version}${meta.format === "docx" ? ", Markdown source" : ""}):\n\n${text}`;
}
