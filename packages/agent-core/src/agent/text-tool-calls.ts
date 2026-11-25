/**
 * Tool calls written as text. Some local models (Llama 3.1 through Ollama most
 * of all) sometimes answer a tool-using request by writing the call out —
 * `{"name": "save_agent_tool", "parameters": {...}}` — instead of making it, so
 * the provider reports no tool call and the user sees raw JSON. A reply that is
 * nothing but such a call, for a tool the model was actually offered, is turned
 * back into a real call. Anything else is left alone.
 */

import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";

interface WrittenCall {
  name: string;
  arguments: JsonObject;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON inside a reply that is only JSON, optionally in one ```json fence, optionally behind a "<|python_tag|>". */
function bareJson(text: string): string | null {
  let t = text.trim().replace(/^<\|python_tag\|>\s*/, "");
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  return t.startsWith("{") || t.startsWith("[") ? t : null;
}

function asCall(value: unknown, offered: ReadonlySet<string>): WrittenCall | null {
  if (!isObject(value)) return null;
  // The shapes models use: {name, parameters} (Llama), {name, arguments} (OpenAI-like), {function: {name, arguments}}.
  const inner = isObject(value.function) ? value.function : value;
  const name = inner.name;
  if (typeof name !== "string" || !offered.has(name)) return null;
  let args: unknown = inner.parameters ?? inner.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!isObject(args)) return null;
  // Nothing else may sit beside the call: an object with more in it is data the model meant to show.
  const extra = Object.keys(inner).filter((k) => !["name", "parameters", "arguments", "type"].includes(k));
  if (extra.length > 0 || (inner !== value && Object.keys(value).some((k) => !["function", "type", "id"].includes(k)))) return null;
  return { name, arguments: args as JsonObject };
}

/** The calls written out in `text`, when the whole reply is one call or a list of calls to offered tools; else null. */
export function parseWrittenToolCalls(text: string, offered: ReadonlySet<string>): WrittenCall[] | null {
  const json = bareJson(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Several calls one after another ("{...}; {...}" or one per line), as Llama sometimes writes them.
    const pieces = json.split(/\}\s*[;\n]\s*\{/);
    if (pieces.length < 2) return null;
    try {
      parsed = pieces.map((p, i) => JSON.parse(`${i > 0 ? "{" : ""}${p}${i < pieces.length - 1 ? "}" : ""}`));
    } catch {
      return null;
    }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return null;
  const calls = items.map((item) => asCall(item, offered));
  return calls.every((c): c is WrittenCall => c !== null) ? calls : null;
}

/** Real tool-call blocks for written-out calls. */
export function toToolCalls(calls: WrittenCall[], idPrefix: string): ToolCall[] {
  return calls.map((c, i) => ({ type: "toolCall", id: `${idPrefix}_${i}`, name: c.name, arguments: c.arguments }));
}

/**
 * Whether streamed text so far could still turn out to be a written tool call, so it
 * should be held back from the screen until the reply is complete. Ordinary replies
 * are let through after their first few characters.
 */
export function mightBeWrittenToolCall(textSoFar: string): boolean {
  const t = textSoFar.trimStart();
  if (t.length === 0) return true;
  if ("<|python_tag|>".startsWith(t) || t.startsWith("<|python_tag|>")) return true;
  if (t.startsWith("{") || t.startsWith("[")) return /^[[{]\s*("|\{|$)/.test(t);
  if (t.startsWith("`")) {
    if ("```".startsWith(t)) return true;
    // A fence holds a call only when it is ```json (or bare) and the first thing inside is an object.
    const m = /^```(json)?[ \t]*(\n\s*([\s\S]*))?$/.exec(t);
    if (!m) return /^```j?s?o?n?$/.test(t);
    if (m[2] === undefined) return true;
    const inside = (m[3] ?? "").trimStart();
    return inside.length === 0 || /^[[{]/.test(inside);
  }
  return false;
}
