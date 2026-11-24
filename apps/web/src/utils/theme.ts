import { useSyncExternalStore } from "react";

/**
 * Colour theme. The preference ("system", "light" or "dark") lives in localStorage; the resolved theme is the
 * `data-theme` attribute on <html>, which styles/tokens.css keys its dark palette off.
 *
 * index.html runs a small inline copy of `applyTheme` before first paint so a stored dark theme never flashes
 * light. Keep THEME_STORAGE_KEY and the resolution rule in step with that script.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "rye-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const isPreference = (value: unknown): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";

/** Used when nothing is stored: the `data-theme-default` attribute on <html> in index.html. */
function defaultPreference(): ThemePreference {
  const fromHtml = document.documentElement.getAttribute("data-theme-default");
  return isPreference(fromHtml) ? fromHtml : "light";
}

// Set only when localStorage refuses the write, so the choice still holds until reload.
let unsavedPreference: ThemePreference | null = null;

export function getThemePreference(): ThemePreference {
  if (unsavedPreference) return unsavedPreference;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isPreference(stored)) return stored;
  } catch {
    // Storage can be blocked (private windows, site-data settings): fall through to the default.
  }
  return defaultPreference();
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/** The theme on screen right now. */
export function getResolvedTheme(): ResolvedTheme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

const listeners = new Set<() => void>();

/**
 * Accent colour: one of the presets in styles/tokens.css, kept in localStorage and shown as the `data-accent`
 * attribute on <html>. Blue is the default and is the absence of the attribute. The inline script in index.html
 * sets it before first paint; keep its list of names in step with ACCENTS.
 */
export const ACCENTS = [
  { value: "blue", label: "Blue" },
  { value: "graphite", label: "Graphite" },
  { value: "green", label: "Green" },
  { value: "teal", label: "Teal" },
  { value: "purple", label: "Purple" },
  { value: "pink", label: "Pink" },
  { value: "orange", label: "Orange" },
] as const;
export type Accent = (typeof ACCENTS)[number]["value"];

export const ACCENT_STORAGE_KEY = "rye-accent";
const DEFAULT_ACCENT: Accent = "blue";

const isAccent = (value: unknown): value is Accent => ACCENTS.some((accent) => accent.value === value);

let unsavedAccent: Accent | null = null;

export function getAccent(): Accent {
  if (unsavedAccent) return unsavedAccent;
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isAccent(stored)) return stored;
  } catch {
    // Storage blocked: the default.
  }
  return DEFAULT_ACCENT;
}

function applyAccent(): void {
  const accent = getAccent();
  const root = document.documentElement;
  if (accent === DEFAULT_ACCENT) root.removeAttribute("data-accent");
  else if (root.getAttribute("data-accent") !== accent) root.setAttribute("data-accent", accent);
  listeners.forEach((listener) => listener());
}

export function setAccent(accent: Accent): void {
  try {
    if (accent === DEFAULT_ACCENT) localStorage.removeItem(ACCENT_STORAGE_KEY);
    else localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    unsavedAccent = null;
  } catch {
    unsavedAccent = accent;
  }
  applyAccent();
}

/** The chosen accent and a setter, for the accent control. */
export function useAccent(): [Accent, (accent: Accent) => void] {
  return [useSyncExternalStore(subscribe, getAccent), setAccent];
}

function applyTheme(): void {
  const resolved = resolveTheme(getThemePreference());
  const root = document.documentElement;
  if (root.getAttribute("data-theme") !== resolved) root.setAttribute("data-theme", resolved);
  // Native scrollbars and form controls. Set inline as well as in tokens.css so it holds before the stylesheet loads.
  root.style.colorScheme = resolved;
  listeners.forEach((listener) => listener());
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    unsavedPreference = null;
  } catch {
    unsavedPreference = preference;
  }
  applyTheme();
}

let started = false;

/** Apply the stored theme and keep it current: OS changes while on "system", and changes made in another tab. */
export function initTheme(): void {
  if (started) return;
  started = true;
  applyTheme();
  applyAccent();
  window.matchMedia(DARK_QUERY).addEventListener("change", applyTheme);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) applyTheme();
    if (event.key === null || event.key === ACCENT_STORAGE_KEY) applyAccent();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored preference and a setter, for a theme control. */
export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  return [useSyncExternalStore(subscribe, getThemePreference), setThemePreference];
}

/** "light" or "dark" as currently shown; re-renders when it changes. For things that can't be styled by tokens. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme);
}
