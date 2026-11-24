import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import {
  PenLine,
  PanelLeftClose,
  BookOpen,
  Home,
  Kanban,
  Brain,
  Bot,
  BarChart3,
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
  Search,
  Settings as SettingsIcon,
} from "lucide-react";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
import type { ChatFolder, ChatRecord } from "../../utils/types";
import { useSops } from "../../contexts/SopContext";
import { useMemories } from "../../contexts/MemoryContext";
import { useAgents } from "../../contexts/AgentContext";
import AgentAvatar from "../agents/AgentAvatar";
import AgentHoverCard from "../agents/AgentHoverCard";
import StatusBar from "./StatusBar";
import EnvPicker from "./EnvPicker";
import Modal, { ModalCancelButton } from "../shared/Modal";

// Every spinner shares the document timeline's origin as its start time, so all of them rotate in phase.
// Re-applied on every render: reordering the chat list re-inserts the node, which restarts its CSS animation.
function WorkingSpinner() {
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
      aria-label="Working"
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
  activePanel: "home" | "chat" | "sops" | "memory" | "agents" | "analytics" | "settings";
  onNewChat: () => void;
  onClose: () => void;
  onSwitch: (chat: ChatRecord) => void;
  /** Open the chat search dialog (also on Cmd/Ctrl+K). */
  onOpenSearch: () => void;
  /** The chat list hasn't arrived from the server yet. */
  chatsLoading?: boolean;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, title: string) => void;
  onOpenSops: () => void;
  onOpenMemory: () => void;
  onOpenAgents: () => void;
  onOpenAnalytics: () => void;
  onOpenSettings: () => void;
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
  onOpenSops,
  onOpenMemory,
  onOpenAgents,
  onOpenAnalytics,
  onOpenSettings,
}: Props) {
  const { sops } = useSops();
  const { memories } = useMemories();
  const { agents, agentById } = useAgents();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<FolderModal | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

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
    const isRunning = runningChatIds.has(chat.id);
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
          <span style={{ marginRight: 7, display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
            <AgentHoverCard agent={chatAgent} placement="right">
              <AgentAvatar agent={chatAgent} size="xs" hideTooltip />
            </AgentHoverCard>
          </span>
        )}
        <span className="sidebar-item-title">{chatAgent ? chatAgent.name : chat.title}</span>
        {(isRunning || chat.unread) && (
          <span className="sidebar-item-indicators">
            {isRunning && <WorkingSpinner />}
            {chat.unread && <span className="sidebar-unread" role="img" aria-label="Unread" />}
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
                    onDelete(chat.id, e);
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
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-wordmark">Rye</span>
        <button className="icon-btn faint" onClick={onClose} title="Close sidebar">
          <PanelLeftClose size={18} />
        </button>
      </div>

      {/* Quick Access */}
      <div className="sidebar-section">

        <button className="sidebar-nav-item" disabled title="Coming soon">
          <Home size={13} />
          <span>Home</span>
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "analytics" ? " active" : ""}`}
          onClick={onOpenAnalytics}
        >
          <BarChart3 size={13} />
          <span>Analytics</span>
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "agents" ? " active" : ""}`}
          onClick={onOpenAgents}
        >
          <Bot size={13} />
          <span>Agents</span>
          {agents !== null && <span className="sidebar-sops-count">{agents.length}</span>}
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
          {sops !== null && <span className="sidebar-sops-count">{sops.length}</span>}
        </button>

        <button
          className={`sidebar-nav-item${activePanel === "memory" ? " active" : ""}`}
          onClick={onOpenMemory}
        >
          <Brain size={13} />
          <span>Memory</span>
          {memories !== null && <span className="sidebar-sops-count">{memories.length}</span>}
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
            <button className="icon-btn muted" onClick={() => openFolderModal({ kind: "create" })} title="New folder" aria-label="New folder">
              <FolderPlus size={15} />
            </button>
            <button className="icon-btn muted" onClick={onNewChat} title="New chat" aria-label="New chat">
              <PenLine size={15} />
            </button>
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