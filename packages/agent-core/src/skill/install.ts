/**
 * Installing and removing skills through the `skills` CLI (bunx skills / npx skills).
 *
 * The CLI runs without a shell, with a scrubbed environment, a timeout and capped output,
 * one operation at a time. `-g -a universal` makes it write only to ~/.agents/skills
 * (without -a it installs into every known agent's directory).
 */

import { OutputCollector } from "./runner.js";
import { SkillError, isValidSkillName } from "./fs-safe.js";
import type { SkillInstalledFrom, SkillStore } from "./store.js";

export const INSTALL_TIMEOUT_MS = 120_000;
const INSTALL_OUTPUT_CHARS = 60_000;
const MAX_INSTALL_SKILLS = 50;
const MAX_SOURCE_LENGTH = 200;
const AGENT_FLAG = "universal";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const GITHUB_SHORTHAND_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
const BARE_PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CLI_SKILL_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

const badSegment = (s: string) => s === "." || s === ".." || s.startsWith("-");

/** Accepts GitHub `owner/repo`, `https://github.com/owner/repo(.git)` and bare package names. */
export function validateInstallSource(source: unknown): string {
  if (typeof source !== "string") throw new SkillError("source is required", 400);
  const s = source.trim();
  if (s === "" || s.length > MAX_SOURCE_LENGTH) throw new SkillError("source is empty or too long", 400);
  if (s !== source) throw new SkillError("source must not have leading or trailing whitespace", 400);

  const url = GITHUB_URL_RE.exec(s);
  if (url) {
    if (badSegment(url[1]) || badSegment(url[2])) throw new SkillError("source is not a valid GitHub repository", 400);
    return s;
  }
  if (GITHUB_SHORTHAND_RE.test(s)) {
    if (s.split("/").some(badSegment)) throw new SkillError("source is not a valid GitHub repository", 400);
    return s;
  }
  if (BARE_PACKAGE_RE.test(s)) return s;
  throw new SkillError(
    "source must be a GitHub 'owner/repo', an https://github.com/owner/repo URL, or a plain package name",
    400,
  );
}

export function validateCliSkillName(name: unknown): string {
  if (typeof name !== "string" || name.length > 100 || !CLI_SKILL_NAME_RE.test(name) || name === "." || name === "..") {
    throw new SkillError(`Invalid skill name ${JSON.stringify(name)}`, 400);
  }
  return name;
}

export function validateInstallSkillNames(names: unknown): string[] {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw new SkillError("skills must be an array of skill names", 400);
  if (names.length > MAX_INSTALL_SKILLS) throw new SkillError(`at most ${MAX_INSTALL_SKILLS} skills can be installed at once`, 400);
  return [...new Set(names.map(validateCliSkillName))];
}

// ---------------------------------------------------------------------------
// argv builders (no shell is ever involved)
// ---------------------------------------------------------------------------

export function listArgs(source: string): string[] {
  return ["add", source, "-l"];
}

/** Without `skills`, installs every skill in the source (`-s '*'`). */
export function addArgs(source: string, skills: string[]): string[] {
  return ["add", source, "-g", "-y", "-a", AGENT_FLAG, ...(skills.length > 0 ? skills.flatMap((s) => ["-s", s]) : ["-s", "*"])];
}

export function removeArgs(name: string): string[] {
  return ["remove", name, "-g", "-y"];
}

// ---------------------------------------------------------------------------
// Parsing `skills add <pkg> -l`
// ---------------------------------------------------------------------------

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

export interface AvailableSkill {
  name: string;
  description?: string;
}

/**
 * Best-effort parse of the CLI's listing: under "Available Skills", each skill is `│    <name>`
 * (4-space indent) followed by `│      <description>` (6-space indent).
 */
export function parseAvailableSkills(raw: string): AvailableSkill[] {
  const out: AvailableSkill[] = [];
  let inList = false;
  let current: AvailableSkill | null = null;
  for (const line of stripAnsi(raw).split("\n")) {
    if (!inList) {
      if (/Available Skills/i.test(line)) inList = true;
      continue;
    }
    if (/^[└╰]/.test(line)) break;
    const m = /^│( +)(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const text = m[2];
    if (/^Use --skill/i.test(text)) break;
    if (indent <= 5 && /^[A-Za-z0-9._-]+$/.test(text)) {
      current = { name: text };
      out.push(current);
    } else if (current && indent >= 6) {
      current.description = current.description ? `${current.description} ${text}` : text;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

const ENV_ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "BUN_INSTALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "SSH_AUTH_SOCK",
  "GITHUB_TOKEN", "GH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_REGISTRY",
]);

/** Only what the CLI needs to find tools and reach GitHub — never RYE_* or other secrets. */
export function installEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (ENV_ALLOW.has(k) || k.startsWith("XDG_"))) env[k] = v;
  }
  return { ...env, NO_COLOR: "1", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
}

/** `bunx skills` when bunx is on PATH, otherwise `npx --yes skills`. */
export function resolveRunner(which: (cmd: string) => string | null = (c) => Bun.which(c)): string[] | null {
  const bunx = which("bunx");
  if (bunx) return [bunx, "skills"];
  const npx = which("npx");
  if (npx) return [npx, "--yes", "skills"];
  return null;
}

export interface CliResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
}

function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function runSkillsCli(
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; runner?: string[] | null; env?: Record<string, string> } = {},
): Promise<CliResult> {
  const runner = opts.runner === undefined ? resolveRunner() : opts.runner;
  if (!runner) throw new SkillError("Neither bunx nor npx was found on PATH; install Bun or Node to manage skills.", 500);

  const out = new OutputCollector(INSTALL_OUTPUT_CHARS);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...runner, ...args], {
      env: opts.env ?? installEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (err) {
    throw new SkillError(`Could not start the skills CLI: ${err instanceof Error ? err.message : String(err)}`, 500);
  }

  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid);
  }, opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
  const onAbort = () => {
    aborted = true;
    killTree(proc.pid);
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) out.push(decoder.decode(chunk, { stream: true }));
      out.push(decoder.decode());
    } catch {
      // closed by cleanup
    }
  };
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  try {
    await proc.exited;
    await Promise.race([pumps, new Promise((r) => setTimeout(r, 200))]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    killTree(proc.pid);
  }
  return { exitCode: proc.exitCode, timedOut, aborted, output: stripAnsi(out.toString()) };
}

// ---------------------------------------------------------------------------
// Operations (one at a time)
// ---------------------------------------------------------------------------

let busy = false;

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new SkillError("Another skill install/remove is already running; try again when it finishes.", 409);
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

export interface CliRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  runner?: string[] | null;
}

function failureText(r: CliResult): string {
  if (r.timedOut) return `The skills CLI timed out after ${INSTALL_TIMEOUT_MS / 1000}s`;
  if (r.aborted) return "The request was cancelled";
  return `The skills CLI exited with code ${r.exitCode}`;
}

export async function listAvailableSkills(
  sourceRaw: unknown,
  opts: CliRunOptions = {},
): Promise<{ ok: boolean; skills: AvailableSkill[]; raw: string; error?: string }> {
  const source = validateInstallSource(sourceRaw);
  return exclusive(async () => {
    const r = await runSkillsCli(listArgs(source), opts);
    const ok = r.exitCode === 0 && !r.timedOut && !r.aborted;
    return { ok, skills: parseAvailableSkills(r.output), raw: r.output, ...(ok ? {} : { error: failureText(r) }) };
  });
}

function fingerprint(from: SkillInstalledFrom | null): string {
  return from ? `${from.skillFolderHash ?? ""}|${from.updatedAt ?? ""}` : "";
}

function installedSnapshot(store: SkillStore): Map<string, string> {
  return new Map(store.rescan().filter((s) => s.source === "installed").map((s) => [s.name, fingerprint(s.installedFrom)]));
}

export interface InstallResult {
  ok: boolean;
  output: string;
  installed: string[];
  error?: string;
  note?: string;
}

export async function installSkills(
  store: SkillStore,
  input: { source?: unknown; skills?: unknown },
  opts: CliRunOptions = {},
): Promise<InstallResult> {
  const source = validateInstallSource(input.source);
  const skills = validateInstallSkillNames(input.skills);
  return exclusive(async () => {
    const before = installedSnapshot(store);
    const r = await runSkillsCli(addArgs(source, skills), opts);
    const after = installedSnapshot(store);
    const installed = [...after].filter(([name, fp]) => before.get(name) !== fp).map(([name]) => name);
    const ok = r.exitCode === 0 && !r.timedOut && !r.aborted;
    return {
      ok,
      output: r.output,
      installed,
      ...(ok ? {} : { error: failureText(r) }),
      ...(ok && installed.length === 0
        ? { note: "The CLI finished but no new skill appeared in Rye's skill directories (the CLI installs to ~/.agents/skills; check [skills] dirs)." }
        : {}),
    };
  });
}

export interface RemoveResult {
  ok: boolean;
  output: string;
  removed: boolean;
  error?: string;
}

/** Removes an installed skill via the CLI; success is judged by a rescan, not the exit code. */
export async function removeInstalledSkill(store: SkillStore, nameRaw: unknown, opts: CliRunOptions = {}): Promise<RemoveResult> {
  if (!isValidSkillName(nameRaw)) throw new SkillError(`Invalid skill name ${JSON.stringify(nameRaw)}`, 400);
  const name = validateCliSkillName(nameRaw);
  const skill = store.summary(name);
  if (!skill) throw new SkillError(`Skill not found: ${name}`, 404);
  if (skill.source !== "installed") {
    throw new SkillError(`Skill "${name}" is a Rye-owned skill; delete it with DELETE /skill/${name}`, 403);
  }
  return exclusive(async () => {
    const r = await runSkillsCli(removeArgs(name), opts);
    const still = store.rescan().some((s) => s.name === name && s.source === "installed");
    const removed = !still;
    return {
      ok: removed,
      output: r.output,
      removed,
      ...(removed
        ? {}
        : { error: r.exitCode === 0 ? "The CLI reported success but the skill folder is still present (it may live outside ~/.agents/skills)." : failureText(r) }),
    };
  });
}
