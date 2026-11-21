/**
 * Copilot content-filter detail. pi-ai collapses a filtered completion into
 * "Provider finish_reason: content_filter" and drops Azure's per-category
 * results, so Copilot chat responses inside a run are teed and scanned for them.
 */

import { getRunContext } from "./run-context.js";

export interface FilterHit {
  /** "prompt" = the conversation sent to the model; "response" = the model's output. */
  source: "prompt" | "response";
  category: string;
  severity?: string;
}

export interface FilterCapture {
  hits: FilterHit[];
  /** Resolves once the scanned copy of the stream has been fully read. */
  done: Promise<void>;
}

const COPILOT_HOST = "api.githubcopilot.com";

function collectHits(results: unknown, source: FilterHit["source"], hits: FilterHit[]) {
  if (!results || typeof results !== "object") return;
  for (const [category, value] of Object.entries(results as Record<string, unknown>)) {
    const v = value as { filtered?: boolean; severity?: string } | undefined;
    if (v?.filtered) hits.push({ source, category, severity: v.severity });
  }
}

function scanLine(line: string, hits: FilterHit[]) {
  if (!line.startsWith("data: ") || !line.includes('"filtered":true')) return;
  try {
    const chunk = JSON.parse(line.slice(6)) as {
      prompt_filter_results?: Array<{ content_filter_results?: unknown }>;
      choices?: Array<{ content_filter_results?: unknown }>;
    };
    for (const p of chunk.prompt_filter_results ?? []) collectHits(p.content_filter_results, "prompt", hits);
    for (const c of chunk.choices ?? []) collectHits(c.content_filter_results, "response", hits);
  } catch {
    // Partial or non-JSON line; nothing to record.
  }
}

async function scanStream(body: ReadableStream<Uint8Array>, hits: FilterHit[]) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) scanLine(line, hits);
    }
    scanLine(buffer, hits);
  } catch {
    // The request was aborted or failed; pi-ai reports that on its own branch.
  }
}

let installed = false;

/** Wrap global fetch once so Copilot chat responses inside a run record their filter results. */
export function installCopilotFilterCapture(): void {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctx = getRunContext();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await originalFetch(input, init);
    if (!ctx || !url.includes(COPILOT_HOST) || !url.endsWith("/chat/completions") || !response.body) {
      return response;
    }
    const [forCaller, forScan] = response.body.tee();
    const hits: FilterHit[] = [];
    ctx.contentFilter = { hits, done: scanStream(forScan, hits) };
    return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  globalThis.fetch = Object.assign(wrapped, originalFetch) as typeof fetch;
}

/** Readable explanation for a content_filter stop, using the current run's captured results. */
export async function describeContentFilter(): Promise<string> {
  const capture = getRunContext()?.contentFilter;
  if (capture) await Promise.race([capture.done, new Promise((r) => setTimeout(r, 500))]);
  const hits = capture?.hits ?? [];
  const base = "Copilot's content filter blocked this response.";
  if (hits.length === 0) {
    return `${base} Copilot didn't say which category was flagged.`;
  }
  const describe = (source: FilterHit["source"]) =>
    [...new Set(
      hits
        .filter((h) => h.source === source)
        .map((h) => `${h.category.replace(/_/g, " ")}${h.severity && h.severity !== "safe" ? ` (${h.severity})` : ""}`),
    )].join(", ");
  const parts = [
    describe("prompt") && `Flagged in the conversation sent to the model (often tool output or pasted logs): ${describe("prompt")}.`,
    describe("response") && `Flagged in the model's response: ${describe("response")}.`,
  ].filter(Boolean);
  return `${base} ${parts.join(" ")}`;
}
