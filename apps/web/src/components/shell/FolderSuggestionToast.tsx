import { useEffect, useRef, useState } from "react";
import { Folder } from "lucide-react";

const DURATION_MS = 8000;
const TICK_MS = 100;

interface Props {
  suggestionKey: string | null;
  chatTitle: string;
  folderName: string;
  onMove: () => void;
  onDismiss: () => void;
}

// Persistent polite live region; the toast inside is keyed per suggestion so its timer restarts.
export default function FolderSuggestionToast({ suggestionKey, ...rest }: Props) {
  return (
    <div className="folder-toast-region" role="status" aria-live="polite">
      {suggestionKey && <Toast key={suggestionKey} {...rest} />}
    </div>
  );
}

function Toast({ chatTitle, folderName, onMove, onDismiss }: Omit<Props, "suggestionKey">) {
  const [remaining, setRemaining] = useState(DURATION_MS);
  const remainingRef = useRef(DURATION_MS);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const doneRef = useRef(false);
  const onMoveRef = useRef(onMove);
  useEffect(() => { onMoveRef.current = onMove; });

  useEffect(() => {
    const sync = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const paused = hovered || focused || hidden;
  useEffect(() => {
    if (paused) return;
    const startedAt = performance.now();
    const from = remainingRef.current;
    const timer = window.setInterval(() => {
      const left = Math.max(0, from - (performance.now() - startedAt));
      remainingRef.current = left;
      setRemaining(left);
      if (left === 0 && !doneRef.current) {
        doneRef.current = true;
        window.clearInterval(timer);
        onMoveRef.current();
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [paused]);

  const finish = (accept: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    (accept ? onMove : onDismiss)();
  };

  return (
    <div
      className="folder-toast"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
      onKeyDown={(e) => { if (e.key === "Escape") finish(false); }}
    >
      <Folder size={16} className="folder-toast-icon" aria-hidden="true" />
      <div className="folder-toast-body">
        <p className="folder-toast-text">
          Move “<span className="folder-toast-chat">{chatTitle}</span>” to <strong>{folderName}</strong>?
        </p>
        <span className="folder-toast-sr">Moves automatically in {DURATION_MS / 1000} seconds unless dismissed.</span>
        <span className="folder-toast-countdown" aria-hidden="true">
          {paused ? "Paused" : `Moving in ${Math.ceil(remaining / 1000)}s`}
        </span>
      </div>
      <div className="folder-toast-actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => finish(true)}>Move</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => finish(false)}>Dismiss</button>
      </div>
      <div className="folder-toast-progress" aria-hidden="true">
        <div className="folder-toast-progress-bar" style={{ transform: `scaleX(${remaining / DURATION_MS})` }} />
      </div>
    </div>
  );
}
