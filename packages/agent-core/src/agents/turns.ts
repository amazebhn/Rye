/**
 * The turns of one `POST /chat/` request: the first reply, then any follow-up replies from other
 * agents (server.ts). While follow-ups are possible the first turn's `done` is held back and sent
 * here once they are over.
 */

/** What kind of `/chat/` request this is, which decides how custom agents may take part. */
export interface ChatRequestKind {
  /** An AI create/edit chat for an SOP, Skill or Agent (it sends `system_prompt_suffix`). */
  authoring: boolean;
  /** The web app's quick chat (`quick: true`): the floating panel, run on the low model tier. */
  quick: boolean;
  /** An `@slug` the user typed routes the turn to that agent. */
  tags: boolean;
  /** The decision model may pick an agent for an untagged message, and agents may reply after one another. */
  autoRoute: boolean;
}

/**
 * Authoring chats are Rye doing one job: never routed to an agent at all. The quick chat honours the
 * user's own `@slug` tags but never auto-routes or adds follow-up replies from other agents.
 */
export function chatRequestKind(body: { system_prompt_suffix?: unknown; quick?: unknown }): ChatRequestKind {
  const authoring = typeof body.system_prompt_suffix === "string" && body.system_prompt_suffix.trim() !== "";
  const quick = body.quick === true;
  return { authoring, quick, tags: !authoring, autoRoute: !authoring && !quick };
}

/** What one agent turn did (server.ts `streamOneTurn`). */
export interface TurnOutcome {
  text: string;
  /** Paused at the tool-round limit, asked the user, or failed: no follow-up replies after it. */
  stoppedEarly: boolean;
  finalSessionId: string;
  /** The turn reached its `done` (an answer, a pause or a question); an error never does. */
  ended: boolean;
}

export interface RunTurnsOptions {
  /** Follow-up replies are possible, so the first turn doesn't send its own `done`. */
  canFollowUp: boolean;
  first: () => Promise<TurnOutcome>;
  /** Runs the follow-up replies after the first; returns the last turn's session id. */
  followUps: (first: TurnOutcome) => Promise<string>;
  aborted: () => boolean;
  sendDone: (sessionId: string) => Promise<void>;
}

/**
 * The client needs a `done` to end every turn that ended: without one after a pause it never shows
 * Continue, keeps no reply and saves nothing. Only an error (sent on its own) or a cancel goes without.
 */
export async function runTurns(opts: RunTurnsOptions): Promise<void> {
  const first = await opts.first();
  // Without follow-ups the first turn sent its own `done`.
  if (!opts.canFollowUp || opts.aborted()) return;
  if (first.stoppedEarly) {
    if (first.ended) await opts.sendDone(first.finalSessionId);
    return;
  }
  const lastSessionId = await opts.followUps(first);
  if (!opts.aborted()) await opts.sendDone(lastSessionId);
}
