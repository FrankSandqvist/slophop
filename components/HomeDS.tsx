"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MascotKind } from "@/lib/mascot";
import { audioLog, audioState, playLoop, sfx, unlockAudio } from "@/lib/sound";
import { FAMILY_BADGES, type PropSpec, type Puzzle, type PuzzleFamily, type StageCard } from "@/lib/types";
import { DSShell, TextBox, type Line } from "./DS";
import type { Job } from "@/lib/jobs";
import { KindBadge } from "./KindBadge";
import { Logo } from "./Logo";
import { HowToPlay, TUTORIAL, TUTORIAL_KEY, type TutorialLine } from "./HowToPlay";
import { PS1Stage, type StageState } from "./PS1Stage";

type Summary = Pick<Puzzle, "id" | "title" | "pr" | "component" | "musicFile" | "bpm" | "family" | "families">;
type Progress = {
  type: "stage";
  stage: "fetch" | "rank" | "pick" | "model" | "music" | "fmv" | "world" | "save";
  status: "active" | "done" | "skipped";
  detail?: string;
  cards?: StageCard[];
  pick?: number;
  component?: string;
  family?: "logic" | "numeric" | "visual" | "flow" | "ai";
  props?: PropSpec[];
};

/** Sample data for /?demo, which plays the generation show without calling any API. */
const DEMO_CARDS: StageCard[] = [
  { repository: "acme/checkout", number: 812, title: "Fix coupon stacking", additions: 24, deletions: 9, lines: ["+ if (coupons.length > 1) return reject()", "- applyAll(coupons)", "+ const total = Math.max(0, price - off)"] },
  { repository: "civic/bus-times", number: 77, title: "Handle midnight wraparound", additions: 13, deletions: 4, lines: ["+ if (minutes >= 1440) minutes -= 1440", "- return hh + ':' + mm"] },
  { repository: "openmaps/router", number: 3051, title: "Avoid closed bridges", additions: 41, deletions: 17, lines: ["+ if (edge.closed) continue", "- cost += edge.length"] },
  { repository: "photos/uploader", number: 290, title: "Reject empty files", additions: 8, deletions: 2, lines: ["+ if (file.size === 0) throw new Error()", "- upload(file)"] },
  { repository: "chat/notify", number: 1188, title: "Quiet hours respect timezone", additions: 19, deletions: 11, lines: ["+ const local = toZone(now, user.tz)", "- if (now.getHours() < 8) return"] },
];

/** Sample generated props for /?demo: a bus stop sign and a clock. */
const DEMO_PROPS: PropSpec[] = [
  {
    name: "Bus stop sign",
    parts: [
      { shape: "cylinder", color: "#b9b4c9", position: [0, 0.45, 0], size: [0.04, 0.9, 0], rotation: [0, 0, 0] },
      { shape: "cylinder", color: "#4dd6ff", position: [0, 0.95, 0], size: [0.22, 0.06, 0], rotation: [Math.PI / 2, 0, 0] },
      { shape: "box", color: "#ffffff", position: [0, 0.95, 0.04], size: [0.2, 0.08, 0.02], rotation: [0, 0, 0] },
    ],
  },
  {
    name: "Midnight clock",
    parts: [
      { shape: "cylinder", color: "#ffd447", position: [0, 0.6, 0], size: [0.35, 0.1, 0], rotation: [Math.PI / 2, 0, 0] },
      { shape: "cylinder", color: "#ffffff", position: [0, 0.6, 0.04], size: [0.29, 0.04, 0], rotation: [Math.PI / 2, 0, 0] },
      { shape: "box", color: "#1b1a22", position: [0, 0.7, 0.08], size: [0.04, 0.2, 0.02], rotation: [0, 0, 0] },
      { shape: "box", color: "#1b1a22", position: [0.06, 0.6, 0.08], size: [0.14, 0.04, 0.02], rotation: [0, 0, 0] },
      { shape: "box", color: "#ff5fa2", position: [0, 0.15, 0], size: [0.3, 0.3, 0.2], rotation: [0, 0, 0] },
    ],
  },
];

const INTRO: Line[] = [
  { who: "add", text: "I'm Green. Every line a pull request adds? That's me." },
  { who: "del", text: "I'm Red. Every line it deletes. Somebody has to." },
  { who: "add", text: "Real code changes from out in the world. Tiny brain teasers. Pick one below!" },
  { who: "del", text: "Got a pull request of your own in mind? Tap PR link, paste it, and we'll puzzle that one up instead." },
];

/**
 * Rough progress while a puzzle is made: each stage owns a slice of the bar; inside the long modelling slice it creeps on
 * an easing curve (never stalls, never hits 100% early). Durations are typical, not promises.
 */
const PROGRESS: Record<string, { label: string; from: number; to: number; seconds: number }> = {
  start: { label: "STARTING", from: 0, to: 4, seconds: 3 },
  fetch: { label: "FINDING PRS", from: 4, to: 16, seconds: 9 },
  rank: { label: "RANKING", from: 16, to: 24, seconds: 5 },
  model: { label: "MODELLING", from: 24, to: 94, seconds: 45 },
  save: { label: "SAVING", from: 94, to: 100, seconds: 2 },
};

/** Banter for the long modelling wait: said only when nothing else is, about every 8s. What Gemini is doing depends on the kind. */
function banter(family?: Progress["family"]): Line[] {
  const specific: Line[] =
    family === "numeric"
      ? [
          { who: "add", text: "It's a numbers one. Gemini's writing the old formula in Python, then the new one." },
          { who: "del", text: "Now it runs both on every number in the range. Mine were fine, for the record." },
          { who: "add", text: "Checking our rulebooks add up. Literally." },
        ]
      : family === "ai"
        ? [
            { who: "add", text: "It's an AI one. Gemini's writing my guard and Red's old one in Python, then testing them both." },
            { who: "del", text: "It throws sample messages and tool calls at us. Harmless ones, promise. Mock villainy only." },
            { who: "add", text: "Checking our rulebooks match what the guards actually did." },
          ]
      : family === "flow"
        ? [
            { who: "add", text: "It's a flow one. Gemini's drawing the whole process: every step and every arrow, before and after." },
            { who: "del", text: "Then our own code walks a few stories through both maps. No guessing, just following arrows." },
            { who: "add", text: "Checking our rulebooks match the maps." },
          ]
      : family === "visual"
        ? [
            { who: "add", text: "It's a UX one. Gemini's sketching it the old way first, screen, buttons and all. That's Red's look." },
            { who: "del", text: "Classic look. Now it's drawing Green's. Same screen, smaller ego." },
            { who: "add", text: "Checking our rulebooks match the pictures." },
          ]
        : [
            { who: "add", text: "It's a logic one. Gemini's writing a little Python copy of Red. Flattering." },
            { who: "del", text: "And one of Green. Then it runs us both on every combination of cases." },
            { who: "add", text: "Now it's checking our rulebooks against the results. No shortcuts." },
          ];
  return [
    ...specific,
    { who: "del", text: "Picking the trickiest cases for you. You're welcome." },
    { who: "add", text: "Still thinking. Big brains take a moment." },
    { who: "del", text: "Almost there. Probably. Don't quote me." },
    { who: "add", text: "If this takes much longer, Red's charging rent." },
  ];
}

/** What the two say while a puzzle is being made. */
function progressLine(event: Progress): Line | null {
  if (event.stage === "fetch" && event.status === "active") return { who: "del", text: "Grabbing fifty fresh pull requests made with AI coding tools..." };
  if (event.stage === "fetch" && event.status === "done" && event.detail === "already made") return { who: "add", text: "That one's already a puzzle! Taking you there." };
  if (event.stage === "fetch" && event.status === "done") return { who: "add", text: `Got ${event.detail}. Let's see which one's the juiciest.` };
  if (event.stage === "rank" && event.status === "active") return { who: "del", text: "Gemini Decisions is scoring every one. Logic, size, who'd notice..." };
  if (event.stage === "model" && event.status === "active") return { who: "del", text: "Now running the old me and the new Green side by side. Every case." };
  if (event.stage === "model" && event.status === "done") return { who: "add", text: `Done: ${event.detail}.` };
  if (event.stage === "fmv" && event.status === "active") return { who: "add", text: "Meanwhile, we're shooting a little movie about it. Lights, camera..." };
  if (event.stage === "world" && event.status === "done" && event.detail) return { who: "del", text: `Fun fact, while we wait: ${event.detail}` };
  if (event.stage === "save" && event.status === "done") return { who: "add", text: "Ready. Let's go!" };
  return null;
}

export function HomeDS({ puzzles, jobs = [] }: { puzzles: Summary[]; jobs?: Job[] }) {
  const router = useRouter();
  const stage = useRef<StageState>({ add: "dance", del: "dance", bpm: 96, show: { mode: "idle", cards: [], picked: null, headline: "", beat: false } });
  const [lines, setLines] = useState<Line[]>(INTRO);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState("");
  // One kind choice: filters the list and is what "+ New puzzle" makes ("all" = a random kind).
  const [kind, setKind] = useState<PuzzleFamily | "all">("all");
  const shown = kind === "all" ? puzzles : puzzles.filter((puzzle) => (puzzle.families ?? [puzzle.family ?? "logic"]).includes(kind));
  const [showUrl, setShowUrl] = useState(false);

  const line = lines[Math.min(index, lines.length - 1)] ?? null;

  // The tutorial: on a first visit the three explain the game while the How to play card lights up step by step.
  // "?" brings both back; closing the card remembers it.
  const [howto, setHowto] = useState(false);
  function openHowto() {
    sfx.select();
    setHowto(true);
    setLines(TUTORIAL);
    setIndex(0);
  }
  function closeHowto() {
    sfx.select();
    setHowto(false);
    try {
      window.localStorage.setItem(TUTORIAL_KEY, "1");
    } catch {}
  }
  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(TUTORIAL_KEY) === "1";
    } catch {}
    if (seen || new URLSearchParams(window.location.search).has("demo")) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHowto(true);
    setLines(TUTORIAL);
    setIndex(0);
  }, []);

  const onTyping = useCallback(
    (typing: boolean) => {
      const who = line?.who;
      for (const kind of ["add", "del"] as MascotKind[]) stage.current[kind] = typing && who === kind ? "talk" : "dance";
    },
    [line],
  );

  /**
   * Dialogue during generation is queued: each line stays up long enough to read (`hold` ms, by default its typing time plus a
   * beat) before the next one, so fast steps don't flash by. Only the show waits; the pipeline runs at full speed.
   */
  const queue = useRef<Array<{ line: Line; hold: number; onShow?: () => void }>>([]);
  const heldUntil = useRef(0);
  const pumpTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (pumpTimer.current) window.clearTimeout(pumpTimer.current);
  }, []);
  function showLine(next: Line) {
    setLines((current) => [...current, next]);
    setIndex(Number.MAX_SAFE_INTEGER);
  }
  function pump() {
    if (pumpTimer.current) return;
    const wait = heldUntil.current - performance.now();
    if (wait > 0) {
      pumpTimer.current = window.setTimeout(() => {
        pumpTimer.current = null;
        pump();
      }, wait);
      return;
    }
    const beat = queue.current.shift();
    if (!beat) return;
    showLine(beat.line);
    beat.onShow?.();
    heldUntil.current = performance.now() + beat.hold;
    pump();
  }
  function say(next: Line, hold = (next.text.length / 48) * 1000 + 1400, onShow?: () => void) {
    queue.current.push({ line: next, hold, onShow });
    pump();
  }
  /** Skips the queue (final line, errors). */
  function sayNow(next: Line) {
    queue.current = [];
    if (pumpTimer.current) window.clearTimeout(pumpTimer.current);
    pumpTimer.current = null;
    heldUntil.current = 0;
    showLine(next);
  }
  // Progress while a puzzle is made: a stage-by-stage bar on the top screen, and banter during the long modelling wait.
  const [progress, setProgress] = useState<{ stage: keyof typeof PROGRESS; since: number } | null>(null);
  const [percent, setPercent] = useState(0);
  const family = useRef<Progress["family"]>(undefined);
  const STAGE_ORDER: Array<keyof typeof PROGRESS> = ["start", "fetch", "rank", "model", "save"];
  function track(event: Progress) {
    if (event.stage === "pick" && event.family) family.current = event.family;
    if (event.status !== "active" || !(event.stage in PROGRESS)) return;
    const next = event.stage as keyof typeof PROGRESS;
    setProgress((current) => (current && STAGE_ORDER.indexOf(next) <= STAGE_ORDER.indexOf(current.stage) ? current : { stage: next, since: performance.now() }));
  }
  useEffect(() => {
    if (!progress) return;
    const slice = PROGRESS[progress.stage];
    const update = () => {
      const seconds = (performance.now() - progress.since) / 1000;
      const eased = 1 - Math.exp(-seconds / (slice.seconds / 2));
      setPercent(Math.min(slice.to - 0.5, slice.from + (slice.to - slice.from) * eased));
    };
    update();
    const timer = window.setInterval(update, 300);
    return () => window.clearInterval(timer);
  }, [progress]);
  const modelling = progress?.stage === "model";
  useEffect(() => {
    if (!modelling) return;
    const lines = banter(family.current);
    let next = 0;
    // Only when nothing else is queued, and ~5s after the last line finished: company, not chatter.
    const timer = window.setInterval(() => {
      if (next >= lines.length || queue.current.length || performance.now() < heldUntil.current + 5000) return;
      say(lines[next++]);
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelling]);


  // Intro music: a random puzzle's soundtrack. Browsers only allow sound after a tap or key press, so it starts right away when
  // that already happened (e.g. back from a puzzle), otherwise on the first one, with a blinking "TAP TO START" until then.
  const hasTracks = puzzles.some((puzzle) => puzzle.musicFile);
  const [musicOn, setMusicOn] = useState(false);
  // ?audiodebug: a small on-screen panel with the audio state and what happened (phones have no console to look at).
  const [audioDebug, setAudioDebug] = useState<{ state: string; active: string; log: string[] } | null>(null);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("audiodebug")) return;
    const update = () => setAudioDebug({ state: audioState(), active: String(navigator.userActivation?.hasBeenActive ?? "n/a"), log: [...audioLog()] });
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, []);
  // The TAP TO START cover calls this from its own click: a real button's click is the surest unlock on iPhone.
  const beginMusic = useRef<() => void>(() => {});
  useEffect(() => {
    const tracks = puzzles.filter((puzzle) => puzzle.musicFile);
    if (!tracks.length) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let started = false;
    let pending = false;
    // Finished taps only: iOS won't start audio from a touch-down (pointerdown).
    const events = ["pointerup", "touchend", "click", "keydown"] as const;
    const unlisten = () => {
      for (const name of events) window.removeEventListener(name, begin, true);
    };
    async function begin() {
      if (started || pending) return;
      unlockAudio(); // synchronously, inside the tap
      pending = true;
      const pick = tracks[Math.floor(Math.random() * tracks.length)];
      const stopTrack = await playLoop(`/api/puzzles/${pick.id}/music`, pick.bpm).catch(() => null);
      pending = false;
      if (cancelled) return stopTrack?.();
      // Didn't start (audio still locked, or the track failed): keep listening, the next tap tries again.
      if (!stopTrack) return;
      started = true;
      unlisten();
      stop = stopTrack;
      setMusicOn(true);
      if (stage.current.show) stage.current.show = { ...stage.current.show, beat: true };
    }
    beginMusic.current = () => void begin();
    for (const name of events) window.addEventListener(name, begin, true);
    if (navigator.userActivation?.hasBeenActive) void begin();
    return () => {
      cancelled = true;
      unlisten();
      stop?.();
    };
  }, [puzzles]);

  // While puzzles are being made in the background, refresh the list now and then so the new one appears by itself.
  useEffect(() => {
    if (!jobs.length || busy) return;
    const timer = window.setInterval(() => router.refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [jobs.length, busy, router]);

  // /?demo plays the whole generation show with sample data, so it can be previewed for free.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("demo")) return;
    const steps: Array<[number, Progress]> = [
      [600, { type: "stage", stage: "fetch", status: "active" }],
      [2200, { type: "stage", stage: "fetch", status: "done", detail: "20 pull requests" }],
      [2300, { type: "stage", stage: "rank", status: "active" }],
      [3200, { type: "stage", stage: "rank", status: "done", detail: "civic/bus-times#77 scored 87%", cards: DEMO_CARDS.map((card, index) => ({ ...card, score: 0.87 - index * 0.09 })) }],
      [3300, { type: "stage", stage: "pick", status: "done", component: "Midnight wraparound" }],
      [3350, { type: "stage", stage: "music", status: "active", props: DEMO_PROPS }],
      [3400, { type: "stage", stage: "model", status: "active" }],
      [9000, { type: "stage", stage: "music", status: "done" }],
      [16000, { type: "stage", stage: "model", status: "done", detail: "12 cases · 3 changed" }],
    ];
    stage.current.show = { mode: "fetching", cards: [], picked: null, headline: "", beat: false };
    const timers = steps.map(([at, event]) =>
      window.setTimeout(() => {
        track(event);
        direct(event);
        const next = progressLine(event);
        if (next) say(next);
      }, at),
    );
    timers.push(
      window.setTimeout(() => {
        stage.current.show = { ...stage.current.show!, mode: "done" };
        setProgress(null);
      }, 17000),
    );
    timers.push(window.setTimeout(() => (stage.current.show = { mode: "idle", cards: [], picked: null, headline: "", beat: false, props: DEMO_PROPS }), 21000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // Mount-only: plays the sample show once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Drives the top-screen show from the server's progress events. */
  function direct(event: Progress) {
    const show = stage.current.show!;
    if (event.stage === "fetch" && event.status === "done" && event.detail === "already made") stage.current.show = { ...show, headline: "ALREADY MADE" };
    else if (event.stage === "fetch" && event.status === "done") stage.current.show = { ...show, mode: "fetching", headline: `${event.detail?.toUpperCase() ?? ""} FOUND` };
    else if (event.stage === "rank" && event.status === "done" && event.cards) {
      // The top five drop in with their scores and hop while it's read out; then a drawn-out reveal (Gemini Decisions is
      // too quick to follow). The winner hops onto the stage exactly when it's named, then the modelling show starts.
      stage.current.show = { ...show, cards: event.cards, picked: null, mode: "fetching" };
      const land = (event.cards.length * 0.45 + 0.9) * 1000;
      const advance = (from: string[], to: "reading" | "picked" | "modelling", at: number) =>
        window.setTimeout(() => {
          const current = stage.current.show;
          if (current && from.includes(current.mode)) stage.current.show = { ...current, mode: to, ...(to === "picked" ? { picked: 0 } : {}) };
        }, at);
      advance(["fetching"], "reading", land);
      const top = event.cards[0];
      const score = top.score !== undefined ? ` (${Math.round(top.score * 100)}%)` : "";
      say({ who: "del", text: `Scores are in! ${event.cards.length > 1 ? "Only one" : "One"} gets to be today's puzzle...` }, 3000);
      say({ who: "add", text: "And the winner is..." }, 2600, () => sfx.drumroll());
      say({ who: "add", text: `${top.repository} #${top.number}${score}! "${top.title}"` }, 4400, () => {
        sfx.found();
        advance(["fetching", "reading"], "picked", 0);
        advance(["fetching", "reading", "picked"], "modelling", 4200);
      });
    } else if (event.stage === "pick" && event.status === "done") stage.current.show = { ...stage.current.show!, headline: event.component ?? "" };
    else if (event.stage === "music") {
      // The generated props arrive with the music events and pop onto the stage.
      stage.current.show = { ...stage.current.show!, ...(event.props?.length ? { props: event.props } : {}), ...(event.status === "done" ? { beat: true } : {}) };
    }
  }

  async function create() {
    if (busy) return;
    sfx.select();
    setBusy(true);
    setError("");
    family.current = undefined;
    setPercent(0);
    setProgress({ stage: "start", since: performance.now() });
    stage.current.show = { mode: "fetching", cards: [], picked: null, headline: "", beat: false };
    say({ who: "add", text: "A new one? On it." });
    try {
      const response = await fetch("/api/puzzles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only when the PR link field is open: a link left in a hidden field must not hijack "+ New puzzle".
        body: JSON.stringify({ prUrl: (showUrl && prUrl.trim()) || undefined, family: kind === "all" ? undefined : kind }),
      });
      if (!response.body) throw new Error("No response from the server.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          const message = JSON.parse(part) as Progress | { type: "done"; puzzle: Puzzle } | { type: "error"; message: string };
          if (message.type === "stage") {
            track(message);
            direct(message);
            const next = progressLine(message);
            if (next) (message.stage === "save" ? sayNow : say)(next);
          } else if (message.type === "done") {
            setProgress(null);
            sfx.found();
            stage.current.show = { ...stage.current.show!, mode: "done" };
            // Let the confetti land before leaving.
            await new Promise((resolve) => setTimeout(resolve, 2200));
            router.push(`/play/${message.puzzle.id}`);
            return;
          } else {
            throw new Error(message.message);
          }
        }
      }
      throw new Error("The connection dropped. Try again?");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Something went wrong.";
      setError(message);
      stage.current.show = { ...stage.current.show!, mode: "error", headline: message };
      setProgress(null);
      sayNow({ who: "del", text: `Ugh. ${message}` });
      setBusy(false);
    }
  }

  return (
    <DSShell
      top={
        <>
          <PS1Stage state={stage} />
          {hasTracks && !musicOn && !progress && (
            // A real button over the stage (the text box stays on top of it): tapping anywhere up here starts the music.
            <button className="press-start-cover" onClick={() => beginMusic.current()} aria-label="Start the music">
              <span className="press-start">▶ TAP TO START ♪</span>
            </button>
          )}
          {audioDebug && (
            <pre className="audio-debug">
              {`audio: ${audioDebug.state} · activated: ${audioDebug.active}\n${audioDebug.log.join("\n")}`}
            </pre>
          )}
          {progress && (
            <div className="gen-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(percent)} aria-label="Making a puzzle">
              <span>{PROGRESS[progress.stage].label}</span>
              <span className="gen-bar">
                <i style={{ width: `${Math.floor(percent / 5) * 5}%` }} />
              </span>
              <span>{Math.floor(percent)}%</span>
            </div>
          )}
          <TextBox
            line={line}
            onTyping={onTyping}
            onNext={index < lines.length - 1 ? () => setIndex((value) => Math.min(value, lines.length - 1) + 1) : undefined}
          />
        </>
      }
      bottom={
        <div className="menu">
          <header className="menu-head">
            <h1 className="logo">
              <Logo />
            </h1>
            <p>Real code changes. Tiny brain teasers.</p>
          </header>

          {howto && <HowToPlay item={(line as TutorialLine | null)?.item} onClose={closeHowto} />}

          <div className="menu-actions">
            <button className="px-btn px-btn-go" onClick={create} disabled={busy}>
              {busy ? "Making one..." : kind === "all" ? "+ New puzzle" : `+ New ${FAMILY_BADGES[kind]} puzzle`}
            </button>
            <button className="px-btn px-btn-small" onClick={() => setShowUrl((value) => !value)} disabled={busy} aria-expanded={showUrl}>
              PR link
            </button>
            {!howto && (
              <button className="px-btn px-btn-small" onClick={openHowto} aria-label="How to play">
                ?
              </button>
            )}
          </div>
          {showUrl && (
            <label className="url-field">
              <span>Paste a GitHub pull request (or an issue that links to one)</span>
              <input value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" inputMode="url" disabled={busy} />
            </label>
          )}
          {error && <p className="menu-error" role="alert">{error}</p>}

          <div className="kind-filter" role="group" aria-label="Kind of puzzle">
            {(["all", "logic", "numeric", "visual", "flow", "ai"] as const).map((option) => (
              <button
                key={option}
                className={`kind-chip ${option === "all" ? "kind-all" : `kind-${option}`}`}
                aria-pressed={kind === option}
                onClick={() => {
                  sfx.cycle();
                  setKind(option);
                }}
              >
                {option === "all" ? "ALL" : FAMILY_BADGES[option]}
              </button>
            ))}
          </div>
          {(busy || jobs.length > 0) && (
            <p className="menu-wait">Bored of waiting? Play one of the ones already made. The new one keeps cooking and pops up here.</p>
          )}
          <ul className="menu-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <span className="menu-item menu-cooking" aria-live="polite">
                  <span className="menu-arrow menu-spinner" aria-hidden>
                    ◐
                  </span>
                  <span className="menu-text">
                    <strong>Being made…</strong>
                    <small>{job.repository ? `${job.repository} · ${job.title ?? ""}` : "Finding a pull request"}</small>
                  </span>
                </span>
              </li>
            ))}
            {shown.map((puzzle) => (
              <li key={puzzle.id}>
                <Link href={`/play/${puzzle.id}`} className="menu-item" onClick={() => sfx.select()}>
                  <span className="menu-arrow" aria-hidden>▶</span>
                  <span className="menu-text">
                    <strong>
                      <KindBadge family={puzzle.family} families={puzzle.families} /> {puzzle.title}
                    </strong>
                    <small>
                      {puzzle.pr.repository} · {puzzle.component.name}
                    </small>
                  </span>
                </Link>
              </li>
            ))}
            {!shown.length && (
              <li className="menu-empty">{kind === "all" ? "No puzzles yet. Make the first one!" : `No ${FAMILY_BADGES[kind]} puzzles yet. Make one!`}</li>
            )}
          </ul>
        </div>
      }
    />
  );
}
