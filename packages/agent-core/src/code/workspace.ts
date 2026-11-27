/**
 * Per-session isolation for code sessions (docs/design/code-sessions.md §3.1): a Rye-owned shared
 * clone of the user's repo, snapshots of every turn into the user's repo, archive and restore.
 *
 * ```
 * <root>/<session-id>/
 *   repo/          the clone: its own refs, index, config and hooks; objects borrowed from the
 *                  user's repo through objects/info/alternates; no remote
 *   tmp/  cache/   cache/bin   (TMPDIR, tool caches, the git shim)
 *   events.jsonl   session.json   (session.json holds this Workspace)
 *   .rye-git/      Rye's shadow git dir (code/git.ts), outside the sandbox's write scope
 * ```
 *
 * **The clone** is what `git clone --shared --no-checkout` makes, built by hand so no transport
 * runs and nothing is copied: `git init`, `objects/info/alternates` → the user's objects,
 * `update-ref refs/heads/rye/<slug> <base>` (create-only), `read-tree --reset -u <base>`. There
 * is no `origin` to remove, no remote-tracking refs and no tags, so the clone's refs name nothing
 * of the user's but the base.
 *
 * **What Rye writes in the user's repo:** objects (additive), `refs/rye/<session>/base` (pins the
 * base so the alternates can't lose it to gc), `refs/rye/<session>/turn-<n>` and
 * `refs/rye/<session>/archive-<n>` (snapshots), and, from code/git.ts, new `rye/*` branches. All
 * create-only. Never the user's index, working tree, stash, HEAD or any other ref.
 *
 * **Uncommitted changes** (`includeUncommitted`): a copy of the user's index in a Rye-owned
 * temporary file (`GIT_INDEX_FILE`), `add -u` from the user's working tree, `write-tree`, and a
 * commit on HEAD. Untracked files are never included. Equivalent to the doc's `git stash create`,
 * without a merge commit in the branch's history.
 *
 * **A base with no commits yet** (`git init` and nothing committed: HEAD is a symbolic ref to a
 * branch that doesn't exist): Rye writes one empty root commit to the user's object store
 * (`emptyRootCommit`, Rye's identity), pins it as the base and clones from it as usual, so the
 * session starts from an empty project (`Workspace.baseUnborn`). With `includeUncommitted` only the
 * files in the user's index (staged) are carried, on top of that root; untracked files never are.
 *
 * Nothing here deletes anything on its own: `archive` removes the clone only after its state is
 * safely in a snapshot ref, and `remove` is an explicit user action.
 */

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CodeGitError, HardenedGit, RYE_GIT_IDENTITY, shadowGitDir, type GitRunnerOptions, type SnapshotRefInfo } from "./git.js";
import {
  RYE_BRANCH_PREFIX,
  RYE_REF_PREFIX,
  type CreateWorkspaceOptions,
  type SnapshotRef,
  type Workspace,
  type WorkspaceManager,
  type WorkspacePaths,
} from "./types.js";

/** Session ids are directory names and ref components. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Slugs are the last part of `rye/<slug>`. */
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const SESSION_FILE_VERSION = 1;

/** The directories of a session under `root` (§3.1). Pure. */
export function workspacePaths(root: string, sessionId: string): WorkspacePaths {
  if (!SESSION_ID_RE.test(sessionId)) throw new CodeGitError(`Invalid session id: ${JSON.stringify(sessionId)}`, "invalid");
  if (!isAbsolute(root)) throw new CodeGitError("The code sessions root must be an absolute path", "invalid");
  const sessionDir = join(resolve(root), sessionId);
  const cacheDir = join(sessionDir, "cache");
  return {
    sessionDir,
    repoDir: join(sessionDir, "repo"),
    tmpDir: join(sessionDir, "tmp"),
    cacheDir,
    binDir: join(cacheDir, "bin"),
    eventsFile: join(sessionDir, "events.jsonl"),
    sessionFile: join(sessionDir, "session.json"),
  };
}

/** The Workspace stored in a session directory's `session.json` by `create`, or null. */
export function readWorkspace(sessionDir: string): Workspace | null {
  try {
    const raw = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8")) as { version?: number; workspace?: Workspace };
    if (raw?.version !== SESSION_FILE_VERSION || !raw.workspace || raw.workspace.sessionDir !== sessionDir) return null;
    return raw.workspace;
  } catch {
    return null;
  }
}

/** Refuse a Workspace whose paths don't hang together (everything Rye removes must be inside its own session dir). */
function assertWorkspace(ws: Workspace): void {
  if (!SESSION_ID_RE.test(ws.sessionId) || basename(ws.sessionDir) !== ws.sessionId) throw new CodeGitError("Invalid workspace", "invalid");
  const p = workspacePaths(resolve(ws.sessionDir, ".."), ws.sessionId);
  for (const k of ["repoDir", "tmpDir", "cacheDir", "binDir", "eventsFile", "sessionFile"] as const) {
    if (ws[k] !== p[k]) throw new CodeGitError(`Invalid workspace (${k})`, "invalid");
  }
  if (ws.refPrefix !== `${RYE_REF_PREFIX}${ws.sessionId}/` || ws.baseRefPin !== `${ws.refPrefix}base`) throw new CodeGitError("Invalid workspace (refs)", "invalid");
}

function dirBytes(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  const own = st.blocks ? st.blocks * 512 : st.size;
  if (!st.isDirectory()) return own;
  let total = own;
  let names: string[] = [];
  try {
    names = readdirSync(path);
  } catch {
    return total;
  }
  for (const n of names) total += dirBytes(join(path, n));
  return total;
}

export interface WorkspaceManagerOptions extends GitRunnerOptions {
  /** Share one runner with `createCodeGit`. */
  git?: HardenedGit;
  /** Clock for snapshot times (tests). */
  now?: () => number;
}

/** Snapshot commit message, with the trailers `listRefs` reads. */
function snapshotMessage(ws: Workspace, label: string, at: number): string {
  return `Rye snapshot: ${label}\n\nRye-Session: ${ws.sessionId}\nRye-Snapshot-At: ${at}\n`;
}

/** `WorkspaceManager` (code/types.ts). */
export function createWorkspaceManager(o: WorkspaceManagerOptions = {}): WorkspaceManager & { readonly git: HardenedGit } {
  const git = o.git ?? new HardenedGit(o);
  const now = o.now ?? Date.now;

  /** Lay down a clone at `repoDir`: branch `branch` at `head`, working tree (not index) at `tree`. */
  const buildClone = async (ws: Workspace, head: string, tree: string): Promise<void> => {
    if (existsSync(ws.repoDir)) throw new CodeGitError("The workspace already has a clone", "invalid");
    for (const d of [ws.tmpDir, ws.cacheDir, ws.binDir]) mkdirSync(d, { recursive: true });
    await git.ok({ pre: [], env: {}, cwd: ws.sessionDir }, ["init", "-q", `--initial-branch=${ws.branch}`, ws.repoDir], { what: "git init" });
    writeFileSync(join(ws.repoDir, ".git", "objects", "info", "alternates"), `${ws.userObjectsDir}\n`);
    const fresh = git.fresh(ws.repoDir);
    await git.ok(fresh, ["update-ref", `refs/heads/${ws.branch}`, head, "0".repeat(head.length)], { what: "creating the clone's branch" });
    await git.ok(fresh, ["read-tree", "--reset", "-u", tree], { what: "checking out the clone" });
    if (tree !== head) await git.ok(fresh, ["read-tree", head], { what: "resetting the clone's index" });
    await git.ensureShadow(ws);
  };

  /** Every snapshot-like ref (turn-n and archive-n), newest last; ties go to archives, then higher turns. */
  const allSnapshots = async (ws: Workspace): Promise<Array<SnapshotRefInfo & { turn?: number; archive?: number }>> => {
    const refs = await git.listRefs(ws, ws.refPrefix);
    const out: Array<SnapshotRefInfo & { turn?: number; archive?: number }> = [];
    for (const r of refs) {
      const name = r.ref.slice(ws.refPrefix.length);
      const t = /^turn-(\d+)$/.exec(name);
      const a = /^archive-(\d+)$/.exec(name);
      if (t) out.push({ ...r, turn: Number(t[1]) });
      else if (a) out.push({ ...r, archive: Number(a[1]) });
    }
    return out.sort((x, y) => x.createdAt - y.createdAt || (x.archive ?? -1) - (y.archive ?? -1) || (x.turn ?? 0) - (y.turn ?? 0));
  };

  const manager: WorkspaceManager & { readonly git: HardenedGit } = {
    git,

    async create(c: CreateWorkspaceOptions): Promise<Workspace> {
      if (!SLUG_RE.test(c.slug)) throw new CodeGitError(`Invalid slug: ${JSON.stringify(c.slug)}`, "invalid");
      if (c.repo.isolation === "worktree") throw new CodeGitError('isolation = "worktree" is not supported yet; use "clone"', "invalid");
      const paths = workspacePaths(c.root, c.sessionId);
      const branch = `${RYE_BRANCH_PREFIX}${c.slug}`;

      // The user's repo (trusted: its config is the user's own).
      const repoPath = resolve(c.repo.path);
      const probe = { pre: [] as string[], env: {}, cwd: repoPath };
      if (!existsSync(repoPath)) throw new CodeGitError(`${c.repo.name}: ${repoPath} does not exist`, "not_found");
      const info = (await git.ok(probe, ["rev-parse", "--absolute-git-dir", "--git-common-dir", "--is-bare-repository"], { what: `${c.repo.name} is not a git repository` })).split("\n");
      const userGitDir = realpathSync(info[0]);
      const commonDir = realpathSync(resolve(repoPath, info[1]));
      const bare = info[2] === "true";
      const userObjectsDir = join(commonDir, "objects");
      const user = { userGitDir };

      let baseRef = c.base ?? c.repo.base;
      if (!baseRef) {
        const r = await git.exec(git.user(user), ["symbolic-ref", "-q", "--short", "HEAD"]);
        baseRef = r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : "HEAD";
      }
      let baseTip = await git.resolveCommit(user, baseRef);
      // An unborn base: the checked-out branch has no commits yet (a new repo). The session starts
      // from an empty project instead (below); anything else that names no commit is an error that
      // says which branches do exist.
      let unborn = false;
      if (!baseTip) {
        const head = await git.unbornHead(git.user(user));
        if (head && (baseRef === head || baseRef === `refs/heads/${head}` || baseRef === "HEAD")) {
          unborn = true;
          baseRef = head;
        } else {
          throw new CodeGitError(await git.missingBaseMessage(git.user(user), c.repo.name, baseRef), "not_found");
        }
      }

      if (existsSync(paths.sessionDir)) throw new CodeGitError(`Session directory ${paths.sessionDir} already exists`, "invalid");
      if (unborn) baseTip = await emptyRootCommit(git, user);
      if (!baseTip) throw new CodeGitError(`${c.repo.name}: the base can't be resolved`, "not_found");
      mkdirSync(c.root, { recursive: true });
      mkdirSync(paths.sessionDir);

      const ws: Workspace = {
        ...paths,
        sessionId: c.sessionId,
        repoName: c.repo.name,
        userRepoPath: repoPath,
        userGitDir,
        userObjectsDir,
        isolation: "clone",
        baseRef,
        baseSha: baseTip,
        includeUncommitted: c.includeUncommitted,
        slug: c.slug,
        branch,
        refPrefix: `${RYE_REF_PREFIX}${c.sessionId}/`,
        baseRefPin: `${RYE_REF_PREFIX}${c.sessionId}/base`,
        ...(unborn ? { baseUnborn: true, emptyRootSha: baseTip } : {}),
      };

      let pinned = false;
      try {
        await git.ensureShadow(ws);
        if (c.includeUncommitted) {
          if (bare) throw new CodeGitError(`${c.repo.name} has no working tree`, "invalid");
          // An unborn base is the checked-out branch by construction; its "uncommitted changes"
          // are the staged files (the index exists without a HEAD), on top of the empty root.
          const head = unborn ? baseTip : await git.resolveCommit(user, "HEAD");
          if (head !== baseTip) throw new CodeGitError("Uncommitted changes can only be included when the base is the checked-out branch", "invalid");
          ws.baseSha = await commitUncommitted(git, ws, repoPath, head, baseRef);
        }
        if ((await git.createRefOnly(ws, ws.baseRefPin, ws.baseSha)) === "exists") {
          throw new CodeGitError(`${ws.baseRefPin} already exists in ${c.repo.name}`, "invalid");
        }
        pinned = true;
        await buildClone(ws, ws.baseSha, ws.baseSha);
        if (!existsSync(ws.eventsFile)) writeFileSync(ws.eventsFile, "");
        writeFileSync(ws.sessionFile, `${JSON.stringify({ version: SESSION_FILE_VERSION, workspace: ws }, null, 2)}\n`);
        return ws;
      } catch (err) {
        // Undo only what this call made: its own new session dir and its own pin.
        rmSync(paths.sessionDir, { recursive: true, force: true });
        if (pinned) await git.deleteSessionRef(ws, ws.baseRefPin, ws.baseSha).catch(() => false);
        throw err;
      }
    },

    async snapshot(ws, turn) {
      assertWorkspace(ws);
      if (!Number.isInteger(turn) || turn < 1) throw new CodeGitError(`Invalid turn: ${turn}`, "invalid");
      const ref = `${ws.refPrefix}turn-${turn}`;
      const st = await git.worktreeState(ws);
      const at = now();
      const sha = await git.commitTree(ws, st.worktreeTree, [st.head ?? ws.baseSha], snapshotMessage(ws, `turn ${turn}`, at));
      await git.transferToUser(ws, [sha], await git.knownUserShas(ws));
      if ((await git.createRefOnly(ws, ref, sha)) === "exists") throw new CodeGitError(`${ref} already exists`, "invalid");
      return { turn, ref, sha, createdAt: at };
    },

    async snapshots(ws): Promise<SnapshotRef[]> {
      assertWorkspace(ws);
      return (await allSnapshots(ws))
        .filter((s) => s.turn !== undefined)
        .map((s) => ({ turn: s.turn!, ref: s.ref, sha: s.sha, createdAt: s.createdAt }))
        .sort((a, b) => a.turn - b.turn);
    },

    async archive(ws) {
      assertWorkspace(ws);
      if (!existsSync(ws.repoDir)) return; // already archived
      // Fails (and keeps the clone) if the state can't be read or stored: never lose work.
      const st = await git.worktreeState(ws);
      const snaps = await allSnapshots(ws);
      const latest = snaps[snaps.length - 1];
      let unchanged = false;
      if (latest) {
        const [tree, parent] = (await git.ok(git.user(ws), ["rev-parse", `${latest.sha}^{tree}`, `${latest.sha}^1`])).trim().split("\n");
        unchanged = tree === st.worktreeTree && parent === (st.head ?? ws.baseSha);
      }
      if (!unchanged) {
        const n = 1 + Math.max(0, ...snaps.map((s) => s.archive ?? 0));
        const at = now();
        const sha = await git.commitTree(ws, st.worktreeTree, [st.head ?? ws.baseSha], snapshotMessage(ws, `archive ${n}`, at));
        await git.transferToUser(ws, [sha], await git.knownUserShas(ws));
        if ((await git.createRefOnly(ws, `${ws.refPrefix}archive-${n}`, sha)) === "exists") throw new CodeGitError("Archive snapshot already exists", "invalid");
      }
      for (const d of [ws.repoDir, ws.tmpDir, ws.cacheDir, shadowGitDir(ws)]) rmSync(d, { recursive: true, force: true });
    },

    async restore(ws) {
      assertWorkspace(ws);
      if (existsSync(ws.repoDir)) throw new CodeGitError("The workspace is not archived", "invalid");
      if (!(await git.refExists(ws, ws.baseRefPin))) throw new CodeGitError(`${ws.baseRefPin} is missing; the session can't be restored`, "not_found");
      const snaps = await allSnapshots(ws);
      const latest = snaps[snaps.length - 1];
      let head = ws.baseSha;
      let tree = ws.baseSha;
      if (latest) {
        tree = latest.sha;
        const r = await git.exec(git.user(ws), ["rev-parse", "--verify", "-q", `${latest.sha}^1`]);
        if (r.exitCode === 0 && r.stdout.trim()) head = r.stdout.trim();
      }
      mkdirSync(ws.sessionDir, { recursive: true });
      try {
        await buildClone(ws, head, tree);
      } catch (err) {
        rmSync(ws.repoDir, { recursive: true, force: true });
        throw err;
      }
      return { ...ws };
    },

    async remove(ws) {
      assertWorkspace(ws);
      let removed = 0;
      for (const r of await git.listRefs(ws, ws.refPrefix)) {
        if (await git.deleteSessionRef(ws, r.ref, r.sha)) removed++;
      }
      rmSync(ws.sessionDir, { recursive: true, force: true });
      return removed;
    },

    async diskUsage(ws) {
      assertWorkspace(ws);
      return dirBytes(ws.sessionDir);
    },
  };
  return manager;
}

/**
 * The base of a session on a branch with no commits yet: one empty root commit (the empty tree,
 * no parents, authored and committed by Rye) written to the user's object store. Writing objects
 * changes no ref of the user's; the caller pins it as `refs/rye/<id>/base`.
 */
async function emptyRootCommit(git: HardenedGit, user: Pick<Workspace, "userGitDir">): Promise<string> {
  const ctx = git.user(user);
  const tree = (await git.ok(ctx, ["mktree"], { input: "", what: "writing the empty tree" })).trim();
  const env = {
    GIT_AUTHOR_NAME: RYE_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: RYE_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: RYE_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: RYE_GIT_IDENTITY.email,
  };
  return (
    await git.ok(ctx, ["commit-tree", "--no-gpg-sign", "-F", "-", tree], { input: "Empty project (Rye code session base)\n", env, what: "writing the empty project's commit" })
  ).trim();
}

/**
 * The user's uncommitted changes to tracked files as a commit on `head`, read through a temporary
 * copy of their index: their index file, working tree, stash and refs are untouched.
 */
async function commitUncommitted(git: HardenedGit, ws: Workspace, repoPath: string, head: string, baseRef: string): Promise<string> {
  const tmp = join(shadowGitDir(ws), `user-index-${randomBytes(6).toString("hex")}`);
  const indexPath = resolve(
    repoPath,
    (await git.ok({ pre: [], env: {}, cwd: repoPath }, ["rev-parse", "--git-path", "index"])).trim(),
  );
  try {
    try {
      if (lstatSync(indexPath).isFile()) copyFileSync(indexPath, tmp);
    } catch {
      /* no index yet */
    }
    const ctx = { pre: [`--git-dir=${ws.userGitDir}`, `--work-tree=${repoPath}`, "-c", "core.splitIndex=false"], env: { GIT_INDEX_FILE: tmp }, cwd: repoPath };
    if (!existsSync(tmp)) await git.ok(ctx, ["read-tree", head]);
    await git.ok(ctx, ["add", "-u"], { what: "reading your uncommitted changes" });
    const tree = (await git.ok(ctx, ["write-tree"])).trim();
    const headTree = (await git.ok(git.user(ws), ["rev-parse", `${head}^{tree}`])).trim();
    if (tree === headTree) return head;
    return (
      await git.ok(git.user(ws), ["commit-tree", "--no-gpg-sign", "-p", head, "-F", "-", tree], { input: `Uncommitted changes on ${baseRef}\n` })
    ).trim();
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.lock`, { force: true });
  }
}
