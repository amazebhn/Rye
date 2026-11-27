import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { markSpeaker, speakersNote, type SpokenMessage } from "../src/agent/turn-context.js";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as Message;
const reply = (text: string, speaker?: string): Message =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
    ...(speaker ? { speaker } : {}),
  }) as unknown as Message;

describe("markSpeaker", () => {
  test("stamps only this turn's replies, and never overwrites a speaker", () => {
    const old = reply("earlier");
    const kept = reply("already stamped", "Marvin (@marvin)");
    const fresh = reply("new");
    const messages = [user("hi"), old, user("again"), kept, fresh];
    markSpeaker(messages, new Set([messages[0], old]), "Rye");
    expect((old as SpokenMessage).speaker).toBeUndefined();
    expect((kept as SpokenMessage).speaker).toBe("Marvin (@marvin)");
    expect((fresh as SpokenMessage).speaker).toBe("Rye");
    expect((messages[2] as SpokenMessage).speaker).toBeUndefined();
  });
});

describe("speakersNote", () => {
  test("is empty when every known reply is the current speaker's", () => {
    expect(speakersNote([user("a"), reply("one", "Rye"), user("b"), reply("two")], "Rye")).toBe("");
    expect(speakersNote([], "Rye")).toBe("");
  });

  test("names each earlier reply's speaker and who is speaking now", () => {
    const history = [
      user("@marvin who are you?"),
      reply("Sigh. I'm Marvin, a robot with a brain the size of a planet.", "Marvin (@marvin)"),
      user("thanks"),
      reply("You're welcome.", "Rye"),
    ];
    const note = speakersNote(history, "Rye");
    expect(note).toContain("1. Marvin (@marvin): \"Sigh. I'm Marvin");
    expect(note).toContain("2. Rye: \"You're welcome.\"");
    expect(note).toContain("You are Rye for this reply");
  });

  test("a turn's tool rounds and Rye's [System] notes count as one reply", () => {
    const history = [
      user("@marvin check it"),
      reply("", "Marvin (@marvin)"),
      user("[System] You have completed iteration 1 of tool use."),
      reply("All checked.", "Marvin (@marvin)"),
    ];
    const note = speakersNote(history, "Rye");
    expect(note).toContain("1. Marvin (@marvin): \"All checked.\"");
    expect(note).not.toContain("2.");
  });

  test("replies saved before speakers existed read as unknown", () => {
    const note = speakersNote([user("a"), reply("old reply"), user("b"), reply("hi", "Marvin (@marvin)")], "Rye");
    expect(note).toContain("1. unknown: \"old reply\"");
  });
});
