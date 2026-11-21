/**
 * Operations over stored results — paging, filtering, sorting and aggregation
 * run server-side so the agent pays context only for the answer, not the data.
 */

import { getResult, saveResult, saveTextResult, TEXT_COLUMN, INLINE_ROW_LIMIT, INLINE_CHAR_LIMIT } from "./store.js";
import type { StoredResult } from "./store.js";

export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "is_null" | "not_null";

export interface Filter {
  column: string;
  op: FilterOp;
  value?: unknown;
}

export interface Sort {
  column: string;
  direction?: "asc" | "desc";
}

const PREVIEW_ROWS = 5;
const MAX_CELL = 120;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? "0000-00-00 00:00:00"
      : value.toISOString().replace(/\.\d{3}Z$/, "").replace("T", " ");
  }
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  const clipped = raw.length > MAX_CELL ? `${raw.slice(0, MAX_CELL)}…` : raw;
  return clipped.replace(/\|/g, "\\|");
}

export function formatTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function renderRows(result: StoredResult, rows: Record<string, unknown>[], columns: string[]): string {
  if (result.kind === "text") return rows.map((r) => String(r[TEXT_COLUMN] ?? "")).join("\n");
  return formatTable(columns, rows);
}

/** Should this output be stored by reference rather than inlined? */
export function shouldStore(rowCount: number, rendered: string): boolean {
  return rowCount > INLINE_ROW_LIMIT || rendered.length > INLINE_CHAR_LIMIT;
}

/** Compact summary the agent sees instead of the full data. */
export function formatReference(result: StoredResult): string {
  const total = result.rows.length;
  const preview = result.rows.slice(0, PREVIEW_ROWS);
  const unit = result.kind === "text" ? "line" : "row";

  const lines = [
    `${total.toLocaleString()} ${unit}${total === 1 ? "" : "s"} returned — stored as result \`${result.id}\`.`,
    `The full data is held server-side and shown to the user as a table; it is deliberately NOT in your context.`,
    "",
  ];

  if (result.kind === "table") {
    lines.push(`Columns: ${result.columns.join(", ")}`, "");
  }

  lines.push(
    `First ${Math.min(PREVIEW_ROWS, total)} of ${total.toLocaleString()}:`,
    renderRows(result, preview, result.columns),
    "",
    `To work with the rest WITHOUT loading it all: call result_query_tool (filter/sort/select/page) or ` +
      `result_aggregate_tool (count/sum/avg/min/max, optionally grouped) with result_id="${result.id}". ` +
      `Only request the rows you actually need.`,
    `[rye:result:${result.id}]`
  );

  return lines.join("\n");
}

/** Store output and return a reference, or return it inline when it's small. */
export function storeOrInline(opts: {
  sessionId?: string;
  source: string;
  label: string;
  columns: string[];
  rows: Record<string, unknown>[];
}): string {
  const rendered = formatTable(opts.columns, opts.rows);
  if (!shouldStore(opts.rows.length, rendered)) return rendered;
  const stored = saveResult({ ...opts, kind: "table" });
  return formatReference(stored);
}

/** Same for plain-text tool output such as log dumps or search hits. */
export function storeOrInlineText(source: string, label: string, text: string, sessionId?: string): string {
  const lineCount = text.split("\n").length;
  if (!shouldStore(lineCount, text)) return text;
  return formatReference(saveTextResult(source, label, text, sessionId));
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function matches(row: Record<string, unknown>, filter: Filter): boolean {
  const value = row[filter.column];
  switch (filter.op) {
    case "eq": return String(value) === String(filter.value);
    case "ne": return String(value) !== String(filter.value);
    case "gt": return compare(value, filter.value) > 0;
    case "gte": return compare(value, filter.value) >= 0;
    case "lt": return compare(value, filter.value) < 0;
    case "lte": return compare(value, filter.value) <= 0;
    case "contains": return String(value ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    case "not_contains": return !String(value ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    case "is_null": return value === null || value === undefined;
    case "not_null": return value !== null && value !== undefined;
    default: return true;
  }
}

export function queryResult(args: {
  result_id: string;
  columns?: string[];
  filters?: Filter[];
  sort?: Sort;
  offset?: number;
  limit?: number;
}, sessionId?: string): string {
  const result = getResult(args.result_id, sessionId);
  if (!result) return `No stored result with id "${args.result_id}". It may have expired.`;

  let rows = result.rows;
  for (const filter of args.filters ?? []) {
    if (!result.columns.includes(filter.column)) {
      return `Unknown column "${filter.column}". Available: ${result.columns.join(", ")}.`;
    }
    rows = rows.filter((r) => matches(r, filter));
  }

  if (args.sort) {
    if (!result.columns.includes(args.sort.column)) {
      return `Unknown sort column "${args.sort.column}". Available: ${result.columns.join(", ")}.`;
    }
    const dir = args.sort.direction === "desc" ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * compare(a[args.sort!.column], b[args.sort!.column]));
  }

  const matched = rows.length;
  const offset = Math.max(args.offset ?? 0, 0);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const page = rows.slice(offset, offset + limit);

  const columns = args.columns?.length
    ? args.columns.filter((c) => result.columns.includes(c))
    : result.columns;
  if (columns.length === 0) return `None of the requested columns exist. Available: ${result.columns.join(", ")}.`;

  const shown = page.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
  const end = offset + page.length;
  const header =
    `${matched.toLocaleString()} row(s) matched; showing ${offset + 1}–${end}` +
    (end < matched ? ` (call again with offset=${end} for more)` : "");

  return `${header}\n\n${renderRows(result, shown, columns)}`;
}

export type AggregateOp = "count" | "sum" | "avg" | "min" | "max";

export function aggregateResult(args: {
  result_id: string;
  op: AggregateOp;
  column?: string;
  group_by?: string;
  filters?: Filter[];
  limit?: number;
}, sessionId?: string): string {
  const result = getResult(args.result_id, sessionId);
  if (!result) return `No stored result with id "${args.result_id}". It may have expired.`;

  if (args.op !== "count" && !args.column) return `Column is required for op "${args.op}".`;
  for (const col of [args.column, args.group_by]) {
    if (col && !result.columns.includes(col)) {
      return `Unknown column "${col}". Available: ${result.columns.join(", ")}.`;
    }
  }

  let rows = result.rows;
  for (const filter of args.filters ?? []) {
    rows = rows.filter((r) => matches(r, filter));
  }

  const compute = (group: Record<string, unknown>[]): string => {
    if (args.op === "count") return String(group.length);
    const nums = group
      .map((r) => Number(r[args.column!]))
      .filter((n) => !Number.isNaN(n));
    if (nums.length === 0) return "n/a";
    switch (args.op) {
      case "sum": return String(nums.reduce((a, b) => a + b, 0));
      case "avg": return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4).replace(/\.?0+$/, "");
      case "min": return String(Math.min(...nums));
      case "max": return String(Math.max(...nums));
    }
  };

  const label = args.op === "count" ? "count" : `${args.op}(${args.column})`;

  if (!args.group_by) {
    return `${label} over ${rows.length.toLocaleString()} row(s): ${compute(rows)}`;
  }

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = cell(row[args.group_by]);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const entries = [...groups.entries()]
    .map(([key, group]) => ({ key, value: compute(group) }))
    .sort((a, b) => compare(b.value, a.value))
    .slice(0, limit);

  const body = formatTable(
    [args.group_by, label],
    entries.map((e) => ({ [args.group_by!]: e.key, [label]: e.value }))
  );
  return `${groups.size.toLocaleString()} group(s)${groups.size > limit ? `, showing top ${limit}` : ""}:\n\n${body}`;
}
