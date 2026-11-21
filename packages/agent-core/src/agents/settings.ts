/**
 * Agent collaboration & routing settings — persisted in DATA_DIR/agent-settings.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.js";

export const AGENT_CHATTINESS_LEVELS = ["off", "low", "medium", "high"] as const;
export type AgentChattiness = (typeof AGENT_CHATTINESS_LEVELS)[number];

export const AgentCollaborationSettingsSchema = z.object({
  /** When true, use the decision model to route untagged messages in generic chats to a relevant agent. */
  autoRoute: z.boolean().default(false),
  /** When true, allow other relevant agents to reply after an agent responds in a generic chat. */
  allowAgentReplies: z.boolean().default(false),
  /** Controls max agent-to-agent hops and relevance sensitivity. */
  chattiness: z.enum(AGENT_CHATTINESS_LEVELS).default("low"),
});

export type AgentCollaborationSettings = z.infer<typeof AgentCollaborationSettingsSchema>;

export const DEFAULT_AGENT_SETTINGS: AgentCollaborationSettings = {
  autoRoute: false,
  allowAgentReplies: false,
  chattiness: "low",
};

const SETTINGS_FILE = join(DATA_DIR, "agent-settings.json");

export function chattinessPolicy(level: AgentChattiness): { maxHops: number; minConfidence: number; guidance: string } {
  switch (level) {
    case "high":
      return {
        maxHops: 4,
        minConfidence: 0.48,
        guidance: "Be collaborative: pick another specialist if they can add useful context, verify a detail, or build on the previous reply.",
      };
    case "medium":
      return {
        maxHops: 2,
        minConfidence: 0.62,
        guidance: "Pick another specialist only if they have meaningful complementary expertise or an important angle not yet covered.",
      };
    case "low":
      return {
        maxHops: 1,
        minConfidence: 0.78,
        guidance: "Be conservative: pick another specialist ONLY if there is a clear gap, risk, or domain-specific follow-up that strongly needs them.",
      };
    case "off":
    default:
      return { maxHops: 0, minConfidence: 1, guidance: "" };
  }
}

export function readAgentSettings(filePath = SETTINGS_FILE): AgentCollaborationSettings {
  try {
    if (!existsSync(filePath)) return { ...DEFAULT_AGENT_SETTINGS };
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed = AgentCollaborationSettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ...DEFAULT_AGENT_SETTINGS };
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

export function writeAgentSettings(
  patch: Partial<AgentCollaborationSettings>,
  filePath = SETTINGS_FILE,
): AgentCollaborationSettings {
  const current = readAgentSettings(filePath);
  const next = AgentCollaborationSettingsSchema.parse({ ...current, ...patch });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}
