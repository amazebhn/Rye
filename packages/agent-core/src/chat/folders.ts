import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.js";

const FOLDERS_FILE = join(DATA_DIR, "chat-folders.json");
export const MAX_FOLDER_NAME = 60;
export const MAX_FOLDERS = 100;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ChatFolder {
  id: string;
  name: string;
  createdAt: number;
  order?: number;
}

export class FolderError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export function cleanFolderName(raw: unknown): string {
  if (typeof raw !== "string") throw new FolderError("name must be a string", 400);
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new FolderError("name is required", 400);
  if (name.length > MAX_FOLDER_NAME) throw new FolderError(`name must be at most ${MAX_FOLDER_NAME} characters`, 400);
  if (/[\p{Cc}\p{Cf}]/u.test(name)) throw new FolderError("name contains invalid characters", 400);
  return name;
}

function normalizeFolder(raw: unknown): ChatFolder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, name, createdAt, order } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof name !== "string" || !name.trim()) return null;
  return {
    id,
    name: name.trim().slice(0, MAX_FOLDER_NAME),
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now(),
    ...(typeof order === "number" && Number.isFinite(order) ? { order } : {}),
  };
}

function sortFolders(folders: ChatFolder[]): ChatFolder[] {
  return [...folders].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt - b.createdAt);
}

export class ChatFolderStore {
  private cache: ChatFolder[] | null = null;

  constructor(private readonly filePath = FOLDERS_FILE) {}

  private load(): ChatFolder[] {
    if (this.cache) return this.cache;
    try {
      const parsed = existsSync(this.filePath) ? (JSON.parse(readFileSync(this.filePath, "utf8")) as { folders?: unknown }) : {};
      const byId = new Map<string, ChatFolder>();
      for (const raw of Array.isArray(parsed.folders) ? parsed.folders : []) {
        const folder = normalizeFolder(raw);
        if (folder && !byId.has(folder.id)) byId.set(folder.id, folder);
      }
      this.cache = sortFolders([...byId.values()]);
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private flush(folders: ChatFolder[]): void {
    this.cache = sortFolders(folders);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ folders: this.cache }), "utf8");
  }

  private assertUniqueName(name: string, exceptId?: string): void {
    const key = name.toLocaleLowerCase();
    if (this.load().some((f) => f.id !== exceptId && f.name.toLocaleLowerCase() === key)) {
      throw new FolderError(`A folder named "${name}" already exists`, 409);
    }
  }

  list(): ChatFolder[] {
    return this.load();
  }

  get(id: string): ChatFolder | null {
    return this.load().find((f) => f.id === id) ?? null;
  }

  create(rawName: unknown): ChatFolder {
    const name = cleanFolderName(rawName);
    this.assertUniqueName(name);
    if (this.load().length >= MAX_FOLDERS) throw new FolderError(`At most ${MAX_FOLDERS} folders`, 400);
    const folder: ChatFolder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    this.flush([...this.load(), folder]);
    return folder;
  }

  update(id: string, patch: { name?: unknown; order?: unknown }): ChatFolder {
    const current = this.get(id);
    if (!current) throw new FolderError("Folder not found", 404);
    const next = { ...current };
    if (patch.name !== undefined) {
      next.name = cleanFolderName(patch.name);
      this.assertUniqueName(next.name, id);
    }
    if (patch.order !== undefined) {
      if (typeof patch.order !== "number" || !Number.isInteger(patch.order) || Math.abs(patch.order) > 1e6) {
        throw new FolderError("order must be an integer", 400);
      }
      next.order = patch.order;
    }
    this.flush(this.load().map((f) => (f.id === id ? next : f)));
    return next;
  }

  remove(id: string): boolean {
    const current = this.load();
    if (!current.some((f) => f.id === id)) return false;
    this.flush(current.filter((f) => f.id !== id));
    return true;
  }
}
