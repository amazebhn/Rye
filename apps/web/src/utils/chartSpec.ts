// A chart the agent writes in its reply as a fenced ```chart block holding one JSON object.

export const CHART_TYPES = ["bar", "line", "area", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Categorical colors come in a fixed order; a ninth series would need a made-up hue. */
export const MAX_SERIES = 8;
/** Points drawn; a stored result can be far larger than a chart can show. */
export const MAX_POINTS = 500;

export type ChartRow = Record<string, unknown>;

export interface ChartSpec {
  type: ChartType;
  title?: string;
  x: string;
  y: string[];
  /** Series named in the spec beyond MAX_SERIES, which are not drawn. */
  droppedSeries: number;
  stacked: boolean;
  horizontal: boolean;
  unit?: string;
  data?: ChartRow[];
  resultId?: string;
}

export type ParsedChart = { ok: true; spec: ChartSpec } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function parseChartSpec(source: string): ParsedChart {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: "The chart block is not valid JSON." };
  }
  if (!isRecord(raw)) return { ok: false, error: "The chart block must be one JSON object." };

  const type = text(raw.type)?.toLowerCase();
  if (!type || !(CHART_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `"type" must be one of ${CHART_TYPES.join(", ")}.` };
  }
  const x = text(raw.x);
  if (!x) return { ok: false, error: '"x" must name a column.' };
  const named = (Array.isArray(raw.y) ? raw.y : [raw.y]).flatMap((v) => text(v) ?? []);
  const y = [...new Set(named)];
  if (y.length === 0) return { ok: false, error: '"y" must name at least one column.' };

  const resultId = text(raw.result_id);
  const data = Array.isArray(raw.data) ? raw.data.filter(isRecord) : undefined;
  if (!resultId && (!data || data.length === 0)) {
    return { ok: false, error: 'The chart needs "data" rows or a "result_id".' };
  }
  if (resultId && !/^res_[a-z0-9]{8}$/i.test(resultId)) return { ok: false, error: '"result_id" is not a stored result id.' };

  return {
    ok: true,
    spec: {
      type: type as ChartType,
      title: text(raw.title),
      x,
      y: y.slice(0, MAX_SERIES),
      droppedSeries: Math.max(0, y.length - MAX_SERIES),
      stacked: raw.stacked === true,
      horizontal: raw.horizontal === true && type === "bar",
      unit: text(raw.unit),
      data: resultId ? undefined : data,
      resultId,
    },
  };
}

export const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Columns whose values are (almost) all numbers, so they can be plotted as series. */
export function numericColumns(columns: string[], rows: ChartRow[]): string[] {
  const sample = rows.slice(0, 200);
  return columns.filter((column) => {
    const values = sample.map((row) => row[column]).filter((v) => v !== null && v !== undefined && v !== "");
    return values.length > 0 && values.filter((v) => toNumber(v) !== null).length / values.length >= 0.8;
  });
}

/** A sensible first chart for a table: the first label-like column across, the first numeric column up. */
export function defaultChart(columns: string[], rows: ChartRow[]): { x: string; y: string[] } | null {
  const numeric = numericColumns(columns, rows);
  if (numeric.length === 0) return null;
  const label = columns.find((c) => !numeric.includes(c));
  // All-numeric table: the first column is the axis, the next one the series.
  const x = label ?? numeric[0];
  const y = numeric.filter((c) => c !== x).slice(0, 1);
  return y.length > 0 ? { x, y } : null;
}

/** Rows ready to plot: y columns as numbers (SQL drivers often return them as strings), x as a label or number. */
export function plotRows(spec: ChartSpec, rows: ChartRow[]): ChartRow[] {
  const numericX = spec.type === "scatter";
  return rows.slice(0, MAX_POINTS).flatMap((row) => {
    const xValue = numericX ? toNumber(row[spec.x]) : row[spec.x];
    if (xValue === null || xValue === undefined) return [];
    const out: ChartRow = { [spec.x]: numericX ? xValue : String(xValue) };
    for (const key of spec.y) out[key] = toNumber(row[key]);
    return [out];
  });
}

/** 1,284 stays in full; an axis that reaches 10,000 reads 12.9K, 4.2M. */
export function formatValue(value: number, compact: boolean): string {
  if (!Number.isFinite(value)) return "";
  if (!compact) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
