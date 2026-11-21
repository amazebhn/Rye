/** SKILL.md frontmatter parsing and serialisation. */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParsedSkillMd {
  /** Parsed frontmatter object ({} when absent or unparseable). */
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  /** Set when the frontmatter block was malformed. */
  warning?: string;
}

/** Split `---` delimited frontmatter from the body. Returns null when the file has none. */
function splitFrontmatter(text: string): { raw: string; body: string } | null {
  const src = text.replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (l === "---" || l === "...") {
      return { raw: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return null;
}

/** Fallback for frontmatter that isn't valid YAML (e.g. an unquoted `: ` inside a description). */
function parseLenient(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*)|\s*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      key = m[1];
      const v = (m[2] ?? "").trim();
      out[key] = /^(['"]).*\1$/.test(v) && v.length >= 2 ? v.slice(1, -1) : v;
    } else if (key && line.trim() !== "") {
      out[key] = `${String(out[key] ?? "")} ${line.trim()}`.trim();
    }
  }
  return out;
}

export function parseSkillMd(text: string): ParsedSkillMd {
  const split = splitFrontmatter(text);
  if (!split) return { data: {}, body: text.replace(/^\uFEFF/, ""), hasFrontmatter: false };

  let data: Record<string, unknown>;
  let warning: string | undefined;
  try {
    const parsed = parseYaml(split.raw);
    if (parsed === null || parsed === undefined) data = {};
    else if (typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    else throw new Error("frontmatter is not a mapping");
  } catch (err) {
    data = parseLenient(split.raw);
    warning = `invalid YAML frontmatter (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); parsed leniently`;
  }
  return { data, body: split.body.replace(/^\r?\n/, ""), hasFrontmatter: true, ...(warning ? { warning } : {}) };
}

/** Compose a SKILL.md. Field order: name, title, description, then extras. */
export function composeSkillMd(
  fm: { name: string; title?: string; description: string; extras?: Record<string, unknown> },
  body: string,
): string {
  const data: Record<string, unknown> = { name: fm.name };
  if (fm.title) data.title = fm.title;
  data.description = fm.description;
  for (const [k, v] of Object.entries(fm.extras ?? {})) {
    if (k !== "name" && k !== "title" && k !== "description") data[k] = v;
  }
  const yaml = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "").trimEnd()}\n`;
}
