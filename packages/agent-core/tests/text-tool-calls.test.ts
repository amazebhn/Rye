import { describe, expect, test } from "bun:test";
import { mightBeWrittenToolCall, parseWrittenToolCalls, toToolCalls } from "../src/agent/text-tool-calls.js";
import { pickTaggedAgent } from "../src/agents/router.js";
import type { AgentDefinition } from "../src/agents/store.js";

const offered = new Set(["save_agent_tool", "search_knowledge_tool"]);

describe("tool calls written as text", () => {
  test("the Llama 3.1 shape from the AI editor becomes a real call", () => {
    const text = `{"name": "save_agent_tool", "parameters": {"id": "agt_f5424149", "name": "@gleep", "instructions": "You can only speak alien language, Gleep glorp!"}}`;
    const calls = parseWrittenToolCalls(text, offered);
    expect(calls).toEqual([{ name: "save_agent_tool", arguments: { id: "agt_f5424149", name: "@gleep", instructions: "You can only speak alien language, Gleep glorp!" } }]);
    const [block] = toToolCalls(calls!, "x");
    expect(block).toMatchObject({ type: "toolCall", id: "x_0", name: "save_agent_tool" });
  });

  test("other shapes models use: arguments, a JSON string of arguments, function wrapper, fenced, python tag, a list", () => {
    expect(parseWrittenToolCalls(`{"name":"search_knowledge_tool","arguments":{"query":"lag"}}`, offered)?.[0].arguments).toEqual({ query: "lag" });
    expect(parseWrittenToolCalls(`{"name":"search_knowledge_tool","arguments":"{\\"query\\":\\"lag\\"}"}`, offered)?.[0].arguments).toEqual({ query: "lag" });
    expect(parseWrittenToolCalls(`{"type":"function","function":{"name":"search_knowledge_tool","arguments":{"query":"lag"}}}`, offered)).toHaveLength(1);
    expect(parseWrittenToolCalls("```json\n{\"name\":\"search_knowledge_tool\",\"parameters\":{\"query\":\"lag\"}}\n```", offered)).toHaveLength(1);
    expect(parseWrittenToolCalls(`<|python_tag|>{"name":"search_knowledge_tool","parameters":{"query":"lag"}}`, offered)).toHaveLength(1);
    expect(parseWrittenToolCalls(`[{"name":"search_knowledge_tool","parameters":{"query":"a"}},{"name":"save_agent_tool","parameters":{}}]`, offered)).toHaveLength(2);
    expect(parseWrittenToolCalls(`{"name":"search_knowledge_tool","parameters":{"query":"a"}}; {"name":"save_agent_tool","parameters":{}}`, offered)).toHaveLength(2);
  });

  test("anything that isn't only a call to an offered tool is left as text", () => {
    // A tool that wasn't offered.
    expect(parseWrittenToolCalls(`{"name":"delete_everything","parameters":{}}`, offered)).toBeNull();
    // JSON data the model means to show, with a "name" in it.
    expect(parseWrittenToolCalls(`{"name":"save_agent_tool","parameters":{},"note":"example"}`, offered)).toBeNull();
    expect(parseWrittenToolCalls(`{"name":"Gleep","age":3}`, offered)).toBeNull();
    // Prose around the JSON.
    expect(parseWrittenToolCalls(`I'll call it: {"name":"save_agent_tool","parameters":{}}`, offered)).toBeNull();
    // One good call and one unknown.
    expect(parseWrittenToolCalls(`[{"name":"save_agent_tool","parameters":{}},{"name":"nope","parameters":{}}]`, offered)).toBeNull();
    expect(parseWrittenToolCalls(`{"name": "save_agent_tool", "parameters": {`, offered)).toBeNull();
  });

  test("streamed text is held back only while it could still be a written call", () => {
    for (const held of ["", "  ", "{", '{"na', "[", "<|python", "`", "``", "```", "```js", "```json", "```json\n", "```json\n{", "```\n{"]) {
      expect(mightBeWrittenToolCall(held)).toBe(true);
    }
    for (const shown of ["Sure", "The replica", "```ts\n", "```json\nhello", "```chart\n{", "{ hello", "- item", "# Title", "{x"]) {
      expect(mightBeWrittenToolCall(shown)).toBe(false);
    }
  });
});

describe("handing over to a tagged agent", () => {
  const agent = (id: string): AgentDefinition => ({ id, slug: id, name: id.toUpperCase() } as AgentDefinition);
  const [gleep, jibbles, marvin] = [agent("gleep"), agent("jibbles"), agent("marvin")];

  test("an agent tagged in the reply goes next, and is taken off the user's queue", () => {
    const queued = [jibbles, marvin];
    expect(pickTaggedAgent([marvin], queued, gleep.id)).toEqual({ agent: marvin, by: "reply" });
    expect(queued).toEqual([jibbles]);
  });

  test("without a tag in the reply, the next agent the user tagged goes", () => {
    const queued = [jibbles, marvin];
    expect(pickTaggedAgent([], queued, gleep.id)).toEqual({ agent: jibbles, by: "user" });
    expect(pickTaggedAgent([], queued, jibbles.id)).toEqual({ agent: marvin, by: "user" });
    expect(pickTaggedAgent([], queued, marvin.id)).toBeNull();
  });

  test("an agent tagging itself is not a hand-off", () => {
    expect(pickTaggedAgent([gleep], [], gleep.id)).toBeNull();
    expect(pickTaggedAgent([gleep, jibbles], [], gleep.id)).toEqual({ agent: jibbles, by: "reply" });
  });
});
