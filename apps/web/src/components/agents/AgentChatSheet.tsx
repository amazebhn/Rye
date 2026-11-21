import React from "react";
import type { AgentRecord } from "../../utils/types";
import type { EditSuggestion } from "../authoring/AiEmptyState";
import AiEditorSheet from "../authoring/AiEditorSheet";

const ENHANCE_PROMPTS: EditSuggestion[] = [
  { label: "Tighten instructions", prompt: "Tighten the instructions so they are sharper and less repetitive." },
  { label: "Add tool workflow", prompt: "Add a clear step-by-step investigation workflow specifying which tools to check first." },
  { label: "Add guardrails", prompt: "Add explicit guardrails and escalation rules for high-risk actions." },
  { label: "Define output format", prompt: "Specify a concise, structured response format for findings and recommendations." },
];

interface Props {
  agent: AgentRecord;
  onClose: () => void;
  onAgentUpdated: (agent: AgentRecord) => void;
}

export default function AgentChatSheet({ agent, onClose, onAgentUpdated }: Props) {
  const systemSuffix = [
    `You are in AGENT EDITING MODE.`,
    `Agent id: ${agent.id}`,
    `Agent name: "${agent.name}" (@${agent.slug})`,
    ``,
    `STRICT RULES — follow exactly:`,
    `1. When you have edits ready, call save_agent_tool with id="${agent.id}", name, description, and the full revised instructions. Do this IMMEDIATELY.`,
    `2. NEVER write the revised instructions as chat text instead of calling save_agent_tool.`,
    `3. Always pass id="${agent.id}" to save_agent_tool so you update this agent in place.`,
    `4. After calling save_agent_tool, write ONE brief sentence saying what changed.`,
    `5. Do not ask for confirmation before calling save_agent_tool — just call it.`,
  ].join("\n");

  return (
    <AiEditorSheet
      kind="Agent"
      title={`${agent.name} (@${agent.slug})`}
      content={agent.instructions}
      badgeText="Saves automatically"
      badgeTitle="Edits are saved to this Agent as soon as the AI makes them."
      placeholder="Ask the AI to edit or enhance this Agent…"
      ariaLabel="Ask the AI to edit this Agent"
      systemSuffix={systemSuffix}
      buildFirstMessage={(text) =>
        [
          `Here is the current agent definition:`,
          `- Name: ${agent.name}`,
          `- Handle: @${agent.slug}`,
          `- Description: ${agent.description || "(none)"}`,
          `- Pre-loaded tool groups: ${agent.tool_groups.length > 0 ? agent.tool_groups.join(", ") : "(none)"}`,
          ``,
          `Current instructions:`,
          agent.instructions,
          ``,
          `---`,
          ``,
          text,
        ].join("\n")
      }
      suggestions={ENHANCE_PROMPTS}
      onEvent={async (event) => {
        if (event.type === "tool_result" && event.content) {
          const match = String(event.content).match(/Agent saved with id=([a-zA-Z0-9_-]+)/);
          if (match) {
            const res = await fetch(`/agents/${encodeURIComponent(match[1])}`);
            if (res.ok) onAgentUpdated((await res.json()) as AgentRecord);
          }
        }
      }}
      onClose={onClose}
    />
  );
}
