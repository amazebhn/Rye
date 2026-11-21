/**
 * Markdown → .docx for Word artifacts. Covers what agents actually write:
 * headings, paragraphs, emphasis, inline code, links, lists (nested, ordered,
 * tasks), code blocks, tables, blockquotes and rules. Anything else falls back
 * to its plain text so content is never silently dropped.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { lexer, type Token, type Tokens } from "marked";

type Inline = TextRun | ExternalHyperlink;
type Block = Paragraph | Table;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

interface BlockCtx {
  quote: number;
  indent?: number; // list-item continuation depth
  list?: { level: number; ordered: boolean; instance: number };
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];
const MONO = "Consolas";
const ORDERED_REF = "rye-ordered";
const SAFE_LINK = /^(https?:|mailto:)/i;


function run(text: string, style: RunStyle): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    font: style.code ? MONO : undefined,
    shading: style.code ? { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
    color: style.link ? "0563C1" : undefined,
    underline: style.link ? {} : undefined,
  });
}

function inlines(tokens: Token[] | undefined, style: RunStyle = {}): Inline[] {
  const out: Inline[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlines(t.tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlines(t.tokens, { ...style, italics: true }));
        break;
      case "del":
        out.push(...inlines(t.tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push(run(t.text, { ...style, code: true }));
        break;
      case "br":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "link": {
        const link = t as Tokens.Link;
        const children = inlines(link.tokens, { ...style, link: true }).filter((c): c is TextRun => c instanceof TextRun);
        out.push(SAFE_LINK.test(link.href) ? new ExternalHyperlink({ link: link.href, children }) : run(link.text, style));
        break;
      }
      case "image":
        out.push(run(`[image: ${(t as Tokens.Image).text || (t as Tokens.Image).href}]`, { ...style, italics: true }));
        break;
      case "text":
        if (t.tokens?.length) out.push(...inlines(t.tokens, style));
        else out.push(run(t.text, style));
        break;
      default:
        if ("text" in t && typeof t.text === "string") out.push(run(t.text, style));
        else if (t.raw) out.push(run(t.raw, style));
    }
  }
  return out;
}

function paragraph(children: Inline[], ctx: BlockCtx, extra: { heading?: (typeof HEADINGS)[number] } = {}): Paragraph {
  const indentLeft = (ctx.quote + (ctx.indent ?? 0)) * 360;
  const list = ctx.list;
  return new Paragraph({
    children,
    heading: extra.heading,
    bullet: list && !list.ordered ? { level: list.level } : undefined,
    numbering: list?.ordered ? { reference: ORDERED_REF, level: list.level, instance: list.instance } : undefined,
    indent: !list && indentLeft ? { left: indentLeft } : undefined,
    border: ctx.quote ? { left: { style: BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 } } : undefined,
    spacing: { after: 120 },
  });
}

function table(t: Tokens.Table): Table {
  const cell = (c: Tokens.TableCell, header: boolean) =>
    new TableCell({
      children: [new Paragraph({ children: inlines(c.tokens, { bold: header }) })],
      shading: header ? { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: t.header.map((c) => cell(c, true)) }),
      ...t.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
    ],
  });
}

function blocks(tokens: Token[], ctx: BlockCtx, counter: { lists: number }): Block[] {
  const out: Block[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        break;
      case "heading":
        out.push(paragraph(inlines(t.tokens), { quote: ctx.quote }, { heading: HEADINGS[Math.min(t.depth, 6) - 1] }));
        break;
      case "paragraph":
        out.push(paragraph(inlines(t.tokens), ctx));
        break;
      case "text":
        out.push(paragraph(t.tokens?.length ? inlines(t.tokens) : [run(t.text, {})], ctx));
        break;
      case "code":
        for (const line of (t as Tokens.Code).text.split("\n")) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: MONO, size: 19 })],
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
              indent: { left: 240 + (ctx.quote + (ctx.indent ?? 0)) * 360 + (ctx.list ? (ctx.list.level + 1) * 360 : 0) },
              spacing: { after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ children: [], spacing: { after: 60 } }));
        break;
      case "list": {
        const list = t as Tokens.List;
        const level = ctx.list ? Math.min(ctx.list.level + 1, 5) : 0;
        const instance = ++counter.lists;
        for (const item of list.items) {
          const itemCtx: BlockCtx = { quote: ctx.quote, list: { level, ordered: list.ordered, instance } };
          let first = true;
          for (const child of item.tokens) {
            if (child.type === "list") {
              out.push(...blocks([child], itemCtx, counter));
              continue;
            }
            if (child.type === "checkbox") continue;
            if (first && (child.type === "text" || child.type === "paragraph")) {
              const box = item.task ? [run(item.checked ? "☑ " : "☐ ", {})] : [];
              const body = child.tokens?.length ? inlines(child.tokens) : [run(child.text, {})];
              out.push(paragraph([...box, ...body], itemCtx));
              first = false;
              continue;
            }
            // Continuation blocks sit under the item without a new bullet.
            out.push(...blocks([child], { quote: ctx.quote, indent: (ctx.indent ?? 0) + level + 1 }, counter));
          }
        }
        break;
      }
      case "table":
        out.push(table(t as Tokens.Table), new Paragraph({ children: [] }));
        break;
      case "blockquote":
        out.push(...blocks((t as Tokens.Blockquote).tokens, { ...ctx, quote: ctx.quote + 1 }, counter));
        break;
      case "hr":
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } } }));
        break;
      default:
        if (t.raw?.trim()) out.push(paragraph([run(t.raw.trim(), {})], ctx));
    }
  }
  return out;
}

export async function markdownToDocx(markdown: string, title: string): Promise<Buffer> {
  const doc = new Document({
    creator: "Rye",
    title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        {
          reference: ORDERED_REF,
          levels: [0, 1, 2, 3, 4, 5].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: blocks(lexer(markdown), { quote: 0 }, { lists: 0 }) }],
  });
  return Packer.toBuffer(doc);
}
