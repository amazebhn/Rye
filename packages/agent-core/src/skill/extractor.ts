/**
 * Skill extractor — uses the configured LLM to turn a natural-language
 * description (or a chat transcript) into a structured SKILL.md-style Skill.
 */

import { type AssistantMessageEvent, type Context, type Message } from "@earendil-works/pi-ai";
import { getSettings } from "../config.js";
import { apiKeyFor, models, resolveModel } from "../llm-provider.js";
import { resolveTaskModelId } from "../model-tiers.js";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SKILL_EXTRACTION_PROMPT = `You are extracting a reusable agent Skill from a user's description of how to handle a domain or task.

A Skill is a SKILL.md-style playbook that teaches the agent HOW to approach a class of problems (not a one-off runbook for a single incident).

Extract and return a JSON object with this exact structure:
{
  "title": "Short, descriptive title for the Skill",
  "description": "One sentence describing WHEN this Skill should be used (its trigger)",
  "content": "Full markdown playbook: when to use it, the approach, steps, gotchas, and examples"
}

Guidelines:
- The description is a trigger — it must make it obvious when to reach for this Skill.
- Be thorough in the content field; include all techniques, tools, and caveats the user mentioned.
- Return ONLY valid JSON, no markdown code blocks.`;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ExtractedSkill {
  title: string;
  description: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export async function extractSkillFromChat(userDescription: string): Promise<ExtractedSkill> {
  const settings = getSettings();
  const model = await resolveModel(settings, await resolveTaskModelId(settings, "extraction"));
  const apiKey = await apiKeyFor(model);

  const messages: Message[] = [
    {
      role: "user",
      content: userDescription,
      timestamp: Date.now(),
    },
  ];

  const context: Context = {
    systemPrompt: SKILL_EXTRACTION_PROMPT,
    messages,
    tools: [],
  };

  const s = models.stream(model, context, { apiKey });

  // Drain the stream (we only need the final result)
  for await (const event of s) {
    const ev = event as AssistantMessageEvent;
    if (ev.type === "error") {
      throw new Error(ev.error.errorMessage ?? "LLM error during Skill extraction");
    }
  }

  const result = await s.result();

  // Collect all text blocks from the response
  let text = result.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Strip markdown fences if the model wrapped the JSON anyway
  text = text.trim();
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    text = lines.slice(1, lines.at(-1)?.trim() === "```" ? -1 : undefined).join("\n");
  }

  return JSON.parse(text) as ExtractedSkill;
}
