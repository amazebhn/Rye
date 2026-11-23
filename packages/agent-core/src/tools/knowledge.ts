/**
 * Knowledge Base (RAG) tools — allow agents to search, read, save, and delete
 * durable system knowledge notes (architecture, service details, learnings).
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { KnowledgeStore } from "../knowledge/store.js";

export const knowledgeTools: Tool[] = [
  {
    name: "search_knowledge_tool",
    description:
      "Search the RAG Knowledge Base for system architecture notes, service mappings, schemas, and past learnings using hybrid semantic + keyword search. Use this before repeatedly querying external systems for static architectural info.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language or keyword query" }),
      category: Type.Optional(Type.String({ description: "Optional category filter (e.g. 'services', 'database', 'infra')" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of snippets to return (default 5, max 10)" })),
    }),
  },
  {
    name: "get_knowledge_tool",
    description: "Fetch the full content of a knowledge document by its id (e.g. 'kn_a1b2c3d4').",
    parameters: Type.Object({
      id: Type.String({ description: "The knowledge document id" }),
    }),
  },
  {
    name: "save_knowledge_tool",
    description:
      "Save or update a durable system knowledge note in the RAG Knowledge Base (e.g. service architecture, database table relationships, deployment topology, recurring quirk). For short key-value facts or acronyms that should ALWAYS be in the prompt, use remember_tool instead.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional existing doc id (kn_...) to update in place" })),
      title: Type.String({ description: "Clear, descriptive title for the note" }),
      content: Type.String({ description: "Markdown content of the knowledge note" }),
      category: Type.Optional(Type.String({ description: "Category (e.g. 'services', 'database', 'infra', 'payments'). Defaults to 'general'." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for filtering" })),
    }),
  },
  {
    name: "delete_knowledge_tool",
    description: "Delete an outdated or incorrect knowledge document by its id.",
    parameters: Type.Object({
      id: Type.String({ description: "The knowledge document id to delete" }),
    }),
  },
];

export async function searchKnowledge(
  store: KnowledgeStore,
  args: { query: string; category?: string; limit?: number },
): Promise<string> {
  const limit = Math.min(10, Math.max(1, args.limit ?? 5));
  const hits = await store.search(args.query, { limit, category: args.category });
  if (hits.length === 0) return `No knowledge notes found for "${args.query}".`;
  return hits
    .map((h) => {
      const heading = h.heading ? ` > ${h.heading}` : "";
      const tags = h.tags.length > 0 ? ` [${h.tags.join(", ")}]` : "";
      return `### ${h.title}${heading} _(id: ${h.doc_id}, ${h.category}${tags}, match: ${h.match_type})_\n${h.snippet}`;
    })
    .join("\n\n");
}

export function getKnowledge(store: KnowledgeStore, args: { id: string }): string {
  const doc = store.get(args.id);
  if (!doc) return `No knowledge document found with id: ${args.id}`;
  const tags = doc.tags.length > 0 ? ` [${doc.tags.join(", ")}]` : "";
  return `# ${doc.title}\n_id: ${doc.id} · category: ${doc.category}${tags} · source: ${doc.source} · updated: ${doc.updated_at}_\n\n${doc.content}`;
}

export async function saveKnowledge(
  store: KnowledgeStore,
  args: { id?: string; title: string; content: string; category?: string; tags?: string[] },
): Promise<string> {
  if (args.id) {
    const updated = await store.update(args.id, {
      title: args.title,
      content: args.content,
      category: args.category,
      tags: args.tags,
    });
    if (!updated) return `No knowledge document found with id: ${args.id}`;
    return `Updated knowledge note **${updated.title}** (id: \`${updated.id}\`, ${updated.chunk_count} chunk(s)${updated.embedding_model ? `, embedded with ${updated.embedding_model}` : ", keyword-indexed"}).`;
  }
  const created = await store.create({
    title: args.title,
    content: args.content,
    category: args.category,
    tags: args.tags,
    source: "agent",
  });
  return `Saved knowledge note **${created.title}** (id: \`${created.id}\`, ${created.chunk_count} chunk(s)${created.embedding_model ? `, embedded with ${created.embedding_model}` : ", keyword-indexed"}).`;
}

export function deleteKnowledge(store: KnowledgeStore, args: { id: string }): string {
  const ok = store.delete(args.id);
  return ok ? `Deleted knowledge note \`${args.id}\`.` : `No knowledge document found with id: ${args.id}`;
}
