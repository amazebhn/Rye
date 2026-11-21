import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { shrinkOldToolResults } from "../src/agent/trim.js";

const assistant = (id: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "mysql_query_tool", arguments: {} }],
    stopReason: "toolUse",
    timestamp: 0,
  }) as unknown as AssistantMessage;

const result = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "mysql_query_tool",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

const textOf = (m: Message) => (m as ToolResultMessage).content.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("shrinkOldToolResults", () => {
  test("cuts large results before the latest assistant turn and keeps the latest ones", () => {
    const big = "x".repeat(10_000);
    const messages: Message[] = [
      { role: "user", content: "hi", timestamp: 0 },
      assistant("a"),
      result("a", big),
      assistant("b"),
      result("b", big),
    ];
    const out = shrinkOldToolResults(messages);

    expect(out).toHaveLength(messages.length);
    expect(textOf(out[2]).length).toBeLessThan(2_000);
    expect(textOf(out[2])).toContain("chars omitted from an earlier tool result");
    expect(textOf(out[2]).startsWith("xxx")).toBe(true);
    expect(textOf(out[4])).toBe(big);
    expect((out[2] as ToolResultMessage).toolCallId).toBe("a");
  });

  test("does not mutate the input", () => {
    const big = "y".repeat(5_000);
    const messages: Message[] = [assistant("a"), result("a", big), assistant("b")];
    shrinkOldToolResults(messages);
    expect(textOf(messages[1])).toBe(big);
  });

  test("leaves small results alone", () => {
    const messages: Message[] = [assistant("a"), result("a", "small"), assistant("b")];
    expect(shrinkOldToolResults(messages)[1]).toBe(messages[1]);
  });

  test("keeps a stored-result id that falls in the cut part", () => {
    const text = `${"z".repeat(3_000)}\nstored as result \`res_a1b2c3d4\`.`;
    const out = shrinkOldToolResults([assistant("a"), result("a", text), assistant("b")]);
    expect(textOf(out[1])).toContain("res_a1b2c3d4");
    expect(textOf(out[1])).toContain("result_query_tool");
  });
});
