"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProgressEvent, Puzzle } from "@/lib/puzzles";
import { BuildWatcher } from "./BuildWatcher";

type StageKey = "source" | "research" | "design" | "build" | "art" | "music" | "save";
type StageState = { status: "waiting" | "active" | "done" | "skipped"; detail?: string };

const STAGES: Array<{ key: StageKey; label: string }> = [
  { key: "source", label: "Finding a pull request" },
  { key: "research", label: "Exploring the repo" },
  { key: "design", label: "Designing the puzzle" },
  { key: "build", label: "Building the game" },
  { key: "art", label: "Drawing the art" },
  { key: "music", label: "Composing music" },
  { key: "save", label: "Saving" },
];

const freshStages = (): Record<StageKey, StageState> =>
  Object.fromEntries(STAGES.map((stage) => [stage.key, { status: "waiting" }])) as Record<StageKey, StageState>;

export function Generator() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState(freshStages);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Puzzle | null>(null);
  const [prUrl, setPrUrl] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const [built, setBuilt] = useState(false);
  const onBuilt = useCallback(() => {
    setBuilt(true);
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  async function generate(event?: React.FormEvent) {
    event?.preventDefault();
    if (running) return;
    setRunning(true);
    setError("");
    setResult(null);
    setBuilt(false);
    setStages(freshStages());
    setElapsed(0);
    startedAt.current = Date.now();

    try {
      const response = await fetch("/api/puzzles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: prUrl.trim() || undefined }),
      });
      if (!response.body) throw new Error("No response from the server.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as ProgressEvent;
          if (message.type === "stage") {
            setStages((current) => ({ ...current, [message.stage]: { status: message.status, detail: message.detail } }));
          } else if (message.type === "done") {
            setResult(message.puzzle);
            setBuilt(message.puzzle.status === "ready");
            finished = true;
            router.refresh();
          } else if (message.type === "error") {
            throw new Error(message.message);
          }
        }
      }
      if (!finished) throw new Error("Connection dropped. The puzzle may still appear shortly.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="generator">
      <form className="generate-row" onSubmit={generate}>
        <button className="button button-primary" type="submit" disabled={running}>
          {running ? `Making… ${elapsed}s` : "New puzzle"}
          <span aria-hidden className="button-arrow">→</span>
        </button>
        <label className="sr-only" htmlFor="pr-url">Optional GitHub pull request URL</label>
        <input
          id="pr-url"
          className="input"
          type="url"
          inputMode="url"
          placeholder="or paste a PR link"
          value={prUrl}
          onChange={(event) => setPrUrl(event.target.value)}
          disabled={running}
        />
      </form>

      {(running || error || result) && (
        <div className="progress" aria-live="polite">
          <ol>
            {STAGES.map((stage) => {
              const state = stages[stage.key];
              return (
                <li key={stage.key} className={`step step-${state.status}`}>
                  <span className="step-dot" aria-hidden />
                  <span>{stage.label}</span>
                  {state.detail && <small>{state.detail}</small>}
                  <span className="sr-only"> ({state.status})</span>
                </li>
              );
            })}
          </ol>
          {error && (
            <p className="progress-error" role="alert">
              {error} <button type="button" className="link-button" onClick={() => generate()}>Try again</button>
            </p>
          )}
          {result && !built && <BuildWatcher id={result.id} onReady={onBuilt} compact />}
          {result && (
            <Link className="progress-ready" href={`/play/${result.id}`}>
              <span aria-hidden>{result.emoji}</span> {result.title}
              <small>{built ? "Ready to play" : "Open it; it starts as soon as it's built"}</small>
              <span className="button-arrow" aria-hidden>→</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
