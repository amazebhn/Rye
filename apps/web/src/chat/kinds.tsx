/**
 * Chat kinds on the web (docs/design/code-sessions.md §4.2): what each kind of chat looks like and how
 * one is started. A kind registers here once and the rest follows: its icon in the sidebar row, its
 * entry in the sidebar's + ▸ Create menu (built from `newMenuLabel` and `NewDialog`), its sidebar
 * filter, and the view that replaces the plain conversation for chats of that kind.
 *
 * A later `document` kind (pptx, pdf, docx) is one more entry here; nothing else needs plumbing.
 * Every kind's entry points stay hidden until `useAvailable()` says the server supports it, except its
 * + ▸ Create entry while `useNeedsSetup()` says it only needs setting up (it opens `SetupDialog`).
 */

import type React from "react";
import { MessageCircle, SquareCode, type LucideIcon } from "lucide-react";
import type { ChatKind } from "@rye/shared";
import type { ChatRecord } from "../utils/types";
import { useCodeAvailable, useCodeSetup } from "../utils/codeApi";
import NewCodeSessionDialog from "../components/code/NewCodeSessionDialog";
import CodeSetupDialog from "../components/code/CodeSetup";
import CodeSessionView, { type CodeSessionViewProps } from "../components/code/CodeSessionView";

export interface ChatKindClient {
  id: ChatKind;
  /** "Code session". */
  label: string;
  /** The sidebar filter's label ("Code"). */
  filterLabel: string;
  icon: LucideIcon;
  /** The + ▸ Create menu entry ("Code session…"); left out, the kind isn't created from the menu. */
  newMenuLabel?: string;
  /** The "New…" dialog; `onCreated` gets the new chat's id. */
  NewDialog?: React.FC<{ onClose: () => void; onCreated: (chatId: string, title: string) => void }>;
  /** Replaces the plain conversation for a chat of this kind. */
  View?: React.FC<CodeSessionViewProps>;
  /** The server supports this kind (a hook: it may probe a route). */
  useAvailable: () => boolean;
  /**
   * The server knows this kind but it isn't set up yet (a hook). Then only its + ▸ Create entry shows
   * (no filter, no icons), and opens `SetupDialog` instead of `NewDialog`.
   */
  useNeedsSetup?: () => boolean;
  /** How to set the kind up; `onOpenPage` goes to an app address (Settings) and closes the dialog. */
  SetupDialog?: React.FC<{ onClose: () => void; onOpenPage: (path: string) => void }>;
}

const alwaysAvailable = () => true;
const neverNeedsSetup = () => false;
const useCodeNeedsSetup = () => useCodeSetup() === "setup";

export const CHAT_KIND_CLIENTS: readonly ChatKindClient[] = [
  { id: "chat", label: "Chat", filterLabel: "Chats", icon: MessageCircle, useAvailable: alwaysAvailable },
  {
    id: "code",
    label: "Code session",
    filterLabel: "Code",
    icon: SquareCode,
    newMenuLabel: "Code session…",
    NewDialog: NewCodeSessionDialog,
    View: CodeSessionView,
    useAvailable: useCodeAvailable,
    useNeedsSetup: useCodeNeedsSetup,
    SetupDialog: CodeSetupDialog,
  },
];

const BY_ID = new Map(CHAT_KIND_CLIENTS.map((k) => [k.id, k]));

/** What a chat is; a chat without a kind is a `chat`. */
export function kindOf(chat: Pick<ChatRecord, "kind">): ChatKind {
  return chat.kind && BY_ID.has(chat.kind) ? chat.kind : "chat";
}

export function kindClient(kind: ChatKind): ChatKindClient | undefined {
  return BY_ID.get(kind);
}

/**
 * The kinds the server supports now, in registry order. The registry is fixed, so calling each
 * kind's hook in a loop keeps the hook order stable.
 */
export function useAvailableKinds(): ChatKindClient[] {
  const available: ChatKindClient[] = [];
  for (const kind of CHAT_KIND_CLIENTS) if (kind.useAvailable()) available.push(kind);
  return available;
}

/**
 * The kinds + ▸ Create offers, in registry order: supported ones with a "New…" dialog, and ones the
 * server knows but that aren't set up, which open their `SetupDialog`. Hook order is stable as above.
 */
export function useCreatableKinds(): ChatKindClient[] {
  const creatable: ChatKindClient[] = [];
  for (const kind of CHAT_KIND_CLIENTS) {
    const available = kind.useAvailable();
    const needsSetup = (kind.useNeedsSetup ?? neverNeedsSetup)();
    if (kind.newMenuLabel && ((available && kind.NewDialog) || (!available && needsSetup && kind.SetupDialog))) creatable.push(kind);
  }
  return creatable;
}

/** The registered view for this chat, when its kind has one and the server supports it. */
export function useKindView(chat: ChatRecord | undefined): React.FC<CodeSessionViewProps> | undefined {
  const kinds = useAvailableKinds();
  if (!chat) return undefined;
  const kind = kindOf(chat);
  return kinds.find((k) => k.id === kind)?.View;
}
