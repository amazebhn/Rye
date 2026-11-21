import React, { useLayoutEffect, useRef, useState } from "react";

// Matches the grid-template-rows transition in base.css, plus slack for a missed transitionend.
const FALLBACK_MS = 450;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Animates height open and closed. Children mount on open and unmount once
 * the close transition ends, so collapsed content costs nothing to render.
 */
export default function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  // Overflow is clipped only while animating, so focus rings and popovers aren't cut off at rest.
  const [settled, setSettled] = useState(open);
  const firstRender = useRef(true);

  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setSettled(false);
    if (prefersReducedMotion()) {
      setMounted(open);
      setExpanded(open);
      setSettled(open);
      return;
    }
    const done = () => (open ? setSettled(true) : setMounted(false));
    const fallback = window.setTimeout(done, FALLBACK_MS);
    let raf = 0;
    if (open) {
      setMounted(true);
      // Paint the 0-height frame first so the transition has a start value.
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => setExpanded(true));
      });
    } else {
      setExpanded(false);
    }
    return () => {
      window.clearTimeout(fallback);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={`collapse${expanded ? " open" : ""}${settled ? " settled" : ""}`}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== "grid-template-rows") return;
        if (open) setSettled(true);
        else setMounted(false);
      }}
    >
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
