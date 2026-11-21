import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillError } from "../src/skill/fs-safe.js";
import {
  MAX_OUTPUT_CHARS,
  MAX_SCRIPT_ARGS,
  MAX_SCRIPT_ARG_LENGTH,
  OutputCollector,
  formatApprovalQuestion,
  formatScriptResult,
  interpreterFor,
  planScriptRun,
  runPlannedScript,
  runSkillScriptTool,
  scriptEnv,
  type ScriptPlan,
} from "../src/skill/runner.js";
import {
  clearScriptApprovals,
  consumeScriptApproval,
  resolvePendingScript,
  setPendingScript,
  type ScriptApprovalToken,
} from "../src/skill/script-approval.js";
import { cleanupTmp, makeFixture, writeSkill, type Fixture } from "./skill-test-utils.js";

afterAll(cleanupTmp);

const hasPython = Bun.which("python3") !== null;
let n = 0;

/** What the loop does on a granted approval: the user answers "Allow once", the loop spends it into a token. */
function mintToken(plan: ScriptPlan): ScriptApprovalToken {
  const sid = `runner-test-${++n}`;
  setPendingScript(sid, plan.fingerprint);
  expect(resolvePendingScript(sid, "Allow once")).toBe("approved");
  const token = consumeScriptApproval(sid, plan.fingerprint);
  clearScriptApprovals(sid);
  expect(token).not.toBeNull();
  return token!;
}

const code = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return e instanceof SkillError ? e.status : -1;
  }
  return 0;
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

function setup(files: Record<string, string>, which: "rye" | "installed" = "installed"): { fx: Fixture; plan: (s: string, args?: unknown) => ScriptPlan; dir: string } {
  const fx = makeFixture();
  const dir = writeSkill(which === "rye" ? fx.rye : fx.ext, "demo", { files });
  return { fx, dir, plan: (script, args) => planScriptRun(fx.store, { skill: "demo", script, args }) };
}

describe("interpreterFor", () => {
  test.each([
    ["scripts/a.sh", "bash"],
    ["scripts/a.ts", "bun"],
    ["scripts/a.js", "bun"],
    ["scripts/a.mjs", "bun"],
    ["scripts/a.py", "python3"],
    ["scripts/A.SH", "bash"],
  ])("%s -> %s", (p, i) => expect(interpreterFor(p)).toBe(i));

  test.each(["scripts/a", "scripts/a.rb", "scripts/a.pl", "scripts/a.exe", "scripts/a.sh.txt", "scripts/.sh", "scripts/a.bash", "scripts/a.zsh"])(
    "refuses %s",
    (p) => expect(interpreterFor(p)).toBeNull(),
  );
});

describe("scriptEnv", () => {
  test("contains only PATH/HOME/LANG/TMPDIR and nothing from Rye's own environment", () => {
    const secrets = {
      RYE_DATA_DIR_TEST: "x",
      RYE_MYSQL_PASSWORD: "pw",
      OPENAI_API_KEY: "k",
      GITHUB_TOKEN: "t",
      AWS_SECRET_ACCESS_KEY: "a",
      MYSQL_PWD: "m",
      NODE_AUTH_TOKEN: "n",
    };
    Object.assign(process.env, secrets);
    try {
      const env = scriptEnv();
      expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
      expect(JSON.stringify(env)).not.toContain("pw");
    } finally {
      for (const k of Object.keys(secrets)) delete process.env[k];
    }
  });
});

describe("planScriptRun", () => {
  test("plans an argv without a shell, cwd = skill dir, and describes the script", () => {
    const { plan, dir } = setup({ "scripts/run.sh": "#!/bin/bash\necho hi\n" });
    const p = plan("scripts/run.sh", ["a", "b c"]);
    expect(p).toMatchObject({ skill: "demo", source: "installed", script: "scripts/run.sh", interpreter: "bash", cwd: dir, args: ["a", "b c"] });
    expect(p.argv).toEqual([Bun.which("bash")!, p.real, "a", "b c"]);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.preview).toContain("echo hi");
  });

  test("scripts/ prefix is optional and normalised", () => {
    const { plan } = setup({ "scripts/run.sh": "echo" });
    expect(plan("run.sh").script).toBe("scripts/run.sh");
    expect(plan("scripts/./run.sh").fingerprint).toBe(plan("run.sh").fingerprint);
  });

  test("fingerprint binds skill, script, content, interpreter and args", () => {
    const { plan, dir, fx } = setup({ "scripts/a.sh": "echo a", "scripts/b.sh": "echo a" });
    const base = plan("a.sh", ["1"]).fingerprint;
    expect(plan("a.sh", ["1"]).fingerprint).toBe(base);
    expect(plan("a.sh", ["2"]).fingerprint).not.toBe(base);
    expect(plan("a.sh", ["1", "2"]).fingerprint).not.toBe(base);
    expect(plan("a.sh", ["1 2"]).fingerprint).not.toBe(plan("a.sh", ["1", "2"]).fingerprint);
    expect(plan("b.sh", ["1"]).fingerprint).not.toBe(base); // same content, different script
    writeSkill(fx.ext, "other", { files: { "scripts/a.sh": "echo a" } });
    expect(planScriptRun(fx.store, { skill: "other", script: "a.sh", args: ["1"] }).fingerprint).not.toBe(base);
    writeFileSync(join(dir, "scripts", "a.sh"), "echo CHANGED");
    expect(plan("a.sh", ["1"]).fingerprint).not.toBe(base);
  });

  test("rejects bad skill names and unknown skills", () => {
    const { fx } = setup({ "scripts/a.sh": "echo" });
    for (const skill of ["../demo", "Demo", "", undefined, 5, "a/b"]) {
      expect(code(() => planScriptRun(fx.store, { skill, script: "a.sh" }))).toBe(400);
    }
    expect(code(() => planScriptRun(fx.store, { skill: "missing", script: "a.sh" }))).toBe(404);
  });

  test("rejects traversal, absolute paths, NULs and backslashes", () => {
    const { plan, dir } = setup({ "scripts/a.sh": "echo" });
    writeFileSync(join(dir, "outside.sh"), "echo outside");
    for (const s of ["../outside.sh", "scripts/../outside.sh", "scripts/../../x.sh", join(dir, "scripts", "a.sh"), "/bin/sh.sh", "scripts/a.sh\0.txt", "scripts\\a.sh", "", "  "]) {
      expect(code(() => plan(s))).toBeGreaterThanOrEqual(400);
    }
  });

  test("only files under scripts/ — not SKILL.md siblings or other folders", () => {
    const { plan } = setup({ "scripts/a.sh": "echo", "other/b.sh": "echo", "top.sh": "echo" });
    expect(code(() => plan("other/b.sh"))).toBe(404); // resolves to scripts/other/b.sh, which doesn't exist
    expect(code(() => plan("top.sh"))).toBe(404);
  });

  test("a symlink in scripts/ pointing outside scripts/ or outside the skill is refused", () => {
    const { plan, dir, fx } = setup({ "scripts/a.sh": "echo", "other.sh": "echo sibling" });
    writeFileSync(join(fx.base, "evil.sh"), "echo evil");
    symlinkSync(join(fx.base, "evil.sh"), join(dir, "scripts", "evil-out.sh"));
    symlinkSync(join(dir, "other.sh"), join(dir, "scripts", "sibling.sh"));
    expect(code(() => plan("evil-out.sh"))).toBe(400);
    expect(code(() => plan("sibling.sh"))).toBe(400);
  });

  test("a symlinked scripts/ directory leaving the skill is refused", () => {
    const fx = makeFixture();
    const dir = writeSkill(fx.ext, "demo");
    const outside = join(fx.base, "outside-scripts");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.sh"), "echo x");
    symlinkSync(outside, join(dir, "scripts"));
    expect(code(() => planScriptRun(fx.store, { skill: "demo", script: "x.sh" }))).toBe(400);
  });

  test("a symlink to another script inside scripts/ is allowed", () => {
    const { plan, dir } = setup({ "scripts/real.sh": "echo real" });
    symlinkSync(join(dir, "scripts", "real.sh"), join(dir, "scripts", "alias.sh"));
    expect(plan("alias.sh").real).toBe(join(dir, "scripts", "real.sh"));
  });

  test("unsupported extensions and no extension are refused", () => {
    const { plan } = setup({ "scripts/a.rb": "puts 1", "scripts/noext": "echo", "scripts/a.sh.bak": "echo", "scripts/.sh": "echo" });
    for (const s of ["a.rb", "noext", "a.sh.bak", ".sh"]) expect(code(() => plan(s))).toBe(400);
  });

  test("a skill with no scripts/ folder and directories named like scripts", () => {
    const fx = makeFixture();
    writeSkill(fx.ext, "bare");
    expect(code(() => planScriptRun(fx.store, { skill: "bare", script: "a.sh" }))).toBe(404);
    const { plan, dir } = setup({});
    mkdirSync(join(dir, "scripts", "dir.sh"), { recursive: true });
    expect(code(() => plan("dir.sh"))).toBe(400);
  });

  test("oversized scripts are refused", () => {
    const { plan } = setup({ "scripts/big.sh": "#".repeat(1024 * 1024 + 1) });
    expect(code(() => plan("big.sh"))).toBe(413);
  });

  test("argument validation", () => {
    const { plan } = setup({ "scripts/a.sh": "echo" });
    expect(code(() => plan("a.sh", "not-an-array"))).toBe(400);
    expect(code(() => plan("a.sh", [{ x: 1 }]))).toBe(400);
    expect(code(() => plan("a.sh", [null]))).toBe(400);
    expect(code(() => plan("a.sh", ["x\0y"]))).toBe(400);
    expect(code(() => plan("a.sh", Array(MAX_SCRIPT_ARGS + 1).fill("a")))).toBe(400);
    expect(code(() => plan("a.sh", ["a".repeat(MAX_SCRIPT_ARG_LENGTH + 1)]))).toBe(400);
    expect(plan("a.sh", Array(MAX_SCRIPT_ARGS).fill("a")).args).toHaveLength(MAX_SCRIPT_ARGS);
    expect(plan("a.sh", [1, true, "s"]).args).toEqual(["1", "true", "s"]);
    expect(plan("a.sh").args).toEqual([]);
    expect(plan("a.sh", null).args).toEqual([]);
  });
});

describe("formatApprovalQuestion", () => {
  test("shows skill, script, args, interpreter, hash, cwd, env and the script head", () => {
    const body = Array.from({ length: 30 }, (_, i) => `echo line${i}`).join("\n");
    const { plan, dir } = setup({ "scripts/a.sh": body });
    const p = plan("a.sh", ["--flag", "; rm -rf /"]);
    const q = formatApprovalQuestion(p);
    expect(q).toContain("`demo`");
    expect(q).toContain("scripts/a.sh");
    expect(q).toContain(p.sha256);
    expect(q).toContain("`bash`");
    expect(q).toContain(JSON.stringify(["--flag", "; rm -rf /"]));
    expect(q).toContain(dir);
    expect(q).toContain("PATH, HOME, LANG, TMPDIR");
    expect(q).toContain("echo line11");
    expect(q).not.toContain("echo line12"); // only the first 12 lines
    expect(q).toContain("installed skill");
    expect(q).toContain("single run only");
  });

  test("long preview lines are cut", () => {
    const { plan } = setup({ "scripts/a.sh": `echo ${"x".repeat(1000)}` });
    expect(formatApprovalQuestion(plan("a.sh")).length).toBeLessThan(2000);
  });
});

describe("OutputCollector", () => {
  test("keeps everything under the cap", () => {
    const c = new OutputCollector(100);
    c.push("abc");
    c.push("def");
    expect(c.truncated).toBe(false);
    expect(c.toString()).toBe("abcdef");
  });

  test("keeps head and tail and counts what was dropped", () => {
    const c = new OutputCollector(20);
    c.push("H".repeat(10));
    c.push("m".repeat(100));
    c.push("T".repeat(10));
    expect(c.truncated).toBe(true);
    const s = c.toString();
    expect(s.startsWith("H".repeat(10))).toBe(true);
    expect(s.endsWith("T".repeat(10))).toBe(true);
    expect(s).toContain("[100 characters omitted]");
    expect(c.total).toBe(120);
  });

  test("many small chunks behave the same as one big chunk", () => {
    const a = new OutputCollector(40);
    const b = new OutputCollector(40);
    const text = Array.from({ length: 500 }, (_, i) => String(i % 10)).join("");
    for (const ch of text) a.push(ch);
    b.push(text);
    expect(a.toString()).toBe(b.toString());
  });
});

describe("runPlannedScript (real processes)", () => {
  const pids: number[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("runs bash with args as literal argv — no shell interpretation", async () => {
    const { plan, fx } = setup({ "scripts/echo.sh": 'for a in "$@"; do echo "ARG:$a"; done\n' });
    const marker = join(fx.base, "pwned");
    const args = [`; touch ${marker}`, "$(touch " + marker + ")", "`touch " + marker + "`", "a && touch " + marker, "$HOME", "*", "x\ny"];
    const r = await runPlannedScript(plan("echo.sh", args));
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(r.output).toContain(`ARG:; touch ${marker}`);
    expect(r.output).toContain("ARG:$HOME");
    expect(r.output).toContain("ARG:*");
    expect(r.output).toContain("ARG:x\ny\n"); // one arg containing a newline
  });

  test("cwd is the skill folder", async () => {
    const { plan, dir } = setup({ "scripts/pwd.sh": "pwd -P\n" });
    const r = await runPlannedScript(plan("pwd.sh"));
    expect(r.output.trim()).toBe(dir);
  });

  test("environment is scrubbed: no RYE_*, tokens or passwords from the parent", async () => {
    const secrets = { RYE_MYSQL_PASSWORD: "rye-pw-123", OPENAI_API_KEY: "sk-secret-1", GITHUB_TOKEN: "ghp_secret", AWS_SECRET_ACCESS_KEY: "aws-secret", MYSQL_PWD: "mysql-secret" };
    Object.assign(process.env, secrets);
    try {
      const { plan } = setup({ "scripts/env.sh": "env\n" });
      const r = await runPlannedScript(plan("env.sh"));
      for (const v of Object.values(secrets)) expect(r.output).not.toContain(v);
      const keys = r.output.split("\n").map((l) => l.split("=")[0]).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
      const allowed = new Set(["PATH", "HOME", "LANG", "TMPDIR", "PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING", "LC_CTYPE"]);
      expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
      expect(keys).toContain("PATH");
    } finally {
      for (const k of Object.keys(secrets)) delete process.env[k];
    }
  });

  test("reports non-zero exit codes and captures stderr", async () => {
    const { plan } = setup({ "scripts/fail.sh": "echo out; echo err >&2; exit 7\n" });
    const p = plan("fail.sh");
    const r = await runPlannedScript(p);
    expect(r.exitCode).toBe(7);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(formatScriptResult(p, r)).toContain("exit code 7");
  });

  test("timeout kills the script", async () => {
    const { plan } = setup({ "scripts/slow.sh": "echo started\nsleep 30\n" });
    const t0 = Date.now();
    const r = await runPlannedScript(plan("slow.sh"), { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.output).toContain("started");
    expect(formatScriptResult(plan("slow.sh"), r)).toContain("timed out");
  });

  test("timeout kills the whole process tree, not just the interpreter", async () => {
    const { plan, fx } = setup({ "scripts/tree.sh": 'sleep 30 &\necho $! > "$1"\nwait\n' });
    const pidFile = join(fx.base, "child.pid");
    const r = await runPlannedScript(plan("tree.sh", [pidFile]), { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    pids.push(child);
    expect(child).toBeGreaterThan(1);
    expect(await waitDead(child)).toBe(true);
  });

  test("a background child left behind by a script that exits normally is reaped", async () => {
    const { plan, fx } = setup({ "scripts/bg.sh": 'sleep 30 >/dev/null 2>&1 &\necho $! > "$1"\necho done\n' });
    const pidFile = join(fx.base, "bg.pid");
    const t0 = Date.now();
    const r = await runPlannedScript(plan("bg.sh", [pidFile]));
    expect(r.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    pids.push(child);
    expect(await waitDead(child)).toBe(true);
  });

  test("a background child holding the output pipe open does not hang the run", async () => {
    const { plan, fx } = setup({ "scripts/hold.sh": 'sleep 30 &\necho $! > "$1"\necho parent-done\n' });
    const pidFile = join(fx.base, "hold.pid");
    const t0 = Date.now();
    const r = await runPlannedScript(plan("hold.sh", [pidFile]));
    pids.push(Number(readFileSync(pidFile, "utf8").trim()));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.output).toContain("parent-done");
  });

  test("abort signal kills the script and its children", async () => {
    const { plan, fx } = setup({ "scripts/tree.sh": 'sleep 30 &\necho $! > "$1"\nwait\n' });
    const pidFile = join(fx.base, "abort.pid");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const t0 = Date.now();
    const r = await runPlannedScript(plan("tree.sh", [pidFile]), { signal: ctl.signal });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    pids.push(child);
    expect(await waitDead(child)).toBe(true);
    expect(formatScriptResult(plan("tree.sh", [pidFile]), r)).toContain("user stopped");
  });

  test("an already-aborted signal never lets the script do its work", async () => {
    const { plan, fx } = setup({ "scripts/late.sh": 'sleep 1\ntouch "$1"\n' });
    const marker = join(fx.base, "late-marker");
    const ctl = new AbortController();
    ctl.abort();
    const r = await runPlannedScript(plan("late.sh", [marker]), { signal: ctl.signal });
    expect(r.aborted).toBe(true);
    await Bun.sleep(1300);
    expect(existsSync(marker)).toBe(false);
  });

  test("output is capped with a head/tail marker", async () => {
    const { plan } = setup({ "scripts/loud.sh": "printf HEAD\nhead -c 100000 /dev/zero | tr '\\0' x\nprintf TAIL\n" });
    const r = await runPlannedScript(plan("loud.sh"));
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(MAX_OUTPUT_CHARS + 100);
    expect(r.output.startsWith("HEAD")).toBe(true);
    expect(r.output.endsWith("TAIL")).toBe(true);
    expect(r.output).toContain("characters omitted");
    expect(formatScriptResult(plan("loud.sh"), r)).toContain("output truncated");
  });

  test("a script that never stops printing is killed at the hard output limit", async () => {
    const { plan } = setup({ "scripts/flood.sh": "yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n" });
    const t0 = Date.now();
    const r = await runPlannedScript(plan("flood.sh"), { timeoutMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("script killed");
    expect(r.output.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
  });

  test("bun scripts get their args after the script path (flags are not eaten by bun)", async () => {
    const { plan } = setup({ "scripts/a.js": "console.log(JSON.stringify(process.argv.slice(2)))\n", "scripts/b.ts": "const x: number = 1; console.log('ts', x, process.argv.length)\n", "scripts/c.mjs": "console.log('mjs ok')\n" });
    const js = await runPlannedScript(plan("a.js", ["--hot", "-e", "console.log(1)", "--smol"]));
    expect(js.exitCode).toBe(0);
    expect(js.output.trim()).toBe(JSON.stringify(["--hot", "-e", "console.log(1)", "--smol"]));
    expect((await runPlannedScript(plan("b.ts"))).output).toContain("ts 1 2");
    expect((await runPlannedScript(plan("c.mjs"))).output).toContain("mjs ok");
  });

  test.skipIf(!hasPython)("python scripts run with python3", async () => {
    const { plan } = setup({ "scripts/a.py": "import sys\nprint(sys.argv[1:])\n" });
    const r = await runPlannedScript(plan("a.py", ["-c", "x; y"]));
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("['-c', 'x; y']");
  });
});

describe("runSkillScriptTool approval gate", () => {
  const REFUSED = "Refused";

  test("refuses to run without an approval token — nothing executes", async () => {
    const { fx } = setup({ "scripts/touch.sh": 'touch "$1"\n' });
    const marker = join(fx.base, "m1");
    const out = await runSkillScriptTool(fx.store, { skill: "demo", script: "touch.sh", args: [marker] }, undefined);
    expect(out).toStartWith(REFUSED);
    expect(existsSync(marker)).toBe(false);
  });

  test("forged tokens are refused (plain object, string, copied fields)", async () => {
    const { fx, plan } = setup({ "scripts/touch.sh": 'touch "$1"\n' });
    const marker = join(fx.base, "m2");
    const p = plan("touch.sh", [marker]);
    for (const forged of [{ fingerprint: p.fingerprint }, { fingerprint: p.fingerprint, used: false }, p.fingerprint, true, {}] as unknown[]) {
      const out = await runSkillScriptTool(fx.store, { skill: "demo", script: "touch.sh", args: [marker] }, forged as ScriptApprovalToken);
      expect(out).toStartWith(REFUSED);
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("a valid token runs the script once; the second use is refused", async () => {
    const { fx, plan } = setup({ "scripts/count.sh": 'echo run >> "$1"\n' });
    const log = join(fx.base, "runs.log");
    const token = mintToken(plan("count.sh", [log]));
    const args = { skill: "demo", script: "count.sh", args: [log] };
    const first = await runSkillScriptTool(fx.store, args, token);
    expect(first).toContain("exit code 0");
    const second = await runSkillScriptTool(fx.store, args, token);
    expect(second).toStartWith(REFUSED);
    expect(readFileSync(log, "utf8")).toBe("run\n");
  });

  test("a token is bound to the exact args, script and skill", async () => {
    const { fx, plan } = setup({ "scripts/touch.sh": 'touch "$1"\n', "scripts/other.sh": 'touch "$1"\n' });
    writeSkill(fx.ext, "twin", { files: { "scripts/touch.sh": 'touch "$1"\n' } });
    const okMarker = join(fx.base, "ok");
    const badMarker = join(fx.base, "bad");
    const token = mintToken(plan("touch.sh", [okMarker]));

    expect(await runSkillScriptTool(fx.store, { skill: "demo", script: "touch.sh", args: [badMarker] }, token)).toStartWith(REFUSED);
    expect(await runSkillScriptTool(fx.store, { skill: "demo", script: "other.sh", args: [okMarker] }, token)).toStartWith(REFUSED);
    expect(await runSkillScriptTool(fx.store, { skill: "twin", script: "touch.sh", args: [okMarker] }, token)).toStartWith(REFUSED);
    expect(await runSkillScriptTool(fx.store, { skill: "demo", script: "touch.sh", args: [okMarker, "extra"] }, token)).toStartWith(REFUSED);
    expect(existsSync(badMarker)).toBe(false);
    expect(existsSync(okMarker)).toBe(false);

    expect(await runSkillScriptTool(fx.store, { skill: "demo", script: "touch.sh", args: [okMarker] }, token)).toContain("exit code 0");
    expect(existsSync(okMarker)).toBe(true);
  });

  test("editing the script after approval invalidates the token", async () => {
    const { fx, plan, dir } = setup({ "scripts/safe.sh": 'echo safe\n' }, "rye");
    const marker = join(fx.base, "swapped");
    const token = mintToken(plan("safe.sh"));
    writeFileSync(join(dir, "scripts", "safe.sh"), `touch ${marker}\n`);
    const out = await runSkillScriptTool(fx.store, { skill: "demo", script: "safe.sh" }, token);
    expect(out).toStartWith(REFUSED);
    expect(existsSync(marker)).toBe(false);
  });

  test("planning errors come back as text, not as a run", async () => {
    const { fx } = setup({ "scripts/a.sh": "echo" });
    const token = mintToken(planScriptRun(fx.store, { skill: "demo", script: "a.sh" }));
    expect(await runSkillScriptTool(fx.store, { skill: "demo", script: "../../etc/passwd.sh" }, token)).toStartWith("Error:");
    expect(await runSkillScriptTool(fx.store, { skill: "demo", script: "a.rb" }, token)).toStartWith("Error:");
    expect(await runSkillScriptTool(fx.store, { skill: "nope", script: "a.sh" }, token)).toStartWith("Error:");
  });

  test("abort signal passed to the tool kills the run", async () => {
    const { fx, plan } = setup({ "scripts/slow.sh": "sleep 30\n" });
    const token = mintToken(plan("slow.sh"));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const t0 = Date.now();
    const out = await runSkillScriptTool(fx.store, { skill: "demo", script: "slow.sh" }, token, ctl.signal);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out).toContain("user stopped the run");
  });
});
