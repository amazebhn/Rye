import React, { useEffect, useRef } from "react";
import type { AgentAvatar as AgentAvatarType, AgentRecord } from "../../utils/types";

export const AGENT_GRADIENTS: ReadonlyArray<{ id: string; label: string; css: string }> = [
  { id: "sunset", label: "Sunset", css: "linear-gradient(135deg, #f97316, #ec4899)" },
  { id: "ocean", label: "Ocean", css: "linear-gradient(135deg, #0ea5e9, #6366f1)" },
  { id: "emerald", label: "Emerald", css: "linear-gradient(135deg, #10b981, #0d9488)" },
  { id: "violet", label: "Violet", css: "linear-gradient(135deg, #8b5cf6, #d946ef)" },
  { id: "amber", label: "Amber", css: "linear-gradient(135deg, #f59e0b, #ef4444)" },
  { id: "rose", label: "Rose", css: "linear-gradient(135deg, #fb7185, #be123c)" },
  { id: "cyan", label: "Cyan", css: "linear-gradient(135deg, #06b6d4, #3b82f6)" },
  { id: "slate", label: "Slate", css: "linear-gradient(135deg, #64748b, #334155)" },
];

const GRADIENT_MAP = new Map(AGENT_GRADIENTS.map((g) => [g.id, g.css]));

export function resolveGradientCss(value: string): string {
  if (GRADIENT_MAP.has(value)) return GRADIENT_MAP.get(value)!;
  if (value.includes("gradient(")) return value;
  return AGENT_GRADIENTS[0].css;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export const TOOL_GROUP_LABELS: Record<string, string> = {
  mysql: "MySQL",
  aws: "AWS",
  jira: "Jira",
  git: "Git",
  code_search: "Code Search",
  results: "Results",
  artifacts: "Artifacts",
  sop_authoring: "SOPs",
  skills: "Skills",
};

export function formatToolGroup(id: string): string {
  return TOOL_GROUP_LABELS[id] ?? id.replace(/^mcp:/, "MCP: ").replace(/_/g, " ");
}

/** Draws frame 0 of an image once onto a small canvas so animated GIFs/WebPs stay completely static. */
function StaticImageWash({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);

  return <canvas ref={canvasRef} width={32} height={32} className="agent-banner-img" />;
}

/** Shared banner backdrop: uses the agent's gradient, or a static color wash sampled from their profile image. */
export function AgentBanner({
  agent,
  className,
}: {
  agent: Pick<AgentRecord, "avatar">;
  className?: string;
}) {
  if (agent.avatar.kind === "image" && agent.avatar.value) {
    return (
      <div className={`agent-banner ${className ?? ""}`} aria-hidden="true">
        <StaticImageWash src={agent.avatar.value} />
        <div className="agent-banner-scrim" />
      </div>
    );
  }
  return (
    <div
      className={`agent-banner ${className ?? ""}`}
      style={{ background: resolveGradientCss(agent.avatar.value) }}
      aria-hidden="true"
    />
  );
}

const SIZES = {
  xs: { box: 16, font: 8.5 },
  sm: { box: 20, font: 9.5 },
  md: { box: 28, font: 11.5 },
  lg: { box: 42, font: 15 },
  xl: { box: 54, font: 19 },
  /** The empty-chat greeting, in place of the AI mark orb (same 78px). */
  hero: { box: 96, font: 32 },
} as const;

interface Props {
  agent?: Pick<AgentRecord, "name" | "avatar">;
  avatar?: AgentAvatarType;
  name?: string;
  size?: keyof typeof SIZES;
  className?: string;
  /** Suppress the native browser title tooltip (e.g. when wrapped in AgentHoverCard). */
  hideTooltip?: boolean;
}

export default function AgentAvatar({ agent, avatar, name, size = "sm", className, hideTooltip }: Props) {
  const resolvedAvatar = avatar ?? agent?.avatar ?? { kind: "gradient", value: "sunset" };
  const resolvedName = name ?? agent?.name ?? "Agent";
  const dims = SIZES[size];
  const titleAttr = hideTooltip ? undefined : resolvedName;

  const baseStyle: React.CSSProperties = {
    width: dims.box,
    height: dims.box,
    minWidth: dims.box,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
    userSelect: "none",
  };

  if (resolvedAvatar.kind === "image" && resolvedAvatar.value) {
    return (
      <span className={className} style={baseStyle} title={titleAttr}>
        <img
          src={resolvedAvatar.value}
          alt={resolvedName}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </span>
    );
  }

  return (
    <span
      className={className}
      title={titleAttr}
      style={{
        ...baseStyle,
        background: resolveGradientCss(resolvedAvatar.value),
        color: "#fff",
        fontSize: dims.font,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
      }}
    >
      {initialsFor(resolvedName)}
    </span>
  );
}
