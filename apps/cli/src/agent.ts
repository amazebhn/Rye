import { createParser } from "eventsource-parser";
import type { SSEEvent } from "@rye/shared";
import { getEffectiveAgentUrl } from "./config.js";

export async function* streamChat(
  message: string,
  sessionId?: string
): AsyncGenerator<SSEEvent> {
  const agentUrl = getEffectiveAgentUrl();

  const response = await fetch(`${agentUrl}/chat/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_id: sessionId }),
  });

  if (!response.ok) {
    throw new Error(`Agent error: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const queue: SSEEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const parser = createParser((event) => {
    if (event.type === "event" || event.type === "data" || (event as any).data) {
      const data = (event as any).data;
      if (data && data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data) as SSEEvent;
          queue.push(parsed);
          resolve?.();
        } catch {
          // ignore parse errors
        }
      }
    }
  });

  // Feed the stream
  (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      done = true;
      resolve?.();
    }
  })();

  // Yield events
  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else if (done) {
      break;
    } else {
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  }
}

export async function checkAgentHealth(): Promise<boolean> {
  const agentUrl = getEffectiveAgentUrl();
  try {
    const resp = await fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}
