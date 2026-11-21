import React, { useState } from "react";
import { useSkills, skillApi, jsonInit, type Skill } from "../../contexts/SkillContext";
import CreateResourceModal from "../authoring/CreateResourceModal";
import MarkdownEditor from "../shared/MarkdownEditor";

const SKILL_TEMPLATE = `## When to use
The situations where the agent should apply this Skill.

## Approach
1. First thing to check
2. How to investigate
3. How to conclude

## Tools
- Tools, queries or dashboards to use

## Pitfalls
- Common mistakes to avoid
`;

const SKILL_SUGGESTIONS = [
  "Reading APM traces to find slow endpoints",
  "Writing safe queries against production replicas",
  "Summarizing an incident timeline from Jira",
];

const SKILL_AI_SYSTEM_SUFFIX = [
  "You are in SKILL CREATION MODE.",
  "",
  "STRICT RULES — follow exactly:",
  "1. When you have enough information, call save_skill_tool WITHOUT a name field to create a brand-new Skill.",
  "2. Always provide a one-sentence 'description' that states WHEN the skill should be used (its trigger).",
  "3. NEVER write the Skill content as chat text. Calling the tool is the ONLY correct way to save it.",
  "4. After calling save_skill_tool, write ONE brief sentence confirming what was created. Nothing else.",
  "5. Do not ask for confirmation before calling save_skill_tool — just call it once you understand the Skill.",
].join("\n");

interface Props {
  onCreated: (skill: Skill) => void;
  onInstall: () => void;
  onClose: () => void;
  animateIn?: boolean;
}

export default function NewSkillModal({ onCreated, onInstall, onClose, animateIn }: Props) {
  const { getSkill } = useSkills();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  async function createWrite() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setWriteError(null);
    try {
      const skill = await skillApi<Skill>(
        "/skill/",
        jsonInit("POST", { title: title.trim(), description: description.trim(), content }),
      );
      onCreated(skill);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CreateResourceModal
      noun="Skill"
      pickTitle="New Skill"
      writeTitle="Write Skill"
      writeDescription="Describe when the agent should use this Skill, then write it in Markdown."
      aiDescription="Describe the domain. The agent may ask follow-ups, then drafts the Skill."
      pickerWriteDescription="Start from a blank page and write the Skill yourself"
      pickerAiDescription="Describe the domain and the agent drafts it for you"
      pickerInstallDescription="Add existing skills from a GitHub repo with the skills CLI"
      onInstall={onInstall}
      submitLabel="Create Skill"
      canSubmit={title.trim().length > 0}
      submitting={saving}
      writeHasProgress={title.trim().length > 0 || description.trim().length > 0 || content.trim().length > 0}
      onSubmitWrite={createWrite}
      animateIn={animateIn}
      onClose={onClose}
      renderWriteForm={() => (
        <div className="modal-form">
          <label className="form-label">Title</label>
          <input
            className="form-input"
            placeholder="e.g. Code Review Best Practices"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void createWrite();
            }}
          />
          <label className="form-label">
            Description <span className="form-label-hint">(when to use it)</span>
          </label>
          <input
            className="form-input"
            placeholder="e.g. Use when reviewing a pull request for security issues"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void createWrite();
            }}
          />
          <label className="form-label" htmlFor="new-skill-content">Content</label>
          <MarkdownEditor
            id="new-skill-content"
            value={content}
            onChange={setContent}
            placeholder="Write your Skill in Markdown, or insert a template to get started…"
            template={SKILL_TEMPLATE}
          />
          {writeError && <p className="skill-form-error" role="alert">{writeError}</p>}
        </div>
      )}
      ai={{
        emptyTitle: "What should this Skill teach the agent?",
        suggestions: SKILL_SUGGESTIONS,
        placeholder: "Describe the Skill you want to create…",
        ariaLabel: "Describe the Skill you want to create",
        systemSuffix: SKILL_AI_SYSTEM_SUFFIX,
        onEvent: async (event) => {
          if (event.type === "tool_result" && event.content) {
            const match = String(event.content).match(/Skill created: (\S+)/);
            if (match) {
              const skill = await getSkill(match[1]).catch(() => null);
              if (skill) {
                onCreated(skill);
                return true;
              }
            }
          }
        },
      }}
    />
  );
}
