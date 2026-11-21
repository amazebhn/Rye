import React, { useEffect, useRef, useState } from "react";
import { jsonInit } from "../../contexts/SkillContext";
import Modal, { ModalCancelButton } from "../shared/Modal";

interface Available {
  name: string;
  description?: string;
}

interface ListResult {
  ok: boolean;
  skills: Available[];
  raw: string;
  error?: string;
}

interface InstallResult {
  ok: boolean;
  output: string;
  installed: string[];
  error?: string;
  note?: string;
}

interface Props {
  onInstalled: () => void;
  /** Returns to the New Skill picker from the first step. */
  onBack?: () => void;
  onClose: () => void;
  animateIn?: boolean;
}

type Step = "source" | "pick" | "done";

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function InstallSkillModal({ onInstalled, onBack, onClose, animateIn }: Props) {
  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<ListResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<InstallResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function begin() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    return controller.signal;
  }

  async function findSkills() {
    const src = source.trim();
    if (!src || busy) return;
    const signal = begin();
    try {
      const res = await fetch(`/skill/install/available?source=${encodeURIComponent(src)}`, { signal });
      const data = (await res.json().catch(() => ({}))) as Partial<ListResult>;
      // A 502 still carries the CLI output, so only a body without it is a hard failure.
      if (data.raw === undefined) throw new Error(data.error ?? `Request failed (${res.status})`);
      const list: ListResult = { ok: !!data.ok, skills: data.skills ?? [], raw: data.raw, error: data.error };
      setListing(list);
      setSelected(new Set(list.skills.map((s) => s.name)));
      setStep("pick");
    } catch (err) {
      if (!signal.aborted) setError(errMessage(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  async function install() {
    if (busy || !listing) return;
    const all = listing.skills.length > 0 && selected.size === listing.skills.length;
    if (listing.skills.length > 0 && selected.size === 0) return;
    const signal = begin();
    try {
      const res = await fetch("/skill/install", {
        ...jsonInit("POST", { source: source.trim(), ...(all || listing.skills.length === 0 ? {} : { skills: [...selected] }) }),
        signal,
      });
      const data = (await res.json().catch(() => ({}))) as Partial<InstallResult> & { error?: string };
      if (!res.ok && data.output === undefined) throw new Error(data.error ?? `Install failed (${res.status})`);
      setResult({ ok: !!data.ok, output: data.output ?? "", installed: data.installed ?? [], error: data.error, note: data.note });
      setStep("done");
      onInstalled();
    } catch (err) {
      if (!signal.aborted) setError(errMessage(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const count = listing?.skills.length ?? 0;
  const installLabel =
    count === 0 ? "Install all" : selected.size === count ? `Install all ${count}` : `Install ${selected.size}`;

  return (
    <Modal
      title={step === "done" ? "Install finished" : "Install Skills"}
      description={
        step === "source"
          ? "Add skills from a GitHub repository with the skills CLI."
          : step === "pick"
            ? `Skills in ${source.trim()}`
            : undefined
      }
      onClose={onClose}
      className="modal--wide"
      animateIn={animateIn}
      lockBackdrop={busy}
      onBack={
        busy ? undefined
        : step === "pick" ? () => { setStep("source"); setError(null); }
        : step === "source" ? onBack
        : undefined
      }
      footer={
        step === "source" ? (
          <>
            <ModalCancelButton />
            <button className="btn btn--primary btn--sm" disabled={!source.trim() || busy} onClick={() => void findSkills()}>
              {busy ? "Looking…" : "Find skills"}
            </button>
          </>
        ) : step === "pick" ? (
          <>
            <ModalCancelButton />
            <button
              className="btn btn--primary btn--sm"
              disabled={busy || (count > 0 && selected.size === 0)}
              onClick={() => void install()}
            >
              {busy ? "Installing…" : installLabel}
            </button>
          </>
        ) : (
          <button className="btn btn--primary btn--sm" onClick={onClose}>Done</button>
        )
      }
    >
      {step === "source" && (
        <div className="modal-form">
          <label className="form-label" htmlFor="skill-install-source">Source</label>
          <input
            id="skill-install-source"
            className="form-input"
            placeholder="owner/repo or https://github.com/owner/repo"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void findSkills(); }}
            disabled={busy}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <p className="skill-install-hint">
            Runs <code>bunx skills add</code> on this machine and installs into <code>~/.agents/skills</code>.
            Installed skills are read-only in Rye. Only install from sources you trust; their scripts still
            ask for your approval every time they run.
          </p>
        </div>
      )}

      {step === "pick" && listing && (
        <div className="skill-install-pick">
          {!listing.ok && (
            <p className="skill-form-error" role="alert">
              {listing.error ?? "Couldn't list the skills in this source."}
            </p>
          )}
          {count === 0 ? (
            <>
              <p className="skill-install-hint">
                No skill list could be read from the CLI output. You can still install everything in this source.
              </p>
              {listing.raw.trim() && <pre className="skill-install-output">{listing.raw.trim()}</pre>}
            </>
          ) : (
            <>
              <label className="skill-install-row skill-install-row--all">
                <input
                  type="checkbox"
                  checked={selected.size === count}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < count; }}
                  onChange={(e) => setSelected(e.target.checked ? new Set(listing.skills.map((s) => s.name)) : new Set())}
                  disabled={busy}
                />
                <span className="skill-install-name">Select all</span>
              </label>
              <ul className="skill-install-list">
                {listing.skills.map((s) => (
                  <li key={s.name}>
                    <label className="skill-install-row">
                      <input type="checkbox" checked={selected.has(s.name)} onChange={() => toggle(s.name)} disabled={busy} />
                      <span>
                        <span className="skill-install-name">{s.name}</span>
                        {s.description && <span className="skill-install-desc">{s.description}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {step === "done" && result && (
        <div className="skill-install-pick">
          {result.ok ? (
            <p className="skill-install-summary">
              {result.installed.length > 0
                ? `Installed ${result.installed.length === 1 ? "1 skill" : `${result.installed.length} skills`}: ${result.installed.join(", ")}.`
                : "The CLI finished."}
            </p>
          ) : (
            <p className="skill-form-error" role="alert">{result.error ?? "The install failed."}</p>
          )}
          {result.note && <p className="skill-install-hint">{result.note}</p>}
          {result.output.trim() && (
            <details className="skill-install-details">
              <summary>CLI output</summary>
              <pre className="skill-install-output">{result.output.trim()}</pre>
            </details>
          )}
        </div>
      )}

      {error && <p className="skill-form-error" role="alert">{error}</p>}
    </Modal>
  );
}
