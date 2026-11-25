/**
 * SOPs and tools the user points a message at (the composer's + menu: "Use an SOP",
 * "Use a tool"). An SOP's content goes in the turn's context block for the model to
 * follow; a tool's group is loaded for the turn and the model is told to use it.
 */

import type { SOPStore } from "../sop/store.js";
import type { ToolGroup } from "../tools/groups.js";
import { groupOfTool } from "../tools/groups.js";

export type ContextRef = { type: "sop"; id: number } | { type: "tool"; name: string };

export const MAX_REFS = 10;
/** Characters of one SOP put in the message; a longer one is cut with a pointer to load_sop_tool. */
const SOP_CHARS = 12_000;

/** Validated refs from a request body, or null when the shape is wrong. */
export function parseContextRefs(raw: unknown): ContextRef[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_REFS) return null;
  const out: ContextRef[] = [];
  for (const item of raw) {
    const r = item as { type?: unknown; id?: unknown; name?: unknown };
    if (r?.type === "sop" && Number.isInteger(r.id) && (r.id as number) > 0) out.push({ type: "sop", id: r.id as number });
    else if (r?.type === "tool" && typeof r.name === "string" && /^[\w.:-]{1,128}$/.test(r.name)) out.push({ type: "tool", name: r.name });
    else return null;
  }
  return out;
}

/** The context note for the refs, and the tool groups to load for this turn. Unknown SOPs and tools are named as missing. */
export function referencesForModel(
  refs: ContextRef[],
  deps: { sops: Pick<SOPStore, "get">; toolGroups: ToolGroup[] },
): { note: string; groups: string[] } {
  if (refs.length === 0) return { note: "", groups: [] };
  const parts: string[] = [];
  const groups = new Set<string>();
  const tools: string[] = [];
  for (const ref of refs) {
    if (ref.type === "sop") {
      const sop = deps.sops.get(ref.id);
      if (!sop) {
        parts.push(`- The user attached SOP ${ref.id}, which no longer exists.`);
        continue;
      }
      const content = sop.content.length > SOP_CHARS
        ? `${sop.content.slice(0, SOP_CHARS)}\n…(cut; call load_sop_tool(id=${sop.id}) for the rest)`
        : sop.content;
      parts.push(`**The user attached SOP [id ${sop.id}] "${sop.title}" to this message. Follow it where it applies:**\n${content}`);
    } else {
      const group = groupOfTool(deps.toolGroups, ref.name);
      if (!group) {
        parts.push(`- The user asked for the tool \`${ref.name}\`, which isn't available now.`);
        continue;
      }
      groups.add(group);
      tools.push(`\`${ref.name}\``);
    }
  }
  if (tools.length > 0) {
    parts.push(`**The user asked you to use ${tools.join(", ")} for this message.** ${tools.length === 1 ? "It is" : "They are"} loaded; use ${tools.length === 1 ? "it" : "them"} unless that clearly can't answer the request, and say so if not.`);
  }
  return { note: parts.join("\n\n"), groups: [...groups] };
}
