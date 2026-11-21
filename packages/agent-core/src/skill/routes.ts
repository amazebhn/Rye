/** HTTP routes for skills (mounted at /skill). Fixed routes are registered before /:name. */

import { Hono, type Context } from "hono";
import { SkillError } from "./fs-safe.js";
import { installSkills, listAvailableSkills, removeInstalledSkill } from "./install.js";
import type { Skill, SkillStore, SkillSummary } from "./store.js";

const MAX_CONTENT_CHARS = 500_000;

export function skillToJson(s: SkillSummary | Skill) {
  const from = s.installedFrom;
  const installedFrom = from
    ? Object.fromEntries(
        Object.entries({
          source: from.source,
          sourceUrl: from.sourceUrl,
          installedAt: from.installedAt,
          updatedAt: from.updatedAt,
        }).filter(([, v]) => v !== null),
      )
    : undefined;
  return {
    name: s.name,
    title: s.title,
    description: s.description,
    source: s.source,
    editable: s.editable,
    path: s.path,
    hasScripts: s.scripts.length > 0,
    scripts: s.scripts,
    files: s.files,
    filesTruncated: s.filesTruncated,
    ...(installedFrom ? { installedFrom } : {}),
    ...(Object.keys(s.frontmatter).length > 0 ? { extras: s.frontmatter } : {}),
    ...(s.shadows ? { shadows: s.shadows } : {}),
    updatedAt: s.updatedAt,
    ...("body" in s ? { body: s.body } : {}),
  };
}

export function skillErrorResponse(c: Context, err: unknown) {
  if (err instanceof SkillError) return c.json({ error: err.message }, err.status);
  console.error("[skill] unexpected error", err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SkillError("Expected a JSON object body", 400);
  return body as Record<string, unknown>;
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new SkillError(`${key} must be a string`, 400);
  return v;
}

function checkContent(content: string | undefined): void {
  if (content !== undefined && content.length > MAX_CONTENT_CHARS) throw new SkillError("content is too large", 413);
}

export function skillRoutes(store: SkillStore): Hono {
  const r = new Hono();

  r.get("/", (c) => c.json(store.list().map(skillToJson)));

  // Fixed paths first so they are never read as a skill name.
  r.get("/warnings", (c) => c.json({ warnings: store.warnings() }));

  r.post("/rescan", (c) => c.json(store.rescan().map(skillToJson)));

  r.get("/install/available", async (c) => {
    try {
      const result = await listAvailableSkills(c.req.query("source"), { signal: c.req.raw.signal });
      return c.json(result, result.ok ? 200 : 502);
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  r.post("/install", async (c) => {
    try {
      const body = await readBody(c);
      const result = await installSkills(store, { source: body.source, skills: body.skills }, { signal: c.req.raw.signal });
      return c.json(result, result.ok ? 200 : 502);
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  r.post("/remove", async (c) => {
    try {
      const body = await readBody(c);
      const result = await removeInstalledSkill(store, body.name, { signal: c.req.raw.signal });
      return c.json(result, result.ok ? 200 : 500);
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  r.post("/", async (c) => {
    try {
      const body = await readBody(c);
      const content = optString(body, "content");
      if (content === undefined) throw new SkillError("content is required", 400);
      checkContent(content);
      const skill = store.create({
        name: optString(body, "name"),
        title: optString(body, "title"),
        description: optString(body, "description"),
        content,
      });
      return c.json(skillToJson(skill), 201);
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  r.get("/:name", (c) => {
    const skill = store.get(c.req.param("name"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json(skillToJson(skill));
  });

  r.get("/:name/file", (c) => {
    try {
      const file = store.readFile(c.req.param("name"), c.req.query("path"));
      return c.json(file);
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  const update = async (c: Context) => {
    try {
      const body = await readBody(c);
      const patch = { title: optString(body, "title"), description: optString(body, "description"), content: optString(body, "content") };
      checkContent(patch.content);
      return c.json(skillToJson(store.update(c.req.param("name") ?? "", patch)));
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  };
  r.put("/:name", update);
  r.patch("/:name", update);

  r.delete("/:name", (c) => {
    try {
      const name = c.req.param("name");
      store.delete(name);
      return c.json({ status: "deleted", name });
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  r.post("/:name/duplicate", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const newName = typeof body === "object" && body !== null ? optString(body as Record<string, unknown>, "name") : undefined;
      return c.json(skillToJson(store.duplicate(c.req.param("name"), newName)), 201);
    } catch (err) {
      return skillErrorResponse(c, err);
    }
  });

  return r;
}
