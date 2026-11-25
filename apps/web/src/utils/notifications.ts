/**
 * Notifications for runs that end while the user isn't looking at their chat: a reply finished,
 * the agent is waiting for an answer or an approval, or the run failed.
 *
 * - Only the tab that ran the chat (the one whose sendMessage finished) notifies, and only when no
 *   tab is looking at that chat: it asks the other tabs over the "rye-notify" BroadcastChannel and
 *   waits LOOK_WAIT_MS for a "looking" reply (the tab on screen in a focused, visible window).
 * - Desktop notifications need the master switch (Settings → General → Notifications) and the
 *   browser's permission. The tab title count ("(2) Rye") and the favicon dot work without either.
 * - A notification is tagged per chat (rye-chat-<id>), so a newer one replaces the older; it closes
 *   (and the count drops) once the chat is seen in any tab. Clicking it opens the chat (/c/<id>).
 */

import { useEffect, useState } from "react";
import type { PendingPrompt } from "@rye/shared";
import type { RenderMessage, ToolCall } from "./types";
import { isPermissionPrompt } from "./approval";
import { toolLabel } from "./toolLabel";
import { openAppPath, settingsPath } from "./routes";

// ---------------------------------------------------------------------------
// Preferences (per browser)
// ---------------------------------------------------------------------------

export type NotifyKind = "reply" | "waiting" | "error";

export interface NotificationPrefs {
  enabled: boolean;
  reply: boolean;
  waiting: boolean;
  error: boolean;
}

const PREFS_KEY = "rye-notifications";
const PREFS_CHANGED = "rye-notifications-changed";
const DEFAULT_PREFS: NotificationPrefs = { enabled: false, reply: true, waiting: true, error: true };

export function readNotificationPrefs(): NotificationPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<NotificationPrefs> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    const pick = (key: keyof NotificationPrefs) => (typeof parsed[key] === "boolean" ? parsed[key] : DEFAULT_PREFS[key]);
    return { enabled: pick("enabled"), reply: pick("reply"), waiting: pick("waiting"), error: pick("error") };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode: the change lasts for this page only.
  }
  window.dispatchEvent(new CustomEvent(PREFS_CHANGED, { detail: prefs }));
}

/** The notification preferences; updates when they change here or in another tab. */
export function useNotificationPrefs(): [NotificationPrefs, (patch: Partial<NotificationPrefs>) => void] {
  const [prefs, setPrefs] = useState(readNotificationPrefs);
  useEffect(() => {
    const here = (e: Event) => setPrefs((e as CustomEvent<NotificationPrefs>).detail);
    const elsewhere = (e: StorageEvent) => {
      if (e.key === PREFS_KEY || e.key === null) setPrefs(readNotificationPrefs());
    };
    window.addEventListener(PREFS_CHANGED, here);
    window.addEventListener("storage", elsewhere);
    return () => {
      window.removeEventListener(PREFS_CHANGED, here);
      window.removeEventListener("storage", elsewhere);
    };
  }, []);
  return [prefs, (patch) => writeNotificationPrefs({ ...readNotificationPrefs(), ...patch })];
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/** "insecure": the API exists only on https or localhost, and this page is neither. */
export type NotificationSupport = "unsupported" | "insecure" | NotificationPermission;

export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined") return "unsupported";
  if (typeof window.Notification === "undefined") return globalThis.isSecureContext ? "unsupported" : "insecure";
  return window.Notification.permission;
}

/** Asks for permission; call it straight from a click so the browser shows its prompt. */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  const support = notificationSupport();
  if (support !== "default") return support;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return notificationSupport();
  }
}

/** The permission state, re-read when the browser reports a change or the window regains focus. */
export function useNotificationSupport(): [NotificationSupport, (next: NotificationSupport) => void] {
  const [support, setSupport] = useState(notificationSupport);
  useEffect(() => {
    const sync = () => setSupport(notificationSupport());
    window.addEventListener("focus", sync);
    let status: PermissionStatus | undefined;
    let gone = false;
    navigator.permissions?.query({ name: "notifications" as PermissionName })
      .then((s) => {
        if (gone) return;
        status = s;
        s.addEventListener("change", sync);
      })
      .catch(() => {});
    return () => {
      gone = true;
      window.removeEventListener("focus", sync);
      status?.removeEventListener("change", sync);
    };
  }, []);
  return [support, setSupport];
}

// ---------------------------------------------------------------------------
// Where the user is looking, across tabs
// ---------------------------------------------------------------------------

type NotifyMessage =
  | { kind: "looking?"; chatId: string; qid: string }
  | { kind: "looking"; qid: string }
  | { kind: "seen"; chatId: string };

// Long enough for another tab's reply on a busy machine; background tabs still answer within it
// because message events aren't throttled like timers.
const LOOK_WAIT_MS = 250;

const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("rye-notify");
const waitingFor = new Map<string, () => void>();
// The chat this tab shows (undefined on Home, Settings, …), kept by useNotifications.
let chatOnScreen: string | undefined;

const userIsHere = () => !document.hidden && document.hasFocus();
const lookingAt = (chatId: string) => chatOnScreen === chatId && userIsHere();

channel?.addEventListener("message", (e: MessageEvent<NotifyMessage>) => {
  const msg = e.data;
  if (msg.kind === "looking?") {
    if (lookingAt(msg.chatId)) channel.postMessage({ kind: "looking", qid: msg.qid } satisfies NotifyMessage);
  } else if (msg.kind === "looking") {
    waitingFor.get(msg.qid)?.();
  } else if (msg.kind === "seen") {
    seen(msg.chatId);
  }
});

/** Whether this tab or another one has the chat on screen in a focused, visible window. */
function someoneIsLooking(chatId: string): Promise<boolean> {
  if (lookingAt(chatId)) return Promise.resolve(true);
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const qid = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      waitingFor.delete(qid);
      resolve(false);
    }, LOOK_WAIT_MS);
    waitingFor.set(qid, () => {
      window.clearTimeout(timer);
      waitingFor.delete(qid);
      resolve(true);
    });
    channel.postMessage({ kind: "looking?", chatId, qid } satisfies NotifyMessage);
  });
}

/** The chat was looked at (here or in another tab): its notification and its count go. */
function seen(chatId: string) {
  shown.get(chatId)?.close();
  shown.delete(chatId);
  if (attention.delete(chatId)) updateBadge();
}

function announceSeen() {
  const id = chatOnScreen;
  if (!id || !userIsHere()) return;
  channel?.postMessage({ kind: "seen", chatId: id } satisfies NotifyMessage);
  seen(id);
}

/**
 * Tells the notifier which chat is on screen (undefined when none is), so it never notifies for
 * the chat the user is looking at and clears that chat's count and notification when it is seen.
 */
export function useNotifications(onScreen: string | undefined): void {
  useEffect(() => {
    chatOnScreen = onScreen;
    announceSeen();
  }, [onScreen]);
  useEffect(() => {
    document.addEventListener("visibilitychange", announceSeen);
    window.addEventListener("focus", announceSeen);
    return () => {
      document.removeEventListener("visibilitychange", announceSeen);
      window.removeEventListener("focus", announceSeen);
      chatOnScreen = undefined;
    };
  }, []);
}

// ---------------------------------------------------------------------------
// In-tab signals: the title count and the favicon dot
// ---------------------------------------------------------------------------

// Chats with something new since the user last looked at them (this tab's runs only).
const attention = new Set<string>();
const COUNT_PREFIX = /^\(\d+\)\s+/;

function updateBadge() {
  const base = document.title.replace(COUNT_PREFIX, "");
  document.title = attention.size ? `(${attention.size}) ${base}` : base;
  drawFavicon();
}

let faviconDraw = 0;

/** A colour token resolved to something a canvas understands (computed colours are rgb()/color()). */
function tokenColor(name: string): string {
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
}

/** Puts an accent dot on the favicon while anything needs attention, and takes it off after. */
function drawFavicon() {
  const draw = ++faviconDraw;
  const links = iconLinks();
  if (attention.size === 0) {
    for (const link of links) {
      if (link.dataset.ryeHref === undefined) continue;
      link.href = link.dataset.ryeHref;
      if (link.dataset.ryeType) link.type = link.dataset.ryeType;
      else link.removeAttribute("type");
      delete link.dataset.ryeHref;
      delete link.dataset.ryeType;
    }
    return;
  }
  const svg = links.find((l) => (l.dataset.ryeType ?? l.type) === "image/svg+xml");
  const source = svg ? (svg.dataset.ryeHref ?? svg.getAttribute("href") ?? "") : "";
  const img = new Image();
  const paint = () => {
    if (draw !== faviconDraw || attention.size === 0) return;
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (img.naturalWidth) ctx.drawImage(img, 0, 0, size, size);
    const accent = tokenColor("--main-accent");
    if (!accent) return;
    // A ring in the page background keeps the dot apart from the mark under it.
    ctx.beginPath();
    ctx.arc(size - 15, 15, 15, 0, Math.PI * 2);
    ctx.fillStyle = tokenColor("--main-bg") || accent;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(size - 15, 15, 11, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    const url = canvas.toDataURL("image/png");
    for (const link of iconLinks()) {
      if (link.dataset.ryeHref === undefined) {
        link.dataset.ryeHref = link.getAttribute("href") ?? "";
        link.dataset.ryeType = link.getAttribute("type") ?? "";
      }
      link.type = "image/png";
      link.href = url;
    }
  };
  img.onload = paint;
  img.onerror = paint;
  if (source) img.src = source;
  else paint();
}

// The dot follows the theme and accent, which are read when it is drawn.
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
  new MutationObserver(() => {
    if (attention.size) drawFavicon();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
}

// ---------------------------------------------------------------------------
// What a finished run says
// ---------------------------------------------------------------------------

/** Markdown as one line of plain text: code blocks, links, emphasis and markers dropped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
    .replace(/\[rye:[^\]]*\]/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|~~|\*)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface RunEnd {
  chatId: string;
  /** The chat's title, or the agent's name for an agent's chat. */
  title?: string;
  /** The chat's messages as the run left them; the last is the run's final assistant message. */
  messages: RenderMessage[];
  /** The question or approval the run ended on. */
  prompt?: PendingPrompt | null;
  startedAt?: number;
}

interface Notice {
  kind: NotifyKind;
  body: string;
  /** For an approval: the tool waiting for it, whose title is looked up before showing. */
  tool?: string;
}

const AWAITING = /^\[Awaiting user approval to (?:run (\S+)|add the MCP server)\]/;

function awaitingTool(message: RenderMessage | undefined): ToolCall | undefined {
  const calls = [...(message?.turns ?? []).flatMap((t) => t.toolCalls), ...(message?.toolCalls ?? [])];
  return calls.reverse().find((tc) => tc.result !== undefined && AWAITING.test(tc.result));
}

function describe(run: RunEnd): Notice | null {
  const last = run.messages.at(-1);
  if (!last || last.role !== "assistant") return null;
  const status = last.meta?.status;
  if (status === "stopped") return null;
  if (status === "error") return { kind: "error", body: clip(`Run failed: ${last.meta?.error ?? "unknown error"}`) };
  if (run.prompt) {
    if (isPermissionPrompt(run.prompt)) {
      const name = awaitingTool(last)?.result?.match(AWAITING)?.[1];
      return name
        ? { kind: "waiting", body: "Needs your approval to run a tool.", tool: name }
        : { kind: "waiting", body: "Needs your approval to add an MCP server." };
    }
    return { kind: "waiting", body: clip(plainText(run.prompt.question)) || "Has a question for you." };
  }
  if (last.paused) return { kind: "waiting", body: "Paused at the tool-round limit. Continue when you're ready." };
  // After agent hand-offs the last message is the last agent's reply; an empty one falls back to earlier text.
  const reply = [...run.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  return { kind: "reply", body: clip(plainText(reply?.content ?? "")) || "Reply ready." };
}

/** A tool's human title ("Run SQL query"), from the server's tool list, else one made from its name. */
async function toolTitle(name: string): Promise<string> {
  try {
    const res = await fetch("/chat/tools", { signal: AbortSignal.timeout(1500) });
    const data = (await res.json()) as { groups?: Array<{ tools: Array<{ name: string; title?: string }> }> };
    const title = data.groups?.flatMap((g) => g.tools).find((t) => t.name === name)?.title;
    if (title) return title;
  } catch {
    // Offline or slow: the name-based label below.
  }
  return toolLabel({ name, args: {} });
}

// ---------------------------------------------------------------------------
// Showing them
// ---------------------------------------------------------------------------

const shown = new Map<string, Notification>();

function show(chatId: string | null, title: string, options: NotificationOptions): void {
  if (notificationSupport() !== "granted") return;
  let notification: Notification;
  try {
    notification = new window.Notification(title, { icon: "/favicon.ico", ...options });
  } catch {
    // Some mobile browsers only show notifications from a service worker.
    return;
  }
  if (!chatId) return;
  shown.get(chatId)?.close();
  shown.set(chatId, notification);
  notification.onclick = (event) => {
    event.preventDefault();
    window.focus();
    openAppPath(`/c/${encodeURIComponent(chatId)}`);
    notification.close();
  };
  notification.onclose = () => {
    if (shown.get(chatId) === notification) shown.delete(chatId);
  };
}

/**
 * Called by the tab that ran the chat when its run ends (once per run, after any agent hand-offs).
 * A run the user stopped says nothing.
 */
export async function notifyRunEnd(run: RunEnd): Promise<void> {
  const notice = describe(run);
  if (!notice) return;
  if (await someoneIsLooking(run.chatId)) return;
  attention.add(run.chatId);
  updateBadge();
  maybeNudge(run);
  const prefs = readNotificationPrefs();
  if (!prefs.enabled || !prefs[notice.kind] || notificationSupport() !== "granted") return;
  const firstAsk = run.messages.find((m) => m.role === "user" && !m.kind)?.content.trim();
  // A chat still waiting for its generated title goes by its first message, as the sidebar shows it.
  const title = clip(plainText(run.title && run.title !== "New chat" ? run.title : (firstAsk ?? "")), 60) || "Rye";
  const body = notice.tool ? `Needs your approval to run “${await toolTitle(notice.tool)}”.` : notice.body;
  // Re-check: the user may have come back while the title was looked up.
  if (notice.tool && lookingAt(run.chatId)) return;
  show(run.chatId, title, {
    body,
    tag: `rye-chat-${run.chatId}`,
    // Questions and approvals stay up until handled (where the system allows it).
    requireInteraction: notice.kind === "waiting",
    // A newer notification for the same chat alerts again rather than replacing the old one silently.
    ...({ renotify: true } as NotificationOptions),
  });
}

export function sendTestNotification(): boolean {
  if (notificationSupport() !== "granted") return false;
  show(null, "Rye", {
    body: "Notifications are on. You'll get one when a chat finishes or needs you while you're elsewhere.",
    tag: "rye-test",
  });
  return true;
}

// ---------------------------------------------------------------------------
// The one-time "Turn on notifications?" nudge
// ---------------------------------------------------------------------------

const NUDGE_KEY = "rye-notifications-nudge";
const NUDGE_AFTER_MS = 30_000;
let nudgeShowing = false;
const nudgeListeners = new Set<(on: boolean) => void>();

function nudgeDone(): boolean {
  try {
    return localStorage.getItem(NUDGE_KEY) === "done";
  } catch {
    return true;
  }
}

function setNudge(on: boolean) {
  nudgeShowing = on;
  for (const listener of nudgeListeners) listener(on);
}

/** After the first long run that finished while the tab was hidden, once, if notifications are off and could be on. */
function maybeNudge(run: RunEnd) {
  if (nudgeShowing || !document.hidden || !run.startedAt || Date.now() - run.startedAt < NUDGE_AFTER_MS) return;
  const support = notificationSupport();
  if (readNotificationPrefs().enabled || (support !== "default" && support !== "granted") || nudgeDone()) return;
  setNudge(true);
}

/** Whether the nudge shows, and `close(openSettings)`, which puts it away for good. */
export function useNotificationNudge(): [boolean, (openSettings: boolean) => void] {
  const [on, setOn] = useState(nudgeShowing);
  useEffect(() => {
    nudgeListeners.add(setOn);
    return () => { nudgeListeners.delete(setOn); };
  }, []);
  const close = (openSettings: boolean) => {
    try {
      localStorage.setItem(NUDGE_KEY, "done");
    } catch {
      // It still goes for this page.
    }
    setNudge(false);
    if (openSettings) openAppPath(settingsPath());
  };
  return [on, close];
}
