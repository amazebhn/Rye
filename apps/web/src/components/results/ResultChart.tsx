import React, { useMemo, useState } from "react";
import { ChartPlot } from "../chat/ChartBlock";
import { CHART_TYPES, MAX_POINTS, MAX_SERIES, defaultChart, numericColumns, plotRows, type ChartRow, type ChartSpec, type ChartType } from "../../utils/chartSpec";

interface Props {
  columns: string[];
  /** In the order the table currently shows them, so sorting the table orders the chart. */
  rows: ChartRow[];
}

const TYPE_LABELS: Record<ChartType, string> = { bar: "Bar", line: "Line", area: "Area", scatter: "Scatter" };

/** Chart any table by picking the columns: one across, up to eight numeric ones as series. */
export default function ResultChart({ columns, rows }: Props) {
  const numeric = useMemo(() => numericColumns(columns, rows), [columns, rows]);
  const initial = useMemo(() => defaultChart(columns, rows), [columns, rows]);
  const [type, setType] = useState<ChartType>("bar");
  const [x, setX] = useState(initial?.x ?? columns[0] ?? "");
  const [y, setY] = useState<string[]>(initial?.y ?? []);
  const [stacked, setStacked] = useState(false);

  // Scatter needs numbers on both axes; the other types take any column across.
  const xChoices = type === "scatter" ? numeric : columns;
  const xColumn = xChoices.includes(x) ? x : xChoices[0] ?? "";
  const series = y.filter((column) => column !== xColumn);

  const spec: ChartSpec = { type, x: xColumn, y: series, droppedSeries: 0, stacked: stacked && type !== "line" && type !== "scatter", horizontal: false };
  const plotted = useMemo(() => plotRows(spec, rows), [type, xColumn, series.join("\u0000"), rows]); // eslint-disable-line react-hooks/exhaustive-deps

  if (numeric.length === 0) {
    return <div className="result-chart-empty">This table has no numeric column to plot.</div>;
  }

  const toggleSeries = (column: string) =>
    setY((current) => (current.includes(column) ? current.filter((c) => c !== column) : current.length < MAX_SERIES ? [...current, column] : current));

  return (
    <div className="result-chart">
      <div className="result-chart-controls">
        <label className="result-data-control">
          <span>Type</span>
          <select value={type} onChange={(event) => setType(event.target.value as ChartType)}>
            {CHART_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="result-data-control">
          <span>Across</span>
          <select value={xColumn} onChange={(event) => setX(event.target.value)}>
            {xChoices.map((column) => <option key={column} value={column}>{column || "(unnamed column)"}</option>)}
          </select>
        </label>
        <div className="result-chart-series" role="group" aria-label="Series to plot">
          <span className="result-chart-series-label">Plot</span>
          {numeric.filter((column) => column !== xColumn).map((column) => {
            const on = series.includes(column);
            return (
              <button
                key={column}
                type="button"
                className="result-data-toggle"
                aria-pressed={on}
                disabled={!on && series.length >= MAX_SERIES}
                onClick={() => toggleSeries(column)}
              >
                {column || "(unnamed column)"}
              </button>
            );
          })}
        </div>
        {(type === "bar" || type === "area") && series.length > 1 && (
          <button type="button" className="result-data-toggle" aria-pressed={stacked} onClick={() => setStacked((value) => !value)}>
            Stacked
          </button>
        )}
      </div>
      <div className="result-chart-body">
        {series.length === 0 ? (
          <div className="result-chart-empty">Pick at least one column to plot.</div>
        ) : plotted.length === 0 ? (
          <div className="result-chart-empty">No rows have a value for "{xColumn}".</div>
        ) : (
          <ChartPlot spec={spec} rows={plotted} height={420} />
        )}
        {rows.length > MAX_POINTS && (
          <div className="chart-block-note">Showing the first {MAX_POINTS.toLocaleString()} of {rows.length.toLocaleString()} rows, in the table's current order.</div>
        )}
      </div>
    </div>
  );
}
