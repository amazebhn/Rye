import { Hono } from "hono";
import { getSettings } from "../config.js";
import { MAX_AUDIO_BYTES, audioExtension, resolveSttCommand, transcribe, type Transcription } from "./transcribe.js";

interface SpeechDeps {
  command?: () => string | null;
  run?: (command: string, audio: Uint8Array, extension: string) => Promise<Transcription>;
}

export function speechRoutes(deps: SpeechDeps = {}): Hono {
  const command = deps.command ?? (() => resolveSttCommand(getSettings().speech.stt_command));
  const run = deps.run ?? transcribe;
  const r = new Hono();

  // Whether dictation can be transcribed on this machine.
  r.get("/", (c) => c.json({ stt: command() !== null }));

  r.post("/transcribe", async (c) => {
    const cmd = command();
    if (!cmd) return c.json({ error: "No speech-to-text command is configured (speech.stt_command)." }, 501);
    const extension = audioExtension(c.req.header("content-type"));
    if (!extension) return c.json({ error: "Send the recording as audio (mp4, webm, ogg, wav or mp3)." }, 415);
    if (Number(c.req.header("content-length") ?? 0) > MAX_AUDIO_BYTES) {
      return c.json({ error: `Recording is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB` }, 413);
    }
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length === 0) return c.json({ error: "The recording is empty." }, 400);
    if (audio.length > MAX_AUDIO_BYTES) return c.json({ error: `Recording is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB` }, 413);
    const result = await run(cmd, audio, extension);
    return "error" in result ? c.json(result, 502) : c.json(result);
  });

  return r;
}
