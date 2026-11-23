import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, Table2 } from "lucide-react";
import { MAX_POINTS, formatValue, parseChartSpec, plotRows, type ChartRow, type ChartSpec } from "../../utils/chartSpec";

/** The chat session a reply belongs to, so a chart can load a stored result (res_…) by id. */
export const ChartSessionContext = createContext<string>("");

// Fixed order, never cycled: a series keeps its color whatever else is plotted. Values live in tokens.css.
const SERIES = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);
const AXIS = { stroke: "var(--main-border)", tick: { fill: "var(--main-fg-muted)", fontSize: 11 }, tickLine: false } as const;
const TOOLTIP_STYLE: React.CSSProperties = {
  background: "var(--main-bg)",
  border: "1px solid var(--main-border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 12,
  color: "var(--main-fg)",
};
const HEIGHT = 280;

function useRows(spec: ChartSpec, sessionId: string): { rows: ChartRow[] | null; total: number; error: string | null } {
  const [loaded, setLoaded] = useState<{ rows: ChartRow[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!spec.resultId) return;
    let cancelled = false;
    setLoaded(null);
    void fetch(`/result/${spec.resultId}?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "That result has expired, so the chart can't be drawn." : `Couldn't load the result (HTTP ${r.status}).`);
        return r.json() as Promise<{ rows?: ChartRow[] }>;
      })
      .then((d) => { if (!cancelled) setLoaded({ rows: d.rows ?? [], error: null }); })
      .catch((e) => { if (!cancelled) setLoaded({ rows: [], error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [spec.resultId, sessionId]);

  if (!spec.resultId) return { rows: spec.data ?? [], total: spec.data?.length ?? 0, error: null };
  return { rows: loaded && !loaded.error ? loaded.rows : null, total: loaded?.rows.length ?? 0, error: loaded?.error ?? null };
}

function Plot({ spec, rows }: { spec: ChartSpec; rows: ChartRow[] }) {
  const compact = useMemo(
    () => rows.some((row) => spec.y.some((key) => Math.abs(Number(row[key] ?? 0)) >= 10_000)),
    [rows, spec.y],
  );
  const unit = spec.unit ? ` ${spec.unit}` : "";
  const tick = (v: number) => formatValue(v, compact);
  const tooltip = (
    <Tooltip
      contentStyle={TOOLTIP_STYLE}
      cursor={{ stroke: "var(--main-border)", fill: "var(--main-surface)" }}
      formatter={(value) => `${formatValue(Number(value), false)}${unit}`}
    />
  );
  // One series is named by the title; a legend with a single swatch would only repeat it.
  // The swatch carries the series color; the name stays in text color, in the order the series were given.
  const legend =
    spec.y.length > 1 ? (
      <Legend
        iconType="circle"
        iconSize={8}
        itemSorter={null}
        wrapperStyle={{ fontSize: 12 }}
        formatter={(name) => <span style={{ color: "var(--main-fg-muted)" }}>{name}</span>}
      />
    ) : null;
  const margin = { top: 8, right: 12, left: 0, bottom: 0 };
  const stackId = spec.stacked ? "stack" : undefined;
  const valueAxis = <YAxis {...AXIS} axisLine={false} tickFormatter={tick} width={52} />;
  const categoryAxis = <XAxis dataKey={spec.x} {...AXIS} minTickGap={24} />;

  if (spec.type === "bar" && spec.horizontal) {
    return (
      <BarChart data={rows} layout="vertical" margin={margin} barGap={2}>
        <CartesianGrid stroke="var(--main-border)" horizontal={false} />
        <XAxis type="number" {...AXIS} axisLine={false} tickFormatter={tick} />
        <YAxis type="category" dataKey={spec.x} {...AXIS} width={120} />
        {tooltip}
        {legend}
        {spec.y.map((key, i) => (
          <Bar key={key} isAnimationActive={false} dataKey={key} stackId={stackId} fill={SERIES[i]} maxBarSize={24} radius={spec.stacked ? 0 : [0, 4, 4, 0]} stroke="var(--main-bg)" strokeWidth={spec.stacked ? 2 : 0} />
        ))}
      </BarChart>
    );
  }
  if (spec.type === "bar") {
    return (
      <BarChart data={rows} margin={margin} barGap={2}>
        <CartesianGrid stroke="var(--main-border)" vertical={false} />
        {categoryAxis}
        {valueAxis}
        {tooltip}
        {legend}
        {spec.y.map((key, i) => (
          <Bar key={key} isAnimationActive={false} dataKey={key} stackId={stackId} fill={SERIES[i]} maxBarSize={24} radius={spec.stacked ? 0 : [4, 4, 0, 0]} stroke="var(--main-bg)" strokeWidth={spec.stacked ? 2 : 0} />
        ))}
      </BarChart>
    );
  }
  if (spec.type === "area") {
    return (
      <AreaChart data={rows} margin={margin}>
        <CartesianGrid stroke="var(--main-border)" vertical={false} />
        {categoryAxis}
        {valueAxis}
        {tooltip}
        {legend}
        {spec.y.map((key, i) => (
          <Area key={key} isAnimationActive={false} type="monotone" dataKey={key} stackId={stackId} stroke={SERIES[i]} strokeWidth={2} fill={SERIES[i]} fillOpacity={spec.stacked ? 0.35 : 0.1} connectNulls />
        ))}
      </AreaChart>
    );
  }
  if (spec.type === "scatter") {
    return (
      <ScatterChart margin={margin}>
        <CartesianGrid stroke="var(--main-border)" />
        <XAxis type="number" dataKey={spec.x} name={spec.x} {...AXIS} tickFormatter={(v: number) => formatValue(v, Math.abs(v) >= 10_000)} />
        <YAxis type="number" {...AXIS} axisLine={false} tickFormatter={tick} width={52} />
        {tooltip}
        {legend}
        {spec.y.map((key, i) => (
          <Scatter key={key} isAnimationActive={false} name={key} data={rows.filter((row) => row[key] !== null)} dataKey={key} fill={SERIES[i]} stroke="var(--main-bg)" strokeWidth={2} />
        ))}
      </ScatterChart>
    );
  }
  return (
    <LineChart data={rows} margin={margin}>
      <CartesianGrid stroke="var(--main-border)" vertical={false} />
      {categoryAxis}
      {valueAxis}
      {tooltip}
      {legend}
      {spec.y.map((key, i) => (
        <Line key={key} isAnimationActive={false} type="monotone" dataKey={key} stroke={SERIES[i]} strokeWidth={2} dot={rows.length <= 24 ? { r: 3, strokeWidth: 0, fill: SERIES[i] } : false} activeDot={{ r: 4, stroke: "var(--main-bg)", strokeWidth: 2 }} connectNulls />
      ))}
    </LineChart>
  );
}

/** The drawn chart on its own, for places that supply their own frame and controls. */
export function ChartPlot({ spec, rows, height = HEIGHT }: { spec: ChartSpec; rows: ChartRow[]; height?: number }) {
  const plotHeight = spec.horizontal ? Math.max(height, rows.length * (spec.stacked ? 30 : 14 + spec.y.length * 16)) : height;
  return (
    <div className="chart-block-plot" style={{ height: plotHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <Plot spec={spec} rows={rows} />
      </ResponsiveContainer>
    </div>
  );
}

function DataTable({ spec, rows }: { spec: ChartSpec; rows: ChartRow[] }) {
  const columns = [spec.x, ...spec.y];
  return (
    <div className="chart-block-table">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{typeof row[c] === "number" ? formatValue(row[c] as number, false) : String(row[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ChartBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseChartSpec(source), [source]);
  if (!parsed.ok) return <ChartFallback source={source} error={parsed.error} />;
  return <ChartFigure spec={parsed.spec} />;
}

// While a reply streams the JSON is incomplete; show a quiet placeholder instead of flashing the raw text.
function ChartFallback({ source, error }: { source: string; error: string }) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), 1500);
    return () => window.clearTimeout(timer);
  }, [source]);
  if (!settled) return <div className="chart-block chart-block--pending">Drawing chart…</div>;
  return (
    <div className="chart-block">
      <div className="chart-block-note">Couldn't draw this chart. {error}</div>
      <pre><code>{source}</code></pre>
    </div>
  );
}

function ChartFigure({ spec }: { spec: ChartSpec }) {
  const sessionId = useContext(ChartSessionContext);
  const { rows: sourceRows, total, error } = useRows(spec, sessionId);
  const [view, setView] = useState<"chart" | "table">("chart");
  const rows = useMemo(() => (sourceRows ? plotRows(spec, sourceRows) : []), [spec, sourceRows]);

  const notes: string[] = [];
  if (total > MAX_POINTS) notes.push(`Showing the first ${MAX_POINTS.toLocaleString()} of ${total.toLocaleString()} rows.`);
  if (spec.droppedSeries > 0) notes.push(`${spec.droppedSeries} more series not shown; a chart holds 8 at most.`);

  return (
    <figure className="chart-block">
      <figcaption className="chart-block-head">
        <span className="chart-block-title">{spec.title ?? spec.y.join(", ")}</span>
        <span className="chart-block-toggle" role="group" aria-label="View">
          <button type="button" className={view === "chart" ? "is-active" : ""} aria-pressed={view === "chart"} aria-label="Chart" onClick={() => setView("chart")} title="Chart">
            <BarChart3 size={13} aria-hidden="true" />
          </button>
          <button type="button" className={view === "table" ? "is-active" : ""} aria-pressed={view === "table"} aria-label="Table" onClick={() => setView("table")} title="Table">
            <Table2 size={13} aria-hidden="true" />
          </button>
        </span>
      </figcaption>
      {error ? (
        <div className="chart-block-note">{error}</div>
      ) : sourceRows === null ? (
        <div className="chart-block-note">Loading data…</div>
      ) : rows.length === 0 ? (
        <div className="chart-block-note">No rows have a value for "{spec.x}", so there is nothing to plot.</div>
      ) : view === "table" ? (
        <DataTable spec={spec} rows={rows} />
      ) : (
        <ChartPlot spec={spec} rows={rows} />
      )}
      {notes.length > 0 && <div className="chart-block-note">{notes.join(" ")}</div>}
    </figure>
  );
}
