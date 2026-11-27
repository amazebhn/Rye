/**
 * SelectionActions: a small floating bar of actions for text the user selects inside a container
 * ("Add to chat", and later "Explain", "Comment", ...). It knows nothing about chats, code or
 * documents: the caller gives it the container, the actions, and optionally `describe`, which turns
 * the selected DOM range into whatever metadata the actions need (or null to offer nothing).
 *
 *   <SelectionActions
 *     containerRef={ref}                       // only selections wholly inside this element
 *     actions={[{ id: "add", label: "Add to chat", icon: MessageSquarePlus, onSelect: (sel) => ... }]}
 *     describe={(range, text) => meta | null}  // optional; null hides the bar
 *   />
 *
 * `onSelect` gets `{ text, range, meta }`: the selected text (or `textOf(range)` when given), a copy
 * of the range, and what `describe` returned.
 *
 * Uses:
 * - Assistant replies (`MessageList`, `enableQuoteActions`): "Add to chat" quotes the selection into
 *   the composer as a `quote` context ref (utils/contextRefs.ts).
 * - The code session's Changes diff (`ChangesView`, reading the rows with DiffView's `readDiffSelection`): `describe` reads `data-path`, `data-line` and
 *   `data-side` ("old" | "new") from the diff rows the range starts and ends in, returning
 *   `{ path, lines: { start, end }, side }` (null when the range spans two files or no rows), and
 *   `textOf` joins the rows' code cells so gutters and +/- markers stay out of the quote.
 * - The document editor (to come): `describe` maps the range to its own positions.
 *
 * Behaviour: the bar appears once a selection settles (on mouse release; after a pause for a
 * keyboard or touch selection), 6px under the selection's last line (so it never covers a multi-line
 * selection), centred on where that line ends, kept on screen and flipped over the first line only
 * when there's no room below in the scroll area or window. On touch it sits a little lower, clear of
 * the selection handles. Its buttons are icons only (28px), each named and titled by its `label`.
 * It hides when the selection collapses, on Escape, on
 * a scroll of the container or the page, on resize, and on a press anywhere else; pressing the bar
 * itself keeps the selection. Selections in inputs, textareas and editors nested inside the
 * container are ignored (a container that is itself editable is fine). `shortcut` (⌥⇧Q /
 * Alt+Shift+Q by default: ⌘⇧A was Chrome's "Search tabs" on a Mac, which a page never receives, and
 * Alt+Shift+Q is no major browser's shortcut and types nothing outside a field) moves focus into the
 * bar while it shows; arrow keys move between its
 * buttons, Escape goes back. An action's own `shortcut` runs it directly. The bar's appearance is
 * announced politely.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface TextSelection<M = unknown> {
  /** The selected text (or what `textOf` made of the range). */
  text: string;
  /** A copy of the selected range, safe to keep. */
  range: Range;
  /** What `describe` returned (undefined without `describe`). */
  meta: M;
}

export interface SelectionAction<M = unknown> {
  id: string;
  label: string;
  /** A Lucide icon component, or any node. */
  icon?: LucideIcon | React.ReactNode;
  onSelect: (selection: TextSelection<M>) => void;
  /** Runs this action directly while the bar shows, e.g. "Mod+Shift+K" (Mod is ⌘ on a Mac, Ctrl elsewhere). */
  shortcut?: string;
  /** Leave the text selected after the action runs (by default the selection is cleared). */
  keepSelection?: boolean;
}

export interface SelectionActionsProps<M = unknown> {
  /**
   * The bar offers what's selected inside this element. A selection that runs past it (a drag begun in
   * the margin) is trimmed to the part inside; one that doesn't touch it gets no bar.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  actions: SelectionAction<M>[];
  /**
   * Narrows the (already trimmed) selection further, e.g. to the one reply whose text it covers, so a drag
   * that starts or ends a little outside the content still counts; null offers no bar.
   */
  clip?: (range: Range) => Range | null;
  /** Maps the selection to metadata for the actions; null offers no bar for it. */
  describe?: (range: Range, text: string) => M | null;
  /** The text the actions get, when the DOM's own (`Selection.toString()`) isn't right, e.g. without a diff's gutters. */
  textOf?: (range: Range) => string;
  /** Moves focus into the bar while it shows. Default "Alt+Shift+Q"; null for none. */
  shortcut?: string | null;
  /** The toolbar's accessible name. */
  label?: string;
  disabled?: boolean;
}

interface Shown<M> {
  selection: TextSelection<M>;
  /** Where the bar goes: under the selection's last line (`bottom`, at `x`), or over its first line (`top`). */
  anchor: { top: number; bottom: number; x: number };
  touch: boolean;
}

const GAP = 6;
const EDGE = 8;
/** Extra room below a touch selection for the system's selection handles. */
const TOUCH_HANDLES = 22;
const KEYBOARD_SETTLE_MS = 300;
const TOUCH_SETTLE_MS = 450;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

interface Combo { mod: boolean; shift: boolean; alt: boolean; key: string }

function parseCombo(spec: string): Combo | null {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const lower = parts.map((p) => p.toLowerCase());
  return { mod: lower.includes("mod"), shift: lower.includes("shift"), alt: lower.includes("alt"), key: key.toLowerCase() };
}

function matchesCombo(e: KeyboardEvent, spec: string | null | undefined): boolean {
  const c = spec ? parseCombo(spec) : null;
  if (!c) return false;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod !== c.mod || e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  if (IS_MAC ? e.ctrlKey : e.metaKey) return false;
  // `code` keeps letters right whatever Shift or Option did to `key`.
  const fromCode = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(e.code)?.[1];
  return (fromCode ?? e.key.toLowerCase()) === c.key;
}

/** The shortcut for `aria-keyshortcuts`: "Meta+Shift+A" on a Mac, "Control+Shift+A" elsewhere. */
function ariaShortcut(spec: string): string {
  const c = parseCombo(spec);
  if (!c) return spec;
  return [c.mod ? (IS_MAC ? "Meta" : "Control") : "", c.alt ? "Alt" : "", c.shift ? "Shift" : "", c.key.length === 1 ? c.key.toUpperCase() : c.key].filter(Boolean).join("+");
}

const sameRange = (a: Range, b: Range) =>
  a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;

/** "⌘⇧A" on a Mac, "Ctrl+Shift+A" elsewhere. */
export function shortcutLabel(spec: string): string {
  const c = parseCombo(spec);
  if (!c) return spec;
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (IS_MAC) return `${c.mod ? "⌘" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${key}`;
  return [c.mod ? "Ctrl" : "", c.alt ? "Alt" : "", c.shift ? "Shift" : "", key].filter(Boolean).join("+");
}

const asElement = (node: Node | null): Element | null => (node ? (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement) : null);

/** Inside a field, or an editor nested in the container (a message being edited); the container being editable is fine. */
function inField(node: Node | null, container: HTMLElement): boolean {
  const el = asElement(node);
  if (!el) return false;
  if (el.closest("input, textarea, select")) return true;
  const editor = el.closest<HTMLElement>("[contenteditable]:not([contenteditable='false'])");
  return Boolean(editor && editor !== container && container.contains(editor));
}

function isBackward(sel: Selection): boolean {
  const dir = (sel as Selection & { direction?: string }).direction;
  if (dir) return dir === "backward";
  const { anchorNode, focusNode } = sel;
  if (!anchorNode || !focusNode) return false;
  if (anchorNode === focusNode) return sel.focusOffset < sel.anchorOffset;
  return Boolean(anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
}

/**
 * Where the bar goes: under the bottom of the selection's last line, so it never covers selected
 * lines, near where that line ends (where it starts, for a selection made backwards); `top` is the
 * first line's top, for when there's no room below.
 */
function anchorRect(range: Range, backward: boolean): Shown<unknown>["anchor"] | null {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const box = range.getBoundingClientRect();
  const first = rects[0] ?? box;
  // The lowest rect is the last line (a fully selected element's box can come after its text's in the list).
  const last = rects.reduce<DOMRect | undefined>((low, r) => (!low || r.bottom > low.bottom + 1 || (Math.abs(r.bottom - low.bottom) <= 1 && r.right > low.right) ? r : low), undefined) ?? box;
  if ((last.width === 0 && last.height === 0) || (first.width === 0 && first.height === 0)) return null;
  const top = Math.min(first.top, ...rects.map((r) => r.top));
  return { top, bottom: last.bottom, x: backward ? last.left : last.right };
}

/** The nearest scrolling ancestor's visible top and bottom, so the bar doesn't sit over a header the container scrolls under. */
function visibleBand(container: HTMLElement): { top: number; bottom: number } {
  let top = EDGE;
  let bottom = window.innerHeight - EDGE;
  for (let el: HTMLElement | null = container; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") {
      const r = el.getBoundingClientRect();
      top = Math.max(top, r.top + EDGE);
      bottom = Math.min(bottom, r.bottom - EDGE);
      break;
    }
  }
  return { top, bottom };
}

function ActionIcon({ icon }: { icon: SelectionAction["icon"] }) {
  if (!icon) return null;
  if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "render" in icon)) {
    const Icon = icon as LucideIcon;
    return <Icon size={15} aria-hidden="true" />;
  }
  return <>{icon}</>;
}

/** `range` trimmed to the part inside `el`; null when it doesn't reach into `el` or nothing is left. */
export function clipRangeTo(range: Range, el: Node): Range | null {
  if (!range.intersectsNode(el)) return null;
  if (el.contains(range.startContainer) && el.contains(range.endContainer)) return range;
  const clipped = range.cloneRange();
  if (!el.contains(range.startContainer)) clipped.setStart(el, 0);
  if (!el.contains(range.endContainer)) clipped.setEnd(el, el.childNodes.length);
  return clipped.collapsed ? null : clipped;
}

export default function SelectionActions<M = unknown>({
  containerRef,
  actions,
  clip,
  describe,
  textOf,
  shortcut = "Alt+Shift+Q",
  label = "Selection actions",
  disabled = false,
}: SelectionActionsProps<M>) {
  const [shown, setShown] = useState<Shown<M> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const barRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // The latest props, read by the document listeners without re-binding them.
  const propsRef = useRef({ actions, clip, describe, textOf, shortcut, disabled });
  propsRef.current = { actions, clip, describe, textOf, shortcut, disabled };
  const pointerDownRef = useRef(false);
  // How the selection is being made: decides when it has settled and where the bar goes.
  const lastPointerRef = useRef<"mouse" | "touch" | "pen" | "keyboard">("mouse");
  const settleTimer = useRef<number | undefined>(undefined);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const hide = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    if (shownRef.current) {
      shownRef.current = null;
      setShown(null);
    }
  }, []);

  /** Shows the bar for the current selection, or hides it when there's nothing to offer. */
  const evaluate = useCallback(() => {
    const container = containerRef.current;
    const { clip: clipFn, describe: describeFn, textOf: textFn, disabled: off, actions: acts } = propsRef.current;
    const sel = window.getSelection();
    if (off || !container || acts.length === 0 || !sel || sel.rangeCount === 0 || sel.isCollapsed) return hide();
    const selected = sel.getRangeAt(0);
    // A drag begun or ended a little outside counts for the part inside (see containerRef and clip).
    const inside = clipRangeTo(selected, container);
    const range = inside && clipFn ? clipFn(inside) : inside;
    if (!range || !container.contains(range.commonAncestorContainer)) return hide();
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return hide();
    if (inField(range.startContainer, container) || inField(range.endContainer, container)) return hide();
    const text = (textFn ? textFn(range) : range === selected ? sel.toString() : range.toString()).replace(/^\s*\n|\s+$/g, "");
    if (!text.trim()) return hide();
    const meta = describeFn ? describeFn(range, text) : (undefined as M);
    if (meta === null) return hide();
    const anchor = anchorRect(range, isBackward(sel));
    if (!anchor) return hide();
    const next: Shown<M> = { selection: { text, range: range.cloneRange(), meta: meta as M }, anchor, touch: lastPointerRef.current === "touch" };
    const wasShown = Boolean(shownRef.current);
    shownRef.current = next;
    setShown(next);
    if (!wasShown) {
      const names = acts.map((a) => a.label).join(", ");
      const key = propsRef.current.shortcut;
      setAnnouncement(`Text selected. ${names}${key ? `: press ${shortcutLabel(key)} to reach ${acts.length === 1 ? "it" : "them"}` : ""}.`);
    }
  }, [containerRef, hide]);

  // Watching the selection.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      lastPointerRef.current = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
      if (barRef.current?.contains(e.target as Node)) return;
      if (e.pointerType !== "touch") pointerDownRef.current = true;
      hide();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (barRef.current?.contains(e.target as Node)) return;
      const wasDown = pointerDownRef.current;
      pointerDownRef.current = false;
      // The selection is final once the browser has handled the release.
      if (wasDown) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = window.setTimeout(evaluate, 0);
      }
    };
    const onSelectionChange = () => {
      if (pointerDownRef.current) return; // a mouse drag: wait for the release
      if (barRef.current?.contains(document.activeElement)) return; // working the bar keeps it
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide();
      // The browser's own late report of the selection the bar already shows for.
      const current = shownRef.current;
      if (current && sameRange(sel.getRangeAt(0), current.selection.range)) return;
      // Keyboard or touch: wait for the selection to settle, then show.
      window.clearTimeout(settleTimer.current);
      if (shownRef.current) {
        shownRef.current = null;
        setShown(null);
      }
      settleTimer.current = window.setTimeout(evaluate, lastPointerRef.current === "touch" ? TOUCH_SETTLE_MS : KEYBOARD_SETTLE_MS);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A selection made now is a keyboard one (placed like a mouse one, above).
      lastPointerRef.current = "keyboard";
      const current = shownRef.current;
      if (!current) return;
      const bar = barRef.current;
      if (e.key === "Escape") {
        const inBar = Boolean(bar?.contains(document.activeElement));
        hide();
        if (inBar) {
          e.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      const { shortcut: focusKey, actions: acts } = propsRef.current;
      const direct = acts.find((a) => matchesCombo(e, a.shortcut));
      if (direct) {
        e.preventDefault();
        run(direct, current);
        return;
      }
      if (focusKey && matchesCombo(e, focusKey) && bar) {
        e.preventDefault();
        if (!bar.contains(document.activeElement)) returnFocusRef.current = document.activeElement as HTMLElement | null;
        bar.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      }
    };
    const onScroll = (e: Event) => {
      if (!shownRef.current) return;
      const container = containerRef.current;
      const target = e.target;
      if (target === document || (target instanceof Node && container && (target.contains(container) || container.contains(target)))) hide();
    };
    const onResize = () => hide();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(settleTimer.current);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // `run` only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, evaluate, hide]);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  function run(action: SelectionAction<M>, current: Shown<M>) {
    const bar = barRef.current;
    const focusWasInBar = Boolean(bar?.contains(document.activeElement));
    hide();
    if (!action.keepSelection) window.getSelection()?.removeAllRanges();
    action.onSelect(current.selection);
    // The bar is gone; if the action didn't move focus somewhere, go back to where the user was.
    if (focusWasInBar && (!document.activeElement || document.activeElement === document.body)) {
      returnFocusRef.current?.focus({ preventScroll: true });
    }
  }

  // Place the bar once its size is known: under the selection's last line, centred on where it ends,
  // flipped over the first line only when there's no room below, and kept inside the window.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const container = containerRef.current;
    if (!shown || !bar || !container) return;
    const { anchor, touch } = shown;
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const band = visibleBand(container);
    const above = anchor.top - GAP - h;
    const below = anchor.bottom + GAP + (touch ? TOUCH_HANDLES : 0);
    const fitsAbove = above >= band.top;
    const fitsBelow = below + h <= Math.min(band.bottom, window.innerHeight - EDGE);
    const placeBelow = fitsBelow || !fitsAbove;
    let top = placeBelow ? below : above;
    // Neither side fits (a selection taller than the view): keep it in the visible band.
    if (!fitsAbove && !fitsBelow) top = Math.min(Math.max(band.top, above), band.bottom - h);
    const left = Math.min(Math.max(EDGE, anchor.x - w / 2), window.innerWidth - EDGE - w);
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(Math.max(EDGE, left))}px`;
    bar.style.visibility = "visible";
    bar.dataset.placement = placeBelow ? "below" : "above";
  }, [shown, containerRef]);

  function onBarKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[next]?.focus();
  }

  const bar = shown
    ? createPortal(
        <div
          ref={barRef}
          className="selection-actions"
          role="toolbar"
          aria-label={label}
          aria-orientation="horizontal"
          {...(shortcut ? { "aria-keyshortcuts": ariaShortcut(shortcut) } : {})}
          style={{ top: 0, left: 0, visibility: "hidden" }}
          // Pressing the bar must not clear the selection it acts on.
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={onBarKeyDown}
        >
          {actions.map((action, i) => (
            <button
              key={action.id}
              type="button"
              className="selection-actions-btn"
              tabIndex={i === 0 ? 0 : -1}
              // Icon only: the label is the button's name and its tooltip.
              aria-label={action.label}
              title={action.shortcut ? `${action.label} (${shortcutLabel(action.shortcut)})` : action.label}
              {...(action.shortcut ? { "aria-keyshortcuts": ariaShortcut(action.shortcut) } : {})}
              onClick={() => shownRef.current && run(action, shownRef.current)}
              // A tap would otherwise clear the selection (and on iOS the click comes too late); run it here.
              onTouchEnd={(e) => {
                e.preventDefault();
                if (shownRef.current) run(action, shownRef.current);
              }}
            >
              {action.icon ? <ActionIcon icon={action.icon} /> : <span>{action.label}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span className="selection-actions-live" aria-live="polite" role="status">{shown ? announcement : ""}</span>
      {bar}
    </>
  );
}
