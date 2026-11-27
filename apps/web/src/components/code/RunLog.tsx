import React, { useEffect, useState } from "react";
import { Ban, Check, Copy, LoaderCircle, SquareTerminal, X } from "lucide-react";
import type { CheckResult, CodeCheckSummary, CodeCommandEntry } from "@rye/shared";
import { codeApi } from "../../utils/codeApi";
import { formatDuration } from "./codeFormat";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="artifacts-icon-btn code-log-copy"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

const COMMAND_STATUS: Record<CodeCommandEntry["status"], string> = { running: "Running", ok: "Succeeded", failed: "Failed", denied: "Denied" };

function StatusIcon({ status }: { status: CodeCommandEntry["status"] | CheckResult["status"] }) {
  if (status === "running" || status === "pending") return <LoaderCircle size={13} className="code-log-spin" aria-hidden="true" />;
  if (status === "ok" || status === "pass") return <Check size={13} aria-hidden="true" />;
  if (status === "denied") return <Ban size={13} aria-hidden="true" />;
  return <X size={13} aria-hidden="true" />;
}

/** One command, collapsed to a row (status, command, duration); its details and output open under it. */
function CommandRow({ entry, open, onToggle }: { entry: CodeCommandEntry; open: boolean; onToggle: () => void }) {
  const exit = entry.exitCode === undefined ? undefined : entry.exitCode === null ? "killed" : `exit ${entry.exitCode}`;
  return (
    <li className={`code-log-item code-log-item--${entry.status}${open ? " is-open" : ""}`}>
      <div className="code-log-row">
        <button type="button" className="code-log-toggle" onClick={onToggle} aria-expanded={open} title={entry.command}>
          <span className={`code-log-status code-log-status--${entry.status}`} title={COMMAND_STATUS[entry.status]}>
            <StatusIcon status={entry.status} />
            <span className="diff-sr">{COMMAND_STATUS[entry.status]}: </span>
          </span>
          <code className="code-log-cmd">{entry.command}</code>
          <span className="code-log-meta">
            {entry.durationMs !== undefined ? formatDuration(entry.durationMs) : entry.status === "running" ? "running" : ""}
          </span>
        </button>
      </div>
      {open && (
        <div className="code-log-detail">
          <div className="code-log-where">
            <span>{COMMAND_STATUS[entry.status]}{exit ? ` (${exit})` : ""}</span>
            <span>Turn {entry.turn}</span>
            <span>in {entry.cwd ? `${entry.cwd}/` : "the repo root"}</span>
            {entry.argv && entry.argv.length > 1 && <span title={JSON.stringify(entry.argv)}>{entry.argv.length} arguments</span>}
            <CopyButton text={entry.command} label="Copy command" />
          </div>
          {entry.deniedReason && <p className="code-log-denied">{entry.deniedReason}</p>}
          {entry.output ? (
            <div className="code-log-output-wrap">
              <pre className="code-log-output">{entry.output}</pre>
              <CopyButton text={entry.output} label="Copy output" />
            </div>
          ) : (
            entry.status !== "denied" && <p className="code-log-empty">{entry.status === "running" ? "No output yet." : "No output."}</p>
          )}
          {entry.outputTruncated && <p className="code-log-empty">Output was cut short.</p>}
        </div>
      )}
    </li>
  );
}

export interface CommandLogState {
  commands: CodeCommandEntry[] | null;
  error: string | null;
}

/**
 * The commands the agent ran, re-read on every state change (`version`) and, while a run goes and the
 * log is on screen (`watching`), every few seconds as their output grows. The header's Log count reads it too.
 */
export function useCommandLog(sessionId: string | undefined, version: number, running: boolean, watching: boolean): CommandLogState {
  const [state, setState] = useState<CommandLogState & { id?: string }>({ commands: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    const ctrl = new AbortController();
    codeApi.commands(sessionId, ctrl.signal).then(
      (r) => setState({ id: sessionId, commands: r.commands, error: null }),
      (e: Error) => { if (!ctrl.signal.aborted) setState((s) => ({ ...s, error: e.message })); },
    );
    return () => ctrl.abort();
  }, [sessionId, version, tick]);

  const live = running && state.commands?.some((c) => c.status === "running");
  useEffect(() => {
    if (!running || !watching) return;
    const t = window.setInterval(() => setTick((n) => n + 1), live ? 2000 : 5000);
    return () => window.clearInterval(t);
  }, [running, watching, live]);

  // Another session's list is never shown for this one while it loads.
  return state.id === sessionId ? state : { commands: null, error: state.error };
}

/**
 * The Log tab: one row per command the agent ran (status, command, duration), full width; a click opens
 * its exit, turn, folder, copy and output under it. Only Rye runs commands; there is no interactive shell.
 */
export function CommandLog({ commands, error, archived }: CommandLogState & { archived: boolean }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (error && !commands) return <p className="diff-note" role="alert">{error}</p>;
  if (!commands) return <p className="diff-note">Loading commands…</p>;
  if (commands.length === 0) {
    return (
      <div className="code-tab-empty">
        <SquareTerminal size={20} aria-hidden="true" />
        <p className="artifacts-empty-title">No commands yet</p>
        <p className="artifacts-empty-text">{archived ? "This session ran no commands." : "Commands the agent runs in its sandbox are logged here with their output."}</p>
      </div>
    );
  }
  return (
    <div className="code-log-scroll">
      <ol className="code-log" aria-label="Commands">
        {/* Every row starts collapsed; the status icon says which failed or were denied. */}
        {commands.map((c) => (
          <CommandRow key={c.id} entry={c} open={openIds.has(c.id)} onToggle={() => toggle(c.id)} />
        ))}
      </ol>
    </div>
  );
}

const CHECK_STATUS: Record<CheckResult["status"], string> = { pending: "Waiting", running: "Running", pass: "Passed", fail: "Failed" };

/** The Checks tab. Running checks is phase 2: until then it shows what the server reports, or says so. */
export function ChecksPanel({ checks }: { checks?: CodeCheckSummary }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!checks || checks.results.length === 0) {
    return (
      <div className="code-tab-empty">
        <Check size={20} aria-hidden="true" />
        <p className="artifacts-empty-title">No checks yet</p>
        <p className="artifacts-empty-text">
          Checks are the repo’s own commands (typecheck, build, tests), set per repo in <code>[[code.repos]]</code>. Running them here, on demand or at the end of a run, is coming in a later update.
        </p>
      </div>
    );
  }
  return (
    <div className="code-log-scroll">
      <ol className="code-log" aria-label="Checks">
        {checks.results.map((c) => {
          const isOpen = open.has(c.command) !== (c.status === "fail");
          const status = c.status === "pass" ? "ok" : c.status === "fail" ? "failed" : "running";
          return (
            <li key={c.command} className={`code-log-item code-log-item--${status}`}>
              <div className="code-log-row">
                <button
                  type="button"
                  className="code-log-toggle"
                  aria-expanded={isOpen}
                  onClick={() => setOpen((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(c.command)) next.add(c.command);
                    return next;
                  })}
                >
                  <span className={`code-log-status code-log-status--${status}`} title={CHECK_STATUS[c.status]}>
                    <StatusIcon status={c.status} />
                    <span className="diff-sr">{CHECK_STATUS[c.status]}: </span>
                  </span>
                  <code className="code-log-cmd">{c.command}</code>
                  <span className="code-log-meta">
                    {c.exitCode !== undefined && c.exitCode !== null && c.exitCode !== 0 && <span>exit {c.exitCode}</span>}
                    {c.durationMs !== undefined && <span>{formatDuration(c.durationMs)}</span>}
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="code-log-detail">
                  {c.output ? <pre className="code-log-output">{c.output}</pre> : <p className="code-log-empty">No output.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
