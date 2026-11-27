import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import {
  PenLine,
  PanelLeftClose,
  BookOpen,
  Home,
  Kanban,
  Brain,
  Bot,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Trash2,
  MessageCircle,
  Share2,
  Folder,
  FolderPlus,
  FolderMinus,
  Check,
  ChevronRight,
  Plus,
  Search,
  Settings as SettingsIcon,
  Shapes,
  X,
} from "lucide-react";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
import type { ChatKind } from "@rye/shared";
import type { ChatFolder, ChatRecord } from "../../utils/types";
import { kindClient, kindOf, useAvailableKinds, useCreatableKinds, type ChatKindClient } from "../../chat/kinds";
import { openAppPath } from "../../utils/routes";
import { useCodeSessionList } from "../../utils/codeApi";
import { ACTIVITY_LABEL } from "../code/codeFormat";
import { useAgents } from "../../contexts/AgentContext";
import AgentAvatar from "../agents/AgentAvatar";
import AgentHoverCard from "../agents/AgentHoverCard";
import StatusBar from "./StatusBar";
import EnvPicker from "./EnvPicker";
import Modal, { ModalCancelButton } from "../shared/Modal";

// Every spinner shares the document timeline's origin as its start time, so all of them rotate in phase.
// Re-applied on every render: reordering the chat list re-inserts the node, which restarts its CSS animation.
function WorkingSpinner({ label = "Working" }: { label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.getAnimations().forEach((animation) => {
      if (animation.startTime !== 0) animation.startTime = 0;
    });
  });
  return (
    <span
      ref={ref}
      className="sidebar-working"
      role="img"
      aria-label={label}
      title={label === "Working" ? undefined : label}
      onAnimationStart={(e) => e.currentTarget.getAnimations().forEach((animation) => { animation.startTime = 0; })}
    />
  );
}

const COLLAPSED_FOLDERS_KEY = "rye.collapsed-folders";
const DRAG_TYPE = "application/x-rye-chat";
const MENU_WIDTH = 192;

// The browser snapshots the row's square box; a copy on its own compositing layer keeps the corners transparent.
function setRoundedDragImage(e: React.DragEvent<HTMLElement>) {
  const row = e.currentTarget;
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.classList.add("sidebar-drag-image");
  ghost.style.width = `${rect.width}px`;
  row.parentElement?.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top);
  window.setTimeout(() => ghost.remove(), 0);
}

function readCollapsed(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLAPSED_FOLDERS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

// Places a fixed menu beside the trigger, flipping left when it would overflow.
function menuPositionFor(rect: DOMRect) {
  const gap = 8;
  const left = rect.right + gap + MENU_WIDTH <= window.innerWidth
    ? rect.right + gap
    : Math.max(gap, rect.left - MENU_WIDTH - gap);
  return { top: Math.min(rect.top - 8, window.innerHeight - 220), left };
}

// Opens below the trigger with its right edge on the trigger's, kept inside the sidebar and the window.
function dropdownBelow(trigger: HTMLElement) {
  const gap = 8;
  const rect = trigger.getBoundingClientRect();
  const bounds = trigger.closest(".sidebar")?.getBoundingClientRect();
  const minLeft = (bounds?.left ?? 0) + gap;
  const maxLeft = Math.min(bounds?.right ?? window.innerWidth, window.innerWidth) - MENU_WIDTH - gap;
  return { top: rect.bottom + 6, left: Math.max(minLeft, Math.min(rect.right - MENU_WIDTH, maxLeft)) };
}

/** The Chats header's "+" button: a small menu to start a chat, make a folder, or create another kind of chat (Create ▸). */
function NewMenu({ onNewChat, onNewFolder, createKinds = [], onCreateKind }: {
  onNewChat: () => void;
  /** Gets the trigger, so focus can go back to it when the folder dialog closes. */
  onNewFolder: (trigger: HTMLElement | null) => void;
  /** Kinds that can be created, or set up, from here (`useCreatableKinds`); Create ▸ shows only when there are some. */
  createKinds?: ChatKindClient[];
  onCreateKind?: (kind: ChatKind, trigger: HTMLElement | null) => void;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  /** The Create ▸ list: beside the menu, or (no room on either side, a phone) a sheet over it. */
  const [popout, setPopout] = useState<{ top: number; left: number; width: number; focus: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popoutRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const open = position !== null;

  const close = (focusButton = false) => {
    window.clearTimeout(closeTimer.current);
    setPosition(null);
    setPopout(null);
    if (focusButton) buttonRef.current?.focus();
  };

  const openPopout = (focus: boolean) => {
    window.clearTimeout(closeTimer.current);
    const menu = menuRef.current?.getBoundingClientRect();
    const row = createRef.current?.getBoundingClientRect();
    if (!menu || !row) return;
    const gap = 4;
    const width = MENU_WIDTH;
    const fitsRight = menu.right + gap + width <= window.innerWidth - 8;
    const fitsLeft = menu.left - gap - width >= 8;
    const top = Math.max(8, Math.min(row.top - 5, window.innerHeight - 160));
    const next = fitsRight || fitsLeft
      ? { top, left: fitsRight ? menu.right + gap : menu.left - width - gap, width, focus }
      : { top: Math.min(menu.bottom + 4, window.innerHeight - 8 - 48 * Math.max(1, createKinds.length)), left: 8, width: window.innerWidth - 16, focus };
    setPopout((current) => (current && !focus ? current : next));
  };

  const scheduleClosePopout = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (popoutRef.current?.contains(document.activeElement)) return;
      setPopout(null);
    }, 220);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (popout?.focus) popoutRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [popout]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target) && !popoutRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // From the Create list, Escape goes back to its row first.
      if (popoutRef.current?.contains(document.activeElement)) {
        setPopout(null);
        createRef.current?.focus();
        return;
      }
      close(true);
    };
    const onResize = () => close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const show = () => {
    if (buttonRef.current) setPosition(dropdownBelow(buttonRef.current));
  };

  const menuKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowRight" && document.activeElement === createRef.current) {
      e.preventDefault();
      openPopout(true);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else {
      // Tab leaves the menu: close it rather than let focus fall to the page behind it.
      if (e.key === "Tab") {
        e.preventDefault();
        close(true);
      }
      return;
    }
    e.preventDefault();
    items[next]?.focus();
    if (items[next] !== createRef.current) setPopout(null);
  };

  const popoutKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPopout(null);
      createRef.current?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };

  const run = (action: () => void) => {
    setPosition(null);
    setPopout(null);
    action();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn muted sidebar-new-btn"
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            show();
          }
        }}
        title="New chat or folder"
        aria-label="New chat or folder"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "sidebar-new-menu" : undefined}
      >
        <Plus size={16} />
      </button>
      {position && (
        <div
          ref={menuRef}
          id="sidebar-new-menu"
          className="sidebar-dropdown sidebar-new-menu"
          role="menu"
          aria-label="New"
          style={{ top: position.top, left: position.left }}
          onKeyDown={menuKeys}
          // The pointer and the arrow keys move one highlight, not two.
          onMouseMove={(e) => {
            const item = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="menuitem"]');
            if (item && item !== document.activeElement) item.focus();
            if (item && item !== createRef.current && popout) setPopout(null);
          }}
        >
          <button type="button" className="sidebar-dropdown-item" role="menuitem" onClick={() => run(onNewChat)}>
            <PenLine size={17} aria-hidden="true" />
            <span>New chat</span>
          </button>
          <button
            type="button"
            className="sidebar-dropdown-item"
            role="menuitem"
            onClick={() => run(() => onNewFolder(buttonRef.current))}
          >
            <FolderPlus size={17} aria-hidden="true" />
            <span>New folder…</span>
          </button>
          {createKinds.length > 0 && onCreateKind && (
            <button
              ref={createRef}
              type="button"
              className="sidebar-dropdown-item"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={popout !== null}
              aria-controls={popout ? "sidebar-create-menu" : undefined}
              onMouseEnter={() => openPopout(false)}
              onMouseLeave={scheduleClosePopout}
              onClick={() => openPopout(true)}
            >
              <Shapes size={17} aria-hidden="true" />
              <span>Create</span>
              <ChevronRight className="sidebar-dropdown-chevron" size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {position && popout && onCreateKind && (
        <div
          ref={popoutRef}
          id="sidebar-create-menu"
          className="sidebar-dropdown sidebar-new-menu sidebar-create-popout"
          role="menu"
          aria-label="Create"
          style={{ top: popout.top, left: popout.left, width: popout.width }}
          onKeyDown={popoutKeys}
          onMouseEnter={() => window.clearTimeout(closeTimer.current)}
          onMouseLeave={scheduleClosePopout}
          onMouseMove={(e) => {
            const item = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="menuitem"]');
            if (item && item !== document.activeElement) item.focus();
          }}
        >
          {createKinds.map((kind) => (
            <button
              key={kind.id}
              type="button"
              className="sidebar-dropdown-item"
              role="menuitem"
              onClick={() => run(() => onCreateKind(kind.id, buttonRef.current))}
            >
              <kind.icon size={17} aria-hidden="true" />
              <span>{kind.newMenuLabel}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

type FolderModal =
  | { kind: "create"; moveChatId?: string }
  | { kind: "rename"; folder: ChatFolder }
  | { kind: "delete"; folder: ChatFolder };

interface Props {
  chats: ChatRecord[];
  folders: ChatFolder[];
  onCreateFolder: (name: string) => Promise<ChatFolder>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onMoveChats: (ids: string[], folderId: string | null) => Promise<void>;
  activeChatId: string | undefined;
  runningChatIds: ReadonlySet<string>;
  envKey: string | undefined;
  onEnvChange: (key: string) => void;
  activePanel: "home" | "chat" | "sops" | "memory" | "agents" | "settings";
  onNewChat: () => void;
  onClose: () => void;
  onSwitch: (chat: ChatRecord) => void;
  /** Open the chat search dialog (also on Cmd/Ctrl+K). */
  onOpenSearch: () => void;
  /** The chat list hasn't arrived from the server yet. */
  chatsLoading?: boolean;
  /** Delete a chat. The sidebar asks for confirmation before calling it. */
  onDelete: (id: string, e?: React.MouseEvent) => void;
  onRename: (id: string, title: string) => void;
  /** Home ("/"): the greeting, large composer and starter prompts. */
  onOpenHome?: () => void;
  onOpenSops: () => void;
  onOpenMemory: () => void;
  onOpenAgents: () => void;
  onOpenSettings: () => void;
  /** Phone width: the sidebar is a drawer over the content (App.tsx), open or slid away. */
  drawer?: { open: boolean };
  /** A chat made from + ▸ Create (a code session…): open it, fetching the list first if needed. */
  onOpenChat?: (chatId: string, title: string) => void;
  /** Desktop: sliding in after being collapsed, or out before it unmounts (App waits for onMotionEnd). */
  motion?: "in" | "out" | null;
  onMotionEnd?: (motion: "in" | "out") => void;
}

export default function Sidebar({
  chats,
  folders,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveChats,
  activeChatId,
  runningChatIds,
  envKey,
  onEnvChange,
  activePanel,
  onNewChat,
  onClose,
  onSwitch,
  onDelete,
  onRename,
  onOpenSearch,
  chatsLoading = false,
  onOpenHome,
  onOpenSops,
  onOpenMemory,
  onOpenAgents,
  onOpenSettings,
  drawer,
  onOpenChat,
  motion = null,
  onMotionEnd,
}: Props) {
  // The nav items carry no counts (the user's call), so the sidebar doesn't load SOPs or memories.
  const { agentById } = useAgents();
  // Chat kinds the server supports (chat/kinds.tsx): with only plain chats, no filter and no Create ▸.
  const kinds = useAvailableKinds();
  // Create ▸ also lists kinds that only need setting up; those open their setup dialog, which turns
  // into the "New…" dialog as soon as the kind becomes available.
  const createKinds = useCreatableKinds();
  const [creatingKind, setCreatingKind] = useState<ChatKind | null>(null);
  const createReturnFocusRef = useRef<HTMLElement | null>(null);
  const creatingReady = creatingKind !== null && kinds.some((k) => k.id === creatingKind);
  const CreateDialog = creatingKind && creatingReady ? kindClient(creatingKind)?.NewDialog : undefined;
  const SetupDialog = creatingKind && !creatingReady ? kindClient(creatingKind)?.SetupDialog : undefined;
  // Code sessions' live state, for the row indicators.
  const codeSessions = useCodeSessionList();
  const codeByChat = new Map(codeSessions.map((s) => [s.chatId, s]));
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<FolderModal | null>(null);
  /** The chat waiting for "Delete chat" to be confirmed. */
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<{ id: string; title: string; code?: boolean } | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The folder dialog doesn't restore focus itself; this is where it goes when the dialog closes.
  const folderReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (folderModal || !folderReturnFocusRef.current) return;
    folderReturnFocusRef.current.focus();
    folderReturnFocusRef.current = null;
  }, [folderModal]);

  useEffect(() => {
    if (!openMenuId && !folderMenuId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId, folderMenuId]);

  useEffect(() => {
    if (submenuPosition) submenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [submenuPosition]);

  function closeMenus() {
    setOpenMenuId(null);
    setFolderMenuId(null);
    setSubmenuPosition(null);
  }

  function toggleFolder(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      try {
        window.localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...next]));
      } catch {
        // Not persisted in private mode.
      }
      return next;
    });
  }

  function moveChat(chatId: string, folderId: string | null) {
    closeMenus();
    void onMoveChats([chatId], folderId).catch(() => {});
  }

  function openFolderModal(modal: FolderModal) {
    closeMenus();
    setFolderModal(modal);
    setFolderName(modal.kind === "rename" ? modal.folder.name : "");
    setFolderError(null);
  }

  async function submitFolderModal(event?: React.FormEvent) {
    event?.preventDefault();
    if (!folderModal || folderBusy) return;
    const name = folderName.trim();
    if (folderModal.kind !== "delete" && !name) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      if (folderModal.kind === "delete") await onDeleteFolder(folderModal.folder.id);
      else if (folderModal.kind === "rename") await onRenameFolder(folderModal.folder.id, name);
      else {
        const folder = await onCreateFolder(name);
        if (folderModal.moveChatId) await onMoveChats([folderModal.moveChatId], folder.id);
      }
      setFolderModal(null);
    } catch (err) {
      setFolderError(err instanceof Error ? err.message : String(err));
    } finally {
      setFolderBusy(false);
    }
  }

  // Drag a chat onto a folder to file it, or onto the unfiled list to remove it from its folder.
  function dropProps(target: string | null) {
    const key = target ?? "";
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dropTarget !== key) setDropTarget(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const chat = chats.find((c) => c.id === e.dataTransfer.getData(DRAG_TYPE));
        if (chat && (chat.folderId ?? null) !== target) void onMoveChats([chat.id], target).catch(() => {});
      },
    };
  }

  async function shareChat(listed: ChatRecord) {
    // The sidebar's list holds titles only for chats that haven't been opened; get the messages first.
    let chat = listed;
    if (listed.partial) {
      try {
        const res = await fetch(`/chat/history/${listed.id}`);
        if (!res.ok) return;
        chat = (await res.json()) as ChatRecord;
      } catch {
        return;
      }
    }
    const transcript = chat.messages
      .filter((message) => message.kind !== "approval")
      .map((message) =>
        message.kind === "answer"
          ? `Answered: ${message.content}`
          : `${message.role === "user" ? "You" : "Rye"}: ${message.content}`
      )
      .join("\n\n");
    try {
      if (navigator.share) {
        await navigator.share({ title: chat.title, text: transcript });
      } else {
        await navigator.clipboard.writeText(transcript);
      }
    } catch {
      // Closing the native share sheet is not an error the UI needs to surface.
    }
    setOpenMenuId(null);
  }

  function startRename(chat: ChatRecord) {
    setOpenMenuId(null);
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  }

  function commitRename(event?: React.FormEvent) {
    event?.preventDefault();
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }

  // Group chats by time bucket
  function groupChats(chats: ChatRecord[]) {
    const now = Date.now();
    const DAY = 86_400_000;
    const groups: { label: string; items: ChatRecord[] }[] = [
      { label: "Today", items: [] },
      { label: "Yesterday", items: [] },
      { label: "Previous 7 days", items: [] },
      { label: "Previous 30 days", items: [] },
      { label: "Older", items: [] },
    ];
    for (const chat of chats) {
      const age = now - (chat.updatedAt ?? 0);
      if (age < DAY) groups[0].items.push(chat);
      else if (age < 2 * DAY) groups[1].items.push(chat);
      else if (age < 7 * DAY) groups[2].items.push(chat);
      else if (age < 30 * DAY) groups[3].items.push(chat);
      else groups[4].items.push(chat);
    }
    return groups.filter((g) => g.items.length > 0);
  }

  function renderChat(chat: ChatRecord) {
    const isActive = chat.id === activeChatId;
    // A code chat (when the server has code sessions) shows its kind's icon and its session's state.
    const kind = kindOf(chat);
    const KindIcon = kind !== "chat" && kinds.some((k) => k.id === kind) ? kindClient(kind)?.icon : undefined;
    const activity = kind === "code" ? codeByChat.get(chat.id)?.activity : undefined;
    const isRunning = runningChatIds.has(chat.id) || activity === "running";
    // The agent asked a question or needs an approval and is waiting on the user.
    const isWaiting = (Boolean(chat.pendingPrompt) && !isRunning) || activity === "needs_approval";
    const isReady = activity === "ready" && !isActive;
    const isFailed = activity === "error";
    const menuOpen = openMenuId === chat.id;
    const currentFolderId = chat.folderId && folders.some((f) => f.id === chat.folderId) ? chat.folderId : undefined;
    const chatAgent = chat.agentId ? agentById.get(chat.agentId) : undefined;
    return (
      <div
        key={chat.id}
        className={`sidebar-item${isActive ? " active" : ""}`}
        onClick={() => onSwitch(chat)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, chat.id);
          e.dataTransfer.effectAllowed = "move";
          setRoundedDragImage(e);
        }}
        onDragEnd={() => setDropTarget(null)}
      >
        {chatAgent && (
          <span style={{ marginRight: 8, display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
            <AgentHoverCard agent={chatAgent} placement="right">
              <AgentAvatar agent={chatAgent} size="xs" hideTooltip />
            </AgentHoverCard>
          </span>
        )}
        {!chatAgent && KindIcon && (
          <span className="sidebar-kind-icon" aria-hidden="true">
            <KindIcon size={16} />
          </span>
        )}
        <span className="sidebar-item-title">
          {KindIcon && <span className="attach-sr-only">{kindClient(kind)?.label}: </span>}
          {chatAgent ? chatAgent.name : chat.title}
        </span>
        {(isRunning || chat.unread || isWaiting || isReady || isFailed) && (
          <span className="sidebar-item-indicators">
            {isRunning && !isWaiting && <WorkingSpinner label={activity ? ACTIVITY_LABEL.running : "Working"} />}
            {isWaiting ? (
              <span
                className="sidebar-unread sidebar-waiting"
                role="img"
                aria-label={activity === "needs_approval" ? ACTIVITY_LABEL.needs_approval : "Waiting for you"}
                title={activity === "needs_approval" ? ACTIVITY_LABEL.needs_approval : "Waiting for you"}
              />
            ) : isFailed ? (
              <span className="sidebar-unread sidebar-failed" role="img" aria-label={ACTIVITY_LABEL.error} title={ACTIVITY_LABEL.error} />
            ) : isReady && !isRunning ? (
              <span className="sidebar-unread sidebar-ready" role="img" aria-label={ACTIVITY_LABEL.ready} title={ACTIVITY_LABEL.ready} />
            ) : (
              chat.unread && <span className="sidebar-unread" role="img" aria-label="Unread" />
            )}
          </span>
        )}
        <div
          className={`sidebar-item-menu${menuOpen ? " open" : ""}`}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="icon-btn sidebar-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setMenuPosition(menuPositionFor(e.currentTarget.getBoundingClientRect()));
              setSubmenuPosition(null);
              setFolderMenuId(null);
              setOpenMenuId(menuOpen ? null : chat.id);
            }}
            title="Options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreVertical size={14} />
          </button>
          {menuOpen && (
            <>
              <div
                className="sidebar-dropdown-backdrop"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  closeMenus();
                }}
              />
              <div
                className="sidebar-dropdown"
                role="menu"
                style={{ top: menuPosition.top, left: menuPosition.left }}
              >
                <button
                  className="sidebar-dropdown-item"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    void shareChat(chat);
                  }}
                >
                  <Share2 size={17} />
                  <span>Share</span>
                </button>
                <button
                  className="sidebar-dropdown-item"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(chat);
                  }}
                >
                  <Pencil size={17} />
                  <span>Rename</span>
                </button>
                <button
                  className="sidebar-dropdown-item sidebar-dropdown-project"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={submenuPosition !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const right = menuPosition.left + MENU_WIDTH + 4;
                    setSubmenuPosition(submenuPosition ? null : {
                      top: Math.max(8, Math.min(rect.top - 5, window.innerHeight - 280)),
                      left: right + MENU_WIDTH <= window.innerWidth ? right : Math.max(8, menuPosition.left - MENU_WIDTH - 4),
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight") e.currentTarget.click();
                  }}
                >
                  <Folder size={17} />
                  <span>Move to folder</span>
                  <ChevronRight className="sidebar-dropdown-chevron" size={16} />
                </button>
                <button
                  className="sidebar-dropdown-item danger"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeMenus();
                    // Deleting can't be undone, so ask first.
                    setConfirmDeleteChat({ id: chat.id, title: chatAgent?.name ?? chat.title, ...(KindIcon && kind === "code" ? { code: true } : {}) });
                  }}
                >
                  <Trash2 size={17} />
                  <span>Delete</span>
                </button>
              </div>
              {submenuPosition && (
                <div
                  ref={submenuRef}
                  className="sidebar-dropdown sidebar-submenu"
                  role="menu"
                  aria-label="Move to folder"
                  style={{ top: submenuPosition.top, left: submenuPosition.left }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") setSubmenuPosition(null);
                  }}
                >
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      className="sidebar-dropdown-item"
                      role="menuitemradio"
                      aria-checked={folder.id === currentFolderId}
                      disabled={folder.id === currentFolderId}
                      onClick={() => moveChat(chat.id, folder.id)}
                    >
                      {folder.id === currentFolderId ? <Check size={17} /> : <Folder size={17} />}
                      <span className="sidebar-dropdown-label">{folder.name}</span>
                    </button>
                  ))}
                  {folders.length > 0 && <div className="sidebar-dropdown-separator" role="separator" />}
                  <button
                    className="sidebar-dropdown-item"
                    role="menuitem"
                    onClick={() => openFolderModal({ kind: "create", moveChatId: chat.id })}
                  >
                    <FolderPlus size={17} />
                    <span>New folder…</span>
                  </button>
                  {currentFolderId && (
                    <button className="sidebar-dropdown-item" role="menuitem" onClick={() => moveChat(chat.id, null)}>
                      <FolderMinus size={17} />
                      <span>Remove from folder</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sidebar${drawer ? ` sidebar--drawer${drawer.open ? " is-open" : ""}` : ""}${
        !drawer && motion === "in" ? " is-entering" : ""
      }${!drawer && motion === "out" ? " is-leaving" : ""}`}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && motion) onMotionEnd?.(motion);
      }}
      id="app-sidebar"
      role={drawer ? "dialog" : undefined}
      aria-modal={drawer ? true : undefined}
      aria-label={drawer ? "Menu" : undefined}
    >
      <div className="sidebar-header">
        <span className="sidebar-wordmark">Rye</span>
        {drawer ? (
          <button type="button" className="icon-btn faint sidebar-close-btn" onClick={onClose} title="Close menu" aria-label="Close menu">
            <X size={20} aria-hidden="true" />
          </button>
        ) : (
          <button className="icon-btn faint" onClick={onClose} title="Close sidebar">
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {/* Quick Access */}
      <div className="sidebar-section">

        <button
          className={`sidebar-nav-item${activePanel === "home" ? " active" : ""}`}
          onClick={onOpenHome}
          disabled={!onOpenHome}
        >
          <Home size={13} />
          <span>Home</span>
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "agents" ? " active" : ""}`}
          onClick={onOpenAgents}
        >
          <Bot size={13} />
          <span>Agents</span>
        </button>

        <button className="sidebar-nav-item" disabled title="Coming soon">
          <Kanban size={13} />
          <span>Tasks</span>
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "sops" ? " active" : ""}`}
          onClick={onOpenSops}
        >
          <BookOpen size={13} />
          <span>SOPs</span>
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "memory" ? " active" : ""}`}
          onClick={onOpenMemory}
        >
          <Brain size={13} />
          <span>Memory</span>
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "settings" ? " active" : ""}`}
          onClick={onOpenSettings}
        >
          <SettingsIcon size={13} />
          <span>Settings</span>
        </button>
      </div>

      {/* Chats */}
      <div className="sidebar-section sidebar-chats-section">
        <div className="sidebar-section-label">
          <span>Chats</span>
          <span className="sidebar-section-actions">
            <button className="icon-btn muted" onClick={onOpenSearch} title={`Search chats (${isMac ? "⌘K" : "Ctrl+K"})`} aria-label="Search chats and messages">
              <Search size={15} />
            </button>
            <NewMenu
              onNewChat={() => {
                closeMenus();
                onNewChat();
              }}
              onNewFolder={(trigger) => {
                folderReturnFocusRef.current = trigger;
                openFolderModal({ kind: "create" });
              }}
              createKinds={createKinds}
              onCreateKind={(kind, trigger) => {
                closeMenus();
                createReturnFocusRef.current = trigger;
                setCreatingKind(kind);
              }}
            />
          </span>
        </div>
        <div className="sidebar-list">
          {chats.length === 0 && folders.length === 0 && (
            // Until the list has arrived, "none yet" would be a guess.
            <div className="sidebar-empty" role="status">{chatsLoading ? "Loading chats…" : "No conversations yet."}</div>
          )}
          {folders.map((folder) => {
            const items = chats.filter((c) => c.folderId === folder.id);
            const isCollapsed = collapsed.has(folder.id);
            const anyRunning = items.some((c) => runningChatIds.has(c.id));
            const anyUnread = items.some((c) => c.unread);
            const holdsActive = isCollapsed && items.some((c) => c.id === activeChatId);
            const menuOpen = folderMenuId === folder.id;
            return (
              <div
                key={folder.id}
                className={`sidebar-folder${dropTarget === folder.id ? " drop-target" : ""}`}
                {...dropProps(folder.id)}
              >
                <div className={`sidebar-folder-row${holdsActive ? " active" : ""}`}>
                  <button
                    type="button"
                    className="sidebar-folder-toggle"
                    aria-expanded={!isCollapsed}
                    aria-current={holdsActive ? "true" : undefined}
                    title={holdsActive ? "Contains the open chat" : undefined}
                    onClick={() => toggleFolder(folder.id)}
                  >
                    <ChevronRight size={13} className="sidebar-folder-chevron" aria-hidden="true" />
                    <Folder size={13} aria-hidden="true" />
                    <span className="sidebar-folder-name">{folder.name}</span>
                    {isCollapsed && (anyRunning || anyUnread) && (
                      <span className="sidebar-item-indicators">
                        {anyRunning && <WorkingSpinner />}
                        {anyUnread && <span className="sidebar-unread" role="img" aria-label="Unread" />}
                      </span>
                    )}
                    <span className="sidebar-sops-count" aria-label={`${items.length} chats`}>{items.length}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn sidebar-folder-menu-btn"
                    onClick={(e) => {
                      setMenuPosition(menuPositionFor(e.currentTarget.getBoundingClientRect()));
                      setOpenMenuId(null);
                      setFolderMenuId(menuOpen ? null : folder.id);
                    }}
                    aria-label={`Options for ${folder.name}`}
                    title="Folder options"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {menuOpen && (
                    <>
                      <div className="sidebar-dropdown-backdrop" aria-hidden="true" onClick={closeMenus} />
                      <div className="sidebar-dropdown" role="menu" style={{ top: menuPosition.top, left: menuPosition.left }}>
                        <button
                          className="sidebar-dropdown-item"
                          role="menuitem"
                          autoFocus
                          onClick={() => openFolderModal({ kind: "rename", folder })}
                        >
                          <Pencil size={17} />
                          <span>Rename</span>
                        </button>
                        <button
                          className="sidebar-dropdown-item danger"
                          role="menuitem"
                          onClick={() => openFolderModal({ kind: "delete", folder })}
                        >
                          <Trash2 size={17} />
                          <span>Delete</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="sidebar-folder-items">
                    {items.length === 0 ? <div className="sidebar-folder-empty">No chats</div> : items.map(renderChat)}
                  </div>
                )}
              </div>
            );
          })}
          <div
            className={`sidebar-unfiled${dropTarget === "" ? " drop-target" : ""}`}
            {...dropProps(null)}
          >
          {groupChats(chats.filter((c) => !c.folderId || !folders.some((f) => f.id === c.folderId))).map((group) => (
            <div className="sidebar-list-group" key={group.label}>
              <div className="sidebar-list-group-label">{group.label}</div>
              {group.items.map(renderChat)}
            </div>
          ))}
          </div>
        </div>
      </div>

      <div className="sidebar-footer">
        <EnvPicker value={envKey} onChange={onEnvChange} />
        <StatusBar />
      </div>

      {renamingId && (
        <Modal
          title="Rename chat"
          description="Give this chat a name that's easy to find later."
          className="sidebar-rename-modal modal--compact"
          onClose={() => setRenamingId(null)}
          lockBackdrop
          guardDismiss={renameValue.trim() !== (chats.find((c) => c.id === renamingId)?.title ?? "").trim()}
          guardMessage="Your new chat name hasn't been saved. If you close now, it will be lost."
          footer={
            <>
              <ModalCancelButton />
              <button
                type="submit"
                form="sidebar-rename-form"
                className="btn btn--primary btn--sm"
                disabled={!renameValue.trim()}
              >
                Rename
              </button>
            </>
          }
        >
          <form id="sidebar-rename-form" className="sidebar-rename-form" onSubmit={commitRename}>
            <label className="sidebar-rename-label" htmlFor="sidebar-rename-title">
              Chat name
            </label>
            <input
              id="sidebar-rename-title"
              className="sidebar-rename-modal-input"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
          </form>
        </Modal>
      )}

      {CreateDialog && (
        <CreateDialog
          onClose={() => {
            setCreatingKind(null);
            createReturnFocusRef.current?.focus();
            createReturnFocusRef.current = null;
          }}
          onCreated={(chatId, title) => {
            setCreatingKind(null);
            createReturnFocusRef.current = null;
            onOpenChat?.(chatId, title);
          }}
        />
      )}

      {SetupDialog && (
        <SetupDialog
          onClose={() => {
            setCreatingKind(null);
            createReturnFocusRef.current?.focus();
            createReturnFocusRef.current = null;
          }}
          onOpenPage={(path) => {
            setCreatingKind(null);
            createReturnFocusRef.current = null;
            openAppPath(path);
            // A page chosen from the phone drawer closes it, as the nav items do.
            if (drawer?.open) onClose();
          }}
        />
      )}

      {confirmDeleteChat && (
        <Modal
          title={`Delete “${confirmDeleteChat.title.length > 60 ? `${confirmDeleteChat.title.slice(0, 60)}…` : confirmDeleteChat.title}”?`}
          description={
            confirmDeleteChat.code
              ? "The chat is deleted and its code session is archived: its snapshots stay, so it can be restored from Settings → Code. Branches you created are kept."
              : "The chat and all its messages are deleted. This can't be undone."
          }
          className="sidebar-rename-modal modal--compact"
          onClose={() => setConfirmDeleteChat(null)}
          footer={
            <>
              <ModalCancelButton autoFocus />
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={() => {
                  const { id } = confirmDeleteChat;
                  setConfirmDeleteChat(null);
                  onDelete(id);
                }}
              >
                Delete chat
              </button>
            </>
          }
        >
          {null}
        </Modal>
      )}

      {folderModal?.kind === "delete" && (
        <Modal
          title={`Delete “${folderModal.folder.name}”?`}
          description="The chats in this folder are not deleted. They move back to your chat list."
          className="sidebar-rename-modal modal--compact"
          onClose={() => setFolderModal(null)}
          footer={
            <>
              <ModalCancelButton />
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={folderBusy}
                onClick={() => void submitFolderModal()}
              >
                Delete folder
              </button>
            </>
          }
        >
          {folderError && <div className="settings-error" role="alert">{folderError}</div>}
        </Modal>
      )}

      {folderModal && folderModal.kind !== "delete" && (
        <Modal
          title={folderModal.kind === "rename" ? "Rename folder" : "New folder"}
          description={folderModal.kind === "create" && folderModal.moveChatId ? "The chat moves into the new folder." : undefined}
          className="sidebar-rename-modal modal--compact"
          onClose={() => setFolderModal(null)}
          lockBackdrop
          footer={
            <>
              <ModalCancelButton />
              <button
                type="submit"
                form="sidebar-folder-form"
                className="btn btn--primary btn--sm"
                disabled={!folderName.trim() || folderBusy}
              >
                {folderModal.kind === "rename" ? "Rename" : "Create"}
              </button>
            </>
          }
        >
          <form id="sidebar-folder-form" className="sidebar-rename-form" onSubmit={(e) => void submitFolderModal(e)}>
            <label className="sidebar-rename-label" htmlFor="sidebar-folder-name">
              Folder name
            </label>
            <input
              id="sidebar-folder-name"
              className="sidebar-rename-modal-input"
              value={folderName}
              maxLength={60}
              onChange={(event) => setFolderName(event.target.value)}
              aria-invalid={folderError ? true : undefined}
              aria-describedby={folderError ? "sidebar-folder-error" : undefined}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
            {folderError && <div id="sidebar-folder-error" className="settings-error" role="alert">{folderError}</div>}
          </form>
        </Modal>
      )}
    </div>
  );
}