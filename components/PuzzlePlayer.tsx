"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Puzzle, Verdict, VerdictTally } from "@/lib/puzzles";
import { puzzleAccent } from "@/lib/puzzle-view";
import { hasQuestion, parseQuestionKey, questionKey, type Tally } from "@/lib/review";
import { Briefing } from "./Briefing";
import { BuildWatcher } from "./BuildWatcher";
import { CodePeek, type Peek } from "./CodePeek";
import { JudgeCard } from "./JudgeCard";
import { ReviewPanel } from "./ReviewPanel";
import { Summary } from "./Summary";
import { useSoundtrack } from "./useSoundtrack";

type GameMessage =
  | { source: "slophop"; type: "judge"; key: string; outcome: string; brokePromise: boolean }
  | { source: "slophop"; type: "peek"; id: string; anchor: { x: number; y: number } | null; happened: string }
  | { source: "slophop"; type: "verdict"; verdict: Verdict; evidence: string; score: number };

type PendingJudge = { key: string; outcome: string; brokePromise: boolean };

/** Every standardized question this puzzle asks, in play order. */
function questionKeys(puzzle: Puzzle) {
  return [
    questionKey("fix"),
    ...puzzle.tradeoffs.map((_, index) => questionKey("tradeoff", index)),
    ...puzzle.cases.map((_, index) => questionKey("case", index)),
  ];
}

function stepLabel(puzzle: Puzzle, key: string) {
  const parsed = parseQuestionKey(key);
  if (!parsed || parsed.kind === "fix") return "What changed";
  if (parsed.kind === "tradeoff") return "Give and take";
  return `Tricky situation ${parsed.index + 1} of ${puzzle.cases.length}`;
}

/**
 * The host: briefing -> the game (one iframe) with standardized judgment cards and code popups -> summary.
 * The game reports what happened; every question and every code reveal is rendered here.
 */
export function PuzzlePlayer(props: {
  puzzle: Puzzle;
  initialTally: VerdictTally;
  initialJudgments: Record<string, Tally>;
  initialBreaks: string[];
}) {
  const { puzzle } = props;
  const router = useRouter();
  const keys = questionKeys(puzzle);
  const ready = puzzle.status === "ready";

  const frame = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const music = useSoundtrack(puzzle.musicFile ? `/api/puzzles/${puzzle.id}/music` : null);
  const [briefingOpen, setBriefingOpen] = useState(true);
  const [hasStarted, setHasStarted] = useState(false);
  const [tally, setTally] = useState(props.initialTally);
  const [judgments, setJudgments] = useState(props.initialJudgments);
  const [myJudgments, setMyJudgments] = useState<Record<string, string>>({});
  const [breaks, setBreaks] = useState(props.initialBreaks);
  const [judging, setJudging] = useState<PendingJudge | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [stageSize, setStageSize] = useState({ width: 390, height: 700 });
  const [myVerdict, setMyVerdict] = useState<{ verdict: Verdict; evidence: string } | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [toast, setToast] = useState("");

  const { start: startMusic, muted, playing } = music;
  const silent = muted || !playing;

  const tellGame = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "slophop-host", ...message }, "*");
  }, []);

  useEffect(() => {
    tellGame({ type: "mute", muted });
  }, [muted, tellGame]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function startGame() {
    setBriefingOpen(false);
    if (!started.current) {
      started.current = true;
      setHasStarted(true);
      if (!muted) void startMusic();
    }
    tellGame({ type: "mute", muted });
    tellGame({ type: "start" });
    frame.current?.focus();
  }

  // If the player pressed Play before the game finished loading, tell it again.
  function onFrameLoad() {
    tellGame({ type: "mute", muted });
    if (started.current) tellGame({ type: "start" });
  }

  useEffect(() => {
    async function onMessage(event: MessageEvent<GameMessage>) {
      if (event.source !== frame.current?.contentWindow || event.data?.source !== "slophop") return;
      const message = event.data;
      if (message.type === "peek") {
        const spot = puzzle.codeSpots.find((candidate) => candidate.id === message.id);
        if (spot) setPeek({ spot, happened: message.happened, anchor: message.anchor, at: Date.now() });
        return;
      }
      if (message.type === "judge") {
        if (hasQuestion(puzzle, message.key)) setJudging({ key: message.key, outcome: message.outcome, brokePromise: message.brokePromise });
        else tellGame({ type: "judged", key: message.key, answer: null });
        return;
      }
      setMyVerdict({ verdict: message.verdict, evidence: message.evidence });
      if (message.verdict === "breaks" && message.evidence) setBreaks((current) => [message.evidence, ...current].slice(0, 5));
      setSummaryOpen(true);
      try {
        const response = await fetch(`/api/puzzles/${puzzle.id}/verdicts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        const data = (await response.json()) as { tally?: VerdictTally };
        if (!response.ok || !data.tally) throw new Error();
        setTally(data.tally);
      } catch {
        setToast("Couldn't save your verdict. Try again in a moment.");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [puzzle, tellGame]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function saveJudgment(answer: string): Promise<Tally | null> {
    if (!judging) return null;
    const { key, outcome } = judging;
    setMyJudgments((current) => ({ ...current, [key]: answer }));
    try {
      const response = await fetch(`/api/puzzles/${puzzle.id}/judgments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, answer, detail: outcome }),
      });
      const data = (await response.json()) as { tally?: Tally };
      if (!response.ok || !data.tally) throw new Error();
      setJudgments((current) => ({ ...current, [key]: data.tally! }));
      return data.tally;
    } catch {
      setToast("Couldn't save that answer, but you can keep playing.");
      return null;
    }
  }

  function finishJudging() {
    if (!judging) return;
    tellGame({ type: "judged", key: judging.key, answer: myJudgments[judging.key] ?? null });
    setJudging(null);
    frame.current?.focus();
  }

  const onReady = useCallback(() => router.refresh(), [router]);
  const judgedCount = keys.filter((key) => myJudgments[key]).length;
  const level = (key: string) => puzzle.levels.find((entry) => entry.beat === key);

  return (
    <div className="player" style={{ "--accent": puzzleAccent(puzzle) } as React.CSSProperties}>
      <header className="player-bar">
        <Link href="/" className="icon-button" aria-label="Back to all puzzles">←</Link>
        <h1 className="player-title">
          <span aria-hidden>{puzzle.emoji}</span> {puzzle.title}
        </h1>
        <span className="pips" aria-label={`${judgedCount} of ${keys.length} questions answered`}>
          {keys.map((key) => <i key={key} className={myJudgments[key] ? "pip-done" : ""} />)}
        </span>
        {music.available && (
          <button className="icon-button" onClick={music.toggle} aria-pressed={!silent} aria-label={silent ? "Sound on" : "Sound off"}>
            {silent ? "♪̸" : "♪"}
          </button>
        )}
        <button className="icon-button" onClick={() => setBriefingOpen(true)} aria-label="What is this?">?</button>
        <button className="icon-button" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen} aria-controls="behind" aria-label="Crowd review">
          {panelOpen ? "×" : "✓"}
        </button>
      </header>

      <div className="player-stage" ref={stageRef}>
        {ready ? (
          <iframe
            ref={frame}
            title={`${puzzle.title}: puzzle game`}
            src={`/api/puzzles/${puzzle.id}/game`}
            sandbox="allow-scripts"
            allow="autoplay"
            className="game-frame"
            onLoad={onFrameLoad}
            inert={briefingOpen || judging !== null || summaryOpen}
          />
        ) : (
          <div className="game-pending">
            <BuildWatcher id={puzzle.id} onReady={onReady} />
            <p>The design is ready; the game is still being built. This page will open it as soon as it&apos;s done.</p>
          </div>
        )}

        {!briefingOpen && !judging && <CodePeek peek={peek} stage={stageSize} />}

        <aside id="behind" className={`behind ${panelOpen ? "behind-open" : ""}`} inert={!panelOpen}>
          <ReviewPanel puzzle={puzzle} judgments={judgments} verdicts={tally} breaks={breaks} myVerdict={myVerdict} />
        </aside>
      </div>

      {briefingOpen && <Briefing puzzle={puzzle} onStart={ready ? startGame : () => setBriefingOpen(false)} started={hasStarted} />}

      {judging && (
        <JudgeCard
          key={judging.key}
          puzzle={puzzle}
          questionKey={judging.key}
          step={stepLabel(puzzle, judging.key)}
          outcome={judging.outcome}
          brokePromise={judging.brokePromise}
          spot={puzzle.codeSpots.find((spot) => spot.id === level(judging.key)?.codeSpot) ?? null}
          onJudge={saveJudgment}
          onDone={finishJudging}
        />
      )}

      {summaryOpen && (
        <Summary
          puzzle={puzzle}
          judgments={judgments}
          verdicts={tally}
          breaks={breaks}
          myVerdict={myVerdict}
          onReplay={() => {
            setSummaryOpen(false);
            setMyJudgments({});
            if (frame.current) frame.current.src = `/api/puzzles/${puzzle.id}/game`;
            setBriefingOpen(true);
            started.current = false;
          }}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
