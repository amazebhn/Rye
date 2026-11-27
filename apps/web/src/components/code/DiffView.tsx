import React, { useMemo } from "react";
import type { DiffFile, DiffHunk, DiffLine } from "@rye/shared";

export type DiffMode = "unified" | "split";

function hunkHeader(h: DiffHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

/** Side-by-side rows: context on both sides, a run of removals paired with the additions after it. */
function splitRows(lines: DiffLine[]): Array<{ left?: DiffLine; right?: DiffLine }> {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", context: " " };
const SPOKEN: Record<DiffLine["kind"], string> = { add: "Added", del: "Removed", context: "" };

function Text({ line }: { line: DiffLine }) {
  return (
    <>
      {line.text === "" ? " " : line.text}
      {line.noNewline && <span className="diff-nonl" data-diff-skip="" title="No newline at end of file"> ⏎̸</span>}
    </>
  );
}

/** The side a line is on: removed lines are the old file's, added and context lines the new file's. */
const SIDE: Record<DiffLine["kind"], DiffSide> = { add: "new", del: "old", context: "new" };

export type DiffSide = "old" | "new";

/** A diff selection as code: the file, the lines it covers on one side, and their text without gutters. */
export interface DiffSelection {
  path: string;
  lines: { start: number; end: number };
  /** Left out when a unified selection mixes removed and added lines (its text is then marked with -/+). */
  side?: DiffSide;
  text: string;
}

// Line numbers, signs, screen-reader words and the no-newline mark: never part of the quoted code.
const SKIP = "[data-gutter], [data-diff-skip]";

/** The part of `cell` inside `range`, as text, without the elements that aren't code. */
function cellText(cell: Element, range: Range): string {
  const part = document.createRange();
  part.selectNodeContents(cell);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
  const frag = part.cloneContents();
  frag.querySelectorAll(SKIP).forEach((el) => el.remove());
  const text = frag.textContent ?? "";
  // An empty line is drawn as one no-break space (`Text`) so it keeps its height.
  return text === " " ? "" : text;
}

const elementOf = (node: Node): Element | null => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
const cellOf = (node: Node): Element | null => elementOf(node)?.closest("td.diff-text") ?? null;

/**
 * What a selection inside a `DiffView` quotes: the code cells it touches on one side, joined line by
 * line. Split view: the side the selection starts on (a drag down one column also crosses the other
 * column's cells in document order; one that ends on the other side still quotes the side it began on).
 * Unified: removed lines are the old side, added and context lines the new side; a selection mixing
 * removed and added lines keeps them all, marked "-"/"+"/" " so the excerpt doesn't read as one file's
 * code, with the new side's line range. Null when it touches no code or more than one file.
 */
export function readDiffSelection(range: Range): DiffSelection | null {
  const common = elementOf(range.commonAncestorContainer);
  const scope = common?.closest(".diff-table") ?? common;
  if (!scope) return null;
  const cells = [...scope.querySelectorAll<HTMLTableCellElement>("td.diff-text")].filter((c) => range.intersectsNode(c) && c.closest("[data-side]"));
  if (cells.length === 0) return null;
  const startCell = cellOf(range.startContainer);
  const read = cells.map((cell) => {
    const at = cell.closest<HTMLElement>("[data-side]")!;
    return {
      cell,
      side: at.dataset.side as DiffSide,
      line: Number(at.dataset.line),
      sign: at.dataset.sign,
      path: cell.closest<HTMLElement>("[data-path]")?.dataset.path ?? "",
      text: cellText(cell, range),
    };
  });
  if (new Set(read.map((r) => r.path)).size !== 1 || !read[0].path) return null;
  let rows = read;
  let side: DiffSide | undefined;
  if (cells[0].closest(".diff-view--split")) {
    side = read.find((r) => r.cell === startCell)?.side ?? read[0].side;
    rows = read.filter((r) => r.side === side);
  } else {
    side = new Set(read.map((r) => r.side)).size === 1 ? read[0].side : undefined;
  }
  // A selection that starts at the very end of a line touches it without taking any of its text.
  while (rows.length > 1 && rows[0].text === "" && rows[0].cell === startCell) rows = rows.slice(1);
  const numbered = rows.filter((r) => Number.isFinite(r.line) && (side ? r.side === side : r.side === "new"));
  const span = (numbered.length ? numbered : rows.filter((r) => Number.isFinite(r.line))).map((r) => r.line);
  if (span.length === 0) return null;
  const mark = (sign?: string) => (sign === "del" ? "-" : sign === "add" ? "+" : " ");
  const text = rows.map((r) => (side ? r.text : `${mark(r.sign)}${r.text}`)).join("\n");
  return { path: read[0].path, lines: { start: Math.min(...span), end: Math.max(...span) }, ...(side ? { side } : {}), text };
}

/** Copying from a diff copies the code (as `readDiffSelection` reads it), not the line numbers and signs. */
function copyCode(e: React.ClipboardEvent<HTMLDivElement>) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const quoted = readDiffSelection(sel.getRangeAt(0));
  if (!quoted) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", quoted.text);
}

/**
 * One file's diff, from the hunks the server parsed: line numbers on both sides, added and removed
 * lines in the `--diff-*` tokens (with a +/− sign too, so colour isn't the only cue). Unified or split.
 * Each line row carries `data-path`, and its side (`data-side`, `old` | `new`) and that side's line
 * number (`data-line`): on the row in unified view, on each side's cells in split view. Gutters carry
 * `data-gutter` and other non-code bits `data-diff-skip`, so selections quote and copy clean code
 * (`readDiffSelection`).
 */
export default function DiffView({ file, mode }: { file: DiffFile; mode: DiffMode }) {
  const hunks = file.hunks ?? [];
  const split = useMemo(() => (mode === "split" ? hunks.map((h) => splitRows(h.lines)) : []), [hunks, mode]);
  // The side and line number a split cell belongs to.
  const at = (line: DiffLine | undefined, side: DiffSide) => {
    const n = line ? (side === "old" ? line.oldLine : line.newLine) : undefined;
    return line && n != null ? { "data-side": side, "data-line": n, "data-sign": line.kind } : {};
  };

  if (file.binary) return <p className="diff-note">Binary file; its contents aren’t shown.</p>;
  if (hunks.length === 0) {
    return (
      <p className="diff-note">
        {file.status === "renamed" ? "Renamed without changes to its contents." : file.oldMode !== file.newMode && (file.oldMode || file.newMode) ? `Mode changed ${file.oldMode ?? "?"} → ${file.newMode ?? "?"}.` : "No line changes."}
      </p>
    );
  }

  return (
    <div className={`diff-view diff-view--${mode}`} onCopy={copyCode}>
      {file.oldMode && file.newMode && file.oldMode !== file.newMode && (
        <p className="diff-note diff-note--inline">Mode changed {file.oldMode} → {file.newMode}</p>
      )}
      <table className="diff-table" aria-label={`Changes to ${file.path}`}>
        {mode === "unified" ? (
          <colgroup><col className="diff-col-num" /><col className="diff-col-num" /><col className="diff-col-sign" /><col /></colgroup>
        ) : (
          <colgroup><col className="diff-col-num" /><col className="diff-col-sign" /><col className="diff-col-half" /><col className="diff-col-num" /><col className="diff-col-sign" /><col className="diff-col-half" /></colgroup>
        )}
        {hunks.map((h, hi) => (
          <tbody key={hi}>
            <tr className="diff-hunk">
              <td colSpan={mode === "unified" ? 4 : 6}>
                <span className="diff-hunk-range">{hunkHeader(h)}</span>
                {h.section && <span className="diff-hunk-section"> {h.section}</span>}
              </td>
            </tr>
            {mode === "unified"
              ? h.lines.map((line, li) => (
                  <tr
                    key={li}
                    className={`diff-line diff-line--${line.kind}`}
                    data-path={file.path}
                    data-side={SIDE[line.kind]}
                    data-line={(SIDE[line.kind] === "old" ? line.oldLine : line.newLine) ?? undefined}
                    data-sign={line.kind}
                  >
                    <td className="diff-num" data-gutter="" aria-hidden="true">{line.oldLine ?? ""}</td>
                    <td className="diff-num" data-gutter="" aria-hidden="true">{line.newLine ?? ""}</td>
                    <td className="diff-sign" data-gutter="" aria-hidden="true">{SIGN[line.kind]}</td>
                    <td className="diff-text">
                      {SPOKEN[line.kind] && <span className="diff-sr" data-diff-skip="">{SPOKEN[line.kind]} line {line.kind === "add" ? line.newLine : line.oldLine}: </span>}
                      <Text line={line} />
                    </td>
                  </tr>
                ))
              : split[hi].map((row, ri) => (
                  <tr key={ri} className="diff-line diff-line--pair" data-path={file.path}>
                    <td className={`diff-num${row.left ? ` diff-cell--${row.left.kind}` : " diff-cell--empty"}`} data-gutter="" aria-hidden="true" {...at(row.left, "old")}>{row.left?.oldLine ?? ""}</td>
                    <td className={`diff-sign${row.left ? ` diff-cell--${row.left.kind}` : " diff-cell--empty"}`} data-gutter="" aria-hidden="true" {...at(row.left, "old")}>{row.left ? SIGN[row.left.kind] : ""}</td>
                    <td className={`diff-text${row.left ? ` diff-cell--${row.left.kind}` : " diff-cell--empty"}`} {...at(row.left, "old")}>
                      {row.left && row.left.kind === "del" && <span className="diff-sr" data-diff-skip="">Removed line {row.left.oldLine}: </span>}
                      {row.left && <Text line={row.left} />}
                    </td>
                    <td className={`diff-num diff-num--right${row.right ? ` diff-cell--${row.right.kind}` : " diff-cell--empty"}`} data-gutter="" aria-hidden="true" {...at(row.right, "new")}>{row.right?.newLine ?? ""}</td>
                    <td className={`diff-sign${row.right ? ` diff-cell--${row.right.kind}` : " diff-cell--empty"}`} data-gutter="" aria-hidden="true" {...at(row.right, "new")}>{row.right ? SIGN[row.right.kind] : ""}</td>
                    <td className={`diff-text${row.right ? ` diff-cell--${row.right.kind}` : " diff-cell--empty"}`} {...at(row.right, "new")}>
                      {row.right && row.right.kind === "add" && <span className="diff-sr" data-diff-skip="">Added line {row.right.newLine}: </span>}
                      {row.right && row.right.kind !== "context" && <Text line={row.right} />}
                      {row.right && row.right.kind === "context" && <span aria-hidden="true"><Text line={row.right} /></span>}
                    </td>
                  </tr>
                ))}
          </tbody>
        ))}
      </table>
      {file.truncated && <p className="diff-note">This file’s diff is too large to show in full.</p>}
    </div>
  );
}
