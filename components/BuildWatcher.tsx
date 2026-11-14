"use client";

import { useEffect, useState } from "react";

type Status = { status: "building" | "ready" | "failed"; kind: "build" | "repair" | null; attempt: number; startedAt: string | null };

const POLL_MS = 6000;

/** Polls a building puzzle until its game is ready (the build runs as a Gemini background interaction). */
export function BuildWatcher({ id, onReady, compact = false }: { id: string; onReady: () => void; compact?: boolean }) {
  const [state, setState] = useState<Status | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    async function poll() {
      try {
        const response = await fetch(`/api/puzzles/${id}/status`, { cache: "no-store" });
        const data = (await response.json()) as Status;
        if (stopped) return;
        setState(data);
        if (data.status === "ready") return onReady();
        if (data.status === "failed") return;
      } catch {}
      if (!stopped) timer = window.setTimeout(poll, POLL_MS);
    }
    void poll();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [id, onReady]);

  const seconds = state?.startedAt ? Math.max(0, Math.round((now - Date.parse(state.startedAt)) / 1000)) : 0;
  const text =
    state?.status === "failed"
      ? "The build didn't work out this time."
      : state?.kind === "repair"
        ? `Polishing the game (pass ${state.attempt})… ${seconds}s`
        : `Building the game… ${seconds}s`;

  return (
    <p className={compact ? "build-watch build-watch-compact" : "build-watch"} aria-live="polite">
      {state?.status !== "failed" && <span className="build-spinner" aria-hidden />}
      {text}
    </p>
  );
}
