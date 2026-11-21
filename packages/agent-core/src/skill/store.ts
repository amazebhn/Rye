/**
 * Skill store — skills are folders containing a SKILL.md plus optional bundled files and scripts.
 *
 * Two kinds of roots are scanned:
 *   - the Rye-owned dir (DATA_DIR/skills): editable from the UI/agent.
 *   - external dirs (default ~/.agents/skills, installed by the `skills` CLI): READ-ONLY for Rye.
 *
 * The folder name is the skill's identity. When a Rye-owned and an installed skill share
 * a name, the Rye-owned one wins and the installed one is hidden (reported as a warning).
 * The agent sees a compact index (name + description) and loads full content on demand.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, getSettings } from "../config.js";
import { composeSkillMd, parseSkillMd } from "./frontmatter.js";
import {
  SkillError,
  assertValidSkillName,
  atomicWriteFile,
  isValidSkillName,
  readTextFile,
  resolveInside,
  type TextRead,
} from "./fs-safe.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillFile {
  /** Path relative to the skill folder, '/'-separated. */
  path: string;
  size: number;
}

export interface SkillInstalledFrom {
  source: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  skillPath: string | null;
  skillFolderHash: string | null;
  installedAt: string | null;
  updatedAt: string | null;
}

export interface SkillSummary {
  /** Folder name — the identity used by tools and routes. */
  name: string;
  title: string;
  description: string;
  source: "rye" | "installed";
  /** Absolute path of the skill folder. */
  path: string;
  /** True only for Rye-owned skills. */
  editable: boolean;
  files: SkillFile[];
  filesTruncated: boolean;
  /** Relative paths under scripts/. */
  scripts: string[];
  installedFrom: SkillInstalledFrom | null;
  /** Frontmatter keys other than name/title/description. */
  frontmatter: Record<string, unknown>;
  /** Set when the frontmatter `name` differs from the folder name (the folder name wins). */
  frontmatterName: string | null;
  /** Path of a same-named installed skill hidden by this Rye-owned one. */
  shadows: string | null;
  updatedAt: string;
}

export interface Skill extends SkillSummary {
  body: string;
}

export interface SkillStoreOptions {
  ryeDir?: string;
  externalDirs?: string[] | (() => string[]);
}

export interface CreateSkillInput {
  name?: string;
  title?: string;
  description?: string;
  content: string;
  extras?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_FILES = 200;
const MAX_DEPTH = 4;
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);
const TMP_RE = /^\..*\.tmp$/;
// Names that would collide with fixed /skill/* routes.
const RESERVED_NAMES = new Set(["install", "remove", "update", "rescan", "warnings"]);
export const MAX_DESCRIPTION_IN_INDEX = 300;

// Copy limits for duplicate().
const COPY_MAX_FILES = 500;
const COPY_MAX_FILE_BYTES = 5 * 1024 * 1024;
const COPY_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Compose SKILL.md text, refusing anything the scanner would later skip as oversized. */
function composeChecked(...args: Parameters<typeof composeSkillMd>): string {
  const text = composeSkillMd(...args);
  if (Buffer.byteLength(text) > MAX_SKILL_MD_BYTES) {
    throw new SkillError(`SKILL.md would be larger than ${MAX_SKILL_MD_BYTES} bytes`, 413);
  }
  return text;
}

export function slugifyName(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
  return slug || "skill";
}

export function titleFromName(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block
      .split("\n")
      .filter((l) => !/^\s*(#|```|---)/.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 200);
  }
  return "";
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function listBundled(dir: string): { files: SkillFile[]; truncated: boolean } {
  const files: SkillFile[] = [];
  let truncated = false;
  let realRoot: string;
  try {
    realRoot = realpathSync(dir);
  } catch {
    return { files, truncated };
  }

  const walk = (abs: string, rel: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (truncated) return;
      if (SKIP_NAMES.has(name) || TMP_RE.test(name)) continue;
      if (rel === "" && name === "SKILL.md") continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      try {
        const real = realpathSync(childAbs);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) continue; // symlink escaping the skill
        const st = statSync(real);
        if (st.isDirectory()) {
          if (depth < MAX_DEPTH) walk(childAbs, childRel, depth + 1);
          else truncated = true;
        } else if (st.isFile()) {
          if (files.length >= MAX_FILES) {
            truncated = true;
            return;
          }
          files.push({ path: childRel, size: st.size });
        }
      } catch {
        // unreadable or dangling entry
      }
    }
  };
  walk(dir, "", 1);
  return { files, truncated };
}

function readLock(rootDir: string): Record<string, SkillInstalledFrom> {
  const lockPath = join(dirname(rootDir), ".skill-lock.json");
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { skills?: Record<string, Record<string, unknown>> };
    const out: Record<string, SkillInstalledFrom> = {};
    for (const [name, e] of Object.entries(parsed.skills ?? {})) {
      out[name] = {
        source: str(e.source),
        sourceType: str(e.sourceType),
        sourceUrl: str(e.sourceUrl),
        skillPath: str(e.skillPath),
        skillFolderHash: str(e.skillFolderHash),
        installedAt: str(e.installedAt),
        updatedAt: str(e.updatedAt),
      };
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Scan {
  signature: string;
  skills: SkillSummary[];
  /** Every folder name seen, including hidden duplicates, for unique-name checks. */
  allNames: Set<string>;
  warnings: string[];
}

export class SkillStore {
  readonly ryeDir: string;
  private readonly externalDirsOpt: string[] | (() => string[]);
  private scan: Scan | null = null;

  constructor(opts: SkillStoreOptions = {}) {
    this.ryeDir = resolve(opts.ryeDir ?? join(DATA_DIR, "skills"));
    this.externalDirsOpt = opts.externalDirs ?? (() => getSettings().skills.dirs);
  }

  private externalDirs(): string[] {
    const dirs = typeof this.externalDirsOpt === "function" ? this.externalDirsOpt() : this.externalDirsOpt;
    return [...new Set(dirs.map((d) => resolve(d)))].filter((d) => d !== this.ryeDir);
  }

  private roots(): Array<{ dir: string; source: "rye" | "installed" }> {
    return [{ dir: this.ryeDir, source: "rye" }, ...this.externalDirs().map((dir) => ({ dir, source: "installed" as const }))];
  }

  /** Cheap fingerprint of every root: dir mtimes plus each SKILL.md's mtime/size and the lock file. */
  private signature(): string {
    const parts: string[] = [];
    for (const { dir } of this.roots()) {
      try {
        parts.push(`${dir}@${statSync(dir).mtimeMs}`);
      } catch {
        parts.push(`${dir}@missing`);
        continue;
      }
      try {
        parts.push(`lock@${statSync(join(dirname(dir), ".skill-lock.json")).mtimeMs}`);
      } catch {
        // no lock file
      }
      let names: string[] = [];
      try {
        names = readdirSync(dir).sort();
      } catch {
        // unreadable root
      }
      for (const n of names) {
        if (n.startsWith(".")) continue;
        try {
          const d = statSync(join(dir, n));
          const f = statSync(join(dir, n, "SKILL.md"));
          parts.push(`${n}:${d.mtimeMs}:${f.mtimeMs}:${f.size}`);
        } catch {
          // not a skill folder
        }
      }
    }
    return parts.join("|");
  }

  private current(): Scan {
    const sig = this.signature();
    if (this.scan && this.scan.signature === sig) return this.scan;
    this.scan = this.doScan(sig);
    return this.scan;
  }

  /** Drop the cache and rescan now. */
  rescan(): SkillSummary[] {
    this.scan = null;
    return this.list();
  }

  warnings(): string[] {
    return [...this.current().warnings];
  }

  private readSummary(
    dir: string,
    name: string,
    source: "rye" | "installed",
    lock: Record<string, SkillInstalledFrom>,
    warnings: string[],
  ): SkillSummary | null {
    const mdPath = join(dir, "SKILL.md");
    let st;
    try {
      st = statSync(mdPath);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    try {
      // A SKILL.md symlinked outside its folder would let a skill expose arbitrary files.
      const realDir = realpathSync(dir);
      if (!realpathSync(mdPath).startsWith(realDir + sep)) {
        warnings.push(`${dir}: SKILL.md resolves outside the skill folder; skipped`);
        return null;
      }
    } catch {
      return null;
    }
    if (st.size > MAX_SKILL_MD_BYTES) {
      warnings.push(`${dir}: SKILL.md is larger than ${MAX_SKILL_MD_BYTES} bytes; skipped`);
      return null;
    }
    let text: string;
    try {
      text = readFileSync(mdPath, "utf8");
    } catch (err) {
      warnings.push(`${dir}: cannot read SKILL.md (${err instanceof Error ? err.message : String(err)}); skipped`);
      return null;
    }
    const parsed = parseSkillMd(text);
    if (parsed.warning) warnings.push(`${name}: ${parsed.warning}`);
    if (!parsed.hasFrontmatter) warnings.push(`${name}: SKILL.md has no frontmatter`);

    const { name: fmName, title: fmTitle, description: fmDesc, ...extras } = parsed.data;
    const description =
      typeof fmDesc === "string" ? fmDesc.replace(/\s+/g, " ").trim() : firstParagraph(parsed.body);
    const frontmatterName = typeof fmName === "string" && fmName !== name ? fmName : null;
    if (frontmatterName) warnings.push(`${name}: frontmatter name "${frontmatterName}" differs from folder name; using "${name}"`);

    const { files, truncated } = listBundled(dir);
    return {
      name,
      title: typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : titleFromName(name),
      description,
      source,
      path: dir,
      editable: source === "rye",
      files,
      filesTruncated: truncated,
      scripts: files.filter((f) => f.path.startsWith("scripts/")).map((f) => f.path),
      installedFrom: source === "installed" ? (lock[name] ?? null) : null,
      frontmatter: extras,
      frontmatterName,
      shadows: null,
      updatedAt: st.mtime.toISOString(),
    };
  }

  private doScan(signature: string): Scan {
    const warnings: string[] = [];
    const allNames = new Set<string>();
    const byName = new Map<string, SkillSummary>();
    const rye: SkillSummary[] = [];
    const installed: SkillSummary[] = [];

    for (const { dir, source } of this.roots()) {
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          warnings.push(`${dir}: cannot read skills directory (${(err as Error).message})`);
        }
        continue;
      }
      const lock = source === "installed" ? readLock(dir) : {};
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const skillDir = join(dir, entry);
        try {
          if (!statSync(skillDir).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!isValidSkillName(entry)) {
          if (existsSync(join(skillDir, "SKILL.md"))) warnings.push(`${skillDir}: invalid skill name "${entry}"; skipped`);
          continue;
        }
        const summary = this.readSummary(skillDir, entry, source, lock, warnings);
        if (!summary) continue;
        allNames.add(entry);
        const existing = byName.get(entry);
        if (existing) {
          // First root wins: Rye-owned over installed, earlier dir over later.
          if (existing.source === "rye" && existing.shadows === null) existing.shadows = skillDir;
          warnings.push(`${entry}: ${skillDir} is hidden by ${existing.path}`);
          continue;
        }
        byName.set(entry, summary);
        (source === "rye" ? rye : installed).push(summary);
      }
    }
    rye.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    return { signature, skills: [...rye, ...installed], allNames, warnings };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(): SkillSummary[] {
    return [...this.current().skills];
  }

  summary(name: string): SkillSummary | null {
    if (!isValidSkillName(name)) return null;
    return this.current().skills.find((s) => s.name === name) ?? null;
  }

  get(name: string): Skill | null {
    const s = this.summary(name);
    if (!s) return null;
    try {
      const parsed = parseSkillMd(readFileSync(join(s.path, "SKILL.md"), "utf8"));
      return { ...s, body: parsed.body };
    } catch {
      return null;
    }
  }

  /** Resolve a bundled file to a real path inside the skill folder (throws SkillError). */
  resolveFile(name: string, rel: unknown): { real: string; rel: string } {
    const s = this.summary(name);
    if (!s) throw new SkillError(`Skill not found: ${name}`, 404);
    return resolveInside(s.path, rel);
  }

  readFile(name: string, rel: unknown): TextRead & { path: string } {
    const { real, rel: clean } = this.resolveFile(name, rel);
    return { ...readTextFile(real), path: clean };
  }

  /**
   * Compact index for progressive disclosure, injected into the system prompt.
   * Lists name — description; the agent loads full instructions with load_skill_tool.
   */
  formatIndexForPrompt(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    const lines = skills.map((s) => {
      let d = s.description.replace(/\s+/g, " ").trim();
      if (d.length > MAX_DESCRIPTION_IN_INDEX) d = `${d.slice(0, MAX_DESCRIPTION_IN_INDEX - 1).trimEnd()}…`;
      return `- ${s.name}${d ? ` — ${d}` : ""}${s.scripts.length > 0 ? " [has scripts]" : ""}`;
    });
    return (
      `## Available Skills\n` +
      `Skills are folders with a SKILL.md playbook and optional bundled files/scripts. When a request matches one, ` +
      `call load_skill_tool with its NAME (the text before the dash) to read the full instructions before proceeding.\n\n` +
      lines.join("\n")
    );
  }

  // -------------------------------------------------------------------------
  // Writes (Rye-owned only)
  // -------------------------------------------------------------------------

  private assertEditable(name: string): SkillSummary {
    assertValidSkillName(name);
    const s = this.summary(name);
    if (!s) throw new SkillError(`Skill not found: ${name}`, 404);
    if (!s.editable) {
      throw new SkillError(
        `Skill "${name}" is installed (read-only). Duplicate it into Rye to edit a copy, or remove it through POST /skill/remove.`,
        403,
      );
    }
    // Guard against a symlinked skill folder pointing outside the Rye dir.
    let real: string;
    try {
      real = realpathSync(s.path);
    } catch {
      throw new SkillError(`Skill not found: ${name}`, 404);
    }
    if (!real.startsWith(realpathSync(this.ryeDir) + sep)) throw new SkillError("Skill folder resolves outside Rye's skills directory", 403);
    return s;
  }

  /** A folder name not used by any scanned skill or existing Rye directory. */
  uniqueName(base: string): string {
    const taken = this.current().allNames;
    const free = (n: string) => !taken.has(n) && !RESERVED_NAMES.has(n) && !existsSync(join(this.ryeDir, n));
    const root = slugifyName(base);
    if (free(root)) return root;
    for (let i = 2; i < 10_000; i++) {
      const suffix = `-${i}`;
      const candidate = `${root.slice(0, 64 - suffix.length).replace(/[-._]+$/, "")}${suffix}`;
      if (free(candidate)) return candidate;
    }
    throw new SkillError("Could not find a free skill name", 409);
  }

  private assertNameFree(name: string): void {
    if (RESERVED_NAMES.has(name)) throw new SkillError(`"${name}" is a reserved name`, 400);
    if (this.current().allNames.has(name) || existsSync(join(this.ryeDir, name))) {
      throw new SkillError(`A skill named "${name}" already exists`, 409);
    }
  }

  create(input: CreateSkillInput): Skill {
    if (typeof input.content !== "string") throw new SkillError("content is required", 400);
    let name: string;
    if (input.name !== undefined && input.name !== "") {
      assertValidSkillName(input.name);
      this.assertNameFree(input.name);
      name = input.name;
    } else {
      const seed = input.title?.trim();
      if (!seed) throw new SkillError("name or title is required", 400);
      name = this.uniqueName(seed);
    }

    const title = input.title?.trim();
    mkdirSync(this.ryeDir, { recursive: true });
    const dir = join(this.ryeDir, name);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new SkillError(`A skill named "${name}" already exists`, 409);
      throw err;
    }
    try {
      atomicWriteFile(
        join(dir, "SKILL.md"),
        composeChecked(
          {
            name,
            title: title && title !== titleFromName(name) ? title : undefined,
            description: (input.description ?? "").trim(),
            extras: input.extras,
          },
          input.content,
        ),
      );
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    this.scan = null;
    return this.get(name)!;
  }

  update(name: string, patch: { title?: string; description?: string; content?: string }): Skill {
    const s = this.assertEditable(name);
    const mdPath = join(s.path, "SKILL.md");
    const parsed = parseSkillMd(readFileSync(mdPath, "utf8"));
    const { name: _n, title: oldTitle, description: oldDesc, ...extras } = parsed.data;

    const title = patch.title !== undefined ? patch.title.trim() : typeof oldTitle === "string" ? oldTitle : undefined;
    const description =
      patch.description !== undefined ? patch.description.trim() : typeof oldDesc === "string" ? oldDesc : s.description;
    atomicWriteFile(
      mdPath,
      composeChecked(
        { name, title: title && title !== titleFromName(name) ? title : undefined, description, extras },
        patch.content !== undefined ? patch.content : parsed.body,
      ),
    );
    this.scan = null;
    return this.get(name)!;
  }

  /** Copy any skill (including installed) into a new Rye-owned skill, bundled files included. */
  duplicate(name: string, newName?: string): Skill {
    assertValidSkillName(name);
    const src = this.summary(name);
    if (!src) throw new SkillError(`Skill not found: ${name}`, 404);

    let target: string;
    if (newName !== undefined && newName !== "") {
      assertValidSkillName(newName);
      this.assertNameFree(newName);
      target = newName;
    } else {
      target = this.uniqueName(`${name}-copy`);
    }

    mkdirSync(this.ryeDir, { recursive: true });
    const staging = join(this.ryeDir, `.dup-${randomBytes(6).toString("hex")}.tmp`);
    try {
      copySkillTree(src.path, staging);
      const mdPath = join(staging, "SKILL.md");
      const parsed = parseSkillMd(readFileSync(mdPath, "utf8"));
      const { name: _n, title: oldTitle, description: oldDesc, ...extras } = parsed.data;
      const baseTitle = typeof oldTitle === "string" && oldTitle.trim() ? oldTitle.trim() : src.title;
      atomicWriteFile(
        mdPath,
        composeSkillMd(
          {
            name: target,
            title: `${baseTitle} (copy)`,
            description: typeof oldDesc === "string" ? oldDesc : src.description,
            extras,
          },
          parsed.body,
        ),
      );
      if (existsSync(join(this.ryeDir, target))) throw new SkillError(`A skill named "${target}" already exists`, 409);
      renameSync(staging, join(this.ryeDir, target));
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
    this.scan = null;
    return this.get(target)!;
  }

  delete(name: string): void {
    const s = this.assertEditable(name);
    // Remove a symlinked folder as a link only; never follow it.
    if (lstatSync(s.path).isSymbolicLink()) rmSync(s.path, { force: true });
    else rmSync(s.path, { recursive: true, force: true });
    this.scan = null;
  }
}

// ---------------------------------------------------------------------------
// Folder copy with caps (used by duplicate)
// ---------------------------------------------------------------------------

function copySkillTree(src: string, dst: string): void {
  const realSrc = realpathSync(src);
  let files = 0;
  let total = 0;
  mkdirSync(dst, { recursive: true });

  const walk = (abs: string, outAbs: string, depth: number) => {
    if (depth > 8) throw new SkillError("Skill folder is nested too deeply to copy", 413);
    for (const name of readdirSync(abs).sort()) {
      if (SKIP_NAMES.has(name) || TMP_RE.test(name)) continue;
      const from = join(abs, name);
      const to = join(outAbs, name);
      let real: string;
      try {
        real = realpathSync(from);
      } catch {
        continue; // dangling symlink
      }
      if (real !== realSrc && !real.startsWith(realSrc + sep)) continue; // symlink escaping the skill
      const st = statSync(real);
      if (st.isDirectory()) {
        mkdirSync(to);
        walk(from, to, depth + 1);
      } else if (st.isFile()) {
        if (st.size > COPY_MAX_FILE_BYTES) throw new SkillError(`${name} is larger than ${COPY_MAX_FILE_BYTES} bytes; cannot copy this skill`, 413);
        files++;
        total += st.size;
        if (files > COPY_MAX_FILES) throw new SkillError(`Skill has more than ${COPY_MAX_FILES} files; cannot copy it`, 413);
        if (total > COPY_MAX_TOTAL_BYTES) throw new SkillError(`Skill is larger than ${COPY_MAX_TOTAL_BYTES} bytes; cannot copy it`, 413);
        cpSync(real, to);
      }
    }
  };
  walk(src, dst, 1);
  if (!existsSync(join(dst, "SKILL.md"))) throw new SkillError("SKILL.md is missing or unreadable", 400);
}
