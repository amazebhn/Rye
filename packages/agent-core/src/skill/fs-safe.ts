/**
 * Path-safe file helpers shared by the skill store, tools and HTTP routes.
 * Everything that touches a skill's bundled files goes through resolveInside().
 */

import { closeSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";

export class SkillError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 413 | 500 = 400,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidSkillName(name: unknown): name is string {
  return typeof name === "string" && SKILL_NAME_RE.test(name) && name !== "." && name !== "..";
}

export function assertValidSkillName(name: unknown): asserts name is string {
  if (!isValidSkillName(name)) {
    throw new SkillError(
      `Invalid skill name ${JSON.stringify(name)}: use 1-64 chars of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.`,
      400,
    );
  }
}

export const MAX_READ_BYTES = 200 * 1024;

/**
 * Resolve `rel` inside `rootDir` and return the real path of an existing regular file.
 * Rejects absolute paths, `..` segments, NULs, backslashes and symlinks that leave the root.
 */
export function resolveInside(rootDir: string, rel: unknown): { real: string; rel: string } {
  if (typeof rel !== "string" || rel.trim() === "") throw new SkillError("path is required", 400);
  if (rel.includes("\0")) throw new SkillError("path contains a NUL byte", 400);
  if (rel.includes("\\")) throw new SkillError("path must use '/' separators", 400);
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) throw new SkillError("path must be relative to the skill folder", 400);
  const segments = rel.split("/");
  if (segments.some((s) => s === "..")) throw new SkillError("path must not contain '..'", 400);

  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(rootDir);
    real = realpathSync(join(realRoot, rel));
  } catch {
    throw new SkillError(`File not found: ${rel}`, 404);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new SkillError("path resolves outside the skill folder", 400);
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new SkillError(`File not found: ${rel}`, 404);
  }
  if (!st.isFile()) throw new SkillError(`Not a regular file: ${rel}`, 400);
  return { real, rel: segments.filter((s) => s !== "" && s !== ".").join("/") };
}

export interface TextRead {
  content: string;
  size: number;
  truncated: boolean;
}

/** Read a text file (first `cap` bytes); refuses binary content. */
export function readTextFile(real: string, cap = MAX_READ_BYTES): TextRead {
  const size = statSync(real).size;
  const fd = openSync(real, "r");
  try {
    const len = Math.min(size, cap);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.subarray(0, 8192).includes(0)) throw new SkillError("Refusing to read a binary file.", 400);
    const truncated = size > cap;
    const text = bytes.toString("utf8");
    return {
      content: truncated ? `${text}\n\n[truncated: file is ${size} bytes, showing the first ${cap}]` : text,
      size,
      truncated,
    };
  } finally {
    closeSync(fd);
  }
}

/** Write via a temp file in the same directory, then rename; the temp file never outlives a failure. */
export function atomicWriteFile(path: string, data: string): void {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
