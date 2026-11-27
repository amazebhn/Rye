/**
 * A scripted code engine: replays `CodeEvent`s from a script instead of running a coding agent.
 * It starts no process of any kind (no Claude Code, no sandbox-exec, no CLI).
 *
 * - Tests build one with `scriptedCodeEngine(script)` and drive the runner with it.
 * - `demoCodeEngine()` is a fixed script that edits files in the workspace and asks for one
 *   approval, for trying the UI end to end. It is registered **only** when Rye is started with
 *   the test-only variable `RYE_CODE_FAKE_ENGINE=1` (code/service.ts), in place of `claude`, so a
 *   browser check can never reach the real engine. Unset (the default), it doesn't exist.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeEngine, CodeEngineAvailability, CodeEngineId, CodeEvent, CodeRun, CodeRunOptions } from "../types.js";

/** What a script sees of its run. */
export interface FakeRunContext {
  options: CodeRunOptions;
  /** Aborted by `interrupt()` or the run's own signal. */
  signal: AbortSignal;
  /** Messages steered into the run so far (`CodeRun.send`). */
  steered: string[];
  /** Resolves with the next steered message, or null once the run is stopped. */
  nextSteer(): Promise<string | null>;
  /** Waits `ms`, or less when the run is stopped. */
  sleep(ms: number): Promise<void>;
}

export type FakeScript = (ctx: FakeRunContext) => AsyncGenerator<CodeEvent, void, unknown>;

/** One run the engine started, for tests to inspect. */
export interface FakeRunRecord {
  options: CodeRunOptions;
  steered: string[];
  interrupted: boolean;
}

class EventQueue {
  private items: CodeEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(e: CodeEvent) {
    if (this.ended) return;
    this.items.push(e);
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *iterate(): AsyncGenerator<CodeEvent> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

class FakeRun implements CodeRun {
  private readonly queue = new EventQueue();
  private readonly abort = new AbortController();
  private finished = false;
  private steerWaiters: Array<(m: string | null) => void> = [];
  private steerQueue: string[] = [];

  constructor(
    private readonly record: FakeRunRecord,
    script: FakeScript,
  ) {
    const o = record.options;
    if (o.signal.aborted) this.abort.abort();
    else o.signal.addEventListener("abort", () => this.abort.abort(), { once: true });
    this.abort.signal.addEventListener("abort", () => {
      for (const w of this.steerWaiters.splice(0)) w(null);
    });
    const ctx: FakeRunContext = {
      options: o,
      signal: this.abort.signal,
      steered: record.steered,
      nextSteer: () => {
        if (this.steerQueue.length) return Promise.resolve(this.steerQueue.shift()!);
        if (this.abort.signal.aborted) return Promise.resolve(null);
        return new Promise((r) => this.steerWaiters.push(r));
      },
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          if (this.abort.signal.aborted) return resolve();
          const t = setTimeout(resolve, ms);
          this.abort.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        }),
    };
    void this.pump(script(ctx));
  }

  private finish(done: Extract<CodeEvent, { type: "done" }>) {
    if (this.finished) return;
    this.finished = true;
    this.queue.push(done);
    this.queue.end();
  }

  private async pump(gen: AsyncGenerator<CodeEvent, void, unknown>) {
    try {
      for await (const ev of gen) {
        if (this.finished) break;
        if (ev.type === "done") return this.finish(this.record.interrupted ? { type: "done", reason: "interrupted" } : ev);
        if (this.abort.signal.aborted) break;
        this.queue.push(ev);
      }
      this.finish(this.abort.signal.aborted ? { type: "done", reason: "interrupted" } : { type: "done", reason: "end" });
    } catch (err) {
      this.finish(this.abort.signal.aborted ? { type: "done", reason: "interrupted" } : { type: "done", reason: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodeEvent> {
    return this.queue.iterate();
  }

  send(text: string): void {
    if (this.finished || !text.trim()) return;
    this.record.steered.push(text);
    const waiter = this.steerWaiters.shift();
    if (waiter) waiter(text);
    else this.steerQueue.push(text);
  }

  async interrupt(): Promise<void> {
    if (this.finished) return;
    this.record.interrupted = true;
    this.abort.abort();
    // The script stops at its next await; the done event follows.
    for (let i = 0; i < 100 && !this.finished; i++) await new Promise((r) => setTimeout(r, 10));
    this.finish({ type: "done", reason: "interrupted" });
  }
}

export interface ScriptedEngineOptions {
  /** Default `claude` (the engine the runner uses when none is named). */
  id?: CodeEngineId;
  models?: string[];
  availability?: CodeEngineAvailability;
}

/** An engine whose every run replays `script`. `runs` records each run's options. */
export function scriptedCodeEngine(script: FakeScript, o: ScriptedEngineOptions = {}): CodeEngine & { runs: FakeRunRecord[] } {
  const runs: FakeRunRecord[] = [];
  return {
    id: o.id ?? "claude",
    capabilities: { resume: true, liveApprovals: true, ownSandbox: true },
    runs,
    async models() {
      return o.models ?? ["fake"];
    },
    async availability() {
      return o.availability ?? { available: true, account: "scripted test engine" };
    },
    start(options: CodeRunOptions): CodeRun {
      const record: FakeRunRecord = { options, steered: [], interrupted: false };
      runs.push(record);
      return new FakeRun(record, script);
    },
  };
}

// ---------------------------------------------------------------------------
// The demo script (RYE_CODE_FAKE_ENGINE=1 only)
// ---------------------------------------------------------------------------

async function* say(ctx: FakeRunContext, text: string): AsyncGenerator<CodeEvent> {
  for (const word of text.split(/(?<= )/)) {
    if (ctx.signal.aborted) return;
    yield { type: "text", delta: word };
    await ctx.sleep(25);
  }
}

function writeInRepo(ctx: FakeRunContext, rel: string, content: string) {
  const path = join(ctx.options.workspace.repoDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Edits two files, runs a slow "test", and asks one live approval (a package install) whose
 * answer decides the third edit. Steered messages are acknowledged as they arrive.
 */
export const demoScript: FakeScript = async function* (ctx) {
  const o = ctx.options;
  const turn = o.input.text.split("\n")[0].slice(0, 80);
  yield { type: "engine_session", id: o.resume ?? `fake-${randomUUID()}`, version: "fake" };
  yield* say(ctx, `Working on: ${turn}. `);
  yield* say(ctx, "First I'll read the README. ");

  const readId = randomUUID();
  yield { type: "tool_start", id: readId, name: "Read", args: { file_path: join(o.workspace.repoDir, "README.md") } };
  let readme = "";
  try {
    readme = readFileSync(join(o.workspace.repoDir, "README.md"), "utf8");
  } catch {
    readme = "(no README.md)";
  }
  yield { type: "tool_result", id: readId, content: readme.slice(0, 2000), isError: false };

  const editId = randomUUID();
  yield { type: "tool_start", id: editId, name: "Write", args: { file_path: join(o.workspace.repoDir, "src/greeting.ts") } };
  writeInRepo(ctx, "src/greeting.ts", `export const greeting = ${JSON.stringify(`Hello from a Rye code session (${turn})`)};\n`);
  yield { type: "tool_result", id: editId, content: "Wrote src/greeting.ts", isError: false };

  yield* say(ctx, "Now the tests; they take a few seconds. ");
  const testId = randomUUID();
  yield { type: "tool_start", id: testId, name: "Bash", args: { command: "bun test", description: "Run the tests" } };
  yield { type: "tool_output", id: testId, chunk: "bun test v1 (fake)\n" };
  await ctx.sleep(6000);
  yield { type: "tool_result", id: testId, content: "3 pass\n0 fail", isError: false };

  for (const m of ctx.steered.splice(0)) yield* say(ctx, `Noted your message: "${m}". `);

  const installId = randomUUID();
  const command = "bun add left-pad";
  yield { type: "tool_start", id: installId, name: "Bash", args: { command } };
  const decision = await o.approve({
    id: randomUUID(),
    sessionId: o.workspace.sessionId,
    toolName: "Bash",
    toolUseId: installId,
    kind: "command",
    category: "install",
    reason: "installs packages from registry.npmjs.org; dependency scripts may run in the sandbox",
    command,
    argv: command.split(" "),
    cwd: "",
    hosts: ["registry.npmjs.org"],
    pattern: "bun add *",
  });
  if (decision.behavior === "allow") {
    writeInRepo(ctx, "package.json", `${JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }, null, 2)}\n`);
    yield { type: "tool_result", id: installId, content: "installed left-pad@1.3.0", isError: false };
  } else {
    yield { type: "tool_result", id: installId, content: decision.behavior === "deny" ? decision.message : "Refused.", isError: true };
  }

  for (const m of ctx.steered.splice(0)) yield* say(ctx, `Noted your message: "${m}". `);
  yield { type: "usage", inputTokens: 1200, outputTokens: 340, costUsd: 0.02 };
  yield* say(ctx, decision.behavior === "allow" ? "Done: added src/greeting.ts and the left-pad dependency." : "Done: added src/greeting.ts (no new dependency, as you asked).");
  yield { type: "done", reason: "end" };
};

/** The demo engine, registered as `claude` when RYE_CODE_FAKE_ENGINE=1. */
export function demoCodeEngine(): CodeEngine {
  return scriptedCodeEngine(demoScript, { id: "claude", models: ["fake-demo"], availability: { available: true, account: "RYE_CODE_FAKE_ENGINE (scripted, no agent runs)" } });
}
