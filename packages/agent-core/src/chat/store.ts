import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingPrompt, PromptType } from "@rye/shared";
import { DATA_DIR } from "../config.js";

const CHAT_HISTORY_FILE = join(DATA_DIR, "chats.json");
const MAX_STORED = 50;

export interface ChatHistoryRecord {
  id: string;
  title: string;
  sessionId: string;
  messages: unknown[];
  updatedAt: number;
  model?: string;
  pendingPrompt?: PendingPrompt;
  env?: string;
  unread?: boolean;
  folderId?: string;
  folderSuggestionDismissed?: boolean;
  agentId?: string;
}

// Changed only through the folder endpoints; client record writes keep the stored values.
type FolderFields = Pick<ChatHistoryRecord, "folderId" | "folderSuggestionDismissed">;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePendingPrompt(raw: unknown): PendingPrompt | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" ? raw.id : null;
  const type = raw.type;
  const question = typeof raw.question === "string" ? raw.question : null;
  const options = raw.options === undefined
    ? undefined
    : (Array.isArray(raw.options) && raw.options.every((option) => typeof option === "string")
      ? raw.options
      : null);

  const validTypes: PromptType[] = ["yesno", "choice", "text"];
  if (!id || !question || !validTypes.includes(type as PromptType) || options === null) return undefined;
  return { id, type: type as PromptType, question, options, ...(raw.multiSelect === true ? { multiSelect: true } : {}) };
}

function normalizeChat(raw: unknown): ChatHistoryRecord | null {
  if (!isObject(raw)) return null;

  const id = typeof raw.id === "string" ? raw.id : null;
  const title = typeof raw.title === "string" ? raw.title : null;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
    ? raw.updatedAt
    : Date.now();
  const model = typeof raw.model === "string" ? raw.model : undefined;
  const pendingPrompt = normalizePendingPrompt(raw.pendingPrompt);
  const env = typeof raw.env === "string" ? raw.env : undefined;
  const unread = raw.unread === true ? true : undefined;
  const folderId = typeof raw.folderId === "string" && raw.folderId ? raw.folderId : undefined;
  const folderSuggestionDismissed = raw.folderSuggestionDismissed === true ? true : undefined;
  const agentId = typeof raw.agentId === "string" && raw.agentId ? raw.agentId : undefined;

  if (!id || !title || sessionId === null) return null;

  return {
    id,
    title,
    sessionId,
    messages,
    updatedAt,
    model,
    pendingPrompt,
    env,
    unread,
    folderId,
    folderSuggestionDismissed,
    agentId,
  };
}

function sanitizeChats(rawChats: unknown[]): ChatHistoryRecord[] {
  const seen = new Set<string>();
  const normalized = rawChats
    .map(normalizeChat)
    .filter((chat): chat is ChatHistoryRecord => chat !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Filed chats and dedicated agent chats don't count toward the unfiled cap.
  const deduped: ChatHistoryRecord[] = [];
  let unfiled = 0;
  for (const chat of normalized) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    if (!chat.folderId && !chat.agentId && ++unfiled > MAX_STORED) continue;
    deduped.push(chat);
  }

  return deduped;
}

function parseStoredChats(raw: string): ChatHistoryRecord[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return sanitizeChats(parsed);
    if (isObject(parsed) && Array.isArray(parsed.chats)) return sanitizeChats(parsed.chats);
    return [];
  } catch {
    return [];
  }
}

export class ChatStore {
  // Loaded once then kept in sync, so per-chat writes don't re-parse the file.
  private cache: ChatHistoryRecord[] | null = null;
  private readonly deletedIds = new Set<string>();

  constructor(private readonly filePath = CHAT_HISTORY_FILE) {}

  private load(): ChatHistoryRecord[] {
    if (this.cache) return this.cache;
    try {
      if (!existsSync(this.filePath)) {
        this.cache = [];
      } else {
        this.cache = parseStoredChats(readFileSync(this.filePath, "utf8"));
      }
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private flush(chats: ChatHistoryRecord[]): ChatHistoryRecord[] {
    this.cache = chats;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(chats), "utf8");
    } catch {
      // Ignore persistence errors; callers still get normalized in-memory result.
    }
    return chats;
  }

  list(): ChatHistoryRecord[] {
    return this.load();
  }

  get(id: string): ChatHistoryRecord | null {
    return this.load().find((chat) => chat.id === id) ?? null;
  }

  isDeleted(id: string): boolean {
    return this.deletedIds.has(id);
  }

  private folderFields(id: string): FolderFields {
    const stored = this.get(id);
    return { folderId: stored?.folderId, folderSuggestionDismissed: stored?.folderSuggestionDismissed };
  }

  upsert(raw: unknown): ChatHistoryRecord | null {
    const parsed = normalizeChat(raw);
    if (!parsed || this.deletedIds.has(parsed.id)) return null;
    const chat = { ...parsed, ...this.folderFields(parsed.id) };
    const rest = this.load().filter((c) => c.id !== chat.id);
    this.flush(sanitizeChats([chat, ...rest]));
    return chat;
  }

  /** Sets folder fields on existing chats without touching updatedAt. Returns the ids changed. */
  setFolderFields(ids: readonly string[], fields: FolderFields): string[] {
    const wanted = new Set(ids);
    const changed: string[] = [];
    const next = this.load().map((chat) => {
      if (!wanted.has(chat.id)) return chat;
      changed.push(chat.id);
      return { ...chat, ...fields };
    });
    if (changed.length) this.flush(next);
    return changed;
  }

  unfileFolder(folderId: string): number {
    return this.setFolderFields(this.load().filter((c) => c.folderId === folderId).map((c) => c.id), { folderId: undefined }).length;
  }

  remove(id: string): boolean {
    this.deletedIds.add(id);
    const current = this.load();
    const next = current.filter((c) => c.id !== id);
    if (next.length === current.length) return false;
    this.flush(next);
    return true;
  }

  replace(rawChats: unknown[]): ChatHistoryRecord[] {
    const chats = sanitizeChats(rawChats).filter((chat) => !this.deletedIds.has(chat.id));
    return this.flush(sanitizeChats(chats.map((chat) => ({ ...chat, ...this.folderFields(chat.id) }))));
  }
}