import { useEffect, useSyncExternalStore } from "react";
import { useSyncRefresh } from "./sync";

// The user's profile (GET/PUT /profile/), shared by every component in this tab: saving it in
// Settings updates the greeting at once, and other tabs refetch on the "profile" sync topic.

export interface UserProfile {
  name: string;
}

let profile: UserProfile = { name: "" };
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: UserProfile) {
  profile = next;
  loaded = true;
  for (const l of listeners) l();
}

function refresh(): Promise<void> {
  inflight ??= fetch("/profile/")
    .then((res) => (res.ok ? (res.json() as Promise<UserProfile>) : null))
    .then((json) => { if (json && typeof json.name === "string") set({ name: json.name }); })
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}

/** Saves the name; resolves to the profile as stored (trimmed), or throws with the server's message. */
export async function saveUserName(name: string): Promise<UserProfile> {
  const res = await fetch("/profile/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<UserProfile> & { error?: string };
  if (!res.ok || typeof json.name !== "string") throw new Error(json.error ?? `HTTP ${res.status}`);
  set({ name: json.name });
  return profile;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The profile, plus whether it has been fetched yet. */
export function useUserProfile(): UserProfile & { loaded: boolean } {
  const current = useSyncExternalStore(subscribe, () => profile);
  const isLoaded = useSyncExternalStore(subscribe, () => loaded);
  useEffect(() => { if (!loaded) void refresh(); }, []);
  useSyncRefresh("profile", () => void refresh());
  return { ...current, loaded: isLoaded };
}

/** The first word of the name, for a greeting ("Sam" for "Sam Rivera"); "" when unset. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}
