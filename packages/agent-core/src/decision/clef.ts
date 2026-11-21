/**
 * Clef backend — any Jev/SystemOne-compatible endpoint: Cloudflare Workers AI
 * (`@cf/cloudflare/clef[-flash]`) or a self-hosted `POST {base_url}/v1/systemone`.
 */

import type { Settings } from "../config.js";
import {
  MAX_QUESTIONS_PER_REQUEST,
  QUESTION_ID_RE,
  type Answer,
  type Answers,
  type DecideOptions,
  type Question,
  type Questions,
} from "./types.js";

export const CLEF_MODELS = ["clef", "clef-flash"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];
// Per-message routing is latency-sensitive, so a blank model means the flash variant.
export const DEFAULT_CLEF_MODEL: ClefModel = "clef-flash";
const CLEF_CONTEXT_WINDOW = 65_536;

type ClefConfig = Settings["decision"]["clef"];

export const isClefModel = (id: string): id is ClefModel => (CLEF_MODELS as readonly string[]).includes(id.trim());

export function resolveClefModel(configured: string): ClefModel {
  return isClefModel(configured) ? (configured.trim() as ClefModel) : DEFAULT_CLEF_MODEL;
}

// An unset ${VAR} stays literal after interpolation; treat it as missing.
const present = (v: string) => v.trim() !== "" && !/^\$\{?[A-Za-z_]/.test(v.trim());

export function clefTarget(cfg: ClefConfig): "self-hosted" | "cloudflare" | null {
  if (present(cfg.base_url)) return "self-hosted";
  if (present(cfg.account_id) && present(cfg.api_token)) return "cloudflare";
  return null;
}

export function clefEndpoint(cfg: ClefConfig, model: ClefModel): { url: string; headers: Record<string, string> } {
  const target = clefTarget(cfg);
  if (target === "self-hosted") {
    return { url: `${cfg.base_url.trim().replace(/\/+$/, "")}/v1/systemone`, headers: { "Content-Type": "application/json" } };
  }
  if (target === "cloudflare") {
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id.trim())}/ai/run/@cf/cloudflare/${model}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_token.trim()}` },
    };
  }
  throw new Error("Clef is not configured: set [decision.clef] base_url, or account_id and api_token");
}

export interface ClefRequest {
  model: string;
  state: unknown;
  questions: Questions;
}

/** One request per 64 questions (the API's limit). */
export function buildClefRequests(state: unknown, questions: Questions, model: string): ClefRequest[] {
  const entries = Object.entries(questions);
  for (const [id] of entries) {
    if (!QUESTION_ID_RE.test(id)) throw new Error(`invalid question id "${id}"`);
  }
  const requests: ClefRequest[] = [];
  for (let i = 0; i < entries.length; i += MAX_QUESTIONS_PER_REQUEST) {
    requests.push({ model, state, questions: Object.fromEntries(entries.slice(i, i + MAX_QUESTIONS_PER_REQUEST)) });
  }
  return requests;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function numberRecord(v: unknown): Record<string, number> | undefined {
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : isObject(v) ? Object.entries(v) : null;
  if (!entries) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of entries) {
    const n = num(x);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

const maxOf = (probs: Record<string, number>) => Math.max(0, ...Object.values(probs));

/** p(true) from a bare number, `{ noul }`, `{ probability }`, or `{ probabilities: { true } }`. */
export function noulProbability(raw: unknown): number | undefined {
  if (num(raw) !== undefined) return raw as number;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (!isObject(raw)) return undefined;
  for (const key of ["noul", "probability", "p", "value"]) {
    const n = num(raw[key]);
    if (n !== undefined) return n;
  }
  if (typeof raw.noul === "boolean") return raw.noul ? 1 : 0;
  if (isObject(raw.probabilities)) return num(raw.probabilities.true) ?? num(raw.probabilities["1"]);
  return undefined;
}

export function normalizeAnswer(question: Question, raw: unknown): Answer {
  if (question.type === "noul") {
    const p = noulProbability(raw);
    if (p === undefined) throw new Error("noul answer has no probability");
    return { type: "noul", noul: Math.min(1, Math.max(0, p)) };
  }
  if (!isObject(raw)) throw new Error(`${question.type} answer is not an object`);
  if (question.type === "choice") {
    if (typeof raw.choice !== "string") throw new Error("choice answer has no choice");
    const probabilities = numberRecord(raw.probabilities) ?? { [raw.choice]: 1 };
    return { type: "choice", choice: raw.choice, confidence: num(raw.confidence) ?? maxOf(probabilities), probabilities };
  }
  const score = num(raw.score);
  if (score === undefined) throw new Error("score answer has no score");
  const probabilities = numberRecord(raw.probabilities) ?? { [String(Math.round(score))]: 1 };
  const legend = isObject(raw.legend) ? raw.legend : Object.fromEntries(question.criteria.map((c, i) => [String(i), c]));
  return { type: "score", score, confidence: num(raw.confidence) ?? maxOf(probabilities), legend, probabilities };
}

function errorSummary(body: unknown): string {
  if (!isObject(body)) return "";
  const errors = Array.isArray(body.errors) ? body.errors.map((e) => (isObject(e) ? String(e.message ?? "") : String(e))) : [];
  const msg = errors.filter(Boolean).join("; ") || (typeof body.error === "string" ? body.error : "");
  return msg.slice(0, 300);
}

export interface ParsedClefResponse {
  answers: Answers;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Accepts the bare SystemOne body or Cloudflare's `{ result, success, errors }` wrapper. */
export function parseClefResponse(json: unknown, questions: Questions): ParsedClefResponse {
  let body = json;
  if (isObject(body) && !("answers" in body) && "result" in body) {
    if (body.success === false) throw new Error(`Clef request failed: ${errorSummary(body) || "unknown error"}`);
    body = body.result;
  }
  if (!isObject(body) || !isObject(body.answers)) throw new Error("Clef response has no answers");

  const answers: Answers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (body.answers[id] === undefined) continue;
    answers[id] = normalizeAnswer(question, body.answers[id]);
  }
  const usage = isObject(body.usage)
    ? { inputTokens: num(body.usage.input_tokens) ?? 0, outputTokens: num(body.usage.output_tokens) ?? 0 }
    : undefined;
  return { answers, model: typeof body.model === "string" ? body.model : undefined, usage };
}

export async function clefDecide(
  settings: Settings,
  state: unknown,
  questions: Questions,
  opts: DecideOptions = {},
): Promise<Answers> {
  const model = resolveClefModel(settings.decision.model);
  const { url, headers } = clefEndpoint(settings.decision.clef, model);
  const provider = clefTarget(settings.decision.clef) === "cloudflare" ? "cloudflare" : "clef";
  return systemOneDecide({ url, headers, model, provider, contextWindow: CLEF_CONTEXT_WINDOW }, state, questions, opts);
}

export interface SystemOneTarget {
  url: string;
  headers: Record<string, string>;
  model: string;
  /** Recorded on usage events. */
  provider: string;
  contextWindow: number;
  /** Extra top-level request fields, e.g. Ollama's keep_alive. */
  extra?: Record<string, unknown>;
}

/** POST questions to any Jev/SystemOne-compatible endpoint, 64 per request. */
export async function systemOneDecide(
  target: SystemOneTarget,
  state: unknown,
  questions: Questions,
  opts: DecideOptions = {},
): Promise<Answers> {
  const { url, headers, model, provider, contextWindow, extra } = target;
  const chunks = await Promise.all(
    buildClefRequests(state, questions, model).map(async (req) => {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...req, ...extra }), signal: opts.signal });
      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${provider} HTTP ${resp.status}: non-JSON response`);
      }
      if (!resp.ok) throw new Error(`${provider} HTTP ${resp.status}: ${errorSummary(json) || "request failed"}`);
      const parsed = parseClefResponse(json, req.questions);
      if (parsed.usage) {
        opts.onUsage?.({ provider, model, ...parsed.usage, contextWindow });
      }
      return parsed.answers;
    }),
  );
  return Object.assign({}, ...chunks) as Answers;
}
