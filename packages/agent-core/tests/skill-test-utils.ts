/** Shared fixtures for the skill tests: temp dirs only, never the user's real skill/data dirs. */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SkillStore } from "../src/skill/store.js";

const made: string[] = [];

export function makeTmp(prefix = "rye-skill-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export interface FixtureSkill {
  description?: string;
  title?: string;
  body?: string;
  /** Extra files relative to the skill folder. */
  files?: Record<string, string>;
  /** Raw SKILL.md; overrides description/title/body. */
  raw?: string;
}

/** Write `<root>/<name>/SKILL.md` plus any bundled files; returns the skill folder. */
export function writeSkill(root: string, name: string, s: FixtureSkill = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const fm = [`name: ${name}`, ...(s.title ? [`title: ${JSON.stringify(s.title)}`] : []), `description: ${JSON.stringify(s.description ?? `About ${name}`)}`];
  writeFileSync(join(dir, "SKILL.md"), s.raw ?? `---\n${fm.join("\n")}\n---\n\n${s.body ?? `# ${name}\n\nBody of ${name}.`}\n`);
  for (const [rel, content] of Object.entries(s.files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    if (rel.startsWith("scripts/")) chmodSync(p, 0o755);
  }
  return dir;
}

export interface Fixture {
  base: string;
  rye: string;
  ext: string;
  store: SkillStore;
}

/** A store with a Rye-owned dir and one external (read-only) dir, laid out like ~/.agents/skills. */
export function makeFixture(): Fixture {
  const base = makeTmp();
  const rye = join(base, "data", "skills");
  const ext = join(base, "home", ".agents", "skills");
  mkdirSync(rye, { recursive: true });
  mkdirSync(ext, { recursive: true });
  return { base, rye, ext, store: new SkillStore({ ryeDir: rye, externalDirs: [ext] }) };
}
