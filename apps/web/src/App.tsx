import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { PendingPrompt, SSEEvent } from "@rye/shared";

import type { AgentRecord, ChatRecord, MessageMeta, RenderMessage } from "./utils/types";
import { isPermissionPrompt } from "./utils/approval";
import { onSyncMessage, publish, useSyncRefresh } from "./utils/sync";
import { useSops } from "./contexts/SopContext";
import { useSkills } from "./contexts/SkillContext";
import { useMemories } from "./contexts/MemoryContext";
import { useAgents } from "./contexts/AgentContext";
import { useEnv } from "./contexts/EnvContext";
import Sidebar from "./components/shell/Sidebar";
import ChatHeader from "./components/chat/ChatHeader";
import MessageList from "./components/chat/MessageList";
import MessageInput from "./components/chat/MessageInput";
import SopPanel from "./components/sops/SopPanel";
import SkillPanel from "./components/skills/SkillPanel";
import MemoryPanel from "./components/memory/MemoryPanel";
import AgentPanel from "./components/agents/AgentPanel";
import SettingsPanel from "./components/settings/SettingsPanel";
import { ChatExamples, ChatHero } from "./components/chat/ChatHome";
import ResultTable from "./components/results/ResultTable";
import ArtifactSheet from "./components/artifacts/ArtifactSheet";
import FolderSuggestionToast from "./components/shell/FolderSuggestionToast";
import { useChatFolders } from "./components/shell/useChatFolders";

const HANDOFF_PROMPT =
  "Write a handoff doc for this conversation as a Markdown file named handoff, so another engineer (or their AI agent) can pick it up cold. " +
  "Make it self-contained: no references to \"above\" or \"earlier\". Include the problem and its impact, the environment and systems involved, " +
  "what was investigated in order, key findings with the exact evidence (queries, log lines, IDs, timestamps, error messages), what was ruled out, " +
  "the current hypothesis and how confident you are, open questions, and next steps with the exact commands or queries to run.";

// Lazy so recharts only loads when Analytics is opened.
const AnalyticsPanel = React.lazy(() => import("./components/analytics/AnalyticsPanel"));

// ---------------------------------------------------------------------------
// Chat history persistence (server-backed)
// ---------------------------------------------------------------------------

const MAX_STORED = 50;
const SYNC_DEBOUNCE_MS = 400;
const ACTIVE_CHAT_STORAGE_KEY = "rye.active-chat-id";

function readActiveChatId(): string | undefined {
  try {
    return window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const DRAFTS_STORAGE_KEY = "rye.drafts";
// Draft key for a new chat that has no id yet.
const NEW_CHAT_DRAFT = "new";
const MAX_PERSISTED_DRAFT = 20_000;

function readDrafts(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""),
    );
  } catch {
    return {};
  }
}

function chatIdFromPath(pathname: string): string | undefined {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function chatPath(chatId: string | undefined): string {
  return chatId ? `/c/${encodeURIComponent(chatId)}` : "/";
}

function navigate(path: string, mode: "push" | "replace" = "push") {
  if (window.location.pathname === path) return;
  if (mode === "replace") window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
}

// Mirrors the server: filed chats and dedicated agent chats don't count toward the cap.
function normalizeChats(chats: ChatRecord[]): ChatRecord[] {
  let unfiled = 0;
  return [...chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c) => !!c.folderId || !!c.agentId || ++unfiled <= MAX_STORED);
}

function sameChat(a: ChatRecord, b: ChatRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A message typed while its chat's run is streaming, bound to the chat it was written in.
interface QueuedMessage {
  text: string;
  chatId: string;
  model: string | undefined;
}

// Live state of one chat's run. Kept with `running: false` when the run ends on a prompt.
interface ChatRun {
  controller: AbortController;
  running: boolean;
  sessionId: string | undefined;
  messages: RenderMessage[];
  prompt: PendingPrompt | null;
  contextPct: number | undefined;
  // Seeds env/model on the chat record if the run creates it.
  env: string | undefined;
  model: string | undefined;
}

type Panel = "home" | "chat" | "sops" | "skills" | "memory" | "agents" | "analytics" | "settings";

function markLastPaused(msgs: RenderMessage[]): RenderMessage[] {
  return msgs.map((m, i, arr) => (i === arr.length - 1 ? { ...m, paused: true } : m));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { refreshSops } = useSops();
  const { refreshSkills } = useSkills();
  const { refreshMemories, refreshKnowledge } = useMemories();
  const { agentById, registerNavHandlers } = useAgents();
  const { envs, activeEnv: defaultEnv, switchEnv } = useEnv();
  const envsRef = useRef(envs);
  useEffect(() => { envsRef.current = envs; }, [envs]);
  const defaultEnvKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => { defaultEnvKeyRef.current = defaultEnv?.key; }, [defaultEnv?.key]);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const chatFolders = useChatFolders(chats, setChats);
  const { suggestFolder } = chatFolders;
  const [chatsHydrated, setChatsHydrated] = useState(false);
  // Track whether the initial GET succeeded so we never PUT an empty list on a fetch failure.
  const chatsFetchOk = useRef(false);
  // Last state successfully handed to the server, keyed by chat id.
  const persistedRef = useRef<Map<string, ChatRecord>>(new Map());
  // Last /chat/history snapshot; records adopted from it are already on the server.
  const remoteRef = useRef<Map<string, ChatRecord>>(new Map());
  // The URL wins; the stored id is only a fallback when the URL names no chat.
  const [activeChatId, setActiveChatId] = useState<string | undefined>(
    () => chatIdFromPath(window.location.pathname) ?? readActiveChatId(),
  );
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => { activeChatIdRef.current = activeChatId; }, [activeChatId]);
  // Source of truth for runs is the ref (read synchronously by streams); `runs` mirrors it for rendering.
  const runsRef = useRef(new Map<string, ChatRun>());
  const [runs, setRuns] = useState<Readonly<Record<string, ChatRun>>>({});
  const commitRuns = useCallback(() => setRuns(Object.fromEntries(runsRef.current)), []);
  // Chats other tabs are running, keyed by tab id.
  const [remoteRuns, setRemoteRuns] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const remoteRunningIds = useMemo(() => new Set([...remoteRuns.values()].flat()), [remoteRuns]);
  const remoteRunningIdsRef = useRef(remoteRunningIds);
  useEffect(() => { remoteRunningIdsRef.current = remoteRunningIds; }, [remoteRunningIds]);
  const [settingsKey, setSettingsKey] = useState(0);
  // Unsent composer text per chat id (or NEW_CHAT_DRAFT).
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts);
  const draftKey = activeChatId ?? NEW_CHAT_DRAFT;
  const input = drafts[draftKey] ?? "";
  const setDraft = useCallback((key: string, text: string) => {
    setDrafts((prev) => {
      if ((prev[key] ?? "") === text) return prev;
      const next = { ...prev };
      if (text) next[key] = text;
      else delete next[key];
      return next;
    });
  }, []);
  const setInput = (text: string) => setDraft(draftKey, text);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const updateQueue = useCallback((fn: (q: QueuedMessage[]) => QueuedMessage[]) => {
    messageQueueRef.current = fn(messageQueueRef.current);
    setMessageQueue(messageQueueRef.current);
  }, []);
  const [pendingContext, setPendingContext] = useState<string | undefined>();
  // Model for the active chat. Sent with each /chat request so what the
  // dropdown shows is exactly what the session uses (no hidden global drift).
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const selectedModelRef = useRef<string | undefined>(undefined);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewingResult, setViewingResult] = useState<{ id: string; sessionId: string } | null>(null);
  const [viewingArtifact, setViewingArtifact] = useState<{ id: string; sessionId: string; version: number } | null>(null);
  const closeArtifact = useCallback(() => setViewingArtifact(null), []);
  const [activePanel, setActivePanel] = useState<Panel>("chat");
  const activePanelRef = useRef(activePanel);
  useEffect(() => { activePanelRef.current = activePanel; }, [activePanel]);
  const deletedChatIdsRef = useRef(new Set<string>());
  const chatsRef = useRef<ChatRecord[]>([]);
  useEffect(() => { chatsRef.current = chats; }, [chats]);

  const activeChat = chats.find((c) => c.id === activeChatId);
  const activeRun = activeChatId ? runs[activeChatId] : undefined;
  // Another tab owns this chat's run; show it as busy here but never mirror its stream.
  const remoteRunning = Boolean(activeChatId && !activeRun?.running && remoteRunningIds.has(activeChatId));
  const loading = Boolean(activeRun?.running) || remoteRunning;
  const isViewingInflight = Boolean(activeRun);
  const displayMessages: RenderMessage[] = activeRun ? activeRun.messages : (activeChat?.messages ?? []);
  const displaySessionId = activeRun ? activeRun.sessionId : activeChat?.sessionId;
  const visiblePrompt = activeRun ? activeRun.prompt : (activeChat?.pendingPrompt ?? null);
  const contextPct = activeRun?.contextPct;
  const activeQueue = messageQueue.filter((m) => m.chatId === activeChatId);
  const runningChatIds = useMemo(
    () => new Set(Object.keys(runs).filter((id) => runs[id].running)),
    [runs],
  );
  const sidebarRunningIds = useMemo(
    () => (remoteRunningIds.size ? new Set([...runningChatIds, ...remoteRunningIds]) : runningChatIds),
    [runningChatIds, remoteRunningIds],
  );
  // Stable across token updates, so presence is only announced when the set changes.
  const runningKey = [...runningChatIds].sort().join("\n");
  const chatOnScreen = activePanel === "chat" ? activeChatId : undefined;
  const pickerEnvKey =
    (chatOnScreen ? (activeChat?.env ?? activeRun?.env) : undefined) ?? defaultEnv?.key;

  // Opening a chat clears its unread flag.
  useEffect(() => {
    if (activePanel !== "chat" || !activeChat?.unread) return;
    const id = activeChat.id;
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, unread: undefined } : c)));
  }, [activePanel, activeChat?.id, activeChat?.unread]);

  useEffect(() => {
    try {
      if (activeChatId) window.localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChatId);
      else window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
    } catch {
      // History still works when storage is unavailable (for example, privacy mode).
    }
  }, [activeChatId]);

  useEffect(() => {
    try {
      const kept = Object.entries(drafts).filter(([, text]) => text.length <= MAX_PERSISTED_DRAFT);
      if (kept.length) window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
      else window.localStorage.removeItem(DRAFTS_STORAGE_KEY);
    } catch {
      // Drafts still live in memory when storage is unavailable or full.
    }
  }, [drafts]);

  // Back/forward switches chats; "/" is a new chat.
  useEffect(() => {
    const onPopState = () => {
      const id = chatIdFromPath(window.location.pathname);
      const chat = id ? chatsRef.current.find((c) => c.id === id) : undefined;
      const run = id ? runsRef.current.get(id) : undefined;
      setActivePanel("chat");
      setPendingContext(undefined);
      if (id && (chat || run)) {
        setActiveChatId(id);
        setSelectedModel(chat?.model ?? run?.model);
        return;
      }
      if (id) navigate("/", "replace");
      setActiveChatId(undefined);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!chatsHydrated || !activeChat || selectedModelRef.current !== undefined) return;
    setSelectedModel(activeChat.model);
  }, [activeChat, chatsHydrated]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/chat/history")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ChatRecord[]>;
      })
      .then((loaded) => {
        if (cancelled) return;
        chatsFetchOk.current = true;
        const normalized = normalizeChats(Array.isArray(loaded) ? loaded : []);
        // Seed the sync baseline so hydration doesn't re-upload what we just read.
        persistedRef.current = new Map(normalized.map((c) => [c.id, c]));
        remoteRef.current = new Map(normalized.map((c) => [c.id, c]));
        setChats(normalized);
        const known = (id: string) => normalized.some((chat) => chat.id === id) || runsRef.current.has(id);
        const urlChatId = chatIdFromPath(window.location.pathname);
        const current = activeChatIdRef.current;
        let next: string | undefined;
        if (urlChatId !== undefined) next = known(urlChatId) ? urlChatId : undefined;
        else next = current && known(current) ? current : normalized.find((chat) => chat.pendingPrompt)?.id;
        setActiveChatId(next);
        navigate(chatPath(next), "replace");
        setDrafts((prev) => {
          const kept = Object.entries(prev).filter(([key]) => key === NEW_CHAT_DRAFT || known(key));
          return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Don't call setChats([]) here — a fetch failure should never wipe persisted data.
        // Leave chats as [] (the initial state) and mark hydrated so the UI unblocks.
      })
      .finally(() => {
        if (!cancelled) setChatsHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist only what actually changed. Records are replaced immutably, so a
  // reference diff against the last-synced snapshot identifies dirty chats.
  useEffect(() => {
    if (!chatsHydrated || !chatsFetchOk.current) return;
    const timer = window.setTimeout(() => {
      const previous = persistedRef.current;
      const next = new Map(chats.map((c) => [c.id, c]));

      for (const chat of chats) {
        if (previous.get(chat.id) === chat || remoteRef.current.get(chat.id) === chat) continue;
        void fetch(`/chat/history/${chat.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chat),
        }).catch(() => {
          // Best-effort persistence; keep UI responsive even if backend is down.
        });
      }

      for (const id of previous.keys()) {
        if (next.has(id)) continue;
        const sessionId = previous.get(id)?.sessionId;
        const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
        void fetch(`/chat/history/${id}${query}`, { method: "DELETE" }).catch(() => {});
      }

      persistedRef.current = next;
    }, SYNC_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [chats, chatsHydrated]);

  // Pull history changed by other tabs. Runs, unsaved edits and drafts in this tab always win.
  const refreshChats = useCallback(async () => {
    if (!chatsFetchOk.current) return;
    let remote: ChatRecord[];
    try {
      const res = await fetch("/chat/history");
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return;
      remote = normalizeChats(data as ChatRecord[]);
    } catch {
      return;
    }
    const before = remoteRef.current;
    const remoteById = new Map(remote.map((c) => [c.id, c]));
    remoteRef.current = remoteById;
    // Only chats the server had before count as deleted elsewhere; a fresh local chat may not be saved yet.
    const gone = (id: string) => before.has(id) && !remoteById.has(id) && !runsRef.current.get(id)?.running;

    // A run parked on a prompt is superseded once another tab answers it or deletes the chat.
    let runsChanged = false;
    for (const [id, run] of runsRef.current) {
      if (run.running) continue;
      const fresh = remoteById.get(id);
      const local = chatsRef.current.find((c) => c.id === id);
      if (gone(id) || (fresh && local && fresh.updatedAt > local.updatedAt)) {
        runsRef.current.delete(id);
        runsChanged = true;
      }
    }
    if (runsChanged) commitRuns();

    setChats((prev) => {
      let changed = false;
      const next: ChatRecord[] = [];
      for (const local of prev) {
        const fresh = remoteById.get(local.id);
        if (!fresh) {
          if (gone(local.id)) changed = true;
          else next.push(local);
          continue;
        }
        const dirty = local !== persistedRef.current.get(local.id) && local !== before.get(local.id);
        // An older server copy means our own save hasn't landed yet.
        if (runsRef.current.has(local.id) || dirty || fresh.updatedAt < local.updatedAt) {
          // Folder fields are server-owned, so they follow the server even when the local record wins.
          if (local.folderId === fresh.folderId && local.folderSuggestionDismissed === fresh.folderSuggestionDismissed) {
            next.push(local);
          } else {
            next.push({ ...local, folderId: fresh.folderId, folderSuggestionDismissed: fresh.folderSuggestionDismissed });
            changed = true;
          }
        } else if (sameChat(local, fresh)) {
          // Keep the existing object so nothing re-renders or re-uploads.
          remoteById.set(local.id, local);
          next.push(local);
        } else {
          next.push(fresh);
          changed = true;
        }
      }
      const localIds = new Set(prev.map((c) => c.id));
      for (const fresh of remote) {
        if (localIds.has(fresh.id) || deletedChatIdsRef.current.has(fresh.id)) continue;
        next.push(fresh);
        changed = true;
      }
      return changed ? normalizeChats(next) : prev;
    });

    const goneIds = new Set([...before.keys()].filter(gone));
    if (goneIds.size === 0) return;
    const active = activeChatIdRef.current;
    updateQueue((q) => q.filter((m) => !goneIds.has(m.chatId)));
    setDrafts((prev) => {
      if (!Object.keys(prev).some((key) => goneIds.has(key))) return prev;
      const next = { ...prev };
      for (const id of goneIds) {
        const text = next[id];
        delete next[id];
        // Unsent text in the chat on screen moves to the new-chat composer instead of vanishing.
        if (id === active && text && !next[NEW_CHAT_DRAFT]) next[NEW_CHAT_DRAFT] = text;
      }
      return next;
    });
    if (active && goneIds.has(active)) {
      setActiveChatId(undefined);
      navigate("/", "replace");
    }
    const goneSessions = new Set([...goneIds].map((id) => before.get(id)?.sessionId).filter(Boolean));
    setViewingResult((v) => (v && goneSessions.has(v.sessionId) ? null : v));
    setViewingArtifact((v) => (v && goneSessions.has(v.sessionId) ? null : v));
  }, [commitRuns, updateQueue]);
  useSyncRefresh("chats", () => void refreshChats());

  useEffect(() => {
    const localRunning = () => [...runsRef.current].filter(([, run]) => run.running).map(([id]) => id);
    // Tab id -> last time it announced; tabs that miss a roll call are dropped (closed or crashed).
    const lastSeen = new Map<string, number>();
    let rollCall: number | undefined;
    const off = onSyncMessage((msg) => {
      if (msg.kind === "hello") {
        publish({ kind: "runs", chatIds: localRunning() });
      } else if (msg.kind === "runs") {
        lastSeen.set(msg.from, Date.now());
        setRemoteRuns((prev) => {
          if (!msg.chatIds.length && !prev.has(msg.from)) return prev;
          const next = new Map(prev);
          if (msg.chatIds.length) next.set(msg.from, msg.chatIds);
          else next.delete(msg.from);
          return next;
        });
      } else if (msg.topic === "settings") {
        setSettingsKey((k) => k + 1);
      }
    });
    const onShow = () => {
      if (document.hidden) return;
      const askedAt = Date.now();
      publish({ kind: "hello" });
      window.clearTimeout(rollCall);
      rollCall = window.setTimeout(() => {
        setRemoteRuns((prev) => {
          const stale = [...prev.keys()].filter((tab) => (lastSeen.get(tab) ?? 0) < askedAt);
          if (!stale.length) return prev;
          const next = new Map(prev);
          for (const tab of stale) next.delete(tab);
          return next;
        });
      }, 1500);
    };
    const onHide = () => publish({ kind: "runs", chatIds: [] });
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pagehide", onHide);
    publish({ kind: "hello" });
    return () => {
      off();
      window.clearTimeout(rollCall);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  useEffect(() => {
    publish({ kind: "runs", chatIds: runningKey ? runningKey.split("\n") : [] });
  }, [runningKey]);

  const upsertChat = useCallback((id: string, sid: string, msgs: RenderMessage[], prompt?: PendingPrompt) => {
    if (deletedChatIdsRef.current.has(id)) return;
    const fallbackTitle = msgs.find((m) => m.role === "user" && !m.kind)?.content.slice(0, 60) ?? "New chat";
    setChats((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      const existing = idx === -1 ? undefined : prev[idx];
      const run = runsRef.current.get(id);
      const record: ChatRecord = {
        ...existing,
        id,
        // Keep an AI-generated or user-renamed title; only untitled chats take the first message.
        title: existing?.title && existing.title !== "New chat" ? existing.title : fallbackTitle,
        sessionId: sid,
        messages: msgs,
        updatedAt: Date.now(),
        // The chat's own model and env win over whatever chat is on screen now.
        model: existing?.model ?? run?.model ?? selectedModelRef.current,
        env: existing?.env ?? run?.env,
        pendingPrompt: prompt,
      };
      if (idx === -1) return [record, ...prev];
      const next = [...prev];
      next[idx] = record;
      next.unshift(next.splice(idx, 1)[0]);
      return next;
    });
  }, []);

  /** Fire-and-forget: generate an AI title and patch the chat record */
  const generateTitle = useCallback((chatId: string, userMsg: string, assistantMsg: string) => {
    void fetch("/chat/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_message: userMsg, assistant_response: assistantMsg }),
    })
      .then((r) => r.json())
      .then((data: { title?: string }) => {
        if (data.title) {
          setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, title: data.title! } : c));
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => suggestFolder(chatId));
  }, [suggestFolder]);

  // Updates chatsRef synchronously too, so a send in the same tick sees the new env.
  const setChatEnv = useCallback((chatId: string, env: string) => {
    const apply = (list: ChatRecord[]) =>
      list.map((c) => (c.id === chatId && c.env !== env ? { ...c, env } : c));
    chatsRef.current = apply(chatsRef.current);
    setChats(apply);
    const run = runsRef.current.get(chatId);
    if (run) runsRef.current.set(chatId, { ...run, env });
  }, []);

  // A stored env that no longer exists in config falls back to the global default.
  function resolveEnv(chatId: string): string | undefined {
    const stored = chatsRef.current.find((c) => c.id === chatId)?.env;
    const known = envsRef.current;
    if (stored && (known.length === 0 || known.some((e) => e.key === stored))) return stored;
    return defaultEnvKeyRef.current;
  }

  function isOnScreen(chatId: string) {
    return activePanelRef.current === "chat" && activeChatIdRef.current === chatId;
  }

  // One POST updates the global default (inherited by new chats); the chat on screen keeps it too.
  function changeEnv(key: string) {
    if (chatOnScreen) setChatEnv(chatOnScreen, key);
    void switchEnv(key);
  }

  function stopActiveRun() {
    if (activeChatId) runsRef.current.get(activeChatId)?.controller.abort();
  }

  function switchToChat(chat: ChatRecord) {
    setActiveChatId(chat.id);
    setActivePanel("chat");
    setPendingContext(undefined);
    setSelectedModel(chat.model);
    navigate(chatPath(chat.id));
  }

  function openAgentChat(agent: AgentRecord) {
    const existing = chatsRef.current.find((c) => c.agentId === agent.id);
    if (existing) {
      switchToChat(existing);
      return;
    }
    const dedicated: ChatRecord = {
      id: `chat_${agent.id}`,
      title: agent.name,
      sessionId: "",
      messages: [],
      updatedAt: Date.now(),
      model: agent.model ?? undefined,
      env: agent.env ?? undefined,
      agentId: agent.id,
    };
    // An agent's chat id is fixed, so a deleted chat comes back under the same id: stop treating it as deleted.
    deletedChatIdsRef.current.delete(dedicated.id);
    setChats((prev) => normalizeChats([dedicated, ...prev]));
    switchToChat(dedicated);
  }

  useEffect(() => {
    registerNavHandlers({
      openChat: openAgentChat,
      openProfile: () => setActivePanel("agents"),
    });
  });

  // Persist a model change immediately so it survives even without sending.
  function changeModel(model: string) {
    setSelectedModel(model);
    if (activeChatId) {
      setChats((prev) => prev.map((c) => (c.id === activeChatId ? { ...c, model } : c)));
    }
  }

  function renameChat(id: string, title: string) {
    setChats((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
  }

  function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    deletedChatIdsRef.current.add(id);
    const deletedSessionId = chats.find((chat) => chat.id === id)?.sessionId;
    const query = deletedSessionId ? `?session_id=${encodeURIComponent(deletedSessionId)}` : "";
    void fetch(`/chat/history/${id}${query}`, { method: "DELETE" }).catch(() => {
      // The history sync effect will retry deletion for persisted chats.
    });
    setChats((prev) => prev.filter((c) => c.id !== id));
    updateQueue((q) => q.filter((m) => m.chatId !== id));
    setDraft(id, "");
    if (activeChatId === id) {
      setActiveChatId(undefined);
      navigate("/", "replace");
    }
    if (viewingResult?.sessionId === deletedSessionId) setViewingResult(null);
    if (viewingArtifact?.sessionId === deletedSessionId) setViewingArtifact(null);
    const run = runsRef.current.get(id);
    if (run) {
      run.controller.abort();
      runsRef.current.delete(id);
      commitRuns();
    }
  }

  function startNewChat(opts?: { display?: string; context?: string }) {
    setPendingContext(opts?.context);
    if (!opts?.display) {
      // No id until the first send, so the new-chat draft and "/" stay shared.
      setActiveChatId(undefined);
      navigate("/");
      return;
    }
    const newChatId = crypto.randomUUID();
    setActiveChatId(newChatId);
    const seed: RenderMessage = { role: "assistant", content: opts.display };
    setChats((prev) => [
      {
        id: newChatId,
        title: "SQL result",
        sessionId: "",
        messages: [seed],
        updatedAt: Date.now(),
        env: defaultEnvKeyRef.current,
      },
      ...prev,
    ]);
    setDraft(newChatId, "What would you like to know about this data?");
    navigate(chatPath(newChatId));
  }

  async function sendMessage(
    overrideText?: string,
    // Queued sends and retries carry their chat's state explicitly so this closure's render state is never read.
    continuation?: { chatId: string; sessionId: string | undefined; baseMessages: RenderMessage[]; model?: string },
    // Index of the user message this send replaces; the server truncates from there first.
    rewindIndex?: number,
    kind?: RenderMessage["kind"],
  ) {
    const text = (overrideText ?? input).trim();
    if (!text) return;
    const chatId = continuation?.chatId ?? activeChatId ?? crypto.randomUUID();
    if (deletedChatIdsRef.current.has(chatId)) return;
    // The backend doesn't guard same-session races, and this tab can't see the other run's end state yet.
    if (!continuation && remoteRunningIdsRef.current.has(chatId) && !runsRef.current.get(chatId)?.running) return;
    // One run per chat (the backend doesn't guard same-session races): queue behind it.
    if (runsRef.current.get(chatId)?.running) {
      if (continuation) {
        updateQueue((q) => [{ text, chatId, model: continuation.model }, ...q]);
      } else {
        if (overrideText === undefined) setDraft(draftKey, "");
        updateQueue((q) => [...q, { text, chatId, model: selectedModelRef.current }]);
      }
      return;
    }
    // Only a composer send consumes the draft; prompt answers, Continue and queued sends leave it.
    if (overrideText === undefined) setDraft(draftKey, "");

    const serverText = pendingContext && !continuation ? `${pendingContext}\n\n${text}` : text;
    if (!continuation) setPendingContext(undefined);

    const controller = new AbortController();
    const startSessionId = continuation ? continuation.sessionId : (displaySessionId || undefined);
    const baseMessages = continuation?.baseMessages ?? displayMessages;
    const model = continuation
      ? (continuation.model ?? chatsRef.current.find((c) => c.id === chatId)?.model ?? selectedModelRef.current)
      : selectedModelRef.current;
    const env = resolveEnv(chatId);
    const chatAgentId = chatsRef.current.find((c) => c.id === chatId)?.agentId;
    const turnId = crypto.randomUUID();
    // Typing "continue" at a paused reply is the same action as the Continue button.
    const turnKind = kind ?? (/^continue[.!]?$/i.test(text) && baseMessages.at(-1)?.paused ? "continue" : undefined);

    const initial: RenderMessage[] = [
      // Sending anything resolves the pause, so retire the Continue button.
      ...baseMessages.map((m) => (m.paused ? { ...m, paused: false } : m)),
      { role: "user", content: text, id: turnId, ...(turnKind ? { kind: turnKind } : {}) },
      { role: "assistant", content: "", toolCalls: [], ...(chatAgentId ? { agentId: chatAgentId } : {}), meta: { startedAt: Date.now(), model, env } },
    ];
    // localMessages is always synchronously up to date, unlike React state, which batches
    // token + done events from the same SSE chunk. Persist from it, never from state.
    let localMessages: RenderMessage[] = initial;
    runsRef.current.set(chatId, {
      controller,
      running: true,
      sessionId: startSessionId,
      messages: initial,
      prompt: null,
      contextPct: runsRef.current.get(chatId)?.contextPct,
      env,
      model,
    });
    commitRuns();
    // Ignores updates once this run no longer owns the chat's entry (deleted or replaced).
    const patchRun = (patch: Partial<ChatRun>) => {
      const cur = runsRef.current.get(chatId);
      if (cur?.controller !== controller) return;
      runsRef.current.set(chatId, { ...cur, ...patch });
      commitRuns();
    };
    const updateMessages = (updater: (prev: RenderMessage[]) => RenderMessage[]) => {
      localMessages = updater(localMessages);
      patchRun({ messages: localMessages });
    };
    const patchMeta = (patch: (meta: MessageMeta) => Partial<MessageMeta>) => {
      updateMessages((prev) =>
        prev.map((m, i, arr) => {
          if (i !== arr.length - 1 || m.role !== "assistant") return m;
          const meta = m.meta ?? { startedAt: Date.now() };
          return { ...m, meta: { ...meta, ...patch(meta) } };
        })
      );
    };
    let sawFirstOutput = false;
    const markFirstOutput = () => {
      if (sawFirstOutput) return;
      sawFirstOutput = true;
      patchMeta(() => ({ firstTokenAt: Date.now() }));
    };
    // Don't yank the user back if they navigated away while the queue drained.
    if (!continuation) {
      setActiveChatId(chatId);
      // A new chat's first send turns "/" into its URL without adding a history entry.
      navigate(chatPath(chatId), "replace");
    }

    let currentSessionId = startSessionId;
    let streamPaused = false;
    let hadPrompt = false;
    let aborted = false;
    let currentPrompt: PendingPrompt | undefined;

    try {
      const resp = await fetch("/chat/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: serverText,
          ...(turnKind === "continue" ? { continue: true } : {}),
          session_id: startSessionId,
          model,
          turn_id: turnId,
          ...(env ? { env } : {}),
          ...(chatAgentId ? { agent_id: chatAgentId } : {}),
          ...(rewindIndex !== undefined ? { rewind: { chat_id: chatId, index: rewindIndex } } : {}),
        }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const detail = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split("\n");
        // Last element is a potentially incomplete line — keep it in the buffer
        sseBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent & {
              name?: string;
              args?: Record<string, unknown>;
            };

            if (event.type === "session" && event.session_id) {
              currentSessionId = event.session_id;
              patchRun({ sessionId: event.session_id });
              upsertChat(chatId, event.session_id, localMessages);
            } else if (event.type === "agent" && event.agent_id) {
              const respondingAgentId = event.agent_id;
              updateMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === "assistant") {
                  updated[updated.length - 1] = { ...last, agentId: respondingAgentId };
                }
                return updated;
              });
            } else if (event.type === "agent_turn_start" && event.agent_id) {
              const nextAgentId = event.agent_id;
              updateMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [],
                  agentId: nextAgentId,
                  meta: { startedAt: Date.now(), model, env },
                },
              ]);
            } else if (event.type === "iter_start") {
              updateMessages((prev) => {
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                const hasTurnContent = last.content.trim() || (last.toolCalls ?? []).length > 0;
                if (hasTurnContent) {
                  last.turns = [...(last.turns ?? []), { thinking: last.content, toolCalls: last.toolCalls ?? [] }];
                  last.content = "";
                  last.toolCalls = [];
                }
                updated[updated.length - 1] = last;
                return updated;
              });
            } else if (event.type === "token" && event.content) {
              markFirstOutput();
              updateMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, content: last.content + event.content };
                return updated;
              });
            } else if (event.type === "tool_start" && event.name) {
              markFirstOutput();
              const name = event.name;
              const args = event.args ?? {};
              updateMessages((prev) => {
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                last.toolCalls = [...(last.toolCalls ?? []), { name, args }];
                updated[updated.length - 1] = last;
                return updated;
              });
            } else if (event.type === "tool_result" && event.name) {
              const name = event.name;
              const content = event.content ?? "";
              if (name === "save_sop_tool") {
                void refreshSops();
                publish({ kind: "changed", topic: "sops" });
              }
              if (name === "save_skill_tool") {
                void refreshSkills();
                publish({ kind: "changed", topic: "skills" });
              }
              if (name === "remember_tool" || name === "forget_tool") {
                void refreshMemories();
                publish({ kind: "changed", topic: "memory" });
              }
              if (name === "save_knowledge_tool" || name === "delete_knowledge_tool") {
                void refreshKnowledge();
                publish({ kind: "changed", topic: "memory" });
              }
              updateMessages((prev) => {
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                const toolCalls = [...(last.toolCalls ?? [])];
                const idx = [...toolCalls].reverse().findIndex(
                  (tc) => tc.name === name && tc.result === undefined
                );
                if (idx !== -1)
                  toolCalls[toolCalls.length - 1 - idx] = {
                    ...toolCalls[toolCalls.length - 1 - idx],
                    result: content,
                  };
                last.toolCalls = toolCalls;
                updated[updated.length - 1] = last;
                return updated;
              });
            } else if (event.type === "usage" && event.context_pct !== undefined) {
              patchRun({ contextPct: event.context_pct });
              patchMeta((meta) => ({
                inputTokens: (meta.inputTokens ?? 0) + (event.input_tokens ?? 0),
                outputTokens: (meta.outputTokens ?? 0) + (event.output_tokens ?? 0),
                llmCalls: (meta.llmCalls ?? 0) + 1,
                // Older servers omit cost_usd entirely; only a null means "no pricing for this model".
                ...(typeof event.cost_usd === "number"
                  ? { costUsd: (meta.costUsd ?? 0) + event.cost_usd }
                  : event.cost_usd === null
                    ? { unpricedCalls: (meta.unpricedCalls ?? 0) + 1 }
                    : {}),
                model: event.model ?? meta.model,
                provider: event.provider ?? meta.provider,
              }));
            } else if (event.type === "iter_summary" && event.content) {
              // Attach the LLM-generated summary to the most recent completed turn
              updateMessages((prev) => {
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                const turns = [...(last.turns ?? [])];
                if (turns.length > 0) {
                  turns[turns.length - 1] = { ...turns[turns.length - 1], summary: event.content };
                  last.turns = turns;
                  updated[updated.length - 1] = last;
                }
                return updated;
              });
            } else if (event.type === "prompt" && event.prompt_type && event.question) {
              hadPrompt = true;
              currentPrompt = {
                id: event.prompt_id ?? crypto.randomUUID(),
                type: event.prompt_type,
                question: event.question,
                options: event.options,
                ...(event.multi_select ? { multiSelect: true } : {}),
              };
              patchRun({ prompt: currentPrompt });
              // Start the history sync immediately rather than waiting for the
              // trailing done event; this makes a prompt durable once rendered.
              upsertChat(chatId, currentSessionId ?? chatId, localMessages, currentPrompt);
            } else if (event.type === "pause") {
              streamPaused = true;
              const rounds = event.rounds ?? 10;
              updateMessages((prev) =>
                prev.map((m, i, arr) => (i === arr.length - 1 ? { ...m, paused: true, pause: { rounds } } : m))
              );
            } else if (event.type === "env_changed" && event.env_key) {
              setChatEnv(chatId, event.env_key);
            } else if (event.type === "error") {
              const errMsg = (event as { error?: string }).error ?? "Unknown error";
              patchMeta(() => ({ finishedAt: Date.now(), status: "error", error: errMsg }));
              // The stream ends after an error without a `done` event, so persist
              // the error into the chat record — otherwise reload shows empty history.
              upsertChat(chatId, currentSessionId ?? chatId, localMessages);
            } else if (event.type === "done") {
              patchMeta(() => ({ finishedAt: Date.now(), status: "done" }));
              const msgs = streamPaused ? markLastPaused(localMessages) : localMessages;
              upsertChat(chatId, currentSessionId!, msgs, currentPrompt);
              // Generate an AI title after the very first exchange
              const userMsgs = msgs.filter((m) => m.role === "user" && !m.kind);
              const asstMsgs = msgs.filter((m) => m.role === "assistant");
              if (!turnKind && !chatAgentId && userMsgs.length === 1) {
                generateTitle(chatId, userMsgs[0].content, asstMsgs[asstMsgs.length - 1]?.content ?? "");
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        aborted = true;
        patchMeta(() => ({ finishedAt: Date.now(), status: "stopped" }));
        // Persist whatever was streamed before the user hit stop
        if (!deletedChatIdsRef.current.has(chatId) && localMessages.length > 0 && currentSessionId) {
          upsertChat(chatId, currentSessionId, localMessages);
        }
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        patchMeta(() => ({ finishedAt: Date.now(), status: "error", error: errMsg }));
        upsertChat(chatId, currentSessionId ?? chatId, localMessages);
      }
    } finally {
      const owned = runsRef.current.get(chatId);
      if (owned?.controller === controller) {
        // A run that ended on a prompt stays visible so the PromptWidget renders until answered.
        if (hadPrompt) runsRef.current.set(chatId, { ...owned, running: false });
        else runsRef.current.delete(chatId);
        commitRuns();
      }
      const deleted = deletedChatIdsRef.current.has(chatId);
      if (!aborted && !deleted && !isOnScreen(chatId)) {
        setChats((prev) => prev.map((c) => (c.id === chatId && !c.unread ? { ...c, unread: true } : c)));
      }
      // Drain this chat's queue only; other chats drain when their own runs finish.
      const next = deleted || hadPrompt ? undefined : messageQueueRef.current.find((m) => m.chatId === chatId);
      if (next) {
        updateQueue((q) => q.filter((m) => m !== next));
        const baseMessages = streamPaused ? markLastPaused(localMessages) : localMessages;
        void sendMessage(next.text, { chatId, sessionId: currentSessionId, baseMessages, model: next.model });
      }
    }
  }

  // Retry and edit: drop the user message at `index` and everything after it, then send `text` in its place.
  function resubmitFrom(index: number, text: string) {
    const trimmed = text.trim();
    // runsRef is set synchronously by sendMessage, so it also blocks a same-frame double click.
    if (
      !trimmed || !activeChatId || runsRef.current.get(activeChatId)?.running ||
      messageQueueRef.current.some((m) => m.chatId === activeChatId)
    ) return;
    if (displayMessages[index]?.role !== "user" || displayMessages[index].kind) return;
    void sendMessage(
      trimmed,
      {
        chatId: activeChatId,
        sessionId: displaySessionId || undefined,
        baseMessages: displayMessages.slice(0, index),
        model: selectedModelRef.current,
      },
      index,
    );
  }

  function answerPrompt(answer: string) {
    const kind = visiblePrompt && isPermissionPrompt(visiblePrompt) ? "approval" : "answer";
    if (activeChatId) {
      const chatId = activeChatId;
      const run = runsRef.current.get(chatId);
      if (run) {
        runsRef.current.set(chatId, { ...run, prompt: null });
        commitRuns();
      }
      setChats((prev) => prev.map((chat) =>
        chat.id === chatId ? { ...chat, pendingPrompt: undefined } : chat
      ));
    }
    void sendMessage(answer, undefined, undefined, kind);
  }

  // While the agent waits on a question, the composer answers it; a permission prompt reads a typed reply as a denial.
  const composerPrompt = !loading && visiblePrompt ? (isPermissionPrompt(visiblePrompt) ? "approval" : "question") : undefined;
  function sendFromComposer() {
    const text = input.trim();
    if (composerPrompt !== "question" || !text) return void sendMessage();
    setDraft(draftKey, "");
    answerPrompt(text);
  }

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          chats={chats}
          folders={chatFolders.folders}
          onCreateFolder={chatFolders.createFolder}
          onRenameFolder={chatFolders.renameFolder}
          onDeleteFolder={chatFolders.deleteFolder}
          onMoveChats={chatFolders.moveChats}
          activeChatId={activeChatId}
          runningChatIds={sidebarRunningIds}
          envKey={pickerEnvKey}
          onEnvChange={changeEnv}
          onNewChat={() => { startNewChat(); setActivePanel("chat"); }}
          onClose={() => setSidebarOpen(false)}
          onSwitch={switchToChat}
          onDelete={deleteChat}
          onRename={renameChat}
          onOpenSops={() => setActivePanel("sops")}
          onOpenSkills={() => setActivePanel("skills")}
          onOpenMemory={() => setActivePanel("memory")}
          onOpenAgents={() => setActivePanel("agents")}
          onOpenAnalytics={() => setActivePanel("analytics")}
          onOpenSettings={() => setActivePanel("settings")}
          activePanel={activePanel}
        />
      )}
      <div className="main">
        {activePanel === "home" ? (
          <SkillPanel />
        ) : activePanel === "sops" ? (
          <SopPanel />
        ) : activePanel === "skills" ? (
          <SkillPanel />
        ) : activePanel === "memory" ? (
          <MemoryPanel />
        ) : activePanel === "agents" ? (
          <AgentPanel onOpenAgentChat={openAgentChat} />
        ) : activePanel === "settings" ? (
          <SettingsPanel
            key={settingsKey}
            folders={chatFolders.folders}
            chats={chats}
            onCreateFolder={chatFolders.createFolder}
            onMoveChats={chatFolders.moveChats}
          />
        ) : activePanel === "analytics" ? (
          <React.Suspense fallback={<div className="sop-panel-empty" style={{ padding: 24 }}>Loading analytics…</div>}>
            <AnalyticsPanel />
          </React.Suspense>
        ) : (
          <>
        <ChatHeader
          sidebarOpen={sidebarOpen}
          chatTitle={activeChat?.title}
          activeAgent={activeChat?.agentId ? agentById.get(activeChat.agentId) : undefined}
          displaySessionId={displaySessionId}
          contextPct={contextPct}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenResult={(id) => {
            if (displaySessionId) setViewingResult({ id, sessionId: displaySessionId });
          }}
          onHandoff={displaySessionId ? () => void sendMessage(HANDOFF_PROMPT) : undefined}
        />
        {displayMessages.length === 0 ? (
          <div className="chat-home">
            <div className="chat-home-inner">
              <ChatHero />
              <MessageInput
                variant="hero"
                input={input}
                loading={loading}
                isViewingInflight={isViewingInflight}
                onStop={stopActiveRun}
                currentModel={selectedModel}
                onModelChange={changeModel}
                activeAgentId={activeChat?.agentId}
                onSelectAgent={(agent) => {
                  if (agent) openAgentChat(agent);
                  else startNewChat();
                }}
                onInput={setInput}
                onSend={sendMessage}
              />
              <ChatExamples onSelect={setInput} />
            </div>
          </div>
        ) : (
          <>
        <MessageList
          messages={displayMessages}
          chatId={activeChatId}
          sessionId={displaySessionId ?? ""}
          loading={loading}
          isViewingInflight={isViewingInflight || remoteRunning}
          onNewChat={startNewChat}
          onOpenArtifact={(id, version) => {
            if (displaySessionId) setViewingArtifact({ id, sessionId: displaySessionId, version });
          }}
          onContinue={() => sendMessage("continue", undefined, undefined, "continue")}
          canResubmit={!loading && activeQueue.length === 0}
          onResubmit={resubmitFrom}
          pendingPrompt={visiblePrompt ?? undefined}
          onPromptAnswer={answerPrompt}
        />
        <MessageInput
          input={input}
          loading={loading}
          isViewingInflight={isViewingInflight}
          queued={activeQueue.map((m) => m.text)}
          onEditQueued={(i) => {
            const item = activeQueue[i];
            if (!item) return;
            updateQueue((q) => q.filter((m) => m !== item));
            setInput(input.trim() ? `${item.text}\n\n${input}` : item.text);
            document.querySelector<HTMLTextAreaElement>(".chat-input")?.focus();
          }}
          onRemoveQueued={(i) => {
            const item = activeQueue[i];
            if (item) updateQueue((q) => q.filter((m) => m !== item));
          }}
          onStop={stopActiveRun}
          currentModel={selectedModel}
          onModelChange={changeModel}
          activeAgentId={activeChat?.agentId}
          onSelectAgent={(agent) => {
            if (agent) openAgentChat(agent);
            else startNewChat();
          }}
          onInput={setInput}
          onSend={sendFromComposer}
          promptPending={composerPrompt}
        />
          </>
        )}
          </>
        )}
      </div>
      {viewingArtifact && activePanel === "chat" && viewingArtifact.sessionId === displaySessionId && (
        <ArtifactSheet
          key={`${viewingArtifact.id}:${viewingArtifact.version}`}
          id={viewingArtifact.id}
          sessionId={viewingArtifact.sessionId}
          version={viewingArtifact.version}
          onClose={closeArtifact}
        />
      )}
      {viewingResult && (
        <ResultTable
          key={`${viewingResult.sessionId}:${viewingResult.id}`}
          resultId={viewingResult.id}
          sessionId={viewingResult.sessionId}
          openFullscreen
          onClose={() => {
            setViewingResult(null);
            window.requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>(".chat-header-db-btn")?.focus();
            });
          }}
        />
      )}
      <FolderSuggestionToast
        suggestionKey={chatFolders.suggestion?.chatId ?? null}
        chatTitle={chats.find((c) => c.id === chatFolders.suggestion?.chatId)?.title ?? ""}
        folderName={chatFolders.folders.find((f) => f.id === chatFolders.suggestion?.folderId)?.name ?? ""}
        onMove={() => chatFolders.suggestion && chatFolders.resolveSuggestion(chatFolders.suggestion, true)}
        onDismiss={() => chatFolders.suggestion && chatFolders.resolveSuggestion(chatFolders.suggestion, false)}
      />
    </div>
  );
}
