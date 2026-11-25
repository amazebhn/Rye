import React, { createContext, useCallback, useEffect, useRef, useState } from "react";

/** Where a table shown full screen should draw its controls: a slot in the viewer's header bar. Null elsewhere. */
export const TableToolbarSlot = createContext<HTMLElement | null>(null);
import { createPortal } from "react-dom";
import { Check, Copy, Download, Maximize2, X } from "lucide-react";

/** A title that reads like a query (SQL, a log filter) rather than a name: shown as code. */
const looksLikeQuery = (text: string) =>
  text.includes("\n") || /^\s*(select|with|show|describe|explain|fields|filter|stats|search|index=|\{)/i.test(text) || text.length > 90;

/**
 * The full-screen viewer's title: one line with an ellipsis, so it never pushes into the controls.
 * A long or multi-line one (usually the query behind the table) can be opened in full and copied.
 */
function FullscreenTitle({ title }: { title?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const lineRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const text = title?.trim() ?? "";
  const query = text ? looksLikeQuery(text) : false;

  // Offer "Show query" only when the line doesn't fit or the text has more than one line.
  useEffect(() => {
    const el = lineRef.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1 || text.includes("\n"));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  if (!text) return <div className="table-fullscreen-title" />;
  const oneLine = text.replace(/\s+/g, " ");
  return (
    <div className={`table-fullscreen-title${query ? " is-query" : ""}${open ? " is-open" : ""}`}>
      <div className="table-fullscreen-title-line">
        <span ref={lineRef} className="table-fullscreen-title-text" title={open ? undefined : text}>
          {oneLine}
        </span>
        {(cut || open) && (
          <button type="button" className="table-fullscreen-title-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide" : query ? "Show query" : "Show all"}
          </button>
        )}
      </div>
      {open && (
        <div className="table-fullscreen-title-full">
          <pre>{text}</pre>
          <button
            type="button"
            className="table-frame-action"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
            aria-label={query ? "Copy query" : "Copy title"}
            title={query ? "Copy query" : "Copy title"}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}

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
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
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
            {/* Row 1: what the table is (a name, or often the query that made it) and the viewer's actions. */}
            <div className="table-fullscreen-top">
              <FullscreenTitle title={title} />
              {actions(true)}
              <button
                type="button"
                ref={closeButtonRef}
                className="table-frame-action table-fullscreen-close"
                onClick={closeFullscreen}
                aria-label="Close full-screen table"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>
            {/* Row 2: the table's own controls (search, group, chart), drawn here by the table itself. */}
            <div ref={setToolbarSlot} className="table-fullscreen-tools" />
          </header>
          <div className="table-fullscreen-content">
            {/* Rendered once the header slot exists, so the controls never flash in the wrong place. */}
            {toolbarSlot && (
              <TableToolbarSlot.Provider value={toolbarSlot}>{fullscreenContent ?? children}</TableToolbarSlot.Provider>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
