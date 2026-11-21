import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { getSettings, type Settings } from "../src/config.js";
import { TOOLS } from "../src/tools/index.js";
import { CORE_GROUP, buildToolGroups, defaultToolGroupSelector } from "../src/tools/groups.js";
import {
  buildClefRequests,
  clefDecide,
  clefEndpoint,
  clefTarget,
  noulProbability,
  parseClefResponse,
  resolveClefModel,
} from "../src/decision/clef.js";
import { parseChatAnswers, runChatDecision } from "../src/decision/chat.js";
import {
  buildDecisionState,
  createDecisionToolGroupSelector,
  historyDigest,
  picksFromAnswers,
  toolGroupQuestions,
  unionSelection,
} from "../src/decision/tool-groups.js";
import type { Answers, DecisionUsage, Questions } from "../src/decision/types.js";

const base = getSettings();
const withDecision = (decision: Partial<Settings["decision"]>, clef: Partial<Settings["decision"]["clef"]> = {}): Settings => ({
  ...base,
  decision: {
    provider: "off",
    model: "",
    timeout_ms: 2500,
    tool_threshold: 0.5,
    ...decision,
    clef: { base_url: "", account_id: "", api_token: "", ...clef },
  },
});

const nouls = (n: number): Questions =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: "noul", instructions: `question ${i}` }]));

const mixed: Questions = {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Outages" } },
  severity: { type: "score", instructions: "How severe?", criteria: ["None", "Minor", "Major", "Critical"] },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("clef request building", () => {
  test("chunks past 64 questions, keeping state and model on every request", () => {
    const reqs = buildClefRequests({ s: 1 }, nouls(130), "clef");
    expect(reqs.map((r) => Object.keys(r.questions).length)).toEqual([64, 64, 2]);
    expect(reqs.every((r) => r.model === "clef" && (r.state as { s: number }).s === 1)).toBe(true);
    expect(Object.keys(reqs[2].questions)).toEqual(["q128", "q129"]);
  });

  test("a single request for ≤64 questions", () => {
    expect(buildClefRequests("s", nouls(64), "clef-flash")).toHaveLength(1);
  });

  test("rejects ids Jev doesn't allow", () => {
    expect(() => buildClefRequests("s", { "mcp:grafana": { type: "noul", instructions: "x" } }, "clef")).toThrow(/invalid question id/);
  });

  test("model falls back to clef-flash for blank or non-Clef ids", () => {
    expect(resolveClefModel("")).toBe("clef-flash");
    expect(resolveClefModel("llama3.2")).toBe("clef-flash");
    expect(resolveClefModel("clef")).toBe("clef");
  });

  test("endpoint: self-hosted wins, else Cloudflare with bearer", () => {
    expect(clefEndpoint({ base_url: "http://box:8080/", account_id: "a", api_token: "t" }, "clef")).toEqual({
      url: "http://box:8080/v1/systemone",
      headers: { "Content-Type": "application/json" },
    });
    const cf = clefEndpoint({ base_url: "", account_id: "acc", api_token: "tok" }, "clef-flash");
    expect(cf.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash");
    expect(cf.headers.Authorization).toBe("Bearer tok");
  });

  test("unresolved ${VAR} secrets count as not configured", () => {
    expect(clefTarget({ base_url: "", account_id: "acc", api_token: "${CF_TOKEN}" })).toBeNull();
    expect(() => clefEndpoint({ base_url: "", account_id: "", api_token: "" }, "clef")).toThrow(/not configured/);
  });
});

describe("clef response parsing", () => {
  const answers = {
    urgent: { type: "noul", noul: 0.82 },
    team: { type: "choice", choice: "technical", confidence: 0.9, probabilities: { billing: 0.1, technical: 0.9 } },
    severity: { type: "score", score: 2.3, confidence: 0.6, legend: { "0": "None" }, probabilities: { "2": 0.7, "3": 0.3 } },
  };

  test("unwrapped SystemOne body", () => {
    const parsed = parseClefResponse({ model: "clef", answers, usage: { input_tokens: 120, output_tokens: 3 } }, mixed);
    expect(parsed.answers.urgent).toEqual({ type: "noul", noul: 0.82 });
    expect(parsed.answers.team).toMatchObject({ choice: "technical", confidence: 0.9 });
    expect(parsed.answers.severity).toMatchObject({ score: 2.3, probabilities: { "2": 0.7, "3": 0.3 } });
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 3 });
  });

  test("Cloudflare { result, success, errors } wrapper", () => {
    const parsed = parseClefResponse({ result: { model: "clef", answers, usage: { input_tokens: 5, output_tokens: 0 } }, success: true, errors: [] }, mixed);
    expect(parsed.answers.urgent).toEqual({ type: "noul", noul: 0.82 });
    expect(parsed.model).toBe("clef");
  });

  test("Cloudflare failure surfaces the error messages", () => {
    expect(() => parseClefResponse({ result: null, success: false, errors: [{ code: 7, message: "bad input" }] }, mixed)).toThrow(/bad input/);
  });

  test("noul answers: bare number, { noul }, { probability }, { probabilities.true }", () => {
    expect(noulProbability(0.3)).toBe(0.3);
    expect(noulProbability({ type: "noul", noul: 0.4 })).toBe(0.4);
    expect(noulProbability({ probability: 0.5 })).toBe(0.5);
    expect(noulProbability({ probabilities: { true: 0.6, false: 0.4 } })).toBe(0.6);
    expect(noulProbability({ nothing: 1 })).toBeUndefined();
    const q = { a: { type: "noul", instructions: "a" } } as Questions;
    expect(parseClefResponse({ answers: { a: 0.9 } }, q).answers.a).toEqual({ type: "noul", noul: 0.9 });
    expect(() => parseClefResponse({ answers: { a: { nope: true } } }, q)).toThrow(/noul/);
  });

  test("choice/score fill confidence from probabilities, score legend from criteria", () => {
    const parsed = parseClefResponse(
      { answers: { team: { choice: "billing", probabilities: { billing: 0.7, technical: 0.3 } }, severity: { score: 1, probabilities: [0.1, 0.8, 0.1, 0] } } },
      mixed,
    );
    expect(parsed.answers.team).toMatchObject({ confidence: 0.7 });
    expect(parsed.answers.severity).toMatchObject({ confidence: 0.8, legend: { "0": "None", "3": "Critical" }, probabilities: { "1": 0.8 } });
  });

  test("missing answers are skipped, not invented", () => {
    expect(Object.keys(parseClefResponse({ answers: { urgent: 1 } }, mixed).answers)).toEqual(["urgent"]);
    expect(() => parseClefResponse({ nothing: true }, mixed)).toThrow(/no answers/);
  });
});

describe("clefDecide (mocked fetch)", () => {
  test("chunks into parallel requests, merges answers, reports usage per call", async () => {
    const bodies: Array<{ questions: Record<string, unknown> }> = [];
    const auth: Array<string | null> = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      auth.push(new Headers(init?.headers).get("authorization"));
      const result = { model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.7 }])), usage: { input_tokens: 10, output_tokens: 0 } };
      return new Response(JSON.stringify({ result, success: true, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const usage: DecisionUsage[] = [];
    const answers = await clefDecide(withDecision({ provider: "clef", model: "clef" }, { account_id: "acc", api_token: "tok" }), "state", nouls(70), {
      onUsage: (u) => usage.push(u),
    });
    expect(bodies.map((b) => Object.keys(b.questions).length).sort()).toEqual([6, 64]);
    expect(auth).toEqual(["Bearer tok", "Bearer tok"]);
    expect(Object.keys(answers)).toHaveLength(70);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ provider: "cloudflare", model: "clef", inputTokens: 10 });
  });

  test("HTTP errors don't leak the token", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 401 })) as unknown as typeof fetch;
    const err = await clefDecide(withDecision({ provider: "clef" }, { account_id: "acc", api_token: "secret-token" }), "s", nouls(1)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain("secret-token");
  });
});

describe("chat backend validation", () => {
  test("valid reply converts to Jev-shaped answers", () => {
    const answers = parseChatAnswers('{"urgent": true, "team": "billing", "severity": 2}', mixed);
    expect(answers.urgent).toEqual({ type: "noul", noul: 1 });
    expect(answers.team).toMatchObject({ choice: "billing", probabilities: { billing: 1, technical: 0 } });
    expect(answers.severity).toMatchObject({ score: 2, probabilities: { "2": 1, "0": 0 } });
  });

  test("tolerates fences, think blocks, string booleans and probabilities", () => {
    const text = '<think>hmm {"x":1}</think>```json\n{"urgent": "false", "team": "technical", "severity": 0}\n```';
    expect(parseChatAnswers(text, mixed).urgent).toEqual({ type: "noul", noul: 0 });
    expect(parseChatAnswers('{"urgent": 0.7, "team": "technical", "severity": 0}', mixed).urgent).toEqual({ type: "noul", noul: 0.7 });
  });

  test("rejects unknown options, out-of-range scores, missing keys and non-JSON", () => {
    expect(() => parseChatAnswers('{"urgent": true, "team": "sales", "severity": 1}', mixed)).toThrow(/team/);
    expect(() => parseChatAnswers('{"urgent": true, "team": "billing", "severity": 4}', mixed)).toThrow(/severity/);
    expect(() => parseChatAnswers('{"urgent": true, "team": "billing"}', mixed)).toThrow(/severity/);
    expect(() => parseChatAnswers("I think yes", mixed)).toThrow(/no JSON/);
    expect(() => parseChatAnswers("{urgent: yes}", mixed)).toThrow(/not valid JSON/);
  });
});

const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "ollama",
    model: "m",
    usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  }) as AssistantMessage;

describe("runChatDecision (mocked model call)", () => {
  const q: Questions = { a: { type: "noul", instructions: "a?" } };

  test("re-asks once after an invalid reply, with the validation error", async () => {
    const contexts: Context[] = [];
    const replies = [reply("sure!"), reply('{"a": true}')];
    const usage: number[] = [];
    const answers = await runChatDecision(
      async (ctx) => {
        contexts.push(structuredClone(ctx));
        return replies.shift()!;
      },
      "state",
      q,
      (u) => usage.push(u.inputTokens),
    );
    expect(answers.a).toEqual({ type: "noul", noul: 1 });
    expect(contexts).toHaveLength(2);
    const last = contexts[1].messages.at(-1) as Message & { content: string };
    expect(last.content).toContain("invalid");
    expect(usage).toEqual([50, 50]);
  });

  test("fails after two invalid replies", async () => {
    let calls = 0;
    await expect(runChatDecision(async () => (calls++, reply("nope")), "s", q)).rejects.toThrow(/invalid reply twice/);
    expect(calls).toBe(2);
  });

  test("a provider error fails immediately", async () => {
    const err = { ...reply(""), errorMessage: "boom" };
    await expect(runChatDecision(async () => ({ ...err, stopReason: "error" }) as AssistantMessage, "s", q)).rejects.toThrow("boom");
  });

  test("prompt lists each question with its allowed values", async () => {
    let prompt = "";
    await runChatDecision(async (ctx) => {
      prompt = String(ctx.messages[0].content);
      return reply('{"urgent": false, "team": "billing", "severity": 0}');
    }, { user_message: "hi" }, mixed);
    expect(prompt).toContain('"urgent": true | false');
    expect(prompt).toContain('"team": "billing" | "technical"');
    expect(prompt).toContain('"severity": 0..3');
  });
});

describe("decision tool-group selector", () => {
  const groups = buildToolGroups([...TOOLS, { name: "mcp__grafana__query", description: "x", parameters: {} as never }]);
  const optional = groups.filter((g) => g.id !== CORE_GROUP);
  const input = (userMessage: string, previouslyEnabled: string[] = []) => ({
    userMessage,
    history: [] as Message[],
    availableGroups: optional,
    previouslyEnabled,
  });
  const yesTo = (wanted: string[]) =>
    mock(async (_state: unknown, questions: Questions): Promise<Answers> =>
      Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: "noul" as const, noul: wanted.some((w) => q.instructions.includes(`the ${w} tools`)) ? 0.9 : 0.1 }])),
    );
  const selector = (provider: Settings["decision"]["provider"], decide: ReturnType<typeof yesTo> | (() => Promise<Answers>), timeout_ms = 2500) =>
    createDecisionToolGroupSelector({
      settings: () => withDecision({ provider, timeout_ms }),
      decide: decide as never,
      recordUsage: () => {},
    });

  test("off: exactly the keyword selector, no decision call", async () => {
    const decide = yesTo(["aws"]);
    const picked = await selector("off", decide)(input("run a mysql query"));
    expect(picked).toEqual(await defaultToolGroupSelector(input("run a mysql query")));
    expect(decide).not.toHaveBeenCalled();
  });

  test("union: decision adds groups, keyword and previous picks stay", async () => {
    const decide = yesTo(["aws", "mcp:grafana"]);
    const picked = await selector("chat", decide)(input("run a mysql query", ["jira"]));
    expect(new Set(picked)).toEqual(new Set(["mysql", "jira", "aws", "mcp:grafana"]));
    const [state, questions] = decide.mock.calls[0];
    // Only undecided groups are asked about, with Jev-safe ids.
    expect(Object.keys(questions)).not.toContain("mysql");
    expect(Object.keys(questions)).toContain("mcp_grafana");
    expect(state).toMatchObject({ user_message: "run a mysql query", enabled_tool_groups: ["jira", "mysql"] });
  });

  test("below-threshold answers add nothing", async () => {
    const picked = await selector("clef", yesTo([]))(input("hello"));
    expect(picked).toEqual([]);
  });

  test("errors fall back to keyword picks", async () => {
    const picked = await selector("clef", async () => {
      throw new Error("Clef is not configured");
    })(input("check the jira ticket"));
    expect(picked).toEqual(["jira"]);
  });

  test("timeouts fall back quickly", async () => {
    const started = Date.now();
    const picked = await selector("chat", () => new Promise<Answers>(() => {}), 50)(input("check the jira ticket"));
    expect(picked).toEqual(["jira"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("no call when every group is already enabled", async () => {
    const decide = yesTo([]);
    await selector("chat", decide)(input("x", optional.map((g) => g.id)));
    expect(decide).not.toHaveBeenCalled();
  });

  test("helpers: question ids, picks and union", () => {
    const { questions, groupByQuestion } = toolGroupQuestions([
      { id: "mcp:a-b", description: "d", tools: [] },
      { id: "mcp_a-b", description: "d", tools: [] },
    ]);
    expect(Object.keys(questions)).toEqual(["mcp_a-b", "mcp_a-b_2"]);
    expect(picksFromAnswers({ "mcp_a-b": { type: "noul", noul: 0.5 }, "mcp_a-b_2": { type: "noul", noul: 0.49 } }, groupByQuestion, 0.5)).toEqual(["mcp:a-b"]);
    expect(unionSelection(["a"], ["b", "a"], ["c"])).toEqual(["a", "b", "c"]);
  });
});

describe("decision state", () => {
  test("history digest drops tool output and stays within budget", () => {
    const history: Message[] = [
      { role: "user", content: "first question ".repeat(50), timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", id: "1", name: "mysql_query_tool", arguments: {} }] } as never,
      { role: "toolResult", toolCallId: "1", toolName: "mysql_query_tool", content: [{ type: "text", text: "SECRET ROWS" }], isError: false, timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "found it" }] } as never,
    ];
    const digest = historyDigest(history);
    expect(digest).not.toContain("SECRET ROWS");
    expect(digest).toContain("[called mysql_query_tool]");
    expect(digest.split("\n").at(-1)).toBe("Assistant: found it");
    expect(digest.length).toBeLessThanOrEqual(1500);
    expect(historyDigest(history, 40)).toBe("Assistant: found it");
  });

  test("user message is truncated to 4000 chars", () => {
    const state = buildDecisionState({ userMessage: "x".repeat(9000), history: [], availableGroups: [], previouslyEnabled: [] }, []);
    expect((state.user_message as string).length).toBe(4000);
    expect(state).not.toHaveProperty("recent_history");
  });
});
