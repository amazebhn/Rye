/**
 * The code-session tools (tools/code.ts): start_code_session_tool only proposes, the user's next
 * message decides; code_session_status_tool reads. Scripted engine, temporary repos.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { getTools, executeTool } from "../src/tools/index.js";
import {
  CODE_TOOL_NAMES,
  codeSessionStatusForAgent,
  prepareCodeSessionStart,
  resolvePendingCodeSessionStart,
  setCodeToolService,
} from "../src/tools/code.js";
import { cleanup, codeHarness } from "./code-test-utils.js";

afterAll(cleanup);
afterEach(() => setCodeToolService(null));
const TIMEOUT = 60_000;

const script = async function* () {
  yield { type: "text" as const, delta: "on it" };
  yield { type: "done" as const, reason: "end" as const };
};

function withService(enabled = true) {
  const h = codeHarness(script);
  setCodeToolService({ enabled: () => enabled, runner: () => h.runner, chatForSession: (s) => (s === "chat-session" ? "parent-chat" : undefined), config: () => h.config });
  return h;
}

describe("code tools", () => {
  test("offered only while code sessions are on", () => {
    const names = () => getTools().map((t) => t.name);
    expect(names().some((n) => CODE_TOOL_NAMES.has(n))).toBe(false);
    withService(false);
    expect(names().some((n) => CODE_TOOL_NAMES.has(n))).toBe(false);
    withService(true);
    expect(names()).toContain("start_code_session_tool");
    expect(names()).toContain("code_session_status_tool");
  });

  test("a proposal asks first; Start creates the session with a card marker for the parent chat", async () => {
    const h = withService();
    expect(prepareCodeSessionStart("chat-session", { repo: "elsewhere", task: "x" })).toMatchObject({ ok: false });
    expect(prepareCodeSessionStart("chat-session", { repo: "demo" })).toMatchObject({ ok: false });
    const prepared = prepareCodeSessionStart("chat-session", { repo: "demo", task: "Make the search faster", title: "Faster search" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("unreachable");
    expect(prepared.question).toMatch(/^Start a code session on \*\*demo\*\* from \*\*main\*\* with Claude/);
    // Nothing exists until the answer.
    expect(h.store.list({ status: "all" })).toHaveLength(0);

    const outcome = await resolvePendingCodeSessionStart("chat-session", "Start");
    expect(outcome?.call?.result).toMatch(/\[rye:code-session:cs_[0-9a-f]{12}\]/);
    const [session] = h.store.list({ status: "all" });
    expect(session.parentChatId).toBe("parent-chat");
    expect(h.chats.get(session.chatId)).toMatchObject({ kind: "code", parentChatId: "parent-chat", title: "Faster search" });
    // Only one answer per proposal.
    expect(await resolvePendingCodeSessionStart("chat-session", "Start")).toBeNull();
    await h.runner.idle(session.id);

    const status = await codeSessionStatusForAgent({ session_id: session.id });
    expect(status).toContain('"Faster search"');
    expect(status).toContain(`[rye:code-session:${session.id}]`);
    expect(await executeTool("code_session_status_tool", { session_id: session.id })).toContain(session.id);
    // A caller that can't ask (a subagent) never starts one.
    expect(await executeTool("start_code_session_tool", { repo: "demo", task: "x" })).toContain("Nothing was started");
  }, TIMEOUT);

  test("anything but Start cancels", async () => {
    const h = withService();
    expect(prepareCodeSessionStart("s2", { repo: "demo", task: "x" }).ok).toBe(true);
    const outcome = await resolvePendingCodeSessionStart("s2", "Cancel");
    expect(outcome?.call).toBeUndefined();
    expect(outcome?.note).toContain("did not start");
    expect(h.store.list({ status: "all" })).toHaveLength(0);
  });
});
