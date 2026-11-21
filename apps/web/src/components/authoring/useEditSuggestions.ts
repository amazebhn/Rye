import { useEffect, useState } from "react";
import type { EditSuggestion } from "./AiEmptyState";

const TIMEOUT_MS = 10_000;
const MAX_CACHED = 30;

// Session cache so reopening an unchanged document skips the loading state entirely.
const sessionCache = new Map<string, EditSuggestion[]>();

function cacheKey(kind: string, title: string, content: string): string {
  return `${kind}\0${title}\0${content}`;
}

interface State {
  suggestions: EditSuggestion[];
  loading: boolean;
  tailored: boolean;
}

function initialState(key: string, fallback: EditSuggestion[]): State {
  const cached = sessionCache.get(key);
  return cached ? { suggestions: cached, loading: false, tailored: true } : { suggestions: fallback, loading: true, tailored: false };
}

/** Document-specific edit prompts, cached until the document changes, with static defaults as fallback. */
export function useEditSuggestions(
  kind: "sop" | "skill",
  title: string,
  content: string,
  fallback: EditSuggestion[],
): State {
  const key = cacheKey(kind, title, content);
  const [state, setState] = useState<State>(() => initialState(key, fallback));

  useEffect(() => {
    const cached = sessionCache.get(key);
    if (cached) {
      setState({ suggestions: cached, loading: false, tailored: true });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    setState({ suggestions: fallback, loading: true, tailored: false });

    fetch("/chat/edit-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, title, content }),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ suggestions?: EditSuggestion[] }>) : null))
      .then((data) => {
        if (cancelled) return;
        const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
        if (suggestions.length > 0) {
          sessionCache.delete(key);
          sessionCache.set(key, suggestions);
          if (sessionCache.size > MAX_CACHED) sessionCache.delete(sessionCache.keys().next().value as string);
        }
        setState({ suggestions: suggestions.length > 0 ? suggestions : fallback, loading: false, tailored: suggestions.length > 0 });
      })
      .catch(() => {
        if (!cancelled) setState({ suggestions: fallback, loading: false, tailored: false });
      })
      .finally(() => window.clearTimeout(timer));

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
    // Fallback is a static module constant; re-fetch only when the document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
