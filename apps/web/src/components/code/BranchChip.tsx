import React, { useEffect, useState } from "react";
import { Archive, ArrowDownUp, Check, CircleDollarSign, Copy, ExternalLink, FileDiff, GitBranch, ShieldCheck, ShieldOff, X } from "lucide-react";
import type { CodePolicyResponse, CodeSessionDetail, CodeSessionStatus } from "@rye/shared";
import { codeApi } from "../../utils/codeApi";
import Modal from "../shared/Modal";
import CodeMenu from "./CodeMenu";
import { formatCost } from "./codeFormat";

let policyCache: Promise<CodePolicyResponse> | null = null;
/** The policy (and sandbox status) rarely changes within a page's life; read it once. */
export function loadPolicy(force = false): Promise<CodePolicyResponse> {
  if (!policyCache || force) {
    policyCache = codeApi.policy();
    policyCache.catch(() => { policyCache = null; });
  }
  return policyCache;
}

function useSandbox(): CodePolicyResponse["sandbox"] | null {
  const [sandbox, setSandbox] = useState<CodePolicyResponse["sandbox"] | null>(null);
  useEffect(() => {
    let live = true;
    loadPolicy().then((p) => { if (live) setSandbox(p.sandbox); }, () => {});
    return () => { live = false; };
  }, []);
  return sandbox;
}

/** `rye/add-x-0bc9` → `add-x-0bc9`: every session branch starts with `rye/`. */
function shortBranch(name: string): string {
  return name.replace(/^rye\//, "");
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The facts behind the chip, as quiet menu lines: where the work is and what it has done. */
function BranchFacts({ detail, status }: { detail: CodeSessionDetail; status: CodeSessionStatus | null }) {
  const sandbox = useSandbox();
  const branch = status?.branch ?? null;
  const name = branch?.branch ?? detail.branch;
  const checks = status?.checks;
  const cost = status?.costUsd ?? detail.costUsd;
  const files = branch?.stat.files ?? detail.stat.files;
  return (
    <div className="code-facts">
      <p className="code-facts-repo">{detail.repo}</p>
      <p className="code-facts-branch" title={detail.baseUnborn ? `${detail.base} had no commits yet` : `${detail.base} at ${detail.baseSha.slice(0, 7)}`}>
        <GitBranch size={14} aria-hidden="true" />
        <span>
          <span className="code-facts-mono">{name}</span>
          <span className="code-facts-dim"> ← </span>
          <span className="diff-sr">from </span>
          <span className="code-facts-mono code-facts-dim">{detail.base}</span>
        </span>
      </p>
      {branch && (
        <p className="code-facts-line">
          <ArrowDownUp size={14} aria-hidden="true" />
          <span>
            {branch.ahead} ahead · <span className={branch.behind > 0 ? "code-facts-warn" : undefined}>{branch.behind} behind</span> {detail.base}
          </span>
        </p>
      )}
      <p className="code-facts-line">
        <FileDiff size={14} aria-hidden="true" />
        <span>
          {files === 0 ? "No files changed" : `${plural(files, "file")} changed`}
          {branch?.dirty && <span className="code-facts-dim"> · {branch.dirtyFiles} not committed</span>}
        </span>
      </p>
      {checks && checks.passed + checks.failed + checks.running > 0 && (
        <p className="code-facts-line">
          {checks.failed > 0 ? <X size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          <span>
            Checks: {checks.passed} passed{checks.failed > 0 && <span className="code-facts-fail">, {checks.failed} failed</span>}
            {checks.running > 0 && `, ${checks.running} running`}
          </span>
        </p>
      )}
      <p className="code-facts-line">
        <CircleDollarSign size={14} aria-hidden="true" />
        <span>{formatCost(cost)} so far</span>
      </p>
      {sandbox && (
        <p className={`code-facts-line${sandbox.available ? "" : " code-facts-warn"}`} title={sandbox.available ? undefined : sandbox.reason}>
          {sandbox.available ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldOff size={14} aria-hidden="true" />}
          <span>{sandbox.available ? `Sandboxed${sandbox.mechanism ? ` (${sandbox.mechanism})` : ""}` : "No OS sandbox"}</span>
        </p>
      )}
      {detail.state === "archived" && (
        <p className="code-facts-line">
          <Archive size={14} aria-hidden="true" />
          <span>Archived</span>
        </p>
      )}
    </div>
  );
}

/** "Continue in terminal": copies the resume command, which runs outside Rye's policy. */
function ResumeRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      role="menuitem"
      className="sidebar-dropdown-item"
      onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true), () => {})}
      title={`Copies: ${command}\nThe terminal runs outside Rye's policy and sandbox.`}
    >
      {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
      <span>{copied ? "Copied the command" : "Continue in terminal"}</span>
    </button>
  );
}

/**
 * The header's branch chip: the session's branch, short, with a dot when the base has moved on. It opens
 * the session's details (repo, branch ← base, ahead/behind, files, checks, cost, sandbox) with Open in
 * editor and Continue in terminal under them; on a phone, the details as a sheet.
 */
export default function BranchChip({ detail, status, phone }: { detail: CodeSessionDetail; status: CodeSessionStatus | null; phone: boolean }) {
  const [sheet, setSheet] = useState(false);
  const branch = status?.branch ?? null;
  const name = branch?.branch ?? detail.branch;
  const behind = (branch?.behind ?? 0) > 0;
  const archived = detail.state === "archived";
  const label = `Branch ${name}${behind ? `, ${branch!.behind} behind ${detail.base}` : ""}`;
  const chip = (
    <>
      <GitBranch size={14} aria-hidden="true" />
      {!phone && <span className="code-branch-name">{shortBranch(name)}</span>}
      {behind && <span className="code-branch-dot" aria-hidden="true" />}
    </>
  );

  if (phone) {
    return (
      <>
        <button type="button" className="chat-header-db-btn code-branch-chip code-branch-chip--icon" onClick={() => setSheet(true)} aria-label={label} title={`${name} ← ${detail.base}`}>
          {chip}
        </button>
        {sheet && (
          <Modal title="Branch" className="modal--compact code-facts-sheet" onClose={() => setSheet(false)}>
            <BranchFacts detail={detail} status={status} />
          </Modal>
        )}
      </>
    );
  }

  return (
    <CodeMenu label={label} title={`${name} ← ${detail.base}${behind ? ` (${branch!.behind} behind)` : ""}`} trigger={chip} triggerClassName="code-branch-chip" menuClassName="code-branch-pop">
      {(close) => (
        <>
          <BranchFacts detail={detail} status={status} />
          {!archived && (detail.editorUrl || detail.resumeCommand) && (
            <>
              <div className="sidebar-dropdown-separator" role="separator" />
              {detail.editorUrl && (
                <a role="menuitem" className="sidebar-dropdown-item" href={detail.editorUrl} onClick={close} title="Open the session's workspace in your editor">
                  <ExternalLink size={17} aria-hidden="true" />
                  <span>Open in editor</span>
                </a>
              )}
              {detail.resumeCommand && <ResumeRow command={detail.resumeCommand} />}
            </>
          )}
        </>
      )}
    </CodeMenu>
  );
}
