import React from "react";
import { PackagePlus } from "lucide-react";
import AiMark from "../shared/AiMark";

export type CreateMode = "write" | "ai";
export type CreateOrInstallMode = CreateMode | "install";

interface Props<M extends CreateOrInstallMode> {
  noun: string;
  writeDescription: string;
  aiDescription: string;
  /** Adds an "Install" option when set. */
  installDescription?: string;
  value: M | null;
  onChange: (mode: M) => void;
  onContinue: (mode: M) => void;
}

function WriteThumb() {
  return (
    <span className="mode-thumb mode-thumb--write" aria-hidden="true">
      <span className="mode-thumb-sheet">
        <span className="mode-thumb-heading" />
        <span className="mode-thumb-line" />
        <span className="mode-thumb-line mode-thumb-line--short" />
        <span className="mode-thumb-line" />
        <span className="mode-thumb-pill" />
      </span>
    </span>
  );
}

function AiThumb() {
  return (
    <span className="mode-thumb mode-thumb--ai" aria-hidden="true">
      <span className="mode-thumb-sheet">
        <span className="mode-thumb-spark"><AiMark size={14} /></span>
        <span className="mode-thumb-line" />
        <span className="mode-thumb-line mode-thumb-line--short" />
        <span className="mode-thumb-pill" />
      </span>
    </span>
  );
}

function InstallThumb() {
  return (
    <span className="mode-thumb mode-thumb--install" aria-hidden="true">
      <span className="mode-thumb-sheet">
        <span className="mode-thumb-spark"><PackagePlus size={14} /></span>
        <span className="mode-thumb-line" />
        <span className="mode-thumb-line mode-thumb-line--short" />
        <span className="mode-thumb-pill" />
      </span>
    </span>
  );
}

export default function CreateModePicker<M extends CreateOrInstallMode = CreateMode>({
  noun,
  writeDescription,
  aiDescription,
  installDescription,
  value,
  onChange,
  onContinue,
}: Props<M>) {
  const options = [
    { mode: "write", title: "Write Markdown", description: writeDescription, thumb: <WriteThumb /> },
    { mode: "ai", title: "Generate with AI", description: aiDescription, thumb: <AiThumb /> },
    ...(installDescription
      ? [{ mode: "install", title: "Install from GitHub", description: installDescription, thumb: <InstallThumb /> }]
      : []),
  ] as { mode: M; title: string; description: string; thumb: React.ReactNode }[];

  return (
    <div className="mode-picker">
      <div className="mode-picker-options" role="radiogroup" aria-label={`How to create this ${noun}`}>
        {options.map((option) => (
          <label
            key={option.mode}
            className={`mode-card${value === option.mode ? " is-selected" : ""}`}
            onDoubleClick={() => onContinue(option.mode)}
          >
            <input
              type="radio"
              className="mode-card-input"
              name="create-mode"
              value={option.mode}
              checked={value === option.mode}
              onChange={() => onChange(option.mode)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onContinue(option.mode);
              }}
            />
            {option.thumb}
            <span className="mode-card-text">
              <span className="mode-card-title">{option.title}</span>
              <span className="mode-card-desc">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
