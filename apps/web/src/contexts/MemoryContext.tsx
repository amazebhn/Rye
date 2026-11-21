import React, { createContext, useContext, useState, useCallback } from "react";
import { useSyncRefresh } from "../utils/sync";

export type MemoryKind = "fact" | "acronym" | "term";

export interface Memory {
  id: number;
  key: string;
  value: string;
  kind?: MemoryKind;
  category: string;
  tags: string[];
  created_at?: string;
  updated_at?: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  source: "manual" | "agent";
  category: string;
  tags: string[];
  agent_id: string | null;
  embedding_model: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchHit {
  doc_id: string;
  title: string;
  category: string;
  tags: string[];
  source: "manual" | "agent";
  heading: string;
  snippet: string;
  score: number;
  match_type: "hybrid" | "semantic" | "keyword";
}

export interface EmbeddingStatus {
  provider: "ollama" | "copilot" | "none";
  model: string | null;
  available: boolean;
}

interface MemoryContextValue {
  memories: Memory[] | null;
  memoriesLoading: boolean;
  refreshMemories: () => Promise<void>;
  saveMemory: (m: { key: string; value: string; kind?: MemoryKind; category?: string; tags?: string[] }) => Promise<void>;
  deleteMemory: (key: string) => Promise<void>;

  knowledgeDocs: KnowledgeDoc[] | null;
  knowledgeLoading: boolean;
  embeddingStatus: EmbeddingStatus | null;
  refreshKnowledge: () => Promise<void>;
  createKnowledge: (doc: { title: string; content: string; category?: string; tags?: string[] }) => Promise<void>;
  updateKnowledge: (id: string, doc: { title?: string; content?: string; category?: string; tags?: string[] }) => Promise<void>;
  deleteKnowledge: (id: string) => Promise<void>;
  searchKnowledge: (query: string) => Promise<KnowledgeSearchHit[]>;
  reindexKnowledge: () => Promise<{ docs: number; chunks: number; embedded: boolean; model: string | null }>;
}

const MemoryContext = createContext<MemoryContextValue>({
  memories: null,
  memoriesLoading: false,
  refreshMemories: async () => {},
  saveMemory: async () => {},
  deleteMemory: async () => {},
  knowledgeDocs: null,
  knowledgeLoading: false,
  embeddingStatus: null,
  refreshKnowledge: async () => {},
  createKnowledge: async () => {},
  updateKnowledge: async () => {},
  deleteKnowledge: async () => {},
  searchKnowledge: async () => [],
  reindexKnowledge: async () => ({ docs: 0, chunks: 0, embedded: false, model: null }),
});

export function MemoryProvider({ children }: { children: React.ReactNode }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDoc[] | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);

  // A silent load keeps the current list on screen and on failure.
  const loadMemories = useCallback(async (silent: boolean) => {
    if (!silent) setMemoriesLoading(true);
    try {
      const res = await fetch("/memory/");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Memory[] | { memories: Memory[] };
      const list = Array.isArray(data) ? data : (data.memories ?? []);
      setMemories(list);
    } catch {
      if (!silent) setMemories([]);
    } finally {
      if (!silent) setMemoriesLoading(false);
    }
  }, []);

  const loadKnowledge = useCallback(async (silent: boolean) => {
    if (!silent) setKnowledgeLoading(true);
    try {
      const res = await fetch("/knowledge/");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs?: KnowledgeDoc[]; embedding?: EmbeddingStatus };
      setKnowledgeDocs(data.docs ?? []);
      if (data.embedding) setEmbeddingStatus(data.embedding);
    } catch {
      if (!silent) setKnowledgeDocs([]);
    } finally {
      if (!silent) setKnowledgeLoading(false);
    }
  }, []);

  const refreshMemories = useCallback(() => loadMemories(false), [loadMemories]);
  const refreshKnowledge = useCallback(() => loadKnowledge(false), [loadKnowledge]);

  useSyncRefresh("memory", () => {
    if (memories !== null) void loadMemories(true);
    if (knowledgeDocs !== null) void loadKnowledge(true);
  });

  const saveMemory = useCallback(
    async (m: { key: string; value: string; kind?: MemoryKind; category?: string; tags?: string[] }) => {
      await fetch("/memory/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(m),
      });
      await refreshMemories();
    },
    [refreshMemories],
  );

  const deleteMemory = useCallback(async (key: string) => {
    await fetch(`/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
    setMemories((prev) => prev?.filter((m) => m.key !== key) ?? prev);
  }, []);

  const createKnowledge = useCallback(
    async (doc: { title: string; content: string; category?: string; tags?: string[] }) => {
      await fetch("/knowledge/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      await refreshKnowledge();
    },
    [refreshKnowledge],
  );

  const updateKnowledge = useCallback(
    async (id: string, doc: { title?: string; content?: string; category?: string; tags?: string[] }) => {
      await fetch(`/knowledge/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      await refreshKnowledge();
    },
    [refreshKnowledge],
  );

  const deleteKnowledge = useCallback(async (id: string) => {
    await fetch(`/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" });
    setKnowledgeDocs((prev) => prev?.filter((d) => d.id !== id) ?? prev);
  }, []);

  const searchKnowledge = useCallback(async (query: string): Promise<KnowledgeSearchHit[]> => {
    const res = await fetch(`/knowledge/search?q=${encodeURIComponent(query)}&limit=8`);
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: KnowledgeSearchHit[]; embedding?: EmbeddingStatus };
    if (data.embedding) setEmbeddingStatus(data.embedding);
    return data.hits ?? [];
  }, []);

  const reindexKnowledge = useCallback(async () => {
    const res = await fetch("/knowledge/reindex", { method: "POST" });
    if (!res.ok) return { docs: 0, chunks: 0, embedded: false, model: null };
    const data = (await res.json()) as {
      docs: number;
      chunks: number;
      embedded: boolean;
      model: string | null;
      embedding?: EmbeddingStatus;
    };
    if (data.embedding) setEmbeddingStatus(data.embedding);
    await refreshKnowledge();
    return { docs: data.docs, chunks: data.chunks, embedded: data.embedded, model: data.model };
  }, [refreshKnowledge]);

  return (
    <MemoryContext.Provider
      value={{
        memories,
        memoriesLoading,
        refreshMemories,
        saveMemory,
        deleteMemory,
        knowledgeDocs,
        knowledgeLoading,
        embeddingStatus,
        refreshKnowledge,
        createKnowledge,
        updateKnowledge,
        deleteKnowledge,
        searchKnowledge,
        reindexKnowledge,
      }}
    >
      {children}
    </MemoryContext.Provider>
  );
}

export function useMemories() {
  return useContext(MemoryContext);
}
