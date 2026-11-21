import React, { useState } from "react";
import Modal, { ModalCancelButton } from "../shared/Modal";
import CreateModePicker, { type CreateOrInstallMode } from "./CreateModePicker";
import AiCreateChat, { type AiCreateChatProps } from "./AiCreateChat";

type Mode = "pick" | "write" | "ai";

export interface CreateResourceModalProps {
  noun: string;
  /** Skip the mode picker and open directly in write/edit mode. */
  skipPicker?: boolean;
  pickTitle: string;
  writeTitle: string;
  writeDescription: string;
  aiDescription: string;
  pickerWriteDescription: string;
  pickerAiDescription: string;
  pickerInstallDescription?: string;
  onInstall?: () => void;
  submitLabel: string;
  submittingLabel?: string;
  canSubmit: boolean;
  submitting: boolean;
  writeHasProgress: boolean;
  onSubmitWrite: () => void | Promise<void>;
  renderWriteForm: () => React.ReactNode;
  ai?: Omit<AiCreateChatProps, "onProgressChange">;
  animateIn?: boolean;
  onClose: () => void;
}

/**
 * Shared create/edit modal shell used by SOPs, Skills, and Agents:
 * mode picker ("Write Markdown" / "Generate with AI" / optional "Install"),
 * wide write form, and identical "Generate with AI" composer.
 */
export default function CreateResourceModal({
  noun,
  skipPicker = false,
  pickTitle,
  writeTitle,
  writeDescription,
  aiDescription,
  pickerWriteDescription,
  pickerAiDescription,
  pickerInstallDescription,
  onInstall,
  submitLabel,
  submittingLabel = "Creating…",
  canSubmit,
  submitting,
  writeHasProgress,
  onSubmitWrite,
  renderWriteForm,
  ai,
  animateIn,
  onClose,
}: CreateResourceModalProps) {
  const [mode, setMode] = useState<Mode>(skipPicker ? "write" : "pick");
  const [choice, setChoice] = useState<CreateOrInstallMode | null>(null);
  const [aiHasProgress, setAiHasProgress] = useState(false);

  function next(picked: CreateOrInstallMode) {
    if (picked === "install") onInstall?.();
    else setMode(picked);
  }

  const modalTitle = mode === "pick" ? pickTitle : mode === "write" ? writeTitle : "Generate with AI";
  const modalDescription =
    mode === "pick"
      ? "Choose how you'd like to start."
      : mode === "write"
        ? writeDescription
        : aiDescription;

  const hasProgress = (mode === "ai" && aiHasProgress) || (mode === "write" && writeHasProgress);

  return (
    <Modal
      title={modalTitle}
      description={modalDescription}
      onClose={onClose}
      className={mode !== "pick" ? "modal--wide" : undefined}
      animateIn={animateIn}
      lockBackdrop={mode !== "pick"}
      guardDismiss={hasProgress}
      onBack={!skipPicker && mode !== "pick" ? () => setMode("pick") : undefined}
      footer={
        mode === "pick" ? (
          <>
            <ModalCancelButton />
            <button className="btn btn--primary btn--sm" disabled={!choice} onClick={() => choice && next(choice)}>
              Next
            </button>
          </>
        ) : mode === "write" ? (
          <>
            <ModalCancelButton />
            <button
              className="btn btn--primary btn--sm"
              onClick={() => void onSubmitWrite()}
              disabled={!canSubmit || submitting}
            >
              {submitting ? submittingLabel : submitLabel}
            </button>
          </>
        ) : undefined
      }
    >
      {mode === "pick" && (
        <CreateModePicker
          noun={noun}
          writeDescription={pickerWriteDescription}
          aiDescription={pickerAiDescription}
          installDescription={pickerInstallDescription}
          value={choice}
          onChange={setChoice}
          onContinue={next}
        />
      )}

      {mode === "write" && renderWriteForm()}

      {mode === "ai" && ai && (
        <AiCreateChat {...ai} onProgressChange={setAiHasProgress} />
      )}
    </Modal>
  );
}
