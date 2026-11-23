import React, { useEffect, useRef } from "react";
import { LEVEL_HISTORY } from "../../utils/audioCapture";

const BAR = 2;
const GAP = 2;
const HEIGHT = 24;
const BARS = 28;
const WIDTH = BARS * (BAR + GAP) - GAP;
/** Speech sits well below full scale, so loudness is boosted and curved to use the height. */
const scale = (level: number) => Math.min(1, Math.sqrt(level * 9));

/** Live waveform of the microphone while dictating: one bar per recent slice of audio, newest on the right. */
export default function DictationWave({ levels }: { levels: () => number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = WIDTH * ratio;
    canvas.height = HEIGHT * ratio;
    ctx.scale(ratio, ratio);
    const color = getComputedStyle(canvas).color;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Bars ease toward their target so the wave moves smoothly between audio buffers.
    const shown = new Array<number>(BARS).fill(0);
    let frame = 0;

    const draw = () => {
      const recent = levels().slice(-Math.min(BARS, LEVEL_HISTORY));
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = color;
      for (let i = 0; i < BARS; i++) {
        const target = scale(recent[recent.length - BARS + i] ?? 0);
        shown[i] = calm ? target : shown[i] + (target - shown[i]) * 0.35;
        const h = Math.max(2, shown[i] * HEIGHT);
        ctx.beginPath();
        ctx.roundRect(i * (BAR + GAP), (HEIGHT - h) / 2, BAR, h, 1);
        ctx.fill();
      }
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [levels]);

  return <canvas ref={canvasRef} className="dictation-wave" style={{ width: WIDTH, height: HEIGHT }} aria-hidden="true" />;
}
