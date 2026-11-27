/**
 * Code sessions: the static policy (docs/design/code-sessions.md §3.2–3.4, §3.6).
 *
 * `compilePolicy` turns `[code.policy]`, the repo's own rules and a workspace into a
 * `CompiledPolicy`: `commandVerdict` judges a Bash command line, `pathVerdict` a file tool's path.
 * It is the code-session analogue of `readOnlyViolation` (tools/sql.ts): a strict pure function
 * with table tests (tests/code-policy.test.ts), backed by a boundary the operating system enforces
 * (the sandbox, code/sandbox.ts). The claim rests on the sandbox. That is why a command the lists
 * below don't name is *allowed*: the sandbox confines its writes and network, as with Claude Code's
 * `autoAllowBashIfSandboxed`. The lists handle what the sandbox can't express (publishing, git
 * operations on refs Rye relies on, credentials) and what needs the user (network, installs,
 * long-running processes).
 *
 * Commands are tokenised by a small shell parser (quotes, escapes, `$'…'`, `$(…)`, backticks,
 * process substitution, heredocs, subshells, `; && || | &`, comments, line continuations), unwrapped
 * through `env`, `command`, `exec`, `nohup`, `time`, `nice`, `timeout`, `xargs`, `find -exec`,
 * `bash -c`, … and judged per simple command. The verdict is the strictest of the parts
 * (deny > ask > allow). Anything the parser can't follow is asked (`unparseable`), never allowed.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import type {
  AskCategory,
  CodePolicyRule,
  CodeRepoConfig,
  CompilePolicy,
  CompiledPolicy,
  PathOp,
  PolicyConfig,
  PolicyScope,
  Verdict,
  Workspace,
} from "./types.js";

type AskVerdict = Extract<Verdict, { verdict: "ask" }>;

// ===========================================================================
// Paths
// ===========================================================================

/** Case-insensitive file systems (APFS and HFS+ by default, NTFS): containment is compared case-folded there. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

const fold = (p: string) => p.normalize("NFC").toLowerCase();
const fsKey = (p: string) => (CASE_INSENSITIVE_FS ? fold(p) : p);

/** `p` is `root` or inside it. Both absolute and canonical; `fsKey`/`fold` applied by the caller. */
function within(p: string, root: string): boolean {
  if (root === "/") return p.startsWith("/");
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The real location of an absolute path, resolving every symbolic link on the way (also a final
 * one whose target doesn't exist yet: writing through it would create the target) and the true
 * case of every existing component. Components that don't exist are kept as written, so a file
 * about to be created resolves through its nearest existing parent.
 */
export function canonicalPath(abs: string): string {
  if (!isAbsolute(abs)) throw new Error(`canonicalPath needs an absolute path, got ${abs}`);
  let cur = "/";
  let rest = abs.split("/").filter(Boolean);
  let hops = 0;
  while (rest.length) {
    const c = rest.shift()!;
    if (c === ".") continue;
    if (c === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = cur === "/" ? `/${c}` : `${cur}/${c}`;
    let st;
    try {
      st = lstatSync(next);
    } catch {
      return posix.normalize([next, ...rest].join("/"));
    }
    if (st.isSymbolicLink()) {
      if (++hops > 40) throw new Error("too many levels of symbolic links");
      const target = readlinkSync(next);
      rest = [...target.split("/").filter(Boolean), ...rest];
      if (target.startsWith("/")) cur = "/";
      continue;
    }
    try {
      cur = realpathSync(next);
    } catch {
      cur = next;
    }
  }
  return cur;
}

const safeCanonical = (abs: string): string | null => {
  try {
    return canonicalPath(abs);
  } catch {
    return null;
  }
};

/**
 * Credentials and private state under the user's home that nothing in a code session reads
 * (§3.2, §3.6). Also the sandbox's `denyRead` (code/sandbox.ts). Best effort.
 */
export const HOME_SECRETS: readonly { path: string; what: string }[] = [
  { path: ".ssh", what: "SSH keys" },
  { path: ".aws", what: "AWS credentials" },
  { path: ".gnupg", what: "GPG keys" },
  { path: ".netrc", what: "saved logins (.netrc)" },
  { path: ".npmrc", what: "npm registry tokens" },
  { path: ".yarnrc.yml", what: "yarn registry tokens" },
  { path: ".pypirc", what: "PyPI tokens" },
  { path: ".gem/credentials", what: "RubyGems tokens" },
  { path: ".cargo/credentials", what: "crates.io tokens" },
  { path: ".cargo/credentials.toml", what: "crates.io tokens" },
  { path: ".m2/settings.xml", what: "Maven credentials" },
  { path: ".gradle/gradle.properties", what: "Gradle credentials" },
  { path: ".docker", what: "Docker credentials" },
  { path: ".kube", what: "Kubernetes credentials" },
  { path: ".azure", what: "Azure credentials" },
  { path: ".config/gcloud", what: "Google Cloud credentials" },
  { path: ".config/gh", what: "GitHub CLI tokens" },
  { path: ".config/hub", what: "GitHub tokens" },
  { path: ".config/glab-cli", what: "GitLab tokens" },
  { path: ".git-credentials", what: "stored git credentials" },
  { path: ".config/git/credentials", what: "stored git credentials" },
  { path: ".password-store", what: "a password store" },
  { path: ".config/op", what: "1Password CLI state" },
  { path: ".vault-token", what: "a Vault token" },
  { path: ".terraform.d", what: "Terraform credentials" },
  { path: ".pgpass", what: "database passwords" },
  { path: ".my.cnf", what: "database passwords" },
  { path: ".claude", what: "Claude Code's own state and login" },
  { path: ".claude.json", what: "Claude Code's own state" },
  // Re-opened read-only for the Copilot engine only (engines/copilot.ts `copilotFiles`).
  { path: ".copilot", what: "GitHub Copilot CLI's own state and login" },
  { path: ".bash_history", what: "shell history" },
  { path: ".zsh_history", what: "shell history" },
  { path: "Library/Keychains", what: "keychains" },
];

/** System-wide secrets. */
const SYSTEM_SECRETS: readonly { path: string; what: string }[] = [{ path: "/Library/Keychains", what: "keychains" }];

/** `.env`, `.env.local`, `.envrc`, …: secrets when they are outside the workspace (§3.6). */
const DOTENV = /^\.env(rc|\..*)?$/i;

/** Absolute secret paths for a home directory, plus Rye's config and data dirs (the sandbox's `denyRead`). */
export function secretPaths(scope: Pick<PolicyScope, "home" | "dataDir" | "configDir">): string[] {
  return [
    ...HOME_SECRETS.map((s) => join(scope.home, s.path)),
    ...SYSTEM_SECRETS.map((s) => s.path),
    scope.configDir,
    scope.dataDir,
  ];
}

/** Toolchain directories that file tools may read without asking, for `PolicyScope.toolchainDirs`. */
export function defaultToolchainDirs(home: string): string[] {
  return [
    "/usr/include", "/usr/lib", "/usr/share", "/usr/local/include", "/usr/local/lib", "/usr/local/share",
    "/opt/homebrew/include", "/opt/homebrew/lib", "/opt/homebrew/share", "/opt/homebrew/Cellar", "/opt/homebrew/opt",
    "/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer", "/nix/store",
    join(home, ".bun/install/global"), join(home, ".nvm/versions"), join(home, ".volta/tools"),
    join(home, ".rustup/toolchains"), join(home, ".cargo/registry/src"), join(home, "go/pkg/mod"),
    join(home, ".pyenv/versions"), join(home, ".deno"),
  ];
}

// ===========================================================================
// Shell parsing
// ===========================================================================

/** Thrown when a command can't be parsed confidently; the command is then asked, never allowed. */
export class ShellParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellParseError";
  }
}

type Part =
  | { t: "lit"; v: string; q: boolean }
  | { t: "var"; name: string; complex: boolean; q: boolean }
  | { t: "tilde"; user: string }
  | { t: "sub"; body: ShellNode[] }
  | { t: "arith" };

interface ShellWord {
  parts: Part[];
  raw: string;
}

interface Redirect {
  op: string;
  target?: ShellWord;
  heredoc?: { delim: string; body: string; quoted: boolean; parts: Part[] };
}

type ShellNode =
  | { t: "cmd"; words: ShellWord[]; redirects: Redirect[]; raw: string; pipeline: number; pipedIn: boolean; loop: boolean }
  | { t: "open" }
  | { t: "close" };

const MAX_NESTING = 12;
const MAX_COMMAND_LENGTH = 64_000;
const META = new Set([" ", "\t", "\n", "\r", ";", "&", "|", "(", ")", "<", ">"]);
/** Reserved words skipped in command position: what follows them is the command. */
const SKIP_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
/** Reserved words this parser doesn't follow. */
const UNSUPPORTED_KEYWORDS = new Set(["case", "esac", "coproc", "select"]);

function pushLit(parts: Part[], v: string, q: boolean) {
  const last = parts[parts.length - 1];
  if (last && last.t === "lit" && last.q === q) last.v += v;
  else parts.push({ t: "lit", v, q });
}

const isPlainWord = (w: ShellWord) => w.parts.length > 0 && w.parts.every((p) => p.t === "lit" && !p.q);

class Parser {
  private i = 0;
  private pipeline = 0;
  private pipedIn = false;
  private nesting = 0;
  private heredocs: Redirect[] = [];

  private constructor(private readonly s: string, private readonly depth: number) {
    if (depth > MAX_NESTING) this.fail("it is nested too deeply");
  }

  static parse(s: string, depth = 0): ShellNode[] {
    return new Parser(s, depth).list(null);
  }

  /** A heredoc body with an unquoted delimiter: expanded like a double-quoted string. */
  static heredocParts(s: string, depth: number): Part[] {
    const p = new Parser(s, depth);
    const parts: Part[] = [];
    p.dquoted(parts, null);
    return parts;
  }

  private fail(msg: string): never {
    throw new ShellParseError(msg);
  }

  private list(end: ")" | null): ShellNode[] {
    const s = this.s;
    const out: ShellNode[] = [];
    let words: ShellWord[] = [];
    let redirects: Redirect[] = [];
    let start = -1;
    let loop = false;
    let funcName = false;
    const finish = () => {
      if (words.length || redirects.length) {
        out.push({ t: "cmd", words, redirects, raw: s.slice(start, this.i).trim(), pipeline: this.pipeline, pipedIn: this.pipedIn, loop });
      }
      this.pipedIn = false;
      words = [];
      redirects = [];
      start = -1;
      loop = false;
    };
    for (;;) {
      if (this.i >= s.length) {
        finish();
        if (end) this.fail(`a "(" is never closed`);
        if (this.heredocs.length) this.fail("a here-document has no body");
        return out;
      }
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r") {
        this.i++;
        continue;
      }
      if (c === "\\" && s[this.i + 1] === "\n") {
        this.i += 2;
        continue;
      }
      if (c === "#") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "\n") {
        finish();
        this.i++;
        this.readHeredocs();
        this.pipeline++;
        continue;
      }
      if (c === ";") {
        if (s[this.i + 1] === ";" || s[this.i + 1] === "&") this.fail("case statements are not supported");
        finish();
        this.i++;
        this.pipeline++;
        continue;
      }
      if (c === "&") {
        if (s[this.i + 1] === ">") {
          if (start < 0) start = this.i;
          this.redirect(redirects);
          continue;
        }
        finish();
        this.i += s[this.i + 1] === "&" ? 2 : 1;
        this.pipeline++;
        continue;
      }
      if (c === "|") {
        if (s[this.i + 1] === "|") {
          finish();
          this.i += 2;
          this.pipeline++;
          continue;
        }
        finish();
        this.i += s[this.i + 1] === "&" ? 2 : 1;
        this.pipedIn = true;
        continue;
      }
      if (c === "(") {
        if (words.length === 1 && redirects.length === 0 && /^[ \t]*\)/.test(s.slice(this.i + 1))) {
          // `name() { …; }`: a function definition. Its body is judged like any other command.
          this.i = s.indexOf(")", this.i) + 1;
          words = [];
          start = -1;
          continue;
        }
        if (words.length || redirects.length) this.fail('of an unexpected "("');
        if (s[this.i + 1] === "(") {
          this.i = this.arithmetic(this.i + 2);
          continue;
        }
        this.i++;
        const pipedIn = this.pipedIn;
        out.push({ t: "open" });
        this.pipedIn = pipedIn;
        out.push(...this.list(")"), { t: "close" });
        continue;
      }
      if (c === ")") {
        if (end === ")") {
          finish();
          this.i++;
          return out;
        }
        this.fail('of an unexpected ")"');
      }
      if ((c === "<" || c === ">") && s[this.i + 1] !== "(") {
        if (start < 0) start = this.i;
        this.redirect(redirects);
        continue;
      }
      if (start < 0) start = this.i;
      const word = this.word();
      if (/^\d+$/.test(word.raw) && (s[this.i] === "<" || s[this.i] === ">") && s[this.i + 1] !== "(") {
        this.redirect(redirects);
        continue;
      }
      if (words.length === 0 && !loop && isPlainWord(word)) {
        const k = word.raw;
        if (funcName) {
          funcName = false;
          if (!redirects.length) start = -1;
          continue;
        }
        if (SKIP_KEYWORDS.has(k)) {
          if (!redirects.length) start = -1;
          continue;
        }
        if (UNSUPPORTED_KEYWORDS.has(k)) this.fail(`"${k}" statements are not supported`);
        if (k === "function") {
          funcName = true;
          if (!redirects.length) start = -1;
          continue;
        }
        if (k === "for") loop = true;
      }
      words.push(word);
    }
  }

  private word(): ShellWord {
    const s = this.s;
    const start = this.i;
    const parts: Part[] = [];
    while (this.i < s.length) {
      const c = s[this.i];
      if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
        this.i += 2;
        parts.push({ t: "sub", body: this.sublist() });
        continue;
      }
      if (META.has(c)) break;
      if (c === "\\") {
        if (s[this.i + 1] === "\n") {
          this.i += 2;
          continue;
        }
        if (this.i + 1 >= s.length) this.fail("it ends with a backslash");
        pushLit(parts, s[this.i + 1], true);
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) this.fail("a ' quote is never closed");
        pushLit(parts, s.slice(this.i + 1, j), true);
        // An empty '' still makes the word quoted (and non-empty as a word).
        if (j === this.i + 1) parts.push({ t: "lit", v: "", q: true });
        this.i = j + 1;
        continue;
      }
      if (c === '"') {
        this.i++;
        const before = parts.length;
        this.dquoted(parts, '"');
        if (parts.length === before) parts.push({ t: "lit", v: "", q: true });
        continue;
      }
      if (c === "$") {
        this.dollar(parts, false);
        continue;
      }
      if (c === "`") {
        this.backtick(parts);
        continue;
      }
      if (c === "~" && this.i === start) {
        let j = this.i + 1;
        while (j < s.length && /[A-Za-z0-9._-]/.test(s[j])) j++;
        if (j >= s.length || s[j] === "/" || META.has(s[j])) {
          parts.push({ t: "tilde", user: s.slice(this.i + 1, j) });
          this.i = j;
          continue;
        }
      }
      pushLit(parts, c, false);
      this.i++;
    }
    return { parts, raw: s.slice(start, this.i) };
  }

  /** `$(…)` or `<(…)`/`>(…)`: the inner command list, up to the matching ")". */
  private sublist(): ShellNode[] {
    if (++this.nesting + this.depth > MAX_NESTING) this.fail("it is nested too deeply");
    const pipeline = this.pipeline;
    const pipedIn = this.pipedIn;
    this.pipedIn = false;
    const body = this.list(")");
    this.pipeline = pipeline;
    this.pipedIn = pipedIn;
    this.nesting--;
    return body;
  }

  private dquoted(parts: Part[], term: '"' | null) {
    const s = this.s;
    for (;;) {
      if (this.i >= s.length) {
        if (term) this.fail('a " quote is never closed');
        return;
      }
      const c = s[this.i];
      if (term && c === term) {
        this.i++;
        return;
      }
      if (c === "\\") {
        const n = s[this.i + 1];
        if (n === "\n") {
          this.i += 2;
          continue;
        }
        if (n === "$" || n === "`" || n === "\\" || (term !== null && n === '"')) {
          pushLit(parts, n, true);
          this.i += 2;
          continue;
        }
        pushLit(parts, "\\", true);
        this.i++;
        continue;
      }
      if (c === "$") {
        this.dollar(parts, true);
        continue;
      }
      if (c === "`") {
        this.backtick(parts);
        continue;
      }
      pushLit(parts, c, true);
      this.i++;
    }
  }

  private dollar(parts: Part[], inDq: boolean) {
    const s = this.s;
    const n = s[this.i + 1];
    if (!inDq && n === "'") {
      this.i += 2;
      pushLit(parts, this.ansiC(), true);
      return;
    }
    if (!inDq && n === '"') {
      this.i += 2;
      this.dquoted(parts, '"');
      return;
    }
    if (n === "(") {
      if (s[this.i + 2] === "(") {
        this.i = this.arithmetic(this.i + 3);
        parts.push({ t: "arith" });
        return;
      }
      this.i += 2;
      parts.push({ t: "sub", body: this.sublist() });
      return;
    }
    if (n === "{") {
      const close = this.braceEnd(this.i + 2);
      const inner = s.slice(this.i + 2, close);
      this.i = close + 1;
      if (/\$\(|`/.test(inner)) this.fail("it has a command substitution inside ${…}");
      if (/@P/.test(inner)) this.fail("${…@P} expands a prompt string, which can run commands");
      const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(inner);
      if (!m) this.fail(`of a \${${inner}} expansion it can't read`);
      parts.push({ t: "var", name: m[0], complex: inner.length > m[0].length, q: inDq });
      return;
    }
    if (n === "[") this.fail("$[…] arithmetic is not supported");
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(this.i + 1));
    if (m) {
      this.i += 1 + m[0].length;
      parts.push({ t: "var", name: m[0], complex: false, q: inDq });
      return;
    }
    pushLit(parts, "$", inDq);
    this.i++;
  }

  private braceEnd(from: number): number {
    const s = this.s;
    let depth = 1;
    for (let j = from; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "'") {
        const k = s.indexOf("'", j + 1);
        if (k < 0) break;
        j = k;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j;
    }
    this.fail("a ${ is never closed");
  }

  /** `$'…'`: ANSI-C quoting, decoded, so `$'\x67it'` is judged as `git`. */
  private ansiC(): string {
    const s = this.s;
    let out = "";
    const simple: Record<string, string> = {
      a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
      "\\": "\\", "'": "'", '"': '"', "?": "?",
    };
    for (;;) {
      if (this.i >= s.length) this.fail("a $' quote is never closed");
      const c = s[this.i];
      if (c === "'") {
        this.i++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        this.i++;
        continue;
      }
      const n = s[this.i + 1];
      this.i += 2;
      if (n === undefined) this.fail("a $' quote is never closed");
      if (n in simple) {
        out += simple[n];
        continue;
      }
      const take = (re: RegExp, max: number) => {
        let d = "";
        while (d.length < max && this.i < s.length && re.test(s[this.i])) d += s[this.i++];
        return d;
      };
      if (/[0-7]/.test(n)) {
        out += String.fromCharCode(parseInt(n + take(/[0-7]/, 2), 8) & 0xff);
        continue;
      }
      if (n === "x" || n === "u" || n === "U") {
        const h = take(/[0-9a-fA-F]/, n === "x" ? 2 : n === "u" ? 4 : 8);
        if (!h) {
          out += `\\${n}`;
          continue;
        }
        const code = parseInt(h, 16);
        if (code > 0x10ffff) this.fail("a $' quote has an invalid escape");
        out += String.fromCodePoint(code);
        continue;
      }
      if (n === "c") {
        const ch = s[this.i++];
        if (ch === undefined) this.fail("a $' quote is never closed");
        out += String.fromCharCode(ch.charCodeAt(0) & 0x1f);
        continue;
      }
      out += `\\${n}`;
    }
  }

  private backtick(parts: Part[]) {
    const s = this.s;
    let j = this.i + 1;
    let inner = "";
    for (;;) {
      if (j >= s.length) this.fail("a ` substitution is never closed");
      const c = s[j];
      if (c === "`") break;
      if (c === "\\" && (s[j + 1] === "`" || s[j + 1] === "\\" || s[j + 1] === "$")) {
        inner += s[j + 1];
        j += 2;
        continue;
      }
      inner += c;
      j++;
    }
    this.i = j + 1;
    parts.push({ t: "sub", body: Parser.parse(inner, this.depth + this.nesting + 1) });
  }

  /** From just inside `((` (or `$((`): the index after the matching `))`. */
  private arithmetic(from: number): number {
    const s = this.s;
    let depth = 0;
    for (let j = from; j < s.length; j++) {
      const c = s[j];
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) {
          if (s[j + 1] !== ")") this.fail("of an arithmetic expression it can't read");
          if (/\$\(|`|\$\{/.test(s.slice(from, j))) this.fail("it has a substitution inside arithmetic");
          return j + 2;
        }
        depth--;
      }
    }
    this.fail("an arithmetic expression is never closed");
  }

  private redirect(redirects: Redirect[]) {
    const s = this.s;
    while (/\d/.test(s[this.i] ?? "")) this.i++;
    const op = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">>", ">&", ">|", "<", ">"].find((o) => s.startsWith(o, this.i));
    if (!op) this.fail("of a redirection it can't read");
    this.i += op.length;
    while (s[this.i] === " " || s[this.i] === "\t") this.i++;
    if (op === "<<" || op === "<<-") {
      const delim = this.word();
      if (!delim.raw) this.fail("a here-document has no delimiter");
      if (!delim.parts.every((p) => p.t === "lit")) this.fail("a here-document delimiter isn't plain text");
      const r: Redirect = {
        op,
        heredoc: {
          delim: delim.parts.map((p) => (p.t === "lit" ? p.v : "")).join(""),
          body: "",
          quoted: delim.parts.some((p) => p.t === "lit" && p.q),
          parts: [],
        },
      };
      this.heredocs.push(r);
      redirects.push(r);
      return;
    }
    if ((op === ">&" || op === "<&") && /^(\d+|-)(?=$|[\s;&|()<>])/.test(s.slice(this.i))) {
      while (/[\d-]/.test(s[this.i] ?? "")) this.i++;
      redirects.push({ op });
      return;
    }
    const target = this.word();
    if (!target.raw) this.fail("a redirection has no target");
    redirects.push({ op, target });
  }

  private readHeredocs() {
    for (const r of this.heredocs) {
      const h = r.heredoc!;
      const lines: string[] = [];
      while (this.i < this.s.length) {
        let nl = this.s.indexOf("\n", this.i);
        if (nl < 0) nl = this.s.length;
        const line = this.s.slice(this.i, nl);
        this.i = Math.min(nl + 1, this.s.length);
        if ((r.op === "<<-" ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      h.body = lines.join("\n");
      if (!h.quoted) h.parts = Parser.heredocParts(h.body, this.depth + this.nesting + 1);
    }
    this.heredocs = [];
  }
}

// ===========================================================================
// Patterns
// ===========================================================================

const squash = (s: string) => s.trim().replace(/\s+/g, " ");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A `[code.policy]` pattern as a regular expression over a whole simple command. `*` matches any
 * run of characters; a trailing ` *` also matches the bare command (`bun test *` matches `bun test`).
 */
export function patternRegex(pattern: string): RegExp {
  const p = squash(pattern);
  const body = (s: string) => s.split("*").map(escapeRe).join(".*");
  if (p.endsWith(" *")) return new RegExp(`^${body(p.slice(0, -2))}(?: .*)?$`, "s");
  return new RegExp(`^${body(p)}$`, "s");
}

/**
 * True for this machine and private networks: localhost names, loopback, unspecified, link-local and
 * private IPv4/IPv6 ranges, and `.local`/`.internal` names. Rye's own API listens on localhost, and an
 * agent that can reach it could answer its own approvals, so these hosts are refused outright and can
 * never be approved or allow-listed (verified as a real escape before the sandbox's local binding was
 * turned off).
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::" || h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("::ffff:")) {
    if (h.startsWith("::ffff:")) return isLocalHost(h.slice(7));
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  // Bare decimal or hex forms of an IPv4 address (http://2130706433/, http://0x7f000001/).
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  return false;
}

/** True when `host` is on the allowlist (`example.com`, or `*.example.com` for its subdomains). */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => {
    const p = d.toLowerCase().trim();
    if (p.startsWith("*.")) return h.endsWith(p.slice(1));
    return h === p;
  });
}

// ===========================================================================
// Built-in rules (what Settings → Code lists, and the `rule` on verdicts)
// ===========================================================================

const NO_REMOTE = "the workspace has no remote and no credentials; when the work is ready, Rye creates a branch in your repository (Create branch)";

const LOCAL_NETWORK_RULE = "network to localhost or a private network";

export const BUILTIN_RULES: readonly CodePolicyRule[] = [
  { pattern: LOCAL_NETWORK_RULE, verdict: "deny", source: "builtin", reason: "Rye's own API listens on this machine; an agent that reached it could answer its own approvals. Never approvable." },
  { pattern: "git push", verdict: "deny", source: "builtin", reason: `Publishes commits; ${NO_REMOTE}.` },
  { pattern: "git remote add|set-url", verdict: "deny", source: "builtin", reason: "Code sessions have no remote to push to." },
  { pattern: "git config <key that runs commands or reaches a remote>", verdict: "deny", source: "builtin", reason: "core.hooksPath, core.fsmonitor, core.sshCommand, *.pager, diff.external, filter.*, alias.*, credential.*, remote URLs and similar keys make git run commands or reach a remote." },
  { pattern: "git config --global|--system|--edit", verdict: "deny", source: "builtin", reason: "Writes configuration outside the workspace, or any key at once." },
  { pattern: "git filter-branch|filter-repo", verdict: "deny", source: "builtin", reason: "Rewrites every ref at once." },
  { pattern: "git gc --prune*|git prune", verdict: "deny", source: "builtin", reason: "Deletes objects the session's snapshots may still need." },
  { pattern: "git reflog expire|delete", verdict: "deny", source: "builtin", reason: "Deletes the history that makes rewritten work recoverable." },
  { pattern: "git update-ref refs/rye/*", verdict: "deny", source: "builtin", reason: "refs/rye/* are Rye's snapshots." },
  { pattern: "git worktree add <outside the workspace>", verdict: "deny", source: "builtin", reason: "Worktrees stay inside the workspace." },
  { pattern: "git clone", verdict: "deny", source: "builtin", reason: "A code session works only in the clone Rye made." },
  { pattern: "git credential*|send-email|for-each-repo|maintenance start", verdict: "deny", source: "builtin", reason: "Reads credentials, sends mail, or acts on other repositories." },
  { pattern: "git <write> outside the workspace", verdict: "deny", source: "builtin", reason: "Git may change only the session's own clone (and only read elsewhere)." },
  { pattern: "npm|pnpm|yarn|bun publish, cargo publish, twine upload, …", verdict: "deny", source: "builtin", reason: "Publishes packages." },
  { pattern: "gh, aws, gcloud, kubectl, terraform, vercel, … (API CLIs with credentials)", verdict: "deny", source: "builtin", reason: "Uses your credentials for an online service." },
  { pattern: "rm|rmdir|unlink <outside the workspace>", verdict: "deny", source: "builtin", reason: "Deletes files outside repo/, tmp/ and cache/." },
  { pattern: "sudo, su, chmod/chown outside the workspace, launchctl, crontab, osascript, security, open", verdict: "deny", source: "builtin", reason: "Changes the system, or reaches outside the sandbox." },
  { pattern: "docker, podman", verdict: "deny", source: "builtin", reason: "Containers run outside the sandbox." },
  { pattern: "curl … | sh", verdict: "deny", source: "builtin", reason: "Runs a downloaded script Rye can't see." },
  { pattern: "<a path holding credentials or Rye's data>", verdict: "deny", source: "builtin", reason: "~/.ssh, ~/.aws, ~/.config/gh, Rye's config and data dirs, .env files outside the workspace, …" },
  { pattern: "bun|npm|pnpm|yarn install|add, pip install, cargo fetch, go mod download, npx, …", verdict: "ask", source: "builtin", reason: "Installs packages (network; dependency scripts may run in the sandbox)." },
  { pattern: "curl, wget, git fetch|pull|submodule update, ssh, …", verdict: "ask", source: "builtin", reason: "Uses the network." },
  { pattern: "dev servers and watchers (bun run dev, vite, --watch, tail -f, nohup, …)", verdict: "ask", source: "builtin", reason: "Starts a long-running process." },
  { pattern: "eval, bash -c, $(…) as a command name, xargs git, …", verdict: "ask", source: "builtin", reason: "Can't be judged statically." },
  { pattern: "<file tool reads outside the workspace and toolchain dirs>", verdict: "ask", source: "builtin", reason: "Reads outside the known areas need your approval." },
  { pattern: "<everything else>", verdict: "allow", source: "builtin", reason: "Runs inside the sandbox: writes confined to the workspace, network off." },
];

// ===========================================================================
// Verdict helpers
// ===========================================================================

const allowV = (rule?: string): Verdict => (rule ? { verdict: "allow", rule } : { verdict: "allow" });
const denyV = (reason: string, rule?: string): Verdict => (rule ? { verdict: "deny", reason, rule } : { verdict: "deny", reason });
function askV(category: AskCategory, reason: string, extra: { hosts?: string[]; pattern?: string; rule?: string } = {}): Verdict {
  const v: AskVerdict = { verdict: "ask", reason, category };
  if (extra.hosts?.length) v.hosts = [...new Set(extra.hosts)];
  if (extra.pattern) v.pattern = extra.pattern;
  if (extra.rule) v.rule = extra.rule;
  return v;
}
const unparseable = (reason: string) => askV("unparseable", reason);

/** The strictest of several verdicts: any deny; else the asks merged (hosts unioned); else allow. */
export function strictestVerdict(vs: readonly Verdict[]): Verdict {
  const d = vs.find((v) => v.verdict === "deny");
  if (d) return d;
  const asks = vs.filter((v): v is AskVerdict => v.verdict === "ask");
  if (asks.length === 0) return vs.find((v) => v.verdict === "allow" && v.rule) ?? allowV();
  if (asks.length === 1) return asks[0];
  const reasons = [...new Set(asks.map((a) => a.reason))];
  const hosts = [...new Set(asks.flatMap((a) => a.hosts ?? []))];
  return askV(asks[0].category, reasons.join("; "), { hosts });
}

interface PartResult {
  verdict: Verdict;
  /** Downloads something (curl, wget): piping it into a shell is denied. */
  fetches?: boolean;
  /** Runs a script read from its standard input (a shell or interpreter with no script argument). */
  runsStdin?: boolean;
}

function strictest(parts: readonly (PartResult | Verdict | null | undefined)[]): PartResult {
  const results = parts.filter((p): p is PartResult | Verdict => !!p).map((p) => ("verdict" in p && typeof p.verdict === "object" ? (p as PartResult) : { verdict: p as Verdict }));
  return {
    verdict: strictestVerdict(results.map((r) => r.verdict)),
    fetches: results.some((r) => r.fetches),
    runsStdin: results.some((r) => r.runsStdin),
  };
}

// ===========================================================================
// Command tables
// ===========================================================================

/** Every git subcommand Rye knows. Anything else may be an alias or a `git-<name>` program: asked. */
const KNOWN_GIT = new Set(
  ("add am annotate apply archimport archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore " +
    "check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph " +
    "commit-tree config count-objects credential credential-cache credential-cache--daemon credential-store credential-osxkeychain " +
    "credential-netrc credential-libsecret credential-manager cvsexportcommit cvsimport cvsserver daemon describe diagnose diff " +
    "diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch filter-repo " +
    "fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects gc get-tar-commit-id grep gui hash-object help hook " +
    "http-backend http-push imap-send index-pack init init-db instaweb interpret-trailers last-modified lfs log ls-files ls-remote " +
    "ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-one-file merge-tree mergetool mktag mktree " +
    "multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff " +
    "read-tree rebase receive-pack reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse " +
    "revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace " +
    "submodule svn switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive " +
    "upload-pack var verify-commit verify-pack verify-tag version web--browse whatchanged worktree write-tree").split(" "),
);

const PUSH_REASON = `git push is never allowed in a code session: ${NO_REMOTE}.`;
const CREDENTIAL_REASON = "git credential commands read or store your git credentials, which code sessions never use.";

/** Git subcommands that are always refused. */
const GIT_DENY: Record<string, { reason: string; rule: string }> = {
  push: { reason: PUSH_REASON, rule: "git push" },
  "send-pack": { reason: PUSH_REASON, rule: "git push" },
  "http-push": { reason: PUSH_REASON, rule: "git push" },
  "send-email": { reason: "git send-email sends patches out of the workspace.", rule: "git credential*|send-email|for-each-repo|maintenance start" },
  "imap-send": { reason: "git imap-send sends patches out of the workspace.", rule: "git credential*|send-email|for-each-repo|maintenance start" },
  "filter-branch": { reason: "git filter-branch rewrites every ref at once and isn't allowed in a code session; rewrite single commits with rebase instead.", rule: "git filter-branch|filter-repo" },
  "filter-repo": { reason: "git filter-repo rewrites every ref at once and isn't allowed in a code session; rewrite single commits with rebase instead.", rule: "git filter-branch|filter-repo" },
  clone: { reason: "git clone isn't allowed: a code session works only in the clone Rye made for it.", rule: "git clone" },
  prune: { reason: "git prune deletes unreachable objects, which the session's snapshots may still need (as git gc --prune does).", rule: "git gc --prune*|git prune" },
  credential: { reason: CREDENTIAL_REASON, rule: "git credential*|send-email|for-each-repo|maintenance start" },
  "for-each-repo": { reason: "git for-each-repo runs git in other repositories.", rule: "git credential*|send-email|for-each-repo|maintenance start" },
};
for (const k of KNOWN_GIT) if (k.startsWith("credential-")) GIT_DENY[k] = GIT_DENY.credential;

/** Git subcommands that serve a repository to a client; Rye can't tell what they'll be asked. */
const GIT_SERVE = new Set(["receive-pack", "upload-pack", "upload-archive", "cvsserver", "http-backend"]);

/** Subcommands that use the network. */
const GIT_NETWORK = new Set(["fetch", "pull", "ls-remote", "fetch-pack", "request-pull", "svn", "p4", "cvsimport", "archimport", "cvsexportcommit"]);

/** Subcommands that start a long-running process. */
const GIT_LONG = new Set(["daemon", "instaweb", "gui", "citool", "web--browse"]);

/** Subcommands that never change the repository. */
const GIT_READ_ONLY = new Set(
  ("annotate archive blame cat-file check-attr check-ignore check-mailmap check-ref-format cherry column count-objects describe diff " +
    "diff-files diff-index diff-pairs diff-tree fmt-merge-msg for-each-ref format-patch fsck fsck-objects get-tar-commit-id grep help " +
    "last-modified log ls-files ls-remote ls-tree mailinfo mailsplit merge-base name-rev patch-id range-diff rev-list rev-parse " +
    "shortlog show show-branch show-index show-ref status stripspace var verify-commit verify-pack verify-tag version whatchanged").split(" "),
);

/** Global git options without a value. */
const GIT_FLAGS = new Set([
  "-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--no-advice",
  "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--html-path", "--man-path", "--info-path",
  "--version", "-v", "--help", "-h", "--exec-path",
]);

/** Variables that tell git which repository to use. */
const GIT_REPO_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]);
/** Variables that make git run a program. */
const GIT_COMMAND_ENV = new Set([
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "GIT_EXTERNAL_DIFF",
  "GIT_PROXY_COMMAND", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR",
]);
/** Values of command-running settings that run nothing worth checking. */
const SAFE_COMMAND_VALUES = new Set(["", "true", "false", "0", "1", "no", "off", ":", "/dev/null", "cat", "less", "less -r", "less -R", "more"]);

/**
 * Git config keys that make git run a program or reach a remote (§3.3 deny list, plus the keys
 * with the same effect). Lower-case keys; `section.sub.name` keeps its subsection.
 */
export function dangerousGitConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  const dot = k.indexOf(".");
  if (dot < 0) return false;
  const section = k.slice(0, dot);
  const name = k.slice(k.lastIndexOf(".") + 1);
  if (["alias", "credential", "filter", "include", "includeif", "url", "protocol", "pager"].includes(section)) return true;
  if (name === "pager") return true;
  if (section === "remote" && ["url", "pushurl", "proxy", "receivepack", "uploadpack", "vcs"].includes(name)) return true;
  if (section === "core" && ["hookspath", "fsmonitor", "sshcommand", "gitproxy", "askpass", "editor", "worktree"].includes(name)) return true;
  if (k === "diff.external" || k === "sequence.editor" || k === "uploadpack.packobjectshook") return true;
  if (section === "diff" && (name === "textconv" || name === "command")) return true;
  if (section === "merge" && name === "driver") return true;
  if (section === "gpg" && name === "program") return true;
  if ((section === "difftool" || section === "mergetool") && name === "cmd") return true;
  return false;
}

const NPM_HOSTS = ["registry.npmjs.org"];
const YARN_HOSTS = ["registry.yarnpkg.com", "registry.npmjs.org"];
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];
const CRATES_HOSTS = ["crates.io", "index.crates.io", "static.crates.io"];
const GO_HOSTS = ["proxy.golang.org", "sum.golang.org"];
const GEM_HOSTS = ["rubygems.org", "index.rubygems.org"];
const BREW_HOSTS = ["formulae.brew.sh", "ghcr.io"];

const PUBLISH_RULE = "npm|pnpm|yarn|bun publish, cargo publish, twine upload, …";
const publishDeny = (what: string) => denyV(`${what} publishes a package, which a code session never does.`, PUBLISH_RULE);
const accountDeny = (what: string) => denyV(`${what} changes your package registry account, which a code session never does.`, PUBLISH_RULE);

/** CLIs that act on an online service with the user's credentials. */
const API_CLIS = new Set([
  "gh", "hub", "glab", "aws", "gcloud", "gsutil", "bq", "az", "heroku", "vercel", "netlify", "fly", "flyctl", "firebase", "doctl",
  "kubectl", "helm", "terraform", "tofu", "pulumi", "op", "vault", "bw", "wrangler", "eas", "stripe", "railway", "supabase",
  "sentry-cli", "doppler", "linode-cli", "jira", "acli", "gcli",
]);
const CONTAINER_CLIS = new Set(["docker", "podman", "nerdctl", "colima", "limactl", "lima", "minikube", "kind", "docker-compose", "podman-compose"]);
const SYSTEM_DENY: Record<string, string> = {
  sudo: "sudo runs a command as another user, outside the sandbox's limits.",
  su: "su switches user, outside the sandbox's limits.",
  doas: "doas runs a command as another user, outside the sandbox's limits.",
  pkexec: "pkexec runs a command as another user, outside the sandbox's limits.",
  run0: "run0 runs a command as another user, outside the sandbox's limits.",
  launchctl: "launchctl manages system services, outside the workspace.",
  crontab: "crontab schedules commands to run later, outside the sandbox.",
  at: "at schedules commands to run later, outside the sandbox.",
  batch: "batch schedules commands to run later, outside the sandbox.",
  osascript: "osascript drives other apps, outside the sandbox.",
  security: "security reads and changes keychains.",
  open: "open launches apps and URLs outside the sandbox.",
  "xdg-open": "xdg-open launches apps and URLs outside the sandbox.",
  shutdown: "shutdown changes the system.",
  reboot: "reboot changes the system.",
  halt: "halt changes the system.",
  poweroff: "poweroff changes the system.",
  systemctl: "systemctl manages system services.",
  service: "service manages system services.",
  chsh: "chsh changes your account.",
  passwd: "passwd changes your account.",
  dscl: "dscl changes directory services.",
  diskutil: "diskutil changes disks.",
  csrutil: "csrutil changes system security.",
  nvram: "nvram changes firmware settings.",
  pmset: "pmset changes power settings.",
  scutil: "scutil changes system configuration.",
  systemsetup: "systemsetup changes system configuration.",
  tccutil: "tccutil changes privacy permissions.",
  spctl: "spctl changes system security.",
  mount: "mount changes the file system layout.",
  umount: "umount changes the file system layout.",
  kextload: "kextload changes the kernel.",
};

/** HTTP clients: their output piped into a shell is a "curl | sh". */
const FETCHERS = new Set(["curl", "wget", "http", "https", "xh", "xhs", "httpie", "aria2c", "fetch", "lynx", "links", "elinks", "w3m"]);
const NETWORK_CLIS = new Set([
  ...FETCHERS, "ftp", "sftp", "scp", "ssh", "mosh", "nc", "ncat", "netcat", "telnet", "socat", "ping", "ping6", "dig", "nslookup",
  "host", "traceroute", "mtr", "whois", "ab", "wrk", "hey", "grpcurl", "websocat", "ngrok", "ncu", "npm-check-updates",
]);

/** Script paths that are really standard input. */
const STDIN_PATHS = /^(-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "ash", "yash"]);
const INTERPRETERS = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|perl[0-9.]*|ruby|php[0-9.]*|lua[0-9.]*|deno|bun|tclsh|Rscript)$/i;

/** Tools whose listed subcommands start a server or watcher. */
const SERVER_SUBCOMMANDS: Record<string, string[]> = {
  next: ["dev", "start"],
  nuxt: ["dev", "preview", "start"],
  nuxi: ["dev", "preview", "start"],
  astro: ["dev", "preview"],
  remix: ["dev"],
  gatsby: ["develop", "serve"],
  expo: ["start"],
  "react-native": ["start"],
  storybook: ["dev"],
  "svelte-kit": ["dev", "preview"],
  turbo: ["dev", "watch"],
  hugo: ["server", "serve"],
  jekyll: ["serve", "s"],
  rails: ["s", "server"],
  ng: ["serve", "s"],
  webpack: ["serve", "watch"],
  flask: ["run"],
};

/** Script names that start servers or watchers. */
const LONG_SCRIPT = /^(dev|serve|server|start|watch|preview|storybook)([:_-].*)?$|[:_-](dev|serve|watch)$/i;
/** Options that keep a command running. */
const LONG_FLAG = /^--(watch(All)?|hot|serve)(=(?!false|0).*)?$/;

const LONG_REASON = "starts a long-running process (a server or watcher)";

// ===========================================================================
// The judge
// ===========================================================================

interface Val {
  /** The value, with known variables and `~` expanded. */
  text: string;
  /** As written. */
  raw: string;
  /** Only known when it runs (a substitution, an unknown variable, …). */
  dynamic: boolean;
  /** Has an unquoted `*`, `?` or `[`. */
  glob: boolean;
  /** Has an unquoted brace expansion. */
  brace: boolean;
  /** Unquoted plain text. */
  plain: boolean;
  /** A substitution in it downloads something. */
  fetches: boolean;
}

const staticVal = (text: string): Val => ({ text, raw: text, dynamic: false, glob: false, brace: false, plain: true, fetches: false });
/** Arguments `xargs` reads from its input. */
const FROM_INPUT: Val = { text: "", raw: "<arguments from input>", dynamic: true, glob: false, brace: false, plain: false, fetches: false };

interface Env {
  name: string;
  value: string | null;
}

interface Stdin {
  pipedIn: boolean;
  /** A here-document or here-string. */
  text?: string;
  /** `< file`. */
  file: boolean;
}

interface Call {
  cwd: string | null;
  stdin: Stdin;
  /** The simple command as written; set at the top level only, for patterns. */
  raw?: string;
  depth: number;
}

interface EvalState {
  cwd: string | null;
  vars: Map<string, string | null>;
  aliases: Map<string, string | null>;
}

const cloneState = (st: EvalState): EvalState => ({ cwd: st.cwd, vars: new Map(st.vars), aliases: new Map(st.aliases) });

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;

function assignName(w: ShellWord): { name: string; append: boolean } | null {
  const p = w.parts[0];
  if (!p || p.t !== "lit" || p.q) return null;
  const m = ASSIGN.exec(p.v);
  return m ? { name: m[1], append: m[2] === "+" } : null;
}

/** The word after `NAME=`. */
function assignValue(w: ShellWord): ShellWord {
  const first = w.parts[0] as Extract<Part, { t: "lit" }>;
  const rest = first.v.slice(first.v.indexOf("=") + 1);
  return { parts: [...(rest ? [{ t: "lit" as const, v: rest, q: false }] : []), ...w.parts.slice(1)], raw: w.raw.slice(w.raw.indexOf("=") + 1) };
}

/**
 * How often each variable is set in the whole command. A variable resolves to its value only when
 * it is set once, to plain text, before it is used; anything else (set twice, in a loop, by
 * `read`, appended to) is only known when it runs.
 */
function countAssignments(nodes: ShellNode[], counts: Map<string, number>) {
  const bump = (n: string, by = 1) => counts.set(n, (counts.get(n) ?? 0) + by);
  const subs = (parts: Part[]) => parts.forEach((p) => p.t === "sub" && countAssignments(p.body, counts));
  for (const n of nodes) {
    if (n.t !== "cmd") continue;
    n.words.forEach((w) => subs(w.parts));
    n.redirects.forEach((r) => {
      if (r.target) subs(r.target.parts);
      if (r.heredoc) subs(r.heredoc.parts);
    });
    if (n.loop) {
      if (n.words[1]) bump(n.words[1].raw, 2);
      continue;
    }
    let k = 0;
    for (; k < n.words.length; k++) {
      const a = assignName(n.words[k]);
      if (!a) break;
      bump(a.name, a.append ? 2 : 1);
    }
    const first = n.words[k];
    if (!first || !isPlainWord(first)) continue;
    const rest = n.words.slice(k + 1);
    if (["export", "declare", "typeset", "local", "readonly"].includes(first.raw)) {
      for (const w of rest) {
        const a = assignName(w);
        if (a) bump(a.name, a.append ? 2 : 1);
        else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.raw)) bump(w.raw, 2);
      }
    } else if (["read", "mapfile", "readarray", "unset", "getopts", "printf"].includes(first.raw)) {
      for (const w of rest) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.raw)) bump(w.raw, 2);
    }
  }
}

/** Everything a judgement needs from the compiled policy. */
interface PolicyCore {
  ws: Workspace;
  scope: PolicyScope;
  repoDir: string;
  tmpDir: string;
  /** Canonical write roots: repo/, tmp/, cache/, plus the repo's `allow_write`. */
  writeRoots: string[];
  readRoots: string[];
  secrets: { path: string; what: string }[];
  dataDir: string;
  configDir: string;
  sessionDir: string;
  home: string;
  allowedDomains: string[];
  deny: CompiledRule[];
  ask: CompiledRule[];
  allow: CompiledRule[];
  sessionAllow: CompiledRule[];
  sessionReads: CompiledRule[];
}

interface CompiledRule {
  pattern: string;
  re: RegExp;
}

class Judge {
  private counts = new Map<string, number>();

  constructor(private readonly p: PolicyCore) {}

  // ---------------------------------------------------------------- helpers

  /** Inside one of the workspace's write roots (after canonicalising). */
  insideWrite(real: string): boolean {
    const k = fsKey(real);
    return this.p.writeRoots.some((r) => within(k, fsKey(r)));
  }

  /**
   * Why a path is off limits, or null. Checked on the canonical path, and again on the path as
   * written (`lexical`) in case a secret directory is itself a symlink; the `.env` rule needs the
   * canonical path, since it depends on being outside the workspace.
   */
  secretReason(path: string, lexical = false): string | null {
    const f = fold(path);
    for (const s of this.p.secrets) if (within(f, fold(s.path))) return s.what;
    if (within(f, fold(this.p.configDir))) return "Rye's configuration";
    if (within(f, fold(this.p.dataDir)) && !within(f, fold(this.p.sessionDir))) return "Rye's data (chats, memory, other sessions)";
    if (!lexical && DOTENV.test(basename(path)) && !this.insideWrite(path)) return "secrets (an .env file outside the workspace)";
    return null;
  }

  /**
   * What a wildcard path could reach: a secret when the part before the wildcard is inside one,
   * or when some leading run of its segments matches a secret path (`~/.ss?/id_rsa`, `~/.*`).
   */
  globSecret(glob: string, cwd: string | null): string | null {
    const abs = this.abs(glob, cwd);
    if (abs === null) return null;
    const idx = abs.search(/[*?[]/);
    const fixed = abs.slice(0, abs.lastIndexOf("/", idx) + 1) || "/";
    const fixedWhy = this.secretOf(fixed, safeCanonical(fixed) ?? fixed);
    if (fixedWhy) return fixedWhy;
    const segRe = (seg: string) =>
      (/^[*?[]/.test(seg) ? "(?!\\.)" : "") +
      seg.replace(/\[!/g, "[^").split(/(\*|\?|\[[^\]]*\])/).map((t) => (t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.startsWith("[") && t.endsWith("]") && t.length > 2 ? t : escapeRe(t))).join("");
    const segs = posix.normalize(abs).split("/").filter(Boolean);
    const targets = [...this.p.secrets.map((s) => s.path), this.p.configDir, this.p.dataDir];
    for (let n = 1; n <= segs.length; n++) {
      if (!/[*?[]/.test(segs[n - 1])) continue;
      const re = new RegExp(`^/${segs.slice(0, n).map(segRe).join("/")}$`, "i");
      const hit = targets.find((t) => re.test(t) && t !== this.p.sessionDir);
      if (hit) return this.secretReason(hit) ?? "a secret";
    }
    return null;
  }

  /** `secretReason` for an absolute path: its canonical form, then as written. */
  secretOf(abs: string, real: string): string | null {
    return this.secretReason(real) ?? this.secretReason(posix.normalize(abs), true);
  }

  /** Absolute form of a path argument, or null when it is relative to a directory Rye can't work out. */
  abs(text: string, cwd: string | null): string | null {
    if (text.startsWith("/")) return text;
    if (cwd === null) return null;
    return join(cwd, text || ".");
  }

  lookup(name: string, st: EvalState): string | null {
    if (st.vars.has(name)) return st.vars.get(name) ?? null;
    if (name === "HOME") return this.p.home;
    if (name === "TMPDIR") return this.p.tmpDir;
    if (name === "PWD") return st.cwd;
    return null;
  }

  value(w: ShellWord, st: EvalState): Val {
    let text = "";
    let unq = "";
    let dynamic = false;
    let glob = false;
    let plain = true;
    for (const p of w.parts) {
      if (p.t === "lit") {
        text += p.v;
        if (p.q) {
          plain = false;
          unq += " ";
        } else {
          unq += p.v;
          if (/[*?[]/.test(p.v)) glob = true;
        }
        continue;
      }
      plain = false;
      if (p.t === "var") {
        const v = p.complex ? null : this.lookup(p.name, st);
        if (v === null || (!p.q && /[\s*?[]/.test(v))) {
          dynamic = true;
          text += `$${p.name}`;
        } else text += v;
        continue;
      }
      if (p.t === "tilde") {
        const h = p.user === "" ? this.lookup("HOME", st) : null;
        if (h === null) {
          dynamic = true;
          text += `~${p.user}`;
        } else text += h;
        continue;
      }
      dynamic = true;
      text += "$(…)";
    }
    return { text, raw: w.raw, dynamic, glob, brace: /\{[^{}]*(,|\.\.)[^{}]*\}/.test(unq), plain, fetches: false };
  }

  // ------------------------------------------------------------ lists

  run(nodes: ShellNode[], cwd: string | null): PartResult[] {
    this.counts = new Map();
    countAssignments(nodes, this.counts);
    return this.list(nodes, { cwd, vars: new Map(), aliases: new Map() }, 0).results;
  }

  /** A command string handed to `bash -c`, `eval`, an alias, …: parsed and judged on its own. */
  nested(text: string, cwd: string | null, depth: number): Verdict {
    if (depth > MAX_NESTING) return unparseable("it nests commands too deeply");
    let nodes: ShellNode[];
    try {
      nodes = Parser.parse(text, depth);
    } catch (e) {
      return unparseable(`Rye couldn't parse the inner command (${(e as Error).message})`);
    }
    const judge = new Judge(this.p);
    return strictestVerdict(judge.run(nodes, cwd).map((r) => r.verdict));
  }

  list(nodes: ShellNode[], st: EvalState, depth: number): { results: PartResult[]; fetches: boolean } {
    const results: PartResult[] = [];
    const stack: EvalState[] = [];
    const stages: { pipeline: number; pipedIn: boolean; result: PartResult }[] = [];
    let cur = st;
    for (const n of nodes) {
      if (n.t === "open") {
        stack.push(cur);
        cur = cloneState(cur);
        continue;
      }
      if (n.t === "close") {
        cur = stack.pop() ?? cur;
        continue;
      }
      const r = this.cmd(n, cur, depth);
      results.push(...r.parts);
      if (r.main) stages.push({ pipeline: n.pipeline, pipedIn: n.pipedIn, result: r.main });
    }
    // `curl … | sh`: a later stage of a pipeline runs, as a script, what an earlier one downloaded.
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (!s.pipedIn || !s.result.runsStdin) continue;
      if (stages.slice(0, i).some((e) => e.pipeline === s.pipeline && e.result.fetches)) {
        results.push({ verdict: denyV("Piping a download into a shell runs a script Rye can't see; download it to a file and look at it first.", "curl … | sh") });
      }
    }
    return { results, fetches: results.some((r) => r.fetches) };
  }

  cmd(n: Extract<ShellNode, { t: "cmd" }>, st: EvalState, depth: number): { parts: PartResult[]; main?: PartResult } {
    const parts: PartResult[] = [];
    const judgeSubs = (ps: Part[]): boolean => {
      let fetches = false;
      for (const p of ps) {
        if (p.t !== "sub") continue;
        const r = this.list(p.body, cloneState(st), depth + 1);
        parts.push(...r.results);
        if (r.fetches) fetches = true;
      }
      return fetches;
    };
    const vals = n.words.map((w) => {
      const fetches = judgeSubs(w.parts);
      return { ...this.value(w, st), fetches };
    });
    let stdin: Stdin = { pipedIn: n.pipedIn, file: false };
    for (const r of n.redirects) {
      if (r.target) judgeSubs(r.target.parts);
      if (r.heredoc) {
        judgeSubs(r.heredoc.parts);
        stdin = { ...stdin, text: r.heredoc.body };
      } else if (r.op === "<<<" && r.target) {
        stdin = { ...stdin, text: this.value(r.target, st).text };
      } else if (r.op === "<" && r.target) {
        stdin = { ...stdin, file: true };
      }
      const v = this.redirectVerdict(r, st);
      if (v) parts.push({ verdict: v });
    }
    if (n.loop) return { parts };

    let k = 0;
    const env: Env[] = [];
    for (; k < n.words.length; k++) {
      const a = assignName(n.words[k]);
      if (!a) break;
      const v = this.value(assignValue(n.words[k]), st);
      env.push({ name: a.name, value: v.dynamic || v.glob || a.append ? null : v.text });
    }
    const argv = vals.slice(k);
    if (argv.length === 0) {
      for (const e of env) st.vars.set(e.name, this.counts.get(e.name) === 1 ? e.value : null);
      return { parts };
    }

    const first = argv[0];
    if (first.plain && st.aliases.has(first.text)) {
      const alias = st.aliases.get(first.text);
      const main: PartResult =
        alias == null
          ? { verdict: unparseable(`"${first.text}" is an alias whose value Rye can't work out`) }
          : { verdict: this.nested(`${alias} ${n.words.slice(k + 1).map((w) => w.raw).join(" ")}`, st.cwd, depth + 1) };
      parts.push(main);
      return { parts, main };
    }

    const main = this.simple(argv, env, { cwd: st.cwd, stdin, raw: squash(n.raw), depth });
    parts.push(main);
    this.updateState(argv, st);
    return { parts, main };
  }

  /** `cd`, `pushd`, `popd`, `alias`, `unalias`: the shell state later commands see. */
  updateState(argv: Val[], st: EvalState) {
    const name = commandName(argv[0]);
    const args = argv.slice(1);
    if (name === "cd" || name === "pushd") {
      const rest = args.filter((a) => a.dynamic || !/^-[LPe@]+$/.test(a.text));
      const target = rest[0]?.text === "--" ? rest[1] : rest[0];
      if (!target) st.cwd = this.p.home;
      else if (target.dynamic || target.glob || target.text === "-") st.cwd = null;
      else {
        const abs = this.abs(target.text, st.cwd);
        st.cwd = abs === null ? null : safeCanonical(abs);
      }
    } else if (name === "popd") {
      st.cwd = null;
    } else if (name === "alias") {
      for (const a of args) {
        const eq = a.text.indexOf("=");
        if (eq <= 0) continue;
        st.aliases.set(a.text.slice(0, eq), a.dynamic ? null : a.text.slice(eq + 1));
      }
    } else if (name === "unalias") {
      for (const a of args) st.aliases.delete(a.text);
    }
  }

  redirectVerdict(r: Redirect, st: EvalState): Verdict | null {
    if (!r.target || r.heredoc || r.op === "<<<") return null;
    const v = this.value(r.target, st);
    if (v.dynamic || v.glob) return null;
    const write = r.op !== "<" && r.op !== "<&";
    const t = v.text;
    if (/^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/.test(t)) return null;
    const abs = this.abs(t, st.cwd);
    if (abs === null) return null;
    const real = safeCanonical(abs) ?? abs;
    const secret = this.secretOf(abs, real);
    if (secret) return denyV(`${write ? "Writes" : "Reads"} ${t}, which holds ${secret}; a code session never touches it.`, "<a path holding credentials or Rye's data>");
    if (write && !this.insideWrite(real)) return denyV(`Writes ${t} (${real}), outside the workspace; only repo/, tmp/ and cache/ are writable.`, "rm|rmdir|unlink <outside the workspace>");
    return null;
  }

  // ------------------------------------------------------------ simple commands

  /** One simple command: the built-in judgement, then the user's patterns. */
  simple(argv: Val[], env: Env[], call: Call): PartResult {
    if (call.depth > 24) return { verdict: unparseable("it wraps commands too deeply") };
    const builtin = this.builtin(argv, env, call);
    const texts = [normalizedText(argv)];
    if (call.raw) texts.push(call.raw);
    return { ...builtin, verdict: this.applyPatterns(builtin.verdict, texts) };
  }

  applyPatterns(v: Verdict, texts: string[]): Verdict {
    if (v.verdict === "deny") return v;
    const hit = (rules: CompiledRule[]) => rules.find((r) => texts.some((t) => r.re.test(t)));
    let r = hit(this.p.deny);
    if (r) return denyV(`Matches the deny rule "${r.pattern}".`, r.pattern);
    r = hit(this.p.sessionAllow);
    if (r) return allowV(r.pattern);
    r = hit(this.p.ask);
    if (r) return askV("rule", `matches the ask rule "${r.pattern}"`, { pattern: r.pattern, rule: r.pattern, hosts: v.verdict === "ask" ? v.hosts : undefined });
    r = hit(this.p.allow);
    if (r) return allowV(r.pattern);
    return v;
  }

  inner(argv: Val[], env: Env[], call: Call, cwd: string | null = call.cwd): PartResult {
    if (argv.length === 0) return { verdict: allowV() };
    return this.simple(argv, env, { cwd, stdin: call.stdin, depth: call.depth + 1 });
  }

  builtin(argv: Val[], env: Env[], call: Call): PartResult {
    const a0 = argv[0];
    if (a0.dynamic || a0.brace || (a0.glob && a0.text !== "[" && a0.text !== "[[")) {
      return { verdict: unparseable("the command name is only known when it runs (a variable, substitution or wildcard)") };
    }
    const name = commandName(a0);
    const args = argv.slice(1);
    const secret = this.secretArgs(args, call.cwd);
    let r: PartResult;
    if (name.startsWith("git-") && name.length > 4) r = this.git([staticVal(name.slice(4)), ...args], env, call);
    else r = this.dispatch(name, args, env, call);
    const long = r.verdict.verdict === "allow" && !r.verdict.rule && args.some((a) => !a.dynamic && LONG_FLAG.test(a.text))
      ? askV("long_running", `${name} ${LONG_REASON}`, { pattern: `${name} *` })
      : null;
    return strictest([secret, r, long]);
  }

  /** A path argument that names a secret is refused, whatever the command. */
  secretArgs(args: Val[], cwd: string | null): Verdict | null {
    for (const a of args) {
      if (a.dynamic) continue;
      const candidates = [a.text];
      const eq = a.text.indexOf("=");
      if (eq >= 0) candidates.push(a.text.slice(eq + 1));
      // `curl -d @file`, `-T@file`: the file is read.
      for (const c of [...candidates]) if (c.startsWith("@")) candidates.push(c.slice(1));
      for (const c of candidates) {
        if (!c || c.includes("://") || !(/^[./~]/.test(c) || c.includes("/"))) continue;
        const why = a.glob ? this.globSecret(c, cwd) : (() => {
          const abs = this.abs(c, cwd);
          return abs === null ? null : this.secretOf(abs, safeCanonical(abs) ?? abs);
        })();
        if (why) return denyV(`${c} holds ${why}; a code session never touches it.`, "<a path holding credentials or Rye's data>");
      }
    }
    return null;
  }

  dispatch(name: string, args: Val[], env: Env[], call: Call): PartResult {
    if (name === "git") return this.git(args, env, call);
    if (SHELLS.has(name)) return this.shell(name, args, call);
    if (SYSTEM_DENY[name]) return { verdict: denyV(SYSTEM_DENY[name], "sudo, su, chmod/chown outside the workspace, launchctl, crontab, osascript, security, open") };
    if (API_CLIS.has(name)) return { verdict: denyV(`${name} uses your credentials for an online service; a code session has none and never acts on your accounts.`, "gh, aws, gcloud, kubectl, terraform, vercel, … (API CLIs with credentials)") };
    if (CONTAINER_CLIS.has(name)) return { verdict: denyV(`${name} runs containers outside the sandbox.`, "docker, podman") };
    if (FETCHERS.has(name) || NETWORK_CLIS.has(name)) return this.networkCli(name, args);
    if (INTERPRETERS.test(name) && name !== "bun" && name !== "deno") return this.interpreter(name, args, call);
    if (/^pip[0-9.]*$/.test(name)) return this.pip(name, args);
    switch (name) {
      case "env": return this.env(args, env, call);
      case "command": {
        let k = 0;
        while (k < args.length && /^-[pvV]+$/.test(args[k].text)) {
          if (/[vV]/.test(args[k].text)) return { verdict: allowV() };
          k++;
        }
        return this.inner(args.slice(k), env, call);
      }
      case "builtin": return this.inner(args, env, call);
      case "exec": {
        let k = 0;
        while (k < args.length && /^-[cl]+$|^-a$/.test(args[k].text)) k += args[k].text === "-a" ? 2 : 1;
        return this.inner(args.slice(k), env, call);
      }
      case "nohup":
      case "setsid":
        return strictest([this.inner(args, env, call), askV("long_running", `${name} keeps a process running after the command returns`, { pattern: `${normalizedText([staticVal(name), ...args.slice(0, 3)])} *` })]);
      case "time": return this.inner(skipOptions(args, ["-o", "-f"]), env, call);
      case "nice": return this.inner(skipOptions(args, ["-n"], /^-\d+$/), env, call);
      case "ionice": return this.inner(skipOptions(args, ["-c", "-n", "-p"]), env, call);
      case "stdbuf": return this.inner(skipOptions(args, ["-i", "-o", "-e"]), env, call);
      case "chronic":
      case "unbuffer":
      case "caffeinate":
      case "chrt":
      case "taskset":
        return this.inner(skipOptions(args, ["-w", "-t", "-p"], /^\d+$/), env, call);
      case "arch": return this.inner(skipOptions(args, ["-arch"], /^-(arm64e?|x86_64|i386)$/), env, call);
      case "xcrun": {
        if (args.some((a) => a.text === "-f" || a.text === "--find" || a.text === "--show-sdk-path")) return { verdict: allowV() };
        return this.inner(skipOptions(args, ["-sdk", "--sdk", "--toolchain"]), env, call);
      }
      case "timeout":
      case "gtimeout": {
        const rest = skipOptions(args, ["-s", "-k", "--signal", "--kill-after"]);
        return this.inner(rest.slice(1), env, call);
      }
      case "busybox": return this.inner(args, env, call);
      case "cross-env": {
        let k = 0;
        const extra: Env[] = [];
        while (k < args.length && ASSIGN.test(args[k].text)) {
          extra.push({ name: args[k].text.slice(0, args[k].text.indexOf("=")), value: args[k].dynamic ? null : args[k].text.slice(args[k].text.indexOf("=") + 1) });
          k++;
        }
        return this.inner(args.slice(k), [...env, ...extra], call);
      }
      case "dotenv":
      case "direnv":
      case "mise":
      case "asdf":
      case "rbenv":
      case "pyenv":
      case "nodenv":
      case "conda":
      case "micromamba": {
        const dd = args.findIndex((a) => a.text === "--");
        if (dd >= 0) return this.inner(args.slice(dd + 1), env, call);
        const sub = args[0]?.text;
        if (name === "direnv" && sub === "exec") return this.inner(args.slice(2), env, call);
        if (sub === "exec" || sub === "x" || sub === "run") return this.inner(skipOptions(args.slice(1), ["-n", "--name", "-p", "--prefix", "-e"]), env, call);
        if (name === "mise" || name === "asdf") {
          if (sub === "install" || sub === "use" || sub === "plugin" || sub === "upgrade") return { verdict: askV("install", `${name} ${sub} downloads tools`, { pattern: `${name} ${sub} *` }) };
        }
        return { verdict: allowV() };
      }
      case "xargs": return this.xargs(args, env, call);
      case "find": return this.find(args, call);
      case "watch": return this.watch(args, call);
      case "parallel": return { verdict: unparseable("parallel builds its commands from its input") };
      case "eval": return this.evalCmd(args, call);
      case "source":
      case ".": {
        const s = args[0];
        if (!s) return { verdict: allowV() };
        if (s.dynamic) return { verdict: s.fetches ? curlShDeny() : unparseable(`${name} runs a script only known when it runs`) };
        if (STDIN_PATHS.test(s.text)) return this.shell("sh", [], call);
        return { verdict: allowV() };
      }
      case "trap": {
        const rest = args[0]?.text === "--" ? args.slice(1) : args;
        const action = rest[0];
        if (!action || rest.length < 2 || action.text === "-" || /^-[lp]$/.test(action.text)) return { verdict: allowV() };
        if (action.dynamic) return { verdict: unparseable("trap runs a command only known when it runs") };
        return { verdict: this.nested(action.text, call.cwd, call.depth + 1) };
      }
      case "alias": {
        // An alias may outlive this command; one that names a denied command is refused now.
        const results: Verdict[] = [];
        for (const a of args) {
          const eq = a.text.indexOf("=");
          if (eq <= 0) continue;
          if (a.dynamic) results.push(unparseable("alias sets a value only known when it runs"));
          else if (this.nested(a.text.slice(eq + 1), call.cwd, call.depth + 1).verdict === "deny") results.push(denyV(`alias ${a.text.slice(0, eq)} names a command a code session never runs.`, "git push"));
        }
        return { verdict: strictestVerdict(results) };
      }
      case "rm":
      case "rmdir":
      case "unlink":
      case "shred":
      case "srm":
      case "trash":
        return this.remove(name, args, call);
      case "chmod":
      case "chown":
      case "chgrp":
      case "chflags":
        return this.changeMode(name, args, call);
      case "tee": return this.writeTargets(name, args.filter((a) => a.dynamic || !a.text.startsWith("-")), call);
      case "dd": return this.writeTargets(name, args.filter((a) => a.text.startsWith("of=")).map((a) => ({ ...a, text: a.text.slice(3) })), call);
      case "npm": return this.npm(args, env, call);
      case "pnpm": return this.pnpm(args, env, call);
      case "yarn":
      case "yarnpkg":
        return this.yarn(args, env, call);
      case "bun": return this.bun(args, env, call);
      case "npx":
      case "pnpx":
      case "bunx":
        return this.runPackage(name, args, env, call, NPM_HOSTS);
      case "corepack": {
        const sub = args[0]?.text;
        if (sub === "npm" || sub === "pnpm" || sub === "yarn") return this.inner(args, env, call);
        if (sub === "enable" || sub === "disable" || !sub) return { verdict: allowV() };
        return { verdict: askV("install", `corepack ${sub} downloads package managers`, { hosts: NPM_HOSTS, pattern: `corepack ${sub} *` }) };
      }
      case "deno": return this.deno(args, env, call);
      case "uv": return this.uv(args, env, call);
      case "uvx":
      case "pipx":
        return name === "uvx" || ["install", "run", "upgrade", "upgrade-all", "inject", "reinstall", "reinstall-all"].includes(args[0]?.text ?? "")
          ? { verdict: askV("install", `${name} downloads and runs Python packages`, { hosts: PYPI_HOSTS, pattern: `${name} *` }) }
          : { verdict: allowV() };
      case "twine": return ["upload", "register"].includes(args[0]?.text ?? "") ? { verdict: publishDeny(`twine ${args[0].text}`) } : { verdict: allowV() };
      case "poetry":
      case "pdm":
      case "pipenv":
      case "hatch":
      case "flit":
      case "rye":
        return this.pyProject(name, args, env, call);
      case "gem": return this.simpleManager(name, args, { install: ["install", "update", "fetch"], deny: ["push", "yank", "owner", "signin", "signout"], hosts: GEM_HOSTS });
      case "bundle":
      case "bundler": {
        if (args[0]?.text === "exec") return this.inner(args.slice(1), env, call);
        return this.simpleManager(name, args, { install: ["install", "update", "add", "lock", "outdated", "binstubs"], deny: [], hosts: GEM_HOSTS, bare: true });
      }
      case "cargo": return this.cargo(args, env, call);
      case "rustup": return ["install", "update", "toolchain", "target", "component", "self"].includes(args[0]?.text ?? "") ? { verdict: askV("install", `rustup ${args[0].text} downloads toolchains`, { hosts: ["static.rust-lang.org"], pattern: `rustup ${args[0].text} *` }) } : { verdict: allowV() };
      case "go": {
        const sub = args[0]?.text;
        if (sub === "get" || sub === "install" || (sub === "mod" && ["download", "tidy", "vendor"].includes(args[1]?.text ?? ""))) {
          const what = sub === "mod" ? `go mod ${args[1].text}` : `go ${sub}`;
          return { verdict: askV("install", `${what} downloads modules from ${GO_HOSTS.join(", ")}`, { hosts: GO_HOSTS, pattern: `${what} *` }) };
        }
        return { verdict: allowV() };
      }
      case "brew": return this.simpleManager(name, args, { install: ["install", "upgrade", "reinstall", "tap", "update", "fetch", "bundle"], deny: [], hosts: BREW_HOSTS });
      case "apt":
      case "apt-get":
      case "dnf":
      case "yum":
      case "apk":
      case "pacman":
      case "zypper":
      case "port":
        return this.simpleManager(name, args, { install: ["install", "upgrade", "update", "add", "dist-upgrade", "-S", "-Syu"], deny: [], hosts: [] });
      case "composer": return this.simpleManager(name, args, { install: ["install", "require", "update", "create-project", "global"], deny: [], hosts: ["repo.packagist.org"] });
      case "pod": {
        if (args[0]?.text === "trunk" && args[1]?.text === "push") return { verdict: publishDeny("pod trunk push") };
        return this.simpleManager(name, args, { install: ["install", "update", "repo"], deny: [], hosts: ["cdn.cocoapods.org"] });
      }
      case "dotnet": {
        const [a, b] = [args[0]?.text, args[1]?.text];
        if (a === "nuget" && b === "push") return { verdict: publishDeny("dotnet nuget push") };
        if ((a === "add" && b === "package") || a === "restore" || (a === "tool" && b === "install")) return { verdict: askV("install", `dotnet ${a} downloads packages`, { hosts: ["api.nuget.org"], pattern: `dotnet ${a} *` }) };
        return { verdict: allowV() };
      }
      case "nuget": return args[0]?.text?.toLowerCase() === "push" ? { verdict: publishDeny("nuget push") } : { verdict: allowV() };
      case "mvn":
      case "mvnw":
        return args.some((a) => a.text === "deploy" || /^release:(perform|prepare)$/.test(a.text) || a.text.endsWith(":deploy")) ? { verdict: publishDeny(`${name} deploy`) } : { verdict: allowV() };
      case "gradle":
      case "gradlew":
        return args.some((a) => /(^|:)(publish\w*|uploadArchives)$/i.test(a.text)) ? { verdict: publishDeny(`${name} publish`) } : { verdict: allowV() };
      case "lerna": return ["publish", "version"].includes(args[0]?.text ?? "") ? { verdict: publishDeny(`lerna ${args[0].text}`) } : { verdict: allowV() };
      case "changeset":
      case "changesets":
        return args[0]?.text === "publish" ? { verdict: publishDeny("changeset publish") } : { verdict: allowV() };
      case "vsce":
      case "ovsx":
      case "jsr":
        return args[0]?.text === "publish" ? { verdict: publishDeny(`${name} publish`) } : { verdict: allowV() };
      case "semantic-release":
      case "release-it":
      case "np":
        return { verdict: publishDeny(name) };
      case "mix": return args[0]?.text === "hex.publish" ? { verdict: publishDeny("mix hex.publish") } : args[0]?.text === "deps.get" ? { verdict: askV("install", "mix deps.get downloads packages", { hosts: ["hex.pm", "repo.hex.pm"], pattern: "mix deps.get *" }) } : { verdict: allowV() };
      case "swift": return args[0]?.text === "package" && ["resolve", "update"].includes(args[1]?.text ?? "") ? { verdict: askV("install", `swift package ${args[1].text} downloads packages`, { pattern: `swift package ${args[1].text} *` }) } : { verdict: allowV() };
      case "rsync": {
        const remote = args.find((a) => !a.dynamic && !a.text.startsWith("-") && (/^[^/]*:/.test(a.text) || a.text.startsWith("rsync://")));
        return remote ? this.networkCli(name, args) : { verdict: allowV() };
      }
      case "openssl": return args[0]?.text === "s_client" ? this.networkCli("openssl s_client", args) : { verdict: allowV() };
      default: return this.longRunning(name, args);
    }
  }

  // ------------------------------------------------------------ wrappers and shells

  env(args: Val[], env: Env[], call: Call): PartResult {
    let k = 0;
    let cwd = call.cwd;
    while (k < args.length) {
      const a = args[k];
      if (a.dynamic) return { verdict: unparseable("env has options only known when it runs") };
      const t = a.text;
      if (t === "--") {
        k++;
        break;
      }
      if (["-i", "-", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(t)) {
        k++;
        continue;
      }
      if (t === "-u" || t === "--unset" || t === "-P") {
        k += 2;
        continue;
      }
      if (t.startsWith("--unset=") || /^-u./.test(t)) {
        k++;
        continue;
      }
      if (t === "-C" || t === "--chdir" || t.startsWith("--chdir=")) {
        const d = t.startsWith("--chdir=") ? staticVal(t.slice(8)) : args[k + 1];
        cwd = !d || d.dynamic ? null : this.abs(d.text, cwd);
        k += t.startsWith("--chdir=") ? 1 : 2;
        continue;
      }
      if (t.startsWith("-S") || t.startsWith("--split-string")) return { verdict: unparseable("env -S splits a string into a command") };
      if (t.startsWith("-")) return { verdict: unparseable(`env ${t} isn't an option Rye knows`) };
      break;
    }
    const extra: Env[] = [];
    while (k < args.length && ASSIGN.test(args[k].raw)) {
      const t = args[k].text;
      const eq = t.indexOf("=");
      extra.push({ name: t.slice(0, eq), value: args[k].dynamic ? null : t.slice(eq + 1) });
      k++;
    }
    if (k >= args.length) return { verdict: allowV() };
    return this.inner(args.slice(k), [...env, ...extra], call, cwd);
  }

  shell(name: string, args: Val[], call: Call): PartResult {
    let k = 0;
    let hasC = false;
    let readsStdin = false;
    while (k < args.length) {
      const a = args[k];
      if (a.dynamic) return { verdict: a.fetches ? curlShDeny() : unparseable(`${name} has options only known when it runs`) };
      const t = a.text;
      if (t === "--" || t === "-") {
        if (t === "-") readsStdin = true;
        k++;
        break;
      }
      if (t.startsWith("--")) {
        k += t === "--rcfile" || t === "--init-file" ? 2 : 1;
        continue;
      }
      if (/^[-+][A-Za-z]+$/.test(t)) {
        if (t[0] === "-" && t.includes("c")) hasC = true;
        if (t[0] === "-" && t.includes("s")) readsStdin = true;
        k += /[oO]/.test(t.slice(1)) ? 2 : 1;
        continue;
      }
      break;
    }
    if (hasC) {
      const s = args[k];
      if (!s) return { verdict: unparseable(`${name} -c has no command`) };
      if (s.dynamic) return { verdict: s.fetches ? curlShDeny() : unparseable(`${name} -c runs a command string only known when it runs`) };
      const inner = this.nested(s.text, call.cwd, call.depth + 1);
      if (inner.verdict === "deny") return { verdict: inner };
      return { verdict: unparseable(`${name} -c runs a command string; it needs your approval`) };
    }
    const script = args[k];
    if (!script || readsStdin || (!script.dynamic && STDIN_PATHS.test(script.text))) {
      if (call.stdin.text !== undefined) {
        const inner = this.nested(call.stdin.text, call.cwd, call.depth + 1);
        if (inner.verdict === "deny") return { verdict: inner, runsStdin: true };
        return { verdict: unparseable(`${name} runs the script given on its input; it needs your approval`), runsStdin: true };
      }
      if (call.stdin.file) return { verdict: allowV(), runsStdin: true };
      return { verdict: unparseable(`${name} runs a script read from its input`), runsStdin: true };
    }
    if (script.dynamic) return { verdict: script.fetches ? curlShDeny() : unparseable(`${name} runs a script only known when it runs`) };
    return { verdict: allowV() };
  }

  evalCmd(args: Val[], call: Call): PartResult {
    if (args.length === 0) return { verdict: allowV() };
    const dyn = args.find((a) => a.dynamic);
    if (dyn) return { verdict: dyn.fetches ? curlShDeny() : unparseable("eval runs a command only known when it runs") };
    const inner = this.nested(args.map((a) => a.text).join(" "), call.cwd, call.depth + 1);
    if (inner.verdict === "deny") return { verdict: inner };
    return { verdict: unparseable("eval runs a command string; it needs your approval") };
  }

  interpreter(name: string, args: Val[], call: Call): PartResult {
    const lower = name.toLowerCase();
    const isPython = /^(python|pypy)/.test(lower);
    // Options that take the program itself, so nothing is read from input.
    const codeFlags = isPython ? ["-c"] : /^(node|nodejs)$/.test(lower) ? ["-e", "--eval", "-p", "--print"] : ["-e", "-E", "-r"];
    const valueFlags = isPython ? ["-W", "-X", "-Q"] : ["-r", "--require", "--import", "--loader", "-I", "--input-type", "--env-file"];
    let k = 0;
    while (k < args.length) {
      const a = args[k];
      if (a.dynamic) return { verdict: allowV() };
      const t = a.text;
      if (t === "-") return { verdict: allowV(), runsStdin: true };
      if (codeFlags.includes(t)) return { verdict: allowV() };
      if (isPython && t === "-m") return this.pythonModule(args.slice(k + 1), call);
      if (isPython && /^-m./.test(t)) return this.pythonModule([staticVal(t.slice(2)), ...args.slice(k + 1)], call);
      if (!t.startsWith("-")) break;
      k += valueFlags.includes(t) ? 2 : 1;
    }
    const script = args[k];
    if (!script) return { verdict: allowV(), runsStdin: true };
    const base = basename(script.text);
    const rest = args.slice(k + 1).map((a) => a.text);
    if (isPython && base === "setup.py" && rest.some((r) => r === "upload" || r === "register")) return { verdict: publishDeny("setup.py upload") };
    if (isPython && base === "manage.py" && rest[0] === "runserver") return { verdict: askV("long_running", `manage.py runserver ${LONG_REASON}`, { pattern: `${name} manage.py runserver *` }) };
    if (/^(php)/.test(lower) && args.some((a) => a.text === "-S")) return { verdict: askV("long_running", `php -S ${LONG_REASON}`, { pattern: `${name} -S *` }) };
    return { verdict: allowV() };
  }

  pythonModule(args: Val[], call: Call): PartResult {
    const mod = args[0]?.text ?? "";
    const rest = args.slice(1);
    if (mod === "pip" || mod === "pip3") return this.pip("python -m pip", rest);
    if (mod === "twine") return ["upload", "register"].includes(rest[0]?.text ?? "") ? { verdict: publishDeny("twine upload") } : { verdict: allowV() };
    if (["http.server", "SimpleHTTPServer", "uvicorn", "gunicorn", "hypercorn", "flask", "django", "streamlit", "jupyter", "notebook"].includes(mod)) {
      if (mod === "flask" && rest[0]?.text !== "run") return { verdict: allowV() };
      if (mod === "django" && rest[0]?.text !== "runserver") return { verdict: allowV() };
      return { verdict: askV("long_running", `python -m ${mod} ${LONG_REASON}`, { pattern: `python -m ${mod} *` }) };
    }
    void call;
    return { verdict: allowV() };
  }

  xargs(args: Val[], env: Env[], call: Call): PartResult {
    let k = 0;
    let replace: string | null = null;
    const valueOpts = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "-R", "-S"]);
    while (k < args.length) {
      const a = args[k];
      if (a.dynamic) return { verdict: unparseable("xargs has options only known when it runs") };
      const t = a.text;
      if (t === "--") {
        k++;
        break;
      }
      if (!t.startsWith("-")) break;
      if (t === "-I") replace = args[k + 1]?.text ?? "{}";
      else if (/^-I./.test(t)) replace = t.slice(2);
      else if (/^-i/.test(t) || t.startsWith("--replace")) replace = t.includes("=") ? t.slice(t.indexOf("=") + 1) : t.length > 2 && !t.startsWith("--") ? t.slice(2) : "{}";
      k += valueOpts.has(t) ? 2 : 1;
    }
    const cmd = args.slice(k);
    if (cmd.length === 0) return { verdict: allowV() };
    const argv = replace !== null
      ? cmd.map((a) => (a.text.includes(replace!) ? FROM_INPUT : a))
      : [...cmd, FROM_INPUT];
    if (commandName(cmd[0]) === "git") {
      const sub = argv[1];
      if (!sub || sub.dynamic) return strictest([this.inner(argv, env, call), unparseable("xargs runs git with arguments from its input")]);
    }
    return this.inner(argv, env, call);
  }

  find(args: Val[], call: Call): PartResult {
    let k = 0;
    while (k < args.length && /^-[HLPEXdsx]$/.test(args[k].text)) k++;
    const starts: Val[] = [];
    while (k < args.length && !/^[-(!)]/.test(args[k].text)) starts.push(args[k++]);
    if (starts.length === 0) starts.push(staticVal("."));
    const results: (PartResult | Verdict)[] = [];
    for (let i = k; i < args.length; i++) {
      const t = args[i].text;
      if (t === "-delete") {
        for (const s of starts) results.push(this.removalTarget("find -delete", { ...s, text: s.text.endsWith("/") ? s.text : `${s.text}/` }, call.cwd) ?? allowV());
      } else if (["-exec", "-execdir", "-ok", "-okdir"].includes(t)) {
        let j = i + 1;
        while (j < args.length && args[j].text !== ";" && args[j].text !== "+") j++;
        const inner = args.slice(i + 1, j);
        if (inner.length === 0) return { verdict: unparseable(`find ${t} has no command`) };
        for (const s of starts) {
          const found: Val = s.dynamic ? FROM_INPUT : staticVal(join(s.text, "…found"));
          results.push(this.inner(inner.map((a) => (!a.dynamic && a.text.includes("{}") ? (s.dynamic ? FROM_INPUT : staticVal(a.text.split("{}").join(found.text))) : a)), [], call));
        }
        i = j;
      }
    }
    return strictest(results);
  }

  watch(args: Val[], call: Call): PartResult {
    let k = 0;
    let exec = false;
    while (k < args.length && args[k].text.startsWith("-")) {
      const t = args[k].text;
      if (t === "-x" || t === "--exec") exec = true;
      k += t === "-n" || t === "--interval" ? 2 : 1;
    }
    const cmd = args.slice(k);
    const long = askV("long_running", `watch ${LONG_REASON}`, { pattern: `watch *` });
    if (cmd.length === 0) return { verdict: allowV() };
    if (exec) return strictest([this.inner(cmd, [], call), long]);
    if (cmd.some((a) => a.dynamic)) return { verdict: unparseable("watch runs a command only known when it runs") };
    return strictest([this.nested(cmd.map((a) => a.text).join(" "), call.cwd, call.depth + 1), long]);
  }

  // ------------------------------------------------------------ files

  /** Why removing `v` is refused or asked, or null when it is inside the workspace. */
  removalTarget(what: string, v: Val, cwd: string | null): Verdict | null {
    if (v.dynamic) return unparseable(`${what} has a target only known when it runs`);
    let text = v.text;
    let follow = text.endsWith("/") || /(^|\/)\.\.?$/.test(text);
    if (v.glob || v.brace) {
      // A wildcard: everything it can match is under the directory before it.
      const idx = text.search(/[*?[{]/);
      text = text.slice(0, text.lastIndexOf("/", idx) + 1) || ".";
      follow = true;
    }
    const abs = this.abs(text, cwd);
    if (abs === null) return unparseable(`${what} ${v.raw} is relative to a directory Rye can't work out`);
    const real = follow ? safeCanonical(abs) : (() => {
      const parent = safeCanonical(dirname(abs));
      return parent === null ? null : join(parent, basename(abs));
    })();
    if (real === null) return unparseable(`${what} ${v.raw} goes through too many symbolic links`);
    const secret = this.secretReason(real);
    if (secret) return denyV(`${what} ${v.raw} would delete ${secret}.`, "rm|rmdir|unlink <outside the workspace>");
    if (!this.insideWrite(real)) return denyV(`${what} ${v.raw} would delete ${real}, outside the workspace; only repo/, tmp/ and cache/ may be changed.`, "rm|rmdir|unlink <outside the workspace>");
    return null;
  }

  remove(name: string, args: Val[], call: Call): PartResult {
    const results: Verdict[] = [];
    let options = true;
    for (const a of args) {
      if (options && !a.dynamic && a.text === "--") {
        options = false;
        continue;
      }
      if (options && !a.dynamic && a.text.startsWith("-") && a.text !== "-") continue;
      const v = this.removalTarget(name, a, call.cwd);
      if (v) results.push(v);
    }
    return { verdict: strictestVerdict(results) };
  }

  changeMode(name: string, args: Val[], call: Call): PartResult {
    const rest: Val[] = [];
    let reference = false;
    let options = true;
    for (const a of args) {
      if (options && !a.dynamic) {
        if (a.text === "--") {
          options = false;
          continue;
        }
        if (/^-[RfvchHLPENCiI]+$/.test(a.text) || /^--(recursive|verbose|changes|silent|quiet|no-dereference|dereference|preserve-root|no-preserve-root)$/.test(a.text)) continue;
        if (a.text.startsWith("--reference=")) {
          reference = true;
          continue;
        }
      }
      rest.push(a);
    }
    const targets = reference ? rest : rest.slice(1);
    const results: Verdict[] = [];
    for (const t of targets) {
      if (t.dynamic) {
        results.push(unparseable(`${name} has a target only known when it runs`));
        continue;
      }
      const abs = this.abs(t.glob ? t.text.slice(0, t.text.lastIndexOf("/", t.text.search(/[*?[]/)) + 1) || "." : t.text, call.cwd);
      if (abs === null) {
        results.push(unparseable(`${name} ${t.raw} is relative to a directory Rye can't work out`));
        continue;
      }
      const real = safeCanonical(abs) ?? abs;
      if (!this.insideWrite(real)) results.push(denyV(`${name} ${t.raw} changes ${real}, outside the workspace.`, "sudo, su, chmod/chown outside the workspace, launchctl, crontab, osascript, security, open"));
    }
    return { verdict: strictestVerdict(results) };
  }

  writeTargets(name: string, targets: Val[], call: Call): PartResult {
    const results: Verdict[] = [];
    for (const t of targets) {
      if (t.dynamic || t.glob || /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(t.text)) continue;
      const abs = this.abs(t.text, call.cwd);
      if (abs === null) continue;
      const real = safeCanonical(abs) ?? abs;
      if (!this.insideWrite(real)) results.push(denyV(`${name} writes ${t.raw} (${real}), outside the workspace.`, "rm|rmdir|unlink <outside the workspace>"));
    }
    return { verdict: strictestVerdict(results) };
  }

  // ------------------------------------------------------------ network

  networkCli(name: string, args: Val[]): PartResult {
    const hosts = hostsIn(args, FETCHERS.has(name) || name === "ssh" || name === "scp" || name === "sftp" || name === "mosh");
    const pattern = normalizedText([staticVal(name), ...args]);
    return { verdict: this.network(`${name} uses the network`, hosts, pattern), fetches: FETCHERS.has(name) };
  }

  network(what: string, hosts: string[], pattern?: string): Verdict {
    const local = hosts.filter(isLocalHost);
    if (local.length) {
      return denyV(`${what} (${local.join(", ")}): this machine and private networks are off limits to code sessions (Rye's own API runs there).`, LOCAL_NETWORK_RULE);
    }
    if (hosts.length && hosts.every((h) => hostAllowed(h, this.p.allowedDomains))) return allowV("allowed_domains");
    return askV("network", `${what}${hosts.length ? ` (${hosts.join(", ")})` : ""}`, { hosts, pattern });
  }

  install(what: string, hosts: string[], pattern?: string, reason?: string): Verdict {
    if (hosts.length && hosts.every((h) => hostAllowed(h, this.p.allowedDomains))) return allowV("allowed_domains");
    const from = hosts.length ? ` from ${hosts.join(", ")}` : "";
    return askV("install", reason ? `${reason}${from}` : `${what} installs packages${from}; dependency scripts may run in the sandbox`, { hosts, pattern });
  }

  longRunning(name: string, args: Val[]): PartResult {
    const positional = args.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
    const sub = positional[0];
    const long = (what = name) => ({ verdict: askV("long_running", `${what} ${LONG_REASON}`, { pattern: `${what} *` }) });
    const servers = SERVER_SUBCOMMANDS[name];
    if (servers) {
      if (name === "turbo" && sub === "run") return LONG_SCRIPT.test(positional[1] ?? "") ? long(`turbo run ${positional[1]}`) : { verdict: allowV() };
      return sub && servers.includes(sub) ? long(`${name} ${sub}`) : { verdict: allowV() };
    }
    switch (name) {
      case "vite":
      case "parcel":
        return sub === "build" || sub === "optimize" ? { verdict: allowV() } : long(sub ? `${name} ${sub}` : name);
      case "vitest":
        return sub === "run" || sub === "bench" || args.some((a) => a.text === "--run") ? { verdict: allowV() } : long(name);
      case "jest":
        return args.some((a) => a.text === "--watch" || a.text === "--watchAll") ? long(name) : { verdict: allowV() };
      case "tsc":
      case "rollup":
      case "tsup":
      case "esbuild":
        return args.some((a) => a.text === "-w" || a.text === "--watch" || a.text === "--serve" || a.text.startsWith("--serve=")) ? long(name) : { verdict: allowV() };
      case "tsx":
        return sub === "watch" ? long("tsx watch") : { verdict: allowV() };
      case "tail":
        return args.some((a) => /^-[a-zA-Z]*[fF]/.test(a.text) || a.text === "--follow" || a.text.startsWith("--follow=")) ? long("tail -f") : { verdict: allowV() };
      case "nodemon":
      case "ts-node-dev":
      case "webpack-dev-server":
      case "http-server":
      case "live-server":
      case "serve":
      case "json-server":
      case "uvicorn":
      case "gunicorn":
      case "hypercorn":
      case "puma":
      case "watchexec":
      case "entr":
      case "top":
      case "htop":
      case "btop":
      case "concurrently":
      case "start-storybook":
      case "caddy":
      case "nginx":
      case "redis-server":
      case "postgres":
      case "mongod":
      case "mysqld":
      case "air":
        return long(name);
      default:
        return { verdict: allowV() };
    }
  }

  // ------------------------------------------------------------ package managers

  simpleManager(name: string, args: Val[], o: { install: string[]; deny: string[]; hosts: string[]; bare?: boolean }): PartResult {
    const sub = args.find((a) => !a.text.startsWith("-") || o.install.includes(a.text));
    if (!sub) return { verdict: o.bare ? this.install(name, o.hosts, `${name} *`) : allowV() };
    if (sub.dynamic) return { verdict: unparseable(`${name} has a subcommand only known when it runs`) };
    if (o.deny.includes(sub.text)) return { verdict: o.deny.includes("push") && sub.text === "push" ? publishDeny(`${name} push`) : accountDeny(`${name} ${sub.text}`) };
    if (o.install.includes(sub.text)) return { verdict: this.install(`${name} ${sub.text}`, o.hosts, `${name} ${sub.text} *`) };
    return { verdict: allowV() };
  }

  pip(what: string, args: Val[]): PartResult {
    const sub = args.find((a) => !a.text.startsWith("-"))?.text;
    if (sub === "install" || sub === "download" || sub === "wheel") return { verdict: this.install(`${what} ${sub}`, PYPI_HOSTS, `${what} ${sub} *`) };
    if (sub === "search" || sub === "index") return { verdict: this.network(`${what} ${sub} uses the network`, PYPI_HOSTS, `${what} ${sub} *`) };
    return { verdict: allowV() };
  }

  runPackage(name: string, args: Val[], env: Env[], call: Call, hosts: string[]): PartResult {
    const rest = skipOptions(args, ["-p", "--package", "-c", "--call"]);
    const pkg = rest[0];
    const what = `${name}${pkg ? ` ${pkg.raw}` : ""}`;
    const ask = this.install(what, hosts, pkg && !pkg.dynamic ? `${name} ${pkg.text} *` : undefined, `${what} may download a package and run it`);
    if (!pkg) return { verdict: ask };
    // The package's own command: `npx npm publish` is still a publish.
    const pkgName = pkg.dynamic ? pkg : staticVal(pkg.text.replace(/^(@[^/]+\/)?([^@]+)(@.*)?$/, "$2"));
    return strictest([this.inner([pkgName, ...rest.slice(1)], env, call), ask]);
  }

  /** The shared shape of npm, pnpm, yarn and bun. */
  jsManager(
    name: string,
    args: Val[],
    env: Env[],
    call: Call,
    o: {
      valueOpts: string[];
      install: string[];
      network: string[];
      deny: string[];
      run: string[];
      exec: string[];
      builtins: string[];
      hosts: string[];
      scriptFallback: boolean;
      bareInstall?: boolean;
    },
  ): PartResult {
    let k = 0;
    while (k < args.length) {
      const a = args[k];
      if (a.dynamic) return { verdict: unparseable(`${name} has arguments only known when it runs`) };
      if (!a.text.startsWith("-")) break;
      k += o.valueOpts.includes(a.text) ? 2 : 1;
    }
    const subVal = args[k];
    if (!subVal) return { verdict: o.bareInstall ? this.install(name, o.hosts, `${name} *`) : allowV() };
    const sub = subVal.text;
    const rest = args.slice(k + 1);
    const positional = rest.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
    if (o.deny.includes(sub)) return { verdict: sub === "publish" || sub === "unpublish" ? publishDeny(`${name} ${sub}`) : accountDeny(`${name} ${sub}`) };
    if (!o.run.includes(sub) && positional.includes("publish")) return { verdict: publishDeny(`${name} … publish`) };
    if (o.install.includes(sub)) return { verdict: this.install(`${name} ${sub}`, o.hosts, `${name} ${sub} *`) };
    if (o.network.includes(sub)) return { verdict: this.network(`${name} ${sub} uses the network`, o.hosts, `${name} ${sub} *`) };
    if (o.exec.includes(sub)) return this.runPackage(`${name} ${sub}`, rest, env, call, o.hosts);
    if (o.run.includes(sub)) {
      const script = skipOptions(rest, ["--cwd", "--filter", "-F", "--workspace", "-w", "--prefix", "--shell"]).at(0);
      if (!script) return { verdict: allowV() };
      if (script.dynamic) return { verdict: unparseable(`${name} ${sub} runs a script only known when it runs`) };
      if (LONG_SCRIPT.test(script.text)) return { verdict: askV("long_running", `${name} ${sub} ${script.text} ${LONG_REASON}`, { pattern: `${name} ${sub} ${script.text} *` }) };
      return { verdict: allowV() };
    }
    if (["start", "restart", "dev", "serve"].includes(sub) || (o.scriptFallback && !o.builtins.includes(sub) && LONG_SCRIPT.test(sub))) {
      return { verdict: askV("long_running", `${name} ${sub} ${LONG_REASON}`, { pattern: `${name} ${sub} *` }) };
    }
    return { verdict: allowV() };
  }

  npm(args: Val[], env: Env[], call: Call): PartResult {
    const sub = firstPositional(args, NPM_VALUE_OPTS);
    if ((sub === "init" || sub === "create") && args.filter((a) => !a.text.startsWith("-")).length > 1) {
      return { verdict: this.install(`npm ${sub}`, NPM_HOSTS, `npm ${sub} *`) };
    }
    return this.jsManager("npm", args, env, call, {
      valueOpts: NPM_VALUE_OPTS,
      install: ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean", "isntall-clean", "install-test", "it", "install-ci-test", "cit", "update", "up", "upgrade", "udpate", "link", "ln", "dedupe", "ddp"],
      network: ["audit", "outdated", "view", "v", "info", "show", "search", "s", "se", "find", "ping", "doctor", "repo", "docs", "home", "bugs", "issues", "whoami"],
      deny: ["publish", "unpublish", "deprecate", "undeprecate", "dist-tag", "dist-tags", "owner", "author", "access", "team", "token", "adduser", "add-user", "login", "logout", "star", "unstar", "hook", "org", "profile", "trust"],
      run: ["run", "run-script", "rum", "urn", "rr"],
      exec: ["exec", "x"],
      builtins: [],
      hosts: NPM_HOSTS,
      scriptFallback: false,
    });
  }

  pnpm(args: Val[], env: Env[], call: Call): PartResult {
    const k = args.findIndex((a) => !a.text.startsWith("-"));
    if (k >= 0 && args[k].text === "exec") return this.inner(args.slice(k + 1), env, call);
    return this.jsManager("pnpm", args, env, call, {
      valueOpts: ["--filter", "-F", "--dir", "-C", "--workspace-dir", "--reporter", "--loglevel", "--registry"],
      install: ["install", "i", "add", "update", "up", "upgrade", "fetch", "import", "link", "ln", "install-test", "it", "create", "self-update", "setup", "env", "deploy", "patch"],
      network: ["audit", "outdated", "view", "info", "search", "whoami"],
      deny: ["publish", "login", "logout", "adduser"],
      run: ["run", "run-script"],
      exec: ["dlx"],
      builtins: ["add", "audit", "bin", "config", "create", "dedupe", "deploy", "dlx", "env", "exec", "fetch", "import", "init", "install", "install-test", "it", "i", "licenses", "link", "list", "ls", "outdated", "pack", "patch", "patch-commit", "patch-remove", "prune", "publish", "rebuild", "remove", "rm", "root", "run", "server", "setup", "start", "store", "test", "t", "unlink", "update", "up", "upgrade", "why", "help"],
      hosts: NPM_HOSTS,
      scriptFallback: true,
    });
  }

  yarn(args: Val[], env: Env[], call: Call): PartResult {
    const k = args.findIndex((a) => !a.text.startsWith("-"));
    const sub = k >= 0 ? args[k].text : undefined;
    if (sub === "workspace" && args[k + 2]) return this.yarn(args.slice(k + 2), env, call);
    if (sub === "exec") return this.evalCmd(args.slice(k + 1), call);
    if (sub === "npm") {
      const s = args[k + 1]?.text;
      if (s === "publish") return { verdict: publishDeny("yarn npm publish") };
      if (s === "login" || s === "logout" || s === "tag") return { verdict: accountDeny(`yarn npm ${s}`) };
      return { verdict: this.network(`yarn npm ${s ?? ""} uses the network`.replace("  ", " "), YARN_HOSTS, `yarn npm ${s ?? ""} *`) };
    }
    return this.jsManager("yarn", args, env, call, {
      valueOpts: ["--cwd", "--modules-folder", "--cache-folder", "--registry", "--mutex", "--network-timeout"],
      install: ["install", "add", "upgrade", "up", "upgrade-interactive", "create", "global", "import", "link", "set", "plugin"],
      network: ["audit", "outdated", "info", "npm"],
      deny: ["publish", "login", "logout", "owner", "tag", "team"],
      run: ["run"],
      exec: ["dlx"],
      builtins: ["add", "audit", "autoclean", "bin", "cache", "check", "config", "create", "dedupe", "dlx", "exec", "explain", "generate-lock-entry", "global", "help", "import", "info", "init", "install", "licenses", "link", "list", "login", "logout", "node", "npm", "outdated", "owner", "pack", "patch", "plugin", "policies", "publish", "rebuild", "remove", "run", "set", "tag", "team", "test", "unlink", "unplug", "up", "upgrade", "upgrade-interactive", "version", "versions", "why", "workspace", "workspaces"],
      hosts: YARN_HOSTS,
      scriptFallback: true,
      bareInstall: true,
    });
  }

  bun(args: Val[], env: Env[], call: Call): PartResult {
    let k = 0;
    const valueOpts = ["--cwd", "--config", "-c", "--env-file", "--preload", "-r", "--filter", "-F", "--tsconfig-override", "--define", "-d", "--loader", "-l", "--port", "--elide-lines", "--shell", "--install", "--main-fields", "--conditions"];
    while (k < args.length && !args[k].dynamic && args[k].text.startsWith("-")) {
      const t = args[k].text;
      if (t === "-e" || t === "--eval" || t === "-p" || t === "--print") return { verdict: allowV() };
      k += valueOpts.includes(t) ? 2 : 1;
    }
    const sub = args[k];
    if (sub && !sub.dynamic) {
      if (sub.text === "exec") return this.evalCmd(args.slice(k + 1), call);
      if (sub.text === "pm") {
        const p = args[k + 1]?.text;
        if (p === "trust" || p === "untrusted") return { verdict: this.install("bun pm trust", NPM_HOSTS, "bun pm trust *", "bun pm trust runs dependency lifecycle scripts and may fetch packages") };
        if (p === "view" || p === "whoami") return { verdict: this.network(`bun pm ${p} uses the network`, NPM_HOSTS, `bun pm ${p} *`) };
        return { verdict: allowV() };
      }
      if (sub.text === "init" && args.slice(k + 1).some((a) => !a.text.startsWith("-"))) return { verdict: this.install("bun init <template>", NPM_HOSTS, "bun init *") };
      // `bun file.ts`, `bun ./script`: runs a file.
      if (/[./]/.test(sub.text) && !/^(run|test|x|build)$/.test(sub.text)) return { verdict: allowV() };
    }
    return this.jsManager("bun", args, env, call, {
      valueOpts,
      install: ["install", "i", "add", "a", "update", "link", "create", "c", "upgrade", "patch"],
      network: ["outdated", "audit", "info"],
      deny: ["publish"],
      run: ["run"],
      exec: ["x"],
      builtins: ["run", "test", "x", "repl", "exec", "install", "i", "add", "a", "remove", "rm", "update", "outdated", "link", "unlink", "publish", "patch", "patch-commit", "pm", "info", "audit", "why", "build", "init", "create", "c", "upgrade", "help", "completions"],
      hosts: NPM_HOSTS,
      scriptFallback: true,
    });
  }

  deno(args: Val[], env: Env[], call: Call): PartResult {
    const sub = args[0]?.text;
    if (sub === "publish") return { verdict: publishDeny("deno publish") };
    if (sub === "install" || sub === "add" || sub === "cache" || sub === "outdated" || sub === "upgrade") return { verdict: this.install(`deno ${sub}`, ["jsr.io", "registry.npmjs.org", "deno.land"], `deno ${sub} *`) };
    if (sub === "serve" || (sub === "task" && LONG_SCRIPT.test(args[1]?.text ?? ""))) return { verdict: askV("long_running", `deno ${sub} ${LONG_REASON}`, { pattern: `deno ${sub} *` }) };
    void env;
    void call;
    return { verdict: allowV() };
  }

  uv(args: Val[], env: Env[], call: Call): PartResult {
    const sub = args[0]?.text;
    const second = args[1]?.text;
    if (sub === "publish") return { verdict: publishDeny("uv publish") };
    if (sub === "run") {
      const rest = skipOptions(args.slice(1), ["--with", "-w", "--python", "-p", "--directory", "--project", "--package", "--env-file", "--extra", "--group", "--index", "--index-url"]);
      const inner = this.inner(rest, env, call);
      return args.some((a) => a.text === "--with" || a.text === "-w" || a.text.startsWith("--with=")) ? strictest([inner, this.install("uv run --with", PYPI_HOSTS, "uv run *")]) : inner;
    }
    if (["add", "sync", "lock", "remove", "venv"].includes(sub ?? "") || (sub === "pip" && ["install", "sync", "compile"].includes(second ?? "")) || (sub === "tool" && ["install", "run", "upgrade"].includes(second ?? "")) || (sub === "python" && second === "install")) {
      const what = sub === "pip" || sub === "tool" || sub === "python" ? `uv ${sub} ${second}` : `uv ${sub}`;
      return { verdict: this.install(what, PYPI_HOSTS, `${what} *`) };
    }
    return { verdict: allowV() };
  }

  pyProject(name: string, args: Val[], env: Env[], call: Call): PartResult {
    const sub = args[0]?.text;
    if (sub === "publish") return { verdict: publishDeny(`${name} publish`) };
    if (sub === "run") return name === "pdm" || name === "rye" ? { verdict: allowV() } : this.inner(skipOptions(args.slice(1), []), env, call);
    if (["install", "add", "update", "lock", "sync", "remove", "self", "uninstall"].includes(sub ?? "")) return { verdict: this.install(`${name} ${sub}`, PYPI_HOSTS, `${name} ${sub} *`) };
    return { verdict: allowV() };
  }

  cargo(args: Val[], env: Env[], call: Call): PartResult {
    const rest = args[0]?.text.startsWith("+") ? args.slice(1) : args;
    const sub = rest.find((a) => !a.text.startsWith("-"))?.text;
    if (sub === "publish") return { verdict: publishDeny("cargo publish") };
    if (["login", "logout", "owner", "yank"].includes(sub ?? "")) return { verdict: accountDeny(`cargo ${sub}`) };
    if (["install", "fetch", "add", "update", "vendor", "generate-lockfile"].includes(sub ?? "")) return { verdict: this.install(`cargo ${sub}`, CRATES_HOSTS, `cargo ${sub} *`) };
    if (sub === "search" || sub === "info") return { verdict: this.network(`cargo ${sub} uses the network`, CRATES_HOSTS, `cargo ${sub} *`) };
    if (sub === "watch") return { verdict: askV("long_running", `cargo watch ${LONG_REASON}`, { pattern: "cargo watch *" }) };
    void env;
    void call;
    return { verdict: allowV() };
  }

  // ------------------------------------------------------------ git

  git(args: Val[], env: Env[], call: Call, depth = 0): PartResult {
    const pending: Verdict[] = [];
    const repoDirs: (string | null)[] = [];
    let cwd = call.cwd;
    const configs: { key: string; value: string | null }[] = [];
    for (const e of env) {
      if (GIT_REPO_ENV.has(e.name)) repoDirs.push(e.value === null ? null : this.abs(e.value, cwd));
      else if (e.name.startsWith("GIT_CONFIG") && e.name !== "GIT_CONFIG_NOSYSTEM") pending.push(unparseable(`${e.name} sets git configuration Rye can't check`));
      else if (GIT_COMMAND_ENV.has(e.name) && !(e.value !== null && SAFE_COMMAND_VALUES.has(e.value.trim()))) pending.push(unparseable(`${e.name} makes git run a program Rye can't check`));
    }
    let k = 0;
    while (k < args.length) {
      const a = args[k];
      if (a.dynamic || a.glob || a.brace) return strictest([...pending, unparseable("git has a subcommand or option only known when it runs")]);
      const t = a.text;
      if (!t.startsWith("-")) break;
      const next = args[k + 1];
      if (t === "-c" || t === "--config-env") {
        if (!next) return strictest([...pending, unparseable(`git ${t} has no value`)]);
        const eq = next.text.indexOf("=");
        const key = eq < 0 ? next.text : next.text.slice(0, eq);
        configs.push({ key, value: next.dynamic || t === "--config-env" ? null : eq < 0 ? "true" : next.text.slice(eq + 1) });
        k += 2;
        continue;
      }
      if (t.startsWith("--config-env=")) {
        configs.push({ key: t.slice(13, t.indexOf("=", 13) < 0 ? undefined : t.indexOf("=", 13)), value: null });
        k++;
        continue;
      }
      if (t === "-C") {
        if (!next) return strictest([...pending, unparseable("git -C has no directory")]);
        cwd = next.dynamic ? null : next.text === "" ? cwd : this.abs(next.text, cwd);
        k += 2;
        continue;
      }
      if (t === "--git-dir" || t === "--work-tree") {
        if (!next) return strictest([...pending, unparseable(`git ${t} has no directory`)]);
        repoDirs.push(next.dynamic ? null : this.abs(next.text, cwd));
        k += 2;
        continue;
      }
      if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) {
        repoDirs.push(this.abs(t.slice(t.indexOf("=") + 1), cwd));
        k++;
        continue;
      }
      if (["--namespace", "--super-prefix", "--attr-source", "--list-cmds"].includes(t)) {
        k += 2;
        continue;
      }
      if (/^--(namespace|super-prefix|attr-source|list-cmds)=/.test(t)) {
        k++;
        continue;
      }
      if (t.startsWith("--exec-path=")) {
        pending.push(unparseable("git --exec-path=… runs git programs from another directory"));
        k++;
        continue;
      }
      if (GIT_FLAGS.has(t)) {
        k++;
        continue;
      }
      return strictest([...pending, unparseable(`git ${t} isn't an option Rye knows`)]);
    }
    if (k >= args.length) return strictest([...pending, allowV()]);
    const sub = args[k].text.toLowerCase();
    const rest = args.slice(k + 1);

    // `-c alias.<sub>=…`: judge what the alias runs.
    const alias = [...configs].reverse().find((c) => c.key.toLowerCase() === `alias.${sub}`);
    if (alias) {
      if (alias.value === null || depth > 8) return strictest([...pending, unparseable(`git alias ${sub} has a value Rye can't work out`)]);
      if (alias.value.startsWith("!")) {
        const inner = this.nested(`${alias.value.slice(1)} ${rest.map((r) => shellQuote(r.text)).join(" ")}`, cwd, call.depth + 1);
        return strictest([...pending, inner.verdict === "deny" ? inner : unparseable(`git alias ${sub} runs a shell command`)]);
      }
      let words: Val[];
      try {
        words = aliasWords(alias.value);
      } catch {
        return strictest([...pending, unparseable(`git alias ${sub} has a value Rye can't read`)]);
      }
      return strictest([...pending, this.git([...args.slice(0, k), ...words, ...rest], env, call, depth + 1)]);
    }
    for (const c of configs) {
      if (c.key.toLowerCase().startsWith("alias.")) continue;
      if (dangerousGitConfigKey(c.key) && !(c.value !== null && SAFE_COMMAND_VALUES.has(c.value.trim()))) {
        pending.push(unparseable(`git -c ${c.key}=… makes git run a program (or reach a remote) Rye can't check`));
      }
    }
    return strictest([...pending, this.gitSub(sub, rest, cwd, repoDirs, call)]);
  }

  gitSub(sub: string, rest: Val[], cwd: string | null, repoDirs: (string | null)[], call: Call): PartResult {
    if (!KNOWN_GIT.has(sub)) return { verdict: unparseable(`"git ${sub}" isn't a git command Rye knows; it may be an alias or a git-${sub} program`) };
    const denied = GIT_DENY[sub];
    if (denied) return { verdict: denyV(denied.reason, denied.rule) };
    if (GIT_SERVE.has(sub)) return { verdict: unparseable(`git ${sub} serves the repository to a client; Rye can't tell what it will be asked to do`) };

    const texts = rest.filter((a) => !a.dynamic).map((a) => a.text);
    const positional = rest.filter((a) => a.dynamic || !a.text.startsWith("-"));
    const first = positional[0];
    if (first?.dynamic && ["remote", "config", "reflog", "worktree", "submodule", "maintenance", "lfs", "svn", "p4", "bisect", "update-ref", "stash"].includes(sub)) {
      return { verdict: unparseable(`git ${sub} has a subcommand only known when it runs`) };
    }
    const action = first?.text;

    // Per-subcommand denials that hold wherever the repository is.
    if (sub === "remote" && (action === "add" || action === "set-url")) return { verdict: denyV(`git remote ${action} isn't allowed: a code session has no remote. ${cap(NO_REMOTE)}.`, "git remote add|set-url") };
    if (sub === "gc" && texts.some((t) => t.startsWith("--prune"))) return { verdict: denyV("git gc --prune deletes unreachable objects, which the session's snapshots may still need; run git gc without --prune.", "git gc --prune*|git prune") };
    if (sub === "reflog" && (action === "expire" || action === "delete")) return { verdict: denyV(`git reflog ${action} deletes the history that makes rewritten work recoverable.`, "git reflog expire|delete") };
    if (sub === "update-ref") {
      if (texts.includes("--stdin")) return { verdict: unparseable("git update-ref --stdin reads ref changes from its input") };
      if (rest.some((a) => a.dynamic)) return { verdict: unparseable("git update-ref has a ref only known when it runs") };
      if (texts.some((t) => /^refs\/+rye(\/|$)/i.test(t))) return { verdict: denyV("refs/rye/* hold Rye's snapshots of this session; git update-ref may not touch them.", "git update-ref refs/rye/*") };
    }
    if (sub === "maintenance" && ["start", "register", "unregister", "stop"].includes(action ?? "")) return { verdict: denyV(`git maintenance ${action} schedules background jobs and writes your global git config.`, "git credential*|send-email|for-each-repo|maintenance start") };
    if ((sub === "svn" && (action === "dcommit" || action === "set-tree")) || (sub === "p4" && action === "submit") || sub === "cvsexportcommit" || (sub === "lfs" && action === "push")) {
      return { verdict: denyV(`git ${sub}${action && sub !== "cvsexportcommit" ? ` ${action}` : ""} publishes commits; ${NO_REMOTE}.`, "git push") };
    }
    if (sub === "config") {
      const v = this.gitConfig(rest, cwd);
      if (v.verdict !== "allow") return { verdict: v };
    }

    // Where it works: anything that changes a repository must be inside the workspace.
    if (!this.gitReadOnly(sub, rest, positional)) {
      if (this.p.ws.isolation === "worktree") {
        return { verdict: denyV(`git ${sub} changes the repository, and in worktree mode its .git is shared with your checkout, so only read-only git commands run; Rye makes the commits.`, "git <write> outside the workspace") };
      }
      for (const d of [cwd, ...repoDirs]) {
        if (d === null) return { verdict: unparseable(`git ${sub} runs in a directory Rye can't work out`) };
        const real = safeCanonical(d) ?? d;
        if (!this.insideWrite(real)) return { verdict: denyV(`git ${sub} would change a repository outside the workspace (${real}); a code session changes only its own clone.`, "git <write> outside the workspace") };
      }
    }

    if (sub === "worktree" && (action === "add" || action === "move")) {
      const opts = ["-b", "-B", "--reason"];
      const pos = skipOptions(rest.slice(1), opts).filter((a) => a.dynamic || !a.text.startsWith("-"));
      const target = action === "add" ? pos[0] : pos[1];
      if (!target) return { verdict: allowV() };
      if (target.dynamic) return { verdict: unparseable(`git worktree ${action} has a path only known when it runs`) };
      const abs = this.abs(target.text, cwd);
      const real = abs === null ? null : safeCanonical(abs);
      if (real === null) return { verdict: unparseable(`git worktree ${action} has a path Rye can't work out`) };
      if (!this.insideWrite(real)) return { verdict: denyV(`git worktree ${action} ${target.raw} would put a worktree outside the workspace (${real}).`, "git worktree add <outside the workspace>") };
      return { verdict: allowV() };
    }
    if (sub === "init" || sub === "init-db") {
      for (const a of rest) {
        const path = a.text.startsWith("--separate-git-dir=") ? a.text.slice(19) : !a.text.startsWith("-") ? a.text : null;
        if (path === null) continue;
        if (a.dynamic) return { verdict: unparseable(`git ${sub} has a directory only known when it runs`) };
        const abs = this.abs(path, cwd);
        const real = abs === null ? null : safeCanonical(abs);
        if (real === null || !this.insideWrite(real)) return { verdict: denyV(`git ${sub} ${path} would create a repository outside the workspace.`, "git <write> outside the workspace") };
      }
    }
    if (GIT_NETWORK.has(sub) || (sub === "archive" && texts.some((t) => t.startsWith("--remote"))) || (sub === "lfs" && ["pull", "fetch", "clone", "pre-push"].includes(action ?? ""))) {
      return { verdict: this.network(`git ${sub} uses the network`, hostsIn(rest, false), `git ${sub} *`) };
    }
    if (sub === "remote") {
      if (action === "update" || action === "prune" || (action === "show" && !texts.includes("-n")) || (action === "set-head" && texts.some((t) => t === "-a" || t === "--auto"))) {
        return { verdict: this.network(`git remote ${action} uses the network`, [], `git remote ${action} *`) };
      }
      return { verdict: allowV() };
    }
    if (sub === "submodule") {
      const s = rest.find((a) => !a.text.startsWith("-"))?.text;
      if (s === "update" || s === "add") return { verdict: this.network(`git submodule ${s} uses the network`, hostsIn(rest, false), `git submodule ${s} *`) };
      if (s === "foreach") {
        const cmd = rest.slice(rest.findIndex((a) => a.text === "foreach") + 1).filter((a) => !/^(--recursive|-q|--quiet)$/.test(a.text));
        if (cmd.some((a) => a.dynamic)) return { verdict: unparseable("git submodule foreach runs a command only known when it runs") };
        const inner = this.nested(cmd.map((a) => a.text).join(" "), cwd, call.depth + 1);
        return { verdict: inner.verdict === "deny" ? inner : unparseable("git submodule foreach runs a command string") };
      }
      return { verdict: allowV() };
    }
    if (GIT_LONG.has(sub)) return { verdict: askV("long_running", `git ${sub} ${LONG_REASON}`, { pattern: `git ${sub} *` }) };
    if (sub === "bisect" && action === "run") {
      const cmd = rest.slice(rest.findIndex((a) => a.text === "run") + 1);
      return this.inner(cmd, [], call, cwd);
    }
    if (sub === "rebase" || sub === "difftool" || sub === "mergetool") {
      const flags = sub === "rebase" ? ["-x", "--exec"] : ["-x", "--extcmd"];
      const results: Verdict[] = [];
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i].text;
        const value = flags.includes(t) ? rest[i + 1] : flags.some((f) => f.startsWith("--") && t.startsWith(`${f}=`)) ? { ...rest[i], text: t.slice(t.indexOf("=") + 1) } : /^-x./.test(t) ? { ...rest[i], text: t.slice(2) } : null;
        if (!value) continue;
        results.push(value.dynamic ? unparseable(`git ${sub} runs a command only known when it runs`) : this.nested(value.text, cwd, call.depth + 1));
      }
      return { verdict: strictestVerdict(results) };
    }
    return { verdict: allowV() };
  }

  /** `git config`: reads are allowed; writes of keys that run commands, global or system writes and `--edit` are denied. */
  gitConfig(rest: Val[], cwd: string | null): Verdict {
    const rule = "git config <key that runs commands or reaches a remote>";
    type Action = "get" | "set" | "unset" | "edit" | "rename" | "remove";
    let action: Action | undefined;
    let scope: string | null = null;
    let file: Val | null = null;
    const positional: Val[] = [];
    const valueOpts = ["--type", "--default", "--comment", "--value", "--url", "--blob"];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const t = a.text;
      if (a.dynamic && !positional.length && !t.startsWith("-")) return unparseable("git config has a key only known when it runs");
      if (t === "--global" || t === "--system") scope = t;
      else if (t === "--file" || t === "-f") {
        file = rest[i + 1] ?? null;
        i++;
      } else if (t.startsWith("--file=")) file = { ...a, text: t.slice(7) };
      else if (t === "-e" || t === "--edit") action = "edit";
      else if (/^--(get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list)$/.test(t) || t === "-l") action = "get";
      else if (t === "--unset" || t === "--unset-all") action = "unset";
      else if (t === "--add" || t === "--replace-all") action = "set";
      else if (t === "--rename-section") action = "rename";
      else if (t === "--remove-section") action = "remove";
      else if (valueOpts.includes(t)) i++;
      else if (t.startsWith("-")) continue;
      else positional.push(a);
    }
    if (!action && positional.length) {
      const verb = positional[0].text;
      const verbs: Record<string, Action> = { get: "get", list: "get", set: "set", unset: "unset", edit: "edit", "rename-section": "rename", "remove-section": "remove" };
      if (verbs[verb] && !positional[0].text.includes(".")) {
        action = verbs[verb];
        positional.shift();
      } else action = positional.length >= 2 ? "set" : "get";
    }
    if (!action || action === "get") return allowV();
    if (action === "edit") return denyV("git config --edit can set any key, including ones that make git run commands; set keys one at a time instead.", "git config --global|--system|--edit");
    if (scope) return denyV(`git config ${scope} writes your ${scope.slice(2)} git configuration, outside the workspace.`, "git config --global|--system|--edit");
    if (file) {
      if (file.dynamic) return unparseable("git config --file has a path only known when it runs");
      const abs = this.abs(file.text, cwd);
      const real = abs === null ? null : safeCanonical(abs);
      if (real === null || !this.insideWrite(real)) return denyV(`git config --file ${file.raw} writes outside the workspace.`, "git config --global|--system|--edit");
    }
    if (action === "unset" || action === "remove") return allowV();
    const keys = action === "rename" ? positional.slice(0, 2) : positional.slice(0, 1);
    for (const key of keys) {
      if (key.dynamic) return unparseable("git config has a key only known when it runs");
      // A section name (rename-section) is checked as `section.x`.
      const k = action === "rename" ? `${key.text}.x` : key.text;
      if (dangerousGitConfigKey(k)) return denyV(`git config ${key.text} can make git run commands or reach a remote, so a code session never sets it.`, rule);
    }
    return allowV();
  }

  gitReadOnly(sub: string, rest: Val[], positional: Val[]): boolean {
    if (GIT_READ_ONLY.has(sub)) return true;
    const texts = rest.map((a) => a.text);
    const action = positional[0]?.text;
    switch (sub) {
      case "branch": {
        if (texts.some((t) => /^-[a-zA-Z]*[dDmMcCuf]/.test(t) && !/^-[avrl]+$/.test(t)) || texts.some((t) => /^--(delete|move|copy|set-upstream-to|unset-upstream|edit-description|force|track|no-track)/.test(t))) return false;
        if (texts.some((t) => t === "--list" || t === "-l" || t === "--show-current" || /^--(contains|no-contains|merged|no-merged|points-at)/.test(t))) return true;
        return positional.length === 0;
      }
      case "tag":
        if (texts.some((t) => /^-[a-zA-Z]*[dasmfFu]/.test(t) && t !== "-l" && !/^-n\d*$/.test(t))) return false;
        if (texts.includes("-l") || texts.includes("--list") || texts.some((t) => /^--(contains|no-contains|merged|no-merged|points-at)/.test(t))) return true;
        return positional.length === 0;
      case "remote": return !action || action === "show" || action === "get-url" || action === "-v";
      case "stash": return action === "list" || action === "show";
      case "worktree": return action === "list";
      case "notes": return !action || action === "list" || action === "show";
      case "reflog": return !action || action === "show" || action === "exists";
      case "submodule": return !action || action === "status" || action === "summary";
      case "sparse-checkout": return action === "list";
      case "symbolic-ref": return positional.length <= 1 && !texts.includes("-d") && !texts.includes("--delete");
      case "hash-object": return !texts.includes("-w");
      case "config": {
        const writes = texts.some((t) => /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(t)) || ["set", "unset", "edit", "rename-section", "remove-section"].includes(action ?? "");
        return !writes && positional.length <= 1;
      }
      case "bundle": return action === "list-heads" || action === "verify";
      case "lfs": return ["ls-files", "status", "env", "version", "logs"].includes(action ?? "");
      default: return false;
    }
  }
}

// ===========================================================================
// Small helpers
// ===========================================================================

const NPM_VALUE_OPTS = ["--prefix", "-C", "--workspace", "-w", "--registry", "--userconfig", "--globalconfig", "--cache", "--loglevel", "--tag", "--otp", "--access", "--scope", "--script-shell", "--include", "--omit", "--location", "--before", "--auth-type"];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const curlShDeny = () => denyV("Running a downloaded script runs code Rye can't see; download it to a file and look at it first.", "curl … | sh");

/** The command's name as judged: the basename, lower-cased (`/usr/bin/GIT` is `git` on a case-insensitive disk). */
function commandName(v: Val): string {
  return basename(v.text).toLowerCase();
}

function normalizedText(argv: Val[]): string {
  if (argv.length === 0) return "";
  return squash([commandName(argv[0]), ...argv.slice(1).map((a) => (a.dynamic ? a.raw : a.text))].join(" "));
}

function firstPositional(args: Val[], valueOpts: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (!t.startsWith("-")) return t;
    if (valueOpts.includes(t)) k++;
  }
  return undefined;
}

/** Drop leading options (and the values of `valueOpts`, and anything matching `alsoSkip`). */
function skipOptions(args: Val[], valueOpts: string[], alsoSkip?: RegExp): Val[] {
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a.dynamic) break;
    if (a.text === "--") return args.slice(k + 1);
    if (alsoSkip?.test(a.text)) {
      k++;
      continue;
    }
    if (!a.text.startsWith("-")) break;
    k += valueOpts.includes(a.text) ? 2 : 1;
  }
  return args.slice(k);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A git alias value split into words, as git splits it (quotes respected, no expansion). */
function aliasWords(value: string): Val[] {
  const nodes = Parser.parse(value);
  const cmd = nodes.find((n): n is Extract<ShellNode, { t: "cmd" }> => n.t === "cmd");
  if (!cmd || nodes.filter((n) => n.t === "cmd").length > 1) throw new ShellParseError("an alias with several commands");
  return cmd.words.map((w) => {
    if (!w.parts.every((p) => p.t === "lit")) throw new ShellParseError("an alias with expansions");
    return staticVal(w.parts.map((p) => (p.t === "lit" ? p.v : "")).join(""));
  });
}

/** Hosts named in arguments: URLs, `user@host:path`, and (for HTTP clients) bare `example.com/path`. */
function hostsIn(args: Val[], bare: boolean): string[] {
  const hosts: string[] = [];
  for (const a of args) {
    if (a.dynamic) continue;
    const t = a.text.includes("=") && !a.text.includes("://") ? a.text : a.text.replace(/^[^=]*=(?=[a-z][a-z0-9+.-]*:\/\/)/i, "");
    let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(t);
    if (m) {
      hosts.push(m[1].toLowerCase());
      continue;
    }
    m = /^(?:[^@\s/:]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|localhost):(?!\/\/)/.exec(t);
    if (m && !t.startsWith("-")) {
      hosts.push(m[1].toLowerCase());
      continue;
    }
    if (bare && !t.startsWith("-")) {
      m = /^(?:[^@\s/:]+@)?((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?::\d+)?(?:\/|$)/.exec(t);
      if (m) hosts.push(m[1].toLowerCase());
    }
  }
  return [...new Set(hosts)];
}

// ===========================================================================
// compilePolicy
// ===========================================================================

const SESSION_READ_PREFIX = "read:";

interface PolicyInputs {
  config: PolicyConfig;
  repo: CodeRepoConfig;
  ws: Workspace;
  scope: PolicyScope;
  session: string[];
  sessionHosts: string[];
}

const compileRules = (patterns: readonly string[] | undefined): CompiledRule[] =>
  (patterns ?? []).filter((p) => typeof p === "string" && p.trim()).map((p) => ({ pattern: squash(p), re: patternRegex(p) }));

function build(inputs: PolicyInputs): CompiledPolicy {
  const { config, repo, ws, scope } = inputs;
  const canon = (p: string) => safeCanonical(p) ?? p;
  const expandHome = (p: string) => (p === "~" ? scope.home : p.startsWith("~/") ? join(scope.home, p.slice(2)) : p);
  const repoDir = canon(ws.repoDir);
  const tmpDir = canon(ws.tmpDir);
  const writeRoots = [repoDir, tmpDir, canon(ws.cacheDir), ...(repo.allow_write ?? []).map((p) => canon(isAbsolute(expandHome(p)) ? expandHome(p) : join(repoDir, p)))];
  const home = canon(scope.home);
  const repoPolicy = repo.policy;
  const sessionCommands = inputs.session.filter((p) => !p.startsWith(SESSION_READ_PREFIX));
  const sessionReads = inputs.session.filter((p) => p.startsWith(SESSION_READ_PREFIX)).map((p) => p.slice(SESSION_READ_PREFIX.length));
  const allowedDomains = [...new Set([...(config.allowed_domains ?? []), ...(repoPolicy?.allowed_domains ?? []), ...inputs.sessionHosts].map((d) => d.trim().toLowerCase()).filter(Boolean))];

  const core: PolicyCore = {
    ws,
    scope,
    repoDir,
    tmpDir,
    writeRoots,
    readRoots: [...writeRoots, canon(ws.userObjectsDir), ...scope.toolchainDirs.map(canon)],
    secrets: [
      ...HOME_SECRETS.map((s) => ({ path: join(home, s.path), what: s.what })),
      ...HOME_SECRETS.map((s) => ({ path: join(scope.home, s.path), what: s.what })),
      ...SYSTEM_SECRETS,
    ],
    dataDir: canon(scope.dataDir),
    configDir: canon(scope.configDir),
    sessionDir: canon(ws.sessionDir),
    home,
    allowedDomains,
    deny: [...compileRules(config.deny), ...compileRules(repoPolicy?.deny)],
    ask: [...compileRules(config.ask), ...compileRules(repoPolicy?.ask)],
    allow: [...compileRules(config.allow), ...compileRules(repoPolicy?.allow)],
    sessionAllow: compileRules(sessionCommands),
    sessionReads: sessionReads.map((p) => ({ pattern: p, re: new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`, "s") })),
  };
  const judge = new Judge(core);

  const rules: CodePolicyRule[] = [
    ...BUILTIN_RULES,
    ...(["deny", "ask", "allow"] as const).flatMap((verdict) => [
      ...compileRules(config[verdict]).map((r): CodePolicyRule => ({ pattern: r.pattern, verdict, source: "config" })),
      ...compileRules(repoPolicy?.[verdict]).map((r): CodePolicyRule => ({ pattern: r.pattern, verdict, source: "repo" })),
    ]),
    ...inputs.session.map((p): CodePolicyRule => ({ pattern: p, verdict: "allow", source: "session" })),
  ];

  return {
    commandVerdict(cmd: string): Verdict {
      if (typeof cmd !== "string") return unparseable("the command isn't text");
      if (cmd.length > MAX_COMMAND_LENGTH) return unparseable("the command is too long to check");
      if (cmd.includes("\0")) return unparseable("the command contains a NUL byte");
      let nodes: ShellNode[];
      try {
        nodes = Parser.parse(cmd);
      } catch (e) {
        if (e instanceof ShellParseError) return unparseable(`Rye couldn't parse this command because ${e.message}`);
        throw e;
      }
      let parts: PartResult[];
      try {
        parts = judge.run(nodes, repoDir);
      } catch (e) {
        if (e instanceof ShellParseError) return unparseable(`Rye couldn't parse this command because ${e.message}`);
        throw e;
      }
      return strictestVerdict(parts.map((p) => p.verdict));
    },

    pathVerdict(path: string, op: PathOp): Verdict {
      const pathRule = "<a path holding credentials or Rye's data>";
      if (typeof path !== "string" || path === "") return denyV("A file path is required.");
      if (path.includes("\0")) return denyV("The path contains a NUL byte.");
      const p = expandHome(path);
      if (p.split("/").includes("..")) return denyV(`Paths with ".." segments are refused; use the plain path (${path}).`);
      const abs = isAbsolute(p) ? p : join(repoDir, p);
      const real = safeCanonical(abs);
      if (real === null) return denyV(`${path} goes through too many symbolic links.`);
      const secret = judge.secretOf(abs, real);
      if (secret) return denyV(`${path} holds ${secret}; a code session never ${op === "write" ? "writes" : "reads"} it.`, pathRule);
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(real);
      } catch {
        st = null;
      }
      const linked = !!st && st.isFile() && st.nlink > 1;
      if (op === "write") {
        if (!judge.insideWrite(real)) return denyV(`Writes are allowed only inside the workspace (${repoDir}); ${path} resolves to ${real}.`, "rm|rmdir|unlink <outside the workspace>");
        const gitDir = join(repoDir, ".git");
        if (within(fsKey(real), fsKey(join(gitDir, "hooks"))) || fsKey(real) === fsKey(join(gitDir, "config"))) {
          return denyV(`${path} is git's hooks or config, which can make git run commands; change settings with git config instead.`, "git config <key that runs commands or reaches a remote>");
        }
        if (linked) return denyV(`${path} has other hard links, so writing it would change a file elsewhere too; delete it and write a new file instead.`);
        return allowV();
      }
      const k = fsKey(real);
      if (core.readRoots.some((r) => within(k, fsKey(r)))) {
        // A hard link inside the workspace may be a second name for a file outside it (a secret
        // linked in), which no path check can see. Toolchain dirs are full of them and fine.
        if (linked && judge.insideWrite(real)) return askV("path", `${path} has other hard links, which may be outside the workspace`, { pattern: `${SESSION_READ_PREFIX}${real}` });
        return allowV();
      }
      const session = core.sessionReads.find((r) => r.re.test(real));
      if (session) return allowV(`${SESSION_READ_PREFIX}${session.pattern}`);
      return askV("path", `reads ${real}, outside the workspace and the toolchain directories`, { pattern: `${SESSION_READ_PREFIX}${dirname(real)}/*` });
    },

    allowForSession(pattern: string, hosts: readonly string[] = []): CompiledPolicy {
      // Local and private hosts can never be approved (isLocalHost).
      return build({ ...inputs, session: [...inputs.session, pattern], sessionHosts: [...inputs.sessionHosts, ...hosts.filter((h) => !isLocalHost(h))] });
    },

    rules,
    allowedDomains,
  };
}

/**
 * Compile `[code.policy]` plus the repo's own rules for one workspace. Built-in denials can't be
 * lifted by any rule; user rules apply deny, then session approvals, then ask, then allow, and an
 * allow rule lifts a built-in ask (`allow = ["bun install *"]`).
 */
export const compilePolicy: CompilePolicy = (config, repo, ws, scope) => build({ config, repo, ws, scope, session: [], sessionHosts: [] });
