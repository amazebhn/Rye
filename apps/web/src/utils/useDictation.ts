import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture, type Capture } from "./audioCapture";

// Dictation has two engines:
//  - "local": capture the microphone in the browser and transcribe on the Rye server
//    (GET /speech/ says whether it can). Works in every browser and keeps audio on this machine.
//    While recording, the audio so far is re-transcribed every couple of seconds so words appear
//    as they are said; the last pass after stopping is the one that stays.
//  - "browser": the browser's own speech recognition, used only when the server has no transcriber.
//    It depends on the browser vendor's online speech service and is missing in Firefox.

// The DOM typings don't include speech recognition, so the shapes used are declared here.
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const canCapture = (): boolean =>
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  ("AudioContext" in window || "webkitAudioContext" in window);

const LOCAL_SETUP_HINT = "For dictation that runs on this machine, install mlx_whisper or set speech.stt_command in config.toml.";
const BROWSER_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was denied. Allow it for this site in the browser's settings.",
  "service-not-allowed": `Speech recognition is turned off in this browser. ${LOCAL_SETUP_HINT}`,
  "audio-capture": "No microphone was found.",
  network: `This browser couldn't reach its speech service. ${LOCAL_SETUP_HINT}`,
};

/** How often the recording so far is transcribed to show words as they are said. */
const LIVE_INTERVAL_MS = 1500;
/** Past this length each live pass takes too long to be worth it; the final pass still covers everything. */
const LIVE_MAX_SECONDS = 90;
/** Below this loudness nothing was said; speech models invent words for silence, so it is never sent. */
const SPEECH_LEVEL = 0.012;

/** Joins what was typed before dictation started with what has been said since. */
export function joinDictation(before: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return before;
  return before && !/\s$/.test(before) ? `${before} ${said}` : `${before}${said}`;
}

async function transcribeWav(wav: Blob): Promise<string> {
  const r = await fetch("/speech/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  const body = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!r.ok) throw new Error(body.error ?? `Transcription failed (HTTP ${r.status}).`);
  return body.text ?? "";
}

type Engine = "local" | "browser" | null;

interface Dictation {
  supported: boolean;
  listening: boolean;
  /** Local engine only: the finished recording is being turned into text. */
  transcribing: boolean;
  error: string | null;
  /** Local engine only: recent microphone loudness (newest last) for a waveform; empty otherwise. */
  levels: () => number[];
  /** Start dictating after `current`; `onText` receives the full field text. */
  start: (current: string, onText: (text: string) => void) => void;
  /** Stop listening. With `discard`, what was said is dropped instead of transcribed. */
  stop: (discard?: boolean) => void;
}

interface LocalSession {
  capture: Capture;
  timer: number;
  /** A live pass is running; the next tick waits for it. */
  busy: boolean;
  /** Set once stopped, so a live pass that returns late can't overwrite the final text. */
  done: boolean;
  finish: (discard: boolean) => void;
}

const NO_LEVELS: number[] = [];

export function useDictation(): Dictation {
  const [engine, setEngine] = useState<Engine>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const local = useRef<LocalSession | null>(null);
  const starting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fallback: Engine = recognitionCtor() ? "browser" : null;
    void fetch("/speech/")
      .then((r) => (r.ok ? (r.json() as Promise<{ stt?: boolean }>) : { stt: false }))
      .catch(() => ({ stt: false }))
      .then((status) => { if (!cancelled) setEngine(status.stt && canCapture() ? "local" : fallback); });
    return () => {
      cancelled = true;
      recognition.current?.abort();
      local.current?.finish(true);
    };
  }, []);

  const startLocal = useCallback(async (current: string, onText: (text: string) => void) => {
    let capture: Capture;
    starting.current = true;
    try {
      capture = await startCapture();
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setError(denied ? BROWSER_ERRORS["not-allowed"] : BROWSER_ERRORS["audio-capture"]);
      return;
    } finally {
      starting.current = false;
    }

    const session: LocalSession = {
      capture,
      busy: false,
      done: false,
      timer: window.setInterval(() => {
        if (session.busy || session.done) return;
        if (capture.peak() < SPEECH_LEVEL || capture.seconds() < 1 || capture.seconds() > LIVE_MAX_SECONDS) return;
        session.busy = true;
        void transcribeWav(capture.wav())
          .then((text) => { if (!session.done && text) onText(joinDictation(current, text)); })
          // A failed live pass isn't worth reporting; the final pass will say what went wrong.
          .catch(() => undefined)
          .finally(() => { session.busy = false; });
      }, LIVE_INTERVAL_MS),
      finish: (discard) => {
        if (session.done) return;
        session.done = true;
        window.clearInterval(session.timer);
        const heard = capture.peak() >= SPEECH_LEVEL;
        const wav = capture.wav();
        capture.stop();
        local.current = null;
        setListening(false);
        if (discard) return;
        if (!heard) {
          setError("Nothing was heard. Check the microphone and try again.");
          return;
        }
        setTranscribing(true);
        void transcribeWav(wav)
          .then((text) => {
            if (text) onText(joinDictation(current, text));
            else setError("Nothing was heard in that recording.");
          })
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setTranscribing(false));
      },
    };
    local.current = session;
    setListening(true);
  }, []);

  const startBrowser = useCallback((current: string, onText: (text: string) => void) => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event) => {
      let spoken = "";
      for (let i = 0; i < event.results.length; i++) spoken += event.results[i][0].transcript;
      onText(joinDictation(current, spoken));
    };
    rec.onerror = (event) => {
      // "no-speech" and "aborted" just mean nothing was said or the user stopped.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError(BROWSER_ERRORS[event.error] ?? `Dictation stopped (${event.error}).`);
      }
    };
    rec.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    try {
      rec.start();
      recognition.current = rec;
      setListening(true);
    } catch {
      setError("Dictation couldn't start.");
    }
  }, []);

  const start = useCallback(
    (current: string, onText: (text: string) => void) => {
      if (listening || transcribing || starting.current || local.current || recognition.current) return;
      setError(null);
      if (engine === "local") void startLocal(current, onText);
      else if (engine === "browser") startBrowser(current, onText);
    },
    [engine, listening, transcribing, startLocal, startBrowser],
  );

  const stop = useCallback((discard = false) => {
    recognition.current?.stop();
    local.current?.finish(discard);
  }, []);

  const levels = useCallback(() => local.current?.capture.levels ?? NO_LEVELS, []);

  return { supported: engine !== null, listening, transcribing, error, levels, start, stop };
}
