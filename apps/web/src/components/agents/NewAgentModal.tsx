import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Pencil, Upload } from "lucide-react";
import type { AgentAvatar as AgentAvatarType, AgentRecord } from "../../utils/types";
import { useAgents, type AgentInput } from "../../contexts/AgentContext";
import { useSops } from "../../contexts/SopContext";
import { useSkills } from "../../contexts/SkillContext";
import { useMemories } from "../../contexts/MemoryContext";
import Collapse from "../shared/Collapse";
import CreateResourceModal from "../authoring/CreateResourceModal";
import MarkdownEditor, { type EditorMention } from "../shared/MarkdownEditor";
import ModelSelect from "../shared/ModelSelect";
import AgentAvatar, { AGENT_GRADIENTS } from "./AgentAvatar";

const TOOL_GROUP_OPTIONS = [
  { id: "mysql", label: "MySQL" },
  { id: "aws", label: "AWS" },
  { id: "jira", label: "Jira" },
  { id: "git", label: "Git" },
  { id: "code_search", label: "Code Search" },
  { id: "results", label: "Results" },
  { id: "artifacts", label: "Artifacts" },
  { id: "sop_authoring", label: "SOPs" },
  { id: "skills", label: "Skills" },
];

const AGENT_TEMPLATE = `## Role
Describe what domain or system this agent owns and when it should be consulted.

## Workflow
1. Check relevant SOPs, saved knowledge, or live metrics first.
2. Gather direct evidence with tools before drawing conclusions.
3. Summarize findings with exact IDs, timestamps, and next steps.

## Guardrails
- Never speculate without evidence from tool results.
- Call out blast radius and rollback steps before recommending changes.
`;

const AGENT_PLACEHOLDER = `Describe this agent's role, workflow, and guardrails…
Type @ or # to reference SOPs, Skills, Knowledge notes, or other Agents.`;

const AGENT_SUGGESTIONS = [
  "A MySQL & database performance specialist that checks schemas and EXPLAIN plans",
  "An AWS infrastructure & ECS triage agent focused on logs and target health",
  "A payments & billing domain expert that helps debug failed transactions",
];

const AGENT_AI_SYSTEM_SUFFIX = [
  "You are in AGENT CREATION MODE.",
  "",
  "STRICT RULES — follow exactly:",
  "1. When you understand the user's agent requirements, call save_agent_tool WITHOUT an id field to create the new agent.",
  "2. Pick a clear name, concise lowercase slug (no '@'), one-line description, rich Markdown instructions, matching avatar_gradient, and relevant tool_groups.",
  "3. NEVER dump the full agent instructions as chat text instead of calling save_agent_tool.",
  "4. After calling save_agent_tool, write ONE brief sentence confirming what was created.",
  "5. Do not ask for confirmation before calling save_agent_tool — call it as soon as you have enough detail.",
].join("\n");

interface Props {
  /** When provided, opens directly in edit mode for this agent (skipping the mode picker). */
  initial?: AgentRecord;
  onSaved: (agent: AgentRecord) => void;
  onClose: () => void;
}

export default function NewAgentModal({ initial, onSaved, onClose }: Props) {
  const { agents, createAgent, updateAgent, refreshAgents } = useAgents();
  const { sops, refreshSops } = useSops();
  const { skills, refreshSkills } = useSkills();
  const { knowledgeDocs, refreshKnowledge } = useMemories();
  const isEditing = Boolean(initial);

  // Ensure SOPs, Skills, and Knowledge notes are loaded for @ / # tagging in instructions
  useEffect(() => {
    if (sops === null) void refreshSops();
    if (skills === null) void refreshSkills();
    if (knowledgeDocs === null) void refreshKnowledge();
  }, [sops, skills, knowledgeDocs, refreshSops, refreshSkills, refreshKnowledge]);

  const editorMentions = useMemo<EditorMention[]>(() => {
    const items: EditorMention[] = [];
    for (const sop of sops ?? []) {
      const preview = sop.content.replace(/^#+\s.*/gm, "").replace(/\s+/g, " ").trim().slice(0, 80);
      items.push({
        id: `sop:${sop.id}`,
        kind: "sop",
        label: sop.title,
        token: `[[sop:${sop.id}|${sop.title}]]`,
        subtitle: preview || undefined,
      });
    }
    for (const skill of skills ?? []) {
      items.push({
        id: `skill:${skill.name}`,
        kind: "skill",
        label: skill.title || skill.name,
        token: `[[skill:${skill.name}|${skill.title || skill.name}]]`,
        subtitle: skill.description || skill.name,
      });
    }
    for (const doc of knowledgeDocs ?? []) {
      items.push({
        id: `knowledge:${doc.id}`,
        kind: "knowledge",
        label: doc.title,
        token: `[[knowledge:${doc.id}|${doc.title}]]`,
        subtitle: doc.category,
      });
    }
    for (const a of agents ?? []) {
      if (initial && a.id === initial.id) continue;
      items.push({
        id: `agent:${a.id}`,
        kind: "agent",
        label: `${a.name} (@${a.slug})`,
        token: `@${a.slug}`,
        subtitle: a.description || undefined,
      });
    }
    return items;
  }, [sops, skills, knowledgeDocs, agents, initial]);

  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [avatar, setAvatar] = useState<AgentAvatarType>(
    initial?.avatar ?? { kind: "gradient", value: "sunset" },
  );
  const [model, setModel] = useState<string>(initial?.model ?? "");
  const [toolGroups, setToolGroups] = useState<string[]>(initial?.tool_groups ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(initial?.model || (initial?.tool_groups.length ?? 0) > 0),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!avatarOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!avatarPopoverRef.current?.contains(e.target as Node)) setAvatarOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [avatarOpen]);

  function toggleToolGroup(id: string) {
    setToolGroups((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 400_000) {
      setError("Please choose an image smaller than 400 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAvatar({ kind: "image", value: reader.result });
        setError(null);
      }
    };
    reader.readAsDataURL(file);
  }

  async function saveWrite() {
    if (!name.trim() || !instructions.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload: AgentInput = {
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim(),
        instructions: instructions.trim(),
        avatar,
        model: model.trim() || null,
        tool_groups: toolGroups,
      };
      const saved = initial
        ? await updateAgent(initial.id, payload)
        : await createAgent(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const writeHasProgress = isEditing
    ? name !== initial!.name ||
      slug !== initial!.slug ||
      description !== initial!.description ||
      instructions !== initial!.instructions
    : name.trim().length > 0 || instructions.trim().length > 0;

  return (
    <CreateResourceModal
      noun="agent"
      skipPicker={isEditing}
      pickTitle="New Agent"
      writeTitle={isEditing ? `Edit ${initial!.name}` : "Create Agent"}
      writeDescription={
        isEditing
          ? "Update this agent's identity, avatar, instructions, or default tools."
          : "Configure the agent's profile and write its instructions in Markdown."
      }
      aiDescription="Describe the agent. Rye may ask follow-ups, then drafts its profile and instructions."
      pickerWriteDescription="Set up the avatar, handle, tools, and write instructions yourself"
      pickerAiDescription="Describe the role and Rye drafts the agent and instructions for you"
      submitLabel={isEditing ? "Save Changes" : "Create Agent"}
      submittingLabel="Saving…"
      canSubmit={name.trim().length > 0 && instructions.trim().length > 0}
      submitting={saving}
      writeHasProgress={writeHasProgress}
      onSubmitWrite={saveWrite}
      onClose={onClose}
      renderWriteForm={() => (
        <div className="modal-form">
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div ref={avatarPopoverRef} style={{ position: "relative", paddingTop: 18 }}>
              <button
                type="button"
                onClick={() => setAvatarOpen((v) => !v)}
                title="Change avatar gradient or upload image"
                aria-label="Change avatar"
                style={{
                  position: "relative",
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  cursor: "pointer",
                  borderRadius: "50%",
                  display: "block",
                }}
              >
                <AgentAvatar avatar={avatar} name={name || "Agent"} size="lg" />
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    right: -2,
                    bottom: -2,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "var(--main-bg)",
                    border: "1px solid var(--main-border)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--main-fg-muted)",
                  }}
                >
                  <Pencil size={9} />
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  handleImageUpload(e);
                  setAvatarOpen(false);
                }}
              />
              {avatarOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    width: 212,
                    background: "var(--main-bg)",
                    border: "1px solid var(--main-border)",
                    borderRadius: 10,
                    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.2)",
                    padding: 10,
                    zIndex: 40,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, justifyItems: "center" }}>
                    {AGENT_GRADIENTS.map((g) => {
                      const selected = avatar.kind === "gradient" && avatar.value === g.id;
                      return (
                        <button
                          key={g.id}
                          type="button"
                          title={g.label}
                          aria-label={`${g.label} gradient`}
                          onClick={() => {
                            setAvatar({ kind: "gradient", value: g.id });
                            setAvatarOpen(false);
                          }}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: "50%",
                            background: g.css,
                            border: selected ? "2px solid var(--main-fg)" : "2px solid transparent",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        />
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    style={{ width: "100%", justifyContent: "center", display: "inline-flex", alignItems: "center", gap: 6 }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={12} />
                    Upload image…
                  </button>
                </div>
              )}
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 2 }}>
                  <label className="form-label">Name</label>
                  <input
                    className="form-input"
                    placeholder="e.g. Database Specialist"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="form-label">Handle</label>
                  <input
                    className="form-input"
                    placeholder="@auto"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.replace(/^@+/, ""))}
                  />
                </div>
              </div>

              <div>
                <label className="form-label">Description</label>
                <input
                  className="form-input"
                  placeholder="Short summary for the agent list, @mentions, and auto-routing"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </div>

          <label className="form-label" htmlFor="agent-instructions-editor">Instructions</label>
          <MarkdownEditor
            id="agent-instructions-editor"
            value={instructions}
            onChange={setInstructions}
            placeholder={AGENT_PLACEHOLDER}
            template={AGENT_TEMPLATE}
            mentions={editorMentions}
          />

          <div style={{ borderTop: "1px solid var(--main-border)", paddingTop: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                background: "transparent",
                border: "none",
                padding: "2px 0",
                cursor: "pointer",
                color: "var(--main-fg)",
                fontSize: 12.5,
                fontWeight: 500,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <ChevronRight
                  size={14}
                  style={{
                    transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 140ms ease",
                    color: "var(--main-fg-faint)",
                  }}
                />
                Model & pre-loaded tools
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--main-fg-faint)" }}>
                {model ? model : "Default model"} · {toolGroups.length > 0 ? `${toolGroups.length} pre-loaded` : "On-demand tools"}
              </span>
            </button>

            <Collapse open={advancedOpen}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="form-label" style={{ margin: 0 }}>Default model</span>
                  <ModelSelect value={model || undefined} onChange={(m) => setModel(m)} />
                  {model && (
                    <button type="button" className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setModel("")}>
                      Clear
                    </button>
                  )}
                </div>

                <div>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                    <span className="form-label" style={{ margin: 0 }}>
                      Pre-loaded tools{" "}
                      <span style={{ fontWeight: 400, color: "var(--main-fg-faint)" }}>
                        ({toolGroups.length} selected)
                      </span>
                    </span>
                    <span style={{ fontSize: 11, color: "var(--main-fg-faint)" }}>
                      Loaded on turn 1; unselected tools still load on demand
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {TOOL_GROUP_OPTIONS.map((g) => {
                      const active = toolGroups.includes(g.id);
                      return (
                        <button
                          key={g.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleToolGroup(g.id)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "4px 10px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: active ? 600 : 400,
                            cursor: "pointer",
                            border: active
                              ? "1px solid var(--accent, #6366f1)"
                              : "1px solid var(--main-border)",
                            background: active
                              ? "color-mix(in srgb, var(--accent, #6366f1) 16%, transparent)"
                              : "transparent",
                            color: active ? "var(--main-fg)" : "var(--main-fg-muted)",
                            transition: "background 120ms ease, border-color 120ms ease",
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 4,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              border: active
                                ? "1px solid var(--accent, #6366f1)"
                                : "1px solid var(--main-fg-faint)",
                              background: active ? "var(--accent, #6366f1)" : "transparent",
                              color: "#fff",
                            }}
                          >
                            {active && <Check size={10} strokeWidth={3} />}
                          </span>
                          <span>{g.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Collapse>
          </div>

          {error && <div className="settings-error" role="alert">{error}</div>}
        </div>
      )}
      ai={{
        emptyTitle: "What kind of agent do you want to build?",
        suggestions: AGENT_SUGGESTIONS,
        placeholder: "Describe the agent you want to create…",
        ariaLabel: "Describe the agent you want to create",
        systemSuffix: AGENT_AI_SYSTEM_SUFFIX,
        onEvent: async (event) => {
          if (event.type === "tool_result" && event.content) {
            const match = String(event.content).match(/Agent saved with id=([a-zA-Z0-9_-]+)/);
            if (match) {
              const agentRes = await fetch(`/agents/${encodeURIComponent(match[1])}`);
              if (agentRes.ok) {
                const created = (await agentRes.json()) as AgentRecord;
                await refreshAgents();
                onSaved(created);
                return true;
              }
            }
          }
        },
      }}
    />
  );
}
