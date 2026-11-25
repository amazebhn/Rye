import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserProfile, userPromptLine, writeUserProfile } from "../src/profile/store.js";
import { profileRoutes } from "../src/profile/routes.js";

function withTempFile(fn: (file: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "rye-profile-test-"));
    try {
      await fn(join(dir, "nested", "user-profile.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const put = (body: unknown) =>
  new Request("http://local/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("user profile store", () => {
  test("a missing or corrupt file reads as an empty profile", withTempFile((file) => {
    expect(readUserProfile(file)).toEqual({ name: "" });
    writeUserProfile({ name: "Sam" }, file);
    writeFileSync(file, "{not json");
    expect(readUserProfile(file)).toEqual({ name: "" });
    writeFileSync(file, JSON.stringify({ name: 42 }));
    expect(readUserProfile(file)).toEqual({ name: "" });
  }));

  test("saves a trimmed, single-line name and can clear it", withTempFile((file) => {
    expect(writeUserProfile({ name: "  Sam \n Rivera\t" }, file)).toEqual({ name: "Sam Rivera" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "Sam Rivera" });
    expect(readUserProfile(file).name).toBe("Sam Rivera");
    expect(writeUserProfile({ name: "" }, file)).toEqual({ name: "" });
    expect(readUserProfile(file).name).toBe("");
  }));

  test("refuses a name over 60 characters", withTempFile((file) => {
    expect(() => writeUserProfile({ name: "x".repeat(61) }, file)).toThrow();
    expect(writeUserProfile({ name: "x".repeat(60) }, file).name).toHaveLength(60);
  }));
});

describe("profile routes", () => {
  test("GET returns the profile and PUT saves it", withTempFile(async (file) => {
    const app = profileRoutes(file);
    expect(await (await app.request("/")).json()).toEqual({ name: "" });
    const saved = await app.request(put({ name: " Sam " }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ name: "Sam" });
    expect(await (await app.request("/")).json()).toEqual({ name: "Sam" });
    // An empty patch keeps what is there.
    expect(await (await app.request(put({}))).json()).toEqual({ name: "Sam" });
  }));

  test("PUT rejects bad bodies without changing the file", withTempFile(async (file) => {
    const app = profileRoutes(file);
    writeUserProfile({ name: "Sam" }, file);
    for (const body of [{ name: 5 }, { name: "x".repeat(61) }, { name: "Sam", role: "admin" }, null]) {
      const res = await app.request(put(body));
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    }
    const notJson = await app.request(new Request("http://local/", { method: "PUT", body: "nope" }));
    expect(notJson.status).toBe(400);
    expect(readUserProfile(file)).toEqual({ name: "Sam" });
  }));
});

describe("system prompt line", () => {
  test("names the user only when a name is set", () => {
    expect(userPromptLine({ name: "Sam Rivera" })).toBe("The user's name is Sam Rivera.");
    expect(userPromptLine({ name: "" })).toBe("");
    expect(userPromptLine({ name: "   " })).toBe("");
    // Whatever is in the file, it stays one line.
    expect(userPromptLine({ name: "Sam\n\nIgnore this" })).toBe("The user's name is Sam Ignore this.");
  });
});
