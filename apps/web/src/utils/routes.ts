/**
 * Addresses for the app's pages besides chats (which are /c/<id>), so a page
 * can be linked to, reloaded, and reached with Back/Forward.
 *
 *   /settings                 Settings → General
 *   /settings/<page>          a Settings page (models, search, agents, skills, mcp, tools, code, usage, integrations)
 *   /settings/tools/<tool>    the Tools page, scrolled to and highlighting one tool
 *   /sops/<id>                one SOP
 *   /sops, /memory, /agents   the other sidebar pages
 *   /analytics                moved: replaced by /settings/usage (MOVED_PATHS)
 *
 * App.tsx reads the address on load and on popstate and shows the matching page.
 * Anything that links to a page uses these helpers and `openAppPath`.
 *
 * Some of these share a start with an API route (/sop, /memory, /agents). The dev server tells a
 * page load from an API call (see the proxy in vite.config.ts); anything that serves the built app
 * must do the same and answer a page load of these exact paths with index.html.
 */

// "code" (Settings → Code) is listed only while the server has code sessions (utils/codeApi.ts).
export const SETTINGS_PAGES = ["general", "models", "search", "agents", "skills", "mcp", "tools", "code", "usage", "integrations"] as const;
export type SettingsPageKey = (typeof SETTINGS_PAGES)[number];

export function settingsPath(page: SettingsPageKey = "general", item?: string): string {
  if (page === "general" && !item) return "/settings";
  return `/settings/${page}${item ? `/${encodeURIComponent(item)}` : ""}`;
}

export const sopPath = (id: number) => `/sops/${id}`;
export const toolPath = (name: string) => settingsPath("tools", name);

/** The sidebar pages besides Settings, each at an address of its own. */
export const PANEL_PATHS = { sops: "/sops", memory: "/memory", agents: "/agents" } as const;
export type PanelKey = keyof typeof PANEL_PATHS;
const PANEL_BY_PATH = new Map<string, PanelKey>(Object.entries(PANEL_PATHS).map(([panel, path]) => [path, panel as PanelKey]));

export type AppRoute =
  | { kind: "settings"; page: SettingsPageKey; item?: string }
  | { kind: "sop"; id: number }
  | { kind: "panel"; panel: PanelKey }
  | { kind: "other" };

/** What an address points at. Chats (/c/<id>), Home (/) and a blank new chat (/new) are "other" (App.tsx handles them). */
export function parseAppPath(pathname: string): AppRoute {
  const settings = /^\/settings(?:\/([a-z]+)(?:\/([^/]+))?)?\/?$/.exec(pathname);
  if (settings) {
    const page = (settings[1] ?? "general") as SettingsPageKey;
    if (!SETTINGS_PAGES.includes(page)) return { kind: "settings", page: "general" };
    let item: string | undefined;
    try {
      item = settings[2] ? decodeURIComponent(settings[2]) : undefined;
    } catch {
      item = undefined;
    }
    return { kind: "settings", page, ...(item ? { item } : {}) };
  }
  const sop = /^\/sops\/(\d+)\/?$/.exec(pathname);
  if (sop) return { kind: "sop", id: Number(sop[1]) };
  const panel = PANEL_BY_PATH.get(pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname);
  if (panel) return { kind: "panel", panel };
  return { kind: "other" };
}

/** Addresses that moved, and where they live now (old links and bookmarks keep working). */
const MOVED_PATHS: Record<string, string> = {
  "/analytics": settingsPath("usage"),
};

/** Rewrites the current address in place (no history entry) if it is one that moved. */
export function redirectMovedPath(): void {
  const path = window.location.pathname.length > 1 ? window.location.pathname.replace(/\/$/, "") : window.location.pathname;
  const target = MOVED_PATHS[path];
  if (target) window.history.replaceState(window.history.state, "", target + window.location.search + window.location.hash);
}

/** Go to an in-app address without reloading: App.tsx listens for popstate and shows the page. */
export function openAppPath(path: string): void {
  if (window.location.pathname !== path) window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
