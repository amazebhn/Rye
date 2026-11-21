import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeSkillMd, parseSkillMd } from "../src/skill/frontmatter.js";
import {
  MAX_READ_BYTES,
  SkillError,
  assertValidSkillName,
  atomicWriteFile,
  isValidSkillName,
  readTextFile,
  resolveInside,
} from "../src/skill/fs-safe.js";
import { cleanupTmp, makeTmp } from "./skill-test-utils.js";

afterAll(cleanupTmp);

describe("parseSkillMd", () => {
  test("parses name/description and body", () => {
    const p = parseSkillMd("---\nname: demo\ndescription: Does things\n---\n\n# Hi\nbody\n");
    expect(p.hasFrontmatter).toBe(true);
    expect(p.data).toEqual({ name: "demo", description: "Does things" });
    expect(p.body).toBe("# Hi\nbody\n");
    expect(p.warning).toBeUndefined();
  });

  test("quoted values keep embedded quotes and colons", () => {
    const p = parseSkillMd(`---\ndescription: "Use when: he said \\"hi\\""\ntitle: 'It''s: fine'\n---\nx`);
    expect(p.data.description).toBe('Use when: he said "hi"');
    expect(p.data.title).toBe("It's: fine");
    expect(p.warning).toBeUndefined();
  });

  test("unquoted colon in a value falls back to lenient parsing with a warning", () => {
    const p = parseSkillMd("---\nname: demo\ndescription: Use when: the user asks\n---\nbody");
    expect(p.data.name).toBe("demo");
    expect(p.data.description).toBe("Use when: the user asks");
    expect(p.warning).toContain("parsed leniently");
  });

  test("folded (>) and literal (|) block scalars", () => {
    const folded = parseSkillMd("---\ndescription: >\n  first line\n  second line\n---\nb");
    expect(String(folded.data.description).trim()).toBe("first line second line");
    const literal = parseSkillMd("---\ndescription: |\n  first line\n  second line\n---\nb");
    expect(String(literal.data.description).trim()).toBe("first line\nsecond line");
  });

  test("no frontmatter returns the whole text as body", () => {
    const p = parseSkillMd("# Just markdown\n\ntext");
    expect(p).toEqual({ data: {}, body: "# Just markdown\n\ntext", hasFrontmatter: false });
  });

  test("unterminated frontmatter is treated as no frontmatter", () => {
    const p = parseSkillMd("---\nname: x\nno end marker");
    expect(p.hasFrontmatter).toBe(false);
    expect(p.body).toContain("no end marker");
  });

  test("CRLF line endings", () => {
    const p = parseSkillMd("---\r\nname: demo\r\ndescription: crlf works\r\n---\r\n\r\nline1\r\nline2\r\n");
    expect(p.data).toEqual({ name: "demo", description: "crlf works" });
    expect(p.body.startsWith("line1")).toBe(true);
  });

  test("leading BOM is ignored", () => {
    const p = parseSkillMd("\uFEFF---\nname: demo\ndescription: bom\n---\nbody");
    expect(p.hasFrontmatter).toBe(true);
    expect(p.data.name).toBe("demo");
    expect(parseSkillMd("\uFEFFno frontmatter").body).toBe("no frontmatter");
  });

  test("empty frontmatter and `...` terminator", () => {
    expect(parseSkillMd("---\n---\nbody")).toMatchObject({ data: {}, hasFrontmatter: true, body: "body" });
    expect(parseSkillMd("---\nname: a\n...\nbody").data.name).toBe("a");
  });

  test("non-mapping frontmatter yields no data and a warning", () => {
    const p = parseSkillMd("---\n- a\n- b\n---\nbody");
    expect(p.data).toEqual({});
    expect(p.warning).toBeDefined();
  });

  test("a YAML alias bomb does not hang or blow up", () => {
    const lines = ["a: &a [x,x,x,x,x,x,x,x,x]"];
    let prev = "a";
    for (const c of "bcdefghij") {
      lines.push(`${c}: &${c} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`);
      prev = c;
    }
    const t0 = Date.now();
    const p = parseSkillMd(`---\n${lines.join("\n")}\n---\nbody`);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(p.hasFrontmatter).toBe(true);
  });
});

describe("composeSkillMd", () => {
  test("round-trips tricky values", () => {
    const description = `Use when: "quoted" # not a comment\nsecond line`;
    const md = composeSkillMd({ name: "demo", title: "Demo: Title", description, extras: { tags: ["a", "b"], n: 3 } }, "\n\n# Body\n");
    const p = parseSkillMd(md);
    expect(p.warning).toBeUndefined();
    expect(p.data).toEqual({ name: "demo", title: "Demo: Title", description, tags: ["a", "b"], n: 3 });
    expect(p.body).toBe("# Body\n");
  });

  test("extras cannot override name/title/description", () => {
    const md = composeSkillMd({ name: "real", description: "d", extras: { name: "evil", title: "t", description: "x" } }, "b");
    const p = parseSkillMd(md);
    expect(p.data.name).toBe("real");
    expect(p.data.description).toBe("d");
    expect(p.data.title).toBeUndefined();
  });
});

describe("skill names", () => {
  test.each(["a", "0", "foo", "foo-bar_baz.v2", "a".repeat(64), "9lives"])("accepts %s", (n) => {
    expect(isValidSkillName(n)).toBe(true);
  });

  test.each([
    "", ".", "..", "-x", ".hidden", "_x", "Upper", "a b", "a/b", "a\\b", "a\0b", "a".repeat(65), "é", "a;b", "$(x)", "a\nb", "../etc",
  ])("rejects %j", (n) => {
    expect(isValidSkillName(n)).toBe(false);
    expect(() => assertValidSkillName(n)).toThrow(SkillError);
  });

  test("rejects non-strings", () => {
    expect(isValidSkillName(5)).toBe(false);
    expect(isValidSkillName(null)).toBe(false);
    expect(isValidSkillName(undefined)).toBe(false);
  });
});

describe("resolveInside", () => {
  const base = makeTmp();
  const root = join(base, "skill");
  const outside = join(base, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "a.txt"), "A");
  writeFileSync(join(root, "sub", "b.txt"), "B");
  writeFileSync(join(outside, "secret.txt"), "SECRET");
  symlinkSync(join(outside, "secret.txt"), join(root, "link-file"));
  symlinkSync(outside, join(root, "link-dir"));
  symlinkSync(join(root, "a.txt"), join(root, "inner-link"));

  const code = (fn: () => unknown): number => {
    try {
      fn();
    } catch (e) {
      return e instanceof SkillError ? e.status : -1;
    }
    return 0;
  };

  test("resolves regular files and normalises the relative path", () => {
    expect(resolveInside(root, "a.txt").rel).toBe("a.txt");
    expect(resolveInside(root, "./sub//b.txt").rel).toBe("sub/b.txt");
  });

  test("allows a symlink that stays inside the folder", () => {
    expect(resolveInside(root, "inner-link").real).toBe(join(root, "a.txt"));
  });

  test.each(["../outside/secret.txt", "sub/../../outside/secret.txt", "..", "sub/.."])("rejects traversal %j", (p) => {
    expect(code(() => resolveInside(root, p))).toBe(400);
  });

  test("rejects absolute paths, drive letters, backslashes and NUL bytes", () => {
    expect(code(() => resolveInside(root, join(outside, "secret.txt")))).toBe(400);
    expect(code(() => resolveInside(root, "C:/x"))).toBe(400);
    expect(code(() => resolveInside(root, "sub\\b.txt"))).toBe(400);
    expect(code(() => resolveInside(root, "a.txt\0.png"))).toBe(400);
  });

  test("rejects empty or non-string paths", () => {
    expect(code(() => resolveInside(root, ""))).toBe(400);
    expect(code(() => resolveInside(root, "  "))).toBe(400);
    expect(code(() => resolveInside(root, undefined))).toBe(400);
    expect(code(() => resolveInside(root, 5))).toBe(400);
  });

  test("rejects symlinks escaping the folder (file and directory)", () => {
    expect(code(() => resolveInside(root, "link-file"))).toBe(400);
    expect(code(() => resolveInside(root, "link-dir/secret.txt"))).toBe(400);
  });

  test("404 for missing files, 400 for directories", () => {
    expect(code(() => resolveInside(root, "nope.txt"))).toBe(404);
    expect(code(() => resolveInside(root, "sub"))).toBe(400);
  });
});

describe("readTextFile", () => {
  const dir = makeTmp();

  test("reads text and reports size", () => {
    writeFileSync(join(dir, "t.txt"), "héllo");
    const r = readTextFile(join(dir, "t.txt"));
    expect(r.content).toBe("héllo");
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(6);
  });

  test("refuses binary content", () => {
    writeFileSync(join(dir, "b.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(() => readTextFile(join(dir, "b.bin"))).toThrow(/binary/i);
  });

  test("caps large files and says so", () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(MAX_READ_BYTES + 5000));
    const r = readTextFile(join(dir, "big.txt"));
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThan(MAX_READ_BYTES + 200);
    expect(r.content).toContain("[truncated");
  });

  test("honours a custom cap", () => {
    writeFileSync(join(dir, "c.txt"), "0123456789");
    expect(readTextFile(join(dir, "c.txt"), 4).content.startsWith("0123\n")).toBe(true);
  });
});

describe("atomicWriteFile", () => {
  test("writes and leaves no temp files", () => {
    const dir = makeTmp();
    atomicWriteFile(join(dir, "f.md"), "one");
    atomicWriteFile(join(dir, "f.md"), "two");
    expect(readdirSync(dir)).toEqual(["f.md"]);
  });

  test("cleans up the temp file when the rename fails", () => {
    const dir = makeTmp();
    mkdirSync(join(dir, "target"));
    expect(() => atomicWriteFile(join(dir, "target"), "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});
