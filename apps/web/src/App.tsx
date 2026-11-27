import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { PendingPrompt, SSEEvent } from "@rye/shared";

import type { AgentRecord, ChatRecord, MessageMeta, RenderMessage } from "./utils/types";
import { chatSaveBody } from "./utils/types";
import { isPermissionPrompt } from "./utils/approval";
import { onSyncMessage, publish, useSyncRefresh } from "./utils/sync";
import { useSops } from "./contexts/SopContext";
import { useSkills } from "./contexts/SkillContext";
import { useMemories } from "./contexts/MemoryContext";
import { useAgents } from "./contexts/AgentContext";
import { useEnv } from "./contexts/EnvContext";
import Sidebar from "./components/shell/Sidebar";
import { SidebarControlContext, type SidebarControl } from "./components/shell/SidebarButton";
import { useIsMobile } from "./utils/viewport";
import ChatSearchModal from "./components/shell/ChatSearch";
import ChatHeader from "./components/chat/ChatHeader";
import MessageList from "./components/chat/MessageList";
import MessageInput from "./components/chat/MessageInput";
import SopPanel from "./components/sops/SopPanel";
import SkillPanel from "./components/skills/SkillPanel";
import MemoryPanel from "./components/memory/MemoryPanel";
import AgentPanel from "./components/agents/AgentPanel";
import SettingsPanel, { type SettingsTab } from "./components/settings/SettingsPanel";
import { ChatExamples, ChatHero } from "./components/chat/ChatHome";
import ArtifactsPanel, { readArtifactsPinned, rememberArtifactsPinned, useCanPinArtifacts, type ArtifactsView } from "./components/artifacts/ArtifactsPanel";
import { ArtifactsPanelContext, type ArtifactsPanelControl } from "./components/artifacts/ArtifactsPanelContext";
import { useChatArtifacts } from "./components/artifacts/useChatArtifacts";
import { useKindView } from "./chat/kinds";
import FolderSuggestionToast from "./components/shell/FolderSuggestionToast";
import NotificationNudge from "./components/shell/NotificationNudge";
import QuickChat, { focusQuickChatComposer } from "./components/quick/QuickChat";
import { QUICK_CHAT_EVENT, type QuickChatDetail } from "./utils/quickChat";
import { notifyRunEnd, useNotifications } from "./utils/notifications";
import { useChatFolders } from "./components/shell/useChatFolders";
import { MAX_ATTACHMENTS, readyRefs, refForServer, refKey, refLabel, uploadAttachment, type AttachmentRef, type ContextRef, type PendingAttachment } from "./utils/attachments";
import { ADD_CONTEXT_EVENT, type AddContextDetail } from "./utils/contextRefs";
import { PANEL_PATHS, parseAppPath, redirectMovedPath, settingsPath, sopPath, type AppRoute } from "./utils/routes";
import type { ToolFocus } from "./components/settings/ToolsSection";

const HANDOFF_PROMPT =
  "Write a handoff doc for this conversation as a Markdown file named handoff, so another engineer (or their AI agent) can pick it up cold. " +
  "Make it self-contained: no references to \"above\" or \"earlier\". Include the problem and its impact, the environment and systems involved, " +
  "what was investigated in order, key findings with the exact evidence (queries, log lines, IDs, timestamps, error messages), what was ruled out, " +
  "the current hypothesis and how confident you are, open questions, and next steps with the exact commands or queries to run.";

// ---------------------------------------------------------------------------
// Chat history persistence (server-backed)
// ---------------------------------------------------------------------------

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

/**
 * The quick chat (components/quick/QuickChat.tsx): Rye's chat in a floating card, run through the same
 * sendMessage as any chat under this id (runs, drafts, files, references, the queue). It is never in
 * `chats`: upsertChat writes it to `quickChat` instead, so it is neither listed nor saved (and never
 * deleted by absence) until "Save as chat" makes a real chat of it. Its draft isn't kept in localStorage.
 */
const QUICK_CHAT_ID = "quick-chat";

interface QuickChatState {
  sessionId?: string;
  messages: RenderMessage[];
  prompt?: PendingPrompt;
}

/** Where a send from a composer goes: the chat on screen (or a new one), or the quick chat. */
interface ChatTarget {
  /** Undefined for a new chat, which gets its id on the first send. */
  chatId: string | undefined;
  draftKey: string;
  messages: RenderMessage[];
  sessionId: string | undefined;
  prompt: PendingPrompt | null;
  loading: boolean;
}

// The model last picked or sent with, so a new chat starts on it rather than on whatever the open chat uses.
const LAST_MODEL_KEY = "rye-last-model";
function readLastModel(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_MODEL_KEY) || undefined;
  } catch {
    return undefined;
  }
}
function rememberLastModel(model: string | undefined): void {
  if (!model) return;
  try {
    window.localStorage.setItem(LAST_MODEL_KEY, model);
  } catch {
    // Private mode: new chats fall back to the default model.
  }
}
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

/**
 * "/" is Home: the greeting, a large composer and starter prompts. NEW_CHAT_PATH is a new chat that
 * looks like any other chat (composer docked at the bottom), with the greeting as a placeholder
 * that floats away when the first message goes in. Neither has a chat id until the first send.
 */
const NEW_CHAT_PATH = "/new";

/** Home or a blank new chat: addresses that show no chat, even if one was open last time. */
function isEmptyChatPath(pathname: string): boolean {
  return pathname === "/" || pathname === NEW_CHAT_PATH;
}

function chatPath(chatId: string | undefined): string {
  if (chatId) return `/c/${encodeURIComponent(chatId)}`;
  // No chat yet: stay on whichever of the two empty pages is showing.
  return window.location.pathname === NEW_CHAT_PATH ? NEW_CHAT_PATH : "/";
}

function navigate(path: string, mode: "push" | "replace" = "push") {
  if (window.location.pathname === path) return;
  if (mode === "replace") window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
}

/**
 * The page an address shows when it isn't a chat (Settings, SOPs…; see utils/routes.ts), or
 * undefined for "/" and /c/<id>. These addresses never say anything about which chat is open:
 * the chat list and the open chat are left as they are while one of them is on show.
 */
function panelForRoute(route: AppRoute): Panel | undefined {
  if (route.kind === "settings") return "settings";
  if (route.kind === "sop") return "sops";
  if (route.kind === "panel") return route.panel;
  return undefined;
}

// A moved address (/analytics is now /settings/usage) is rewritten first, on load and on Back/Forward.
const routeNow = () => {
  redirectMovedPath();
  return parseAppPath(window.location.pathname);
};

/** A chat that is gone stops being the address; a page other than that chat keeps its own. */
function leaveChatAddress(chatId: string | undefined) {
  if (chatId && chatIdFromPath(window.location.pathname) === chatId) navigate("/", "replace");
}

// Mirrors the server: filed chats and dedicated agent chats don't count toward the cap.
// Newest first. Nothing is dropped for being old: a chat missing from this list is deleted on
// the server by the sync below, so trimming here would silently destroy history.
function normalizeChats(chats: ChatRecord[]): ChatRecord[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Same details (title, model, folder, prompt…), whatever each side knows about the messages. */
function sameDetails(a: ChatRecord, b: ChatRecord): boolean {
  const details = ({ messages: _m, partial: _p, messageCount: _c, ...rest }: ChatRecord) =>
    // Unset fields and field order don't count as differences.
    JSON.stringify(Object.entries(rest).filter(([, value]) => value !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return details(a) === details(b);
}

/** A chat from the titles-only list: its messages are still to be fetched unless there are none. */
function fromSummary(summary: ChatRecord): ChatRecord {
  if (Array.isArray(summary.messages)) return summary;
  return { ...summary, messages: [], ...(summary.messageCount ? { partial: true } : {}) };
}

// A message typed while its chat's run is streaming, bound to the chat it was written in.
interface QueuedMessage {
  text: string;
  chatId: string;
  model: string | undefined;
  attachments?: AttachmentRef[];
  references?: ContextRef[];
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

// Skills are managed in Settings (its "skills" page), not in a panel of their own.
type Panel = "home" | "chat" | "sops" | "memory" | "agents" | "settings";

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
  // The URL wins; the stored id is only a fallback when the URL names no chat and isn't Home or /new
  // (e.g. a reload on /settings keeps the last chat ready for when the user goes back to it).
  const [activeChatId, setActiveChatId] = useState<string | undefined>(
    () =>
      chatIdFromPath(window.location.pathname) ??
      (isEmptyChatPath(window.location.pathname) ? undefined : readActiveChatId()),
  );
  // Set when a chat is opened from a search result, so the list scrolls to that message.
  const [focusMessage, setFocusMessage] = useState<{ chatId: string; index: number; token: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Cmd/Ctrl+K opens chat search from anywhere, including with the sidebar hidden.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
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
  // Held here so anything that wants a Settings page can land on it: openPage(settingsPath("skills" | "mcp" | …)),
  // or openAppPath from outside App. The address (/settings/<page>) decides it; see showRoute below.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => {
    const route = routeNow();
    return route.kind === "settings" ? route.page : "general";
  });
  // /settings/tools/<name>: the tool the Tools page scrolls to and highlights.
  const [focusTool, setFocusTool] = useState<ToolFocus | null>(() => {
    const route = routeNow();
    return route.kind === "settings" && route.page === "tools" && route.item ? { name: route.item, token: 0 } : null;
  });
  // /sops/<id>: the SOP open in the SOPs panel.
  const [sopId, setSopId] = useState<number | null>(() => {
    const route = routeNow();
    return route.kind === "sop" ? route.id : null;
  });
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
  // Files picked in the composer, per chat like the text. Uploaded as soon as they are picked; kept in memory only.
  const [fileDrafts, setFileDrafts] = useState<Record<string, PendingAttachment[]>>({});
  const fileDraftsRef = useRef(fileDrafts);
  fileDraftsRef.current = fileDrafts;
  const draftFiles = fileDrafts[draftKey] ?? [];
  const updateFiles = useCallback((key: string, fn: (items: PendingAttachment[]) => PendingAttachment[]) => {
    setFileDrafts((prev) => {
      const next = fn(prev[key] ?? []);
      const copy = { ...prev };
      if (next.length > 0) copy[key] = next;
      else delete copy[key];
      return copy;
    });
  }, []);
  const addFiles = useCallback((key: string, files: File[]) => {
    const room = MAX_ATTACHMENTS - (fileDraftsRef.current[key]?.length ?? 0);
    const picked = files.slice(0, Math.max(0, room)).map((file) => ({
      file,
      pending: {
        key: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        status: "uploading" as const,
        ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
      },
    }));
    if (picked.length === 0) return;
    updateFiles(key, (items) => [...items, ...picked.map((p) => p.pending)]);
    for (const { file, pending } of picked) {
      uploadAttachment(file)
        .then((ref) => updateFiles(key, (items) => items.map((a) => (a.key === pending.key ? { ...a, status: "ready", ref } : a))))
        .catch((err: unknown) =>
          updateFiles(key, (items) => items.map((a) => (a.key === pending.key ? { ...a, status: "error", error: err instanceof Error ? err.message : String(err) } : a))),
        );
    }
  }, [updateFiles]);
  // SOPs and tools picked for the next message, per chat like the text.
  const [refDrafts, setRefDrafts] = useState<Record<string, ContextRef[]>>({});
  const refDraftsRef = useRef(refDrafts);
  refDraftsRef.current = refDrafts;
  const draftRefs = refDrafts[draftKey] ?? [];
  const updateRefs = useCallback((key: string, fn: (items: ContextRef[]) => ContextRef[]) => {
    setRefDrafts((prev) => {
      const next = fn(prev[key] ?? []);
      const copy = { ...prev };
      if (next.length > 0) copy[key] = next;
      else delete copy[key];
      return copy;
    });
  }, []);
  const addRef = useCallback((key: string, ref: ContextRef) => {
    updateRefs(key, (items) => (items.some((r) => refKey(r) === refKey(ref)) || items.length >= 10 ? items : [...items, ref]));
  }, [updateRefs]);
  const removeRef = useCallback((key: string, k: string) => updateRefs(key, (items) => items.filter((r) => refKey(r) !== k)), [updateRefs]);
  // `addContextToChat` (utils/contextRefs.ts) from anywhere: a quote of a reply or a diff into a chat's draft.
  const addContextRef = useRef<(detail: AddContextDetail) => void>(() => {});
  addContextRef.current = ({ ref, chatId, focus }: AddContextDetail) => {
    addRef(chatId ?? draftKey, ref);
    const target = chatId && chatId !== activeChatId && focus ? chatsRef.current.find((c) => c.id === chatId) : undefined;
    if (target) switchToChat(target);
    // After the chip renders (and the chat opens), so the caret lands in the composer.
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(".chat-input")?.focus({ preventScroll: true })));
  };
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddContextDetail>).detail;
      if (detail?.ref) addContextRef.current(detail);
    };
    window.addEventListener(ADD_CONTEXT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_CONTEXT_EVENT, onAdd);
  }, []);
  const removeFile = useCallback((key: string, fileKey: string) => {
    updateFiles(key, (items) => {
      const gone = items.find((a) => a.key === fileKey);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return items.filter((a) => a.key !== fileKey);
    });
  }, [updateFiles]);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  const updateQueue = useCallback((fn: (q: QueuedMessage[]) => QueuedMessage[]) => {
    messageQueueRef.current = fn(messageQueueRef.current);
    setMessageQueue(messageQueueRef.current);
  }, []);
  const [pendingContext, setPendingContext] = useState<string | undefined>();
  // The quick chat's saved state (what upsertChat writes for QUICK_CHAT_ID), whether its card shows, and a
  // counter that changes with each new quick conversation (New, Save as chat) so its message list starts afresh.
  const [quickChat, setQuickChat] = useState<QuickChatState>({ messages: [] });
  const quickChatRef = useRef(quickChat);
  quickChatRef.current = quickChat;
  const [quickOpen, setQuickOpen] = useState(false);
  const quickOpenRef = useRef(false);
  quickOpenRef.current = quickOpen;
  const [quickEpoch, setQuickEpoch] = useState(0);
  // Model for the active chat. Sent with each /chat request so what the
  // dropdown shows is exactly what the session uses (no hidden global drift).
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const selectedModelRef = useRef<string | undefined>(undefined);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Desktop: the sidebar slides in when shown and out before it unmounts (shell.css; none under reduced motion).
  const [sidebarMotion, setSidebarMotion] = useState<"in" | "out" | null>(null);
  const reducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const collapseSidebar = useCallback(() => {
    if (reducedMotion()) setSidebarOpen(false);
    else setSidebarMotion("out");
  }, []);
  const endSidebarMotion = useCallback((motion: "in" | "out") => {
    if (motion === "out") setSidebarOpen(false);
    setSidebarMotion(null);
  }, []);
  // Phone width: the sidebar is a drawer over the content with its own open state, so the desktop
  // column's expanded/collapsed state survives resizing between the two. Presentation only.
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenRef = useRef(false);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const closeDrawer = useCallback(() => {
    if (!drawerOpenRef.current) return;
    drawerOpenRef.current = false;
    setDrawerOpen(false);
    const back = drawerReturnFocusRef.current;
    drawerReturnFocusRef.current = null;
    // After the page has re-rendered: the page that opened the drawer may be gone (a chat or page was chosen),
    // so focus goes to the new page's menu button instead.
    window.requestAnimationFrame(() => {
      if (drawerOpenRef.current) return;
      const target = back?.isConnected ? back : document.querySelector<HTMLElement>(".main .sidebar-toggle-btn");
      target?.focus({ preventScroll: true });
    });
  }, []);
  useEffect(() => {
    if (isMobile) return;
    drawerOpenRef.current = false;
    setDrawerOpen(false);
  }, [isMobile]);
  useEffect(() => {
    const drawerShowing = isMobile && drawerOpen;
    // The page behind the open drawer can't be reached by Tab or a screen reader.
    mainRef.current?.toggleAttribute("inert", drawerShowing);
    if (!drawerShowing) return;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("#app-sidebar .sidebar-close-btn")?.focus();
    });
    // Capture phase, so this sees the page before a menu or dialog inside the drawer closes on the same Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".modal-overlay, [role=menu], .sidebar-dropdown")) return;
      if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      closeDrawer();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isMobile, drawerOpen, closeDrawer]);
  const sidebarControl = useMemo<SidebarControl>(() => ({
    drawer: isMobile,
    open: isMobile ? drawerOpen : sidebarOpen,
    show: (trigger) => {
      if (isMobile) {
        drawerReturnFocusRef.current = trigger;
        drawerOpenRef.current = true;
        setDrawerOpen(true);
      } else {
        setSidebarOpen(true);
        setSidebarMotion(reducedMotion() ? null : "in");
      }
    },
  }), [isMobile, drawerOpen, sidebarOpen]);
  // Choosing a chat or a page from the drawer closes it.
  const fromDrawer = useCallback(<A extends unknown[]>(action: (...args: A) => void) => (...args: A) => {
    action(...args);
    closeDrawer();
  }, [closeDrawer]);
  // The Artifacts panel (a chat's files and stored results) and what it shows; it follows the open chat.
  // sessionId is undefined only while the panel is pinned on a chat without a session (it shows the empty state).
  const [artifactsPanel, setArtifactsPanel] = useState<{ sessionId: string | undefined; view: ArtifactsView } | null>(null);
  const [activePanel, setActivePanel] = useState<Panel>(() => panelForRoute(routeNow()) ?? "chat");
  // Which empty page shows before a chat has messages: Home ("/", false) or a blank new chat (NEW_CHAT_PATH, true).
  const [blankChat, setBlankChat] = useState(() => window.location.pathname === NEW_CHAT_PATH);
  // The chat whose first message just went in from a blank new chat: its greeting floats away (CSS), then goes.
  const [heroExitId, setHeroExitId] = useState<string | null>(null);
  useEffect(() => {
    if (!heroExitId) return;
    const t = window.setTimeout(() => setHeroExitId(null), 600);
    return () => window.clearTimeout(t);
  }, [heroExitId]);
  const activePanelRef = useRef(activePanel);
  useEffect(() => { activePanelRef.current = activePanel; }, [activePanel]);
  // Shows the page an address names. False for "/" and chat addresses, which the chat code handles.
  // Only page state changes here: never the chat list or the open chat.
  const showRoute = useCallback((route: AppRoute): boolean => {
    const panel = panelForRoute(route);
    if (!panel) return false;
    setActivePanel(panel);
    if (route.kind === "settings") {
      setSettingsTab(route.page);
      setFocusTool(route.page === "tools" && route.item ? { name: route.item, token: Date.now() } : null);
    } else if (route.kind === "sop") {
      setSopId(route.id);
    } else if (route.kind === "panel" && route.panel === "sops") {
      setSopId(null);
    }
    return true;
  }, []);
  // Go to a page with its own address (Settings, SOPs…), adding a history entry.
  const openPage = useCallback((path: string) => {
    navigate(path);
    showRoute(parseAppPath(path));
  }, [showRoute]);
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
  // The list loads titles only; the chat on screen fetches its messages (see the effect below).
  const activeNeedsLoad = Boolean(activeChat?.partial) && !activeRun;
  const [chatLoadError, setChatLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    const id = activeChatId;
    if (!id || !activeNeedsLoad) return;
    let cancelled = false;
    setChatLoadError(null);
    void fetch(`/chat/history/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<ChatRecord>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((full) => {
        if (cancelled || !Array.isArray(full.messages)) return;
        const current = chatsRef.current.find((c) => c.id === id);
        if (!current?.partial) return;
        // Details edited here while it loaded (a rename) are kept; a copy saved elsewhere since wins outright.
        const { partial: _partial, messageCount: _count, ...details } = full.updatedAt > current.updatedAt ? full : current;
        const loaded: ChatRecord = { ...details, messages: full.messages };
        // Nothing here differs from the server unless this tab had unsaved edits, so don't upload it back.
        const clean = current === persistedRef.current.get(id) || current === remoteRef.current.get(id);
        if (clean) remoteRef.current.set(id, loaded);
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== id || !c.partial) return c;
            if (c === current) return loaded;
            // Edited between the lines above and this update: keep that edit, add the messages.
            const { partial: _p, messageCount: _c, ...edited } = c;
            return { ...edited, messages: full.messages };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setChatLoadError(id);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, activeNeedsLoad, loadAttempt]);
  const displaySessionId = activeRun ? activeRun.sessionId : activeChat?.sessionId;
  const chatArtifacts = useChatArtifacts(displaySessionId, loading);
  const artifactCount = displaySessionId && chatArtifacts.sessionId === displaySessionId
    ? chatArtifacts.files.length + chatArtifacts.results.length
    : 0;
  // Pinned docks the panel beside the chat (wide windows only); the choice is remembered in this browser.
  const canPinArtifacts = useCanPinArtifacts();
  const [artifactsPinPref, setArtifactsPinPref] = useState(readArtifactsPinned);
  const artifactsPinned = artifactsPinPref && canPinArtifacts && !isMobile;
  const toggleArtifactsPin = useCallback(() => {
    setArtifactsPinPref((was) => {
      rememberArtifactsPinned(!was);
      return !was;
    });
  }, []);
  // A pinned panel slides shut (artifacts.css, .is-leaving) before it unmounts; a floating one just goes.
  const [artifactsLeaving, setArtifactsLeaving] = useState(false);
  const artifactsLeaveTimer = useRef<number | null>(null);
  const dismissArtifacts = useCallback(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!artifactsPinned || reduced) {
      setArtifactsPanel(null);
      return;
    }
    if (artifactsLeaveTimer.current !== null) return;
    setArtifactsLeaving(true);
    artifactsLeaveTimer.current = window.setTimeout(() => {
      artifactsLeaveTimer.current = null;
      setArtifactsLeaving(false);
      setArtifactsPanel(null);
    }, 140);
  }, [artifactsPinned]);
  useEffect(() => () => {
    if (artifactsLeaveTimer.current !== null) window.clearTimeout(artifactsLeaveTimer.current);
  }, []);
  // The panel follows the open chat. Floating: another chat shows its own list, or the panel closes when that
  // chat has nothing (checked once its lists arrive), and a new chat closes it. Pinned: it stays docked and shows
  // whatever the open chat has, even nothing, so the chat beside it never changes width on its own.
  const artifactsFollowRef = useRef<string | null>(null);
  useEffect(() => {
    if (!artifactsPanel || artifactsPanel.sessionId === displaySessionId) return;
    if (artifactsPinned) {
      setArtifactsPanel({ sessionId: displaySessionId, view: { kind: "list" } });
      return;
    }
    if (!displaySessionId) {
      setArtifactsPanel(null);
      return;
    }
    artifactsFollowRef.current = displaySessionId;
    setArtifactsPanel({ sessionId: displaySessionId, view: { kind: "list" } });
  }, [displaySessionId, artifactsPanel, artifactsPinned]);
  useEffect(() => {
    const followed = artifactsFollowRef.current;
    if (!followed || chatArtifacts.sessionId !== followed) return;
    artifactsFollowRef.current = null;
    if (!artifactsPinned && !chatArtifacts.error && chatArtifacts.files.length + chatArtifacts.results.length === 0) {
      setArtifactsPanel((p) => (p?.sessionId === followed ? null : p));
    }
  }, [chatArtifacts.sessionId, chatArtifacts.files, chatArtifacts.results, chatArtifacts.error, artifactsPinned]);
  const artifactsControl = useMemo<ArtifactsPanelControl | null>(
    () => (displaySessionId
      ? {
          openFile: (id, version) => setArtifactsPanel({ sessionId: displaySessionId, view: { kind: "file", id, version } }),
          openResult: (id) => setArtifactsPanel({ sessionId: displaySessionId, view: { kind: "result", id } }),
        }
      : null),
    [displaySessionId],
  );
  const visiblePrompt = activeRun ? activeRun.prompt : (activeChat?.pendingPrompt ?? null);
  const contextPct = activeRun?.contextPct;
  const activeQueue = messageQueue.filter((m) => m.chatId === activeChatId);
  // The two places a composer sends from: the chat on screen and the quick chat.
  const mainTarget: ChatTarget = {
    chatId: activeChatId,
    draftKey,
    messages: displayMessages,
    sessionId: displaySessionId || undefined,
    prompt: visiblePrompt,
    loading,
  };
  const quickRun = runs[QUICK_CHAT_ID];
  const quickTarget: ChatTarget = {
    chatId: QUICK_CHAT_ID,
    draftKey: QUICK_CHAT_ID,
    messages: quickRun ? quickRun.messages : quickChat.messages,
    sessionId: quickRun?.sessionId ?? quickChat.sessionId,
    prompt: quickRun ? quickRun.prompt : (quickChat.prompt ?? null),
    loading: Boolean(quickRun?.running),
  };
  // Read by a quick chat edit or retry, which sends the messages it rewinds (the server has no copy of them).
  const quickMessagesRef = useRef(quickTarget.messages);
  quickMessagesRef.current = quickTarget.messages;
  const quickQueue = messageQueue.filter((m) => m.chatId === QUICK_CHAT_ID);
  // The quick chat isn't a listed chat: not shown running in the sidebar, nor announced to other tabs.
  const runningChatIds = useMemo(
    () => new Set(Object.keys(runs).filter((id) => runs[id].running && id !== QUICK_CHAT_ID)),
    [runs],
  );
  const sidebarRunningIds = useMemo(
    () => (remoteRunningIds.size ? new Set([...runningChatIds, ...remoteRunningIds]) : runningChatIds),
    [runningChatIds, remoteRunningIds],
  );
  // Stable across token updates, so presence is only announced when the set changes.
  const runningKey = [...runningChatIds].sort().join("\n");
  const chatOnScreen = activePanel === "chat" ? activeChatId : undefined;
  // Desktop notifications and the tab title count skip the chat on screen and clear once it is seen.
  useNotifications(chatOnScreen);
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
      // The quick chat's draft goes with it on a reload.
      const kept = Object.entries(drafts).filter(([key, text]) => key !== QUICK_CHAT_ID && text.length <= MAX_PERSISTED_DRAFT);
      if (kept.length) window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
      else window.localStorage.removeItem(DRAFTS_STORAGE_KEY);
    } catch {
      // Drafts still live in memory when storage is unavailable or full.
    }
  }, [drafts]);

  // Back/forward switches chats; "/" is a new chat. Other pages' addresses show that page and leave the chat alone.
  useEffect(() => {
    const onPopState = () => {
      if (showRoute(routeNow())) return;
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
      setBlankChat(window.location.pathname === NEW_CHAT_PATH);
      setActiveChatId(undefined);
      setSelectedModel(readLastModel());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [showRoute]);

  useEffect(() => {
    if (!chatsHydrated || !activeChat || selectedModelRef.current !== undefined) return;
    setSelectedModel(activeChat.model);
  }, [activeChat, chatsHydrated]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/chat/history?summary=1")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ChatRecord[]>;
      })
      .then((loaded) => {
        if (cancelled) return;
        chatsFetchOk.current = true;
        // Every chat, titles and details only; a chat's messages are fetched when it is opened.
        const normalized = normalizeChats((Array.isArray(loaded) ? loaded : []).map(fromSummary));
        // Seed the sync baseline so hydration doesn't re-upload what we just read.
        persistedRef.current = new Map(normalized.map((c) => [c.id, c]));
        remoteRef.current = new Map(normalized.map((c) => [c.id, c]));
        setChats(normalized);
        const known = (id: string) => normalized.some((chat) => chat.id === id) || runsRef.current.has(id);
        const urlChatId = chatIdFromPath(window.location.pathname);
        const current = activeChatIdRef.current;
        let next: string | undefined;
        if (urlChatId !== undefined) next = known(urlChatId) ? urlChatId : undefined;
        // Home and /new show no chat unless one was started here before the list arrived.
        else if (isEmptyChatPath(window.location.pathname)) next = current && known(current) ? current : undefined;
        else next = current && known(current) ? current : normalized.find((chat) => chat.pendingPrompt)?.id;
        setActiveChatId(next);
        // On another page's address (/settings…), the address stays; the chat is there for when the user goes back to it.
        if (!panelForRoute(routeNow())) navigate(chatPath(next), "replace");
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
          // A chat whose messages were never loaded is saved without them, so the server keeps its own.
          body: JSON.stringify(chatSaveBody(chat)),
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
      const res = await fetch("/chat/history?summary=1");
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return;
      // Still every chat (absence means deleted), just without messages.
      remote = normalizeChats((data as ChatRecord[]).map(fromSummary));
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
        } else if (fresh.updatedAt > local.updatedAt) {
          // Saved again elsewhere: take the server's details. Its messages aren't in the titles-only
          // list, so the chat is marked partial (never saved with messages, never sent into) and is
          // fetched again if it is on screen; what this tab already has stays visible meanwhile.
          const adopted = fresh.partial && !local.partial ? { ...fresh, messages: local.messages } : fresh;
          remoteById.set(local.id, adopted);
          next.push(adopted);
          changed = true;
        } else if (sameDetails(local, fresh)) {
          // Keep the existing object so nothing re-renders or re-uploads.
          remoteById.set(local.id, local);
          next.push(local);
        } else {
          // Same messages (same updatedAt), different details, e.g. filed in a folder elsewhere:
          // take the details and keep whatever messages this tab has loaded.
          const merged = { ...fresh, messages: local.messages, partial: local.partial };
          if (!merged.partial) delete merged.partial;
          remoteById.set(local.id, merged);
          next.push(merged);
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
      leaveChatAddress(active);
    }
    const goneSessions = new Set([...goneIds].map((id) => before.get(id)?.sessionId).filter(Boolean));
    setArtifactsPanel((p) => (p && goneSessions.has(p.sessionId) ? null : p));
  }, [commitRuns, updateQueue]);
  useSyncRefresh("chats", () => void refreshChats());

  // A chat of another kind (a code session) has a view of its own (chat/kinds.tsx), once the server supports the kind.
  const KindView = useKindView(activeChat);

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
    // The quick chat is kept in its own state, never in `chats` (so never listed, saved or deleted by absence).
    // A run that hasn't learned its session yet passes the chat id as one: that is no session.
    if (id === QUICK_CHAT_ID) {
      const sessionId = sid === QUICK_CHAT_ID ? quickChatRef.current.sessionId : sid;
      setQuickChat({ sessionId, messages: msgs, ...(prompt ? { prompt } : {}) });
      return;
    }
    if (deletedChatIdsRef.current.has(id)) return;
    const fallbackTitle = msgs.find((m) => m.role === "user" && !m.kind)?.content.slice(0, 60) ?? "New chat";
    setChats((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      const existing = idx === -1 ? undefined : prev[idx];
      // Second line of defence behind the send guard: never write a run's messages over a chat
      // whose own messages were not loaded, since that would erase them on the next save.
      if (existing?.partial) {
        console.error(`[chat] refused to overwrite unloaded chat ${id}`);
        return prev;
      }
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

  /**
   * Opens a chat the server made (a new code session, a session's card in its parent chat). The list
   * may not have it yet, so it is re-read first; only adding to the list, never dropping from it.
   */
  async function openChatById(chatId: string, title = "Code session") {
    if (!chatsRef.current.some((c) => c.id === chatId)) await refreshChats();
    // refreshChats updates remoteRef at once; the list state (and chatsRef) catch up on the next render.
    const found = chatsRef.current.find((c) => c.id === chatId) ?? remoteRef.current.get(chatId);
    if (found) return switchToChat(found);
    // Not listed yet: show it now, its messages to be fetched like any unopened chat.
    const placeholder: ChatRecord = { id: chatId, title, sessionId: "", messages: [], updatedAt: Date.now(), kind: "code", partial: true };
    deletedChatIdsRef.current.delete(chatId);
    setChats((prev) => (prev.some((c) => c.id === chatId) ? prev : normalizeChats([placeholder, ...prev])));
    switchToChat(placeholder);
  }
  const openChatByIdRef = useRef(openChatById);
  openChatByIdRef.current = openChatById;
  useEffect(() => {
    const onOpen = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (chatId) void openChatByIdRef.current(chatId);
    };
    window.addEventListener("rye:open-chat", onOpen);
    return () => window.removeEventListener("rye:open-chat", onOpen);
  }, []);

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
      openProfile: () => openPage(PANEL_PATHS.agents),
    });
  });

  // Persist a model change immediately so it survives even without sending.
  function changeModel(model: string) {
    setSelectedModel(model);
    // An agent's chat uses that agent's model; picking one there isn't a general preference.
    if (!activeChat?.agentId) rememberLastModel(model);
    if (activeChatId) {
      setChats((prev) => prev.map((c) => (c.id === activeChatId ? { ...c, model } : c)));
    }
  }

  function renameChat(id: string, title: string) {
    setChats((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
  }

  // Called once the user has confirmed (the sidebar asks first).
  function deleteChat(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
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
      // leaveChatAddress goes to "/", so show Home rather than a blank new chat.
      if (chatIdFromPath(window.location.pathname) === id) setBlankChat(false);
      leaveChatAddress(id);
    }
    if (artifactsPanel?.sessionId === deletedSessionId) setArtifactsPanel(null);
    const run = runsRef.current.get(id);
    if (run) {
      run.controller.abort();
      runsRef.current.delete(id);
      commitRuns();
    }
  }

  function startNewChat(opts?: { display?: string; context?: string }) {
    setPendingContext(opts?.context);
    // A new chat starts on the model last used, not on the one the chat being left was using.
    setSelectedModel(readLastModel());
    if (!opts?.display) {
      // No id until the first send, so the new-chat draft is shared with Home.
      setActiveChatId(undefined);
      setBlankChat(true);
      navigate(NEW_CHAT_PATH);
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

  /**
   * Forgets the quick conversation (New, leaving the page). Its server session (history, results, files) is
   * deleted too, unless `keepSession`: it now belongs to the chat it was saved as. The draft is left alone.
   */
  function clearQuickChat(keepSession = false) {
    const run = runsRef.current.get(QUICK_CHAT_ID);
    const sid = run?.sessionId ?? quickChatRef.current.sessionId;
    if (run) {
      // Dropped before the abort, so nothing the stopped run still writes reaches the next conversation.
      runsRef.current.delete(QUICK_CHAT_ID);
      commitRuns();
      run.controller.abort();
    }
    if (sid && !keepSession) {
      void fetch(`/chat/session/${encodeURIComponent(sid)}`, { method: "DELETE", keepalive: true }).catch(() => {});
    }
    updateQueue((q) => q.filter((m) => m.chatId !== QUICK_CHAT_ID));
    setQuickChat({ messages: [] });
    setQuickEpoch((n) => n + 1);
  }
  const clearQuickChatRef = useRef(clearQuickChat);
  clearQuickChatRef.current = clearQuickChat;
  // A reload (or leaving the page) loses the quick chat: its session is deleted on the way out.
  useEffect(() => {
    const onHide = () => {
      const q = quickChatRef.current;
      if (runsRef.current.has(QUICK_CHAT_ID) || q.sessionId || q.messages.length > 0) clearQuickChatRef.current();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  /**
   * Quick chat's "Save as chat": a regular chat with its messages and session (so the model keeps its context),
   * added to the list through upsertChat like any new chat, titled like one, then opened. From then on it is
   * an ordinary chat on the chat's own model; the quick card closes, empty.
   */
  function saveQuickChat() {
    const { messages, sessionId, prompt, loading: running } = quickTarget;
    if (running || !sessionId || messages.length === 0) return;
    clearQuickChat(true);
    setQuickOpen(false);
    const id = crypto.randomUUID();
    upsertChat(id, sessionId, messages, prompt ?? undefined);
    switchToChat({ id, title: "New chat", sessionId, messages, updatedAt: Date.now(), model: selectedModelRef.current });
    const firstUser = messages.find((m) => m.role === "user" && !m.kind);
    const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
    if (firstUser) {
      const said =
        firstUser.content.trim() ||
        [...(firstUser.attachments ?? []).map((a) => a.name), ...(firstUser.references ?? []).map(refLabel)].join(", ");
      generateTitle(id, said, lastReply?.content ?? "");
    }
  }

  // openQuickChat / toggleQuickChat (utils/quickChat.ts) from anywhere, and Cmd+J (Ctrl+J elsewhere, where the
  // browser would open its Downloads page) to show or hide it. A quote becomes a chip in its composer.
  const onQuickChatEventRef = useRef<(detail: QuickChatDetail) => void>(() => {});
  onQuickChatEventRef.current = (detail) => {
    if (detail.action === "toggle" && quickOpenRef.current) {
      setQuickOpen(false);
      return;
    }
    if (detail.quote) addRef(QUICK_CHAT_ID, detail.quote);
    const text = detail.text?.trim();
    if (text) {
      setDrafts((prev) => {
        const cur = prev[QUICK_CHAT_ID] ?? "";
        return { ...prev, [QUICK_CHAT_ID]: cur.trim() ? `${cur}\n\n${text}` : text };
      });
    }
    setQuickOpen(true);
    focusQuickChatComposer();
  };
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<QuickChatDetail>).detail;
      if (detail) onQuickChatEventRef.current(detail);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      onQuickChatEventRef.current({ action: "toggle" });
    };
    window.addEventListener(QUICK_CHAT_EVENT, onEvent);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(QUICK_CHAT_EVENT, onEvent);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  /** A file the quick chat wrote: there is no Artifacts panel for it (Save as chat to get one), so it downloads. */
  function downloadQuickArtifact(id: string, version: number) {
    const sid = quickTarget.sessionId;
    if (!sid) return;
    const a = document.createElement("a");
    a.href = `/artifact/${encodeURIComponent(id)}/download?session_id=${encodeURIComponent(sid)}&version=${version}`;
    a.click();
  }

  /** Home: the greeting with the large composer and starter prompts. Leaves the chat list alone. */
  function goHome() {
    setPendingContext(undefined);
    setSelectedModel(readLastModel());
    setActiveChatId(undefined);
    setBlankChat(false);
    setActivePanel("chat");
    navigate("/");
  }

  async function sendMessage(
    overrideText?: string,
    // Queued sends and retries carry their chat's state explicitly so this closure's render state is never read.
    continuation?: { chatId: string; sessionId: string | undefined; baseMessages: RenderMessage[]; model?: string },
    // Index of the user message this send replaces; the server truncates from there first.
    rewindIndex?: number,
    kind?: RenderMessage["kind"],
    // Files sent with the message. A composer send takes the composer's; queued sends and edits pass theirs.
    files?: AttachmentRef[],
    // SOPs and tools the message is pointed at; same rule as files.
    refs?: ContextRef[],
    // Which composer and conversation a send without `continuation` belongs to: the chat on screen, or the quick chat.
    target: ChatTarget = mainTarget,
  ) {
    const { draftKey } = target;
    const text = (overrideText ?? drafts[draftKey] ?? "").trim();
    const fromComposer = overrideText === undefined && !continuation;
    const composerFiles = fromComposer ? (fileDraftsRef.current[draftKey] ?? []) : [];
    // Wait for uploads to finish (the send button is disabled meanwhile; this covers Enter).
    if (composerFiles.some((a) => a.status === "uploading")) return;
    const sending = files ?? readyRefs(composerFiles);
    const pointing = refs ?? (fromComposer ? (refDraftsRef.current[draftKey] ?? []) : []);
    if (!text && sending.length === 0 && pointing.length === 0) return;
    if (fromComposer && composerFiles.length > 0) {
      for (const a of composerFiles) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      updateFiles(draftKey, () => []);
    }
    if (fromComposer && pointing.length > 0) updateRefs(draftKey, () => []);
    const chatId = continuation?.chatId ?? target.chatId ?? crypto.randomUUID();
    // The quick chat runs like any chat; what differs: the server picks its model (`quick: true`), it isn't
    // listed (upsertChat keeps it apart), and it never takes over the address, the title or notifications.
    const quick = chatId === QUICK_CHAT_ID;
    if (deletedChatIdsRef.current.has(chatId)) return;
    // A chat whose messages haven't loaded can't be sent into: the run would start from an empty
    // history and saving it would replace the real one. The composer is disabled until it loads.
    if (chatsRef.current.find((c) => c.id === chatId)?.partial) return;
    // The backend doesn't guard same-session races, and this tab can't see the other run's end state yet.
    if (!continuation && remoteRunningIdsRef.current.has(chatId) && !runsRef.current.get(chatId)?.running) return;
    // One run per chat (the backend doesn't guard same-session races): queue behind it.
    if (runsRef.current.get(chatId)?.running) {
      const queuedFiles = { ...(sending.length > 0 ? { attachments: sending } : {}), ...(pointing.length > 0 ? { references: pointing } : {}) };
      if (continuation) {
        updateQueue((q) => [{ text, chatId, model: continuation.model, ...queuedFiles }, ...q]);
      } else {
        if (overrideText === undefined) setDraft(draftKey, "");
        updateQueue((q) => [...q, { text, chatId, model: selectedModelRef.current, ...queuedFiles }]);
      }
      return;
    }
    // Only a composer send consumes the draft; prompt answers, Continue and queued sends leave it.
    if (overrideText === undefined) setDraft(draftKey, "");

    // The context a new chat was started with (a SQL result) belongs to the main chat's first message.
    const serverText = pendingContext && !continuation && !quick ? `${pendingContext}\n\n${text}` : text;
    if (!continuation && !quick) setPendingContext(undefined);

    const controller = new AbortController();
    const startSessionId = continuation ? continuation.sessionId : target.sessionId;
    const baseMessages = continuation?.baseMessages ?? target.messages;
    const model = quick
      ? undefined
      : continuation
        ? (continuation.model ?? chatsRef.current.find((c) => c.id === chatId)?.model ?? selectedModelRef.current)
        : selectedModelRef.current;
    const env = resolveEnv(chatId);
    const chatAgentId = chatsRef.current.find((c) => c.id === chatId)?.agentId;
    // What the user last sent with is what a new chat starts on (agent chats use their agent's model).
    if (!continuation && !chatAgentId && !quick) rememberLastModel(model);
    const turnId = crypto.randomUUID();
    // Typing "continue" at a paused reply is the same action as the Continue button.
    const turnKind = kind ?? (/^continue[.!]?$/i.test(text) && baseMessages.at(-1)?.paused ? "continue" : undefined);

    const initial: RenderMessage[] = [
      // Sending anything resolves the pause, so retire the Continue button.
      ...baseMessages.map((m) => (m.paused ? { ...m, paused: false } : m)),
      { role: "user", content: text, id: turnId, ...(turnKind ? { kind: turnKind } : {}), ...(sending.length > 0 ? { attachments: sending } : {}), ...(pointing.length > 0 ? { references: pointing } : {}) },
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
    // Saves the run into its chat. A quick chat cleared (New) or saved as a chat while this run was going has
    // dropped the run, so a late write from it (its abort, say) must not bring the old conversation back.
    const saveChat = (sid: string, msgs: RenderMessage[], prompt?: PendingPrompt) => {
      if (quick && runsRef.current.get(chatId)?.controller !== controller) return;
      upsertChat(chatId, sid, msgs, prompt);
    };
    // Don't yank the user back if they navigated away while the queue drained. The quick chat stays in its card.
    if (!continuation && !quick) {
      // The first message of a blank new chat: its greeting floats away instead of vanishing.
      if (blankChat && displayMessages.length === 0) setHeroExitId(chatId);
      setActiveChatId(chatId);
      // A new chat's first send turns "/" into its URL without adding a history entry.
      navigate(chatPath(chatId), "replace");
    }

    let currentSessionId = startSessionId;
    let streamPaused = false;
    let hadPrompt = false;
    let aborted = false;
    // Set by `done` or `error`. A stream that closes without either (a server restart mid-run, a server bug
    // that skips `done`) would otherwise leave the reply unsaved, and it blanks out once the run is gone.
    let streamEnded = false;
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
          // The server runs it on the low model tier and never auto-routes it or adds agent follow-ups.
          ...(quick ? { quick: true } : {}),
          ...(env ? { env } : {}),
          ...(chatAgentId ? { agent_id: chatAgentId } : {}),
          // The quick chat isn't stored on the server, so an edit or retry sends the messages it rewinds.
          ...(rewindIndex !== undefined
            ? {
                rewind: quick
                  ? { index: rewindIndex, messages: quickMessagesRef.current.map(({ role, content, id }) => ({ role, content, ...(id ? { id } : {}) })) }
                  : { chat_id: chatId, index: rewindIndex },
              }
            : {}),
          ...(sending.length > 0 ? { attachments: sending.map((a) => a.id) } : {}),
          ...(pointing.length > 0 ? { references: pointing.map(refForServer) } : {}),
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
              saveChat(event.session_id, localMessages);
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
              // A file written or a result stored: the Artifacts count and panel pick it up now, not at run end.
              if (/\[rye:(artifact|result):/.test(content)) chatArtifacts.refresh();
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
              saveChat(currentSessionId ?? chatId, localMessages, currentPrompt);
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
              streamEnded = true;
              saveChat(currentSessionId ?? chatId, localMessages);
            } else if (event.type === "done") {
              streamEnded = true;
              patchMeta(() => ({ finishedAt: Date.now(), status: "done" }));
              const msgs = streamPaused ? markLastPaused(localMessages) : localMessages;
              saveChat(currentSessionId!, msgs, currentPrompt);
              // Generate an AI title after the very first exchange (a quick chat gets one when it is saved as a chat)
              const userMsgs = msgs.filter((m) => m.role === "user" && !m.kind);
              const asstMsgs = msgs.filter((m) => m.role === "assistant");
              if (!turnKind && !chatAgentId && !quick && userMsgs.length === 1) {
                // A message of only files is titled from their names.
                const first = userMsgs[0];
                const said =
                  first.content.trim() ||
                  [...(first.attachments ?? []).map((a) => a.name), ...(first.references ?? []).map(refLabel)].join(", ");
                generateTitle(chatId, said, asstMsgs[asstMsgs.length - 1]?.content ?? "");
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      }
      // Closed without `done` or `error` (and not by a prompt, which saves itself): keep what streamed.
      if (!streamEnded && !hadPrompt && !deletedChatIdsRef.current.has(chatId) && localMessages.length > 0) {
        patchMeta(() => ({ finishedAt: Date.now(), status: streamPaused ? "done" : "stopped" }));
        saveChat(currentSessionId ?? chatId, streamPaused ? markLastPaused(localMessages) : localMessages, currentPrompt);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        aborted = true;
        patchMeta(() => ({ finishedAt: Date.now(), status: "stopped" }));
        // Persist whatever was streamed before the user hit stop
        if (!deletedChatIdsRef.current.has(chatId) && localMessages.length > 0 && currentSessionId) {
          saveChat(currentSessionId, localMessages);
        }
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        patchMeta(() => ({ finishedAt: Date.now(), status: "error", error: errMsg }));
        saveChat(currentSessionId ?? chatId, localMessages);
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
      if (!aborted && !deleted && !quick && !isOnScreen(chatId)) {
        setChats((prev) => prev.map((c) => (c.id === chatId && !c.unread ? { ...c, unread: true } : c)));
      }
      // Drain this chat's queue only; other chats drain when their own runs finish.
      const next = deleted || hadPrompt ? undefined : messageQueueRef.current.find((m) => m.chatId === chatId);
      if (next) {
        updateQueue((q) => q.filter((m) => m !== next));
        const baseMessages = streamPaused ? markLastPaused(localMessages) : localMessages;
        void sendMessage(next.text, { chatId, sessionId: currentSessionId, baseMessages, model: next.model }, undefined, undefined, next.attachments, next.references);
      } else if (!aborted && !deleted && !quick) {
        // Once per run (after any agent hand-offs), from the tab that ran it; a queued follow-up notifies when it ends.
        // Not for the quick chat, which has no chat to open from a notification.
        void notifyRunEnd({
          chatId,
          title: (chatAgentId ? agentById.get(chatAgentId)?.name : undefined) ?? chatsRef.current.find((c) => c.id === chatId)?.title,
          messages: localMessages,
          prompt: currentPrompt,
          startedAt: initial.at(-1)?.meta?.startedAt,
        });
      }
    }
  }

  // Retry and edit: drop the user message at `index` and everything after it, then send `text` in its place.
  function resubmitFrom(index: number, text: string, target: ChatTarget = mainTarget) {
    const { chatId, messages } = target;
    const trimmed = text.trim();
    // The edited (or retried) message keeps the files it was sent with.
    const files = messages[index]?.attachments ?? [];
    const refs = messages[index]?.references ?? [];
    // runsRef is set synchronously by sendMessage, so it also blocks a same-frame double click.
    if (
      (!trimmed && files.length === 0 && refs.length === 0) || !chatId || runsRef.current.get(chatId)?.running ||
      messageQueueRef.current.some((m) => m.chatId === chatId)
    ) return;
    if (messages[index]?.role !== "user" || messages[index].kind) return;
    void sendMessage(
      trimmed,
      {
        chatId,
        sessionId: target.sessionId,
        baseMessages: messages.slice(0, index),
        model: selectedModelRef.current,
      },
      index,
      undefined,
      files,
      refs,
    );
  }

  function answerPrompt(answer: string, target: ChatTarget = mainTarget) {
    const kind = target.prompt && isPermissionPrompt(target.prompt) ? "approval" : "answer";
    dismissPrompt(target.chatId);
    void sendMessage(answer, undefined, undefined, kind, undefined, undefined, target);
  }

  // The agent's question is answered (by a pick or by the next message): hide it.
  function dismissPrompt(chatId = activeChatId) {
    if (!chatId) return;
    const run = runsRef.current.get(chatId);
    if (run) {
      runsRef.current.set(chatId, { ...run, prompt: null });
      commitRuns();
    }
    if (chatId === QUICK_CHAT_ID) {
      setQuickChat((q) => (q.prompt ? { ...q, prompt: undefined } : q));
      return;
    }
    setChats((prev) => prev.map((chat) =>
      chat.id === chatId ? { ...chat, pendingPrompt: undefined } : chat
    ));
  }

  // While the agent waits on a question, the composer answers it; a permission prompt reads a typed reply as a denial.
  const promptPendingFor = (target: ChatTarget) =>
    !target.loading && target.prompt ? (isPermissionPrompt(target.prompt) ? "approval" as const : "question" as const) : undefined;
  const composerPrompt = promptPendingFor(mainTarget);
  function sendFromComposer(target: ChatTarget = mainTarget) {
    const { draftKey } = target;
    const text = (drafts[draftKey] ?? "").trim();
    if (promptPendingFor(target) !== "question" || !text) return void sendMessage(undefined, undefined, undefined, undefined, undefined, undefined, target);
    // With files or SOPs/tools picked, the reply is a full message (it still answers the question):
    // an inline answer can't carry them.
    const files = fileDrafts[draftKey] ?? [];
    if (files.length > 0 || (refDrafts[draftKey] ?? []).length > 0) {
      if (files.some((a) => a.status === "uploading")) return;
      dismissPrompt(target.chatId);
      return void sendMessage(undefined, undefined, undefined, undefined, undefined, undefined, target);
    }
    setDraft(draftKey, "");
    answerPrompt(text, target);
  }

  return (
    <SidebarControlContext.Provider value={sidebarControl}>
    <div className="app">
      {(isMobile || sidebarOpen) && (
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
          onNewChat={fromDrawer(() => { startNewChat(); setActivePanel("chat"); })}
          onClose={() => (isMobile ? closeDrawer() : collapseSidebar())}
          motion={isMobile ? null : sidebarMotion}
          onMotionEnd={endSidebarMotion}
          onSwitch={fromDrawer(switchToChat)}
          onOpenSearch={fromDrawer(() => setSearchOpen(true))}
          chatsLoading={!chatsHydrated}
          onDelete={deleteChat}
          onRename={renameChat}
          onOpenHome={fromDrawer(goHome)}
          onOpenSops={fromDrawer(() => openPage(PANEL_PATHS.sops))}
          onOpenMemory={fromDrawer(() => openPage(PANEL_PATHS.memory))}
          onOpenAgents={fromDrawer(() => openPage(PANEL_PATHS.agents))}
          onOpenSettings={fromDrawer(() => openPage(settingsPath(settingsTab)))}
          onOpenChat={fromDrawer((chatId: string, title: string) => void openChatById(chatId, title))}
          activePanel={activePanel === "chat" && !activeChatId && !blankChat ? "home" : activePanel}
          drawer={isMobile ? { open: drawerOpen } : undefined}
        />
      )}
      {isMobile && (
        <div
          className={`sidebar-scrim${drawerOpen ? " is-open" : ""}`}
          aria-hidden="true"
          onClick={() => closeDrawer()}
        />
      )}
      <div className="main" ref={mainRef}>
        {activePanel === "home" ? (
          <SkillPanel />
        ) : activePanel === "sops" ? (
          <SopPanel
            openId={sopId}
            onOpenChange={(id, replace) => {
              setSopId(id);
              navigate(id === null ? PANEL_PATHS.sops : sopPath(id), replace ? "replace" : "push");
            }}
          />
        ) : activePanel === "memory" ? (
          <MemoryPanel />
        ) : activePanel === "agents" ? (
          <AgentPanel onOpenAgentChat={openAgentChat} />
        ) : activePanel === "settings" ? (
          <SettingsPanel
            tab={settingsTab}
            onTabChange={(tab) => openPage(settingsPath(tab))}
            focusTool={focusTool}
            reloadKey={settingsKey}
            folders={chatFolders.folders}
            chats={chats}
            onCreateFolder={chatFolders.createFolder}
            onMoveChats={chatFolders.moveChats}
          />
        ) : activeChat && KindView ? (
          <KindView
            key={activeChat.id}
            chat={activeChat}
            onNewChat={startNewChat}
            composer={{
              input,
              onInput: setInput,
              attachments: draftFiles,
              onAddFiles: (files) => addFiles(draftKey, files),
              onRemoveAttachment: (key) => removeFile(draftKey, key),
              clearAttachments: () => updateFiles(draftKey, (items) => {
                for (const a of items) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                return [];
              }),
              references: draftRefs,
              onRemoveReference: (key) => removeRef(draftKey, key),
              clearReferences: () => updateRefs(draftKey, () => []),
            }}
          />
        ) : (
          <>
        <ChatHeader
          chatTitle={activeChat?.title}
          activeAgent={activeChat?.agentId ? agentById.get(activeChat.agentId) : undefined}
          displaySessionId={displaySessionId}
          contextPct={contextPct}
          artifactCount={artifactCount}
          artifactsOpen={!!artifactsPanel && artifactsPanel.sessionId === displaySessionId}
          onToggleArtifacts={() => {
            if (!displaySessionId) return;
            if (artifactsPanel && artifactsPanel.sessionId === displaySessionId) dismissArtifacts();
            else setArtifactsPanel({ sessionId: displaySessionId, view: { kind: "list" } });
          }}
          onHandoff={displaySessionId ? () => void sendMessage(HANDOFF_PROMPT) : undefined}
        />
        {activeNeedsLoad && displayMessages.length === 0 ? (
          // The composer stays hidden until the messages are here: sending now would start from an empty history.
          <div className="chat-loading" role="status">
            {chatLoadError === activeChatId ? (
              <>
                <span>Couldn't load this conversation.</span>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setLoadAttempt((n) => n + 1)}>
                  Try again
                </button>
              </>
            ) : (
              <span>Loading conversation…</span>
            )}
          </div>
        ) : displayMessages.length === 0 && !blankChat ? (
          <div className="chat-home">
            <div className="chat-home-inner">
              <ChatHero agent={activeChat?.agentId ? agentById.get(activeChat.agentId) : undefined} />
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
                  // Back to plain Rye: stay on Home.
                  else goHome();
                }}
                onInput={setInput}
                onSend={() => void sendMessage()}
                attachments={draftFiles}
                onAddFiles={(files) => addFiles(draftKey, files)}
                onRemoveAttachment={(key) => removeFile(draftKey, key)}
                references={draftRefs}
                onAddReference={(ref) => addRef(draftKey, ref)}
                onRemoveReference={(key) => removeRef(draftKey, key)}
              />
              <ChatExamples onSelect={setInput} />
            </div>
          </div>
        ) : (
          <>
        <div className="chat-stage">
        {/* A blank new chat shows the greeting where the messages will be; the first message floats it away. */}
        {(displayMessages.length === 0 || (heroExitId !== null && heroExitId === activeChatId)) && (
          <div className={`chat-blank-hero${displayMessages.length > 0 ? " is-leaving" : ""}`} aria-hidden={displayMessages.length > 0}>
            <ChatHero agent={activeChat?.agentId ? agentById.get(activeChat.agentId) : undefined} />
          </div>
        )}
        <ArtifactsPanelContext.Provider value={artifactsControl}>
        <MessageList
          messages={displayMessages}
          chatId={activeChatId}
          enableQuoteActions
          focusMessage={focusMessage && focusMessage.chatId === activeChatId ? focusMessage : undefined}
          sessionId={displaySessionId ?? ""}
          loading={loading}
          isViewingInflight={isViewingInflight || remoteRunning}
          onNewChat={startNewChat}
          onOpenArtifact={(id, version) => artifactsControl?.openFile(id, version)}
          onContinue={() => sendMessage("continue", undefined, undefined, "continue")}
          canResubmit={!loading && activeQueue.length === 0}
          onResubmit={(index, text) => resubmitFrom(index, text)}
          pendingPrompt={visiblePrompt ?? undefined}
          onPromptAnswer={(answer) => answerPrompt(answer)}
        />
        </ArtifactsPanelContext.Provider>
        </div>
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
          onSend={() => sendFromComposer()}
          promptPending={composerPrompt}
          attachments={draftFiles}
          onAddFiles={(files) => addFiles(draftKey, files)}
          onRemoveAttachment={(key) => removeFile(draftKey, key)}
          references={draftRefs}
          onAddReference={(ref) => addRef(draftKey, ref)}
          onRemoveReference={(key) => removeRef(draftKey, key)}
        />
          </>
        )}
          </>
        )}
      </div>
      {searchOpen && (
        <ChatSearchModal
          chats={chats}
          chatsLoading={!chatsHydrated}
          agentName={(id) => agentById.get(id)?.name}
          onClose={() => setSearchOpen(false)}
          onOpenAgent={openAgentChat}
          onNewChat={(draft) => {
            startNewChat();
            setActivePanel("chat");
            // What was typed in search becomes the new chat's draft, ready to send or edit.
            if (draft) setDraft(NEW_CHAT_DRAFT, draft);
          }}
          onOpen={(chatId, messageIndex) => {
            const chat = chatsRef.current.find((c) => c.id === chatId);
            if (!chat) return;
            switchToChat(chat);
            // The token makes opening the same result twice scroll to it again.
            setFocusMessage(messageIndex === undefined ? null : { chatId, index: messageIndex, token: Date.now() });
          }}
        />
      )}
      {artifactsPanel && activePanel === "chat" && !KindView && artifactsPanel.sessionId === displaySessionId && (
        <ArtifactsPanel
          key={artifactsPanel.sessionId ?? "no-session"}
          sessionId={artifactsPanel.sessionId}
          data={chatArtifacts}
          view={artifactsPanel.view}
          onViewChange={(view) => setArtifactsPanel({ sessionId: artifactsPanel.sessionId, view })}
          onClose={dismissArtifacts}
          pinned={artifactsPinned}
          onTogglePin={canPinArtifacts && !isMobile ? toggleArtifactsPin : undefined}
          leaving={artifactsLeaving}
        />
      )}
      <FolderSuggestionToast
        suggestionKey={chatFolders.suggestion?.chatId ?? null}
        chatTitle={chats.find((c) => c.id === chatFolders.suggestion?.chatId)?.title ?? ""}
        folderName={chatFolders.folders.find((f) => f.id === chatFolders.suggestion?.folderId)?.name ?? ""}
        onMove={() => chatFolders.suggestion && chatFolders.resolveSuggestion(chatFolders.suggestion, true)}
        onDismiss={() => chatFolders.suggestion && chatFolders.resolveSuggestion(chatFolders.suggestion, false)}
      />
      <NotificationNudge />
      {/* The quick chat: the same message list, composer and sendMessage as the chat above, in a floating card.
          After .main, so `.chat-input` lookups for the main composer still find that one first. */}
      {quickOpen && (
        <QuickChat
          replyModel={[...quickTarget.messages].reverse().find((m) => m.role === "assistant" && m.meta?.model)?.meta?.model}
          canNew={quickTarget.messages.length > 0 || Boolean(quickRun)}
          canSave={Boolean(quickTarget.sessionId) && !quickTarget.loading && quickTarget.messages.length > 0}
          onNew={() => {
            clearQuickChat();
            focusQuickChatComposer();
          }}
          onSave={saveQuickChat}
          onClose={() => setQuickOpen(false)}
        >
          <div className="quick-chat-body">
            {quickTarget.messages.length === 0 ? (
              <div className="quick-chat-empty">
                <p>Ask something quick. It isn't kept unless you save it as a chat.</p>
              </div>
            ) : (
              <MessageList
                key={quickEpoch}
                messages={quickTarget.messages}
                chatId={QUICK_CHAT_ID}
                sessionId={quickTarget.sessionId ?? ""}
                loading={quickTarget.loading}
                isViewingInflight={Boolean(quickRun)}
                onNewChat={startNewChat}
                onOpenArtifact={downloadQuickArtifact}
                onContinue={() => void sendMessage("continue", undefined, undefined, "continue", undefined, undefined, quickTarget)}
                canResubmit={!quickTarget.loading && quickQueue.length === 0}
                onResubmit={(index, text) => resubmitFrom(index, text, quickTarget)}
                pendingPrompt={quickTarget.prompt ?? undefined}
                onPromptAnswer={(answer) => answerPrompt(answer, quickTarget)}
              />
            )}
          </div>
          <MessageInput
            variant="compact"
            hideModelPicker
            input={drafts[QUICK_CHAT_ID] ?? ""}
            loading={quickTarget.loading}
            isViewingInflight={Boolean(quickRun)}
            queued={quickQueue.map((m) => m.text)}
            onEditQueued={(i) => {
              const item = quickQueue[i];
              if (!item) return;
              updateQueue((q) => q.filter((m) => m !== item));
              const cur = drafts[QUICK_CHAT_ID] ?? "";
              setDraft(QUICK_CHAT_ID, cur.trim() ? `${item.text}\n\n${cur}` : item.text);
              focusQuickChatComposer();
            }}
            onRemoveQueued={(i) => {
              const item = quickQueue[i];
              if (item) updateQueue((q) => q.filter((m) => m !== item));
            }}
            onStop={() => runsRef.current.get(QUICK_CHAT_ID)?.controller.abort()}
            onInput={(text) => setDraft(QUICK_CHAT_ID, text)}
            onSend={() => sendFromComposer(quickTarget)}
            promptPending={promptPendingFor(quickTarget)}
            attachments={fileDrafts[QUICK_CHAT_ID] ?? []}
            onAddFiles={(files) => addFiles(QUICK_CHAT_ID, files)}
            onRemoveAttachment={(key) => removeFile(QUICK_CHAT_ID, key)}
            references={refDrafts[QUICK_CHAT_ID] ?? []}
            onAddReference={(ref) => addRef(QUICK_CHAT_ID, ref)}
            onRemoveReference={(key) => removeRef(QUICK_CHAT_ID, key)}
            placeholder={quickTarget.loading || quickTarget.prompt ? undefined : "Ask a quick question…"}
          />
        </QuickChat>
      )}
    </div>
    </SidebarControlContext.Provider>
  );
}
