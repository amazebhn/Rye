// Continuing after the tool-round limit is a UI action, not words the user typed.
export const CONTINUE_MESSAGE =
  "[System] The user chose to continue the investigation. Pick up where you stopped: don't repeat tool calls you already made, and answer as soon as the evidence supports it.";

export function toolLimitMessage(rounds: number): string {
  return `Paused after ${rounds} tool-call rounds.`;
}

/** The user message for a POST /chat/ body; `continue: true` replaces the text. Undefined when there is none. */
export function turnMessage(body: { message?: unknown; continue?: unknown }): string | undefined {
  if (body.continue === true) return CONTINUE_MESSAGE;
  return typeof body.message === "string" && body.message.trim() ? body.message : undefined;
}
