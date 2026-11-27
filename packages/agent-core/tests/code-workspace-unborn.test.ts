/**
 * Code sessions on a repo whose base has no commits yet (`git init`, nothing committed): the
 * session starts from an empty root commit Rye writes, the user's untracked files never reach it,
 * and the user's repo is left exactly as it was. Real git on temporary repos only: no network, no
 * agents, no global git config.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { FakeScript } from "../src/code/engines/fake.js";
import { createCodeGit } from "../src/code/git.js";
import { codeRoutes } from "../src/code/routes.js";
import type { CodeRepoConfig } from "../src/code/types.js";
import { createWorkspaceManager, readWorkspace } from "../src/code/workspace.js";
import { cleanup, codeHarness, waitFor } from "./code-test-utils.js";

const TIMEOUT = 60_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  cleanup();
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const HOME = tmp("rye-unborn-home-");
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Plain git, as the user (or the agent in its clone) would run it. */
function git(cwd: string, args: string[], o: { allowFail?: boolean } = {}): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Test User", "-c", "user.email=test@example.com", ...args], { cwd, env: ENV, stdin: "ignore", timeout: 30_000 });
  if (r.exitCode !== 0 && !o.allowFail) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Every file under `root` except `.git`, as path → content hash. */
function treeHash(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === "" && name === ".git") continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p, r);
      else out[r] = sha256(readFileSync(p));
    }
  };
  walk(root, "");
  return out;
}

/** What must never change in the user's repo: refs (other than Rye's), HEAD, index bytes, working tree, stash, config. */
function fingerprint(repo: string) {
  const indexPath = join(repo, ".git", "index");
  return {
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n").filter((l) => l && !l.startsWith("refs/rye/") && !l.startsWith("refs/heads/rye/")),
    head: readFileSync(join(repo, ".git", "HEAD"), "utf8"),
    index: existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "",
    worktree: treeHash(repo),
    stash: git(repo, ["stash", "list"], { allowFail: true }),
    config: sha256(readFileSync(join(repo, ".git", "config"))),
  };
}

const ryeRefs = (repo: string) =>
  git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter((l) => l.startsWith("refs/rye/") || l.startsWith("refs/heads/rye/"));
const allRefs = (repo: string) => git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);

/** A brand-new repo: `git init` on main, nothing committed, an untracked folder and one staged file. */
function makeUnbornRepo(): string {
  const repo = join(tmp("rye-unborn-user-"), "project");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, "untracked-folder/secret.env", "API_KEY=do-not-copy\n");
  write(repo, "untracked-folder/notes.md", "# private\n");
  write(repo, "staged.txt", "staged content\n");
  git(repo, ["add", "staged.txt"]);
  return repo;
}

const repoConfig = (path: string, extra: Partial<CodeRepoConfig> = {}): CodeRepoConfig => ({ name: "project", path, isolation: "clone", setup: [], checks: [], ...extra });

let n = 0;
async function newSession(userRepo: string, o: { includeUncommitted?: boolean; base?: string; repo?: Partial<CodeRepoConfig> } = {}) {
  const root = join(tmp("rye-unborn-root-"), "code");
  const manager = createWorkspaceManager();
  const codeGit = createCodeGit({ git: manager.git });
  const ws = await manager.create({
    sessionId: `u${++n}`,
    repo: repoConfig(userRepo, o.repo),
    base: o.base,
    slug: `task-${n}`,
    includeUncommitted: o.includeUncommitted ?? false,
    root,
  });
  return { manager, codeGit, ws, root };
}

/** The user's main is still unborn: HEAD names it and it doesn't exist. */
function expectStillUnborn(repo: string): void {
  expect(git(repo, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/main");
  expect(git(repo, ["rev-parse", "--verify", "-q", "refs/heads/main"], { allowFail: true }).trim()).toBe("");
}

// ===========================================================================

describe("a base with no commits yet", () => {
  test(
    "the session starts from an empty root commit; untracked files never reach it; the user's repo is untouched",
    async () => {
      const user = makeUnbornRepo();
      const before = fingerprint(user);
      const { ws } = await newSession(user);

      expect(ws.baseUnborn).toBe(true);
      expect(ws.baseRef).toBe("main");
      expect(ws.emptyRootSha).toBe(ws.baseSha);
      // One root commit of the empty tree, by Rye.
      expect(git(user, ["rev-list", "--parents", "-n", "1", ws.baseSha]).trim()).toBe(ws.baseSha);
      expect(git(user, ["rev-parse", `${ws.baseSha}^{tree}`]).trim()).toBe(git(user, ["hash-object", "-t", "tree", "/dev/null"]).trim());
      expect(git(user, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", ws.baseSha]).trim()).toBe("Rye <rye@localhost>|Rye <rye@localhost>|Empty project (Rye code session base)");

      // The clone is empty: no staged file without includeUncommitted, and never the untracked folder.
      expect(treeHash(ws.repoDir)).toEqual({});
      expect(git(ws.repoDir, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(ws.branch);
      expect(git(ws.repoDir, ["rev-parse", "HEAD"]).trim()).toBe(ws.baseSha);

      // The user's repo: same HEAD (still unborn), index, working tree, stash; only refs/rye/* added.
      expect(fingerprint(user)).toEqual(before);
      expectStillUnborn(user);
      expect(allRefs(user)).toEqual([`refs/rye/${ws.sessionId}/base`]);
      expect(readWorkspace(ws.sessionDir)).toEqual(ws);
    },
    TIMEOUT,
  );

  test(
    "includeUncommitted carries only the staged files, on top of the empty root",
    async () => {
      const user = makeUnbornRepo();
      const before = fingerprint(user);
      const { ws } = await newSession(user, { includeUncommitted: true });

      expect(ws.baseUnborn).toBe(true);
      expect(ws.baseSha).not.toBe(ws.emptyRootSha);
      expect(git(user, ["rev-parse", `${ws.baseSha}^`]).trim()).toBe(ws.emptyRootSha!);
      expect(git(user, ["ls-tree", "-r", "--name-only", ws.baseSha]).trim()).toBe("staged.txt");
      expect(Object.keys(treeHash(ws.repoDir))).toEqual(["staged.txt"]);
      expect(readFileSync(join(ws.repoDir, "staged.txt"), "utf8")).toBe("staged content\n");
      expect(existsSync(join(ws.repoDir, "untracked-folder"))).toBe(false);

      expect(fingerprint(user)).toEqual(before);
      expectStillUnborn(user);
      expect(allRefs(user)).toEqual([`refs/rye/${ws.sessionId}/base`]);
    },
    TIMEOUT,
  );

  test(
    "status, snapshot, archive, restore and Create branch (kept and squashed) start their history at the empty root",
    async () => {
      const user = makeUnbornRepo();
      const before = fingerprint(user);
      const { manager, codeGit, ws } = await newSession(user);
      const root = ws.emptyRootSha!;

      write(ws.repoDir, "src/app.ts", "export const app = 1;\n");
      git(ws.repoDir, ["add", "-A"]);
      git(ws.repoDir, ["commit", "-q", "-m", "agent commit"]);
      write(ws.repoDir, "notes.txt", "uncommitted\n");

      const st = await codeGit.status(ws);
      expect(st).toMatchObject({ base: "main", baseSha: root, baseTip: root, ahead: 1, behind: 0, dirty: true, baseUnborn: true });
      expect(st.stat.files).toBe(2);

      const snap = await manager.snapshot(ws, 1);
      expect(git(user, ["rev-parse", `${snap.sha}^`]).trim()).toBe(git(ws.repoDir, ["rev-parse", "HEAD"]).trim());
      write(ws.repoDir, "after.txt", "after the snapshot\n");
      const files = treeHash(ws.repoDir);
      await manager.archive(ws);
      expect(existsSync(ws.repoDir)).toBe(false);
      await manager.restore(ws);
      expect(treeHash(ws.repoDir)).toEqual(files);
      expect((await codeGit.status(ws)).ahead).toBe(1);

      const kept = await codeGit.createBranch(ws, { name: "rye/kept", mode: "keep" });
      expect(kept).toMatchObject({ status: "created", branch: "rye/kept", commits: 2 });
      expect(git(user, ["rev-list", "--max-parents=0", "rye/kept"]).trim()).toBe(root);
      expect(git(user, ["ls-tree", "-r", "--name-only", "rye/kept"]).trim().split("\n")).toEqual(["after.txt", "notes.txt", "src/app.ts"]);

      const squash = await codeGit.createBranch(ws, { name: "rye/squashed", mode: "squash", message: "All of it" });
      expect(squash).toMatchObject({ status: "created", commits: 1 });
      expect(git(user, ["rev-list", "--parents", "-n", "1", "rye/squashed"]).trim().split(" ").slice(1)).toEqual([root]);
      expect(git(user, ["rev-list", "--count", "rye/squashed"]).trim()).toBe("2");

      // Merge is refused while the base has no commits, and writes nothing.
      const refs = ryeRefs(user);
      await expect(codeGit.mergeWithBase(ws, { name: "rye/merged" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("main has no commits yet") });
      expect(ryeRefs(user)).toEqual(refs);

      expect(fingerprint(user)).toEqual(before);
      expectStillUnborn(user);
      expect(allRefs(user).filter((r) => !r.startsWith("refs/rye/") && !r.startsWith("refs/heads/rye/"))).toEqual([]);
      git(user, ["fsck", "--strict", "--no-progress"]);
    },
    TIMEOUT,
  );

  test(
    "after the user commits to main: status counts against the real tip, and merge joins the unrelated histories onto a new branch",
    async () => {
      const user = makeUnbornRepo();
      const { codeGit, ws } = await newSession(user);
      write(ws.repoDir, "src/app.ts", "export const app = 1;\n");
      git(ws.repoDir, ["add", "-A"]);
      git(ws.repoDir, ["commit", "-q", "-m", "agent commit"]);

      // The user's own first commit (their index and working tree change: that's them, not Rye).
      git(user, ["commit", "-q", "-m", "first"]);
      git(user, ["add", "untracked-folder/notes.md"]);
      git(user, ["commit", "-q", "-m", "second"]);
      const tip = git(user, ["rev-parse", "main"]).trim();
      const fp = fingerprint(user);

      // Unrelated histories: ahead is the session's work after the empty root, behind is all of main.
      const st = await codeGit.status(ws);
      expect(st).toMatchObject({ baseTip: tip, ahead: 1, behind: 2 });
      expect(st.baseUnborn).toBeUndefined();

      const r = await codeGit.mergeWithBase(ws, { name: "rye/merged", message: "Merge main" });
      expect(r).toMatchObject({ status: "merged", branch: "rye/merged", baseTip: tip });
      if (r.status !== "merged") throw new Error("unreachable");
      expect(git(user, ["rev-list", "--parents", "-n", "1", r.sha]).trim().split(" ").slice(1)).toEqual([git(ws.repoDir, ["rev-parse", "HEAD"]).trim(), tip]);
      expect(git(user, ["ls-tree", "-r", "--name-only", r.sha]).trim().split("\n")).toEqual(["src/app.ts", "staged.txt", "untracked-folder/notes.md"]);
      expect(fingerprint(user)).toEqual(fp);
      expect(git(user, ["rev-parse", "main"]).trim()).toBe(tip);
    },
    TIMEOUT,
  );

  test(
    "after the user commits to main: a file added on both sides is an add/add conflict and nothing is written",
    async () => {
      const user = makeUnbornRepo();
      const { codeGit, ws } = await newSession(user);
      write(ws.repoDir, "staged.txt", "the agent's version\n");
      git(user, ["commit", "-q", "-m", "first"]);
      const refs = ryeRefs(user);

      const r = await codeGit.mergeWithBase(ws, { name: "rye/conflicted" });
      expect(r.status).toBe("conflicts");
      if (r.status !== "conflicts") throw new Error("unreachable");
      expect(r.conflicts.map((c) => [c.path, c.kind])).toEqual([["staged.txt", "add_add"]]);
      expect(ryeRefs(user)).toEqual(refs);
    },
    TIMEOUT,
  );

  test(
    "after the user fast-forwards main onto a session branch, the histories are related again",
    async () => {
      const user = makeUnbornRepo();
      const { codeGit, ws } = await newSession(user);
      write(ws.repoDir, "src/app.ts", "export const app = 1;\n");
      git(ws.repoDir, ["add", "-A"]);
      git(ws.repoDir, ["commit", "-q", "-m", "agent commit"]);
      await codeGit.createBranch(ws, { name: "rye/kept", mode: "keep" });
      git(user, ["rm", "-q", "--cached", "staged.txt"]);
      git(user, ["merge", "-q", "--ff-only", "rye/kept"]);
      expect(git(user, ["rev-parse", "main"]).trim()).toBe(git(user, ["rev-parse", "rye/kept"]).trim());

      expect(await codeGit.status(ws)).toMatchObject({ ahead: 0, behind: 0 });
      write(ws.repoDir, "more.txt", "more\n");
      const r = await codeGit.mergeWithBase(ws, { name: "rye/again" });
      expect(r.status).toBe("merged");
    },
    TIMEOUT,
  );
});

describe("a base that names nothing", () => {
  test(
    "a configured base that doesn't exist names the branches that do, and writes nothing",
    async () => {
      const user = join(tmp("rye-unborn-branches-"), "project");
      mkdirSync(user);
      git(user, ["init", "-q", "-b", "main"]);
      write(user, "a.txt", "a\n");
      git(user, ["add", "-A"]);
      git(user, ["commit", "-q", "-m", "init"]);
      git(user, ["branch", "dev"]);
      const before = fingerprint(user);

      const err = await newSession(user, { repo: { base: "release" } }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "not_found" });
      expect((err as Error).message).toBe('project has no branch or commit named "release". Its branches: dev, main.');
      expect((err as Error).message).not.toContain("no commit named release");
      expect(fingerprint(user)).toEqual(before);
      expect(ryeRefs(user)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "in a repo with no commits, a base other than the checked-out branch says which one to use",
    async () => {
      const user = makeUnbornRepo();
      const before = fingerprint(user);
      const err = await newSession(user, { base: "develop" }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "not_found" });
      expect((err as Error).message).toContain('no branch or commit named "develop"');
      expect((err as Error).message).toContain("no commits yet; its checked-out branch is main");
      expect(fingerprint(user)).toEqual(before);
      expect(allRefs(user)).toEqual([]);
    },
    TIMEOUT,
  );
});

// ===========================================================================

const script: FakeScript = async function* (ctx) {
  yield { type: "engine_session", id: "eng-unborn" };
  writeFileSync(join(ctx.options.workspace.repoDir, "hello.ts"), "export const hello = 1;\n");
  yield { type: "text", delta: "Added hello.ts." };
  yield { type: "done", reason: "end" };
};

const JSON_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:8080" };

describe("/code/ routes on a repo with no commits", () => {
  test(
    "repos and branches say so; POST /code/sessions starts from an empty project; merge is refused, Create branch works",
    async () => {
      const user = makeUnbornRepo();
      const h = codeHarness(script, { repos: [{ name: "fresh", path: user, isolation: "clone", setup: [], checks: [] }] });
      const a = new Hono();
      a.route("/code/", codeRoutes({ runner: () => h.runner, enabled: () => true }));
      const post = (path: string, body: unknown) => a.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const before = fingerprint(user);

      const repos = (await (await a.request("/code/repos")).json()) as { repos: Array<{ name: string; base: string; unborn?: boolean }> };
      expect(repos.repos).toEqual([expect.objectContaining({ name: "fresh", base: "main", available: true, unborn: true })]);
      const branches = await (await a.request("/code/repos/fresh/branches")).json();
      expect(branches).toEqual({ branches: [], defaultBase: "main", dirty: true, unbornBranch: "main" });

      const created = await post("/code/sessions", { repo: "fresh", base: "main", task: "Say hello" });
      expect(created.status).toBe(200);
      const { session } = (await created.json()) as { session: { id: string; baseUnborn?: boolean; base: string; status: { branch: { baseUnborn?: boolean } | null } } };
      expect(session.baseUnborn).toBe(true);
      expect(session.base).toBe("main");
      await waitFor(() => !h.runner.isRunning(session.id), 10_000, "the run to finish");
      expect(h.engine.runs[0].options.systemPrompt).toContain("starts from an empty project");

      const status = (await (await a.request(`/code/sessions/${session.id}/status`)).json()) as { branch: { baseUnborn?: boolean; behind: number } };
      expect(status.branch).toMatchObject({ baseUnborn: true, behind: 0 });

      const merge = await post(`/code/sessions/${session.id}/merge`, { name: "rye/merged" });
      expect(merge.status).toBe(400);
      expect(await merge.json()).toEqual({ error: "main has no commits yet, so there is nothing to merge; use Create branch.", code: "invalid" });

      const branch = await post(`/code/sessions/${session.id}/branch`, { name: "rye/hello", mode: "keep" });
      expect(branch.status).toBe(200);
      expect(await branch.json()).toMatchObject({ status: "created", branch: "rye/hello" });
      expect(git(user, ["show", "rye/hello:hello.ts"])).toBe("export const hello = 1;\n");
      expect(git(user, ["ls-tree", "-r", "--name-only", "rye/hello"]).trim()).toBe("hello.ts");

      expect(fingerprint(user)).toEqual(before);
      expectStillUnborn(user);
    },
    TIMEOUT,
  );
});
