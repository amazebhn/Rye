import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, X } from "lucide-react";

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  /** Shows a back arrow before the title, for multi-step modals. */
  onBack?: () => void;
  /** Pinned action bar below the scrollable body. */
  footer?: React.ReactNode;
  /** Extra class applied to the inner panel, e.g. "modal--wide" */
  className?: string;
  /** Ignores backdrop clicks, e.g. while a form is open. */
  lockBackdrop?: boolean;
  /** Set false when this modal replaces another, so the backdrop doesn't fade in again. */
  animateIn?: boolean;
  /** Asks for confirmation before closing, for unsaved work. Implies lockBackdrop. */
  guardDismiss?: boolean;
  guardTitle?: string;
  guardMessage?: string;
  children: React.ReactNode;
}

const ModalCloseContext = createContext<() => void>(() => {});

/** Close the enclosing modal through its guard (use for in-body Cancel buttons). */
export function useModalClose() {
  return useContext(ModalCloseContext);
}

export function ModalCancelButton({ label = "Cancel" }: { label?: string }) {
  const close = useModalClose();
  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={close}>
      {label}
    </button>
  );
}

/** Shared accessible modal overlay. Closes on Escape or backdrop click. */
export default function Modal({
  title,
  description,
  onClose,
  onBack,
  footer,
  className,
  lockBackdrop = false,
  animateIn = true,
  guardDismiss = false,
  guardTitle = "Discard unsaved changes?",
  guardMessage = "You have edits that haven't been saved. If you close now, they'll be lost.",
  children,
}: ModalProps) {
  const [confirming, setConfirming] = useState(false);
  // Only a press that starts on the backdrop counts, so drag-selecting text out of the panel can't close it.
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    if (!guardDismiss) setConfirming(false);
  }, [guardDismiss]);

  const requestClose = useCallback(() => {
    if (guardDismiss) setConfirming(true);
    else onClose();
  }, [guardDismiss, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (confirming) setConfirming(false);
      else requestClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, requestClose]);

  return (
    <div
      className={`modal-overlay${animateIn ? "" : " modal-overlay--no-enter"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby={description ? "modal-description" : undefined}
      onMouseDown={(e) => { pressStartedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const fromBackdrop = pressStartedOnBackdrop.current && e.target === e.currentTarget;
        pressStartedOnBackdrop.current = false;
        if (!fromBackdrop) return;
        if (guardDismiss) setConfirming(true);
        else if (!lockBackdrop) onClose();
      }}
    >
      <div
        className={`modal-panel${className ? ` ${className}` : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          {onBack && (
            <button type="button" className="modal-back" onClick={onBack} aria-label="Back" title="Back">
              <ChevronLeft size={18} />
            </button>
          )}
          <div className="modal-heading">
            <h3 className="modal-title" id="modal-title">{title}</h3>
            {description && <p className="modal-description" id="modal-description">{description}</p>}
          </div>
          <button className="modal-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <ModalCloseContext.Provider value={requestClose}>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </ModalCloseContext.Provider>
        {confirming && (
          <div className="modal-confirm">
            <div
              className="modal-confirm-box"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="modal-confirm-title"
              aria-describedby="modal-confirm-text"
            >
              <div className="modal-confirm-head">
                <span className="modal-confirm-icon" aria-hidden="true">
                  <AlertTriangle size={16} />
                </span>
                <div>
                  <h4 className="modal-confirm-title" id="modal-confirm-title">{guardTitle}</h4>
                  <p className="modal-confirm-text" id="modal-confirm-text">{guardMessage}</p>
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} autoFocus>
                  Keep editing
                </button>
                <button className="btn btn--danger btn--sm" onClick={onClose}>
                  Discard changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
