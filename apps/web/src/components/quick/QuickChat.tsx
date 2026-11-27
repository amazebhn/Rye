/**
 * Quick chat's floating card: the frame only. What is inside is Rye's own chat, built by App.tsx with the
 * same MessageList, MessageInput and send pipeline (`sendMessage`) as the main chat; App keeps the quick
 * conversation out of the chat list (`QUICK_CHAT_ID`) until "Save as chat".
 *
 * This file owns what is specific to the card: where it sits (dragged by its header, resized from its
 * corner, kept on screen, remembered in localStorage), the header (title, the model chip, New, Save as
 * chat, Close), Escape to hide, and focus (the composer on open, back where it was on close). On a phone
 * it is a bottom sheet instead, not draggable. There is never a backdrop: the page stays usable beside it.
 */

import React, { useEffect, useRef, useState } from "react";
import { MessageSquareShare, SquarePen, X, Zap } from "lucide-react";
import { formatModelName } from "../../utils/modelNames";
import { useIsMobile } from "../../utils/viewport";

interface Props {
  /** The model of the latest reply; the low tier's model (fetched here) until there is one. */
  replyModel?: string;
  canNew: boolean;
  canSave: boolean;
  onNew: () => void;
  onSave: () => void;
  onClose: () => void;
  /** The messages (or the empty state) and the composer. */
  children: React.ReactNode;
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FRAME_KEY = "rye.quick-chat-frame";
const DEFAULT_W = 380;
const DEFAULT_H = 520;
const MIN_W = 300;
const MIN_H = 340;
/** Kept this far from every window edge. */
const EDGE = 8;

function readFrame(): Frame | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FRAME_KEY) ?? "null") as Partial<Frame> | null;
    if (!parsed || ![parsed.x, parsed.y, parsed.w, parsed.h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return parsed as Frame;
  } catch {
    return null;
  }
}

function rememberFrame(frame: Frame): void {
  try {
    window.localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
  } catch {
    // Private mode: the card opens in its default place next time.
  }
}

/** Bottom right, clear of the chat composer's send button. */
function defaultFrame(vw: number, vh: number): Frame {
  return { x: vw - DEFAULT_W - 24, y: vh - DEFAULT_H - 96, w: DEFAULT_W, h: DEFAULT_H };
}

/** The frame as it fits this window: never larger than it, never past an edge. */
function clampFrame(f: Frame, vw: number, vh: number): Frame {
  const w = Math.min(Math.max(f.w, MIN_W), vw - EDGE * 2);
  const h = Math.min(Math.max(f.h, MIN_H), vh - EDGE * 2);
  return {
    w,
    h,
    x: Math.min(Math.max(f.x, EDGE), vw - w - EDGE),
    y: Math.min(Math.max(f.y, EDGE), vh - h - EDGE),
  };
}

/** Puts the caret in the card's composer once it (and any chip just added) has rendered. */
export function focusQuickChatComposer(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".quick-chat .chat-input")?.focus({ preventScroll: true })),
  );
}

export default function QuickChat({ replyModel, canNew, canSave, onNew, onSave, onClose, children }: Props) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the composer on open and goes back where it was on close.
  useEffect(() => {
    const active = document.activeElement;
    const back = active instanceof HTMLElement && active !== document.body ? active : null;
    focusQuickChatComposer();
    return () => {
      if (back?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
        requestAnimationFrame(() => back.focus({ preventScroll: true }));
      }
    };
  }, []);

  // The low tier's model, for the chip until a reply names its model. The server picks it (`quick: true`).
  const [lowModel, setLowModel] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    void fetch("/models/settings")
      .then((r) => (r.ok ? (r.json() as Promise<{ tiers?: { low?: { effective?: string } } }>) : null))
      .then((data) => {
        const model = data?.tiers?.low?.effective;
        if (!cancelled && model) setLowModel(model);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const shownModel = replyModel ?? lowModel;

  // What the user placed it at; what is drawn is that frame fitted to the window, so shrinking the
  // window and growing it again puts it back where it was.
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [wanted, setWanted] = useState<Frame>(() => readFrame() ?? defaultFrame(window.innerWidth, window.innerHeight));
  const frame = clampFrame(wanted, viewport.w, viewport.h);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Drags the card by its header, or resizes it from its right edge, bottom edge or corner. */
  const startGesture = (mode: "move" | "resize" | "resize-x" | "resize-y") => (e: React.PointerEvent<HTMLElement>) => {
    if (isMobile || e.button !== 0) return;
    if (mode === "move" && (e.target as Element).closest("button")) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const start = { px: e.clientX, py: e.clientY, ...frameRef.current };
    let last = frameRef.current;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      const w = mode === "resize-y" ? start.w : Math.min(start.w + dx, window.innerWidth - start.x - EDGE);
      const h = mode === "resize-x" ? start.h : Math.min(start.h + dy, window.innerHeight - start.y - EDGE);
      const next = mode === "move" ? { ...start, x: start.x + dx, y: start.y + dy } : { ...start, w, h };
      last = clampFrame(next, window.innerWidth, window.innerHeight);
      setWanted(last);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      rememberFrame(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  // Escape with focus inside hides the card (the conversation is kept). Tag suggestions, menus and
  // dialogs opened from inside take it first.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!panelRef.current?.contains(e.target as Node)) return;
    if (document.querySelector(".modal-overlay, [role=menu]")) return;
    e.preventDefault();
    onClose();
  };

  const style: React.CSSProperties | undefined = isMobile ? undefined : { left: frame.x, top: frame.y, width: frame.w, height: frame.h };

  return (
    <div
      ref={panelRef}
      className={`quick-chat${isMobile ? " quick-chat--sheet" : ""}`}
      style={style}
      role="dialog"
      aria-label="Quick chat"
      onKeyDown={onKeyDown}
    >
      <header className={`quick-chat-header${isMobile ? "" : " is-draggable"}`} onPointerDown={startGesture("move")}>
        <h2 className="quick-chat-title">
          <Zap size={14} aria-hidden="true" />
          Quick chat
        </h2>
        {shownModel && (
          <span className="quick-chat-model" title={`Quick chat runs on the low model tier: ${shownModel}`}>
            {formatModelName(shownModel)}
          </span>
        )}
        <div className="quick-chat-actions">
          <button type="button" className="quick-chat-icon-btn" onClick={onNew} disabled={!canNew} aria-label="New quick chat" title="New">
            <SquarePen size={15} />
          </button>
          <button type="button" className="quick-chat-icon-btn" onClick={onSave} disabled={!canSave} aria-label="Save as chat" title="Save as chat">
            <MessageSquareShare size={15} />
          </button>
          <button type="button" className="quick-chat-icon-btn" onClick={onClose} aria-label="Close quick chat" title="Close (⌘J)">
            <X size={16} />
          </button>
        </div>
      </header>
      {children}
      {/* Resizing: invisible hit areas on the right edge, the bottom edge and the corner, shown only by the cursor. */}
      {!isMobile && (
        <>
          <div className="quick-chat-resize quick-chat-resize--x" onPointerDown={startGesture("resize-x")} aria-hidden="true" />
          <div className="quick-chat-resize quick-chat-resize--y" onPointerDown={startGesture("resize-y")} aria-hidden="true" />
          <div className="quick-chat-resize quick-chat-resize--xy" onPointerDown={startGesture("resize")} aria-hidden="true" />
        </>
      )}
    </div>
  );
}
