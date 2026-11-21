/** Chat folder + categorize routes (mounted at /chat). */

import { Hono, type Context } from "hono";
import type { ChatHistoryRecord, ChatStore } from "./store.js";
import { cleanFolderName, FolderError, ID_PATTERN, type ChatFolderStore } from "./folders.js";
import { MAX_PROPOSED_FOLDERS, proposeFolders, suggestFolders, type CategorizeOptions } from "./categorize.js";

const MAX_MOVE_IDS = 200;
const MAX_CATEGORIZE_IDS = 25;

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new FolderError("Expected a JSON object body", 400);
  return body as Record<string, unknown>;
}

function idList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) throw new FolderError(`chat_ids must be an array of 1-${max} ids`, 400);
  if (!raw.every((id) => typeof id === "string" && ID_PATTERN.test(id))) throw new FolderError("chat_ids contains an invalid id", 400);
  return [...new Set(raw as string[])];
}

function folderIdParam(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!ID_PATTERN.test(id)) throw new FolderError("Invalid folder id", 400);
  return id;
}

function validNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_PROPOSED_FOLDERS).flatMap((name) => {
    try {
      return [cleanFolderName(name)];
    } catch {
      return [];
    }
  });
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof FolderError) return c.json({ error: err.message }, err.status);
  console.error("[chat-folders] unexpected error", err);
  return c.json({ error: "Internal error" }, 500);
}

export function chatFolderRoutes(chats: ChatStore, folders: ChatFolderStore, categorize: CategorizeOptions = {}): Hono {
  const r = new Hono();

  r.get("/folders", (c) => c.json(folders.list()));

  r.post("/folders", async (c) => {
    try {
      const body = await readBody(c);
      return c.json(folders.create(body.name), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Fixed paths before /folders/:id.
  r.post("/folders/move", async (c) => {
    try {
      const body = await readBody(c);
      const ids = idList(body.chat_ids, MAX_MOVE_IDS);
      const folderId = body.folder_id;
      if (folderId !== null && (typeof folderId !== "string" || !folders.get(folderId))) {
        throw new FolderError("folder_id must be an existing folder id or null", 400);
      }
      // Unfiling by hand means the user wants the chat unfiled, so it's never suggested again.
      const moved = chats.setFolderFields(ids, folderId ? { folderId } : { folderId: undefined, folderSuggestionDismissed: true });
      return c.json({ moved });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  r.post("/folders/dismiss", async (c) => {
    try {
      const body = await readBody(c);
      const dismissed = chats.setFolderFields(idList(body.chat_ids, MAX_MOVE_IDS), { folderSuggestionDismissed: true });
      return c.json({ dismissed });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  r.patch("/folders/:id", async (c) => {
    try {
      const id = folderIdParam(c);
      const body = await readBody(c);
      return c.json(folders.update(id, { name: body.name, order: body.order }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  r.delete("/folders/:id", (c) => {
    try {
      const id = folderIdParam(c);
      if (!folders.remove(id)) throw new FolderError("Folder not found", 404);
      return c.json({ status: "deleted", id, unfiled: chats.unfileFolder(id) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Suggests existing folders for unfiled chats; with `propose` and no folders yet, proposes new folder names.
  // Model failures return no suggestions with `failed: true`, never an error status.
  r.post("/categorize", async (c) => {
    let body: Record<string, unknown>;
    let ids: string[];
    try {
      body = await readBody(c);
      ids = idList(body.chat_ids, MAX_CATEGORIZE_IDS);
    } catch (err) {
      return errorResponse(c, err);
    }
    const candidates = ids
      .map((id) => chats.get(id))
      .filter((chat): chat is ChatHistoryRecord => chat !== null && !chat.folderId);
    const existing = folders.list();

    if (body.propose === true && existing.length === 0) {
      const proposed = validNames(body.proposed);
      try {
        const result = await proposeFolders(candidates, proposed, categorize);
        return c.json({
          new_folders: result.folders,
          suggestions: candidates.map((chat, i) => ({ chat_id: chat.id, folder_name: result.assignments[i] })),
        });
      } catch (err) {
        console.warn("[chat-folders] propose failed", err instanceof Error ? err.message : err);
        return c.json({ new_folders: proposed, suggestions: [], failed: true });
      }
    }

    try {
      const picks = await suggestFolders(candidates, existing, categorize);
      return c.json({ suggestions: candidates.map((chat, i) => ({ chat_id: chat.id, folder_id: picks[i] })) });
    } catch (err) {
      console.warn("[chat-folders] categorize failed", err instanceof Error ? err.message : err);
      return c.json({ suggestions: [], failed: true });
    }
  });

  return r;
}
