import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speechRoutes } from "../src/speech/routes.js";
import { audioExtension, buildArgv, findMlxWhisper, resolveSttCommand, splitCommand, transcribe } from "../src/speech/transcribe.js";

function withTempDir(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "rye-speech-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("speech-to-text command", () => {
  test("recognises the audio types browsers record", () => {
    expect(audioExtension("audio/mp4")).toBe("mp4");
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("application/json")).toBeNull();
    expect(audioExtension(undefined)).toBeNull();
  });

  test("splits quoted arguments and fills in the placeholders", () => {
    expect(splitCommand(`"/opt/my tools/stt" --lang 'en US' -q`)).toEqual(["/opt/my tools/stt", "--lang", "en US", "-q"]);
    expect(buildArgv("stt {input} -o {output_dir}", "/t/a.mp4", "/t/out")).toEqual(["stt", "/t/a.mp4", "-o", "/t/out"]);
    // No {input}: the recording is passed as the last argument.
    expect(buildArgv("stt --fast", "/t/a.mp4", "/t/out")).toEqual(["stt", "--fast", "/t/a.mp4"]);
  });

  test(
    "finds mlx_whisper on PATH or in a pyenv environment, but not through a pyenv shim",
    withTempDir((dir) => {
      const shims = join(dir, ".pyenv", "shims");
      const envBin = join(dir, ".pyenv", "versions", "tools_3_13", "bin");
      mkdirSync(shims, { recursive: true });
      mkdirSync(envBin, { recursive: true });
      script(shims, "mlx_whisper", "exit 127");
      expect(findMlxWhisper({ PATH: shims }, dir)).toBeNull();
      const real = script(envBin, "mlx_whisper", "exit 0");
      expect(findMlxWhisper({ PATH: shims }, dir)).toBe(real);
      const onPath = script(dir, "mlx_whisper", "exit 0");
      expect(findMlxWhisper({ PATH: `${shims}:${dir}` }, dir)).toBe(onPath);
    }),
  );

  test("a configured command wins; with none, dictation is off unless mlx_whisper is found", () => {
    expect(resolveSttCommand("  my-stt {input} ", () => "/x/mlx_whisper")).toBe("my-stt {input}");
    expect(resolveSttCommand("", () => null)).toBeNull();
    expect(resolveSttCommand("", () => "/x y/mlx_whisper")).toContain('"/x y/mlx_whisper" {input}');
  });

  test(
    "reads the transcript from the .txt the command writes, or from its output",
    withTempDir(async (dir) => {
      const toFile = script(dir, "to-file", 'mkdir -p "$2" && printf "from   the\\nfile " > "$2/recording.txt" && echo ignored');
      expect(await transcribe(`${toFile} {input} {output_dir}`, new Uint8Array([1, 2, 3]), "mp4")).toEqual({ text: "from the file" });

      const toStdout = script(dir, "to-stdout", 'case "$1" in *.webm) echo " heard it ";; *) exit 3;; esac');
      expect(await transcribe(toStdout, new Uint8Array([1]), "webm")).toEqual({ text: "heard it" });

      const failing = script(dir, "failing", "echo model missing >&2; exit 2");
      expect(await transcribe(failing, new Uint8Array([1]), "mp4")).toEqual({ error: "The transcriber exited with code 2: model missing" });

      const missing = await transcribe(join(dir, "nope"), new Uint8Array([1]), "mp4");
      expect("error" in missing && missing.error).toContain("Couldn't start the transcriber");
    }),
  );
});

describe("speech routes", () => {
  const post = (app: ReturnType<typeof speechRoutes>, body: BodyInit, type: string) =>
    app.request("/transcribe", { method: "POST", headers: { "Content-Type": type }, body });

  test("reports whether dictation is available and refuses when it isn't", async () => {
    const off = speechRoutes({ command: () => null });
    expect(await (await off.request("/")).json()).toEqual({ stt: false });
    expect((await post(off, new Uint8Array([1]), "audio/mp4")).status).toBe(501);
  });

  test("transcribes audio and rejects anything else", async () => {
    const seen: string[] = [];
    const app = speechRoutes({
      command: () => "stt",
      run: async (_command, audio, extension) => {
        seen.push(`${extension}:${audio.length}`);
        return extension === "ogg" ? { error: "boom" } : { text: "hello" };
      },
    });
    expect(await (await app.request("/")).json()).toEqual({ stt: true });
    expect(await (await post(app, new Uint8Array([1, 2]), "audio/webm;codecs=opus")).json()).toEqual({ text: "hello" });
    expect((await post(app, "{}", "application/json")).status).toBe(415);
    expect((await post(app, new Uint8Array(0), "audio/mp4")).status).toBe(400);
    expect((await post(app, new Uint8Array([1]), "audio/ogg")).status).toBe(502);
    expect(seen).toEqual(["webm:2", "ogg:1"]);
  });
});
