/**
 * Agent avatar files — profile images too large to embed in the agent record
 * are stored on disk and served at /agents/avatars/<file>. The agent's
 * avatar.value is then that URL instead of a base64 data URI.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AVATAR_URL_PREFIX = "/agents/avatars/";
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
// Uploads are kept this long without an agent using them, so an open editor doesn't lose its image.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

// SVG is left out on purpose: served from the app's origin it could run script.
const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
type AvatarExt = keyof typeof TYPES;

const FILE_NAME = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

/** Image type from the file's leading bytes, ignoring whatever the client claimed. */
export function sniffImage(bytes: Uint8Array): AvatarExt | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Store an image under its content hash and return the URL to use as avatar.value. */
export function saveAvatar(dir: string, bytes: Uint8Array): { url: string } | { error: string } {
  if (bytes.length === 0) return { error: "Empty upload" };
  if (bytes.length > MAX_AVATAR_BYTES) return { error: `Image is larger than ${MAX_AVATAR_BYTES / 1024 / 1024} MB` };
  const ext = sniffImage(bytes);
  if (!ext) return { error: "Unsupported image type (use PNG, JPEG, GIF or WebP)" };
  const name = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return { url: `${AVATAR_URL_PREFIX}${name}` };
}

/** Path and content type of a stored avatar, or null for an unknown or malformed name. */
export function findAvatar(dir: string, name: string): { path: string; contentType: string } | null {
  if (!FILE_NAME.test(name)) return null;
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  return { path, contentType: TYPES[name.split(".")[1] as AvatarExt] };
}

/** Delete stored avatars no agent uses any more. */
export function pruneAvatars(dir: string, avatarValues: string[], now = Date.now()): void {
  if (!existsSync(dir)) return;
  const used = new Set(avatarValues.filter((v) => v.startsWith(AVATAR_URL_PREFIX)).map((v) => v.slice(AVATAR_URL_PREFIX.length)));
  for (const name of readdirSync(dir)) {
    if (!FILE_NAME.test(name) || used.has(name)) continue;
    try {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > ORPHAN_GRACE_MS) unlinkSync(path);
    } catch {
      // Already removed, or unreadable; try again next time.
    }
  }
}
