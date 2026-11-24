import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * A button that acts only after being held down, for changes that are costly to
 * undo. A fill slides across it while it is held; letting go early cancels.
 * Works with the pointer and with Space or Enter held on the keyboard.
 */
export default function HoldButton({
  children,
  onConfirm,
  holdMs = 1200,
  disabled = false,
  className = "",
}: {
  children: React.ReactNode;
  onConfirm: () => void;
  holdMs?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || timer.current !== null) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onConfirm();
    }, holdMs);
  }, [disabled, holdMs, onConfirm]);

  useEffect(() => cancel, [cancel]);
  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);

  const isHoldKey = (e: React.KeyboardEvent) => e.key === " " || e.key === "Enter";

  return (
    <button
      type="button"
      className={`btn btn--sm hold-btn${holding ? " is-holding" : ""} ${className}`}
      style={{ "--hold-ms": `${holdMs}ms` } as React.CSSProperties}
      disabled={disabled}
      title="Press and hold"
      onPointerDown={(e) => { if (e.button === 0) start(); }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onKeyDown={(e) => { if (isHoldKey(e)) { e.preventDefault(); if (!e.repeat) start(); } }}
      onKeyUp={(e) => { if (isHoldKey(e)) cancel(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="hold-btn-fill" aria-hidden="true" />
      <span className="hold-btn-label">{children}</span>
    </button>
  );
}
