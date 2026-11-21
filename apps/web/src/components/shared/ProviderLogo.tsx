import React from "react";
import { siClaude, siDeepseek, siGooglegemini, siMeta, siMistralai, siQwen } from "simple-icons";
import type { SimpleIcon } from "simple-icons";
import openaiSvg from "bootstrap-icons/icons/openai.svg?raw";
import microsoftSvg from "bootstrap-icons/icons/microsoft.svg?raw";
import twitterXSvg from "bootstrap-icons/icons/twitter-x.svg?raw";
import { modelProvider } from "../../utils/modelNames";
import type { ModelProvider } from "../../utils/modelNames";
import { Astroid } from "lucide-react";

interface Mark {
  viewBox: string;
  paths: Array<{ d: string; fillRule?: "evenodd" | "nonzero" }>;
  /** Brand color; undefined follows the surrounding text color. */
  color?: string;
}

function fromSimpleIcon(icon: SimpleIcon): Mark {
  // Pure-black marks follow the text color so they stay visible in dark mode.
  return { viewBox: "0 0 24 24", paths: [{ d: icon.path }], color: icon.hex === "000000" ? undefined : `#${icon.hex}` };
}

/** Bootstrap Icons ship as static SVG files; pull out just the path geometry. */
function fromBootstrapSvg(svg: string): Mark {
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?>/g)].flatMap((match) => {
    const d = match[1].match(/\sd="([^"]+)"/)?.[1];
    if (!d) return [];
    const fillRule = match[1].includes('fill-rule="evenodd"') ? ("evenodd" as const) : undefined;
    return [{ d, fillRule }];
  });
  return { viewBox: svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 16 16", paths };
}

// Simple Icons has no OpenAI/Microsoft marks and Bootstrap Icons lacks Claude/Gemini/etc., so combine both.
const MARKS: Partial<Record<ModelProvider["id"], Mark>> = {
  anthropic: fromSimpleIcon(siClaude),
  google: fromSimpleIcon(siGooglegemini),
  meta: fromSimpleIcon(siMeta),
  mistral: fromSimpleIcon(siMistralai),
  qwen: fromSimpleIcon(siQwen),
  deepseek: fromSimpleIcon(siDeepseek),
  openai: fromBootstrapSvg(openaiSvg),
  microsoft: fromBootstrapSvg(microsoftSvg),
  xai: fromBootstrapSvg(twitterXSvg),
};

interface Props {
  /** A model id or a provider id. */
  model?: string;
  provider?: ModelProvider["id"];
  size?: number;
}

export default function ProviderLogo({ model, provider, size = 14 }: Props) {
  const id = provider ?? modelProvider(model ?? "").id;
  const mark = MARKS[id];

  if (mark) {
    return (
      <svg className="provider-logo" width={size} height={size} viewBox={mark.viewBox} aria-hidden="true" focusable="false">
        {mark.paths.map((p, i) => (
          <path key={i} d={p.d} fillRule={p.fillRule} fill={mark.color ?? "currentColor"} />
        ))}
      </svg>
    );
  }

  return (
    <span className="provider-logo provider-logo--wildcard" style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden="true">
      <Astroid width={size} height={size} />
    </span>
  );
}
