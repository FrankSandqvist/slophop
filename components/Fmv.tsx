"use client";

import { useEffect, useRef } from "react";
import type { FmvLine } from "@/lib/types";

/** FMV resolution: about the stage's 256px width, 16:9, adjusted so a whole-number scale fills the screen width. */
const TARGET_W = 256;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16 - 0.5);

/**
 * Plays the puzzle's cutscene on the top screen like a PS1 FMV: drawn into a ~256x144 canvas, ordered-dithered and crushed
 * to 15-bit colour (the same treatment as the stage), letterboxed. Reports which dialogue line is due, so the text box
 * follows the picture. Tap to skip. The clip's own audio stays muted; the soundtrack keeps playing.
 */
export function Fmv({ src, lines, onLine, onDone }: { src: string; lines: FmvLine[]; onLine: (index: number) => void; onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onLine, onDone });
  useEffect(() => {
    callbacks.current = { onLine, onDone };
  }, [onLine, onDone]);

  // Like the stage: a whole-number device-pixel scale (every FMV pixel the same size), with the render width picked so
  // the picture fills the screen width.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = canvas?.parentElement;
    if (!canvas || !box) return;
    const fit = () => {
      const ratio = window.devicePixelRatio || 1;
      const device = Math.round(box.clientWidth * ratio);
      const scale = Math.max(1, Math.round(device / TARGET_W));
      const width = Math.ceil(device / scale);
      const height = Math.round((width * 9) / 16);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${(width * scale) / ratio}px`;
      canvas.style.height = `${(height * scale) / ratio}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    let url = "";
    let frame = 0;
    let shown = -1;
    let cancelled = false;
    const finish = () => {
      if (!cancelled) callbacks.current.onDone();
    };

    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (video.readyState < 2) return;
      const { width, height } = context.canvas;
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      const data = image.data;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const offset = BAYER[(y & 3) * 4 + (x & 3)] / 31;
          for (let c = 0; c < 3; c++) data[i + c] = (Math.round((data[i + c] / 255 + offset) * 31) / 31) * 255;
        }
      }
      context.putImageData(image, 0, 0);
      let due = -1;
      lines.forEach((line, index) => {
        if (video.currentTime >= line.at) due = index;
      });
      if (due !== shown) {
        shown = due;
        callbacks.current.onLine(due);
      }
    };

    // Fetched whole and played from a blob URL: small file, and no range requests needed.
    fetch(src)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`cutscene ${response.status}`))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        video.src = url;
        video.addEventListener("ended", finish);
        video.addEventListener("error", finish);
        frame = requestAnimationFrame(draw);
        return video.play();
      })
      .catch(finish);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      video.pause();
      video.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, lines]);

  return (
    <button className="fmv" onClick={() => callbacks.current.onDone()} aria-label="Skip the cutscene">
      <canvas ref={canvasRef} className="ps1 fmv-canvas" width={TARGET_W} height={(TARGET_W * 9) / 16} aria-hidden />
      <span className="fmv-skip">SKIP ▶▶</span>
    </button>
  );
}
