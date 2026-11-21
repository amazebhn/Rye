/**
 * Subagent tool — lets the main agent spawn up to 3 parallel focused subagents.
 */

import { Type, type Tool } from "@earendil-works/pi-ai";
import { runSubagents } from "../agent/subagent.js";

export async function spawnSubagents(args: { tasks: string[] }, sessionId?: string): Promise<string> {
  const { tasks } = args;
  if (!tasks || tasks.length === 0) return "No tasks provided.";

  const results = await runSubagents(tasks, undefined, sessionId);

  return results
    .map(({ task, result }, i) =>
      `## Subagent ${i + 1}: ${task}\n\n${result}`
    )
    .join("\n\n---\n\n");
}

export const subagentTools: Tool[] = [
  {
    name: "spawn_subagents_tool",
    description: `Spawn up to 3 parallel subagents, each given a focused task. Use this to investigate multiple independent angles simultaneously — e.g. "check CloudWatch for errors", "check ECS service health", "query DB for recent failures". Each subagent has access to all tools and runs its own tool-call loop to completion. Results are returned together when all finish. Do NOT use for tasks that depend on each other's results.`,
    parameters: Type.Object({
      tasks: Type.Array(
        Type.String({ description: "A self-contained task description for one subagent." }),
        {
          description: "List of independent tasks to run in parallel (max 3).",
          minItems: 1,
          maxItems: 3,
        }
      ),
    }),
  },
];
