/**
 * In-process deletion tombstones coordinate active agent runs with HTTP
 * deletion. Session ids are UUIDs, so a deleted id is never intentionally
 * reused during the lifetime of this process.
 */
const deletedSessions = new Set<string>();

export function markSessionDeleted(sessionId: string): void {
  deletedSessions.add(sessionId);
}

export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessions.has(sessionId);
}
