"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MUSIC_VOLUME = 0.5;
const MUTE_KEY = "slophop:muted";

/** Gapless looping soundtrack via Web Audio, with fades. Must start from a user gesture. */
export function useSoundtrack(src: string | null) {
  const context = useRef<AudioContext | null>(null);
  const gain = useRef<GainNode | null>(null);
  const bytes = useRef<Promise<ArrayBuffer> | null>(null);
  const started = useRef(false);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    try {
      // Restoring a stored preference after hydration is intentional here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMuted(window.localStorage.getItem(MUTE_KEY) === "1");
    } catch {}
    if (src) bytes.current = fetch(src).then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error("No music"))));
    return () => {
      void context.current?.close();
    };
  }, [src]);

  const start = useCallback(async (force = false) => {
    if (!bytes.current || (started.current && !force)) return;
    try {
      if (!context.current) {
        const ctx = new AudioContext();
        const node = ctx.createGain();
        node.gain.value = 0;
        node.connect(ctx.destination);
        context.current = ctx;
        gain.current = node;
        started.current = true;
        const buffer = await ctx.decodeAudioData((await bytes.current).slice(0));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(node);
        source.start();
      }
      await context.current.resume();
      setPlaying(true);
    } catch {
      started.current = false;
    }
  }, []);

  useEffect(() => {
    const ctx = context.current;
    const node = gain.current;
    if (!ctx || !node) return;
    node.gain.cancelScheduledValues(ctx.currentTime);
    node.gain.setTargetAtTime(muted ? 0 : MUSIC_VOLUME, ctx.currentTime, muted ? 0.15 : 0.8);
  }, [muted, playing]);

  const toggle = useCallback(() => {
    if (!started.current) {
      setMuted(false);
      void start(true);
      return;
    }
    setMuted((value) => {
      try {
        window.localStorage.setItem(MUTE_KEY, value ? "0" : "1");
      } catch {}
      return !value;
    });
  }, [start]);

  return { start, toggle, muted, playing, available: Boolean(src) };
}
