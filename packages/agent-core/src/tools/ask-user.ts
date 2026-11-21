/**
 * ask_user_tool — pauses the agent loop and prompts the user for structured input.
 *
 * This tool definition is used ONLY to register the tool schema for the LLM.
 * The loop in agent/loop.ts intercepts calls to this tool BEFORE executeTool
 * is reached, so the executor below is never called during normal usage.
 */

import { Type, type Tool } from "@earendil-works/pi-ai";
import type { PromptType } from "@rye/shared";

export const ASK_USER_TOOL_NAME = "ask_user_tool";
export const MAX_ASK_USER_OPTIONS = 8;
const MAX_OPTION_CHARS = 120;

export const askUserTools: Tool[] = [
  {
    name: ASK_USER_TOOL_NAME,
    description:
      "Pause and ask the user ONE clear question, then stop. " +
      "Put any findings or context in your normal message text BEFORE calling this tool — the question field is shown alone on a card, " +
      "so it must be just the question (one or two sentences, no findings, no 'meanwhile', no list of options). " +
      "prompt_type='choice' with 2–8 short, distinct `options` when there are discrete answers (set multi_select=true if several can apply); " +
      "prompt_type='yesno' for a yes/no confirmation; prompt_type='text' for open-ended answers. " +
      "The user can always type their own answer or let you decide instead. " +
      "Do not call other tools in the same turn; the answer arrives as the next user message.",
    parameters: Type.Object({
      prompt_type: Type.Union(
        [Type.Literal("yesno"), Type.Literal("choice"), Type.Literal("text")],
        { description: "How the user should answer: yesno | choice | text" }
      ),
      question: Type.String({ description: "Only the question itself, e.g. \"Which environment should I check?\"" }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: "For prompt_type='choice': 2–8 short option labels (no numbering)",
        })
      ),
      multi_select: Type.Optional(
        Type.Boolean({ description: "For prompt_type='choice': let the user pick more than one option" })
      ),
    }),
  },
];

export interface AskUserPrompt {
  prompt_type: PromptType;
  question: string;
  options?: string[];
  multi_select?: boolean;
}

/** Clean up the model's ask_user_tool arguments; returns an error message when there is no usable question. */
export function normalizeAskUserArgs(raw: Record<string, unknown>): AskUserPrompt | { error: string } {
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return { error: "ask_user_tool needs a non-empty `question`." };

  const options: string[] = [];
  for (const item of Array.isArray(raw.options) ? raw.options : []) {
    if (typeof item !== "string" || options.length >= MAX_ASK_USER_OPTIONS) continue;
    // Models often number or bullet options; the UI adds its own numbers.
    const label = item.trim().replace(/^(?:\d+[.)]|[-*•])\s+/, "").slice(0, MAX_OPTION_CHARS);
    if (label && !options.some((o) => o.toLowerCase() === label.toLowerCase())) options.push(label);
  }

  const type = raw.prompt_type;
  if (type === "yesno") return { prompt_type: "yesno", question };
  // A choice needs at least two options; otherwise fall back to a free-text question.
  if ((type === "choice" || type === undefined) && options.length >= 2) {
    return { prompt_type: "choice", question, options, ...(raw.multi_select === true ? { multi_select: true } : {}) };
  }
  return { prompt_type: "text", question };
}

// This executor should never be called — the loop intercepts ask_user_tool
// before dispatching to executeTool. If it somehow is called, return a sensible fallback.
export function askUserFallback(): string {
  return "User prompt could not be delivered. Please state your question directly in text.";
}
