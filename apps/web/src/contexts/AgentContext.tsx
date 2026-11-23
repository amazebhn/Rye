import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from "react";
import type { AgentAvatar, AgentRecord } from "../utils/types";
import { useSyncRefresh } from "../utils/sync";

export interface AgentInput {
  name: string;
  slug?: string;
  description?: string;
  instructions: string;
  avatar?: AgentAvatar;
  model?: string | null;
  env?: string | null;
  tool_groups?: string[];
  skip_base_prompt?: boolean;
}

export type AgentChattiness = "off" | "low" | "medium" | "high";

export interface AgentCollaborationSettings {
  autoRoute: boolean;
  allowAgentReplies: boolean;
  chattiness: AgentChattiness;
}

const DEFAULT_SETTINGS: AgentCollaborationSettings = {
  autoRoute: false,
  allowAgentReplies: false,
  chattiness: "low",
};

interface AgentNavHandlers {
  openChat?: (agent: AgentRecord) => void;
  openProfile?: (agent: AgentRecord) => void;
}

interface AgentContextValue {
  agents: AgentRecord[] | null;
  agentsLoading: boolean;
  agentById: ReadonlyMap<string, AgentRecord>;
  agentBySlug: ReadonlyMap<string, AgentRecord>;
  settings: AgentCollaborationSettings;
  pendingProfileId: string | null;
  clearPendingProfileId: () => void;
  registerNavHandlers: (handlers: AgentNavHandlers) => void;
  openAgentChat: (agent: AgentRecord) => void;
  openAgentProfile: (agent: AgentRecord) => void;
  refreshAgents: () => Promise<void>;
  createAgent: (input: AgentInput) => Promise<AgentRecord>;
  updateAgent: (id: string, input: Partial<AgentInput> & { chat_id?: string | null }) => Promise<AgentRecord>;
  deleteAgent: (id: string) => Promise<void>;
  updateSettings: (patch: Partial<AgentCollaborationSettings>) => Promise<void>;
}

const AgentContext = createContext<AgentContextValue>({
  agents: null,
  agentsLoading: false,
  agentById: new Map(),
  agentBySlug: new Map(),
  settings: DEFAULT_SETTINGS,
  pendingProfileId: null,
  clearPendingProfileId: () => {},
  registerNavHandlers: () => {},
  openAgentChat: () => {},
  openAgentProfile: () => {},
  refreshAgents: async () => {},
  createAgent: async () => { throw new Error("AgentProvider missing"); },
  updateAgent: async () => { throw new Error("AgentProvider missing"); },
  deleteAgent: async () => {},
  updateSettings: async () => {},
});

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [settings, setSettings] = useState<AgentCollaborationSettings>(DEFAULT_SETTINGS);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const navRef = React.useRef<AgentNavHandlers>({});

  const registerNavHandlers = useCallback((handlers: AgentNavHandlers) => {
    navRef.current = handlers;
  }, []);

  const clearPendingProfileId = useCallback(() => setPendingProfileId(null), []);

  const openAgentChat = useCallback((agent: AgentRecord) => {
    navRef.current.openChat?.(agent);
  }, []);

  const openAgentProfile = useCallback((agent: AgentRecord) => {
    setPendingProfileId(agent.id);
    navRef.current.openProfile?.(agent);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/agents/settings");
      if (!res.ok) return;
      const data = (await res.json()) as Partial<AgentCollaborationSettings>;
      setSettings({ ...DEFAULT_SETTINGS, ...data });
    } catch {
      // keep defaults
    }
  }, []);

  const loadAgents = useCallback(async (silent: boolean) => {
    if (!silent) setAgentsLoading(true);
    try {
      const res = await fetch("/agents/");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AgentRecord[];
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      if (!silent) setAgents([]);
    } finally {
      if (!silent) setAgentsLoading(false);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    await Promise.all([loadAgents(false), loadSettings()]);
  }, [loadAgents, loadSettings]);

  // Load once on startup so sidebar chat avatars and @mentions work immediately.
  useEffect(() => {
    void loadAgents(false);
    void loadSettings();
  }, [loadAgents, loadSettings]);

  useSyncRefresh("agents", () => {
    void loadAgents(true);
    void loadSettings();
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );

  const agentBySlug = useMemo(
    () => new Map((agents ?? []).map((a) => [a.slug.toLowerCase(), a])),
    [agents],
  );

  const createAgent = useCallback(async (input: AgentInput): Promise<AgentRecord> => {
    const res = await fetch("/agents/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const created = (await res.json()) as AgentRecord;
    setAgents((prev) => [...(prev ?? []), created].sort((a, b) => a.name.localeCompare(b.name)));
    return created;
  }, []);

  const updateAgent = useCallback(
    async (id: string, input: Partial<AgentInput> & { chat_id?: string | null }): Promise<AgentRecord> => {
      const res = await fetch(`/agents/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as AgentRecord;
      setAgents((prev) =>
        (prev ?? []).map((a) => (a.id === id ? updated : a)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      return updated;
    },
    [],
  );

  const deleteAgent = useCallback(async (id: string) => {
    await fetch(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    setAgents((prev) => prev?.filter((a) => a.id !== id) ?? prev);
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AgentCollaborationSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    const res = await fetch("/agents/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = (await res.json()) as AgentCollaborationSettings;
      setSettings(updated);
    }
  }, []);

  return (
    <AgentContext.Provider
      value={{
        agents,
        agentsLoading,
        agentById,
        agentBySlug,
        settings,
        pendingProfileId,
        clearPendingProfileId,
        registerNavHandlers,
        openAgentChat,
        openAgentProfile,
        refreshAgents,
        createAgent,
        updateAgent,
        deleteAgent,
        updateSettings,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgents() {
  return useContext(AgentContext);
}
