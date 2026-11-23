/** Skill tools: load/save SKILL.md playbooks, read bundled files, run bundled scripts (approval-gated). */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { SkillError } from "../skill/fs-safe.js";
import { legacyIdToName } from "../skill/migrate.js";
import { RUN_SKILL_SCRIPT_TOOL_NAME } from "../skill/runner.js";
import type { SkillStore } from "../skill/store.js";

const MAX_LISTED_FILES = 40;

export const skillTools: Tool[] = [
  {
    name: "save_skill_tool",
    description:
      "Create or update a Rye-owned agent Skill (a folder DATA_DIR/skills/<name>/SKILL.md). " +
      "To edit an existing Skill pass its 'name'; omit 'name' to create a new one (the name is derived from the title). " +
      "Installed (read-only) skills cannot be edited — only Rye-owned ones.",
    parameters: Type.Object({
      title: Type.String({ description: "Short descriptive title for the Skill." }),
      description: Type.String({ description: "One-sentence summary of WHEN to use this Skill. Shown in the skill index so you can decide when to load it." }),
      content: Type.String({ description: "Full Skill instructions in Markdown (the SKILL.md body, without frontmatter)." }),
      name: Type.Optional(
        Type.String({ description: "Existing Skill name (folder, e.g. 'incident-triage') to update. Omit when creating a brand-new Skill." }),
      ),
    }),
  },
  {
    name: "load_skill_tool",
    description:
      "Load a Skill's full SKILL.md instructions by its NAME, plus the list of its bundled files and scripts. " +
      "The available skills (name — description) are listed in the system prompt under 'Available Skills'. " +
      "Call this when the user's request matches a skill so you can follow its instructions.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill name from the Available Skills index, e.g. 'shadcn'." }),
    }),
  },
  {
    name: "read_skill_file_tool",
    description:
      "Read a text file bundled inside a Skill folder (e.g. a reference doc the SKILL.md points to). " +
      "The path is relative to the skill folder; it cannot leave it. Large files are truncated; binary files are refused.",
    parameters: Type.Object({
      skill: Type.String({ description: "Skill name." }),
      path: Type.String({ description: "Path relative to the skill folder, e.g. 'rules/forms.md'." }),
    }),
  },
  {
    name: RUN_SKILL_SCRIPT_TOOL_NAME,
    description:
      "Run a script bundled in a Skill's scripts/ folder (.sh, .ts, .js, .mjs, .py). " +
      "EVERY run pauses for the user's explicit approval of the exact command; do not ask separately. " +
      "No shell: args is an argv array. 55s timeout, output capped, minimal environment.",
    parameters: Type.Object({
      skill: Type.String({ description: "Skill name." }),
      script: Type.String({ description: "Script path inside scripts/, e.g. 'scripts/check.sh'." }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script (at most 32)." })),
    }),
  },
];

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function errText(err: unknown): string {
  return err instanceof SkillError ? `Error: ${err.message}` : `Error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Skill name from a tool arg; maps a legacy numeric id to its migrated folder name. */
function resolveName(store: SkillStore, args: { name?: unknown; id?: unknown }): { name: string } | { error: string } {
  const raw = args.name ?? args.id;
  const num = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
  if (num !== null) {
    const mapped = legacyIdToName(store, num);
    return mapped
      ? { name: mapped }
      : { error: `Skills are now identified by name, not id (id ${num} was not found in the migrated skills). See the Available Skills index for names.` };
  }
  if (typeof raw !== "string" || raw.trim() === "") return { error: "name is required. See the Available Skills index for names." };
  return { name: raw.trim() };
}

export function loadSkill(store: SkillStore, args: { name?: unknown; id?: unknown }): string {
  const resolved = resolveName(store, args);
  if ("error" in resolved) return resolved.error;
  const skill = store.get(resolved.name);
  if (!skill) {
    const names = store.list().map((s) => s.name).join(", ");
    return `No skill named "${resolved.name}".${names ? ` Available: ${names}.` : ""}`;
  }

  const shown = skill.files.slice(0, MAX_LISTED_FILES);
  const hidden = skill.files.length - shown.length;
  const files =
    shown.length === 0
      ? ""
      : `\n\n---\nBundled files (${skill.files.length}${skill.filesTruncated ? "+" : ""}):\n` +
        shown.map((f) => `- ${f.path} (${fmtSize(f.size)})${f.path.startsWith("scripts/") ? " [script]" : ""}`).join("\n") +
        (hidden > 0 || skill.filesTruncated ? `\n- … and more (use read_skill_file_tool with a path)` : "") +
        `\n\nRelative paths in the instructions above refer to this skill's folder: read them with read_skill_file_tool({ skill: "${skill.name}", path }).` +
        (skill.scripts.length > 0
          ? ` Run scripts with run_skill_script_tool({ skill: "${skill.name}", script, args }); each run needs the user's approval.`
          : "");

  return `# ${skill.title}\n${skill.description ? `\n_${skill.description}_\n` : ""}\n${skill.body.trim()}${files}`;
}

export function saveSkill(
  store: SkillStore,
  args: { name?: unknown; id?: unknown; title?: unknown; description?: unknown; content?: unknown },
): string {
  if (typeof args.content !== "string") return "Error: content is required.";
  const title = typeof args.title === "string" ? args.title : undefined;
  const description = typeof args.description === "string" ? args.description : undefined;

  let name: string | undefined;
  if (args.name !== undefined && args.name !== null && args.name !== "") {
    const resolved = resolveName(store, args);
    if ("error" in resolved) return `Error: ${resolved.error}`;
    name = resolved.name;
  } else if (args.id !== undefined) {
    const resolved = resolveName(store, { id: args.id });
    if ("error" in resolved) return `Error: ${resolved.error}`;
    name = resolved.name;
  }

  try {
    const existing = name ? store.summary(name) : null;
    if (existing && !existing.editable) {
      return `Error: skill "${existing.name}" is installed (read-only) and cannot be edited. Ask the user to copy it to Rye (Duplicate in the Skills page), then edit the copy by its new name.`;
    }
    if (existing) {
      const saved = store.update(existing.name, { title, description, content: args.content });
      return `Skill updated: ${saved.name} ("${saved.title}")`;
    }
    const saved = store.create({ name, title, description, content: args.content });
    return `Skill created: ${saved.name} ("${saved.title}") at ${saved.path}`;
  } catch (err) {
    return errText(err);
  }
}

export function readSkillFile(store: SkillStore, args: { skill?: unknown; path?: unknown }): string {
  if (typeof args.skill !== "string") return "Error: skill is required.";
  try {
    const r = store.readFile(args.skill, args.path);
    return r.content;
  } catch (err) {
    return errText(err);
  }
}
