/**
 * Speech-to-text for dictation, run locally by a command-line transcriber.
 *
 * The command comes from `speech.stt_command`; left blank, Rye looks for
 * mlx_whisper (Whisper on Apple silicon). Audio never leaves the machine
 * unless the configured command sends it somewhere.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";

const EXTENSIONS: Record<string, string> = {
  "audio/mp4": "mp4",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
};

/** "audio/webm;codecs=opus" → "webm"; null for anything that isn't a known audio type. */
export function audioExtension(contentType: string | undefined): string | null {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return EXTENSIONS[base] ?? null;
}

/** Split a command line into arguments, honouring single and double quotes. No shell is involved. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of command.matchAll(re)) args.push(m[1] ?? m[2] ?? m[3]);
  return args;
}

/**
 * The argv for one transcription. `{input}` and `{output_dir}` in the command
 * are replaced; a command that names neither gets the audio path appended.
 */
export function buildArgv(command: string, input: string, outputDir: string): string[] {
  const parts = splitCommand(command);
  const filled = parts.map((p) => p.replaceAll("{input}", input).replaceAll("{output_dir}", outputDir));
  return parts.some((p) => p.includes("{input}")) ? filled : [...filled, input];
}

/** A working mlx_whisper: on PATH (pyenv shims only work in the right environment, so they're skipped) or in a pyenv environment. */
export function findMlxWhisper(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || dir.includes(join(".pyenv", "shims"))) continue;
    const candidate = join(dir, "mlx_whisper");
    if (existsSync(candidate)) return candidate;
  }
  const versions = join(home, ".pyenv", "versions");
  try {
    for (const name of readdirSync(versions).sort().reverse()) {
      const candidate = join(versions, name, "bin", "mlx_whisper");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // no pyenv
  }
  return null;
}

/** The command that will be used, or null when dictation can't be transcribed on this machine. */
export function resolveSttCommand(configured: string, find: () => string | null = findMlxWhisper): string | null {
  if (configured.trim()) return configured.trim();
  const mlx = find();
  return mlx ? `"${mlx}" {input} --model ${DEFAULT_MODEL} --output-format txt --output-dir {output_dir} --verbose False` : null;
}

export type Transcription = { text: string } | { error: string };

/**
 * Transcribe one recording. The transcript is the .txt file the command wrote
 * to the output directory, or else whatever it printed.
 */
export async function transcribe(command: string, audio: Uint8Array, extension: string): Promise<Transcription> {
  const dir = mkdtempSync(join(tmpdir(), "rye-stt-"));
  try {
    const input = join(dir, `recording.${extension}`);
    const outputDir = join(dir, "out");
    writeFileSync(input, audio);
    const argv = buildArgv(command, input, outputDir);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      return { error: `Couldn't start the transcriber (${argv[0]}): ${err instanceof Error ? err.message : String(err)}` };
    }
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) {
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      return { error: `The transcriber exited with code ${code}${detail ? `: ${detail}` : "."}` };
    }
    let text = stdout;
    if (existsSync(outputDir)) {
      const written = readdirSync(outputDir).find((f) => f.endsWith(".txt"));
      if (written) text = readFileSync(join(outputDir, written), "utf8");
    }
    return { text: text.replace(/\s+/g, " ").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
