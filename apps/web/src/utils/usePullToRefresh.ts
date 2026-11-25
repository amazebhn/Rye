import { useEffect, useRef, useState, type RefObject } from "react";

/** How far (after resistance) the indicator must travel before letting go refreshes. */
export const PULL_THRESHOLD = 64;
/** The indicator never travels further than this, however far the finger goes. */
const PULL_MAX = 112;
/** A refresh shows its spinner at least this long, so a fast reload still reads as one. */
const MIN_REFRESH_MS = 450;
/** Finger travel before the gesture is judged a pull, a scroll or a sideways swipe. */
const SLOP = 6;

export type PullPhase = "idle" | "pulling" | "refreshing" | "settling";

export interface PullState {
  /** How far the indicator has travelled, in CSS pixels (0 at rest). */
  pull: number;
  phase: PullPhase;
  /** Past the threshold: letting go now refreshes. */
  armed: boolean;
}

/** The nearest ancestor that scrolls vertically (the list's scroll container). */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Something between the touch and the list that is itself scrolled down (a code block, a nested list) keeps the gesture. */
function innerScrolled(target: EventTarget | null, scroller: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
  }
  return false;
}

/** Rubber-band resistance: the indicator follows the finger less and less, up to PULL_MAX. */
function resist(distance: number): number {
  return PULL_MAX * (1 - Math.exp(-distance / PULL_MAX));
}

/**
 * Pull to refresh on a phone: a downward drag that starts while the list (the nearest vertically
 * scrolling ancestor of `anchor`) is at the top draws the indicator down, and letting go past
 * PULL_THRESHOLD calls `onRefresh` and holds the spinner until the promise it returns settles.
 *
 * Touch only (touch events never come from a mouse or pen). A drag that starts with the list scrolled,
 * moves up first or moves sideways first (a wide table) is left to the browser untouched; only a
 * pull in progress cancels the native scroll, so the page can't bounce or reload under it.
 */
export function usePullToRefresh(
  anchor: RefObject<HTMLElement | null>,
  onRefresh: () => unknown,
  enabled: boolean,
): PullState {
  const [state, setState] = useState<PullState>({ pull: 0, phase: "idle", armed: false });
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    if (!enabled) return;
    const scroller = scrollParent(anchor.current);
    if (!scroller) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let mode: "none" | "pending" | "pulling" | "refreshing" = "none";
    let startX = 0;
    let startY = 0;
    let pull = 0;
    let settleTimer = 0;
    let alive = true;

    const show = (next: PullState) => { if (alive) setState(next); };
    const settle = () => {
      pull = 0;
      if (reduceMotion.matches) {
        show({ pull: 0, phase: "idle", armed: false });
        return;
      }
      show({ pull: 0, phase: "settling", armed: false });
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => show({ pull: 0, phase: "idle", armed: false }), 220);
    };

    function onStart(e: TouchEvent) {
      if (mode === "refreshing") return;
      mode = "none";
      if (e.touches.length !== 1 || scroller!.scrollTop > 0 || innerScrolled(e.target, scroller!)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      mode = "pending";
    }

    function onMove(e: TouchEvent) {
      if (mode !== "pending" && mode !== "pulling") return;
      if (e.touches.length !== 1) {
        if (mode === "pulling") settle();
        mode = "none";
        return;
      }
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (mode === "pending") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Up (scrolling the list) or sideways (a table, a carousel) first: not a pull.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || scroller!.scrollTop > 0) {
          mode = "none";
          return;
        }
        mode = "pulling";
      }
      if (e.cancelable) e.preventDefault();
      pull = resist(Math.max(0, dy - SLOP));
      show({ pull, phase: "pulling", armed: pull >= PULL_THRESHOLD });
    }

    function onEnd(e: TouchEvent) {
      if (mode !== "pulling") {
        if (mode === "pending") mode = "none";
        return;
      }
      if (e.type === "touchcancel" || pull < PULL_THRESHOLD) {
        mode = "none";
        settle();
        return;
      }
      mode = "refreshing";
      pull = PULL_THRESHOLD;
      show({ pull, phase: "refreshing", armed: true });
      const started = performance.now();
      Promise.resolve()
        .then(() => refresh.current())
        .catch(() => {})
        .then(() => new Promise((r) => window.setTimeout(r, Math.max(0, MIN_REFRESH_MS - (performance.now() - started)))))
        .then(() => {
          mode = "none";
          settle();
        });
    }

    scroller.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a pull in progress cancels the native scroll and overscroll.
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", onEnd);
    return () => {
      alive = false;
      window.clearTimeout(settleTimer);
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
      setState({ pull: 0, phase: "idle", armed: false });
    };
  }, [anchor, enabled]);

  return state;
}
