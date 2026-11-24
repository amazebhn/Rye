import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import Modal, { ModalCancelButton } from "../shared/Modal";
import HoldButton from "../shared/HoldButton";

type Source = "settings" | "config" | "default";
type RerankProvider = "off" | "ollama" | "decision" | "server";

interface EmbeddingInfo {
  model: string;
  source: Source;
  ollama_models: string[];
  needs_reindex: boolean;
  knowledge: { chunks: number; models: Array<{ model: string; chunks: number }>; backup: { model: string; chunks: number } | null };
  chats: { model: string | null; messages: number; embedded: number; backup: { model: string; messages: number } | null };
  reindex: { running: boolean; done: number; total: number; model: string | null; error: string | null; finished_at: number | null };
}

interface RerankInfo {
  provider: RerankProvider;
  model: string;
  url: string;
  source: Source;
  ollama_models: string[];
  problem: string | null;
  decision_ready: boolean;
}

interface Retrieval {
  embedding: EmbeddingInfo;
  rerank: RerankInfo;
}

const EMBEDDING_DESC =
  "Turns knowledge notes, SOPs and chat messages into vectors so they can be found by meaning, not only by their words. Runs in Ollama; chat messages are never sent anywhere else.";

const SOURCE_LABEL: Record<Source, string> = { settings: "Set here", config: "config.toml", default: "Default" };

const RERANK_PROVIDERS: { key: RerankProvider; name: string }[] = [
  { key: "off", name: "Off" },
  { key: "decision", name: "Decision model" },
  { key: "ollama", name: "Ollama chat model" },
  { key: "server", name: "Rerank server" },
];

async function call(path: string, method: "GET" | "PUT" | "POST", body?: unknown): Promise<Retrieval> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { retrieval?: Retrieval; error?: string };
  if (!res.ok || !json.retrieval) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.retrieval;
}

const sameModel = (a: string, b: string) => a.replace(/:latest$/, "") === b.replace(/:latest$/, "");
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Embedding model and reranker: what turns notes and messages into something searchable by meaning. */
export default function RetrievalSection() {
  const [data, setData] = useState<Retrieval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The embedding model the user picked and has yet to confirm. */
  const [pending, setPending] = useState<string | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const run = useCallback(async (request: () => Promise<Retrieval>) => {
    setBusy(true);
    setError(null);
    try {
      setData(await request());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void run(() => call("/models/settings", "GET")); }, [run]);

  // While the server is re-embedding, follow its progress.
  const running = data?.embedding.reindex.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      call("/models/settings", "GET").then(setData).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!data) {
    // The heading is there from the start, so the page doesn't jump when the settings arrive.
    return (
      <>
        {error && <div className="settings-error" role="alert">{error}</div>}
        <section className="settings-section" aria-labelledby="settings-embedding-title">
          <div className="settings-section-head">
            <h3 className="settings-section-title" id="settings-embedding-title">Embedding model</h3>
            <p className="settings-section-desc">{EMBEDDING_DESC}</p>
          </div>
          {!error && <div className="settings-task-list settings-retrieval-loading" aria-busy="true"><p className="settings-placeholder">Loading…</p></div>}
        </section>
      </>
    );
  }

  const { embedding, rerank } = data;
  const embeddingOptions = embedding.ollama_models.some((m) => sameModel(m, embedding.model)) ? embedding.ollama_models : [embedding.model, ...embedding.ollama_models];
  const onCurrent = embedding.knowledge.models.filter((m) => sameModel(m.model, embedding.model)).reduce((n, m) => n + m.chunks, 0);
  const backupModel = embedding.knowledge.backup?.model ?? embedding.chats.backup?.model ?? null;
  const saveRerank = (patch: { provider?: RerankProvider; model?: string | null; url?: string | null }) =>
    void run(() => call("/models/settings", "PUT", { rerank: patch }));

  async function confirmChange() {
    if (!pending) return;
    setBusy(true);
    setPendingError(null);
    try {
      setData(await call("/models/settings", "PUT", { embedding_model: pending }));
      setPending(null);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="settings-error" role="alert">{error}</div>}

      <section className="settings-section" aria-labelledby="settings-embedding-title">
        <div className="settings-section-head">
          <h3 className="settings-section-title" id="settings-embedding-title">Embedding model</h3>
          <p className="settings-section-desc">{EMBEDDING_DESC}</p>
        </div>
        <div className="settings-task-list">
          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Model</span>
              <span className="settings-task-desc">
                Changing it means indexing everything again. The current vectors are kept as a backup to switch back to.
              </span>
            </div>
            <div className="settings-decision-control">
              <span className={`settings-source settings-source--${embedding.source}`}>{SOURCE_LABEL[embedding.source]}</span>
              <select
                className="settings-select"
                value={embeddingOptions.find((m) => sameModel(m, embedding.model)) ?? embedding.model}
                disabled={busy || running}
                onChange={(e) => { setPendingError(null); setPending(e.target.value); }}
                aria-label="Embedding model"
              >
                {embeddingOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Index</span>
              <span className="settings-task-desc" role="status">
                {running
                  ? `Indexing with ${embedding.reindex.model}… ${embedding.reindex.done} of ${embedding.reindex.total} notes`
                  : <>
                      {embedding.knowledge.chunks === 0
                        ? "No knowledge notes yet."
                        : `${onCurrent.toLocaleString()} of ${count(embedding.knowledge.chunks, "note section")} indexed with this model.`}{" "}
                      {embedding.chats.messages > 0 && `${embedding.chats.embedded.toLocaleString()} of ${count(embedding.chats.messages, "message")} indexed${embedding.chats.embedded < embedding.chats.messages ? " (the rest are filled in in the background)" : ""}.`}
                    </>}
              </span>
              {!running && embedding.needs_reindex && (
                <span className="settings-decision-status is-missing" role="status">
                  <TriangleAlert size={12} aria-hidden="true" /> Some notes were indexed with another model and can only be found by keyword until you reindex.
                </span>
              )}
              {!running && embedding.reindex.error && <span className="settings-decision-status is-missing" role="alert">{embedding.reindex.error}</span>}
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy || running}
              onClick={() => void run(() => call("/models/embeddings/reindex", "POST", {}))}
            >
              <RefreshCw size={13} className={running ? "spin" : ""} /> {running ? "Indexing…" : "Reindex"}
            </button>
          </div>

          {backupModel && !sameModel(backupModel, embedding.model) && (
            <div className="settings-task">
              <div className="settings-task-text">
                <span className="settings-task-name">Backup from {backupModel}</span>
                <span className="settings-task-desc">
                  {[
                    embedding.knowledge.backup && count(embedding.knowledge.backup.chunks, "note section"),
                    embedding.chats.backup && count(embedding.chats.backup.messages, "message"),
                  ].filter(Boolean).join(" and ")}{" "}
                  kept from the previous model. Switching back restores them without embedding again; only what changed since is redone.
                </span>
              </div>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || running} onClick={() => { setPendingError(null); setPending(backupModel); }}>
                <Undo2 size={13} /> Switch back
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-rerank-title">
        <div className="settings-section-head">
          <h3 className="settings-section-title" id="settings-rerank-title">Reranker</h3>
          <p className="settings-section-desc">
            Re-reads the knowledge notes a search found against your message. Only notes it judges relevant are attached,
            and searches return the best first. If it fails or is slow, search carries on without it.
          </p>
        </div>
        <div className="settings-task-list">
          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Provider</span>
            </div>
            <div className="settings-decision-control">
              <span className={`settings-source settings-source--${rerank.source}`}>{SOURCE_LABEL[rerank.source]}</span>
              <select
                className="settings-select"
                value={rerank.provider}
                disabled={busy}
                onChange={(e) => saveRerank({ provider: e.target.value as RerankProvider, model: null })}
                aria-label="Reranker provider"
              >
                {RERANK_PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </div>
          </div>

          {rerank.provider === "decision" && (
            <div className="settings-task">
              <div className="settings-task-text">
                <span className="settings-task-name">Decision model</span>
                <span className={`settings-decision-status${rerank.decision_ready ? " is-ok" : " is-missing"}`} role="status">
                  {rerank.decision_ready
                    ? "Uses the decision model chosen on the Models page. Every note is judged in one request."
                    : "The decision model is off. Turn it on from the Models page, or notes won't be reranked."}
                </span>
              </div>
            </div>
          )}

          {rerank.provider === "ollama" && (
            <div className="settings-task">
              <div className="settings-task-text">
                <span className="settings-task-name">Model</span>
                <span className="settings-task-desc">Asked "does this note help?" once per note. A small, fast chat model works best.</span>
                {rerank.problem && <span className="settings-decision-status is-missing" role="alert">{rerank.problem}</span>}
                {!rerank.model && <span className="settings-decision-status is-missing" role="status">Choose a model, or notes won't be reranked.</span>}
              </div>
              <div className="settings-decision-control">
                <select
                  className="settings-select"
                  value={rerank.model}
                  disabled={busy}
                  onChange={(e) => saveRerank({ model: e.target.value })}
                  aria-label="Reranker model"
                >
                  <option value="">Choose a model</option>
                  {(rerank.model && !rerank.ollama_models.includes(rerank.model) ? [rerank.model, ...rerank.ollama_models] : rerank.ollama_models).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {rerank.provider === "server" && (
            <ServerFields key={`${rerank.url}|${rerank.model}`} rerank={rerank} disabled={busy} onSave={saveRerank} />
          )}
        </div>
      </section>

      {pending && (
        <Modal
          title={`Use ${pending} for embeddings?`}
          className="modal--compact"
          onClose={() => { if (!busy) setPending(null); }}
          lockBackdrop
          footer={
            <>
              <ModalCancelButton />
              <HoldButton disabled={busy} onConfirm={() => void confirmChange()}>
                {busy ? "Checking the model…" : "Hold to change and reindex"}
              </HoldButton>
            </>
          }
        >
          <div className="settings-confirm">
            <p>
              <strong>Everything has to be indexed again.</strong> Vectors from one model can't be compared with another's, so{" "}
              {count(embedding.knowledge.chunks, "note section")}, your SOPs and {count(embedding.chats.messages, "chat message")} will be embedded with {pending}.
              A large model can take several minutes. Until it finishes, search by meaning finds less; keyword search keeps working.
            </p>
            {backupModel && sameModel(backupModel, pending) ? (
              <p>The backup from {pending} is restored first, so only what changed since then needs embedding.</p>
            ) : (
              <p>
                The vectors from {embedding.model} are kept as a backup, so you can switch back without embedding again.
                {backupModel && !sameModel(backupModel, embedding.model) && <> One previous model is kept: this replaces the backup from {backupModel}.</>}
              </p>
            )}
            {pendingError && <div className="settings-error" role="alert">{pendingError}</div>}
          </div>
        </Modal>
      )}
    </>
  );
}

/** The rerank server's address and model name; saved together with the button, not on every keystroke. */
function ServerFields({ rerank, disabled, onSave }: { rerank: RerankInfo; disabled: boolean; onSave: (patch: { url: string; model: string }) => void }) {
  const [url, setUrl] = useState(rerank.url);
  const [model, setModel] = useState(rerank.model);
  const dirty = url.trim() !== rerank.url || model.trim() !== rerank.model;
  return (
    <form
      className="settings-task settings-retrieval-server"
      onSubmit={(e) => { e.preventDefault(); if (dirty) onSave({ url: url.trim(), model: model.trim() }); }}
    >
      <div className="settings-task-text">
        <span className="settings-task-name">Server</span>
        <span className="settings-task-desc">
          Anything that answers <code>/v1/rerank</code>, such as <code>llama-server --rerank</code>. This is how zerank and
          cross-encoder rerankers run; Ollama can't score them.
        </span>
        <label className="form-label" htmlFor="rerank-url">Address</label>
        <input id="rerank-url" className="form-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8012" autoComplete="off" spellCheck={false} />
        <label className="form-label" htmlFor="rerank-model">Model name <span className="form-label-hint">optional</span></label>
        <input id="rerank-model" className="form-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="zerank-2" autoComplete="off" spellCheck={false} />
        {!rerank.url && <span className="settings-decision-status is-missing" role="status">Enter the server's address, or notes won't be reranked.</span>}
      </div>
      <button type="submit" className="btn btn--primary btn--sm" disabled={disabled || !dirty}>Save</button>
    </form>
  );
}
