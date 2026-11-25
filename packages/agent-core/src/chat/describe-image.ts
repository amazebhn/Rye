/**
 * Describing attached images with a local vision model, so a later turn (and
 * a model that can't see) still knows what an image showed, and chat search
 * can find it. Runs in the background after upload; never sends the image
 * anywhere but the local Ollama.
 */

import { getSettings, type Settings } from "../config.js";
import { listOllamaModels } from "../embeddings/models.js";
import type { ImageCaptioner } from "./attachments.js";

const PROMPT =
  "Describe this image for someone who can't see it, in one or two plain sentences: what it is and the important details " +
  "(for a screenshot: the app or page, any error text, key numbers). Then give up to 8 short lowercase tags. " +
  'Reply only with JSON: {"description": "...", "tags": ["..."]}';

/** The vision model to use: the configured one, else the smallest installed model with vision. Null when there is none. */
export async function pickVisionModel(settings: Settings, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const configured = settings.attachments.vision_model.trim();
  if (configured === "off") return null;
  if (configured) return configured;
  // It has to write text: embedding and decision models can report vision too.
  const vision = (await listOllamaModels(settings, fetchFn)).filter((m) => m.capabilities.includes("vision") && m.capabilities.includes("completion"));
  vision.sort((a, b) => (a.size || Infinity) - (b.size || Infinity));
  return vision[0]?.name ?? null;
}

/** Pull `{description, tags}` out of a model reply, tolerating a code fence or text around the JSON. */
export function parseDescription(reply: string): { caption: string; tags: string[] } | null {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { description?: unknown; tags?: unknown };
    const caption = typeof parsed.description === "string" ? parsed.description.trim().slice(0, 600) : "";
    if (!caption) return null;
    const tags = Array.isArray(parsed.tags)
      ? [...new Set(parsed.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8)
      : [];
    return { caption, tags };
  } catch {
    return null;
  }
}

/** A captioner that asks the local vision model, or null when no vision model is available. */
export function ollamaImageDescriber(fetchFn: typeof fetch = fetch): ImageCaptioner {
  return async (image) => {
    const settings = getSettings();
    const model = await pickVisionModel(settings, fetchFn);
    if (!model) return null;
    const res = await fetchFn(`${settings.ollama.base_url.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT, images: [image.data] }],
        stream: false,
        think: false,
        format: "json",
        keep_alive: "5m",
        options: { temperature: 0 },
      }),
      // A large model may have to load first.
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(`${model}: Ollama HTTP ${res.status}${detail ? ` (${detail.split("\n")[0].slice(0, 200)})` : ""}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return parseDescription(data.message?.content ?? "");
  };
}
