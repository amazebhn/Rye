/**
 * Code sessions: workspace isolation and Rye's hardened git (docs/design/code-sessions.md §3.1,
 * §3.5, §8). Real git on temporary repos only: no network, no agents, no global git config
 * (every command here runs with GIT_CONFIG_GLOBAL=/dev/null and a per-command identity).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGitError, MAX_DIFF_LINES, createCodeGit, isSafeRepoPath, lockfileHosts, parseHunks, parseMergeTree, sensitiveFlags } from "../src/code/git.js";
import type { CodeRepoConfig, Workspace } from "../src/code/types.js";
import { createWorkspaceManager, readWorkspace, workspacePaths } from "../src/code/workspace.js";

const TIMEOUT = 60_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const HOME = tmp("rye-ws-home-");
const ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME,
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Plain git, as the user (or the agent inside its clone) would run it. Identity per command. */
function git(cwd: string, args: string[], o: { env?: Record<string, string>; allowFail?: boolean; input?: string } = {}): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Test User", "-c", "user.email=test@example.com", ...args], {
    cwd,
    env: { ...ENV, ...o.env },
    stdin: o.input !== undefined ? new TextEncoder().encode(o.input) : "ignore",
    timeout: 30_000,
  });
  if (r.exitCode !== 0 && !o.allowFail) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function write(root: string, rel: string, content: string | Uint8Array): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

/** A user repo on `main` with a few files and one commit. */
function makeUserRepo(): string {
  const repo = join(tmp("rye-ws-user-"), "project");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, "README.md", "# Project\n");
  write(repo, "src/a.ts", lines(20));
  write(repo, "src/old.txt", lines(30, "rename me"));
  write(repo, "del.txt", "delete me\n");
  write(repo, "keep.txt", "keep\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

/** Commit `files` onto `branch` with plumbing only (the user's index and working tree are untouched). */
function commitOnBranch(repo: string, branch: string, files: Record<string, string>, message = "user commit"): string {
  const idx = join(tmp("rye-ws-idx-"), "index");
  const env = { GIT_INDEX_FILE: idx };
  git(repo, ["read-tree", branch], { env });
  for (const [path, content] of Object.entries(files)) {
    const sha = git(repo, ["hash-object", "-w", "--stdin"], { input: content }).trim();
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`], { env });
  }
  const tree = git(repo, ["write-tree"], { env }).trim();
  const parent = git(repo, ["rev-parse", branch]).trim();
  const commit = git(repo, ["commit-tree", tree, "-p", parent, "-m", message]).trim();
  git(repo, ["update-ref", `refs/heads/${branch}`, commit, parent]);
  return commit;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Every file under `root` except `.git`, as path → content hash (symlinks by target, with mode bits). */
function treeHash(root: string, skip = new Set([".git"])): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === "" && skip.has(name)) continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p, r);
      else out[r] = `${(st.mode & 0o111) !== 0 ? "x" : "-"}:${sha256(readFileSync(p))}`;
    }
  };
  walk(root, "");
  return out;
}

interface Fingerprint {
  refs: string[];
  head: string;
  index: string;
  worktree: Record<string, string>;
  stash: string;
  config: string;
}

/** What must never change in the user's repo: refs (other than Rye's), HEAD, index bytes, working tree, stash, config. */
function fingerprint(repo: string): Fingerprint {
  const refs = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])
    .split("\n")
    .filter((l) => l && !l.startsWith("refs/rye/") && !l.startsWith("refs/heads/rye/"));
  const indexPath = join(repo, ".git", "index");
  return {
    refs,
    head: readFileSync(join(repo, ".git", "HEAD"), "utf8"),
    index: existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "",
    worktree: treeHash(repo),
    stash: git(repo, ["stash", "list"]),
    config: sha256(readFileSync(join(repo, ".git", "config"))),
  };
}

/** Rye's refs in the user repo: only refs/rye/* and refs/heads/rye/*. */
function ryeRefs(repo: string): string[] {
  return git(repo, ["for-each-ref", "--format=%(refname)"])
    .split("\n")
    .filter((l) => l.startsWith("refs/rye/") || l.startsWith("refs/heads/rye/"));
}

function repoConfig(path: string, extra: Partial<CodeRepoConfig> = {}): CodeRepoConfig {
  return { name: "project", path, isolation: "clone", setup: [], checks: [], ...extra };
}

let sessionN = 0;
async function newSession(userRepo: string, o: { includeUncommitted?: boolean; base?: string } = {}) {
  const root = join(tmp("rye-ws-root-"), "code");
  const manager = createWorkspaceManager({ git: undefined });
  const codeGit = createCodeGit({ git: manager.git });
  const id = `s${++sessionN}`;
  const ws = await manager.create({
    sessionId: id,
    repo: repoConfig(userRepo),
    base: o.base,
    slug: `task-${sessionN}`,
    includeUncommitted: o.includeUncommitted ?? false,
    root,
  });
  return { manager, codeGit, ws, root };
}

// ===========================================================================

describe("pure helpers", () => {
  test("parseHunks: line numbers, sections and the no-newline marker", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 1111111..2222222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@ function top()",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -10 +10,2 @@",
      "-ten",
      "\\ No newline at end of file",
      "+--- ten",
      "+eleven",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const { hunks, truncated, binary } = parseHunks(patch);
    expect(truncated).toBe(false);
    expect(binary).toBe(false);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: "function top()" });
    expect(hunks[0].lines).toEqual([
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "del", text: "two", oldLine: 2 },
      { kind: "add", text: "TWO", newLine: 2 },
      { kind: "context", text: "three", oldLine: 3, newLine: 3 },
    ]);
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 });
    expect(hunks[1].lines).toEqual([
      { kind: "del", text: "ten", oldLine: 10, noNewline: true },
      { kind: "add", text: "--- ten", newLine: 10 },
      { kind: "add", text: "eleven", newLine: 11, noNewline: true },
    ]);
    expect(parseHunks("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary).toBe(true);
    expect(parseHunks(patch, 3).truncated).toBe(true);
  });

  test("sensitive flags by path, mode and content", () => {
    const kinds = (path: string, extra: Partial<Parameters<typeof sensitiveFlags>[0]> = {}) =>
      sensitiveFlags({ path, status: "modified", binary: false, ...extra }).map((f) => f.kind);
    expect(kinds("package.json")).toEqual(["manifest"]);
    expect(kinds("apps/web/package.json")).toEqual(["manifest"]);
    expect(kinds("bun.lock")).toEqual(["lockfile"]);
    expect(kinds(".github/workflows/ci.yml")).toEqual(["ci"]);
    expect(kinds(".husky/pre-commit")).toEqual(["git_hooks"]);
    expect(kinds("lefthook.yml")).toEqual(["git_hooks"]);
    expect(kinds(".envrc")).toEqual(["envrc"]);
    expect(kinds(".vscode/tasks.json")).toEqual(["editor_tasks"]);
    expect(kinds(".claude/settings.json")).toEqual(["agent_config"]);
    expect(kinds(".mcp.json")).toEqual(["agent_config"]);
    expect(kinds("AGENTS.md")).toEqual(["agent_instructions"]);
    expect(kinds("packages/x/CLAUDE.md")).toEqual(["agent_instructions"]);
    expect(kinds(".env")).toEqual(["env_file"]);
    expect(kinds("config/.env.production")).toEqual(["env_file"]);
    expect(kinds("src/index.ts")).toEqual([]);
    expect(kinds("x.png", { binary: true })).toEqual(["binary"]);
    expect(kinds("renamed.yml", { status: "renamed", oldPath: ".github/workflows/ci.yml" })).toEqual(["ci"]);
    const link = sensitiveFlags({ path: "l", status: "added", binary: false, newMode: "120000" }, { symlinkTarget: "../../.ssh" });
    expect(link).toEqual([{ kind: "symlink", detail: "new symlink → ../../.ssh" }]);
    expect(sensitiveFlags({ path: "run.sh", status: "modified", binary: false, oldMode: "100644", newMode: "100755" })).toEqual([
      { kind: "executable", detail: "mode 100644 → 100755" },
    ]);
    expect(lockfileHosts(['  resolved "https://registry.yarnpkg.com/a/-/a-1.0.0.tgz"', '"b": "git+ssh://git@evil.example.com/x.git"', "c git@github.com:o/r"])).toEqual([
      "evil.example.com",
      "github.com",
      "registry.yarnpkg.com",
    ]);
  });

  test("repo paths: no .., no .git, not absolute", () => {
    for (const ok of ["a", "src/a.ts", "x/.gitignore", ".github/workflows/ci.yml", "a..b"]) expect(isSafeRepoPath(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "./a", "a//b", ".git/config", "x/.GIT/hooks", ".git. /x", "a\0b"]) expect(isSafeRepoPath(bad)).toBe(false);
  });

  test("parseMergeTree maps conflict kinds", () => {
    const out = [
      "abc123",
      "a.txt",
      "both.txt",
      "d.txt",
      "",
      "1", "a.txt", "Auto-merging", "Auto-merging a.txt\n",
      "1", "a.txt", "CONFLICT (contents)", "CONFLICT (content): Merge conflict in a.txt\n",
      "1", "both.txt", "CONFLICT (contents)", "CONFLICT (add/add): Merge conflict in both.txt\n",
      "1", "d.txt", "CONFLICT (modify/delete)", "CONFLICT (modify/delete): d.txt deleted in X and modified in Y.\n",
      "",
    ].join("\0");
    const r = parseMergeTree(out);
    expect(r.tree).toBe("abc123");
    expect(r.conflicts.map((c) => [c.path, c.kind])).toEqual([
      ["a.txt", "content"],
      ["both.txt", "add_add"],
      ["d.txt", "modify_delete"],
    ]);
  });

  test("workspacePaths lays out a session directory and refuses odd ids", () => {
    const p = workspacePaths("/data/code", "abc_1");
    expect(p).toEqual({
      sessionDir: "/data/code/abc_1",
      repoDir: "/data/code/abc_1/repo",
      tmpDir: "/data/code/abc_1/tmp",
      cacheDir: "/data/code/abc_1/cache",
      binDir: "/data/code/abc_1/cache/bin",
      eventsFile: "/data/code/abc_1/events.jsonl",
      sessionFile: "/data/code/abc_1/session.json",
    });
    for (const bad of ["", "../x", "a/b", ".hidden", "x".repeat(65)]) expect(() => workspacePaths("/data/code", bad)).toThrow(CodeGitError);
    expect(() => workspacePaths("relative", "abc")).toThrow(CodeGitError);
  });
});

// ===========================================================================

describe("the user's repo is untouched", () => {
  test(
    "refs, HEAD, index, working tree, stash and config survive create, snapshot, archive, restore, create-branch and merge",
    async () => {
      const user = makeUserRepo();
      // A busy checkout: a stash entry, a staged new file, an unstaged edit and an untracked file.
      write(user, "keep.txt", "stashed edit\n");
      git(user, ["stash", "push", "-q", "-m", "user stash"]);
      write(user, "staged-new.txt", "staged\n");
      git(user, ["add", "staged-new.txt"]);
      write(user, "src/a.ts", lines(20).replace("line 5", "user edit"));
      write(user, ".env", "SECRET=1\n");

      const before = fingerprint(user);
      const { manager, codeGit, ws } = await newSession(user);
      expect(fingerprint(user)).toEqual(before);
      expect(ryeRefs(user)).toEqual([`refs/rye/${ws.sessionId}/base`]);

      // The agent works in its clone.
      write(ws.repoDir, "src/a.ts", lines(20).replace("line 2", "agent edit"));
      git(ws.repoDir, ["commit", "-q", "-am", "agent commit"]);
      write(ws.repoDir, "agent-new.txt", "new\n");

      // The user moves on: a commit on main (changes the user's own refs, so re-fingerprint).
      commitOnBranch(user, "main", { "upstream.txt": "from upstream\n" });
      const fp = fingerprint(user);
      const check = () => expect(fingerprint(user)).toEqual(fp);

      await codeGit.status(ws);
      await codeGit.changes(ws, "base");
      await codeGit.fileDiff(ws, "src/a.ts", "base");
      check();
      await manager.snapshot(ws, 1);
      check();
      const branch = await codeGit.createBranch(ws, { name: "rye/my-branch", mode: "keep" });
      expect(branch.status).toBe("created");
      check();
      const squash = await codeGit.createBranch(ws, { name: "rye/my-squash", mode: "squash", message: "Squashed work" });
      expect(squash.status).toBe("created");
      check();
      const merged = await codeGit.mergeWithBase(ws, { name: "rye/merged", message: "Merge main" });
      expect(merged.status).toBe("merged");
      check();
      write(ws.repoDir, "after-snapshot.txt", "so archive has something new to keep\n");
      await manager.archive(ws);
      check();
      await manager.restore(ws);
      check();
      await codeGit.stage(ws, ["agent-new.txt"], true);
      await codeGit.stage(ws, ["agent-new.txt"], false);
      await codeGit.discard(ws, ["agent-new.txt"]);
      check();

      const id = ws.sessionId;
      expect(ryeRefs(user).sort()).toEqual(
        [`refs/heads/rye/merged`, `refs/heads/rye/my-branch`, `refs/heads/rye/my-squash`, `refs/rye/${id}/archive-1`, `refs/rye/${id}/base`, `refs/rye/${id}/turn-1`].sort(),
      );
      git(user, ["fsck", "--strict", "--no-progress"]);
      // The new branches never touched the user's checked-out branch.
      expect(git(user, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/main");
    },
    TIMEOUT,
  );

  test(
    "uncommitted changes are carried into the clone when asked, and the user's copy stays as it was",
    async () => {
      const user = makeUserRepo();
      write(user, "src/a.ts", lines(20).replace("line 3", "unstaged edit"));
      write(user, "staged-new.txt", "staged new\n");
      git(user, ["add", "staged-new.txt"]);
      write(user, "keep.txt", "staged edit\n");
      git(user, ["add", "keep.txt"]);
      write(user, "keep.txt", "staged edit, then edited again\n");
      unlinkSync(join(user, "del.txt"));
      write(user, ".env", "SECRET=untracked\n");
      const before = fingerprint(user);
      const head = git(user, ["rev-parse", "HEAD"]).trim();

      const { ws } = await newSession(user, { includeUncommitted: true });
      expect(fingerprint(user)).toEqual(before);
      expect(ws.includeUncommitted).toBe(true);
      expect(ws.baseSha).not.toBe(head);
      expect(git(user, ["rev-parse", `${ws.baseSha}^1`]).trim()).toBe(head);
      expect(git(user, ["rev-parse", ws.baseRefPin]).trim()).toBe(ws.baseSha);

      expect(readFileSync(join(ws.repoDir, "src/a.ts"), "utf8")).toContain("unstaged edit");
      expect(readFileSync(join(ws.repoDir, "staged-new.txt"), "utf8")).toBe("staged new\n");
      expect(readFileSync(join(ws.repoDir, "keep.txt"), "utf8")).toBe("staged edit, then edited again\n");
      expect(existsSync(join(ws.repoDir, "del.txt"))).toBe(false);
      expect(existsSync(join(ws.repoDir, ".env"))).toBe(false); // untracked files are never copied
      expect(git(ws.repoDir, ["status", "--porcelain"])).toBe(""); // the clone starts clean at the base

      // Without the option the clone is the committed base.
      const plain = await newSession(user);
      expect(plain.ws.baseSha).toBe(head);
      expect(readFileSync(join(plain.ws.repoDir, "src/a.ts"), "utf8")).toBe(lines(20));
      expect(fingerprint(user)).toEqual(before);

      // Uncommitted changes belong to the checked-out branch only.
      git(user, ["branch", "other", "HEAD~0"]);
      commitOnBranch(user, "other", { "o.txt": "o\n" });
      await expect(newSession(user, { includeUncommitted: true, base: "other" })).rejects.toThrow(/checked-out branch/);
    },
    TIMEOUT,
  );
});

// ===========================================================================

describe("the clone is cut off from the user's history", () => {
  test(
    "no remote, only its own branch, and destructive git in the clone can't reach the user's repo",
    async () => {
      const user = makeUserRepo();
      git(user, ["branch", "feature"]);
      git(user, ["tag", "v1"]);
      const { manager, codeGit, ws } = await newSession(user);
      expect(git(ws.repoDir, ["remote"]).trim()).toBe("");
      expect(git(ws.repoDir, ["config", "--get-regexp", "^remote\\."], { allowFail: true }).trim()).toBe("");
      expect(git(ws.repoDir, ["for-each-ref", "--format=%(refname)"]).trim()).toBe(`refs/heads/${ws.branch}`);
      expect(git(ws.repoDir, ["symbolic-ref", "HEAD"]).trim()).toBe(`refs/heads/${ws.branch}`);
      expect(readFileSync(join(ws.repoDir, ".git/objects/info/alternates"), "utf8").trim()).toBe(ws.userObjectsDir);

      write(ws.repoDir, "work.txt", "agent work\n");
      git(ws.repoDir, ["add", "work.txt"]);
      git(ws.repoDir, ["commit", "-q", "-m", "agent work"]);
      const snap = await manager.snapshot(ws, 1);
      const before = fingerprint(user);
      const rye = ryeRefs(user);

      // Everything an agent could do to its own repo's history.
      write(ws.repoDir, "keep.txt", "to stash\n");
      git(ws.repoDir, ["stash", "push", "-q"]);
      git(ws.repoDir, ["stash", "clear"]);
      const root = git(ws.repoDir, ["rev-list", "--max-parents=0", "HEAD"]).trim();
      git(ws.repoDir, ["reset", "-q", "--hard", root]);
      git(ws.repoDir, ["checkout", "-q", "--detach"]);
      git(ws.repoDir, ["branch", "-D", ws.branch]);
      git(ws.repoDir, ["update-ref", "-d", "refs/heads/main"], { allowFail: true });
      git(ws.repoDir, ["update-ref", "-d", ws.baseRefPin], { allowFail: true });
      git(ws.repoDir, ["update-ref", "-d", snap.ref], { allowFail: true });
      git(ws.repoDir, ["tag", "-d", "v1"], { allowFail: true });
      git(ws.repoDir, ["reflog", "expire", "--expire=now", "--all"]);
      git(ws.repoDir, ["gc", "-q", "--prune=now"]);

      expect(fingerprint(user)).toEqual(before);
      expect(ryeRefs(user)).toEqual(rye);
      git(user, ["fsck", "--strict", "--no-progress"]);
      expect(git(user, ["cat-file", "-t", snap.sha]).trim()).toBe("commit");
      expect(git(user, ["show", `${snap.sha}:work.txt`])).toBe("agent work\n");
      // The clone still reads the shared objects after its own gc.
      expect(git(ws.repoDir, ["cat-file", "-t", ws.baseSha]).trim()).toBe("commit");
      git(ws.repoDir, ["fsck", "--no-progress"]);
      // And Rye still reads it.
      const st = await codeGit.status(ws);
      expect(st.branch).toBeNull();
      expect(st.head).toBe(root);
    },
    TIMEOUT,
  );

  test(
    "the base pin keeps the clone's borrowed objects alive when the user deletes the branch and gcs",
    async () => {
      const user = makeUserRepo();
      git(user, ["branch", "feature"]);
      const featureTip = commitOnBranch(user, "feature", { "feature.txt": "only on feature\n" });
      const { codeGit, ws } = await newSession(user, { base: "feature" });
      expect(ws.baseSha).toBe(featureTip);

      git(user, ["branch", "-D", "feature"]);
      git(user, ["reflog", "expire", "--expire=now", "--all"]);
      git(user, ["gc", "-q", "--prune=now"]);

      expect(git(user, ["cat-file", "-t", featureTip]).trim()).toBe("commit");
      git(ws.repoDir, ["fsck", "--strict", "--no-progress"]);
      expect(readFileSync(join(ws.repoDir, "feature.txt"), "utf8")).toBe("only on feature\n");
      const st = await codeGit.status(ws);
      expect(st.baseTip).toBe(featureTip); // base gone: falls back to the pinned commit
      expect(st.ahead).toBe(0);
    },
    TIMEOUT,
  );
});

// ===========================================================================

describe("create-only refs", () => {
  test(
    "update-ref refuses an existing ref, and Rye writes nothing outside refs/rye/* and rye/*",
    async () => {
      const user = makeUserRepo();
      const { manager, codeGit, ws } = await newSession(user);
      const g = manager.git;
      const head = git(user, ["rev-parse", "HEAD"]).trim();

      expect(await g.createRefOnly(ws, `${ws.refPrefix}extra`, head)).toBe("created");
      const other = commitOnBranch(user, "main", { "x.txt": "x\n" });
      expect(await g.createRefOnly(ws, `${ws.refPrefix}extra`, other)).toBe("exists");
      expect(git(user, ["rev-parse", `${ws.refPrefix}extra`]).trim()).toBe(head);

      await expect(g.createRefOnly(ws, "refs/heads/main", head)).rejects.toThrow(CodeGitError);
      await expect(g.createRefOnly(ws, "refs/tags/v1", head)).rejects.toThrow(CodeGitError);
      await expect(g.createRefOnly(ws, "refs/heads/rye/../main", head)).rejects.toThrow(CodeGitError);
      await expect(g.deleteSessionRef(ws, "refs/heads/main", other)).rejects.toThrow(CodeGitError);
      expect(git(user, ["rev-parse", "main"]).trim()).toBe(other);

      write(ws.repoDir, "f.txt", "1\n");
      const first = await codeGit.createBranch(ws, { name: "rye/out", mode: "keep" });
      expect(first.status).toBe("created");
      const tip = git(user, ["rev-parse", "rye/out"]).trim();
      write(ws.repoDir, "f.txt", "2\n");
      expect(await codeGit.createBranch(ws, { name: "rye/out", mode: "keep" })).toEqual({ status: "branch_exists", branch: "rye/out" });
      expect(await codeGit.mergeWithBase(ws, { name: "rye/out", message: "m" })).toEqual({ status: "branch_exists", branch: "rye/out" });
      expect(git(user, ["rev-parse", "rye/out"]).trim()).toBe(tip);
      await expect(codeGit.createBranch(ws, { name: "main", mode: "keep" })).rejects.toThrow(/rye\//);
      await expect(codeGit.createBranch(ws, { name: "rye/x", mode: "squash" })).rejects.toThrow(/message/);

      await manager.snapshot(ws, 1);
      await expect(manager.snapshot(ws, 1)).rejects.toThrow(/already exists/);
    },
    TIMEOUT,
  );
});

// ===========================================================================

const HOOKS = [
  "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-checkout", "post-merge", "pre-push",
  "pre-rebase", "post-rewrite", "reference-transaction", "pre-auto-gc", "post-index-change", "fsmonitor-watchman",
  "push-to-checkout", "pre-merge-commit",
];

describe("a malicious clone config never runs during Rye's git calls", () => {
  test(
    "fsmonitor, hooks, sshCommand, filters, textconv, external diff, gpg, pager and core.worktree stay inert",
    async () => {
      const user = makeUserRepo();
      const { manager, codeGit, ws } = await newSession(user);
      const evilDir = tmp("rye-ws-evil-");
      const marker = join(evilDir, "MARKER");
      const script = join(evilDir, "evil.sh");
      writeFileSync(script, `#!/bin/sh\necho "ran: $0 $*" >> "${marker}"\ncat\n`);
      chmodSync(script, 0o755);

      // The agent commits normally first (before planting anything).
      write(ws.repoDir, "src/a.ts", lines(20).replace("line 7", "agent"));
      git(ws.repoDir, ["commit", "-q", "-am", "agent"]);

      // Then plants every config trick it can.
      const hooksDir = join(ws.repoDir, ".git", "evil-hooks");
      mkdirSync(hooksDir);
      for (const h of HOOKS) {
        writeFileSync(join(hooksDir, h), `#!/bin/sh\n"${script}" hook-${h}\n`);
        chmodSync(join(hooksDir, h), 0o755);
        writeFileSync(join(ws.repoDir, ".git", "hooks", h), `#!/bin/sh\n"${script}" default-hook-${h}\n`);
        chmodSync(join(ws.repoDir, ".git", "hooks", h), 0o755);
      }
      const cfg = join(ws.repoDir, ".git", "config");
      writeFileSync(
        cfg,
        readFileSync(cfg, "utf8") +
          [
            "[core]",
            `\tfsmonitor = ${script}`,
            `\thooksPath = ${hooksDir}`,
            `\tsshCommand = ${script}`,
            `\tpager = ${script}`,
            `\teditor = ${script}`,
            `\taskPass = ${script}`,
            `\talternateRefsCommand = ${script}`,
            `\tworktree = ${user}`,
            "[diff]",
            `\texternal = ${script}`,
            '[diff "evil"]',
            `\ttextconv = ${script}`,
            `\tcommand = ${script}`,
            '[filter "evil"]',
            `\tclean = ${script} clean`,
            `\tsmudge = ${script} smudge`,
            `\tprocess = ${script} process`,
            "\trequired = true",
            '[merge "evil"]',
            `\tdriver = ${script} merge`,
            "[commit]",
            "\tgpgSign = true",
            "[gpg]",
            `\tprogram = ${script}`,
            "[log]",
            "\tshowSignature = true",
            "[credential]",
            `\thelper = !${script}`,
            "[uploadpack]",
            `\tpackObjectsHook = ${script}`,
            "[pager]",
            `\tdiff = ${script}`,
            "",
          ].join("\n"),
      );
      write(ws.repoDir, ".gitattributes", "* filter=evil diff=evil merge=evil\n");
      write(ws.repoDir, ".git/info/attributes", "* filter=evil diff=evil\n");
      // Uncommitted work, written straight to disk (no git).
      write(ws.repoDir, "src/a.ts", lines(20).replace("line 7", "agent").replace("line 9", "more"));
      write(ws.repoDir, "new.txt", "new\n");
      write(ws.repoDir, "scratch.txt", "scratch\n");

      commitOnBranch(user, "main", { "upstream.txt": "upstream\n" });
      const fp = fingerprint(user);

      await codeGit.status(ws);
      const { files } = await codeGit.changes(ws, "base");
      expect(files.map((f) => f.path)).toEqual([".gitattributes", "new.txt", "scratch.txt", "src/a.ts"]);
      const diff = await codeGit.fileDiff(ws, "src/a.ts", "base");
      expect(diff?.hunks?.length).toBeGreaterThan(0);
      expect(diff?.binary).toBe(false);
      await codeGit.stage(ws, ["new.txt"], true);
      await codeGit.stage(ws, ["new.txt"], false);
      await codeGit.discard(ws, ["scratch.txt"]);
      await manager.snapshot(ws, 1);
      expect((await codeGit.createBranch(ws, { name: "rye/evil-keep", mode: "keep" })).status).toBe("created");
      expect((await codeGit.createBranch(ws, { name: "rye/evil-squash", mode: "squash", message: "squash" })).status).toBe("created");
      expect((await codeGit.mergeWithBase(ws, { name: "rye/evil-merge", message: "merge" })).status).toBe("merged");
      await manager.diskUsage(ws);

      expect(existsSync(marker)).toBe(false);
      expect(fingerprint(user)).toEqual(fp); // core.worktree pointed at the user's checkout: untouched

      await manager.archive(ws);
      await manager.restore(ws);
      await codeGit.status(ws);
      expect(existsSync(marker)).toBe(false);

      // Sanity: the planted fsmonitor does run as soon as plain git touches a clone with it.
      const probe = await newSession(user);
      const probeCfg = join(probe.ws.repoDir, ".git", "config");
      writeFileSync(probeCfg, `${readFileSync(probeCfg, "utf8")}[core]\n\tfsmonitor = ${script}\n`);
      git(probe.ws.repoDir, ["status", "--porcelain"], { allowFail: true });
      expect(existsSync(marker)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a clone whose .git is redirected is refused, and a symlinked index is replaced, not written through",
    async () => {
      const user = makeUserRepo();
      const { codeGit, ws } = await newSession(user);
      const gitDir = join(ws.repoDir, ".git");
      const fp = fingerprint(user);

      // commondir would point refs and config at the user's repo.
      writeFileSync(join(gitDir, "commondir"), join(user, ".git"));
      await expect(codeGit.status(ws)).rejects.toMatchObject({ code: "unsafe" });
      unlinkSync(join(gitDir, "commondir"));

      // A gitfile in place of .git.
      renameSync(gitDir, `${gitDir}-moved`);
      writeFileSync(gitDir, `gitdir: ${join(user, ".git")}\n`);
      await expect(codeGit.stage(ws, ["keep.txt"], true)).rejects.toMatchObject({ code: "unsafe" });
      unlinkSync(gitDir);
      // A symlink in place of .git.
      symlinkSync(join(user, ".git"), gitDir);
      await expect(codeGit.discard(ws, ["keep.txt"])).rejects.toMatchObject({ code: "unsafe" });
      unlinkSync(gitDir);
      renameSync(`${gitDir}-moved`, gitDir);

      // .git/index as a symlink to a file outside: stage replaces the link.
      const victim = join(tmp("rye-ws-victim-"), "victim");
      writeFileSync(victim, "do not touch\n");
      rmSync(join(gitDir, "index"));
      symlinkSync(victim, join(gitDir, "index"));
      write(ws.repoDir, "keep.txt", "changed\n");
      await codeGit.stage(ws, ["keep.txt"], true);
      expect(readFileSync(victim, "utf8")).toBe("do not touch\n");
      expect(lstatSync(join(gitDir, "index")).isSymbolicLink()).toBe(false);
      expect(git(ws.repoDir, ["diff", "--cached", "--name-only"]).trim()).toBe("keep.txt");

      // Paths are checked before anything runs.
      await expect(codeGit.stage(ws, ["../outside"], true)).rejects.toMatchObject({ code: "invalid" });
      await expect(codeGit.discard(ws, [".git/config"])).rejects.toMatchObject({ code: "invalid" });
      await expect(codeGit.fileDiff(ws, "/etc/passwd", "base")).rejects.toMatchObject({ code: "invalid" });
      expect(fingerprint(user)).toEqual(fp);
    },
    TIMEOUT,
  );
});

// ===========================================================================

describe("diffs", () => {
  test(
    "add, modify, delete, rename, binary, big file, modes, symlinks, stages and sensitive flags",
    async () => {
      const user = makeUserRepo();
      write(user, "package.json", '{ "name": "p" }\n');
      write(user, "run.sh", "#!/bin/sh\necho hi\n");
      write(user, "yarn.lock", "# yarn lockfile v1\n");
      git(user, ["add", "-A"]);
      git(user, ["commit", "-q", "-m", "more files"]);
      const { manager, codeGit, ws } = await newSession(user);
      const r = ws.repoDir;

      // Committed on the session branch.
      write(r, "README.md", "# Project\n\nCommitted by the agent.\n");
      git(r, ["commit", "-q", "-am", "readme"]);
      await manager.snapshot(ws, 1);
      // Staged, partly staged, unstaged, untracked.
      write(r, "package.json", '{ "name": "p", "dependencies": { "left-pad": "1" } }\n');
      git(r, ["add", "package.json"]);
      write(r, "src/a.ts", lines(20).replace("line 10", "staged"));
      git(r, ["add", "src/a.ts"]);
      write(r, "src/a.ts", lines(20).replace("line 10", "staged").replace("line 15", "unstaged too"));
      write(r, "keep.txt", "edited\n");
      unlinkSync(join(r, "del.txt"));
      renameSync(join(r, "src/old.txt"), join(r, "src/new.txt"));
      write(r, "bin.dat", new Uint8Array([0, 1, 2, 3, 0, 255, 254, 0]));
      write(r, "big.txt", lines(MAX_DIFF_LINES + 2_000, "big"));
      write(r, ".github/workflows/ci.yml", "on: push\n");
      write(r, ".env", "TOKEN=x\n");
      write(r, "yarn.lock", '# yarn lockfile v1\nleft-pad@1:\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"\n');
      symlinkSync("../../.ssh/id_rsa", join(r, "link"));
      chmodSync(join(r, "run.sh"), 0o755);

      const { files, stat } = await codeGit.changes(ws, "base");
      const by = Object.fromEntries(files.map((f) => [f.path, f]));
      expect(Object.keys(by).sort()).toEqual(
        [".env", ".github/workflows/ci.yml", "README.md", "big.txt", "bin.dat", "del.txt", "keep.txt", "link", "package.json", "run.sh", "src/a.ts", "src/new.txt", "yarn.lock"].sort(),
      );
      expect(by["README.md"]).toMatchObject({ status: "modified", stage: "committed", additions: 2, deletions: 0 });
      expect(by["package.json"]).toMatchObject({ status: "modified", stage: "staged" });
      expect(by["package.json"].sensitive.map((s) => s.kind)).toEqual(["manifest"]);
      expect(by["src/a.ts"]).toMatchObject({ status: "modified", stage: "partly_staged", additions: 2, deletions: 2 });
      expect(by["keep.txt"]).toMatchObject({ status: "modified", stage: "unstaged", additions: 1, deletions: 1 });
      expect(by["del.txt"]).toMatchObject({ status: "deleted", stage: "unstaged", deletions: 1, oldMode: "100644" });
      expect(by["src/new.txt"]).toMatchObject({ status: "renamed", oldPath: "src/old.txt", additions: 0, deletions: 0 });
      expect(by["bin.dat"]).toMatchObject({ status: "added", binary: true, stage: "untracked", additions: 0 });
      expect(by["bin.dat"].sensitive.map((s) => s.kind)).toEqual(["binary"]);
      expect(by["big.txt"]).toMatchObject({ status: "added", additions: MAX_DIFF_LINES + 2_000, newMode: "100644" });
      expect(by[".github/workflows/ci.yml"].sensitive.map((s) => s.kind)).toEqual(["ci"]);
      expect(by[".env"].sensitive.map((s) => s.kind)).toEqual(["env_file"]);
      expect(by["link"]).toMatchObject({ status: "added", newMode: "120000" });
      expect(by["link"].sensitive).toEqual([{ kind: "symlink", detail: "new symlink → ../../.ssh/id_rsa" }]);
      expect(by["run.sh"]).toMatchObject({ status: "modified", oldMode: "100644", newMode: "100755" });
      expect(by["run.sh"].sensitive).toEqual([{ kind: "executable", detail: "mode 100644 → 100755" }]);
      expect(by["yarn.lock"].resolvedHosts).toEqual(["registry.yarnpkg.com"]);
      expect(stat.files).toBe(files.length);
      expect(stat.additions).toBe(files.reduce((s, f) => s + f.additions, 0));
      expect(files.every((f) => f.hunks === undefined)).toBe(true);

      // Per-file diffs.
      const a = (await codeGit.fileDiff(ws, "src/a.ts", "base"))!;
      // Lines 10 and 15 changed: their 3-line contexts touch, so git makes one hunk of 7–18.
      expect(a.hunks!.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[7, 12, 7, 12]]);
      expect(a.hunks![0].lines.filter((l) => l.kind !== "context")).toEqual([
        { kind: "del", text: "line 10", oldLine: 10 },
        { kind: "add", text: "staged", newLine: 10 },
        { kind: "del", text: "line 15", oldLine: 15 },
        { kind: "add", text: "unstaged too", newLine: 15 },
      ]);
      expect(a.hunks![0].lines[0]).toEqual({ kind: "context", text: "line 7", oldLine: 7, newLine: 7 });
      const added = (await codeGit.fileDiff(ws, "src/new.txt", "base"))!;
      expect(added).toMatchObject({ status: "renamed", oldPath: "src/old.txt", hunks: [] });
      const viaOld = await codeGit.fileDiff(ws, "src/old.txt", "base");
      expect(viaOld?.path).toBe("src/new.txt");
      const del = (await codeGit.fileDiff(ws, "del.txt", "base"))!;
      expect(del.hunks).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, section: "", lines: [{ kind: "del", text: "delete me", oldLine: 1 }] }]);
      const bin = (await codeGit.fileDiff(ws, "bin.dat", "base"))!;
      expect(bin).toMatchObject({ binary: true, hunks: [] });
      const big = (await codeGit.fileDiff(ws, "big.txt", "base"))!;
      expect(big.truncated).toBe(true);
      expect(big.hunks![0].oldStart).toBe(0);
      expect(big.hunks!.reduce((s, h) => s + h.lines.length, 0)).toBe(MAX_DIFF_LINES);
      expect(await codeGit.fileDiff(ws, "nothing-here.txt", "base")).toBeNull();

      // Since the turn-1 snapshot: README's commit is no longer a change.
      const since = await codeGit.changes(ws, "turn-1");
      expect(since.files.some((f) => f.path === "README.md")).toBe(false);
      expect(since.files.some((f) => f.path === "src/a.ts")).toBe(true);
      await expect(codeGit.changes(ws, "turn-9")).rejects.toMatchObject({ code: "not_found" });

      // Branch status.
      const st = await codeGit.status(ws);
      expect(st).toMatchObject({ branch: ws.branch, base: "main", baseSha: ws.baseSha, baseTip: ws.baseSha, ahead: 1, behind: 0, dirty: true });
      expect(st.dirtyFiles).toBe(files.length - 1); // everything but the committed README
      expect(st.stat).toEqual(stat);
    },
    TIMEOUT,
  );

  test(
    "stage, unstage and discard change only the clone",
    async () => {
      const user = makeUserRepo();
      const { codeGit, ws } = await newSession(user);
      const r = ws.repoDir;
      write(r, "keep.txt", "edited\n");
      write(r, "fresh.txt", "untracked\n");
      renameSync(join(r, "src/old.txt"), join(r, "src/moved.txt"));

      await codeGit.stage(ws, ["keep.txt", "fresh.txt"], true);
      expect(git(r, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort()).toEqual(["fresh.txt", "keep.txt"]);
      let files = (await codeGit.changes(ws, "base")).files;
      expect(files.find((f) => f.path === "keep.txt")?.stage).toBe("staged");
      await codeGit.stage(ws, ["keep.txt", "fresh.txt"], false);
      expect(git(r, ["diff", "--cached", "--name-only"]).trim()).toBe("");
      expect(readFileSync(join(r, "keep.txt"), "utf8")).toBe("edited\n");

      await codeGit.discard(ws, ["keep.txt", "fresh.txt", "src/moved.txt"]);
      expect(readFileSync(join(r, "keep.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(join(r, "fresh.txt"))).toBe(false);
      expect(existsSync(join(r, "src/moved.txt"))).toBe(false);
      expect(readFileSync(join(r, "src/old.txt"), "utf8")).toBe(lines(30, "rename me"));
      files = (await codeGit.changes(ws, "base")).files;
      expect(files).toEqual([]);
      expect(git(r, ["status", "--porcelain"])).toBe("");
    },
    TIMEOUT,
  );
});

// ===========================================================================

describe("merge with the latest base", () => {
  test(
    "a clean merge makes a two-parent commit on a new branch",
    async () => {
      const user = makeUserRepo();
      const { codeGit, ws } = await newSession(user);
      write(ws.repoDir, "src/a.ts", lines(20).replace("line 2", "session change"));
      git(ws.repoDir, ["commit", "-q", "-am", "session"]);
      write(ws.repoDir, "uncommitted.txt", "also goes in\n");
      const baseTip = commitOnBranch(user, "main", { "upstream.txt": "upstream\n" });
      const fp = fingerprint(user);

      const st = await codeGit.status(ws);
      expect(st).toMatchObject({ baseTip, ahead: 1, behind: 1 });

      const r = await codeGit.mergeWithBase(ws, { name: "rye/merged", message: "Merge main into rye/merged" });
      expect(r).toMatchObject({ status: "merged", branch: "rye/merged", baseTip });
      if (r.status !== "merged") throw new Error("unreachable");
      expect(git(user, ["rev-parse", "rye/merged"]).trim()).toBe(r.sha);
      const parents = git(user, ["rev-list", "--parents", "-n", "1", r.sha]).trim().split(" ").slice(1);
      expect(parents).toHaveLength(2);
      expect(parents[1]).toBe(baseTip);
      expect(git(user, ["show", `${r.sha}:upstream.txt`])).toBe("upstream\n");
      expect(git(user, ["show", `${r.sha}:uncommitted.txt`])).toBe("also goes in\n");
      expect(git(user, ["show", `${r.sha}:src/a.ts`])).toContain("session change");
      expect(git(user, ["log", "-1", "--format=%s", r.sha]).trim()).toBe("Merge main into rye/merged");
      expect(fingerprint(user)).toEqual(fp);
    },
    TIMEOUT,
  );

  test(
    "a conflicting merge lists the conflicts and writes no branch",
    async () => {
      const user = makeUserRepo();
      const { codeGit, ws } = await newSession(user);
      write(ws.repoDir, "src/a.ts", lines(20).replace("line 4", "session side"));
      write(ws.repoDir, "both.txt", "session\n");
      unlinkSync(join(ws.repoDir, "keep.txt"));
      const baseTip = commitOnBranch(user, "main", { "src/a.ts": lines(20).replace("line 4", "base side"), "both.txt": "base\n", "keep.txt": "base edit\n" });
      const fp = fingerprint(user);
      const rye = ryeRefs(user);

      const r = await codeGit.mergeWithBase(ws, { name: "rye/conflicted", message: "m" });
      expect(r.status).toBe("conflicts");
      if (r.status !== "conflicts") throw new Error("unreachable");
      expect(r.baseTip).toBe(baseTip);
      expect(r.conflicts.map((c) => [c.path, c.kind])).toEqual([
        ["both.txt", "add_add"],
        ["keep.txt", "modify_delete"],
        ["src/a.ts", "content"],
      ]);
      expect(r.conflicts.every((c) => typeof c.message === "string" && c.message.startsWith("CONFLICT"))).toBe(true);
      expect(git(user, ["rev-parse", "--verify", "-q", "rye/conflicted"], { allowFail: true }).trim()).toBe("");
      expect(ryeRefs(user)).toEqual(rye);
      expect(fingerprint(user)).toEqual(fp);
    },
    TIMEOUT,
  );
});

// ===========================================================================

describe("archive and restore", () => {
  test(
    "a round trip keeps commits, uncommitted edits and untracked files; nothing is lost",
    async () => {
      const user = makeUserRepo();
      const { manager, codeGit, ws } = await newSession(user);
      const r = ws.repoDir;
      write(r, "src/a.ts", lines(20).replace("line 1", "committed"));
      git(r, ["commit", "-q", "-am", "agent commit"]);
      const head = git(r, ["rev-parse", "HEAD"]).trim();
      await manager.snapshot(ws, 1);
      write(r, "keep.txt", "uncommitted edit\n");
      write(r, "untracked/new.txt", "untracked\n");
      unlinkSync(join(r, "del.txt"));
      const filesBefore = treeHash(r);
      const changesBefore = await codeGit.changes(ws, "base");
      const diskBefore = await manager.diskUsage(ws);
      expect(diskBefore).toBeGreaterThan(0);

      await manager.archive(ws);
      expect(existsSync(r)).toBe(false);
      expect(existsSync(ws.tmpDir)).toBe(false);
      expect(existsSync(ws.sessionFile)).toBe(true);
      expect(await manager.diskUsage(ws)).toBeLessThan(diskBefore);
      expect(ryeRefs(user).sort()).toEqual([`refs/rye/${ws.sessionId}/archive-1`, `refs/rye/${ws.sessionId}/base`, `refs/rye/${ws.sessionId}/turn-1`]);
      await expect(codeGit.status(ws)).rejects.toMatchObject({ code: "archived" });
      await manager.archive(ws); // already archived: a no-op

      const stored = readWorkspace(ws.sessionDir);
      expect(stored).toEqual(ws);
      const back = await manager.restore(stored!);
      expect(back).toEqual(ws);
      expect(treeHash(r)).toEqual(filesBefore);
      expect(git(r, ["rev-parse", "HEAD"]).trim()).toBe(head);
      expect(git(r, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(ws.branch);
      expect(git(r, ["remote"]).trim()).toBe("");
      expect((await codeGit.changes(ws, "base")).files.map((f) => [f.path, f.status])).toEqual(changesBefore.files.map((f) => [f.path, f.status]));
      const st = await codeGit.status(ws);
      expect(st).toMatchObject({ ahead: 1, dirty: true, dirtyFiles: 3 });
      await expect(manager.restore(ws)).rejects.toMatchObject({ code: "invalid" });

      // Archiving again with no changes adds no snapshot; snapshots() lists turns only.
      await manager.archive(ws);
      expect(ryeRefs(user).filter((x) => x.includes("archive-"))).toEqual([`refs/rye/${ws.sessionId}/archive-1`]);
      expect((await manager.snapshots(ws)).map((s) => s.turn)).toEqual([1]);
      await manager.restore(ws);
      expect(treeHash(r)).toEqual(filesBefore);

      // Remove drops the session's refs and directory, never a rye/* branch.
      await codeGit.createBranch(ws, { name: "rye/kept", mode: "keep" });
      expect(await manager.remove(ws)).toBe(3);
      expect(existsSync(ws.sessionDir)).toBe(false);
      expect(ryeRefs(user)).toEqual(["refs/heads/rye/kept"]);
      git(user, ["fsck", "--strict", "--no-progress"]);
    },
    TIMEOUT,
  );
});
