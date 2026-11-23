import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRoutes } from "../src/agents/routes.js";
import { AgentStore } from "../src/agents/store.js";
import { MAX_AVATAR_BYTES, pruneAvatars, sniffImage } from "../src/agents/avatars.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 9, 9]);

let dir: string;
let store: AgentStore;
let app: ReturnType<typeof agentRoutes>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rye-avatars-"));
  store = new AgentStore(join(dir, "agents.db"));
  app = agentRoutes(store, { avatarDir: join(dir, "avatars") });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const upload = (bytes: Uint8Array) => app.request("/avatars", { method: "POST", body: bytes });

describe("agent avatar files", () => {
  test("an uploaded image is served back from the returned URL", async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/agents\/avatars\/[a-f0-9]{64}\.png$/);

    const served = await app.request(url.replace("/agents", ""));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // The URL is accepted as an agent's avatar value.
    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Pat", instructions: "help", avatar: { kind: "image", value: url } }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { avatar: { value: string } }).avatar.value).toBe(url);
  });

  test("non-images, oversized uploads and bad names are rejected", async () => {
    expect((await upload(new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(400);
    expect((await upload(new Uint8Array(0))).status).toBe(400);
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(PNG);
    expect((await upload(big)).status).toBeGreaterThanOrEqual(400);
    expect((await app.request("/avatars/..%2Fagents.db")).status).toBe(404);
    expect((await app.request(`/avatars/${"a".repeat(64)}.png`)).status).toBe(404);
  });

  test("files no agent uses are pruned once they are old enough", async () => {
    const used = ((await (await upload(PNG)).json()) as { url: string }).url;
    const unused = ((await (await upload(GIF)).json()) as { url: string }).url;
    const avatars = join(dir, "avatars");
    expect(readdirSync(avatars).length).toBe(2);

    // Fresh uploads survive, so an open editor keeps its image.
    pruneAvatars(avatars, [used]);
    expect(readdirSync(avatars).length).toBe(2);

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of readdirSync(avatars)) utimesSync(join(avatars, name), old, old);
    pruneAvatars(avatars, [used]);
    expect(existsSync(join(avatars, used.split("/").pop()!))).toBe(true);
    expect(existsSync(join(avatars, unused.split("/").pop()!))).toBe(false);
  });

  test("sniffImage reads the type from the bytes", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(GIF)).toBe("gif");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImage(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("hello"))).toBeNull();
  });
});
