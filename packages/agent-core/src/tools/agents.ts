/**
 * Agent authoring tool — lets the AI Editor create or update custom agents.
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentStore } from "../agents/store.js";

export const agentTools: Tool[] = [
  {
    name: "save_agent_tool",
    description:
      "Create a new custom agent or update an existing one. Omit `id` to create a new agent; provide `id` (e.g. 'agt_a1b2c3d4') to update an existing agent's instructions or metadata.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Existing agent id to update. Omit when creating a new agent." })),
      name: Type.String({ description: "Display name for the agent (e.g. 'Database Specialist')" }),
      slug: Type.Optional(Type.String({ description: "Short @handle without '@' (e.g. 'db'). Auto-generated from name if omitted." })),
      description: Type.Optional(Type.String({ description: "One-line summary of what this agent specializes in" })),
      instructions: Type.String({ description: "Full Markdown instructions defining the agent's role, workflow, domain rules, and tone" }),
      avatar_gradient: Type.Optional(
        Type.Union(
          [
            Type.Literal("sunset"),
            Type.Literal("ocean"),
            Type.Literal("emerald"),
            Type.Literal("violet"),
            Type.Literal("amber"),
            Type.Literal("rose"),
            Type.Literal("cyan"),
            Type.Literal("slate"),
          ],
          { description: "Optional preset gradient color for the agent's avatar." },
        ),
      ),
      tool_groups: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional list of tool groups to pre-load (e.g. ['mysql', 'aws', 'code_search', 'jira', 'git', 'results', 'artifacts']).",
        }),
      ),
    }),
  },
];

export function saveAgentTool(
  store: AgentStore,
  args: {
    id?: string;
    name: string;
    slug?: string;
    description?: string;
    instructions: string;
    avatar_gradient?: string;
    tool_groups?: string[];
  },
): string {
  if (args.id) {
    const existing = store.get(args.id);
    if (!existing) return `No agent found with id=${args.id}`;
    const updated = store.update(args.id, {
      name: args.name,
      slug: args.slug,
      description: args.description,
      instructions: args.instructions,
      ...(args.avatar_gradient ? { avatar: { kind: "gradient", value: args.avatar_gradient } } : {}),
      ...(args.tool_groups ? { tool_groups: args.tool_groups } : {}),
    });
    if (!updated) return `Failed to update agent id=${args.id}`;
    return `Agent saved with id=${updated.id} (@${updated.slug})`;
  }

  const created = store.create({
    name: args.name,
    slug: args.slug,
    description: args.description,
    instructions: args.instructions,
    ...(args.avatar_gradient ? { avatar: { kind: "gradient", value: args.avatar_gradient } } : {}),
    tool_groups: args.tool_groups,
  });
  return `Agent saved with id=${created.id} (@${created.slug})`;
}
