import React from "react";
import { useSkills, type Skill } from "../../contexts/SkillContext";
import type { EditSuggestion } from "../authoring/AiEmptyState";
import { useEditSuggestions } from "../authoring/useEditSuggestions";
import AiEditorSheet from "../authoring/AiEditorSheet";

const ENHANCE_PROMPTS: EditSuggestion[] = [
  { label: "When to use", prompt: "Clarify when the agent should use this Skill." },
  { label: "More concise", prompt: "Make the approach more concise and actionable." },
  { label: "Example queries", prompt: "Add example queries or commands the agent can use." },
  { label: "Pitfalls", prompt: "Add common pitfalls and how to avoid them." },
];

interface Props {
  skill: Skill;
  onClose: () => void;
  onSaved: (updated: Skill) => void;
}

export default function SkillChatSheet({ skill, onClose, onSaved }: Props) {
  const { getSkill } = useSkills();
  const content = skill.body ?? "";
  const edits = useEditSuggestions("skill", skill.title, content, ENHANCE_PROMPTS);

  // Backend edit mode keys on the exact "Skill name: <name>" line (agent/loop.ts).
  const systemSuffix = [
    `You are in SKILL EDITING MODE.`,
    `Skill name: ${skill.name}`,
    `Skill title: "${skill.title}"`,
    ``,
    `STRICT RULES — follow exactly:`,
    `1. When you have edits ready, call save_skill_tool with name="${skill.name}" and the full revised content (the SKILL.md body, no frontmatter). Do this IMMEDIATELY.`,
    `2. NEVER write the Skill content as chat text. Writing markdown in the chat instead of calling the tool is WRONG.`,
    `3. Always pass name="${skill.name}" to save_skill_tool. Never omit it.`,
    `4. Always include a one-sentence 'description' stating WHEN to use this skill${skill.description ? ` (current: "${skill.description}")` : ""}. Keep it unless the user asks to change it.`,
    `5. After calling save_skill_tool, write ONE brief sentence saying what changed. Nothing else.`,
    `6. Do not ask for confirmation before calling save_skill_tool — just call it.`,
  ].join("\n");

  return (
    <AiEditorSheet
      kind="Skill"
      title={skill.title}
      content={content}
      badgeText="Saves automatically"
      badgeTitle="Edits are written to this Skill as soon as the AI makes them."
      placeholder="Ask the AI to edit or enhance this Skill…"
      ariaLabel="Ask the AI to edit this Skill"
      systemSuffix={systemSuffix}
      buildFirstMessage={(text) =>
        `Here is the current Skill content:\n\n# ${skill.title}\n\n${content}\n\n---\n\n${text}`
      }
      suggestions={edits.suggestions}
      suggestionsLoading={edits.loading}
      suggestionsTailored={edits.tailored}
      onEvent={async (event) => {
        if (event.type === "tool_result" && event.content) {
          const match = String(event.content).match(/Skill updated: (\S+)/);
          if (match) {
            try {
              onSaved(await getSkill(match[1]));
            } catch {
              // the list refresh in App still picks it up
            }
          }
        }
      }}
      onClose={onClose}
    />
  );
}
