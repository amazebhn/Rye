import React, { useEffect, useId, useState } from "react";
import { Code2, Workflow } from "lucide-react";

type Mermaid = (typeof import("mermaid"))["default"];

// Mermaid is large, so it is only fetched the first time a reply contains a diagram.
let loading: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // "strict" sanitizes labels and disables click handlers: the diagram source comes from a model.
      securityLevel: "strict",
      theme: "neutral",
      // The app's sans font, by name: Mermaid measures labels off-page, where "inherit" resolves to the browser default.
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "sans-serif",
    });
    return mermaid;
  });
  return loading;
}

type Drawn = { source: string; svg: string } | { source: string; error: string };

/** A diagram the agent writes as a fenced ```mermaid block (flowchart, sequence, ER, state, gantt…). */
export default function DiagramBlock({ source }: { source: string }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [view, setView] = useState<"diagram" | "source">("diagram");

  useEffect(() => {
    let cancelled = false;
    // While a reply streams the source changes on every token; wait for it to hold still.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const mermaid = await loadMermaid();
          // Checked first because render() leaves an error graphic in the page when the source is invalid.
          const valid = await mermaid.parse(source, { suppressErrors: true });
          if (!valid) throw new Error("The diagram source isn't valid Mermaid.");
          const { svg } = await mermaid.render(id, source);
          if (!cancelled) setDrawn({ source, svg });
        } catch (err) {
          if (!cancelled) setDrawn({ source, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, source]);

  const current = drawn?.source === source ? drawn : null;
  // Keep the last good drawing on screen while newer source is being checked.
  const svg = drawn && "svg" in drawn ? drawn.svg : null;
  const failed = current && "error" in current ? current.error : null;

  return (
    <figure className="chart-block diagram-block">
      <figcaption className="chart-block-head">
        <span className="chart-block-title">Diagram</span>
        <span className="chart-block-toggle" role="group" aria-label="View">
          <button type="button" className={view === "diagram" ? "is-active" : ""} aria-pressed={view === "diagram"} aria-label="Diagram" title="Diagram" onClick={() => setView("diagram")}>
            <Workflow size={13} aria-hidden="true" />
          </button>
          <button type="button" className={view === "source" ? "is-active" : ""} aria-pressed={view === "source"} aria-label="Source" title="Source" onClick={() => setView("source")}>
            <Code2 size={13} aria-hidden="true" />
          </button>
        </span>
      </figcaption>
      {view === "source" ? (
        <pre><code>{source}</code></pre>
      ) : failed && !svg ? (
        <>
          <div className="chart-block-note">Couldn't draw this diagram. {failed}</div>
          <pre><code>{source}</code></pre>
        </>
      ) : svg ? (
        // Mermaid's own sanitized SVG output (securityLevel "strict").
        <div className="diagram-block-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="chart-block-note">Drawing diagram…</div>
      )}
    </figure>
  );
}
