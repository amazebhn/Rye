import React, { createContext, useContext, useState, useCallback } from "react";
import { useSyncRefresh } from "../utils/sync";

export interface SOP {
  id: number;
  title: string;
  content: string;
  created_at?: string;
  updated_at?: string;
}

interface SopContextValue {
  sops: SOP[] | null;
  sopsLoading: boolean;
  refreshSops: () => Promise<void>;
  deleteSop: (id: number) => Promise<void>;
  renameSop: (id: number, title: string) => Promise<void>;
  duplicateSop: (id: number) => Promise<void>;
}

const SopContext = createContext<SopContextValue>({
  sops: null,
  sopsLoading: false,
  refreshSops: async () => {},
  deleteSop: async () => {},
  renameSop: async () => {},
  duplicateSop: async () => {},
});

export function SopProvider({ children }: { children: React.ReactNode }) {
  const [sops, setSops] = useState<SOP[] | null>(null);
  const [sopsLoading, setSopsLoading] = useState(false);

  // A silent load keeps the current list on screen and on failure.
  const loadSops = useCallback(async (silent: boolean) => {
    if (!silent) setSopsLoading(true);
    try {
      const res = await fetch("/sop/");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SOP[] | { sops: SOP[] };
      const list = Array.isArray(data) ? data : (data.sops ?? []);
      setSops(list);
    } catch {
      if (!silent) setSops([]);
    } finally {
      if (!silent) setSopsLoading(false);
    }
  }, []);
  const refreshSops = useCallback(() => loadSops(false), [loadSops]);
  useSyncRefresh("sops", () => { if (sops !== null) void loadSops(true); });

  const deleteSop = useCallback(async (id: number) => {
    await fetch(`/sop/${id}`, { method: "DELETE" });
    setSops((prev) => prev?.filter((s) => s.id !== id) ?? prev);
  }, []);

  const renameSop = useCallback(async (id: number, title: string) => {
    await fetch(`/sop/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setSops((prev) => prev?.map((s) => s.id === id ? { ...s, title } : s) ?? prev);
  }, []);

  const duplicateSop = useCallback(async (id: number) => {
    await fetch(`/sop/${id}/duplicate`, { method: "POST" });
    await refreshSops();
  }, [refreshSops]);

  return (
    <SopContext.Provider value={{ sops, sopsLoading, refreshSops, deleteSop, renameSop, duplicateSop }}>
      {children}
    </SopContext.Provider>
  );
}

export function useSops() {
  return useContext(SopContext);
}
