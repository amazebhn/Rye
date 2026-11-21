/**
 * Per-run approval for skill scripts.
 *
 * Unlike MCP tools there is no "always" option: an approval is bound to the exact
 * (skill, script content, interpreter, args) fingerprint and is consumed by one run.
 * The agent loop mints a ScriptApprovalToken from a granted approval and passes it to
 * executeTool; the tool refuses to run without a valid, unspent token for that fingerprint.
 */

import { APPROVE_ONCE } from "../mcp/approval.js";

const GRANT_TTL_MS = 15 * 60_000;

const pending = new Map<string, string>();
const granted = new Map<string, Map<string, number>>();
const denied = new Map<string, Set<string>>();

class Token {
  used = false;
  constructor(readonly fingerprint: string) {}
}

/** Opaque proof that the user approved one specific script run. */
export type ScriptApprovalToken = Pick<Token, "fingerprint">;

export function isScriptApprovalToken(x: unknown): x is ScriptApprovalToken {
  return x instanceof Token;
}

/** Spend the token for `fingerprint`; false when it is missing, mismatched or already spent. */
export function spendScriptApprovalToken(token: unknown, fingerprint: string): boolean {
  if (!(token instanceof Token) || token.used || token.fingerprint !== fingerprint) return false;
  token.used = true;
  return true;
}

export function setPendingScript(sessionId: string, fingerprint: string): void {
  pending.set(sessionId, fingerprint);
}

export function getPendingScript(sessionId: string): string | undefined {
  return pending.get(sessionId);
}

/**
 * Apply the user's answer to the outstanding script prompt. Only the exact "Allow once"
 * label approves; anything else denies.
 */
export function resolvePendingScript(sessionId: string, answer: string): "approved" | "denied" | null {
  const fingerprint = pending.get(sessionId);
  if (!fingerprint) return null;
  pending.delete(sessionId);

  if (answer.trim().toLowerCase() === APPROVE_ONCE.toLowerCase()) {
    const map = granted.get(sessionId) ?? new Map<string, number>();
    map.set(fingerprint, Date.now() + GRANT_TTL_MS);
    granted.set(sessionId, map);
    return "approved";
  }
  const set = denied.get(sessionId) ?? new Set<string>();
  set.add(fingerprint);
  denied.set(sessionId, set);
  return "denied";
}

/** Consume a granted approval for this exact fingerprint, returning a single-use token. */
export function consumeScriptApproval(sessionId: string, fingerprint: string): ScriptApprovalToken | null {
  const map = granted.get(sessionId);
  const expiresAt = map?.get(fingerprint);
  if (!map || expiresAt === undefined) return null;
  map.delete(fingerprint);
  return expiresAt > Date.now() ? new Token(fingerprint) : null;
}

export function wasScriptDenied(sessionId: string, fingerprint: string): boolean {
  return denied.get(sessionId)?.has(fingerprint) === true;
}

export type ScriptGate = { action: "run"; token: ScriptApprovalToken } | { action: "denied" } | { action: "ask" };

/**
 * What the agent loop does with a planned run: use a granted approval (spent here, one run only),
 * report that the user already denied it, or ask — which records the prompt as pending.
 */
export function gateScriptRun(sessionId: string, fingerprint: string): ScriptGate {
  if (wasScriptDenied(sessionId, fingerprint)) return { action: "denied" };
  const token = consumeScriptApproval(sessionId, fingerprint);
  if (token) return { action: "run", token };
  setPendingScript(sessionId, fingerprint);
  return { action: "ask" };
}

/** Drop approvals and denials left over from the previous run (keeps any pending prompt). */
export function expireScriptApprovals(sessionId: string): void {
  granted.delete(sessionId);
  denied.delete(sessionId);
}

export function clearScriptApprovals(sessionId: string): void {
  expireScriptApprovals(sessionId);
  pending.delete(sessionId);
}
