/**
 * Agent router — uses explicit @mentions first, then optionally the decision
 * model to route untagged messages in generic chats and orchestrate
 * agent-to-agent follow-up replies based on chattiness settings.
 */

import { getSettings } from "../config.js";
import { decide, type Answers, type ChoiceAnswer, type DecideOptions, type Questions } from "../decision/index.js";
import type { AgentDefinition } from "./store.js";
import { chattinessPolicy, type AgentChattiness } from "./settings.js";

export interface RecentTurn {
  role: "user" | "assistant";
  speaker: string;
  content: string;
}

export type DecideFn = (state: unknown, questions: Questions, opts?: DecideOptions) => Promise<Answers>;

const AUTO_ROUTE_MIN_CONFIDENCE = 0.65;

function summarizeAgent(agent: AgentDefinition): string {
  const desc = agent.description.trim();
  if (desc) return `${agent.name}: ${desc}`;
  return `${agent.name}: ${agent.instructions.slice(0, 140).replace(/\s+/g, " ").trim()}`;
}

/**
 * Pick the best specialist agent for an untagged user message in a generic chat.
 * Returns null when general Rye should handle the turn.
 */
export async function pickAutoRoutedAgent(opts: {
  message: string;
  recentTurns: RecentTurn[];
  agents: AgentDefinition[];
  signal?: AbortSignal;
  decideFn?: DecideFn;
}): Promise<AgentDefinition | null> {
  if (opts.agents.length === 0) return null;
  if (!opts.decideFn && getSettings().decision.provider === "off") return null;

  const criteria: Record<string, string> = {
    rye: "General production support assistant — use this for general questions or when no specialist clearly fits.",
  };
  const bySlug = new Map<string, AgentDefinition>();
  for (const agent of opts.agents) {
    criteria[agent.slug] = summarizeAgent(agent);
    bySlug.set(agent.slug, agent);
  }

  const runDecide = opts.decideFn ?? decide;
  try {
    const answers = await runDecide(
      {
        latest_user_message: opts.message.slice(0, 1500),
        recent_conversation: opts.recentTurns.slice(-6).map((t) => ({
          speaker: t.speaker,
          excerpt: t.content.slice(0, 400),
        })),
      },
      {
        responder: {
          type: "choice",
          instructions:
            "Choose which agent should respond to the latest user message. Pick a specialist only if the message clearly falls in their domain; otherwise pick 'rye'.",
          criteria,
        },
      },
      { signal: opts.signal },
    );

    const ans = answers.responder as ChoiceAnswer | undefined;
    if (!ans || ans.type !== "choice" || ans.choice === "rye") return null;
    if (ans.confidence < AUTO_ROUTE_MIN_CONFIDENCE) return null;
    return bySlug.get(ans.choice) ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide whether another agent should chime in after `lastSpeaker` responded.
 * Returns null when the conversation should pause and wait for the user.
 */
export async function pickFollowUpAgent(opts: {
  recentTurns: RecentTurn[];
  lastSpeakerId: string | null;
  agents: AgentDefinition[];
  chattiness: AgentChattiness;
  hopIndex: number;
  signal?: AbortSignal;
  decideFn?: DecideFn;
}): Promise<AgentDefinition | null> {
  const policy = chattinessPolicy(opts.chattiness);
  if (policy.maxHops <= 0 || opts.hopIndex >= policy.maxHops) return null;

  const candidates = opts.agents.filter((a) => a.id !== opts.lastSpeakerId);
  if (candidates.length === 0) return null;
  if (!opts.decideFn && getSettings().decision.provider === "off") return null;

  const criteria: Record<string, string> = {
    none: "No other agent needs to reply; hand back to the user.",
  };
  const bySlug = new Map<string, AgentDefinition>();
  for (const agent of candidates) {
    criteria[agent.slug] = summarizeAgent(agent);
    bySlug.set(agent.slug, agent);
  }

  const runDecide = opts.decideFn ?? decide;
  try {
    const answers = await runDecide(
      {
        recent_conversation: opts.recentTurns.slice(-6).map((t) => ({
          speaker: t.speaker,
          excerpt: t.content.slice(0, 600),
        })),
        follow_up_hop: opts.hopIndex + 1,
        max_hops: policy.maxHops,
      },
      {
        next_speaker: {
          type: "choice",
          instructions: `Decide if another specialist agent should reply next. ${policy.guidance} Otherwise choose 'none'.`,
          criteria,
        },
      },
      { signal: opts.signal },
    );

    const ans = answers.next_speaker as ChoiceAnswer | undefined;
    if (!ans || ans.type !== "choice" || ans.choice === "none") return null;
    if (ans.confidence < policy.minConfidence) return null;
    return bySlug.get(ans.choice) ?? null;
  } catch {
    return null;
  }
}
