import { describe, expect, test } from "bun:test";
import { MAX_ASK_USER_OPTIONS, normalizeAskUserArgs } from "../src/tools/ask-user.js";

describe("normalizeAskUserArgs", () => {
  test("rejects a missing or blank question", () => {
    expect(normalizeAskUserArgs({ prompt_type: "text" })).toHaveProperty("error");
    expect(normalizeAskUserArgs({ prompt_type: "text", question: "   " })).toHaveProperty("error");
  });

  test("trims the question", () => {
    expect(normalizeAskUserArgs({ prompt_type: "text", question: "  Which host?  " })).toEqual({
      prompt_type: "text",
      question: "Which host?",
    });
  });

  test("strips numbering and bullets, drops blanks, non-strings and case-insensitive duplicates", () => {
    const result = normalizeAskUserArgs({
      prompt_type: "choice",
      question: "Which environment?",
      options: ["1. production", "2) Staging", "- dev", "• qa", "Production", "", 42, "staging"],
    });
    expect(result).toEqual({ prompt_type: "choice", question: "Which environment?", options: ["production", "Staging", "dev", "qa"] });
  });

  test("caps options and their length", () => {
    const options = Array.from({ length: 12 }, (_, i) => `option ${i} ${"x".repeat(200)}`);
    const result = normalizeAskUserArgs({ prompt_type: "choice", question: "Pick", options });
    if ("error" in result) throw new Error(result.error);
    expect(result.options).toHaveLength(MAX_ASK_USER_OPTIONS);
    expect(result.options!.every((o) => o.length <= 120)).toBe(true);
  });

  test("a choice with fewer than two options becomes a text question", () => {
    expect(normalizeAskUserArgs({ prompt_type: "choice", question: "Pick", options: ["only one"] })).toEqual({
      prompt_type: "text",
      question: "Pick",
    });
  });

  test("yes/no drops options and multi_select", () => {
    expect(normalizeAskUserArgs({ prompt_type: "yesno", question: "Restart?", options: ["Yes", "No"], multi_select: true })).toEqual({
      prompt_type: "yesno",
      question: "Restart?",
    });
  });

  test("multi_select only when explicitly true on a choice", () => {
    const base = { prompt_type: "choice", question: "Which services?", options: ["api", "worker"] };
    expect(normalizeAskUserArgs({ ...base, multi_select: true })).toHaveProperty("multi_select", true);
    expect(normalizeAskUserArgs({ ...base, multi_select: "true" })).not.toHaveProperty("multi_select");
    expect(normalizeAskUserArgs({ ...base, prompt_type: "text", multi_select: true })).not.toHaveProperty("multi_select");
  });
});
