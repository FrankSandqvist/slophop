"use client";

import { useEffect, useRef, useState } from "react";
import { drawMascot, MASCOT_H, MASCOT_W, type MascotKind, type MascotMood } from "@/lib/mascot";
import { musicBeat, sfx, voice } from "@/lib/sound";

/** The two-screen handheld: top screen for the stage and dialogue, bottom screen for touch. */
export function DSShell({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  return (
    <div className="ds">
      <section className="ds-screen ds-top" aria-label="Top screen">{top}</section>
      <div className="ds-hinge" aria-hidden><i /><i /></div>
      <section className="ds-screen ds-bottom" aria-label="Bottom screen">{bottom}</section>
    </div>
  );
}

export type Speaker = MascotKind | "narrator";
export type Line = { who: Speaker; text: string };

const NAMES: Record<Speaker, string> = { add: "GREEN", del: "RED", narrator: "SLOPHOP" };
const CHARS_PER_SECOND = 48;

/** DS-style dialogue box with a typewriter effect. Tap to finish the line, tap again to advance. */
export function TextBox({ line, onNext, onTyping }: { line: Line | null; onNext?: () => void; onTyping?: (typing: boolean) => void }) {
  const [shown, setShown] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    if (!line) return;
    started.current = performance.now();
    // Restart the typewriter for each new line.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown(0);
    onTyping?.(true);
    let frame = 0;
    let last = 0;
    const tick = () => {
      const count = Math.min(line.text.length, Math.floor(((performance.now() - started.current) / 1000) * CHARS_PER_SECOND));
      if (count !== last) {
        // Green and Red babble (one syllable every other letter, rising at the end of a question); the narrator blips.
        if (count % 2 === 0) {
          const char = line.text[count - 1] ?? "";
          if (line.who === "narrator") {
            if (char !== " ") sfx.text();
          } else {
            voice(line.who, char, line.text.trimEnd().endsWith("?") && count > line.text.length - 10 ? 4 : 0);
          }
        }
        last = count;
        setShown(count);
      }
      if (count < line.text.length) frame = requestAnimationFrame(tick);
      else onTyping?.(false);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [line, onTyping]);

  if (!line) return null;
  const done = shown >= line.text.length;
  return (
    <button
      className={`textbox textbox-${line.who}`}
      onClick={() => {
        if (!done) {
          started.current = -1e9;
          setShown(line.text.length);
          onTyping?.(false);
        } else if (onNext) {
          sfx.select();
          onNext();
        }
      }}
      aria-live="polite"
    >
      <span className="textbox-name">{NAMES[line.who]}</span>
      <span className="textbox-text">
        {line.text.slice(0, shown)}
        <span className="textbox-ghost" aria-hidden>{line.text.slice(shown)}</span>
      </span>
      {done && onNext && <span className="textbox-next" aria-hidden>▼</span>}
    </button>
  );
}

/** A mascot drawn on its own little canvas, for the bottom screen. */
export function Mascot({ kind, mood = "idle", scale = 1, bpm = 96 }: { kind: MascotKind; mood?: MascotMood; scale?: number; bpm?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(mood);
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    const context = ref.current?.getContext("2d");
    if (!context) return;
    let frame = 0;
    const start = performance.now();
    const loop = () => {
      const music = musicBeat();
      drawMascot(context, kind, (performance.now() - start) / 1000, moodRef.current, { bpm: music?.bpm ?? bpm, beat: music?.beat });
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [kind, bpm]);

  return <canvas ref={ref} className="mascot" width={MASCOT_W} height={MASCOT_H} style={{ width: MASCOT_W * scale, height: MASCOT_H * scale }} aria-hidden />;
}
