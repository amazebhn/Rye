import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { RefreshCw, BarChart3, AlertCircle } from "lucide-react";
import { formatModelName } from "../../utils/modelNames";

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  cost: number;
  pricedCalls: number;
}

interface DayRow {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
}

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
}

interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
  totalMs: number;
}

interface ContextPoint {
  ts: number;
  sessionId: string;
  model: string;
  contextPct: number;
  inputTokens: number;
  contextWindow: number;
}

interface Summary {
  days: number;
  totals: Totals;
  byDay: DayRow[];
  byModel: ModelRow[];
  byTool: ToolRow[];
  contextTimeline: ContextPoint[];
}

const RANGES = [7, 30, 90];
const SERIES_COLORS = ["#2383e2", "#6f5bd6", "#d97757", "#3ca370", "#c2410c", "#9333ea", "#0891b2"];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="analytics-stat">
      <span className="analytics-stat-label">{label}</span>
      <span className="analytics-stat-value">{value}</span>
      {sub && <span className="analytics-stat-sub">{sub}</span>}
    </div>
  );
}

const AXIS = { stroke: "var(--color-fg-dim)", fontSize: 11 };
const TOOLTIP_STYLE = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--color-fg)",
};

// Recharts widens formatter args to `ValueType | undefined`, so coerce here.
const tokenFormatter = (value: unknown, name: unknown): [string, string] => [
  formatTokens(Number(value) || 0),
  String(name ?? ""),
];

const costFormatter = (value: unknown): string => formatCost(Number(value) || 0);

const contextFormatter = (value: unknown, _name: unknown, entry: unknown): [string, string] => {
  const point = (entry as { payload?: ContextPoint } | undefined)?.payload;
  return [
    `${Number(value) || 0}% (${formatTokens(point?.inputTokens ?? 0)} tokens)`,
    point?.model ? formatModelName(point.model) : "context",
  ];
};

export default function AnalyticsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(range: number) {
    setLoading(true);
    try {
      const res = await fetch(`/usage/summary?days=${range}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(days); }, [days]);

  const dayChart = useMemo(
    () => (data?.byDay ?? []).map((d) => ({ ...d, label: formatDay(d.date) })),
    [data]
  );

  const contextChart = useMemo(
    () =>
      (data?.contextTimeline ?? []).map((p, i) => ({
        ...p,
        idx: i,
        time: new Date(p.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      })),
    [data]
  );

  const hasData = (data?.totals.calls ?? 0) > 0;
  const unpriced = data ? data.totals.calls - data.totals.pricedCalls : 0;

  return (
    <div className="sop-panel">
      <div className="sop-panel-header">
        <h2 className="sop-panel-title">Analytics</h2>
        <div className="sop-panel-toolbar">
          <div className="analytics-range">
            {RANGES.map((r) => (
              <button
                key={r}
                className={`analytics-range-btn${days === r ? " active" : ""}`}
                onClick={() => setDays(r)}
              >
                {r}d
              </button>
            ))}
          </div>
          <div className="sop-toolbar-divider" />
          <button className="icon-btn faint" onClick={() => void load(days)} title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <div className="sop-panel-body">
        {loading && !data && <div className="sop-panel-empty">Loading…</div>}
        {error && <div className="sop-panel-empty">Failed to load usage: {error}</div>}

        {data && !hasData && (
          <div className="sop-panel-zero">
            <BarChart3 size={32} className="sop-panel-zero-icon" />
            <p>No usage recorded yet.</p>
            <p className="sop-panel-zero-sub">
              Token usage is tracked automatically as you chat. Come back after a few conversations.
            </p>
          </div>
        )}

        {data && hasData && (
          <div className="analytics-body">
            <div className="analytics-stats">
              <StatCard label="LLM calls" value={String(data.totals.calls)} />
              <StatCard label="Input tokens" value={formatTokens(data.totals.inputTokens)} />
              <StatCard label="Output tokens" value={formatTokens(data.totals.outputTokens)} />
              <StatCard label="Tool calls" value={String(data.totals.toolCalls)} />
              <StatCard
                label="Est. cost"
                value={formatCost(data.totals.cost)}
                sub={unpriced > 0 ? `${unpriced} call(s) unpriced` : undefined}
              />
            </div>

            {unpriced > 0 && (
              <div className="analytics-note">
                <AlertCircle size={13} />
                <span>
                  {data.totals.pricedCalls === 0
                    ? "No model pricing configured — cost shows $0."
                    : "Some calls have no pricing, so cost is understated."}{" "}
                  Paste a pricing table into chat and ask the agent to save it.
                </span>
              </div>
            )}

            <section className="analytics-section">
              <h3 className="analytics-section-title">Tokens over time</h3>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={dayChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="label" {...AXIS} tickLine={false} />
                  <YAxis {...AXIS} tickLine={false} tickFormatter={formatTokens} width={48} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenFormatter} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="inputTokens" name="Input" stackId="1" stroke={SERIES_COLORS[0]} fill={SERIES_COLORS[0]} fillOpacity={0.25} />
                  <Area type="monotone" dataKey="outputTokens" name="Output" stackId="1" stroke={SERIES_COLORS[1]} fill={SERIES_COLORS[1]} fillOpacity={0.25} />
                </AreaChart>
              </ResponsiveContainer>
            </section>

            <div className="analytics-grid">
              <section className="analytics-section">
                <h3 className="analytics-section-title">Tokens by model</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.byModel} layout="vertical" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                    <XAxis type="number" {...AXIS} tickLine={false} tickFormatter={formatTokens} />
                    <YAxis type="category" dataKey="model" {...AXIS} tickLine={false} width={150} tickFormatter={formatModelName} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenFormatter} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="inputTokens" name="Input" stackId="1" fill={SERIES_COLORS[0]} />
                    <Bar dataKey="outputTokens" name="Output" stackId="1" fill={SERIES_COLORS[1]} />
                  </BarChart>
                </ResponsiveContainer>
              </section>

              <section className="analytics-section">
                <h3 className="analytics-section-title">Cost by model</h3>
                {data.totals.cost > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={data.byModel.filter((m) => m.cost > 0).map((m) => ({ ...m, label: formatModelName(m.model) }))}
                        dataKey="cost"
                        nameKey="label"
                        innerRadius={50}
                        outerRadius={80}
                paddingAngle={2}
                      >
                        {data.byModel.filter((m) => m.cost > 0).map((_, i) => (
                          <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={costFormatter} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="sop-panel-empty">Set model pricing to see cost breakdown.</div>
                )}
              </section>
            </div>

            <section className="analytics-section">
              <h3 className="analytics-section-title">Context window usage</h3>
              <p className="analytics-section-sub">
                Each point is one LLM call. Compaction kicks in around 72%.
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={contextChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" {...AXIS} tickLine={false} minTickGap={40} />
                  <YAxis {...AXIS} tickLine={false} domain={[0, 100]} width={40} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={contextFormatter} />
                  <Line type="monotone" dataKey="contextPct" name="Context used" stroke={SERIES_COLORS[2]} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </section>

            <section className="analytics-section">
              <h3 className="analytics-section-title">Most-used tools</h3>
              <table className="sop-table">
                <tbody>
                  {data.byTool.slice(0, 15).map((t) => (
                    <tr key={t.tool} className="sop-table-row">
                      <td className="sop-table-td" style={{ fontWeight: 600 }}>{t.tool}</td>
                      <td className="sop-table-td" style={{ width: 90 }}>{t.calls} call{t.calls !== 1 ? "s" : ""}</td>
                      <td className="sop-table-td" style={{ width: 110 }}>
                        {(t.totalMs / Math.max(t.calls, 1) / 1000).toFixed(1)}s avg
                      </td>
                      <td className="sop-table-td" style={{ width: 90, color: t.errors > 0 ? "var(--color-danger, #c2410c)" : "var(--color-fg-dim)" }}>
                        {t.errors > 0 ? `${t.errors} error${t.errors !== 1 ? "s" : ""}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
