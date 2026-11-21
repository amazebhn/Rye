import React, { useEffect, useRef, useState } from "react";
import { useEnv } from "../../contexts/EnvContext";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";

function envColorClass(key: string): "prod" | "semi" | "qa" {
  const k = key.toLowerCase();
  if (k.includes("prod")) return "prod";
  if (k.includes("semi") || k.includes("staging") || k.includes("stage")) return "semi";
  return "qa";
}

interface Props {
  /** Env key to show; falls back to the global default. */
  value?: string;
  /** Replaces the default global switch when provided. */
  onChange?: (key: string) => void;
}

export default function EnvPicker({ value, onChange }: Props = {}) {
  const { envs, activeEnv, refreshEnvs, switchEnv } = useEnv();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshEnvs();
  }, [refreshEnvs]);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (envs.length <= 1) return null;

  const shownEnv = envs.find((e) => e.key === value) ?? activeEnv;
  const activeKey = shownEnv?.key ?? "default";
  const activeName = shownEnv?.name ?? "Default";
  const colorClass = envColorClass(activeKey);

  return (
    <div className="env-picker" ref={ref}>
      <button
        className="env-picker-btn"
        onClick={() => setOpen((o) => !o)}
        title="Switch environment"
      >
        <span className={`env-dot env-dot--${colorClass}`} />
        <span className="env-picker-label">{activeName}</span>
        <span className="env-picker-caret">{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>

      </button>
      {open && (
        <div className="env-picker-dropdown">
          {envs.map((env) => (
            <button
              key={env.key}
              className={`env-picker-item${env.key === activeKey ? " active" : ""}`}
              onClick={() => { (onChange ?? switchEnv)(env.key); setOpen(false); }}
            >
              <span className={`env-dot env-dot--${envColorClass(env.key)}`} />
              <span className="env-picker-item-name">{env.name}</span>
              {env.overrides.length > 0 && (
                <span className="env-picker-item-overrides">{env.overrides.join(", ")}</span>
              )}
              {env.key === activeKey && <span className="env-picker-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
