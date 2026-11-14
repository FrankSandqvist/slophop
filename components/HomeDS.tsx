"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MascotKind } from "@/lib/mascot";
import { playLoop, sfx } from "@/lib/sound";
import type { PropSpec, Puzzle, StageCard } from "@/lib/types";
import { DSShell, TextBox, type Line } from "./DS";
import { HowToPlay, TUTORIAL, TUTORIAL_KEY, type TutorialLine } from "./HowToPlay";
import { PS1Stage, type StageState } from "./PS1Stage";

type Summary = Pick<Puzzle, "id" | "title" | "pr" | "component" | "musicFile" | "bpm">;
type Progress = {
  type: "stage";
  stage: "fetch" | "rank" | "pick" | "model" | "music" | "fmv" | "save";
  status: "active" | "done" | "skipped";
  detail?: string;
  cards?: StageCard[];
  pick?: number;
  component?: string;
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
];

/** What the two say while a puzzle is being made. */
function progressLine(event: Progress): Line | null {
  if (event.stage === "fetch" && event.status === "active") return { who: "del", text: "Grabbing fifty fresh pull requests made with AI coding tools..." };
  if (event.stage === "fetch" && event.status === "done") return { who: "add", text: `Got ${event.detail}. Let's see which one's the juiciest.` };
  if (event.stage === "rank" && event.status === "active") return { who: "del", text: "Gemini Decisions is scoring every one. Logic, size, who'd notice..." };
  if (event.stage === "rank" && event.status === "done") return { who: "add", text: `Winner: ${event.detail}!` };
  if (event.stage === "model" && event.status === "active") return { who: "del", text: "Now running the old me and the new Green side by side. Every case." };
  if (event.stage === "model" && event.status === "done") return { who: "add", text: `Done: ${event.detail}.` };
  if (event.stage === "fmv" && event.status === "active") return { who: "add", text: "Meanwhile, we're shooting a little movie about it. Lights, camera..." };
  if (event.stage === "save" && event.status === "done") return { who: "add", text: "Ready. Let's go!" };
  return null;
}

export function HomeDS({ puzzles }: { puzzles: Summary[] }) {
  const router = useRouter();
  const stage = useRef<StageState>({ add: "dance", del: "dance", bpm: 96, show: { mode: "idle", cards: [], picked: null, headline: "", beat: false } });
  const [lines, setLines] = useState<Line[]>(INTRO);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState("");
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

  /** Appends a line and jumps to it (the index is clamped to the last line). */
  function say(next: Line) {
    setLines((current) => [...current, next]);
    setIndex(Number.MAX_SAFE_INTEGER);
  }

  // Intro music: a random puzzle's soundtrack. Browsers only allow sound after a tap or key press, so it starts right away when
  // that already happened (e.g. back from a puzzle), otherwise on the first one, with a blinking "TAP TO START" until then.
  const hasTracks = puzzles.some((puzzle) => puzzle.musicFile);
  const [musicOn, setMusicOn] = useState(false);
  useEffect(() => {
    const tracks = puzzles.filter((puzzle) => puzzle.musicFile);
    if (!tracks.length) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let started = false;
    const unlisten = () => {
      window.removeEventListener("pointerdown", begin, true);
      window.removeEventListener("keydown", begin, true);
    };
    async function begin() {
      if (started) return;
      started = true;
      unlisten();
      const pick = tracks[Math.floor(Math.random() * tracks.length)];
      const stopTrack = await playLoop(`/api/puzzles/${pick.id}/music`, pick.bpm).catch(() => null);
      if (cancelled) return stopTrack?.();
      if (!stopTrack) return;
      stop = stopTrack;
      setMusicOn(true);
      if (stage.current.show) stage.current.show = { ...stage.current.show, beat: true };
    }
    if (navigator.userActivation?.hasBeenActive) void begin();
    else {
      window.addEventListener("pointerdown", begin, true);
      window.addEventListener("keydown", begin, true);
    }
    return () => {
      cancelled = true;
      unlisten();
      stop?.();
    };
  }, [puzzles]);

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
        direct(event);
        const next = progressLine(event);
        if (next) say(next);
      }, at),
    );
    timers.push(window.setTimeout(() => (stage.current.show = { ...stage.current.show!, mode: "done" }), 17000));
    timers.push(window.setTimeout(() => (stage.current.show = { mode: "idle", cards: [], picked: null, headline: "", beat: false, props: DEMO_PROPS }), 21000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  /** Drives the top-screen show from the server's progress events. */
  function direct(event: Progress) {
    const show = stage.current.show!;
    if (event.stage === "fetch" && event.status === "done") stage.current.show = { ...show, mode: "fetching", headline: `${event.detail?.toUpperCase() ?? ""} FOUND` };
    else if (event.stage === "rank" && event.status === "done" && event.cards) {
      // The top five drop in with their scores, then a little timeline: read them, crown the winner, run the logic.
      stage.current.show = { ...show, cards: event.cards, picked: null, mode: "fetching" };
      const land = (event.cards.length * 0.45 + 0.9) * 1000;
      const advance = (from: string[], to: "reading" | "picked" | "modelling", at: number) =>
        window.setTimeout(() => {
          const current = stage.current.show;
          if (current && from.includes(current.mode)) stage.current.show = { ...current, mode: to, ...(to === "picked" ? { picked: 0 } : {}) };
        }, at);
      advance(["fetching"], "reading", land);
      advance(["fetching", "reading"], "picked", land + 2600);
      advance(["fetching", "reading", "picked"], "modelling", land + 5200);
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
    stage.current.show = { mode: "fetching", cards: [], picked: null, headline: "", beat: false };
    say({ who: "add", text: "A new one? On it." });
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
            direct(message);
            const next = progressLine(message);
            if (next) say(next);
          } else if (message.type === "done") {
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
      say({ who: "del", text: `Ugh. ${message}` });
      setBusy(false);
    }
  }

  return (
    <DSShell
      top={
        <>
          <PS1Stage state={stage} />
          {hasTracks && !musicOn && <span className="press-start">▶ TAP TO START ♪</span>}
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
              <span className="logo-slop">SLOP</span>
              <span className="logo-hop">HOP</span>
            </h1>
            <p>Real code changes. Tiny brain teasers.</p>
          </header>

          {howto && <HowToPlay item={(line as TutorialLine | null)?.item} onClose={closeHowto} />}

          <div className="menu-actions">
            <button className="px-btn px-btn-go" onClick={create} disabled={busy}>
              {busy ? "Making one..." : "+ New puzzle"}
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
              <span>Paste a GitHub pull request</span>
              <input value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" inputMode="url" disabled={busy} />
            </label>
          )}
          {error && <p className="menu-error" role="alert">{error}</p>}

          <ul className="menu-list">
            {puzzles.map((puzzle) => (
              <li key={puzzle.id}>
                <Link href={`/play/${puzzle.id}`} className="menu-item" onClick={() => sfx.select()}>
                  <span className="menu-arrow" aria-hidden>▶</span>
                  <span className="menu-text">
                    <strong>{puzzle.title}</strong>
                    <small>
                      {puzzle.pr.repository} · {puzzle.component.name}
                    </small>
                  </span>
                </Link>
              </li>
            ))}
            {!puzzles.length && <li className="menu-empty">No puzzles yet. Make the first one!</li>}
          </ul>
        </div>
      }
    />
  );
}
