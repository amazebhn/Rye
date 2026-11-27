/**
 * Code sessions in the running server: whether they are on, and the process's one `CodeRunner`,
 * built on first use (so a Rye without `[code]` never opens `code.db` or touches anything).
 *
 * - **On** means `[code] enabled` (default true) and at least one `[[code.repos]]` entry. Off, the
 *   `/code/` routes answer 404, the `code` tools aren't offered and the web app shows nothing.
 * - **`RYE_CODE_FAKE_ENGINE=1`** (test-only; ignored unless set to exactly `1`) replaces the
 *   `claude` engine with the scripted demo engine (code/engines/fake.ts), for trying the UI end to
 *   end without running any agent. Never set it for real use.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, DATA_DIR, getSettings, type Settings } from "../config.js";
import type { Attachment } from "../chat/attachments.js";
import { discoverRepos } from "../tools/code-search.js";
import { CodeEngineRegistry, codeEngines } from "./engine.js";
import { demoCodeEngine } from "./engines/fake.js";
import { defaultToolchainDirs } from "./policy.js";
import { titleInstruction } from "./naming.js";
import { CodeRunner, type CodeChats } from "./runner.js";
import { probeSandbox } from "./sandbox.js";
import { CodeStore } from "./store.js";
import type { CodeConfig } from "./types.js";
import { createWorkspaceManager } from "./workspace.js";

export const CODE_DB_FILE = join(DATA_DIR, "code.db");
export const FAKE_ENGINE_ENV = "RYE_CODE_FAKE_ENGINE";

/** `[code]` is on and allows at least one repo. */
export function codeSessionsEnabled(s: Pick<Settings, "code"> = getSettings()): boolean {
  return s.code.enabled && s.code.repos.length > 0;
}

/** `[code] worktree_root`, blank → `DATA_DIR/code`. */
export function codeRoot(s: Pick<Settings, "code"> = getSettings()): string {
  return s.code.worktree_root || join(DATA_DIR, "code");
}

export interface CodeService {
  enabled(): boolean;
  /** The runner, built on first call. */
  runner(): CodeRunner;
  /** At startup: recover runs a restart cut off (only when code sessions were ever used), and archive idle ones hourly. */
  start(): void;
}

export function createCodeService(deps: { chats: CodeChats; attachments?: { get(id: string): Attachment | null } }): CodeService {
  let runner: CodeRunner | null = null;
  const build = (): CodeRunner => {
    const fake = process.env[FAKE_ENGINE_ENV] === "1";
    if (fake) console.warn(`[code] ${FAKE_ENGINE_ENV}=1: the claude engine is replaced by a scripted demo engine (test use only; no agent runs).`);
    const home = homedir();
    return new CodeRunner({
      store: new CodeStore(CODE_DB_FILE),
      chats: deps.chats,
      engines: fake ? new CodeEngineRegistry([demoCodeEngine()]) : codeEngines(),
      config: () => getSettings().code as CodeConfig,
      root: () => codeRoot(),
      scope: { home, dataDir: DATA_DIR, configDir: CONFIG_DIR, toolchainDirs: defaultToolchainDirs(home) },
      sandboxProbe: probeSandbox,
      workspaces: createWorkspaceManager(),
      defaultModel: (engine) => (engine === "claude" && !fake ? getSettings().claude.model : ""),
      ...(deps.attachments ? { attachments: deps.attachments } : {}),
      candidates: () => discoverRepos().map((r) => ({ name: r.name, path: r.path })),
      // The same title model as chats ("Titles & step labels"); loaded when first used, so this module stays light.
      nameSession: async (task, repo, signal) => {
        const { suggestTitle } = await import("../agent/loop.js");
        return suggestTitle(task, { context: `Repository: ${repo}`, instruction: titleInstruction(), signal });
      },
    });
  };
  return {
    enabled: () => codeSessionsEnabled(),
    runner: () => (runner ??= build()),
    start() {
      // A Rye that never had code sessions doesn't even open code.db.
      if (!codeSessionsEnabled() && !existsSync(CODE_DB_FILE)) return;
      const r = (runner ??= build());
      try {
        r.recover();
      } catch (err) {
        console.error("[code] recovering interrupted runs failed:", err);
      }
      const sweep = setInterval(() => {
        if (codeSessionsEnabled()) void r.sweepIdle().catch((err) => console.error("[code] archiving idle sessions failed:", err));
      }, 60 * 60 * 1000);
      (sweep as { unref?: () => void }).unref?.();
    },
  };
}
