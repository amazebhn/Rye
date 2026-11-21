import React from "react";
import type { SOP } from "../../contexts/SopContext";
import type { EditSuggestion } from "../authoring/AiEmptyState";
import { useEditSuggestions } from "../authoring/useEditSuggestions";
import AiEditorSheet from "../authoring/AiEditorSheet";

const ENHANCE_PROMPTS: EditSuggestion[] = [
  { label: "Tighten wording", prompt: "Tighten the wording and fix any formatting issues." },
  { label: "Numbered steps", prompt: "Break long paragraphs into clear numbered steps." },
  { label: "Prerequisites", prompt: "Add a prerequisites section listing the access and tools needed." },
  { label: "Verification", prompt: "Add a verification section explaining how to confirm it worked." },
  { label: "Rollback", prompt: "Add rollback steps in case something goes wrong." },
];

export interface PendingDraft {
  sop_id: number;
  title: string;
  proposed_content: string;
  original_content: string;
}

interface Props {
  sop: SOP;
  onClose: () => void;
  onDraftReady: (draft: PendingDraft) => void;
}

export default function SopChatSheet({ sop, onClose, onDraftReady }: Props) {
  const edits = useEditSuggestions("sop", sop.title, sop.content, ENHANCE_PROMPTS);

  const systemSuffix = [
    `You are in SOP EDITING MODE.`,
    `SOP id: ${sop.id}`,
    `SOP title: "${sop.title}"`,
    ``,
    `STRICT RULES — follow exactly:`,
    `1. When you have edits ready, call save_sop_tool with id=${sop.id} and the full revised content. Do this IMMEDIATELY.`,
    `2. NEVER write the SOP content as chat text. Writing markdown in the chat instead of calling the tool is WRONG.`,
    `3. Always pass id=${sop.id} to save_sop_tool. Never omit it.`,
    `4. After calling save_sop_tool, write ONE brief sentence saying what changed. Nothing else.`,
    `5. Do not ask for confirmation before calling save_sop_tool — just call it.`,
  ].join("\n");

  return (
    <AiEditorSheet
      kind="SOP"
      title={sop.title}
      content={sop.content}
      badgeText="Review before saving"
      badgeTitle="Changes come back as a draft you can approve or discard."
      placeholder="Ask the AI to edit or enhance this SOP…"
      ariaLabel="Ask the AI to edit this SOP"
      systemSuffix={systemSuffix}
      buildFirstMessage={(text) =>
        `Here is the current SOP content:\n\n# ${sop.title}\n\n${sop.content}\n\n---\n\n${text}`
      }
      suggestions={edits.suggestions}
      suggestionsLoading={edits.loading}
      suggestionsTailored={edits.tailored}
      onEvent={(event) => {
        if (event.type === "sop_draft" && event.sop_id != null) {
          onDraftReady({
            sop_id: event.sop_id,
            title: event.title ?? sop.title,
            proposed_content: event.proposed_content ?? "",
            original_content: event.original_content ?? "",
          });
        }
      }}
      onClose={onClose}
    />
  );
}
