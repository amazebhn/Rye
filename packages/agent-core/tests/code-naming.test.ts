/**
 * Naming a new code session (code/naming.ts, CodeRunner.create): the chat title from the title model or
 * the task's own words, and the branch from the title with filler and the repo's name taken out.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ChatStore } from "../src/chat/store.js";
import { CodeEngineRegistry } from "../src/code/engine.js";
import { scriptedCodeEngine } from "../src/code/engines/fake.js";
import { branchSlug, cleanAiTitle, fallbackTitle, nameWithin } from "../src/code/naming.js";
import { CodeRunner, sessionSlug } from "../src/code/runner.js";
import { CodeStore } from "../src/code/store.js";
import { CODE_CONFIG_DEFAULTS, type CodeConfig } from "../src/code/types.js";
import { SLUG_RE, createWorkspaceManager } from "../src/code/workspace.js";
import { cleanup, makeRepo, tmp } from "./code-test-utils.js";

afterAll(cleanup);

describe("branchSlug", () => {
  test("keeps up to four meaningful words", () => {
    expect(branchSlug("Let's see what additional fingerprinting is available")).toBe("fingerprinting");
    expect(branchSlug("please add a dark mode toggle to settings")).toBe("dark-mode-toggle-settings");
    expect(branchSlug("Fraud fingerprinting signals")).toBe("fraud-fingerprinting-signals");
    expect(branchSlug("Fix the search lag in the sidebar when typing fast")).toBe("fix-search-lag-sidebar");
    expect(branchSlug("Can you please look into why the build is so slow?")).toBe("build-slow");
  });

  test("drops the repo's name, folds accents and closes apostrophes", () => {
    expect(branchSlug("rye: Fingerprinting return fraud", ["rye"])).toBe("fingerprinting-return-fraud");
    expect(branchSlug("my-app: Faster search", ["my-app"])).toBe("faster-search");
    expect(branchSlug("Añadir modo oscuro à l'écran")).toBe("anadir-modo-oscuro-lecran");
    expect(branchSlug("Don’t crash on empty input")).toBe("dont-crash-empty-input");
  });

  test("session when nothing is left", () => {
    expect(branchSlug("")).toBe("session");
    expect(branchSlug("   ")).toBe("session");
    expect(branchSlug("日本語のタスク")).toBe("session");
    expect(branchSlug("Can you please do it?")).toBe("session");
  });

  test("always a valid slug once the id is added", () => {
    for (const text of ["", "x".repeat(200), "Supercalifragilisticexpialidocious antidisestablishmentarianism words", "--- !!! ---", "Ünïcödé ✨ emoji 🚀 task"]) {
      const slug = sessionSlug(text, "cs_abcdef123456", ["demo"]);
      expect(slug).toMatch(SLUG_RE);
      expect(slug.endsWith("-3456")).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(45);
    }
    expect(sessionSlug("Fix search lag!", "cs_abcdef123456")).toBe("fix-search-lag-3456");
  });
});

describe("titles", () => {
  test("a model's answer, cleaned: sentence case, at most six words", () => {
    expect(cleanAiTitle("Fraud Fingerprinting Signals")).toBe("Fraud fingerprinting signals");
    expect(cleanAiTitle("Additional Fingerprinting for Return Fraud Analysis")).toBe("Additional fingerprinting for return fraud analysis");
    expect(cleanAiTitle("Speed up Postgres search")).toBe("Speed up Postgres search");
    expect(cleanAiTitle('"Fraud fingerprinting signals."')).toBe("Fraud fingerprinting signals");
    expect(cleanAiTitle("Title: **Dark mode toggle**\nSome explanation")).toBe("Dark mode toggle");
    expect(cleanAiTitle("Add OAuth login to the GitHub client settings page now")).toBe("Add OAuth login to the GitHub");
    expect(cleanAiTitle("<think>hmm</think>\nSearch lag fix")).toBe("Search lag fix");
    expect(cleanAiTitle("")).toBeNull();
    expect(cleanAiTitle("...")).toBeNull();
    expect(cleanAiTitle(null)).toBeNull();
  });

  test("the fallback is the repo and the task's meaningful words", () => {
    expect(fallbackTitle("rye", "Let's see what additional fingerprinting is available for return fraud")).toBe("rye: Fingerprinting return fraud");
    expect(fallbackTitle("web", "please add a dark mode toggle to settings\nand more")).toBe("web: Dark mode toggle settings");
    expect(fallbackTitle("web", "Can you do it?")).toBe("web: Can you do it?");
  });

  test("nameWithin gives up after its time and aborts the request", async () => {
    let aborted = false;
    const slow = (signal: AbortSignal) =>
      new Promise<string | null>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; });
        setTimeout(() => resolve("Too late"), 500);
      });
    expect(await nameWithin(slow, 20)).toBeNull();
    expect(aborted).toBe(true);
    expect(await nameWithin(async () => { throw new Error("no model"); }, 100)).toBeNull();
    expect(await nameWithin(async () => "Search Lag Fix", 100)).toBe("Search lag fix");
  });
});

describe("CodeRunner.create names the session", () => {
  function runnerWith(nameSession?: ConstructorParameters<typeof CodeRunner>[0]["nameSession"]) {
    const base = tmp("rye-naming-");
    const repo = makeRepo();
    const chats = new ChatStore(join(base, "chats.db"), null, null);
    const config: CodeConfig = {
      ...CODE_CONFIG_DEFAULTS,
      policy: { allowed_domains: [], allow: [], ask: [], deny: [] },
      repos: [{ name: "shop", path: repo, base: "main", isolation: "clone", setup: [], checks: [] }],
    };
    const runner = new CodeRunner({
      store: new CodeStore(join(base, "code.db")),
      chats,
      engines: new CodeEngineRegistry([scriptedCodeEngine(async function* () { yield { type: "done", reason: "end" }; })]),
      config: () => config,
      root: () => join(base, "code"),
      scope: { home: base, dataDir: base, configDir: join(base, "config"), toolchainDirs: [] },
      sandboxProbe: async () => ({ available: true, mechanism: "seatbelt" }),
      workspaces: createWorkspaceManager(),
      processEnv: { PATH: process.env.PATH, HOME: base },
      log: () => {},
      ...(nameSession ? { nameSession } : {}),
    });
    return { runner, chats };
  }
  const TASK = "Let's see what additional fingerprinting is available for return fraud";

  test("from the title model", async () => {
    const seen: string[] = [];
    const { runner, chats } = runnerWith(async (task, repo) => {
      seen.push(`${repo}|${task}`);
      return "Fraud Fingerprinting Signals";
    });
    const { session, chatId } = await runner.create({ repo: "shop", task: TASK });
    expect(seen).toEqual([`shop|${TASK}`]);
    expect(chats.get(chatId)?.title).toBe("Fraud fingerprinting signals");
    expect(session.branch).toMatch(/^rye\/fraud-fingerprinting-signals-[a-f0-9]{4}$/);
    await runner.idle(session.id);
  });

  test("the task's words when the model fails", async () => {
    const { runner, chats } = runnerWith(async () => { throw new Error("connection refused"); });
    const { session, chatId } = await runner.create({ repo: "shop", task: TASK });
    expect(chats.get(chatId)?.title).toBe("shop: Fingerprinting return fraud");
    expect(session.branch).toMatch(/^rye\/fingerprinting-return-fraud-[a-f0-9]{4}$/);
    await runner.idle(session.id);
  });

  test("a title the caller gives is kept and the model isn't asked", async () => {
    let asked = false;
    const { runner, chats } = runnerWith(async () => { asked = true; return "Other"; });
    const { session, chatId } = await runner.create({ repo: "shop", task: TASK, title: "Return fraud signals" });
    expect(asked).toBe(false);
    expect(chats.get(chatId)?.title).toBe("Return fraud signals");
    expect(session.branch).toMatch(/^rye\/return-fraud-signals-[a-f0-9]{4}$/);
    await runner.idle(session.id);
  });
});
