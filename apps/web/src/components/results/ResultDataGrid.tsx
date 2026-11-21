import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ChevronsUpDown, Copy } from "lucide-react";

type SortDirection = "asc" | "desc";
type TimeZoneMode = "local" | "UTC";
type CellKind = "null" | "number" | "boolean" | "date" | "json" | "text";

interface SortState {
  column: string;
  direction: SortDirection;
}

interface IndexedRow {
  row: Record<string, unknown>;
  originalIndex: number;
}

interface SelectedCell {
  originalIndex: number;
  rowIndex: number;
  column: string;
}

interface ResultDataGridProps {
  columns: string[];
  rows: Record<string, unknown>[];
  pageSize?: number;
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const DATE_COLUMN_NAME = /(^|_)(date|time|timestamp|created|updated|modified)(_|$)|_at$/i;
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function epochMilliseconds(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value >= 1_000_000_000 && value < 100_000_000_000) return value * 1000;
  if (value >= 100_000_000_000 && value < 100_000_000_000_000) return value;
  return null;
}

function parseDate(value: unknown, column: string): Date | null {
  let milliseconds: number | null = null;
  if (typeof value === "string" && ISO_DATE_ONLY.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    milliseconds = Date.UTC(year, month - 1, day);
  } else if (typeof value === "string" && ISO_DATE_TIME.test(value)) {
    const normalized = value
      .replace(" ", "T")
      .replace(/(\.\d{3})\d+/, "$1")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
      .replace(/([+-]\d{2})$/, "$1:00");
    milliseconds = Date.parse(normalized);
  } else if (typeof value === "number" && DATE_COLUMN_NAME.test(column)) {
    milliseconds = epochMilliseconds(value);
  }
  if (milliseconds === null || Number.isNaN(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferDateColumns(columns: string[], rows: Record<string, unknown>[]): Set<string> {
  const inferred = new Set<string>();
  for (const column of columns) {
    const values = rows
      .slice(0, 200)
      .map((row) => row[column])
      .filter((value) => value !== null && value !== undefined && value !== "")
      .slice(0, 40);
    if (values.length === 0) continue;
    const parsed = values.filter((value) => parseDate(value, column) !== null).length;
    if (parsed / values.length >= 0.8) inferred.add(column);
  }
  return inferred;
}

function cellKind(value: unknown, column: string, dateColumns: Set<string>): CellKind {
  // TODO(Kev-4b): classify semantic statuses (true/false/fail/success and domain-specific
  // equivalents) server-side, then render accessible background colors with a legend.
  if (value === null || value === undefined || value === "") return "null";
  if (dateColumns.has(column) && parseDate(value, column)) return "date";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "json";
  return "text";
}

function formatDate(value: unknown, column: string, timeZone: TimeZoneMode): string {
  const raw = cellText(value);
  if (typeof value === "string" && ISO_DATE_ONLY.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const key = "date-only";
    let formatter = dateFormatterCache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        timeZone: "UTC",
      });
      dateFormatterCache.set(key, formatter);
    }
    return formatter.format(new Date(Date.UTC(year, month - 1, day)));
  }
  const date = parseDate(value, column);
  if (!date) return raw;
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      ...(timeZone === "UTC" ? { timeZone: "UTC" } : {}),
    });
    dateFormatterCache.set(timeZone, formatter);
  }
  return formatter.format(date);
}

function displayValue(
  value: unknown,
  column: string,
  dateColumns: Set<string>,
  timeZone: TimeZoneMode,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (dateColumns.has(column)) return formatDate(value, column, timeZone);
  return cellText(value);
}

function compareValues(
  left: unknown,
  right: unknown,
  column: string,
  dateColumns: Set<string>,
): number {
  const leftEmpty = left === null || left === undefined || left === "";
  const rightEmpty = right === null || right === undefined || right === "";
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;

  if (dateColumns.has(column)) {
    const leftDate = parseDate(left, column)?.getTime();
    const rightDate = parseDate(right, column)?.getTime();
    if (leftDate !== undefined && rightDate !== undefined) return leftDate - rightDate;
  }
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return cellText(left).localeCompare(cellText(right), undefined, { numeric: true, sensitivity: "base" });
}

export default function ResultDataGrid({ columns, rows, pageSize = 500 }: ResultDataGridProps) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [timeZone, setTimeZone] = useState<TimeZoneMode>("local");
  const [striped, setStriped] = useState(true);
  const [visible, setVisible] = useState(pageSize);
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number>();

  const localTimeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Browser local",
    [],
  );
  const dateColumns = useMemo(() => inferDateColumns(columns, rows), [columns, rows]);

  const sortedRows = useMemo<IndexedRow[]>(() => {
    const indexed = rows.map((row, originalIndex) => ({ row, originalIndex }));
    if (!sort) return indexed;
    return indexed.sort((left, right) => {
      const leftValue = left.row[sort.column];
      const rightValue = right.row[sort.column];
      const leftEmpty = leftValue === null || leftValue === undefined || leftValue === "";
      const rightEmpty = rightValue === null || rightValue === undefined || rightValue === "";
      if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? left.originalIndex - right.originalIndex : leftEmpty ? 1 : -1;
      const comparison = compareValues(
        leftValue,
        rightValue,
        sort.column,
        dateColumns,
      );
      if (comparison === 0) return left.originalIndex - right.originalIndex;
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [dateColumns, rows, sort]);

  const groups = useMemo(() => {
    if (groupBy === null) return [{ key: "", label: "", rows: sortedRows }];
    const grouped = new Map<string, { key: string; label: string; rows: IndexedRow[] }>();
    for (const indexedRow of sortedRows) {
      const value = indexedRow.row[groupBy];
      const key = `${typeof value}:${cellText(value)}`;
      let group = grouped.get(key);
      if (!group) {
        group = {
          key,
          label: displayValue(value, groupBy, dateColumns, timeZone),
          rows: [],
        };
        grouped.set(key, group);
      }
      group.rows.push(indexedRow);
    }
    return [...grouped.values()];
  }, [dateColumns, groupBy, sortedRows, timeZone]);

  const visibleGroups = useMemo(() => {
    let remaining = visible;
    let gridRowIndex = 0;
    const rendered: Array<Omit<(typeof groups)[number], "rows"> & {
      rows: Array<IndexedRow & { gridRowIndex: number }>;
      totalCount: number;
      collapsed: boolean;
    }> = [];
    for (const group of groups) {
      const collapsed = groupBy !== null && collapsedGroups.has(group.key);
      const beyondPage = remaining <= 0 && !collapsed;
      const groupRows = collapsed
        ? []
        : group.rows.slice(0, remaining).map((indexedRow) => ({
            ...indexedRow,
            gridRowIndex: gridRowIndex++,
          }));
      remaining -= groupRows.length;
      rendered.push({
        ...group,
        rows: groupRows,
        totalCount: group.rows.length,
        collapsed,
      });
      if (beyondPage) break;
    }
    return rendered;
  }, [collapsedGroups, groupBy, groups, visible]);

  const selectedDetails = useMemo(() => {
    if (!selected) return null;
    const value = rows[selected.originalIndex]?.[selected.column];
    return {
      raw: cellText(value),
      display: displayValue(value, selected.column, dateColumns, timeZone),
      kind: cellKind(value, selected.column, dateColumns),
    };
  }, [dateColumns, rows, selected, timeZone]);

  useEffect(() => { setVisible(pageSize); }, [pageSize]);

  useEffect(() => () => {
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
  }, []);

  function toggleSort(column: string) {
    setVisible(pageSize);
    setSelected(null);
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: "asc" };
      if (current.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  }

  function clearSort() {
    setVisible(pageSize);
    setSelected(null);
    setSort(null);
  }

  function changeGroup(value: string) {
    setVisible(pageSize);
    setSelected(null);
    setCollapsedGroups(new Set());
    const columnIndex = Number(value);
    setGroupBy(Number.isInteger(columnIndex) && columnIndex >= 0 ? columns[columnIndex] ?? null : null);
  }

  function toggleGroup(key: string) {
    setSelected(null);
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function focusCell(target: HTMLTableCellElement, rowIndex: number, columnIndex: number) {
    const table = target.closest("table");
    table?.querySelector<HTMLTableCellElement>(
      `[data-grid-row="${rowIndex}"][data-grid-column="${columnIndex}"]`,
    )?.focus();
  }

  function handleCellKey(
    event: React.KeyboardEvent<HTMLTableCellElement>,
    rowIndex: number,
    columnIndex: number,
  ) {
    const movement: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    focusCell(event.currentTarget, rowIndex + delta[0], columnIndex + delta[1]);
  }

  async function copySelectedValue() {
    if (!selectedDetails) return;
    await navigator.clipboard.writeText(selectedDetails.raw);
    setCopied(true);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
  }

  const expandedRowCount = groups.reduce(
    (total, group) => total + (collapsedGroups.has(group.key) ? 0 : group.rows.length),
    0,
  );
  const shownRows = Math.min(visible, expandedRowCount);
  const remainingRows = expandedRowCount - shownRows;
  const ariaRowCount = rows.length + 1 + (groupBy === null ? 0 : groups.length);

  return (
    <div className={`result-data-grid${striped ? " is-striped" : ""}`}>
      <div className="result-data-toolbar" aria-label="Table display controls">
        <span className="result-data-summary">
          {rows.length.toLocaleString()} rows · {columns.length.toLocaleString()} columns
        </span>
        <label className="result-data-control">
          <span>Group</span>
          <select
            value={groupBy === null ? "-1" : String(columns.indexOf(groupBy))}
            onChange={(event) => changeGroup(event.target.value)}
          >
            <option value="-1">None</option>
            {columns.map((column, index) => <option key={`${column}:${index}`} value={index}>{column || "(unnamed column)"}</option>)}
          </select>
        </label>
        {dateColumns.size > 0 && (
          <label className="result-data-control">
            <span>Time zone</span>
            <select value={timeZone} onChange={(event) => setTimeZone(event.target.value as TimeZoneMode)}>
              <option value="local">Local · {localTimeZone}</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
        )}
        <button
          type="button"
          className="result-data-toggle"
          aria-pressed={striped}
          onClick={() => setStriped((value) => !value)}
        >
          Stripes
        </button>
        {sort && (
          <button type="button" className="result-data-sort-clear" onClick={clearSort}>
            Clear sort
          </button>
        )}
      </div>

      <div className="result-data-grid-scroll">
        <table className="result-table-grid" role="grid" aria-rowcount={ariaRowCount} aria-colcount={columns.length + 1}>
          <thead>
            <tr>
              <th className="result-data-row-number result-data-corner" aria-label="Row number">#</th>
              {columns.map((column) => {
                const activeSort = sort?.column === column ? sort.direction : null;
                return (
                  <th
                    key={column}
                    aria-sort={activeSort === "asc" ? "ascending" : activeSort === "desc" ? "descending" : "none"}
                  >
                    <button
                      type="button"
                      className={`result-data-sort${activeSort ? " active" : ""}`}
                      onClick={() => toggleSort(column)}
                      title={`Sort by ${column}`}
                    >
                      <span>{column}</span>
                      {activeSort === "asc" ? <ArrowUp size={12} /> : activeSort === "desc" ? <ArrowDown size={12} /> : <ChevronsUpDown size={12} />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleGroups.map((group) => (
              <React.Fragment key={group.key || "all"}>
                {groupBy !== null && (
                  <tr className="result-data-group-row">
                    <td colSpan={columns.length + 1}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        aria-expanded={!group.collapsed}
                      >
                        {group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <strong>{group.label}</strong>
                        <span>{group.totalCount.toLocaleString()} {group.totalCount === 1 ? "row" : "rows"}</span>
                      </button>
                    </td>
                  </tr>
                )}
                {group.rows.map(({ row, originalIndex, gridRowIndex }) => (
                  <tr key={originalIndex} className={gridRowIndex % 2 === 1 ? "is-odd" : ""}>
                    <th className="result-data-row-number" scope="row">{gridRowIndex + 1}</th>
                    {columns.map((column, columnIndex) => {
                      const value = row[column];
                      const kind = cellKind(value, column, dateColumns);
                      const isSelected = selected?.originalIndex === originalIndex && selected.column === column;
                      const isInitial = !selected && gridRowIndex === 0 && columnIndex === 0;
                      return (
                        <td
                          key={column}
                          className={`result-data-cell result-data-cell--${kind}${isSelected ? " is-selected" : ""}`}
                          data-grid-row={gridRowIndex}
                          data-grid-column={columnIndex}
                          tabIndex={isSelected || isInitial ? 0 : -1}
                          onFocus={() => setSelected({ originalIndex, rowIndex: gridRowIndex, column })}
                          onClick={(event) => event.currentTarget.focus()}
                          onKeyDown={(event) => handleCellKey(event, gridRowIndex, columnIndex)}
                        >
                          {displayValue(value, column, dateColumns, timeZone)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>

        {remainingRows > 0 && (
          <button
            type="button"
            className="result-table-more result-table-more--fullscreen"
            onClick={() => setVisible((value) => value + pageSize)}
          >
            Show {Math.min(pageSize, remainingRows).toLocaleString()} more
            <span className="result-table-more-sub"> ({remainingRows.toLocaleString()} remaining)</span>
          </button>
        )}
      </div>

      {selected && selectedDetails && (
        <aside className="result-data-inspector" aria-live="polite">
          <div className="result-data-inspector-meta">
            <strong>Row {selected.rowIndex + 1}</strong>
            <span>{selected.column}</span>
            <span>{selectedDetails.kind}</span>
          </div>
          <pre>{selectedDetails.display}</pre>
          {selectedDetails.display !== selectedDetails.raw && (
            <code className="result-data-inspector-raw">Raw · {selectedDetails.raw}</code>
          )}
          <button
            type="button"
            className="result-data-copy-cell"
            onClick={() => void copySelectedValue()}
            title="Copy raw cell value"
            aria-label="Copy raw cell value"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </aside>
      )}
    </div>
  );
}
