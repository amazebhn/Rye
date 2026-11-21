/**
 * Artifact store — files the agent writes for the user (handoff docs, CSV
 * exports, reports). Each artifact is keyed by (session, filename); writing the
 * same filename again adds a version. The latest version lives as long as the
 * chat; older versions expire like stored results.
 *
 * Layout: DATA_DIR/artifacts/<art_id>/meta.json + v<N>.src (UTF-8 source;
 * .docx artifacts keep Markdown source and are converted on download).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { isSessionDeleted } from "../session/lifecycle.js";

let ARTIFACTS_DIR = join(DATA_DIR, "artifacts");

/** Tests point the store at a temp dir (DATA_DIR is fixed once config loads). */
export function setArtifactsRoot(dir: string): void {
  ARTIFACTS_DIR = dir;
}
const PRIOR_VERSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VERSIONS = 10;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export const ARTIFACT_FORMATS = ["md", "csv", "txt", "json", "docx", "html"] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

const ID_RE = /^art_[a-f0-9]{8}$/;
const STEM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ArtifactVersion {
  version: number;
  createdAt: number;
  size: number;
}

export interface Artifact {
  id: string;
  sessionId: string;
  filename: string;
  title: string;
  format: ArtifactFormat;
  createdAt: number;
  updatedAt: number;
  versions: ArtifactVersion[]; // ascending; the last entry is the latest
}

export class ArtifactError extends Error {}

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return typeof value === "string" && (ARTIFACT_FORMATS as readonly string[]).includes(value);
}

/** "Incident Handoff.md" → "incident-handoff.md" for format md. Throws if nothing usable is left. */
export function artifactFilename(name: string, format: ArtifactFormat): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(new RegExp(`\\.${format}$`), "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-.]+$/g, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  if (!STEM_RE.test(stem)) throw new ArtifactError(`Invalid artifact name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-'.`);
  return `${stem}.${format}`;
}

function artifactDir(id: string): string {
  if (!ID_RE.test(id)) throw new ArtifactError(`Invalid artifact id ${JSON.stringify(id)}.`);
  return join(ARTIFACTS_DIR, id);
}

function readMeta(id: string): Artifact | null {
  try {
    const path = join(artifactDir(id), "meta.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Artifact;
  } catch {
    return null;
  }
}

function writeMeta(meta: Artifact): void {
  writeFileSync(join(artifactDir(meta.id), "meta.json"), JSON.stringify(meta), "utf8");
}

function allArtifacts(): Artifact[] {
  if (!existsSync(ARTIFACTS_DIR)) return [];
  return readdirSync(ARTIFACTS_DIR)
    .filter((entry) => ID_RE.test(entry))
    .map(readMeta)
    .filter((meta): meta is Artifact => meta !== null);
}

/** Drop prior versions past retention or the version cap. The latest version is always kept. */
function pruneVersions(meta: Artifact, now: number): void {
  const latest = meta.versions[meta.versions.length - 1];
  const cutoff = now - PRIOR_VERSION_RETENTION_MS;
  const keep = meta.versions
    .slice(0, -1)
    .filter((v) => v.createdAt >= cutoff)
    .slice(-(MAX_VERSIONS - 1));
  const kept = new Set([...keep, latest].map((v) => v.version));
  for (const v of meta.versions) {
    if (!kept.has(v.version)) rmSync(join(artifactDir(meta.id), `v${v.version}.src`), { force: true });
  }
  meta.versions = [...keep, latest];
}

export function listArtifacts(sessionId: string): Artifact[] {
  try {
    return allArtifacts()
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function getArtifact(id: string, sessionId: string): Artifact | null {
  if (!ID_RE.test(id)) return null;
  const meta = readMeta(id);
  return meta && meta.sessionId === sessionId ? meta : null;
}

export function findArtifactByFilename(sessionId: string, filename: string): Artifact | null {
  return listArtifacts(sessionId).find((a) => a.filename === filename) ?? null;
}

/** Source text of a version (latest when omitted), or null if it has expired. */
export function readArtifactSource(meta: Artifact, version?: number): { version: ArtifactVersion; content: string } | null {
  const entry = version === undefined ? meta.versions[meta.versions.length - 1] : meta.versions.find((v) => v.version === version);
  if (!entry) return null;
  try {
    return { version: entry, content: readFileSync(join(artifactDir(meta.id), `v${entry.version}.src`), "utf8") };
  } catch {
    return null;
  }
}

/** Create the artifact, or add a version when this session already has the filename. */
export function saveArtifact(opts: {
  sessionId: string;
  filename: string;
  title: string;
  format: ArtifactFormat;
  content: string;
}): { artifact: Artifact; version: ArtifactVersion } {
  const size = Buffer.byteLength(opts.content, "utf8");
  if (size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`Artifact is ${size.toLocaleString("en-US")} bytes; the limit is ${MAX_ARTIFACT_BYTES.toLocaleString("en-US")}.`);
  }
  const now = Date.now();
  const existing = findArtifactByFilename(opts.sessionId, opts.filename);
  const meta: Artifact = existing ?? {
    id: `art_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
    sessionId: opts.sessionId,
    filename: opts.filename,
    title: opts.title,
    format: opts.format,
    createdAt: now,
    updatedAt: now,
    versions: [],
  };
  const version: ArtifactVersion = { version: (meta.versions.at(-1)?.version ?? 0) + 1, createdAt: now, size };
  meta.title = opts.title;
  meta.updatedAt = now;
  meta.versions.push(version);
  // A run can outlive its chat; don't recreate files for a deleted session.
  if (isSessionDeleted(opts.sessionId)) return { artifact: meta, version };

  const dir = artifactDir(meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `v${version.version}.src`), opts.content, "utf8");
  pruneVersions(meta, now);
  writeMeta(meta);
  return { artifact: meta, version };
}

/** Delete every artifact owned by a session. */
export function deleteArtifactsForSession(sessionId: string): number {
  let deleted = 0;
  try {
    for (const meta of allArtifacts()) {
      if (meta.sessionId !== sessionId) continue;
      rmSync(artifactDir(meta.id), { recursive: true, force: true });
      deleted++;
    }
  } catch {
    // Best-effort, like result cleanup.
  }
  return deleted;
}
