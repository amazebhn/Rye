import { describe, expect, test } from "bun:test";
import { CONTINUE_MESSAGE, toolLimitMessage, turnMessage } from "../src/agent/continue.js";

describe("turnMessage", () => {
  test("continue: true sends the continuation instruction instead of the text", () => {
    expect(turnMessage({ continue: true })).toBe(CONTINUE_MESSAGE);
    expect(turnMessage({ continue: true, message: "continue" })).toBe(CONTINUE_MESSAGE);
  });

  test("a normal message passes through unchanged", () => {
    expect(turnMessage({ message: "  check db-1  " })).toBe("  check db-1  ");
    expect(turnMessage({ message: "continue", continue: "yes" })).toBe("continue");
  });

  test("no usable message", () => {
    expect(turnMessage({})).toBeUndefined();
    expect(turnMessage({ message: "   " })).toBeUndefined();
    expect(turnMessage({ message: 5 })).toBeUndefined();
  });
});

test("toolLimitMessage names the round count", () => {
  expect(toolLimitMessage(10)).toBe("Paused after 10 tool-call rounds.");
});
