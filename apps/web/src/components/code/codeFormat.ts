import type { CodeActivity, CodeEngineId, DiffFileStatus, SensitiveKind } from "@rye/shared";

export const STATUS_LETTER: Record<DiffFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
};

export const STATUS_WORD: Record<DiffFileStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
};

/** Short labels for the review flags (§3.5), as the file list shows them. */
export const SENSITIVE_LABEL: Record<SensitiveKind, string> = {
  manifest: "deps",
  lockfile: "lockfile",
  ci: "CI",
  git_hooks: "git hooks",
  envrc: ".envrc",
  editor_tasks: "editor tasks",
  agent_config: "agent config",
  agent_instructions: "agent instructions",
  env_file: "env file",
  symlink: "symlink",
  executable: "executable",
  binary: "binary",
};

export const SENSITIVE_WHY: Record<SensitiveKind, string> = {
  manifest: "Changes dependencies",
  lockfile: "Changes where packages are downloaded from",
  ci: "Changes what CI runs",
  git_hooks: "Changes what runs on commit or push",
  envrc: "Runs in your shell when you enter the folder",
  editor_tasks: "Your editor may run it",
  agent_config: "Changes how coding agents behave here",
  agent_instructions: "Instructions coding agents follow",
  env_file: "A tracked environment file",
  symlink: "A new link to somewhere else",
  executable: "Can now be run as a program",
  binary: "Contents can’t be reviewed as text",
};

export const ACTIVITY_LABEL: Record<CodeActivity, string> = {
  idle: "Idle",
  running: "Running",
  needs_approval: "Needs approval",
  ready: "Ready to review",
  error: "Last run failed",
};

export function engineTitle(engine: CodeEngineId, titles?: Map<string, string>): string {
  return titles?.get(engine) ?? (engine === "claude" ? "Claude" : engine === "pi" ? "Rye" : engine === "acp:copilot" ? "GitHub Copilot" : engine.replace(/^acp:/, ""));
}

export function formatCost(usd: number): string {
  if (!usd) return "$0";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function ago(ts: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The last two segments of a path, for narrow lists ("chat/search.ts"). */
export function shortPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
