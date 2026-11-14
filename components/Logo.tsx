"use client";

import { useEffect, useRef } from "react";
import { drawLogo, logoSize } from "@/lib/logo";

const SCALE = 3;
const BOUNCE = 2;

/** The SlopHop wordmark (faces as the O's) on a tiny canvas, scaled up with hard pixels. Bobs gently and blinks. */
export function Logo({ zoom = 2 }: { zoom?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { w, h } = logoSize(SCALE, BOUNCE);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    let frame = 0;
    const start = performance.now();
    const loop = () => {
      const t = (performance.now() - start) / 1000;
      context.clearRect(0, 0, w, h);
      drawLogo(context, 0, BOUNCE + 2, { scale: SCALE, bounce: Math.round(Math.abs(Math.sin(t * 2.4)) * -BOUNCE), t });
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [w, h]);
  return <canvas ref={canvas} className="ps1 logo-canvas" width={w} height={h} style={{ width: w * zoom, height: h * zoom }} role="img" aria-label="SlopHop" />;
}
