/**
 * The whole-process OS sandbox (docs/design/code-sessions.md §2.2: "engines whose own approval
 * hooks Rye can't trust run only with the whole process inside sandbox-runtime"; §3.3 "ACP CLIs").
 *
 * An engine with `capabilities.ownSandbox = false` (the `acp:<cli>` engines) is started through a
 * `ProcessSandbox`: the CLI and everything it runs get the run's `SandboxPlan` (writes only in the
 * workspace, `denyRead` over secrets and Rye's own dirs, network only through a filtering proxy),
 * plus the agent's own files (its login read-only, its session history writable).
 *
 * The real one is `@anthropic-ai/sandbox-runtime` (srt, Apache-2.0,
 * https://github.com/anthropics/sandbox-runtime; pinned in package.json): Seatbelt
 * (`sandbox-exec`) on macOS, bubblewrap on Linux, and an HTTP/SOCKS proxy in Rye's process that
 * allows only listed hosts. It is used as a library:
 *
 * - `SandboxManager.initialize(base)` once per Rye process. srt's configuration is process-wide,
 *   so the base allows no hosts and no paths; everything per run goes in the per-call
 *   `customConfig` (filesystem) and a per-call network allow list
 *   (`registerCommandNetworkLists(commandId, …)`, keyed by an unguessable id the proxy reads from
 *   the proxy username). Updating that list is how approvals add hosts while the agent runs.
 * - `wrapWithSandbox(command, …, customConfig, …, { commandId })` returns a shell command line
 *   with the proxy variables baked in; Rye runs it as `/bin/bash -c <line>` with its own scrubbed
 *   env (srt's `wrapWithSandboxArgv` would hand back all of `process.env`).
 * - Local binding stays off: with it on, a sandboxed process could reach any localhost port,
 *   including Rye's own API.
 *
 * Nothing here starts a sandbox until `wrap` is called; `status()` only asks srt whether the
 * platform and its dependencies (ripgrep; bubblewrap and socat on Linux) are there. Tests inject
 * their own `ProcessSandbox` and never load srt.
 */

import { randomBytes } from "node:crypto";
import type { CodeSandboxStatus, SandboxPlan } from "./types.js";

/** What a whole-process sandbox needs to start one program. */
export interface ProcessSandboxRequest {
  /** The program and its arguments (no shell). */
  argv: string[];
  /** The program's whole environment (already scrubbed). */
  env: Record<string, string>;
  plan: SandboxPlan;
  /** Hosts the process may reach now (the agent's own, the plan's, approvals'). */
  allowedDomains: string[];
  /** Readable even inside `denyRead` areas (the agent's login and settings). */
  readOnly: string[];
  /** Writable besides the plan's `allowWrite` (the agent's session history). */
  write: string[];
  /** Never writable. */
  denyWrite: string[];
}

/** A program ready to start inside the sandbox. */
export interface SandboxedProcess {
  /** What to spawn (no shell around it), with `env`, in `plan.cwd`. */
  argv: string[];
  env: Record<string, string>;
  /** Replace the hosts the process may reach (after an approval, or when a one-off approval ends). */
  setAllowedDomains?(domains: string[]): void;
  /** Once the process has exited: drop its network allow list. */
  dispose(): Promise<void>;
}

export interface ProcessSandbox {
  status(): Promise<CodeSandboxStatus>;
  /** Throws when the sandbox can't be set up (never falls back to running unsandboxed). */
  wrap(req: ProcessSandboxRequest): Promise<SandboxedProcess>;
}

// ---------------------------------------------------------------------------
// Plan → srt config (pure; exported for tests)
// ---------------------------------------------------------------------------

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** The srt filesystem and network settings for one process: the plan plus the agent's own files. */
export function srtConfigFor(req: Pick<ProcessSandboxRequest, "plan" | "readOnly" | "write" | "denyWrite" | "allowedDomains">) {
  const fs = req.plan.filesystem;
  return {
    filesystem: {
      allowWrite: unique([...fs.allowWrite, ...req.write]),
      denyWrite: unique([...fs.denyWrite, ...req.denyWrite]),
      allowRead: unique([...fs.allowRead, ...req.readOnly, ...req.write]),
      denyRead: unique([...fs.denyRead]),
    },
    /** Per-process, through `registerCommandNetworkLists`; the session-wide list stays empty. */
    allowedDomains: unique(req.allowedDomains.map((d) => d.toLowerCase())),
  };
}

/** One argv as a POSIX shell command line. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

// ---------------------------------------------------------------------------
// sandbox-runtime
// ---------------------------------------------------------------------------

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");

/** The base srt configuration: no hosts, no paths (each process brings its own), no local binding. */
const BASE_CONFIG = {
  network: { allowedDomains: [] as string[], deniedDomains: [] as string[], allowLocalBinding: false },
  filesystem: { denyRead: [] as string[], allowRead: [] as string[], allowWrite: [] as string[], denyWrite: [] as string[] },
};

export interface SrtSandboxDeps {
  /** Loads srt. Default: a dynamic import, so a Rye that never runs an ACP engine never loads it. */
  load?: () => Promise<SrtModule>;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** The shell srt's command line runs in. Default `/bin/bash`. */
  shell?: string;
}

/** The real whole-process sandbox: `@anthropic-ai/sandbox-runtime`. */
export function srtProcessSandbox(deps: SrtSandboxDeps = {}): ProcessSandbox {
  const load = deps.load ?? (() => import("@anthropic-ai/sandbox-runtime"));
  let initialized: Promise<SrtModule> | null = null;
  const ready = (): Promise<SrtModule> => {
    initialized ??= load().then(async (srt) => {
      await srt.SandboxManager.initialize(BASE_CONFIG as Parameters<SrtModule["SandboxManager"]["initialize"]>[0]);
      return srt;
    });
    initialized.catch(() => (initialized = null));
    return initialized;
  };
  const platform = deps.platform ?? process.platform;
  const mechanism = platform === "darwin" ? ("seatbelt" as const) : platform === "linux" ? ("bubblewrap" as const) : null;

  return {
    async status(): Promise<CodeSandboxStatus> {
      if (!mechanism) return { available: false, mechanism: null, reason: platform === "win32" ? "native Windows is not supported; run Rye in WSL" : `${platform} is not supported` };
      let srt: SrtModule;
      try {
        srt = await load();
      } catch (err) {
        return { available: false, mechanism: null, reason: `sandbox-runtime couldn't be loaded (${err instanceof Error ? err.message : String(err)})` };
      }
      if (!srt.SandboxManager.isSupportedPlatform()) return { available: false, mechanism: null, reason: "sandbox-runtime doesn't support this platform" };
      const check = await srt.SandboxManager.checkDependenciesAsync().catch((err) => ({ errors: [err instanceof Error ? err.message : String(err)], warnings: [] }));
      if (check.errors.length > 0) return { available: false, mechanism: null, reason: check.errors.join("; ") };
      return { available: true, mechanism };
    },

    async wrap(req: ProcessSandboxRequest): Promise<SandboxedProcess> {
      const srt = await ready();
      const cfg = srtConfigFor(req);
      // At least 128 random bits: the proxy trusts whoever presents it (srt README, "Per-command network allow lists").
      const commandId = randomBytes(16).toString("base64url");
      const line = await srt.SandboxManager.wrapWithSandbox(
        shellCommand(req.argv),
        deps.shell ?? "/bin/bash",
        { filesystem: cfg.filesystem, network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false } } as Parameters<SrtModule["SandboxManager"]["wrapWithSandbox"]>[2],
        undefined,
        { commandId },
      );
      srt.SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: cfg.allowedDomains });
      return {
        argv: [deps.shell ?? "/bin/bash", "-c", line],
        env: req.env,
        setAllowedDomains(domains) {
          srt.SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: unique(domains.map((d) => d.toLowerCase())) });
        },
        async dispose() {
          srt.SandboxManager.unregisterCommandNetworkLists(commandId);
        },
      };
    },
  };
}
