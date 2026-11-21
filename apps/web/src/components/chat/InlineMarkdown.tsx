import React from "react";

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*/g;

// Inline code and bold only: cheap enough for one-line titles and labels.
export default function InlineMarkdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(m[1] !== undefined ? <code key={at}>{m[1]}</code> : <strong key={at}>{m[2]}</strong>);
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
