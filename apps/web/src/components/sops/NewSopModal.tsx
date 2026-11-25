import React, { useState } from "react";
import type { SOP } from "../../contexts/SopContext";
import CreateResourceModal from "../authoring/CreateResourceModal";
import MarkdownEditor from "../shared/MarkdownEditor";

const SOP_TEMPLATE = `## Purpose
When this procedure applies and what it achieves.

## Prerequisites
- Access or permissions needed
- Tools or dashboards to have open

## Steps
1. First step
2. Second step
3. Third step

## Verification
- How to confirm it worked

## Rollback
1. How to undo the change if something goes wrong
`;

const SOP_SUGGESTIONS = [
  "Rolling back a failed production deploy",
  "Rotating expired database credentials",
  "Triaging a sudden spike in 5xx errors",
];

const SOP_AI_SYSTEM_SUFFIX = [
  "You are in SOP CREATION MODE.",
  "",
  "STRICT RULES — follow exactly:",
  "1. When you have enough information, call save_sop_tool WITHOUT an id field to create a brand-new SOP.",
  "2. NEVER write the SOP content as chat text. Calling the tool is the ONLY correct way to save it.",
  "3. After calling save_sop_tool, write ONE brief sentence confirming what was created. Nothing else.",
  "4. Do not ask for confirmation before calling save_sop_tool — just call it once you understand the SOP.",
].join("\n");

interface Props {
  onCreated: (sop: SOP) => void;
  onClose: () => void;
  /** Adds "Import a file" to the picker: opens the file chooser for a .md or .json SOP. */
  onImport?: () => void;
}

export default function NewSopModal({ onCreated, onClose, onImport }: Props) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function createWrite() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/sop/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sop_id: number };
        const sopRes = await fetch(`/sop/${data.sop_id}`);
        if (sopRes.ok) onCreated((await sopRes.json()) as SOP);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <CreateResourceModal
      noun="SOP"
      pickTitle="New SOP"
      writeTitle="Write SOP"
      writeDescription="Write the procedure in Markdown. You can edit it any time."
      aiDescription="Describe the process. The agent may ask follow-ups, then drafts the SOP."
      pickerWriteDescription="Start from a blank page and write the procedure yourself"
      pickerAiDescription="Describe the process and the agent drafts it for you"
      pickerImportDescription="Upload an SOP saved as Markdown (.md) or JSON (.json)"
      onImport={onImport}
      submitLabel="Create SOP"
      canSubmit={title.trim().length > 0}
      submitting={saving}
      writeHasProgress={title.trim().length > 0 || content.trim().length > 0}
      onSubmitWrite={createWrite}
      onClose={onClose}
      renderWriteForm={() => (
        <div className="modal-form">
          <label className="form-label">Title</label>
          <input
            className="form-input"
            placeholder="e.g. Deployment Runbook"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void createWrite();
            }}
          />
          <label className="form-label" htmlFor="new-sop-content">Content</label>
          <MarkdownEditor
            id="new-sop-content"
            value={content}
            onChange={setContent}
            placeholder="Write your SOP in Markdown, or insert a template to get started…"
            template={SOP_TEMPLATE}
          />
        </div>
      )}
      ai={{
        emptyTitle: "What should this SOP cover?",
        suggestions: SOP_SUGGESTIONS,
        placeholder: "Describe the SOP you want to create…",
        ariaLabel: "Describe the SOP you want to create",
        systemSuffix: SOP_AI_SYSTEM_SUFFIX,
        onEvent: async (event) => {
          if (event.type === "tool_result" && event.content) {
            const match = String(event.content).match(/SOP saved with id=(\d+)/);
            if (match) {
              const sopId = parseInt(match[1], 10);
              const sopRes = await fetch(`/sop/${sopId}`);
              if (sopRes.ok) {
                onCreated((await sopRes.json()) as SOP);
                return true;
              }
            }
          }
        },
      }}
    />
  );
}
