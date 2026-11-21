/**
 * Skill script runner. Planning (validation + fingerprint) is separate from running so the
 * agent loop can ask the user for approval of the exact command before anything executes.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, sep } from "node:path";
import { SkillError, isValidSkillName, resolveInside } from "./fs-safe.js";
import { isScriptApprovalToken, spendScriptApprovalToken, type ScriptApprovalToken } from "./script-approval.js";
import type { SkillStore } from "./store.js";

export const RUN_SKILL_SCRIPT_TOOL_NAME = "run_skill_script_tool";
export const SCRIPT_TIMEOUT_MS = 55_000;
export const MAX_SCRIPT_ARGS = 32;
export const MAX_SCRIPT_ARG_LENGTH = 1000;
export const MAX_OUTPUT_CHARS = 20_000;
const HARD_OUTPUT_LIMIT = 20_000_000;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const PREVIEW_LINES = 12;
const PREVIEW_LINE_CHARS = 160;

const INTERPRETERS: Record<string, string> = {
  ".sh": "bash",
  ".ts": "bun",
  ".js": "bun",
  ".mjs": "bun",
  ".py": "python3",
};

/** Interpreter binary name for a script path, or null for unknown/missing extensions. */
export function interpreterFor(script: string): string | null {
  return INTERPRETERS[extname(script).toLowerCase()] ?? null;
}

/** Minimal environment for scripts — never Rye's own env (RYE_*, tokens, DB passwords). */
export function scriptEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

export interface ScriptPlan {
  skill: string;
  source: "rye" | "installed";
  /** Script path relative to the skill folder, e.g. "scripts/run.sh". */
  script: string;
  real: string;
  cwd: string;
  /** Interpreter name (bash, bun, python3). */
  interpreter: string;
  /** Exact argv passed to spawn (no shell). */
  argv: string[];
  args: string[];
  size: number;
  sha256: string;
  /** First lines of the script, for the approval prompt. */
  preview: string;
  /** Binds an approval to this skill, script content, interpreter and args. */
  fingerprint: string;
}

function normalizeArgs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SkillError("args must be an array of strings", 400);
  if (raw.length > MAX_SCRIPT_ARGS) throw new SkillError(`at most ${MAX_SCRIPT_ARGS} args are allowed`, 400);
  return raw.map((a) => {
    if (typeof a !== "string" && typeof a !== "number" && typeof a !== "boolean") {
      throw new SkillError("args must be an array of strings", 400);
    }
    const s = String(a);
    if (s.length > MAX_SCRIPT_ARG_LENGTH) throw new SkillError(`each arg must be at most ${MAX_SCRIPT_ARG_LENGTH} characters`, 400);
    if (s.includes("\0")) throw new SkillError("args must not contain NUL bytes", 400);
    return s;
  });
}

/** Validate a run request and describe exactly what would execute. Throws SkillError. */
export function planScriptRun(store: SkillStore, input: { skill?: unknown; script?: unknown; args?: unknown }): ScriptPlan {
  if (typeof input.skill !== "string" || !isValidSkillName(input.skill)) throw new SkillError("skill must be a valid skill name", 400);
  const skill = store.summary(input.skill);
  if (!skill) throw new SkillError(`Skill not found: ${input.skill}`, 404);
  if (typeof input.script !== "string" || input.script.trim() === "") throw new SkillError("script is required", 400);

  const given = input.script.trim();
  const rel = given.startsWith("scripts/") ? given : `scripts/${given}`;
  const interpreter = interpreterFor(rel);
  if (!interpreter) {
    throw new SkillError(`Unsupported script type: ${extname(rel) || "(no extension)"}. Allowed: .sh, .ts, .js, .mjs, .py`, 400);
  }

  const { real, rel: cleanRel } = resolveInside(skill.path, rel);
  let realScripts: string;
  try {
    realScripts = realpathSync(join(skill.path, "scripts"));
  } catch {
    throw new SkillError(`Skill "${skill.name}" has no scripts/ folder`, 404);
  }
  if (!real.startsWith(realScripts + sep)) throw new SkillError("script must resolve inside the skill's scripts/ folder", 400);

  const size = statSync(real).size;
  if (size > MAX_SCRIPT_BYTES) throw new SkillError(`script is larger than ${MAX_SCRIPT_BYTES} bytes`, 413);
  const bytes = readFileSync(real);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const interpreterPath = Bun.which(interpreter);
  if (!interpreterPath) throw new SkillError(`Interpreter "${interpreter}" was not found on PATH`, 400);

  const args = normalizeArgs(input.args);
  const preview = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .slice(0, PREVIEW_LINES)
    .map((l) => (l.length > PREVIEW_LINE_CHARS ? `${l.slice(0, PREVIEW_LINE_CHARS)}…` : l))
    .join("\n");

  return {
    skill: skill.name,
    source: skill.source,
    script: cleanRel,
    real,
    cwd: skill.path,
    interpreter,
    argv: [interpreterPath, real, ...args],
    args,
    size,
    sha256,
    preview,
    fingerprint: createHash("sha256").update(JSON.stringify([skill.name, cleanRel, sha256, interpreter, args])).digest("hex"),
  };
}

/** The approval question shown to the user: skill, script, args, interpreter, hash and first lines. */
export function formatApprovalQuestion(plan: ScriptPlan): string {
  return (
    `Run a script from the ${plan.source === "installed" ? "installed " : ""}skill \`${plan.skill}\`?\n\n` +
    `- Skill: \`${plan.skill}\`\n` +
    `- Script: \`${plan.script}\` (${plan.size} bytes, sha256 \`${plan.sha256}\`)\n` +
    `- Interpreter: \`${plan.interpreter}\`\n` +
    `- Arguments: ${JSON.stringify(plan.args)}\n` +
    `- Working directory: \`${plan.cwd}\`\n` +
    `- Environment: only PATH, HOME, LANG, TMPDIR\n` +
    `- Limits: ${SCRIPT_TIMEOUT_MS / 1000}s timeout; output capped\n\n` +
    `First lines of the script:\n\`\`\`\n${plan.preview}\n\`\`\`\n\n` +
    `The script runs with your user permissions. This approval covers this single run only.`
  );
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Keeps the first and last part of the output and counts what was dropped in between. */
export class OutputCollector {
  private head = "";
  private tail = "";
  total = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(max = MAX_OUTPUT_CHARS) {
    this.headMax = Math.floor(max / 2);
    this.tailMax = max - this.headMax;
  }

  push(chunk: string): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headMax) {
      const take = this.headMax - this.head.length;
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest) this.tail = (this.tail + rest).slice(-this.tailMax);
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length;
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    const omitted = this.total - this.head.length - this.tail.length;
    return `${this.head}\n…[${omitted} characters omitted]…\n${this.tail}`;
  }
}

export interface ScriptResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL"); // the script runs in its own process group
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Run a planned script. Caller must already hold the user's approval. */
export async function runPlannedScript(
  plan: ScriptPlan,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ScriptResult> {
  const timeoutMs = opts.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const startedAt = Date.now();
  const out = new OutputCollector();
  const result = (exitCode: number | null, signal: string | null, flags: Partial<ScriptResult> = {}): ScriptResult => ({
    exitCode,
    signal,
    timedOut: false,
    aborted: false,
    output: out.toString(),
    truncated: out.truncated,
    durationMs: Date.now() - startedAt,
    ...flags,
  });

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(plan.argv, {
      cwd: plan.cwd,
      env: scriptEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true, // own process group, so the whole tree can be killed
    });
  } catch (err) {
    out.push(`failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    return result(null, null);
  }

  let timedOut = false;
  let aborted = false;
  let outputLimited = false;
  const kill = () => killTree(proc.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        out.push(decoder.decode(chunk, { stream: true }));
        if (out.total > HARD_OUTPUT_LIMIT && !outputLimited) {
          outputLimited = true;
          kill();
        }
      }
      out.push(decoder.decode());
    } catch {
      // stream closed by the cleanup below
    }
  };
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);

  try {
    await proc.exited;
    // Pipes held open by a backgrounded child must not hang the run; give trailing data a moment.
    await Promise.race([pumps, new Promise((r) => setTimeout(r, 200))]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    kill(); // reap anything the script left running
  }
  if (outputLimited) out.push(`\n[output exceeded ${HARD_OUTPUT_LIMIT} characters; script killed]`);
  return result(proc.exitCode, proc.signalCode, { timedOut, aborted });
}

export function formatScriptResult(plan: ScriptPlan, r: ScriptResult): string {
  const status = r.timedOut
    ? `killed: timed out after ${SCRIPT_TIMEOUT_MS / 1000}s`
    : r.aborted
      ? "killed: the user stopped the run"
      : r.signal
        ? `killed by signal ${r.signal}`
        : `exit code ${r.exitCode}`;
  return (
    `$ ${plan.interpreter} ${plan.script}${plan.args.length ? ` ${JSON.stringify(plan.args)}` : ""}  (cwd: ${plan.cwd})\n` +
    `${status} — ${r.durationMs}ms${r.truncated ? " — output truncated" : ""}\n\n` +
    (r.output.trim() ? r.output : "(no output)")
  );
}

/**
 * Tool entry point. Refuses unless `approval` is a valid, unspent token for exactly this run;
 * the agent loop is the only place that mints one.
 */
export async function runSkillScriptTool(
  store: SkillStore,
  args: { skill?: unknown; script?: unknown; args?: unknown },
  approval: ScriptApprovalToken | undefined,
  signal?: AbortSignal,
): Promise<string> {
  let plan: ScriptPlan;
  try {
    plan = planScriptRun(store, args);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!isScriptApprovalToken(approval) || !spendScriptApprovalToken(approval, plan.fingerprint)) {
    return "Refused: running a skill script needs the user's approval for this exact run, which can only be granted in the main conversation.";
  }
  const result = await runPlannedScript(plan, { signal });
  return formatScriptResult(plan, result);
}
