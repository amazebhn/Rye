import { Hono } from "hono";
import { UserProfileSchema, USER_PROFILE_FILE, readUserProfile, writeUserProfile } from "./store.js";

const ProfilePatchSchema = UserProfileSchema.partial().strict();

/** `GET /profile/` and `PUT /profile/` (a partial profile; `{ "name": "" }` clears the name). */
export function profileRoutes(filePath = USER_PROFILE_FILE): Hono {
  const r = new Hono();

  r.get("/", (c) => c.json(readUserProfile(filePath)));

  r.put("/", async (c) => {
    const parsed = ProfilePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid profile" }, 400);
    return c.json(writeUserProfile(parsed.data, filePath));
  });

  return r;
}
