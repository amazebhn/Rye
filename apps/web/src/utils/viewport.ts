import { useSyncExternalStore } from "react";

/**
 * Below this width the app is laid out for a phone: the sidebar becomes a drawer over the content,
 * and the stylesheets switch to their `@media (max-width: 767px)` rules. Keep the two in step.
 */
export const MOBILE_BREAKPOINT = 768;
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}

/** True while the window is phone-sized (narrower than MOBILE_BREAKPOINT). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false);
}
