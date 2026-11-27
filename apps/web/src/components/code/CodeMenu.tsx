import React, { useCallback, useEffect, useRef, useState } from "react";

const ITEMS = "[role=menuitem]:not(:disabled), [role=menuitemradio]:not(:disabled)";

/**
 * A small menu in the app's menu style (`.sidebar-dropdown`), anchored under its trigger: a ⋯ on a file
 * or a list, the branch chip's details. Closes on a click outside, Escape (taken, so a floating panel
 * around it stays open) or a choice; arrow keys move between items.
 */
export default function CodeMenu({
  label,
  title,
  trigger,
  triggerClassName = "artifacts-icon-btn",
  menuClassName = "",
  align = "right",
  children,
}: {
  label: string;
  title?: string;
  trigger: React.ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
  align?: "left" | "right";
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const menu = rootRef.current?.querySelector<HTMLElement>("[role=menu]");
    menu?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
      items[next].focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="code-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`${triggerClassName}${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
      >
        {trigger}
      </button>
      {open && (
        <div className={`sidebar-dropdown code-menu-pop code-menu-pop--${align} ${menuClassName}`} role="menu" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
