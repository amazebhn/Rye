import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, StoredResultSummary } from "../../utils/types";
import { useSyncRefresh } from "../../utils/sync";

export interface ChatArtifacts {
  /** The chat session these lists belong to; differs from the one asked for while it loads. */
  sessionId: string | undefined;
  files: Artifact[];
  results: StoredResultSummary[];
  error: boolean;
  refresh: () => void;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * A chat's files (GET /artifact) and stored results (GET /result), for the header count and the
 * Artifacts panel. Refetched when the session changes, when a run in it ends, and when another tab
 * saves a result as a file or comes back into view.
 */
export function useChatArtifacts(sessionId: string | undefined, running: boolean): ChatArtifacts {
  const [state, setState] = useState<Omit<ChatArtifacts, "refresh">>({ sessionId: undefined, files: [], results: [], error: false });
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const session = sessionRef.current;
    const request = ++requestRef.current;
    if (!session) {
      setState({ sessionId: undefined, files: [], results: [], error: false });
      return;
    }
    const q = `session_id=${encodeURIComponent(session)}`;
    void Promise.all([
      getJson<{ artifacts?: Artifact[] }>(`/artifact?${q}`),
      getJson<{ results?: StoredResultSummary[] }>(`/result?${q}`),
    ])
      .then(([a, r]) => {
        if (request !== requestRef.current) return;
        setState({
          sessionId: session,
          files: Array.isArray(a.artifacts) ? [...a.artifacts].sort((x, y) => y.updatedAt - x.updatedAt) : [],
          results: Array.isArray(r.results) ? [...r.results].sort((x, y) => y.createdAt - x.createdAt) : [],
          error: false,
        });
      })
      .catch(() => {
        if (request !== requestRef.current) return;
        // Keep what this session already showed; a different session starts empty.
        setState((prev) => (prev.sessionId === session ? { ...prev, error: true } : { sessionId: session, files: [], results: [], error: true }));
      });
  }, []);

  useEffect(() => { refresh(); }, [sessionId, refresh]);

  // A run that just ended may have written files or stored results the live events didn't announce.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  }, [running, refresh]);

  useSyncRefresh("artifacts", refresh);
  // Another tab's run in this chat ends with a chat save.
  useSyncRefresh("chats", refresh);

  return { ...state, refresh };
}
