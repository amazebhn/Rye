/**
 * Code sessions: the web client for every `/code/` route in the contract (`packages/shared/src/code.ts`,
 * whose header lists the routes). Types come from `@rye/shared` only.
 *
 * Every mutation sends JSON (the server's local-origin guard accepts nothing else). Errors throw a
 * `CodeApiError` carrying the server's `{ error, code }`.
 *
 * Nothing in the app shows a code-session entry point until `GET /code/engines` answers with a real
 * engines list (`useCodeAvailable`): with a backend that has no `/code/` routes the probe gets a 404
 * (or the dev server's index.html) and everything stays hidden, without an error. A backend whose
 * `[code]` isn't set up answers a JSON `not_found` 404 instead (`useCodeSetup` → `"setup"`): only
 * + ▸ Create ▸ Code session… and Settings → Code show then, with how to set it up.
 */

import { useSyncExternalStore } from "react";
import type {
  ApprovalAnswerRequest,
  ChangesSince,
  CodeBranchesResponse,
  CodeChangesResponse,
  CodeCommandsResponse,
  CodeEnginesResponse,
  CodeErrorResponse,
  CodeFileDiffResponse,
  CodeOkResponse,
  CodePolicyResponse,
  CodeReposResponse,
  CodeSessionDetail,
  CodeSessionState,
  CodeSessionStatus,
  CodeSessionSummary,
  CodeSnapshotsResponse,
  CreateBranchRequest,
  CreateBranchResponse,
  CreateCodeSessionRequest,
  CreateCodeSessionResponse,
  DeleteCodeSessionResponse,
  DiscardFilesResponse,
  DraftBranchMessageResponse,
  ListCodeSessionsResponse,
  MergeResult,
  MergeWithBaseRequest,
  SSEEvent,
} from "@rye/shared";
import { onSyncMessage } from "./sync";

export class CodeApiError extends Error {
  readonly status: number;
  readonly code?: CodeErrorResponse["code"];
  constructor(message: string, status: number, code?: CodeErrorResponse["code"]) {
    super(message);
    this.name = "CodeApiError";
    this.status = status;
    this.code = code;
  }
}

const enc = encodeURIComponent;

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    signal,
  });
  const type = res.headers.get("content-type") ?? "";
  const data = (type.includes("json") ? await res.json().catch(() => null) : null) as (T & Partial<CodeErrorResponse>) | null;
  if (!res.ok) {
    throw new CodeApiError(data?.error ?? `Request failed (HTTP ${res.status}).`, res.status, data?.code);
  }
  if (data === null) throw new CodeApiError("The server answered without JSON.", res.status);
  return data;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") q.set(key, String(value));
  const s = q.toString();
  return s ? `?${s}` : "";
};

const session = (id: string, rest = "") => `/code/sessions/${enc(id)}${rest}`;

/** One function per route in the contract's table, in its order. */
export const codeApi = {
  repos: (signal?: AbortSignal) => request<CodeReposResponse>("GET", "/code/repos", undefined, signal),
  branches: (repo: string, signal?: AbortSignal) => request<CodeBranchesResponse>("GET", `/code/repos/${enc(repo)}/branches`, undefined, signal),
  engines: (signal?: AbortSignal) => request<CodeEnginesResponse>("GET", "/code/engines", undefined, signal),
  policy: (signal?: AbortSignal) => request<CodePolicyResponse>("GET", "/code/policy", undefined, signal),
  sessions: (q: { status?: CodeSessionState | "all"; chat?: string } = {}, signal?: AbortSignal) =>
    request<ListCodeSessionsResponse>("GET", `/code/sessions${query(q)}`, undefined, signal),
  create: (body: CreateCodeSessionRequest) => request<CreateCodeSessionResponse>("POST", "/code/sessions", body),
  detail: (id: string, signal?: AbortSignal) => request<CodeSessionDetail>("GET", session(id), undefined, signal),
  status: (id: string, signal?: AbortSignal) => request<CodeSessionStatus>("GET", session(id, "/status"), undefined, signal),
  /** The event stream URL; read it with `subscribeCodeEvents`. */
  eventsUrl: (id: string, after = 0) => session(id, `/events${query({ after })}`),
  stop: (id: string) => request<CodeOkResponse>("POST", session(id, "/stop"), {}),
  answer: (id: string, promptId: string, body: ApprovalAnswerRequest) =>
    request<CodeOkResponse>("POST", session(id, `/approvals/${enc(promptId)}`), body),
  changes: (id: string, since: ChangesSince = "base", signal?: AbortSignal) =>
    request<CodeChangesResponse>("GET", session(id, `/changes${query({ since: since === "base" ? undefined : since })}`), undefined, signal),
  diff: (id: string, path: string, since: ChangesSince = "base", signal?: AbortSignal) =>
    request<CodeFileDiffResponse>("GET", session(id, `/diff${query({ path, since: since === "base" ? undefined : since })}`), undefined, signal),
  snapshots: (id: string, signal?: AbortSignal) => request<CodeSnapshotsResponse>("GET", session(id, "/snapshots"), undefined, signal),
  commands: (id: string, signal?: AbortSignal) => request<CodeCommandsResponse>("GET", session(id, "/commands"), undefined, signal),
  stage: (id: string, paths: string[], staged: boolean) => request<CodeChangesResponse>("POST", session(id, "/files/stage"), { paths, staged }),
  discard: (id: string, paths: string[]) => request<DiscardFilesResponse>("POST", session(id, "/files/discard"), { paths }),
  draftBranchMessage: (id: string) => request<DraftBranchMessageResponse>("POST", session(id, "/branch/message"), {}),
  createBranch: (id: string, body: CreateBranchRequest) => request<CreateBranchResponse>("POST", session(id, "/branch"), body),
  merge: (id: string, body: MergeWithBaseRequest = {}) => request<MergeResult>("POST", session(id, "/merge"), body),
  archive: (id: string) => request<CodeSessionDetail>("POST", session(id, "/archive"), {}),
  restore: (id: string) => request<CodeSessionDetail>("POST", session(id, "/restore"), {}),
  remove: (id: string) => request<DeleteCodeSessionResponse>("DELETE", session(id)),
};

/**
 * Sends a message into a code chat. As for any chat it is `POST /chat/`; the server dispatches by the
 * chat's kind, and starts a turn or steers the running one. The answer is the session's event stream,
 * which this doesn't read (the view follows `/events` instead, so nothing is shown twice); closing it
 * never stops the run.
 */
export async function sendCodeMessage(body: {
  chatId: string;
  sessionId?: string;
  message: string;
  turnId: string;
  attachments?: string[];
  /** Quotes picked for the message, as the server takes them (`refForServer`). */
  references?: unknown[];
}): Promise<void> {
  const res = await fetch("/chat/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      message: body.message,
      chat_id: body.chatId,
      ...(body.sessionId ? { session_id: body.sessionId } : {}),
      turn_id: body.turnId,
      ...(body.attachments?.length ? { attachments: body.attachments } : {}),
      ...(body.references?.length ? { references: body.references } : {}),
    }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new CodeApiError(detail?.error ?? `Couldn't send (HTTP ${res.status}).`, res.status);
  }
  void res.body?.cancel().catch(() => {});
}

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

export interface CodeEventSubscription {
  close(): void;
}

/**
 * Follows `GET /code/sessions/:id/events?after=<seq>`: replays logged events after `after`, then live
 * ones. Reconnects after a dropped connection from the last sequence number seen, so nothing is lost or
 * repeated. `onState` reports whether the stream is connected (for a quiet "reconnecting" hint).
 */
export function subscribeCodeEvents(
  id: string,
  after: number,
  onEvent: (event: SSEEvent, seq: number) => void,
  onState?: (state: "open" | "retrying" | "gone") => void,
): CodeEventSubscription {
  let lastSeq = after;
  let closed = false;
  let controller: AbortController | null = null;
  let retry: number | undefined;
  let delay = 1000;

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    let opened = false;
    try {
      const res = await fetch(codeApi.eventsUrl(id, lastSeq), { headers: { Accept: "text/event-stream" }, signal: controller.signal });
      if (res.status === 404) {
        onState?.("gone");
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onState?.("open");
      opened = true;
      delay = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let frameId: number | undefined;
      let data: string[] = [];
      const dispatch = () => {
        if (data.length === 0) {
          frameId = undefined;
          return;
        }
        const raw = data.join("\n");
        data = [];
        try {
          const event = JSON.parse(raw) as SSEEvent;
          const seq = typeof event.seq === "number" ? event.seq : frameId;
          frameId = undefined;
          // A replay that overlaps what was already seen (after a reconnect) is skipped.
          if (seq !== undefined && seq <= lastSeq) return;
          if (seq !== undefined) lastSeq = seq;
          onEvent(event, seq ?? lastSeq);
        } catch {
          // A malformed frame is skipped; the next one carries on.
        }
      };
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
          else if (line.startsWith("id:")) {
            const n = Number(line.slice(3).trim());
            if (Number.isFinite(n)) frameId = n;
          }
        }
      }
      dispatch();
    } catch {
      if (closed) return;
    }
    if (closed) return;
    // A stream that ended after it opened (the server closed it) is picked up again quietly; only a
    // failed connection counts as "reconnecting".
    if (!opened) onState?.("retrying");
    retry = window.setTimeout(() => void connect(), delay);
    if (!opened) delay = Math.min(delay * 2, 15_000);
  };

  void connect();
  return {
    close() {
      closed = true;
      window.clearTimeout(retry);
      controller?.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// Availability and the session list, shared within the tab
// ---------------------------------------------------------------------------

/**
 * What `GET /code/engines` says about code sessions here:
 * - `available`: it answered `{ engines: [...] }`;
 * - `setup`: a JSON 404 with `code: "not_found"`: the server has code sessions but `[code]` isn't set up;
 * - `unsupported`: anything else (an older backend, the dev server's index.html), and until the first answer.
 */
export type CodeSetup = "available" | "setup" | "unsupported";

interface CodeState {
  /** null until the first probe answers. */
  engines: CodeEnginesResponse | null;
  available: boolean;
  setup: CodeSetup;
  sessions: CodeSessionSummary[];
}

let state: CodeState = { engines: null, available: false, setup: "unsupported", sessions: [] };
const listeners = new Set<() => void>();
let probing: Promise<void> | null = null;
let lastProbe = 0;
let sessionsTimer: number | undefined;
let started = false;

function setState(patch: Partial<CodeState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function looksLikeEngines(data: unknown): data is CodeEnginesResponse {
  return typeof data === "object" && data !== null && Array.isArray((data as CodeEnginesResponse).engines);
}

/** Asks `GET /code/engines` whether code sessions exist on this server. Quiet on any failure. */
export function probeCodeSessions(force = false): Promise<void> {
  if (probing) return probing;
  // At most once a minute (on focus), so a server without code sessions isn't asked over and over.
  if (!force && Date.now() - lastProbe < 60_000) return Promise.resolve();
  lastProbe = Date.now();
  probing = fetch("/code/engines", { headers: { Accept: "application/json" } })
    .then(async (res) => {
      const type = res.headers.get("content-type") ?? "";
      // The dev proxy's own error (the server is restarting): keep what was known, as for no answer.
      if (res.status >= 500 && !type.includes("json")) return;
      const json = (res.ok || res.status === 404) && type.includes("json");
      const data = json ? ((await res.json().catch(() => null)) as unknown) : null;
      if (res.ok && looksLikeEngines(data)) {
        const wasAvailable = state.available;
        setState({ engines: data, available: true, setup: "available" });
        if (!wasAvailable) void refreshCodeSessions();
      } else {
        const notSetUp = res.status === 404 && (data as Partial<CodeErrorResponse> | null)?.code === "not_found";
        setState({ engines: null, available: false, setup: notSetUp ? "setup" : "unsupported", sessions: [] });
      }
    })
    // The server didn't answer at all (restarting): keep what was known.
    .catch(() => {})
    .finally(() => {
      probing = null;
    });
  return probing;
}

/** Re-reads `GET /code/sessions` (active ones) for the sidebar and the parent-chat cards. */
export async function refreshCodeSessions(): Promise<void> {
  if (!state.available) return;
  try {
    const { sessions } = await codeApi.sessions({ status: "active" });
    if (Array.isArray(sessions)) setState({ sessions });
  } catch {
    // Keep what was shown; the next refresh tries again.
  }
  scheduleSessions();
}

// Polls only while code sessions exist here: quickly while one is running or waiting, slowly otherwise.
function scheduleSessions() {
  window.clearTimeout(sessionsTimer);
  if (!state.available || document.hidden) return;
  const busy = state.sessions.some((s) => s.activity === "running" || s.activity === "needs_approval");
  sessionsTimer = window.setTimeout(() => void refreshCodeSessions(), busy ? 4000 : 30_000);
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  void probeCodeSessions(true);
  const onShow = () => {
    if (document.hidden) {
      window.clearTimeout(sessionsTimer);
      return;
    }
    void probeCodeSessions().then(() => refreshCodeSessions());
  };
  document.addEventListener("visibilitychange", onShow);
  window.addEventListener("focus", onShow);
  onSyncMessage((msg) => {
    if (msg.kind === "changed" && (msg.topic === "code" || msg.topic === "chats")) void refreshCodeSessions();
  });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getState = () => state;

/** Code sessions exist on this server (`GET /code/engines` answered). Every entry point hides until then. */
export function useCodeAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => getState().available, () => false);
}

/** Available, known but not set up (+ ▸ Create and Settings → Code then show how), or unsupported. */
export function useCodeSetup(): CodeSetup {
  return useSyncExternalStore(subscribe, () => getState().setup, () => "unsupported" as const);
}

/** The engines list (`GET /code/engines`), or null while unknown or unavailable. */
export function useCodeEngines(): CodeEnginesResponse | null {
  return useSyncExternalStore(subscribe, () => getState().engines, () => null);
}

/** Active code sessions, newest first; empty while code sessions are unavailable. */
export function useCodeSessionList(): CodeSessionSummary[] {
  return useSyncExternalStore(subscribe, () => getState().sessions, () => state.sessions);
}

/** Updates one session in the shared list (from a `code_status` event), so the sidebar follows at once. */
export function noteCodeStatus(status: CodeSessionStatus): void {
  const at = state.sessions.findIndex((s) => s.id === status.sessionId);
  if (at === -1) return;
  const current = state.sessions[at];
  const stat = status.branch?.stat ?? current.stat;
  if (current.activity === status.activity && current.costUsd === status.costUsd && current.stat === stat) return;
  const sessions = [...state.sessions];
  sessions[at] = { ...current, activity: status.activity, costUsd: status.costUsd, stat, updatedAt: status.updatedAt };
  setState({ sessions });
  scheduleSessions();
}
