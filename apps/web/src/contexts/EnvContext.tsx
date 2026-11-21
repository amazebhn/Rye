import React, { createContext, useContext, useState, useCallback } from "react";
import { useSyncRefresh } from "../utils/sync";

export interface EnvInfo {
  key: string;
  name: string;
  isActive: boolean;
  overrides: string[];
}

interface EnvContextValue {
  envs: EnvInfo[];
  activeEnv: EnvInfo | null;
  envsLoading: boolean;
  refreshEnvs: () => Promise<void>;
  switchEnv: (key: string) => Promise<void>;
}

const EnvContext = createContext<EnvContextValue>({
  envs: [],
  activeEnv: null,
  envsLoading: false,
  refreshEnvs: async () => {},
  switchEnv: async () => {},
});

export function EnvProvider({ children }: { children: React.ReactNode }) {
  const [envs, setEnvs] = useState<EnvInfo[]>([]);
  const [envsLoading, setEnvsLoading] = useState(false);

  const refreshEnvs = useCallback(async () => {
    setEnvsLoading(true);
    try {
      const res = await fetch("/env/");
      if (res.ok) {
        const data: EnvInfo[] = await res.json();
        setEnvs(data);
      }
    } finally {
      setEnvsLoading(false);
    }
  }, []);

  useSyncRefresh("env", () => { refreshEnvs().catch(() => {}); });

  const switchEnv = useCallback(async (key: string) => {
    // Optimistic update
    setEnvs((prev) => prev.map((e) => ({ ...e, isActive: e.key === key })));
    await fetch("/env/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    await refreshEnvs();
  }, [refreshEnvs]);

  const activeEnv = envs.find((e) => e.isActive) ?? null;

  return (
    <EnvContext.Provider value={{ envs, activeEnv, envsLoading, refreshEnvs, switchEnv }}>
      {children}
    </EnvContext.Provider>
  );
}

export function useEnv() {
  return useContext(EnvContext);
}
