/**
 * Code search tools — TypeScript port of the Python code_search.py tools.
 * Uses Bun.spawnSync for ripgrep, falls back to pure TS glob+regex.
 */

import { Type, type Tool } from "@earendil-works/pi-ai";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { settings } from "../config.js";

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

function isGitRepo(p: string): boolean {
  try {
    statSync(join(p, ".git"));
    return true;
  } catch {
    return false;
  }
}

interface RepoInfo {
  name: string;
  path: string;
}

export function discoverRepos(): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const seen = new Set<string>();

  // Explicit entries from config
  for (const r of settings.code_search.repos) {
    if (!seen.has(r.path)) {
      seen.add(r.path);
      repos.push({ name: r.name, path: r.path });
    }
  }

  // Auto-discover from repos_root
  if (settings.code_search.repos_root) {
    try {
      const entries = readdirSync(settings.code_search.repos_root, {
        withFileTypes: true,
      });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = join(settings.code_search.repos_root, e.name);
        if (seen.has(full)) continue;
        if (isGitRepo(full)) {
          seen.add(full);
          repos.push({ name: e.name, path: full });
        }
      }
    } catch {}
  }

  return repos;
}

function resolveRepos(repoName?: string): RepoInfo[] {
  const all = discoverRepos();
  if (!repoName) return all;
  return all.filter((r) => r.name === repoName);
}

// ---------------------------------------------------------------------------
// File matching helpers
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDES = settings.code_search.file_excludes;

function* walkFiles(dir: string, globExts: string[]): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (DEFAULT_EXCLUDES.includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full, globExts);
    } else if (e.isFile()) {
      if (globExts.length === 0 || globExts.includes(extname(e.name))) {
        yield full;
      }
    }
  }
}

function globToExts(fileGlob: string): string[] {
  // Handle patterns like *.{py,ts,js} or *.py
  const braceMatch = fileGlob.match(/\*\.\{(.+)\}/);
  if (braceMatch) return braceMatch[1].split(",").map((e) => `.${e.trim()}`);
  const simpleMatch = fileGlob.match(/\*\.(\w+)/);
  if (simpleMatch) return [`.${simpleMatch[1]}`];
  return [];
}

// ---------------------------------------------------------------------------
// Ripgrep search
// ---------------------------------------------------------------------------

/**
 * Run ripgrep and return stdout, or null if it couldn't be executed.
 * stdio is set explicitly because Bun inherits stderr by default, and
 * inheriting a closed fd from the server process makes posix_spawn fail EBADF.
 */
function runRg(args: string[], cwd?: string): string | null {
  try {
    const result = Bun.spawnSync(args, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Exit 1 means "no matches", which is a valid empty result, not a failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    return result.stdout.toString();
  } catch {
    return null;
  }
}

let rgAvailableCache: boolean | null = null;

function rgAvailable(): boolean {
  if (rgAvailableCache === null) rgAvailableCache = runRg(["rg", "--version"]) !== null;
  return rgAvailableCache;
}

interface Match {
  file: string;
  lineNumber: number;
  lineText: string;
  context: string[];
}

/** Returns null when ripgrep couldn't run, so the caller can fall back. */
function searchWithRg(
  pattern: string,
  repoPath: string,
  fileGlob: string,
  caseSensitive: boolean,
  contextLines: number,
  maxResults: number
): Match[] | null {
  const args = [
    "rg",
    "--line-number",
    "--no-heading",
    `--context=${contextLines}`,
    `--glob=${fileGlob}`,
    "--max-count=1",
    caseSensitive ? "" : "--ignore-case",
    pattern,
    repoPath,
  ].filter(Boolean);

  const stdout = runRg(args, repoPath);
  if (stdout === null) return null;

  const lines = stdout.split("\n");
  const matches: Match[] = [];
  let current: Match | null = null;

  for (const line of lines) {
    const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
    if (matchLine) {
      if (current) matches.push(current);
      if (matches.length >= maxResults) break;
      current = {
        file: matchLine[1],
        lineNumber: parseInt(matchLine[2], 10),
        lineText: matchLine[3],
        context: [],
      };
    } else if (current && line !== "--") {
      current.context.push(line);
    }
  }
  if (current) matches.push(current);
  return matches.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Pure TS search fallback
// ---------------------------------------------------------------------------

function searchPureTs(
  pattern: string,
  repoPath: string,
  fileGlob: string,
  caseSensitive: boolean,
  contextLines: number,
  maxResults: number
): Match[] {
  const exts = globToExts(fileGlob);
  const regex = new RegExp(pattern, caseSensitive ? "" : "i");
  const matches: Match[] = [];

  for (const file of walkFiles(repoPath, exts)) {
    if (matches.length >= maxResults) break;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (!regex.test(fileLines[i])) continue;
      const start = Math.max(0, i - contextLines);
      const end = Math.min(fileLines.length - 1, i + contextLines);
      matches.push({
        file,
        lineNumber: i + 1,
        lineText: fileLines[i],
        context: fileLines.slice(start, end + 1),
      });
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Format results
// ---------------------------------------------------------------------------

function formatResults(matches: Match[], repoName: string, repoPath: string): string[] {
  return matches.map((m) => {
    const rel = relative(repoPath, m.file);
    return `[${repoName}] ${rel}:${m.lineNumber}\n${m.context.join("\n")}`;
  });
}

// ---------------------------------------------------------------------------
// Read lines with context
// ---------------------------------------------------------------------------

function readLinesContext(file: string, lineNumber: number, contextLines: number): string {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    const start = Math.max(0, lineNumber - contextLines - 1);
    const end = Math.min(lines.length - 1, lineNumber + contextLines - 1);
    return lines
      .slice(start, end + 1)
      .map((l, i) => `  ${start + i + 1}: ${l}`)
      .join("\n");
  } catch {
    return "  (could not read file)";
  }
}

// ---------------------------------------------------------------------------
// Stack trace regexes
// ---------------------------------------------------------------------------

const PY_FRAME = /File "(.+?)", line (\d+), in (\w+)/g;
const NODE_FRAME = /at (?:(.+?) \()?(.+?):(\d+):\d+\)?/g;

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function listRepos(): string {
  const repos = discoverRepos();
  if (repos.length === 0) {
    return (
      "No repositories configured. Set RYE_CODE_SEARCH_REPOS_ROOT or add entries to code_search.repos in config.toml."
    );
  }
  return (
    `Available repositories (${repos.length}):\n` +
    repos.map((r) => `  ${r.name.padEnd(30)} ${r.path}`).join("\n")
  );
}

export function codeSearch(args: {
  pattern: string;
  repo_name?: string;
  file_glob?: string;
  case_sensitive?: boolean;
  context_lines?: number;
  max_results?: number;
  offset?: number;
}): string {
  const {
    pattern,
    repo_name,
    file_glob = "*.{py,ts,js,tsx,jsx}",
    case_sensitive = false,
    context_lines = 2,
    max_results = 50,
    offset = 0,
  } = args;

  const repos = resolveRepos(repo_name);
  if (repos.length === 0) {
    return `No repositories found${repo_name ? ` matching '${repo_name}'` : ""}. Run list_repos_tool to see available repos.`;
  }

  const useRg = settings.code_search.use_ripgrep && rgAvailable();
  // Fetch offset + max_results + 1 total so we can detect whether more exist
  const fetchLimit = offset + max_results + 1;
  const allMatches: string[] = [];
  let remaining = fetchLimit;

  for (const repo of repos) {
    if (remaining <= 0) break;
    const matches =
      (useRg
        ? searchWithRg(pattern, repo.path, file_glob, case_sensitive, context_lines, remaining)
        : null) ??
      searchPureTs(pattern, repo.path, file_glob, case_sensitive, context_lines, remaining);
    allMatches.push(...formatResults(matches, repo.name, repo.path));
    remaining -= matches.length;
  }

  const hasMore = allMatches.length > offset + max_results;
  const page = allMatches.slice(offset, offset + max_results);

  if (page.length === 0) {
    if (offset > 0) return `No more matches for \`${pattern}\` after offset ${offset}.`;
    return `No matches found for \`${pattern}\` in ${repo_name ? `repo '${repo_name}'` : `${repos.length} repo(s)`}.`;
  }

  const rangeEnd = offset + page.length;
  let header = `Showing matches ${offset + 1}–${rangeEnd} for \`${pattern}\``;
  if (hasMore) {
    header += ` (more results exist — call again with offset=${rangeEnd} to see the next page)`;
  }
  return header + "\n\n" + page.join("\n\n");
}

export function symbolSearch(args: {
  symbol: string;
  symbol_type?: "class" | "function" | "method" | "any";
  language?: "python" | "javascript" | "typescript" | "any";
  repo_name?: string;
}): string {
  const { symbol, symbol_type = "any", language = "any", repo_name } = args;
  const repos = resolveRepos(repo_name);
  if (repos.length === 0) {
    return `No repositories found${repo_name ? ` matching '${repo_name}'` : ""}.`;
  }

  const patterns: [string, string][] = [];
  if (symbol_type === "any" || symbol_type === "class") {
    if (language === "python" || language === "any")
      patterns.push([`class ${symbol}[:(]`, "Python class definition"]);
    if (language !== "python")
      patterns.push([`class ${symbol}[\\s{]`, "JS/TS class definition"]);
  }
  if (symbol_type === "any" || symbol_type === "function") {
    if (language === "python" || language === "any")
      patterns.push([`def ${symbol}\\s*\\(`, "Python function definition"]);
    if (language !== "python")
      patterns.push([`function ${symbol}\\s*\\(`, "JS/TS function definition"]);
    if (language !== "python")
      patterns.push([`const ${symbol}\\s*=\\s*(async\\s+)?\\(`, "JS/TS arrow function"]);
  }
  if (symbol_type === "any" || symbol_type === "method") {
    patterns.push([`\\.${symbol}\\s*\\(`, "method call"]);
  }

  const fileGlob =
    language === "python"
      ? "*.py"
      : language === "typescript"
      ? "*.{ts,tsx}"
      : language === "javascript"
      ? "*.{js,jsx}"
      : "*.{py,ts,js,tsx,jsx}";

  const useRg = settings.code_search.use_ripgrep && rgAvailable();
  const definitions: string[] = [];
  const callSites: string[] = [];
  const seen = new Set<string>();

  for (const [pat, label] of patterns) {
    const isDef = label.includes("definition") || label.includes("class");
    for (const repo of repos) {
      const matches =
        (useRg
          ? searchWithRg(pat, repo.path, fileGlob, false, 2, settings.code_search.max_results)
          : null) ??
        searchPureTs(pat, repo.path, fileGlob, false, 2, settings.code_search.max_results);
      for (const m of matches) {
        const key = `${m.file}:${m.lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rel = relative(repo.path, m.file);
        const entry =
          `[${label}] ${repo.name}:${rel}:${m.lineNumber}\n` +
          readLinesContext(m.file, m.lineNumber, 2);
        if (isDef) definitions.push(entry);
        else callSites.push(entry);
      }
    }
  }

  if (definitions.length === 0 && callSites.length === 0) {
    return `Symbol \`${symbol}\` not found in ${repo_name ? `repo ${repo_name}` : "any repo"}.`;
  }
  const parts: string[] = [];
  if (definitions.length > 0)
    parts.push(`=== Definitions (${definitions.length}) ===\n\n${definitions.join("\n\n")}`);
  if (callSites.length > 0)
    parts.push(`=== Call Sites (${callSites.length}) ===\n\n${callSites.slice(0, 20).join("\n\n")}`);
  return parts.join("\n\n");
}

export function stackTraceTool(args: {
  stack_trace: string;
  repo_name?: string;
}): string {
  const { stack_trace, repo_name } = args;
  const repos = resolveRepos(repo_name);
  const output: string[] = [];

  function findFile(filePath: string): string | null {
    for (const repo of repos) {
      const full = join(repo.path, filePath);
      try {
        statSync(full);
        return full;
      } catch {}
      // Try basename match
      for (const f of walkFiles(repo.path, [])) {
        if (basename(f) === basename(filePath)) return f;
      }
    }
    return null;
  }

  // Python frames
  const pyMatches = [...stack_trace.matchAll(PY_FRAME)];
  if (pyMatches.length > 0) {
    output.push("=== Python Stack Frames ===");
    for (const m of pyMatches) {
      const [, filePath, lineNo, func] = m;
      const resolved = findFile(filePath);
      const label = `  Frame: ${basename(filePath)}:${lineNo} in ${func}`;
      if (resolved) {
        output.push(`${label}\n  (resolved: ${resolved})\n${readLinesContext(resolved, parseInt(lineNo), 4)}`);
      } else {
        output.push(`${label}\n  (file not found in local repos)`);
      }
    }
  }

  // Node frames
  const nodeMatches = [...stack_trace.matchAll(NODE_FRAME)];
  if (nodeMatches.length > 0) {
    output.push("=== Node.js Stack Frames ===");
    for (const m of nodeMatches) {
      const [, func, filePath, lineNo] = m;
      const resolved = findFile(filePath);
      const label = `  Frame: ${basename(filePath)}:${lineNo} in ${func || "<anonymous>"}`;
      if (resolved) {
        output.push(`${label}\n  (resolved: ${resolved})\n${readLinesContext(resolved, parseInt(lineNo), 4)}`);
      } else {
        output.push(`${label}\n  (file not found in local repos)`);
      }
    }
  }

  if (output.length === 0) {
    return "No recognisable stack frames found. Supported: Python and Node.js.";
  }
  return output.join("\n\n");
}

export function fileSearch(args: {
  pattern: string;
  repo_name?: string;
  file_glob?: string;
  max_results?: number;
}): string {
  const { pattern, repo_name, file_glob, max_results = 100 } = args;
  const repos = resolveRepos(repo_name);
  if (repos.length === 0) {
    return `No repositories found${repo_name ? ` matching '${repo_name}'` : ""}. Run list_repos_tool to see available repos.`;
  }

  const useRg = settings.code_search.use_ripgrep && rgAvailable();
  const results: string[] = [];

  for (const repo of repos) {
    if (results.length >= max_results) break;
    const remaining = max_results - results.length;

    if (useRg) {
      const args_rg = ["rg", "--files"];
      if (file_glob) args_rg.push(`--glob=${file_glob}`);
      args_rg.push(repo.path);
      const stdout = runRg(args_rg, repo.path);
      if (stdout !== null) {
        const files = stdout.split("\n").filter(Boolean);
        const nameRe = new RegExp(pattern, "i");
        for (const f of files) {
          if (results.length >= max_results) break;
          const rel = relative(repo.path, f);
          if (nameRe.test(rel)) results.push(`[${repo.name}] ${rel}`);
        }
        continue;
      }
    }

    // Pure TS fallback
    const exts = file_glob ? globToExts(file_glob) : [];
    const nameRe = new RegExp(pattern, "i");
    let count = 0;
    for (const f of walkFiles(repo.path, exts)) {
      if (count >= remaining) break;
      const rel = relative(repo.path, f);
      if (nameRe.test(rel)) {
        results.push(`[${repo.name}] ${rel}`);
        count++;
      }
    }
  }

  if (results.length === 0) {
    return `No files matching '${pattern}'${file_glob ? ` with glob '${file_glob}'` : ""} found in ${repo_name ? `repo '${repo_name}'` : `${repos.length} repo(s)`}.`;
  }
  return `Found ${results.length} file(s) matching '${pattern}'${results.length >= max_results ? ` (truncated at ${max_results})` : ""}:\n\n${results.join("\n")}`;
}

export function logToSource(args: {
  log_line: string;
  repo_name?: string;
  file_glob?: string;
}): string {
  const { log_line, repo_name, file_glob = "*.{py,ts,js,tsx,jsx}" } = args;

  // Strip dynamic values (UUIDs, timestamps, IPs, IDs)
  let candidate = log_line
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Extract quoted string or meaningful phrase
  const quoted = candidate.match(/"([^"]{6,})"/)?.[1];
  const errorMatch = candidate.match(/(?:Error|Exception|Failed|Cannot|Unable to)\s+\S+(?:\s+\S+)?/i)?.[0];
  candidate = quoted ?? errorMatch ?? candidate;
  candidate = candidate.slice(0, 80).trim();

  if (candidate.length < 6) {
    return "Could not extract a useful search pattern from the log line. Try code_search_tool with a manual pattern.";
  }

  return codeSearch({ pattern: candidate, repo_name, file_glob, context_lines: 3 });
}

// ---------------------------------------------------------------------------
// Tool definitions (pi-ai format)
// ---------------------------------------------------------------------------

export const codeSearchTools: Tool[] = [
  {
    name: "list_repos_tool",
    description:
      "List all source code repositories available for searching. Call this first when you need to know what codebases are available.",
    parameters: Type.Object({}),
  },
  {
    name: "code_search_tool",
    description:
      "Search source code across local repositories by exact string or regex pattern. Returns file paths, line numbers, and surrounding context. " +
      "Results are paginated: if the response says more results exist, call again with offset=N to fetch the next page.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search string or regex pattern." }),
      repo_name: Type.Optional(Type.String({ description: "Repo name to search (omit to search all)." })),
      file_glob: Type.Optional(Type.String({ description: "Glob pattern, e.g. '*.py'" })),
      case_sensitive: Type.Optional(Type.Boolean()),
      context_lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many leading matches — use for pagination. Set to the end of the previous page (e.g. 50, 100) to fetch the next page." })),
    }),
  },
  {
    name: "symbol_search_tool",
    description:
      "Find where a class, function, or method is defined or called across source code.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Class, function, or method name." }),
      symbol_type: Type.Optional(
        Type.Union([Type.Literal("class"), Type.Literal("function"), Type.Literal("method"), Type.Literal("any")])
      ),
      language: Type.Optional(
        Type.Union([Type.Literal("python"), Type.Literal("javascript"), Type.Literal("typescript"), Type.Literal("any")])
      ),
      repo_name: Type.Optional(Type.String()),
    }),
  },
  {
    name: "stack_trace_tool",
    description:
      "Parse a Python or Node.js stack trace and correlate each frame to source code.",
    parameters: Type.Object({
      stack_trace: Type.String({ description: "Full stack trace text." }),
      repo_name: Type.Optional(Type.String()),
    }),
  },
  {
    name: "file_search_tool",
    description:
      "Find files in source repositories by name or path pattern (regex or substring). " +
      "Use this when you know part of a filename or directory but not its exact location. " +
      "Faster than code_search_tool when you just need to locate files, not their contents. " +
      "Optionally narrow results with a file_glob (e.g. '*.py').",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Regex or substring to match against relative file paths, e.g. 'payment', 'webhook.*handler', 'models/user'",
      }),
      repo_name: Type.Optional(Type.String({ description: "Repo name to search (omit to search all)." })),
      file_glob: Type.Optional(Type.String({ description: "Glob to restrict file types, e.g. '*.py' or '*.{ts,tsx}'" })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
  },
  {
    name: "log_to_source_tool",
    description:
      "Given a raw log line, find the source code that most likely produced it.",
    parameters: Type.Object({
      log_line: Type.String({ description: "A single log line." }),
      repo_name: Type.Optional(Type.String()),
      file_glob: Type.Optional(Type.String()),
    }),
  },
];
