import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChatFolder, ChatRecord } from "../../utils/types";
import { useSyncRefresh } from "../../utils/sync";

const SUGGEST_FOLDERS_KEY = "rye.suggest-folders";
// Lets the titled record's debounced PUT land before the server reads it.
const SUGGEST_DELAY_MS = 1200;
const SUGGEST_TIMEOUT_MS = 25_000;

export function readSuggestFolders(): boolean {
  try {
    return window.localStorage.getItem(SUGGEST_FOLDERS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSuggestFolders(on: boolean) {
  try {
    window.localStorage.setItem(SUGGEST_FOLDERS_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the toggle just won't persist.
  }
}

export async function folderApi<T>(url: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface FolderSuggestion {
  chatId: string;
  folderId: string;
}

export interface CategorizeResponse {
  suggestions: { chat_id: string; folder_id?: string | null; folder_name?: string | null }[];
  new_folders?: string[];
  failed?: boolean;
}

export function useChatFolders(chats: ChatRecord[], setChats: Dispatch<SetStateAction<ChatRecord[]>>) {
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const [queue, setQueue] = useState<FolderSuggestion[]>([]);
  const foldersRef = useRef(folders);
  const chatsRef = useRef(chats);
  useEffect(() => { foldersRef.current = folders; }, [folders]);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  const requestedRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const list = await folderApi<ChatFolder[]>("/chat/folders", "GET");
      if (Array.isArray(list)) setFolders(list);
    } catch {
      // Keep the last known list.
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useSyncRefresh("chats", () => void refresh());

  // Folder fields are server-owned and don't bump updatedAt, so local patches mirror the server.
  const patchChats = useCallback((ids: Iterable<string>, patch: (chat: ChatRecord) => ChatRecord) => {
    const set = new Set(ids);
    if (set.size === 0) return;
    setChats((prev) => prev.map((c) => (set.has(c.id) ? patch(c) : c)));
  }, [setChats]);

  const createFolder = useCallback(async (name: string) => {
    const folder = await folderApi<ChatFolder>("/chat/folders", "POST", { name });
    setFolders((prev) => [...prev.filter((f) => f.id !== folder.id), folder]);
    return folder;
  }, []);

  const renameFolder = useCallback(async (id: string, name: string) => {
    const folder = await folderApi<ChatFolder>(`/chat/folders/${encodeURIComponent(id)}`, "PATCH", { name });
    setFolders((prev) => prev.map((f) => (f.id === id ? folder : f)));
  }, []);

  const deleteFolder = useCallback(async (id: string) => {
    await folderApi(`/chat/folders/${encodeURIComponent(id)}`, "DELETE");
    setFolders((prev) => prev.filter((f) => f.id !== id));
    patchChats(chatsRef.current.filter((c) => c.folderId === id).map((c) => c.id), ({ folderId: _, ...rest }) => rest);
  }, [patchChats]);

  const moveChats = useCallback(async (ids: string[], folderId: string | null) => {
    const { moved } = await folderApi<{ moved: string[] }>("/chat/folders/move", "POST", { chat_ids: ids, folder_id: folderId });
    patchChats(moved, ({ folderId: _, ...rest }) => (folderId ? { ...rest, folderId } : { ...rest, folderSuggestionDismissed: true }));
  }, [patchChats]);

  const dismissSuggestion = useCallback(async (chatId: string) => {
    patchChats([chatId], (c) => ({ ...c, folderSuggestionDismissed: true }));
    await folderApi("/chat/folders/dismiss", "POST", { chat_ids: [chatId] }).catch(() => {});
  }, [patchChats]);

  // Stable so it can be called from App's generateTitle; reads state through refs.
  const suggestFolder = useCallback((chatId: string) => {
    if (requestedRef.current.has(chatId)) return;
    const eligible = () => {
      const chat = chatsRef.current.find((c) => c.id === chatId);
      return readSuggestFolders() && foldersRef.current.length > 0 && !!chat && !chat.folderId && !chat.folderSuggestionDismissed;
    };
    if (!eligible()) return;
    requestedRef.current.add(chatId);
    window.setTimeout(() => {
      if (!eligible()) return;
      void folderApi<CategorizeResponse>("/chat/categorize", "POST", { chat_ids: [chatId] }, AbortSignal.timeout(SUGGEST_TIMEOUT_MS))
        .then((res) => {
          const folderId = res.suggestions?.find((s) => s.chat_id === chatId)?.folder_id;
          if (!folderId || !eligible() || !foldersRef.current.some((f) => f.id === folderId)) return;
          setQueue((prev) => (prev.some((s) => s.chatId === chatId) ? prev : [...prev, { chatId, folderId }]));
        })
        .catch(() => { /* quiet: suggestions are optional */ });
    }, SUGGEST_DELAY_MS);
  }, []);

  // Drop suggestions for chats that were deleted, filed by hand or whose folder is gone.
  useEffect(() => {
    setQueue((prev) => {
      const next = prev.filter((s) => {
        const chat = chats.find((c) => c.id === s.chatId);
        return chat && !chat.folderId && !chat.folderSuggestionDismissed && folders.some((f) => f.id === s.folderId);
      });
      return next.length === prev.length ? prev : next;
    });
  }, [chats, folders]);

  const resolveSuggestion = useCallback((suggestion: FolderSuggestion, accept: boolean) => {
    setQueue((prev) => prev.filter((s) => s !== suggestion));
    if (accept) void moveChats([suggestion.chatId], suggestion.folderId).catch(() => {});
    else void dismissSuggestion(suggestion.chatId);
  }, [moveChats, dismissSuggestion]);

  return {
    folders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveChats,
    suggestFolder,
    suggestion: queue[0] ?? null,
    resolveSuggestion,
  };
}
