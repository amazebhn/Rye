import React, { cloneElement, isValidElement, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

type Cell = React.ReactElement<{ children?: React.ReactNode; style?: React.CSSProperties; className?: string }>;
type Row = React.ReactElement<{ children?: React.ReactNode }>;

const elements = <T extends React.ReactElement>(node: React.ReactNode): T[] =>
  React.Children.toArray(node).filter((child): child is T => isValidElement(child));

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/**
 * The number in a cell as people write them in tables: "1,284", "$4.2", "38%", "620 ms", "-3.5".
 * Null for anything that isn't a single number with an optional currency sign or short unit.
 */
export function looseNumber(text: string): number | null {
  const match = /^([-+−]?)\s*[$€£]?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:%|[a-zA-Zµ/]{1,5})?$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return match[1] === "-" || match[1] === "−" ? -value : value;
}

/** Columns where nearly every filled cell is a number: these are right-aligned and sorted by value. */
export function numericColumnFlags(rows: string[][], columnCount: number): boolean[] {
  return Array.from({ length: columnCount }, (_, column) => {
    const filled = rows.map((row) => row[column] ?? "").filter((text) => text.trim() && text.trim() !== "-" && text.trim() !== "—");
    return filled.length > 0 && filled.filter((text) => looseNumber(text) !== null).length / filled.length >= 0.8;
  });
}

interface Sort {
  column: number;
  direction: "asc" | "desc";
}

interface Props {
  /** What react-markdown rendered inside <table>: a thead and a tbody. */
  children: React.ReactNode;
  tableRef: React.RefObject<HTMLTableElement>;
}

/** A table in a reply: click a column heading to sort; number columns line up on the right. */
export default function MarkdownTable({ children, tableRef }: Props) {
  const [sort, setSort] = useState<Sort | null>(null);

  const { headCells, rows } = useMemo(() => {
    const sections = elements<React.ReactElement<{ children?: React.ReactNode }>>(children);
    const head = sections.find((section) => section.type === "thead");
    const body = sections.find((section) => section.type === "tbody");
    const headRow = head ? elements<Row>(head.props.children)[0] : undefined;
    return {
      headCells: headRow ? elements<Cell>(headRow.props.children) : [],
      rows: (body ? elements<Row>(body.props.children) : []).map((row, index) => {
        const cells = elements<Cell>(row.props.children);
        return { index, cells, text: cells.map((cell) => textOf(cell.props.children)) };
      }),
    };
  }, [children]);

  const numeric = useMemo(() => numericColumnFlags(rows.map((row) => row.text), headCells.length), [rows, headCells.length]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { column, direction } = sort;
    return [...rows].sort((a, b) => {
      const left = a.text[column]?.trim() ?? "";
      const right = b.text[column]?.trim() ?? "";
      // Empty cells stay at the bottom whichever way the column is sorted.
      if (!left || !right) return left === right ? a.index - b.index : left ? -1 : 1;
      const leftNumber = numeric[column] ? looseNumber(left) : null;
      const rightNumber = numeric[column] ? looseNumber(right) : null;
      const order =
        leftNumber !== null && rightNumber !== null
          ? leftNumber - rightNumber
          : left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
      return order === 0 ? a.index - b.index : direction === "asc" ? order : -order;
    });
  }, [rows, sort, numeric]);

  // Nothing recognisable (or still streaming in): show it as written.
  if (headCells.length === 0) return <table ref={tableRef} className="md-table-grid">{children}</table>;

  const sortable = rows.length > 1;
  // Unsorted → ascending → descending → unsorted.
  const toggle = (column: number) =>
    setSort((current) =>
      current?.column !== column ? { column, direction: "asc" } : current.direction === "asc" ? { column, direction: "desc" } : null,
    );
  const align = (cell: Cell, column: number) => (numeric[column] && !cell.props.style?.textAlign ? "is-num" : undefined);

  return (
    <table ref={tableRef} className="md-table-grid">
      <thead>
        <tr>
          {headCells.map((cell, column) => {
            const active = sort?.column === column ? sort.direction : null;
            return (
              <th
                key={column}
                style={cell.props.style}
                className={align(cell, column)}
                aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : sortable ? "none" : undefined}
              >
                {sortable ? (
                  <button type="button" className={`md-table-sort${active ? " active" : ""}`} onClick={() => toggle(column)} title="Sort">
                    <span>{cell.props.children}</span>
                    {active === "asc" ? <ArrowUp size={12} aria-hidden="true" /> : active === "desc" ? <ArrowDown size={12} aria-hidden="true" /> : <ChevronsUpDown size={12} aria-hidden="true" />}
                  </button>
                ) : (
                  cell.props.children
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.index}>
            {row.cells.map((cell, column) => cloneElement(cell, { key: column, className: align(cell, column) }))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
