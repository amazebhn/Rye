import { describe, expect, test } from "bun:test";
import { chatRequestKind, runTurns, type RunTurnsOptions, type TurnOutcome } from "../src/agents/turns.js";
import { QuickRewindSchema, rewindPlan, StoredRewindSchema } from "../src/chat/rewind.js";

const outcome = (patch: Partial<TurnOutcome> = {}): TurnOutcome => ({
  text: "reply",
  stoppedEarly: false,
  finalSessionId: "s1",
  ended: true,
  ...patch,
});

/** Runs the turns with a fake first turn and records what was sent after it. */
async function run(first: TurnOutcome, opts: Partial<RunTurnsOptions> = {}) {
  const done: string[] = [];
  let followedUp = false;
  await runTurns({
    canFollowUp: true,
    first: async () => first,
    followUps: async () => {
      followedUp = true;
      return "s2";
    },
    aborted: () => false,
    sendDone: async (id) => void done.push(id),
    ...opts,
  });
  return { done, followedUp };
}

describe("runTurns", () => {
  // Regression: with agent replies on, a turn paused at the tool-round limit sent `pause` and then
  // closed the stream without `done`, so the web app showed no Continue and lost the reply.
  test("a first turn paused at the tool-round limit still gets its done, with no follow-ups", async () => {
    const { done, followedUp } = await run(outcome({ stoppedEarly: true, ended: true }));
    expect(done).toEqual(["s1"]);
    expect(followedUp).toBe(false);
  });

  test("a first turn that asked the user also gets its done", async () => {
    expect((await run(outcome({ stoppedEarly: true, ended: true }))).done).toEqual(["s1"]);
  });

  test("an error ends the stream without done", async () => {
    const { done, followedUp } = await run(outcome({ stoppedEarly: true, ended: false }));
    expect(done).toEqual([]);
    expect(followedUp).toBe(false);
  });

  test("a finished first turn runs the follow-ups, then one done for the last turn", async () => {
    const { done, followedUp } = await run(outcome());
    expect(followedUp).toBe(true);
    expect(done).toEqual(["s2"]);
  });

  test("without follow-ups the first turn sends its own done, so none is added", async () => {
    expect((await run(outcome({ stoppedEarly: true }), { canFollowUp: false })).done).toEqual([]);
    expect((await run(outcome(), { canFollowUp: false })).done).toEqual([]);
  });

  test("a cancelled run sends no done", async () => {
    expect((await run(outcome({ stoppedEarly: true }), { aborted: () => true })).done).toEqual([]);
    expect((await run(outcome(), { aborted: () => true })).done).toEqual([]);
  });
});

describe("chatRequestKind", () => {
  const plain = { authoring: false, quick: false, tags: true, autoRoute: true };

  test("a plain chat takes tags, auto-routing and follow-ups", () => {
    expect(chatRequestKind({})).toEqual(plain);
    expect(chatRequestKind({ system_prompt_suffix: "   " })).toEqual(plain);
  });

  test("an authoring chat is never routed to agents", () => {
    expect(chatRequestKind({ system_prompt_suffix: "Edit this SOP" })).toEqual({ authoring: true, quick: false, tags: false, autoRoute: false });
  });

  test("a quick chat takes the user's tags but never auto-routes or follows up", () => {
    expect(chatRequestKind({ quick: true })).toEqual({ authoring: false, quick: true, tags: true, autoRoute: false });
  });

  test("only a literal true makes a quick chat", () => {
    for (const quick of ["true", 1, "yes", null, false]) expect(chatRequestKind({ quick })).toEqual(plain);
  });
});

describe("rewindPlan", () => {
  const msgs = [
    { role: "user", content: "first", id: "t1" },
    { role: "assistant", content: "one" },
    { role: "user", content: "second", id: "t2" },
    { role: "assistant", content: "two" },
  ];

  test("keeps the turns before the user message and slices exactly when the dropped turns are tagged", () => {
    expect(rewindPlan(msgs, 2)).toEqual({
      kept: [
        { role: "user", content: "first", id: "t1" },
        { role: "assistant", content: "one", id: undefined },
      ],
      exact: true,
    });
  });

  test("an untagged dropped user turn means rebuilding", () => {
    const untagged = [...msgs.slice(0, 2), { role: "user", content: "second" }, msgs[3]];
    expect(rewindPlan(untagged, 2)).toMatchObject({ exact: false });
  });

  test("the index must name a user message", () => {
    expect(rewindPlan(msgs, 1)).toEqual({ error: "Rewind index must point at a user message" });
    expect(rewindPlan(msgs, 9)).toEqual({ error: "Rewind index must point at a user message" });
  });

  test("a quick chat's rewind sends its messages; a stored chat's names itself", () => {
    expect(QuickRewindSchema.safeParse({ index: 2, messages: msgs }).success).toBe(true);
    expect(QuickRewindSchema.safeParse({ chat_id: "c1", index: 2 }).success).toBe(false);
    expect(StoredRewindSchema.safeParse({ chat_id: "c1", index: 2 }).success).toBe(true);
    expect(StoredRewindSchema.safeParse({ index: 2, messages: msgs }).success).toBe(false);
  });
});
