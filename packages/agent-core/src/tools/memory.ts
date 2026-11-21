/**
 * Memory tools — allow the agent to persist and recall facts across sessions.
 */

import { Type, type Tool } from "@earendil-works/pi-ai";
import type { MemoryKind, MemoryStore } from "../memory/store.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const memoryTools: Tool[] = [
  {
    name: "remember_tool",
    description:
      "Save a short, always-in-prompt fact, acronym, or custom term to the Fact & Glossary table (e.g. 'redis_host', 'oms' -> 'Order Management Service'). For longer architecture notes or multi-paragraph system docs, use save_knowledge_tool instead.",
    parameters: Type.Object({
      key: Type.String({ description: "Short unique identifier or term/acronym (e.g. 'redis_host', 'oms')" }),
      value: Type.String({ description: "The fact or definition to remember" }),
      kind: Type.Optional(
        Type.Union([Type.Literal("fact"), Type.Literal("acronym"), Type.Literal("term")], {
          description: "Entry type: 'fact' (default), 'acronym', or 'term' (custom domain term).",
        }),
      ),
      category: Type.Optional(Type.String({ description: "Group this memory under a category (e.g. 'infra', 'people', 'process'). Defaults to 'general'." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional labels to group related memories (e.g. ['infra', 'mysql'])" })),
    }),
  },
  {
    name: "forget_tool",
    description: "Delete a previously saved memory by key. Use when a fact is outdated or no longer relevant.",
    parameters: Type.Object({
      key: Type.String({ description: "The key of the memory to delete" }),
    }),
  },
  {
    name: "list_memories_tool",
    description: "List all saved facts, acronyms, and terms. Use this when the user asks what you remember or to review stored context.",
    parameters: Type.Object({}),
  },
];

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

export function rememberFact(
  store: MemoryStore,
  args: { key: string; value: string; kind?: MemoryKind; category?: string; tags?: string[] },
): string {
  store.save(args.key, args.value, args.tags ?? [], args.category ?? "general", { kind: args.kind });
  const kindStr = args.kind && args.kind !== "fact" ? ` [${args.kind}]` : "";
  const cat = args.category && args.category !== "general" ? ` _(${args.category})_` : "";
  return `Remembered${kindStr}: **${args.key}** = ${args.value}${cat}`;
}

export function forgetFact(store: MemoryStore, args: { key: string }): string {
  const deleted = store.forget(args.key);
  return deleted ? `Forgot memory: **${args.key}**` : `No memory found with key: **${args.key}**`;
}

export function listMemories(store: MemoryStore): string {
  const memories = store.all();
  if (memories.length === 0) return "No memories saved yet.";
  return memories
    .map((m) => {
      const kindStr = m.kind !== "fact" ? ` (${m.kind})` : "";
      const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
      const catStr = m.category && m.category !== "general" ? ` _(${m.category})_` : "";
      return `- **${m.key}**${kindStr}${catStr}${tagStr}: ${m.value}  _(updated ${m.updated_at})_`;
    })
    .join("\n");
}
