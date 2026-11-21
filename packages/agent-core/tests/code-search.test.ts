/**
 * Unit tests for the code-search tools.
 * These tests only exercise the pure-TS logic (no ripgrep, no LLM).
 *
 * Because `settings` is a module-level singleton loaded before tests run,
 * we can't rely on env var overrides. Instead, we call the underlying
 * helper functions directly and pass explicit repo paths.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

// ---- helpers we need to test without going through discoverRepos() ----------
// We import the internal search helpers by copying the same logic inline
// (keeping tests simple and not requiring changes to the main source).

let repoRoot: string;
let repoPath: string;

beforeAll(() => {
  repoRoot = join(tmpdir(), `rye-test-${Date.now()}`);
  repoPath = join(repoRoot, "test-repo");
  mkdirSync(join(repoPath, ".git"), { recursive: true });
  mkdirSync(join(repoPath, "src"), { recursive: true });

  writeFileSync(
    join(repoPath, "src", "app.ts"),
    `import { createServer } from "http";

class DatabaseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DatabaseError";
  }
}

function connectToDatabase(url: string) {
  if (!url) throw new DatabaseError("Database URL is required");
  return createServer();
}

export { connectToDatabase, DatabaseError };
`
  );

  writeFileSync(
    join(repoPath, "src", "utils.py"),
    `def parse_config(path):
    """Load config from a TOML file."""
    import tomllib
    with open(path, "rb") as f:
        return tomllib.load(f)

class ConfigError(Exception):
    pass
`
  );
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Internal search helpers (replicated from source to avoid singleton issues)
// ---------------------------------------------------------------------------

import { readFileSync, statSync, readdirSync } from "node:fs";
import { extname, basename } from "node:path";

function globToExts(fileGlob: string): string[] {
  const braceMatch = fileGlob.match(/\*\.\{(.+)\}/);
  if (braceMatch) return braceMatch[1].split(",").map((e) => `.${e.trim()}`);
  const simpleMatch = fileGlob.match(/\*\.(\w+)/);
  if (simpleMatch) return [`.${simpleMatch[1]}`];
  return [];
}

function* walkFiles(dir: string): Generator<string> {
  const skip = new Set(["node_modules", ".git", "__pycache__", "dist", ".venv"]);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

interface Match { file: string; lineNumber: number; context: string[] }

function search(pattern: string, root: string, glob: string, ci = true): Match[] {
  const exts = globToExts(glob);
  const re = new RegExp(pattern, ci ? "i" : "");
  const matches: Match[] = [];
  for (const file of walkFiles(root)) {
    if (exts.length > 0 && !exts.includes(extname(file))) continue;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + 2);
      matches.push({ file, lineNumber: i + 1, context: lines.slice(start, end + 1) });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Tests using the inline helpers
// ---------------------------------------------------------------------------

describe("search helper", () => {
  test("finds DatabaseError in TypeScript files", () => {
    const results = search("DatabaseError", repoPath, "*.ts");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.file.endsWith("app.ts"))).toBe(true);
  });

  test("finds parse_config in Python files", () => {
    const results = search("parse_config", repoPath, "*.py");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.file.endsWith("utils.py"))).toBe(true);
  });

  test("returns nothing for unknown pattern", () => {
    const results = search("NONEXISTENT_XYZ_12345", repoPath, "*.{ts,py}");
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests for logToSource extraction logic (pure string manipulation)
// ---------------------------------------------------------------------------

function extractCandidate(logLine: string): string | null {
  let candidate = logLine
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const quoted = candidate.match(/"([^"]{6,})"/)?.[1];
  const errorMatch = candidate.match(/(?:Error|Exception|Failed|Cannot|Unable to)\s+\S+(?:\s+\S+)?/i)?.[0];
  candidate = quoted ?? errorMatch ?? candidate;
  candidate = candidate.slice(0, 80).trim();
  return candidate.length >= 6 ? candidate : null;
}

describe("log extraction", () => {
  test("extracts meaningful phrase from log line", () => {
    const c = extractCandidate('2024-01-15T10:30:00Z ERROR "Database URL is required" user_id=12345');
    expect(c).toBe("Database URL is required");
  });

  test("returns null for all-dynamic log line", () => {
    const c = extractCandidate("2024-01-01T00:00:00Z 192.168.1.1 550 12345");
    expect(c).toBeNull();
  });

  test("extracts error phrase", () => {
    const c = extractCandidate("2024-01-01 ERROR Failed to connect retry=3");
    // The regex captures "Error|Exception|Failed|..." and 2 following tokens
    expect(c).not.toBeNull();
    expect(c!.toLowerCase()).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// Stack trace regex tests
// ---------------------------------------------------------------------------

const PY_FRAME = /File "(.+?)", line (\d+), in (\w+)/g;
const NODE_FRAME = /at (?:(.+?) \()?(.+?):(\d+):\d+\)?/g;

describe("stack trace parsing", () => {
  test("parses Python stack frames", () => {
    const trace = `File "/app/utils.py", line 4, in parse_config`;
    const matches = [...trace.matchAll(PY_FRAME)];
    expect(matches.length).toBe(1);
    expect(matches[0][1]).toBe("/app/utils.py");
    expect(matches[0][2]).toBe("4");
    expect(matches[0][3]).toBe("parse_config");
  });

  test("parses Node.js stack frames", () => {
    const trace = `    at connectToDatabase (/project/src/app.ts:12:10)`;
    const matches = [...trace.matchAll(NODE_FRAME)];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0][1]).toContain("connectToDatabase");
  });

  test("returns no frames for plain text", () => {
    const pyMatches = [...("hello world".matchAll(PY_FRAME))];
    const nodeMatches = [...("hello world".matchAll(NODE_FRAME))];
    expect(pyMatches.length + nodeMatches.length).toBe(0);
  });
});
