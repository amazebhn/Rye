/**
 * SOP extractor — uses the configured LLM to extract a structured SOP
 * from a natural language description of how an incident was resolved.
 */

import { type AssistantMessageEvent, type Context, type Message } from "@earendil-works/pi-ai";
import { getSettings } from "../config.js";
import { apiKeyFor, models, resolveModel } from "../llm-provider.js";
import { resolveTaskModelId } from "../model-tiers.js";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SOP_EXTRACTION_PROMPT = `You are extracting a Standard Operating Procedure (SOP) from a user's description of how they resolve a specific incident or issue.

Extract and return a JSON object with this exact structure:
{
  "title": "Short, descriptive title for the SOP",
  "description": "One sentence describing what problem this SOP solves",
  "tags": ["tag1", "tag2"],
  "content": "Full markdown-formatted runbook with all steps, context, and notes",
  "steps": [
    {
      "step_number": 1,
      "action": "What to do",
      "rationale": "Why this step matters",
      "tool_used": "aws|mysql|jira|git|none"
    }
  ]
}

Be thorough in the content field — include all details the user mentioned.
Return ONLY valid JSON, no markdown code blocks.`;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ExtractedSOP {
  title: string;
  description: string;
  tags: string[];
  content: string;
  steps: Array<{
    step_number: number;
    action: string;
    rationale?: string;
    tool_used?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export async function extractSopFromChat(userDescription: string): Promise<ExtractedSOP> {
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
    systemPrompt: SOP_EXTRACTION_PROMPT,
    messages,
    tools: [],
  };

  const s = models.stream(model, context, { apiKey });

  // Drain the stream (we only need the final result)
  for await (const event of s) {
    const ev = event as AssistantMessageEvent;
    if (ev.type === "error") {
      throw new Error(ev.error.errorMessage ?? "LLM error during SOP extraction");
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

  return JSON.parse(text) as ExtractedSOP;
}
