import React from "react";
import { FileDiff } from "lucide-react";
import type { DiffStat } from "@rye/shared";
import { Stat } from "./ChangesView";

/**
 * Under the latest reply of a code chat whose branch has changes: "2 files changed · +7 −0 · since main"
 * and Review, which switches to the Changes tab. A message card like `ArtifactCard`.
 */
export default function ChangesSummaryCard({ stat, base, onReview }: { stat: DiffStat; base: string; onReview: () => void }) {
  const title = `${stat.files} file${stat.files === 1 ? "" : "s"} changed`;
  return (
    <div className="artifact-cards">
      <div className="artifact-card code-changes-card">
        <button type="button" className="artifact-card-main" onClick={onReview} title="Review the changes">
          <span className="artifact-card-icon"><FileDiff size={16} aria-hidden="true" /></span>
          <span className="artifact-card-text">
            <span className="artifact-card-title">{title}</span>
            <span className="artifact-card-meta">
              <span><Stat file={{ ...stat, binary: false }} /></span>
              <span>since {base}</span>
            </span>
          </span>
        </button>
        <div className="artifact-card-actions">
          <button type="button" className="btn btn--sm btn--ghost" onClick={onReview} aria-label={`Review: ${title}`}>
            Review
          </button>
        </div>
      </div>
    </div>
  );
}
