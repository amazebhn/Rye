/**
 * Reranking: a second, slower look at retrieved passages that reads the query
 * and each passage together and says how relevant the passage is.
 *
 * Three ways to do it, chosen by `rerank.provider`:
 *
 *   ollama   — a generative model in Ollama, asked a yes/no question per passage;
 *              the score is how much of its first token's probability falls on
 *              "yes". Ollama has no rerank endpoint and reports only the 20
 *              likeliest tokens, so models that are scored by one token's raw
 *              logit (zerank) and cross-encoders (bge-reranker) can't be used
 *              this way. Qwen3-Reranker builds get their own prompt.
 *   decision — the decision model, asked one yes/no question per passage, all in
 *              a single request.
 *   server   — a rerank server speaking the /v1/rerank protocol (llama-server
 *              --rerank, Text Embeddings Inference, …). This is how zerank and
 *              cross-encoders run.
 */

import { getSettings, type Settings } from "../config.js";
import { decide, type Questions } from "../decision/index.js";

/** Relevance of each passage to the query, 0 to 1, in the order given. Null when reranking isn't available. */
export type RerankFn = (query: string, passages: string[]) => Promise<number[] | null>;

/** Above this a passage is taken to be relevant: "yes" is likelier than "no". */
export const RELEVANT_SCORE = 0.5;

/** Characters of a passage shown to the reranker; the start of a note says what it is about. */
const PASSAGE_CHARS = 1600;
const CONCURRENCY = 4;
/** Reranking runs before every reply that retrieved something, so it must never hold a turn up for long. */
const TOTAL_TIMEOUT_MS = 6000;
const TASK = "Given a question or task from a user, judge whether the document contains information that helps answer it.";

const isQwenReranker = (model: string) => /qwen3[^/]*rerank/i.test(model);

/** Models that are known not to work through Ollama's generate endpoint, and why. */
export function ollamaRerankProblem(model: string): string | null {
  if (/zerank/i.test(model)) return "zerank is scored by the raw value of one output token, which Ollama doesn't report. Run it with llama-server --rerank and choose \"Rerank server\".";
  if (/bge-reranker|jina-reranker|ms-marco|cross-encoder/i.test(model)) return "This is a cross-encoder, which Ollama can't run. Serve it with llama-server --rerank and choose \"Rerank server\".";
  return null;
}

/** The request body for one query/passage pair. */
export function rerankRequest(model: string, query: string, passage: string): Record<string, unknown> {
  const document = passage.slice(0, PASSAGE_CHARS);
  const options = { num_predict: 1, temperature: 0 };
  if (isQwenReranker(model)) {
    // The format the Qwen3 rerankers were trained on, sent as-is: the empty think block is part of it.
    return {
      model,
      raw: true,
      prompt:
        `<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. ` +
        `Note that the answer can only be "yes" or "no".<|im_end|>\n` +
        `<|im_start|>user\n<Instruct>: ${TASK}\n<Query>: ${query}\n<Document>: ${document}<|im_end|>\n` +
        `<|im_start|>assistant\n<think>\n\n</think>\n\n`,
      stream: false,
      logprobs: true,
      top_logprobs: 20,
      options,
    };
  }
  return {
    model,
    system: `${TASK} Answer with exactly one word: yes or no.`,
    prompt: `Question or task: ${query}\n\nDocument:\n${document}\n\nDoes the document help? Answer yes or no.`,
    stream: false,
    think: false,
    logprobs: true,
    top_logprobs: 20,
    options,
  };
}

interface TokenLogprob {
  token: string;
  logprob: number;
  top_logprobs?: TokenLogprob[];
}

/**
 * The share of probability on "yes" among the yes/no readings of the first
 * token. Null when the model said neither, so the passage's standing is unknown.
 */
export function yesProbability(first: TokenLogprob | undefined): number | null {
  if (!first) return null;
  let yes = 0;
  let no = 0;
  for (const candidate of first.top_logprobs?.length ? first.top_logprobs : [first]) {
    const word = candidate.token.trim().toLowerCase();
    if (word === "yes") yes += Math.exp(candidate.logprob);
    else if (word === "no") no += Math.exp(candidate.logprob);
  }
  return yes + no > 0 ? yes / (yes + no) : null;
}

/** What a rerank call may be handed in place of the real network and settings (tests, measurements). */
export interface RerankUsing {
  fetch?: typeof fetch;
  model?: string;
  baseUrl?: string;
}

/** Rerank with a generative model in Ollama. Null when none is named, or Ollama can't serve it in time. */
export async function rerankWithOllama(query: string, passages: string[], using: RerankUsing = {}): Promise<number[] | null> {
  const fetchFn = using.fetch ?? fetch;
  const cfg = getSettings();
  const model = (using.model ?? cfg.rerank.model).trim();
  const baseUrl = (using.baseUrl ?? cfg.ollama.base_url).replace(/\/+$/, "");
  if (!model || !baseUrl) return null;
  if (passages.length === 0) return [];

  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const scores = new Array<number | null>(passages.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < passages.length) {
      const index = next++;
      const res = await fetchFn(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rerankRequest(model, query, passages[index]), keep_alive: "30m" }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { logprobs?: TokenLogprob[] };
      scores[index] = yesProbability(data.logprobs?.[0]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, passages.length) }, worker));
  } catch (err) {
    console.error(`[rerank] ${model} unavailable, falling back to unranked results:`, err instanceof Error ? err.message : err);
    return null;
  }
  // A model that answers neither yes nor no can't rank anything.
  if (scores.every((s) => s === null)) {
    console.error(`[rerank] ${model} never answered yes or no; it can't be used as a reranker through Ollama.`);
    return null;
  }
  return scores.map((s) => s ?? 0);
}

/** Rerank with the decision model: one yes/no question per passage, all in one request. */
export async function rerankWithDecision(
  query: string,
  passages: string[],
  using: { decide?: typeof decide; settings?: Settings } = {},
): Promise<number[] | null> {
  if (passages.length === 0) return [];
  const settings = using.settings ?? getSettings();
  if (settings.decision.provider === "off") return null;
  const notes: Record<string, string> = {};
  const questions: Questions = {};
  passages.forEach((passage, i) => {
    notes[`note_${i + 1}`] = passage.slice(0, PASSAGE_CHARS);
    // A focused proposition per note, naming the note: decision models answer each question against the whole state.
    questions[`note_${i + 1}`] = { type: "noul", instructions: `Does note_${i + 1} contain information that helps answer the user's message?` };
  });
  try {
    const answers = await (using.decide ?? decide)(
      { context: "Notes retrieved from a knowledge base for an assistant that is about to answer the user's message.", user_message: query, notes },
      questions,
      { settings, signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS) },
    );
    const scores = passages.map((_, i) => {
      const answer = answers[`note_${i + 1}`];
      return answer?.type === "noul" ? answer.noul : null;
    });
    if (scores.every((s) => s === null)) return null;
    return scores.map((s) => s ?? 0);
  } catch (err) {
    console.error("[rerank] decision model unavailable, falling back to unranked results:", err instanceof Error ? err.message : err);
    return null;
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Rerank with a server that speaks the common /v1/rerank protocol
 * (`{model, query, documents}` → `{results: [{index, relevance_score}]}`).
 */
export async function rerankWithServer(query: string, passages: string[], using: RerankUsing = {}): Promise<number[] | null> {
  const cfg = getSettings();
  const base = (using.baseUrl ?? cfg.rerank.url).trim().replace(/\/+$/, "");
  if (!base) return null;
  if (passages.length === 0) return [];
  const url = /\/rerank$/.test(base) ? base : `${base}/v1/rerank`;
  const model = (using.model ?? cfg.rerank.model).trim();
  try {
    const res = await (using.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(model ? { model } : {}), query, documents: passages.map((p) => p.slice(0, PASSAGE_CHARS)), top_n: passages.length }),
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ index: number; relevance_score?: number; score?: number }> };
    const raw = new Array<number | null>(passages.length).fill(null);
    for (const r of data.results ?? []) {
      const value = r.relevance_score ?? r.score;
      if (Number.isInteger(r.index) && r.index >= 0 && r.index < raw.length && typeof value === "number") raw[r.index] = value;
    }
    if (raw.every((s) => s === null)) throw new Error("no scores in the response");
    // Some servers return probabilities, others raw logits (any real number). Logits are squashed to 0–1
    // so RELEVANT_SCORE means the same thing: the model leans towards "relevant".
    const logits = raw.some((s) => s !== null && (s < 0 || s > 1));
    return raw.map((s) => (s === null ? 0 : logits ? sigmoid(s) : s));
  } catch (err) {
    console.error(`[rerank] ${url} unavailable, falling back to unranked results:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Rerank with whatever `rerank.provider` names. Null when it is off or the provider can't answer. */
export const rerank: RerankFn = async (query, passages) => {
  switch (getSettings().rerank.provider) {
    case "ollama":
      return rerankWithOllama(query, passages);
    case "decision":
      return rerankWithDecision(query, passages);
    case "server":
      return rerankWithServer(query, passages);
    default:
      return null;
  }
};
