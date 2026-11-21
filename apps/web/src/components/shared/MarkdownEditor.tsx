import React, { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AtSign, Bold, Code, Heading2, Italic, Link2, List, ListOrdered, FileText } from "lucide-react";

export interface EditorMention {
  id: string;
  kind: "sop" | "skill" | "knowledge" | "agent";
  label: string;
  token: string;
  subtitle?: string;
}

const KIND_LABELS: Record<EditorMention["kind"], string> = {
  sop: "SOP",
  skill: "Skill",
  knowledge: "Knowledge",
  agent: "Agent",
};

/** Format [[sop:id|Title]], [[skill:name]], [[knowledge:id|Title]] tags cleanly for Markdown preview. */
export function formatReferencesForMarkdown(md: string): string {
  return md
    .replace(/\[\[sop:(\d+)\|([^\]]+)\]\]/g, "`SOP: $2`")
    .replace(/\[\[sop:(\d+)\]\]/g, "`SOP #$1`")
    .replace(/\[\[skill:([a-zA-Z0-9._-]+)(?:\|([^\]]+))?\]\]/g, (_, name, label) => `\`Skill: ${label || name}\``)
    .replace(/\[\[knowledge:([a-zA-Z0-9_-]+)\|([^\]]+)\]\]/g, "`Knowledge: $2`")
    .replace(/\[\[knowledge:([a-zA-Z0-9_-]+)\]\]/g, "`Knowledge: $1`");
}

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  template?: string;
  mentions?: EditorMention[];
}

type Tab = "write" | "preview";

export default function MarkdownEditor({ id, value, onChange, placeholder, template, mentions }: Props) {
  const [tab, setTab] = useState<Tab>("write");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  function applyEdit(next: string, selStart: number, selEnd: number) {
    onChange(next);
    setCursorPos(selEnd);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(selStart, selEnd);
    });
  }

  function insertAtCursor(snippet: string) {
    const el = ref.current;
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    const needsSpaceBefore = s > 0 && !/[\s(\[]/.test(value[s - 1]);
    const insert = `${needsSpaceBefore ? " " : ""}${snippet} `;
    const next = value.slice(0, s) + insert + value.slice(e);
    applyEdit(next, s + insert.length, s + insert.length);
  }

  // Inline @ or # autocomplete inside the textarea
  const inlineMention = useMemo(() => {
    if (mentionDismissed || !mentions || mentions.length === 0) return null;
    const before = value.slice(0, cursorPos);
    const m = before.match(/(?:^|\s)[@#]([a-zA-Z0-9_.:-]*)$/);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const matches = mentions.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.kind.includes(q) ||
        (item.subtitle?.toLowerCase().includes(q) ?? false),
    );
    if (matches.length === 0) return null;
    const start = before.length - m[1].length - 1;
    return { start, end: cursorPos, matches: matches.slice(0, 8) };
  }, [mentions, value, cursorPos, mentionDismissed]);

  function applyInlineMention(item: EditorMention) {
    if (!inlineMention) return;
    const replacement = `${item.token} `;
    const next = value.slice(0, inlineMention.start) + replacement + value.slice(inlineMention.end);
    const nextPos = inlineMention.start + replacement.length;
    setMentionIndex(0);
    setMentionDismissed(false);
    applyEdit(next, nextPos, nextPos);
  }

  const pickerMatches = useMemo(() => {
    if (!mentions || mentions.length === 0) return [];
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return mentions.slice(0, 12);
    return mentions
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.kind.includes(q) ||
          (item.subtitle?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 12);
  }, [mentions, pickerQuery]);

  function wrap(before: string, after = before, fallback = "text") {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = value.slice(s, e) || fallback;
    const next = value.slice(0, s) + before + selected + after + value.slice(e);
    applyEdit(next, s + before.length, s + before.length + selected.length);
  }

  function prefixLines(prefix: (index: number) => string) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const lineEnd = value.indexOf("\n", e);
    const end = lineEnd === -1 ? value.length : lineEnd;
    const block = value.slice(lineStart, end).split("\n").map((line, i) => prefix(i) + line).join("\n");
    const next = value.slice(0, lineStart) + block + value.slice(end);
    applyEdit(next, lineStart, lineStart + block.length);
  }

  const tools: { label: string; icon: React.ReactNode; run: () => void }[] = [
    { label: "Heading", icon: <Heading2 size={15} />, run: () => prefixLines(() => "## ") },
    { label: "Bold", icon: <Bold size={15} />, run: () => wrap("**") },
    { label: "Italic", icon: <Italic size={15} />, run: () => wrap("_") },
    { label: "Bulleted list", icon: <List size={15} />, run: () => prefixLines(() => "- ") },
    { label: "Numbered list", icon: <ListOrdered size={15} />, run: () => prefixLines((i) => `${i + 1}. `) },
    { label: "Inline code", icon: <Code size={15} />, run: () => wrap("`", "`", "code") },
    { label: "Link", icon: <Link2 size={15} />, run: () => wrap("[", "](https://)", "link text") },
  ];

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <div className="md-editor">
      <div className="md-editor-bar">
        <div className="sop-diff-tabs" role="tablist" aria-label="Editor mode">
          {(["write", "preview"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`sop-diff-tab${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
        {tab === "write" && (
          <div className="md-editor-tools" role="toolbar" aria-label="Formatting">
            {tools.map((tool) => (
              <button
                key={tool.label}
                type="button"
                className="md-editor-tool"
                onMouseDown={(e) => e.preventDefault()}
                onClick={tool.run}
                title={tool.label}
                aria-label={tool.label}
              >
                {tool.icon}
              </button>
            ))}
            {mentions && mentions.length > 0 && (
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  className="md-editor-tool"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setPickerOpen((v) => !v);
                    setPickerQuery("");
                  }}
                  title="Tag SOP, Skill, Knowledge, or Agent (@ / #)"
                  aria-label="Tag SOP, Skill, Knowledge, or Agent"
                >
                  <AtSign size={15} />
                </button>
                {pickerOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 6px)",
                      left: 0,
                      width: 300,
                      maxHeight: 260,
                      overflowY: "auto",
                      background: "var(--main-bg)",
                      border: "1px solid var(--main-border)",
                      borderRadius: 10,
                      boxShadow: "0 10px 28px rgba(0, 0, 0, 0.2)",
                      padding: 6,
                      zIndex: 40,
                    }}
                  >
                    <input
                      className="form-input"
                      style={{ fontSize: 12, padding: "5px 8px", marginBottom: 6 }}
                      placeholder="Filter SOPs, Skills, Knowledge, Agents…"
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setPickerOpen(false);
                      }}
                    />
                    {pickerMatches.length === 0 ? (
                      <div style={{ padding: "8px 6px", fontSize: 12, color: "var(--main-fg-faint)" }}>
                        No matching resources.
                      </div>
                    ) : (
                      pickerMatches.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            insertAtCursor(item.token);
                            setPickerOpen(false);
                          }}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 7px",
                            border: "none",
                            borderRadius: 6,
                            background: "transparent",
                            color: "var(--main-fg)",
                            textAlign: "left",
                            cursor: "pointer",
                            fontSize: 12,
                          }}
                        >
                          <span className="sop-card-tag" style={{ fontSize: 9.5, flexShrink: 0 }}>
                            {KIND_LABELS[item.kind]}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                            {item.label}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {template && tab === "write" && !value.trim() && (
          <button type="button" className="md-editor-template" onClick={() => applyEdit(template, 0, 0)}>
            <FileText size={13} /> Insert template
          </button>
        )}
      </div>

      {tab === "write" ? (
        <div style={{ position: "relative", display: "flex", flex: 1, width: "100%" }}>
          <textarea
            id={id}
            ref={ref}
            className="md-editor-input"
            style={{ width: "100%", boxSizing: "border-box" }}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setCursorPos(e.target.selectionStart ?? e.target.value.length);
              setMentionDismissed(false);
              setMentionIndex(0);
            }}
            onClick={(e) => {
              setCursorPos(e.currentTarget.selectionStart ?? value.length);
              setPickerOpen(false);
            }}
            onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? value.length)}
            onKeyDown={(e) => {
              if (!inlineMention) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % inlineMention.matches.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + inlineMention.matches.length) % inlineMention.matches.length);
              } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                applyInlineMention(inlineMention.matches[mentionIndex % inlineMention.matches.length]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setMentionDismissed(true);
              }
            }}
            placeholder={placeholder}
            spellCheck
          />
          {inlineMention && (
            <div
              role="listbox"
              aria-label="Insert reference"
              style={{
                position: "absolute",
                left: 10,
                bottom: 8,
                width: 320,
                maxHeight: 220,
                overflowY: "auto",
                background: "var(--main-bg)",
                border: "1px solid var(--main-border)",
                borderRadius: 10,
                boxShadow: "0 10px 28px rgba(0, 0, 0, 0.22)",
                padding: 4,
                zIndex: 40,
              }}
            >
              {inlineMention.matches.map((item, i) => {
                const active = i === mentionIndex % inlineMention.matches.length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyInlineMention(item);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      border: "none",
                      borderRadius: 6,
                      background: active ? "var(--main-surface)" : "transparent",
                      color: "var(--main-fg)",
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    <span className="sop-card-tag" style={{ fontSize: 9.5, flexShrink: 0 }}>
                      {KIND_LABELS[item.kind]}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </div>
                      {item.subtitle && (
                        <div style={{ fontSize: 10.5, color: "var(--main-fg-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="md-editor-preview">
          {value.trim() ? (
            <div className="sop-detail-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatReferencesForMarkdown(value)}</ReactMarkdown>
            </div>
          ) : (
            <p className="md-editor-empty">Nothing to preview yet.</p>
          )}
        </div>
      )}

      <div className="md-editor-foot">
        <span>{mentions && mentions.length > 0 ? "Markdown supported · Type @ or # to tag SOPs, Skills, Knowledge, or Agents" : "Markdown supported"}</span>
        <span>{words.toLocaleString()} {words === 1 ? "word" : "words"}</span>
      </div>
    </div>
  );
}
