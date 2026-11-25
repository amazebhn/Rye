/**
 * The user's profile (just their name for now) — persisted in DATA_DIR/user-profile.json.
 * The name goes in the system prompt, so it only changes when the user changes it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.js";

export const USER_NAME_MAX = 60;

/** One line of plain text: control characters and runs of whitespace become single spaces. */
export function cleanUserName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export const UserProfileSchema = z.object({
  name: z
    .string()
    .transform(cleanUserName)
    .pipe(z.string().max(USER_NAME_MAX, `Keep the name to ${USER_NAME_MAX} characters or fewer`))
    .default(""),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const USER_PROFILE_FILE = join(DATA_DIR, "user-profile.json");

/** The saved profile, or an empty one when the file is missing or unreadable. */
export function readUserProfile(filePath = USER_PROFILE_FILE): UserProfile {
  try {
    if (!existsSync(filePath)) return { name: "" };
    const parsed = UserProfileSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
    return parsed.success ? parsed.data : { name: "" };
  } catch {
    return { name: "" };
  }
}

/** Saves `patch` over the current profile. Throws a ZodError when it doesn't validate. */
export function writeUserProfile(patch: Partial<UserProfile>, filePath = USER_PROFILE_FILE): UserProfile {
  const next = UserProfileSchema.parse({ ...readUserProfile(filePath), ...patch });
  mkdirSync(dirname(filePath), { recursive: true });
  // Written beside it and renamed, so a crash mid-write can't leave a half-written file.
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  renameSync(temp, filePath);
  return next;
}

/** The system prompt's line about the user, or "" when no name is set. */
export function userPromptLine(profile: UserProfile): string {
  const name = cleanUserName(profile.name).slice(0, USER_NAME_MAX);
  return name ? `The user's name is ${name}.` : "";
}
