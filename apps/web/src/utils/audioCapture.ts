// Microphone capture as raw samples, so a recording can be transcribed while it is still growing
// (any prefix of the samples is a complete WAV) and its loudness can be drawn as a waveform.
// MediaRecorder is avoided on purpose: its container format differs per browser and a partial
// recording is not reliably a valid file.

export const TARGET_RATE = 16_000;
/** Loudness values kept for the waveform, newest last. */
export const LEVEL_HISTORY = 48;

/** Reduce the sample rate by averaging each run of input samples; speech models want 16 kHz mono. */
export function downsample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate <= toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(chunks: Float32Array[], sampleRate = TARGET_RATE): Blob {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

/** Root-mean-square loudness of a buffer, 0 (silence) to about 1. */
export function loudness(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export interface Capture {
  /** Recent loudness values, newest last; read by the waveform on each frame. */
  levels: number[];
  /** Loudest moment so far, to tell a silent recording from speech. */
  peak: () => number;
  seconds: () => number;
  /** Everything recorded so far. */
  wav: () => Blob;
  stop: () => void;
}

export async function startCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  await ctx.resume().catch(() => undefined);
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but is the one capture path every browser still runs
  // without a separate worklet file. It only fires while connected to the destination, so it
  // goes through a silent gain to keep the microphone out of the speakers.
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  const levels: number[] = [];
  let samples = 0;
  let peak = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const level = loudness(input);
    peak = Math.max(peak, level);
    levels.push(level);
    if (levels.length > LEVEL_HISTORY) levels.shift();
    const chunk = downsample(new Float32Array(input), ctx.sampleRate);
    chunks.push(chunk);
    samples += chunk.length;
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  return {
    levels,
    peak: () => peak,
    seconds: () => samples / TARGET_RATE,
    wav: () => encodeWav(chunks),
    stop: () => {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}
