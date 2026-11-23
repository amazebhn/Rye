import React, { isValidElement, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ChartBlock from "./ChartBlock";
import DiagramBlock from "./DiagramBlock";

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** A fenced code block in a reply: ```chart draws a chart, ```mermaid a diagram; anything else gets a language label and a copy button. */
export default function CodeBlock({ children }: { children?: React.ReactNode }) {
  const code = React.Children.toArray(children).find((c) => isValidElement(c));
  const className = isValidElement<{ className?: string }>(code) ? code.props.className ?? "" : "";
  const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? "";
  // The streaming cursor is appended to the reply text and can land inside an unfinished block.
  const source = textOf(children).replace(/▋$/, "").replace(/\n$/, "");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (language === "chart") return <ChartBlock source={source} />;
  if (language === "mermaid") return <DiagramBlock source={source} />;

  const copy = () => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{language}</span>
        <button type="button" className="code-block-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy code"} title={copied ? "Copied" : "Copy"}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
