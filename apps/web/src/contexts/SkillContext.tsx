import React, { createContext, useContext, useState, useCallback } from "react";
import { useSyncRefresh } from "../utils/sync";

export interface SkillFile {
  path: string;
  size: number;
}

/** Mirrors agent-core skill/routes.ts `skillToJson`. `body` is only present on GET /skill/:name. */
export interface Skill {
  name: string;
  title: string;
  description: string;
  source: "rye" | "installed";
  editable: boolean;
  path: string;
  hasScripts: boolean;
  scripts: string[];
  files: SkillFile[];
  filesTruncated: boolean;
  installedFrom?: { source?: string; sourceUrl?: string; installedAt?: string; updatedAt?: string };
  extras?: Record<string, unknown>;
  shadows?: string;
  updatedAt: string;
  body?: string;
}

/** Fetch JSON; throws the backend's `{ error }` message on failure. */
export async function skillApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

interface SkillContextValue {
  skills: Skill[] | null;
  skillsLoading: boolean;
  refreshSkills: () => Promise<void>;
  getSkill: (name: string) => Promise<Skill>;
  /** Rye-owned skills are deleted; installed ones are removed through the skills CLI. */
  deleteSkill: (skill: Skill) => Promise<void>;
  renameSkill: (name: string, title: string) => Promise<void>;
  duplicateSkill: (name: string) => Promise<Skill>;
}

const SkillContext = createContext<SkillContextValue>({
  skills: null,
  skillsLoading: false,
  refreshSkills: async () => {},
  getSkill: async () => { throw new Error("SkillProvider missing"); },
  deleteSkill: async () => {},
  renameSkill: async () => {},
  duplicateSkill: async () => { throw new Error("SkillProvider missing"); },
});

export function SkillProvider({ children }: { children: React.ReactNode }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);

  // A silent load keeps the current list on screen and on failure.
  const loadSkills = useCallback(async (silent: boolean) => {
    if (!silent) setSkillsLoading(true);
    try {
      setSkills(await skillApi<Skill[]>("/skill/"));
    } catch {
      if (!silent) setSkills([]);
    } finally {
      if (!silent) setSkillsLoading(false);
    }
  }, []);
  const refreshSkills = useCallback(() => loadSkills(false), [loadSkills]);
  useSyncRefresh("skills", () => { if (skills !== null) void loadSkills(true); });

  const getSkill = useCallback(
    (name: string) => skillApi<Skill>(`/skill/${encodeURIComponent(name)}`),
    [],
  );

  const deleteSkill = useCallback(async (skill: Skill) => {
    if (skill.source === "installed") {
      await skillApi("/skill/remove", jsonInit("POST", { name: skill.name }));
      await refreshSkills();
      return;
    }
    await skillApi(`/skill/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
    // An installed skill of the same name may have been hidden by this one.
    if (skill.shadows) await refreshSkills();
    else setSkills((prev) => prev?.filter((s) => s.name !== skill.name) ?? prev);
  }, [refreshSkills]);

  const renameSkill = useCallback(async (name: string, title: string) => {
    const updated = await skillApi<Skill>(`/skill/${encodeURIComponent(name)}`, jsonInit("PUT", { title }));
    setSkills((prev) => prev?.map((s) => (s.name === name ? { ...updated, body: undefined } : s)) ?? prev);
  }, []);

  const duplicateSkill = useCallback(async (name: string) => {
    const copy = await skillApi<Skill>(`/skill/${encodeURIComponent(name)}/duplicate`, jsonInit("POST", {}));
    await refreshSkills();
    return copy;
  }, [refreshSkills]);

  return (
    <SkillContext.Provider value={{ skills, skillsLoading, refreshSkills, getSkill, deleteSkill, renameSkill, duplicateSkill }}>
      {children}
    </SkillContext.Provider>
  );
}

export function useSkills() {
  return useContext(SkillContext);
}
