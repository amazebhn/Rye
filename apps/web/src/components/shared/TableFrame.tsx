import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Download, Maximize2, X } from "lucide-react";

interface TableFrameProps {
  title?: string;
  children: React.ReactNode;
  fullscreenContent?: React.ReactNode;
  onCopy?: () => void | Promise<void>;
  onDownload?: () => void;
  copyLabel?: string;
  downloadLabel?: string;
  initialFullscreen?: boolean;
  fullscreenOnly?: boolean;
  onFullscreenClose?: () => void;
}

export default function TableFrame({
  title,
  children,
  fullscreenContent,
  onCopy,
  onDownload,
  copyLabel = "Copy table",
  downloadLabel = "Download table",
  initialFullscreen = false,
  fullscreenOnly = false,
  onFullscreenClose,
}: TableFrameProps) {
  const [fullscreen, setFullscreen] = useState(initialFullscreen);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    onFullscreenClose?.();
  }, [onFullscreenClose]);

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFullscreen();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleDialogKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [closeFullscreen, fullscreen]);

  useEffect(() => () => {
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
  }, []);

  async function copy() {
    if (!onCopy) return;
    await onCopy();
    setCopied(true);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
  }

  const actions = (inFullscreen = false) => (
    <div className={`table-frame-actions${inFullscreen ? " table-frame-actions--fullscreen" : ""}`}>
      {!inFullscreen && (
        <button
          type="button"
          className="table-frame-action"
          onClick={() => setFullscreen(true)}
          title="View full screen"
          aria-label="View table full screen"
        >
          <Maximize2 size={15} />
        </button>
      )}
      {onCopy && (
        <button
          type="button"
          className="table-frame-action"
          onClick={() => void copy()}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      )}
      {onDownload && (
        <button
          type="button"
          className="table-frame-action"
          onClick={onDownload}
          title={downloadLabel}
          aria-label={downloadLabel}
        >
          <Download size={15} />
        </button>
      )}
    </div>
  );

  return (
    <>
      {!fullscreenOnly && (
        <div className="table-frame">
          {children}
          {actions()}
        </div>
      )}
      {fullscreen && createPortal(
        <div
          ref={dialogRef}
          className="table-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label={title ? `${title} table viewer` : "Table viewer"}
          tabIndex={-1}
        >
          <header className="table-fullscreen-header">
            <div className="table-fullscreen-title">
              {title && <span>{title}</span>}
              <span className="table-fullscreen-hint">Esc to close</span>
            </div>
            {actions(true)}
            <button
              type="button"
              ref={closeButtonRef}
              className="table-frame-action table-fullscreen-close"
              onClick={closeFullscreen}
              aria-label="Close full-screen table"
              title="Close"
            >
              <X size={16} />
            </button>
          </header>
          <div className="table-fullscreen-content">
            {fullscreenContent ?? children}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
