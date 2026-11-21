import React, { useId } from "react";

interface Props {
  size?: number;
  className?: string;
}

/** Rye's AI mark: a curved four-point spark with a smaller companion, gradient-filled. */
export default function AiMark({ size = 16, className }: Props) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="3" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="0.55" stopColor="#6366f1" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M11 2c.7 5 3.3 7.6 8 9-4.7 1.4-7.3 4-8 9-.7-5-3.3-7.6-8-9 4.7-1.4 7.3-4 8-9z"
      />
      <path
        fill={`url(#${gradientId})`}
        opacity="0.85"
        d="M19.5 15.5c.3 1.6 1 2.4 2.5 3-1.5.6-2.2 1.4-2.5 3-.3-1.6-1-2.4-2.5-3 1.5-.6 2.2-1.4 2.5-3z"
      />
    </svg>
  );
}
