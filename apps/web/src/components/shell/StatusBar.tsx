import React, { useEffect, useRef, useState } from "react";
import { useEnv } from "../../contexts/EnvContext";

interface ConnectorStatus {
  name: string;
  ok: boolean;
  error?: string;
}

export default function StatusBar() {
  const { activeEnv } = useEnv();
  const [statuses, setStatuses] = useState<ConnectorStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ idx: number; x: number; y: number } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatuses(await res.json());
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[StatusBar] fetch failed:", msg);
      setError(msg);
    }
  }

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [activeEnv?.key]);

  if (statuses === null) {
    return (
      <div className="status-bar">
        <span className="status-bar-loading">{error ? `⚠ ${error}` : "…"}</span>
      </div>
    );
  }

  return (
    <div className="status-bar">
      {statuses.map((s, i) => (
        <span
          key={s.name}
          className={`status-dot ${s.ok ? "ok" : "err"}`}
          title=""
          onMouseEnter={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setTooltip({ idx: i, x: rect.left, y: rect.top });
          }}
          onMouseLeave={() => setTooltip(null)}
        />
      ))}
      {tooltip !== null && (
        <div
          className="status-tooltip"
          style={{ left: tooltip.x, top: tooltip.y - 8 }}
        >
          {statuses.map((s, i) => (
            <div key={s.name} className="status-tooltip-row">
              <span className={`status-dot ${s.ok ? "ok" : "err"}`} />
              <span className="status-tooltip-name">{s.name}</span>
              {s.error && <span className="status-tooltip-error">{s.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
