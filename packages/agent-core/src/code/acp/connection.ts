/**
 * A JSON-RPC 2.0 connection to an Agent Client Protocol agent running as a child process.
 *
 * Transport (https://agentclientprotocol.com/protocol/transports): the client starts the agent
 * and speaks over its stdin/stdout, one UTF-8 JSON message per line; messages never contain an
 * embedded newline (`JSON.stringify` escapes them). The agent may log to stderr; Rye keeps the
 * last lines for error messages. Anything on stdout that isn't a JSON-RPC message is ignored.
 *
 * Both sides send requests: Rye calls `initialize`, `session/prompt`, …; the agent calls
 * `session/request_permission` and `fs/*` on Rye (`AcpHandlers.onRequest`) and sends
 * `session/update` notifications (`AcpHandlers.onNotification`).
 *
 * The process is started through an injectable `AcpSpawn`, so tests run a fake agent script and
 * never a real CLI.
 */

import { StderrTail } from "../../harness/claude-events.js";
import { RPC_ERRORS, type JsonRpcErrorObject, type JsonRpcId } from "./protocol.js";

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

/** The agent process as the connection needs it. */
export interface AcpChildProcess {
  /** Write to stdin. Throws or ignores once stdin is closed. */
  write(data: string): void;
  closeStdin(): void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code (null when a signal ended it). */
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

export interface AcpSpawnOptions {
  cwd: string;
  /** The whole environment (nothing is inherited). */
  env: Record<string, string>;
}

/** Starts the agent: `argv[0]` is the program, with no shell. */
export type AcpSpawn = (argv: string[], o: AcpSpawnOptions) => AcpChildProcess;

/** The real spawner: `Bun.spawn` with piped stdio, no shell, and only the given env. */
export const bunAcpSpawn: AcpSpawn = (argv, o) => {
  const proc = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    write(data) {
      proc.stdin.write(data);
      void proc.stdin.flush();
    },
    closeStdin() {
      try {
        void proc.stdin.end();
      } catch {
        // Already closed.
      }
    },
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited.then((code) => (proc.signalCode ? null : code)),
    kill(signal) {
      try {
        proc.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A JSON-RPC error: one the agent answered with, or one Rye raises in a handler to answer with. */
export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/** The agent process ended (or was closed) while requests were outstanding. */
export class AcpClosedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "AcpClosedError";
  }
}

/** A request got no answer in time. */
export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`The agent didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "AcpTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

export interface AcpHandlers {
  /**
   * An agent → client request. Resolve with the result, or throw `AcpError` to answer with that
   * error (any other throw is answered as an internal error). `signal` aborts when the connection
   * closes.
   */
  onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  /** An agent → client notification (`session/update`). */
  onNotification(method: string, params: unknown): void;
  /** Called for every message, so callers can track activity (idle timeouts). */
  onActivity?(): void;
}

export interface RequestOptions {
  /** Reject with `AcpTimeoutError` after this long. Default: no timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  cleanup(): void;
}

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly incoming = new AbortController();
  private readonly stderrTail: StderrTail;
  private exitCode: number | null | undefined;
  private isClosed = false;
  /** Resolves once the process has exited and stdout is drained. */
  readonly closed: Promise<{ exitCode: number | null }>;

  constructor(
    private readonly proc: AcpChildProcess,
    private readonly handlers: AcpHandlers,
    opts: { stderrLines?: number } = {},
  ) {
    this.stderrTail = new StderrTail(opts.stderrLines ?? 8);
    const stdoutDone = this.readStdout();
    void this.readStderr();
    this.closed = Promise.all([proc.exited, stdoutDone]).then(([code]) => {
      this.exitCode = code;
      this.markClosed(code);
      return { exitCode: code };
    });
  }

  /** The last lines the agent wrote to stderr. */
  stderr(): string {
    return this.stderrTail.text();
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  /** Send a request and wait for its result. Rejects with `AcpError`, `AcpTimeoutError` or `AcpClosedError`. */
  request<T>(method: string, params: unknown, o: RequestOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new AcpClosedError(this.closedMessage(), this.exitCode ?? null));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        this.pending.get(id)?.reject(new AcpClosedError(`${method} was cancelled.`, null));
      };
      const entry: Pending = {
        method,
        resolve: (v) => {
          entry.cleanup();
          resolve(v as T);
        },
        reject: (e) => {
          entry.cleanup();
          reject(e);
        },
        cleanup: () => {
          this.pending.delete(id);
          if (timer) clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.set(id, entry);
      if (o.timeoutMs && o.timeoutMs > 0) timer = setTimeout(() => entry.reject(new AcpTimeoutError(method, o.timeoutMs!)), o.timeoutMs);
      if (o.signal) {
        if (o.signal.aborted) return onAbort();
        o.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Send a notification (`session/cancel`). Dropped once closed. */
  notify(method: string, params: unknown): void {
    if (this.isClosed) return;
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * Stop the agent: close its stdin (the polite end for a stdio server), then SIGTERM after
   * `graceMs`, then SIGKILL after as long again. Resolves once it has exited.
   */
  async close(graceMs = 2000): Promise<void> {
    this.markClosed(undefined);
    this.proc.closeStdin();
    const exited = this.closed.then(() => true);
    const wait = (ms: number) => new Promise<false>((r) => setTimeout(() => r(false), ms));
    if (await Promise.race([exited, wait(graceMs)])) return;
    this.proc.kill("SIGTERM");
    if (await Promise.race([exited, wait(graceMs)])) return;
    this.proc.kill("SIGKILL");
    await Promise.race([exited, wait(graceMs)]);
  }

  // -------------------------------------------------------------------------

  private closedMessage(): string {
    const code = this.exitCode;
    const how = code === undefined ? "was closed" : code === null ? "was killed" : `exited with code ${code}`;
    const tail = this.stderr();
    return `The agent process ${how}.${tail ? `\n${tail}` : ""}`;
  }

  private markClosed(code: number | null | undefined) {
    if (code !== undefined) this.exitCode = code;
    if (this.isClosed && this.pending.size === 0) return;
    this.isClosed = true;
    this.incoming.abort();
    const err = new AcpClosedError(this.closedMessage(), this.exitCode ?? null);
    for (const p of [...this.pending.values()]) p.reject(err);
  }

  private send(message: Record<string, unknown>) {
    try {
      this.proc.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The process is gone; `closed` reports it.
    }
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          this.handleLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) this.handleLine(buffer);
    } catch {
      // stdout broke; the exit is reported through `closed`.
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          this.stderrTail.push(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
        // Keep a runaway line from growing without bound.
        if (buffer.length > 8192) {
          this.stderrTail.push(buffer.slice(-8192));
          buffer = "";
        }
      }
      if (buffer.trim()) this.stderrTail.push(buffer);
    } catch {
      // Ignore: stderr is only for messages.
    }
  }

  private handleLine(raw: string) {
    const line = raw.trim();
    if (!line || line[0] !== "{") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    this.handlers.onActivity?.();
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";
    if (typeof msg.method === "string") {
      if (hasId) void this.answer(msg.id as JsonRpcId, msg.method, msg.params);
      else {
        try {
          this.handlers.onNotification(msg.method, msg.params);
        } catch {
          // A handler bug must not break the connection.
        }
      }
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(msg.id as JsonRpcId);
    if (!p) return;
    if (msg.error && typeof msg.error === "object") {
      const e = msg.error as JsonRpcErrorObject;
      p.reject(new AcpError(typeof e.code === "number" ? e.code : RPC_ERRORS.internalError, typeof e.message === "string" ? e.message : "Unknown error", e.data));
    } else {
      p.resolve(msg.result ?? null);
    }
  }

  private async answer(id: JsonRpcId, method: string, params: unknown) {
    try {
      const result = await this.handlers.onRequest(method, params, this.incoming.signal);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const error: JsonRpcErrorObject =
        err instanceof AcpError
          ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
          : { code: RPC_ERRORS.internalError, message: err instanceof Error ? err.message : String(err) };
      this.send({ jsonrpc: "2.0", id, error });
    }
  }
}
