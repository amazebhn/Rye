import { useEffect, useRef } from "react";

// Cross-tab sync: tabs announce server-side changes over a BroadcastChannel and
// refetch on focus, so other tabs stay current without a reload.

export type SyncTopic = "chats" | "sops" | "skills" | "memory" | "agents" | "env" | "settings" | "profile" | "usage" | "artifacts" | "code";

export type SyncMessage =
  | { kind: "changed"; topic: SyncTopic }
  // Full set of chats this tab is running; empty when it has none or is closing.
  | { kind: "runs"; chatIds: string[] }
  | { kind: "hello" };

const REFRESH_DEBOUNCE_MS = 300;

const tabId = crypto.randomUUID();
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("rye-sync");

export function publish(msg: SyncMessage) {
  channel?.postMessage({ ...msg, from: tabId });
}

/** Messages from other tabs only (a channel never receives its own posts). */
export function onSyncMessage(handler: (msg: SyncMessage & { from: string }) => void): () => void {
  if (!channel) return () => {};
  const listener = (e: MessageEvent<SyncMessage & { from: string }>) => handler(e.data);
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}

/** Runs `refresh` when another tab changes `topic`, and when this tab is shown or focused again. */
export function useSyncRefresh(topic: SyncTopic, refresh: () => void) {
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; });

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refreshRef.current(), REFRESH_DEBOUNCE_MS);
    };
    // Hidden tabs skip broadcasts; they catch up when they become visible.
    const off = onSyncMessage((msg) => {
      if (msg.kind === "changed" && msg.topic === topic && !document.hidden) schedule();
    });
    const onShow = () => { if (!document.hidden) schedule(); };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      off();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [topic]);
}

const MUTATION_TOPICS: [RegExp, SyncTopic][] = [
  [/^\/chat\/(history|session|folders)(\/|$)/, "chats"],
  [/^\/(chat\/sop$|sop\/)/, "sops"],
  [/^\/(chat\/skill$|skill\/)/, "skills"],
  [/^\/memory\//, "memory"],
  [/^\/knowledge(\/|$)/, "memory"],
  [/^\/agents(\/|$)/, "agents"],
  [/^\/env\//, "env"],
  [/^\/models\/settings$/, "settings"],
  [/^\/profile(\/|$)/, "profile"],
  [/^\/usage\//, "usage"],
  [/^\/result\/[^/]+\/save$/, "artifacts"],
  [/^\/code\//, "code"],
];

/** Announces every successful API mutation, so each call site doesn't have to. */
export function publishApiMutations() {
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await fetchOriginal(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (res.ok && method !== "GET" && method !== "HEAD") {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const topic = url.origin === window.location.origin
        ? MUTATION_TOPICS.find(([pattern]) => pattern.test(url.pathname))?.[1]
        : undefined;
      if (topic) publish({ kind: "changed", topic });
    }
    return res;
  };
}
