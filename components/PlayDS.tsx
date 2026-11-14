"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MascotKind, MascotMood } from "@/lib/mascot";
import { playLoop, setMuted, sfx } from "@/lib/sound";
import { caseLabel, formatNumber, numericRow, outcome, pointAt, roundTo, storyOf, valueLabel, visualRow, voteRow, type Puzzle, type PuzzleRow, type Round, type VoteTally } from "@/lib/types";
import { Fmv } from "./Fmv";
import { Keypad, NumberCase, NumberLine, NumberResults, VisualSpot, VisualWhich } from "./Families";
import { DSShell, TextBox, type Line } from "./DS";
import { PS1Stage, type StageState } from "./PS1Stage";
import {
  CaseChips,
  ClaimCard,
  CodeCard,
  EdgePick,
  OddOneOut,
  OutcomeCards,
  Outcomes,
  PatternPick,
  PivotPick,
  RuleBubble,
  RuleFill,
  RulesSheet,
  SayBubble,
  TweakPick,
  Vote,
  WhoPick,
} from "./Rounds";

const BPM = 96;

/** "explain": after a step's reveal, why Red and Green did what they did in that exact case. */
type Phase = { kind: "intro" } | { kind: "round"; index: number } | { kind: "explain"; index: number } | { kind: "end" };
type Result = { row: PuzzleRow; correct: boolean };

function pickLine<T>(options: T[]) {
  return options[Math.floor(Math.random() * options.length)];
}

const rowOf = (puzzle: Puzzle, key: string) => puzzle.table.find((row) => row.key === key)!;
const rowsOf = (puzzle: Puzzle, keys: string[]) => keys.map((key) => rowOf(puzzle, key)).filter(Boolean);

/** Red's claim about Green, in words. */
function claimText(puzzle: Puzzle, round: Extract<Round, { kind: "claim" }>) {
  const input = puzzle.inputs[round.input];
  return `When ${input?.label.toLowerCase()} is "${valueLabel(puzzle, round.input, round.value)}", Green always ends at "${outcome(puzzle, round.outcome)?.label}".`;
}

const stateOf = (puzzle: Puzzle, id: string) => puzzle.visual?.states.find((state) => state.id === id);

/** The case a step was about, as a compact recap above its explainer: the values and what each of them did. */
function CaseRecap({ puzzle, round, row }: { puzzle: Puzzle; round: Round; row: PuzzleRow }) {
  if (puzzle.numeric && row.key.startsWith("x~")) {
    const x = Number(row.key.slice(2));
    return (
      <>
        <NumberCase model={puzzle.numeric} x={x} />
        <NumberResults model={puzzle.numeric} x={x} />
      </>
    );
  }
  if (puzzle.visual && (round.kind === "vis-which" || round.kind === "vis-spot")) {
    const state = stateOf(puzzle, round.state);
    return (
      <div className="case case-base">
        <span className="chips">
          <span className="chip">{state?.label}</span>
        </span>
        <span className="case-note">{state?.story}</span>
      </div>
    );
  }
  if (!puzzle.table.some((entry) => entry.key === row.key)) return null;
  return (
    <>
      <div className="case case-base">
        <CaseChips puzzle={puzzle} row={row} />
      </div>
      <Outcomes puzzle={puzzle} row={row} />
    </>
  );
}

/** Whose rules a step is about: Red's for "what did Red do", both when you must tell them apart, else Green's. */
function rulesFor(round: Round): Array<"old" | "new"> {
  if (["who", "num-diff", "num-split", "vis-which", "vis-spot"].includes(round.kind)) return ["old", "new"];
  if (round.kind === "num-predict" && round.side === "old") return ["old"];
  if (round.kind === "predict" && round.side === "old") return ["old"];
  return ["new"];
}

/** The one-line prompt shown above each step (the full question is in the dialogue). */
function goalOf(puzzle: Puzzle, round: Round) {
  switch (round.kind) {
    case "predict":
      return round.side === "new" ? "Using Green's rules: what happens?" : "Using Red's old rules: what happened?";
    case "who":
      return "Whose rules give this result?";
    case "tweak":
      return round.goal === "disagree" ? "Change ONE thing so Red and Green differ" : `Which ONE change makes Green: ${outcome(puzzle, round.target!)?.label}?`;
    case "pattern":
      return "Spot the pattern: what goes in the ?";
    case "edge":
      return "Where does Green change its mind?";
    case "odd":
      return "Tap the odd one out";
    case "rule":
      return "Finish Green's rule";
    case "pivot":
      return "Which one thing decides it here?";
    case "claim":
      return "True or false?";
    case "num-predict":
      return `${round.side === "new" ? "Green's" : "Red's"} ${puzzle.numeric?.output.label.toLowerCase()}? Key it in`;
    case "num-diff":
      return "How much more does Green give? Key it in";
    case "num-split":
      return "Drag to where Green starts to differ";
    case "num-reach":
      return `Drag to where Green first hits ${formatNumber(round.target, puzzle.numeric?.output.unit ?? "", puzzle.numeric?.output.decimals)}`;
    case "vis-which":
      return "Which picture is Green's?";
    case "vis-spot":
      return "Tap what changed in Green's picture";
  }
}

/** What the guys say when a step starts. Fixed copy: Gemini only fills in the labels and stories. */
function roundLine(puzzle: Puzzle, round: Round): Line {
  const story = (key: string) => storyOf(puzzle, rowOf(puzzle, key));
  switch (round.kind) {
    case "predict":
      return round.side === "new"
        ? { who: "add", text: `Picture it: ${story(round.row)}. Use my rules: what do I do?` }
        : { who: "del", text: `Picture it: ${story(round.row)}. Before this change, I was in charge. What did I do?` };
    case "who": {
      const row = rowOf(puzzle, round.row);
      return { who: "del", text: `When ${story(round.row)}, the result is "${outcome(puzzle, round.shown === "old" ? row.old : row.new)?.label}". My old rules, or Green's new ones?` };
    }
    case "tweak":
      return round.goal === "disagree"
        ? { who: "add", text: `Right now Red and I agree: ${story(round.base)}. Change ONE thing so we don't.` }
        : { who: "del", text: `Let's try to break Green. Change ONE thing so it ends at "${outcome(puzzle, round.target!)?.label}".` };
    case "pattern":
      return { who: "add", text: "Here's what I did in a few cases. Each one differs from the last row by one thing. Spot the pattern!" };
    case "edge":
      return { who: "del", text: `As ${puzzle.inputs[round.input].label.toLowerCase()} goes up, Green changes its mind once. Where?` };
    case "odd":
      return { who: "del", text: "Three of these end the same way with Green. One doesn't. Which?" };
    case "rule":
      return { who: "add", text: `Finish my rule: when do I ALWAYS end at "${outcome(puzzle, round.outcome)?.label}"?` };
    case "pivot":
      return { who: "del", text: `Picture it: ${story(round.row)}. Only ONE of those things decides what Green does. Which?` };
    case "claim":
      return { who: "del", text: `I reckon: ${claimText(puzzle, round)} True or false?` };
    case "num-predict": {
      const model = puzzle.numeric!;
      const at = `${model.input.label}: ${formatNumber(round.x, model.input.unit)}.`;
      return round.side === "new"
        ? { who: "add", text: `${at} Use my rules: what's my ${model.output.label.toLowerCase()}? Key it in.` }
        : { who: "del", text: `${at} Before the change, I was in charge. What was my ${model.output.label.toLowerCase()}?` };
    }
    case "num-diff": {
      const model = puzzle.numeric!;
      return { who: "del", text: `${model.input.label}: ${formatNumber(round.x, model.input.unit)}. How much more do you get from Green than from me? If it's less, key in a minus.` };
    }
    case "num-split":
      return { who: "add", text: "Red's line is drawn in. Slide along it to the first spot where my result comes out different." };
    case "num-reach": {
      const model = puzzle.numeric!;
      return { who: "add", text: `Slide along: what's the smallest ${model.input.label.toLowerCase()} where my ${model.output.label.toLowerCase()} hits ${formatNumber(round.target, model.output.unit, model.output.decimals)}?` };
    }
    case "vis-which":
      return { who: "del", text: `Picture it: ${stateOf(puzzle, round.state)?.story ?? ""}. One of these is me, one is Green. Which is Green's?` };
    case "vis-spot":
      return { who: "add", text: `Picture it: ${stateOf(puzzle, round.state)?.story ?? ""}. This is me now. Tap the part that changed.` };
  }
}

export function PlayDS({ puzzle, initialVotes }: { puzzle: Puzzle; initialVotes: VoteTally }) {
  const stage = useRef<StageState>({
    add: "idle",
    del: "idle",
    bpm: puzzle.bpm ?? BPM,
    show: { mode: "idle", cards: [], picked: null, headline: puzzle.title.toUpperCase(), beat: Boolean(puzzle.musicFile), props: puzzle.props ?? [] },
  });
  const reactions = useRef<Partial<Record<MascotKind, number>>>({});
  const stopMusic = useRef<(() => void) | null>(null);
  const stepPanel = useRef<HTMLDivElement>(null);
  const phaseIsEnd = useRef(false);
  const [phase, setPhase] = useState<Phase>({ kind: "intro" });
  const [script, setScript] = useState<Line[]>(() => [
    { who: "narrator", text: `${puzzle.pr.repository}. ${puzzle.project}` },
    ...(puzzle.where ? [{ who: "narrator" as const, text: `Where we are: ${puzzle.where}` }] : []),
    ...(puzzle.scenario ? [{ who: "narrator" as const, text: puzzle.scenario }] : []),
    { who: "narrator", text: `This pull request: ${puzzle.change}` },
    // Each reads out their rulebook: the puzzles are worked out from these.
    ...(puzzle.rules?.old ?? []).map((rule, index) => ({ who: "del" as const, text: `${index === 0 ? "My old rules. " : ""}${rule}` })),
    ...(puzzle.rules?.new ?? []).map((rule, index) => ({ who: "add" as const, text: `${index === 0 ? "My new rules! " : ""}${rule}` })),
    { who: "narrator", text: "Both rulebooks are below, and behind the Rules button. Ready?" },
  ]);
  const [lineIndex, setLineIndex] = useState(0);
  // The cutscene plays first (if this puzzle has one); its lines follow the video, then the intro script takes over.
  const [fmvPlaying, setFmvPlaying] = useState(Boolean(puzzle.fmv));
  const [fmvLine, setFmvLine] = useState(-1);
  const fmvLines = useMemo<Line[]>(() => (puzzle.fmv?.lines ?? []).map((entry) => ({ who: entry.who, text: entry.text })), [puzzle]);
  const [picked, setPicked] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [results, setResults] = useState<boolean[]>([]);
  const [muted, setMutedState] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  const round = phase.kind === "round" ? puzzle.rounds[phase.index] : null;
  const line = fmvPlaying ? (fmvLines[fmvLine] ?? null) : (script[Math.min(lineIndex, script.length - 1)] ?? null);

  useEffect(() => () => stopMusic.current?.(), []);

  // ?round=N jumps straight to step N (1-based): handy for previewing each step type.
  useEffect(() => {
    const wanted = Number(new URLSearchParams(window.location.search).get("round"));
    if (wanted >= 1 && wanted <= puzzle.rounds.length) startRound(wanted - 1);
    // Arriving by a tap (e.g. from the menu) already allows sound, so the soundtrack can start with the cutscene.
    else if (navigator.userActivation?.hasBeenActive) void startMusic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Steps never scroll: if one is too tall (long labels), switch it to the dense layout (tighter padding, same font).
  useLayoutEffect(() => {
    const panel = stepPanel.current;
    if (!panel) return;
    const fit = () => {
      // Fallbacks in order: tighter padding, then the rules bubble goes (the Rules button has it), then spare rows.
      const levels = ["dense", "no-rules", "denser"];
      panel.classList.remove(...levels);
      for (const level of levels) {
        if (panel.scrollHeight <= panel.clientHeight + 1) break;
        panel.classList.add(level);
      }
    };
    fit();
    void document.fonts?.ready.then(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [phase, picked, result]);

  // ?qa logs whether the current step overflows its fixed screen (used by headless layout checks).
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("qa")) return;
    // ?qa=answer also auto-answers, to measure the after-answer layout.
    if (new URLSearchParams(window.location.search).get("qa") === "answer" && round && !result) {
      const first: Record<Round["kind"], () => string> = {
        predict: () => puzzle.outcomes[0].id,
        who: () => "add",
        tweak: () => (round.kind === "tweak" ? round.options[0] : ""),
        pattern: () => puzzle.outcomes[0].id,
        edge: () => "1",
        odd: () => (round.kind === "odd" ? round.rows[0] : ""),
        rule: () => (round.kind === "rule" ? puzzle.inputs[round.input].values[0].id : ""),
        pivot: () => "0",
        claim: () => "true",
        "num-predict": () => "0",
        "num-diff": () => "0",
        "num-split": () => String(puzzle.numeric?.points[0].x ?? 0),
        "num-reach": () => String(puzzle.numeric?.points[0].x ?? 0),
        "vis-which": () => "a",
        "vis-spot": () => "none",
      };
      window.setTimeout(() => answer(first[round.kind]()), 300);
    }
    const timer = window.setTimeout(() => {
      const panel = document.querySelector<HTMLElement>(".panel-step");
      if (panel) console.log(`QA step ${phase.kind === "round" ? phase.index + 1 : "-"}: scroll ${panel.scrollHeight} / client ${panel.clientHeight} -> ${panel.scrollHeight > panel.clientHeight + 1 ? "OVERFLOW" : "fits"} [${[...panel.classList].filter((name) => !name.startsWith("panel")).join(" ") || "roomy"}]`);
      console.log(`QA page: ${document.documentElement.scrollHeight} / ${window.innerHeight} -> ${document.documentElement.scrollHeight > window.innerHeight + 1 ? "PAGE SCROLLS" : "page fits"}`);
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, result]);

  const mood = useCallback((kind: MascotKind, value: MascotMood, ms = 0) => {
    stage.current[kind] = value;
    window.clearTimeout(reactions.current[kind]);
    if (ms) reactions.current[kind] = window.setTimeout(() => (stage.current[kind] = phaseIsEnd.current ? "dance" : "idle"), ms);
  }, []);

  const onTyping = useCallback(
    (typing: boolean) => {
      if (!line || line.who === "narrator") return;
      if (typing) mood(line.who, "talk");
      else if (stage.current[line.who] === "talk") mood(line.who, phaseIsEnd.current ? "dance" : "idle");
    },
    [line, mood],
  );

  function say(next: Line) {
    setScript((current) => [...current, next]);
    setLineIndex(Number.MAX_SAFE_INTEGER);
  }

  /** After a reveal: the case explainer if there is one, else straight on. */
  function afterReveal(index: number) {
    const explainer = puzzle.explainers?.[index];
    if (!explainer || !(explainer.red || explainer.green)) return startRound(index + 1);
    sfx.select();
    setRulesOpen(false);
    setPhase({ kind: "explain", index });
    // Red, then Green, then the takeaway, one tap at a time on the top screen.
    const lines: Line[] = [
      ...(explainer.red ? [{ who: "del" as const, text: explainer.red }] : []),
      ...(explainer.green ? [{ who: "add" as const, text: explainer.green }] : []),
      ...(explainer.why ? [{ who: "narrator" as const, text: explainer.why }] : []),
    ];
    setLineIndex(script.length);
    setScript([...script, ...lines]);
  }

  function startRound(index: number) {
    const next = puzzle.rounds[index];
    setRulesOpen(false);
    if (!next) {
      phaseIsEnd.current = true;
      setPhase({ kind: "end" });
      mood("add", "dance");
      mood("del", "dance");
      say({ who: "add", text: "That's the change! Every vote you left adds to the crowd check on this pull request." });
      return;
    }
    setFmvPlaying(false);
    setPhase({ kind: "round", index });
    setPicked(null);
    setResult(null);
    say(roundLine(puzzle, next));
  }

  async function startMusic() {
    if (puzzle.musicFile && !stopMusic.current) {
      stopMusic.current = () => {};
      stopMusic.current = await playLoop(`/api/puzzles/${puzzle.id}/music`, puzzle.bpm).catch(() => null);
    }
  }

  async function start() {
    sfx.select();
    await startMusic();
    startRound(0);
  }

  function finish(row: PuzzleRow, correct: boolean, reaction: Line) {
    setResult({ row, correct });
    setResults((current) => [...current, correct]);
    if (correct) sfx.right();
    else sfx.wrong();
    const speaker: MascotKind = reaction.who === "del" ? "del" : "add";
    mood(speaker, correct ? "cheer" : "talk", 1800);
    mood(speaker === "add" ? "del" : "add", correct ? "idle" : "shake", 900);
    say(reaction);
  }

  /** One handler for every step: compare the pick with the answer and react. */
  function answer(choice: string) {
    if (!round || result) return;
    setPicked(choice);
    const speak = (text: string, who: MascotKind = "add"): Line => ({ who, text });
    switch (round.kind) {
      case "predict": {
        const row = rowOf(puzzle, round.row);
        const truth = round.side === "new" ? row.new : row.old;
        const correct = choice === truth;
        return finish(
          row,
          correct,
          correct
            ? speak(round.side === "new" ? pickLine(["Nailed it. That's exactly what I do.", "Ding! You read my rules right."]) : "Yep, that's how I used to do it.", round.side === "new" ? "add" : "del")
            : speak(`Not quite: ${round.side === "new" ? "Green" : "Red"} does "${outcome(puzzle, truth)?.label}" here.`, "del"),
        );
      }
      case "who": {
        const culprit: MascotKind = round.shown === "old" ? "del" : "add";
        const correct = choice === culprit;
        return finish(
          rowOf(puzzle, round.row),
          correct,
          correct ? speak(culprit === "add" ? "Yep, that's my new rule." : "Guilty. That's my old rule.", culprit) : speak("Not me! Check the rules again.", choice as MascotKind),
        );
      }
      case "tweak": {
        const correct = choice === round.answer;
        return finish(
          rowOf(puzzle, choice),
          correct,
          correct
            ? speak(round.goal === "disagree" ? "That's the one! That's exactly where the change bites." : "You broke it. Is that okay? Vote below.", round.goal === "disagree" ? "add" : "del")
            : speak("That change doesn't do it. See what happens instead.", "del"),
        );
      }
      case "pattern": {
        const row = rowOf(puzzle, round.row);
        const correct = choice === row.new;
        return finish(row, correct, correct ? speak("You cracked the pattern!") : speak(`Close! I do "${outcome(puzzle, row.new)?.label}" there.`, "del"));
      }
      case "edge": {
        const correct = Number(choice) === round.flip;
        const before = puzzle.inputs[round.input].values[round.flip - 1]?.label;
        const after = puzzle.inputs[round.input].values[round.flip]?.label;
        return finish(rowOf(puzzle, round.rows[round.flip]), correct, correct ? speak(`Exactly: between ${before} and ${after}.`, "del") : speak(`I switch between ${before} and ${after}.`));
      }
      case "odd": {
        const odd = rowOf(puzzle, round.odd);
        const correct = choice === round.odd;
        return finish(odd, correct, correct ? speak(`Yep. That one makes Green do "${outcome(puzzle, odd.new)?.label}".`, "del") : speak("Not that one. Check the marked row."));
      }
      case "rule": {
        const correct = round.answers.includes(choice);
        return finish(voteRow(puzzle, round)!, correct, correct ? speak("That's my rule. No exceptions.") : speak("Nope, Green breaks that one sometimes.", "del"));
      }
      case "pivot": {
        const correct = Number(choice) === round.input;
        const label = puzzle.inputs[round.input].label.toLowerCase();
        return finish(rowOf(puzzle, round.row), correct, correct ? speak(`Right: ${label} is what flips me.`) : speak(`Changing that does nothing here. It's ${label}.`, "del"));
      }
      case "num-predict":
      case "num-diff": {
        const model = puzzle.numeric!;
        const point = pointAt(model, round.x)!;
        const truth = round.kind === "num-diff" ? roundTo(point.new - point.old, model.output.decimals) : round.side === "new" ? point.new : point.old;
        const correct = Math.abs(Number(choice) - truth) < 0.5 * 10 ** -model.output.decimals;
        const said = formatNumber(truth, model.output.unit, model.output.decimals);
        const who: MascotKind = round.kind === "num-predict" && round.side === "old" ? "del" : "add";
        return finish(numericRow(model, round.x), correct, correct ? speak(`Spot on: ${said}.`, who) : speak(`Not quite. It's ${said}.`, who));
      }
      case "num-split":
      case "num-reach": {
        const model = puzzle.numeric!;
        const correct = Number(choice) === round.answer;
        const at = formatNumber(round.answer, model.input.unit);
        return finish(numericRow(model, round.answer), correct, correct ? speak(`Exactly: ${at}. That's where the change kicks in.`) : speak(`It's at ${at}. See my line now.`, "del"));
      }
      case "vis-which": {
        const state = stateOf(puzzle, round.state)!;
        const correct = (choice === "a") === round.greenFirst;
        return finish(visualRow(state), correct, correct ? speak("That's me! The change is outlined.") : speak("Nope, that one's mine. The old look.", "del"));
      }
      case "vis-spot": {
        const state = stateOf(puzzle, round.state)!;
        const correct = state.changed.includes(choice);
        return finish(visualRow(state), correct, correct ? speak("Sharp eyes. That's what changed.") : speak("Not that bit. Watch it flip: the change is outlined.", "del"));
      }
      case "claim": {
        const correct = (choice === "true") === round.truth;
        const row = voteRow(puzzle, round, puzzle.table.find((entry) => entry.values[round.input] === round.value))!;
        return finish(
          row,
          correct,
          round.truth ? speak(correct ? "True! I'm consistent there." : "It's actually true.") : speak(correct ? "Caught me. Here's a case that breaks it." : "False, I'm afraid. See the case below.", "del"),
        );
      }
    }
  }

  const score = results.filter(Boolean).length;
  // Logic puzzles flag table rows; numbers and looks flag the input values / situations people voted on.
  const voteKeys = puzzle.table.length ? puzzle.table.map((row) => row.key) : Object.keys(initialVotes).filter((key) => caseLabel(puzzle, key));
  const flagged = voteKeys
    .map((key) => ({ row: puzzle.table.find((entry) => entry.key === key) ?? null, key, votes: initialVotes[key] }))
    .filter((entry) => entry.votes && entry.votes.right + entry.votes.off > 0)
    .sort((a, b) => b.votes!.off / (b.votes!.right + b.votes!.off) - a.votes!.off / (a.votes!.right + a.votes!.off))
    .slice(0, 3);

  return (
    <DSShell
      top={
        <>
          <PS1Stage state={stage} />
          {fmvPlaying && puzzle.fmv && (
            <Fmv
              src={`/api/puzzles/${puzzle.id}/fmv`}
              lines={puzzle.fmv.lines}
              onLine={setFmvLine}
              onDone={() => {
                setFmvPlaying(false);
                void startMusic();
              }}
            />
          )}
          {round && phase.kind === "round" && <div className="hud">{`${phase.index + 1} / ${puzzle.rounds.length}`}</div>}
          <TextBox
            line={line}
            onTyping={onTyping}
            onNext={!fmvPlaying && lineIndex < script.length - 1 ? () => setLineIndex((value) => Math.min(value, script.length - 1) + 1) : undefined}
          />
        </>
      }
      bottom={
        <div className="play">
          <div className="play-bar">
            <Link href="/" className="px-btn px-btn-icon" aria-label="Back to the menu">◀</Link>
            {/* During a step the bar shows its one-line goal (saves a row on the fixed screen). */}
            <span className={`play-title ${round && phase.kind === "round" ? "play-goal" : ""}`}>
              {round && phase.kind === "round" ? goalOf(puzzle, round) : phase.kind === "explain" ? `Why? Step ${phase.index + 1} of ${puzzle.rounds.length}` : puzzle.title}
            </span>
            <button className="px-btn px-btn-small" onClick={() => setRulesOpen((open) => !open)} aria-expanded={rulesOpen}>Rules</button>
            <button
              className="px-btn px-btn-icon"
              onClick={() => {
                setMuted(!muted);
                setMutedState(!muted);
              }}
              aria-label={muted ? "Sound on" : "Sound off"}
            >
              {muted ? "×" : "♪"}
            </button>
          </div>

          {rulesOpen && <RulesSheet puzzle={puzzle} onClose={() => setRulesOpen(false)} />}

          {phase.kind === "intro" && (
            <div className="panel panel-info">
              <a className="pr-card" href={puzzle.pr.url} target="_blank" rel="noreferrer">
                <span className="pr-repo">{puzzle.pr.repository} #{puzzle.pr.number}</span>
                <strong>{puzzle.pr.title}</strong>
                <small>
                  {puzzle.pr.madeWith ? `A real, public pull request, signed as made with ${puzzle.pr.madeWith}.` : "A real, public pull request."} See it on GitHub ↗
                </small>
              </a>
              <RulesSheet puzzle={puzzle} />
              <button className="px-btn px-btn-go panel-sticky" onClick={start}>Start ▶</button>
            </div>
          )}

          {round && phase.kind === "round" && (
            <div className="panel panel-step" ref={stepPanel}>
              {/* The rules this step is about, said by whoever owns them. Hidden first if the step doesn't fit (Rules button still has them). */}
              {puzzle.rules && (
                <>
                  <div className="step-rules">
                    {rulesFor(round).map((side) => (
                      <RuleBubble key={side} rules={puzzle.rules!} side={side} />
                    ))}
                  </div>
                  {/* On short screens the bubble gives way to this one-line way in. */}
                  <button className="rules-peek" onClick={() => setRulesOpen(true)}>
                    ▸ {rulesFor(round).length > 1 ? "Red's and Green's rules" : rulesFor(round)[0] === "new" ? "Green's rules" : "Red's rules"}: tap to read
                  </button>
                </>
              )}
              {round.kind === "predict" && (
                <>
                  <div className="case case-base"><CaseChips puzzle={puzzle} row={rowOf(puzzle, round.row)} /></div>
                  {result ? <Outcomes puzzle={puzzle} row={result.row} /> : <OutcomeCards puzzle={puzzle} picked={picked} onPick={answer} />}
                </>
              )}
              {round.kind === "who" && (() => {
                const row = rowOf(puzzle, round.row);
                return (
                  <>
                    <div className="case case-base">
                      <CaseChips puzzle={puzzle} row={row} />
                      <span className="case-note">Result: {outcome(puzzle, round.shown === "old" ? row.old : row.new)?.label}</span>
                    </div>
                    {result ? <Outcomes puzzle={puzzle} row={row} /> : <WhoPick picked={picked as MascotKind | null} answer={round.shown === "old" ? "del" : "add"} onPick={answer} />}
                  </>
                );
              })()}
              {round.kind === "tweak" && (
                <TweakPick puzzle={puzzle} base={rowOf(puzzle, round.base)} goal={round.goal} options={rowsOf(puzzle, round.options)} answer={round.answer} picked={picked} onPick={answer} />
              )}
              {round.kind === "pattern" && <PatternPick puzzle={puzzle} examples={rowsOf(puzzle, round.examples)} row={rowOf(puzzle, round.row)} picked={picked} onPick={answer} />}
              {round.kind === "edge" && (
                <EdgePick puzzle={puzzle} input={round.input} rows={rowsOf(puzzle, round.rows)} flip={round.flip} picked={picked === null ? null : Number(picked)} onPick={(gap) => answer(String(gap))} />
              )}
              {round.kind === "odd" && <OddOneOut puzzle={puzzle} rows={rowsOf(puzzle, round.rows)} odd={round.odd} picked={picked} onPick={answer} />}
              {round.kind === "rule" && <RuleFill puzzle={puzzle} input={round.input} outcomeId={round.outcome} answers={round.answers} picked={picked} onPick={answer} />}
              {round.kind === "pivot" && (
                <PivotPick puzzle={puzzle} row={rowOf(puzzle, round.row)} answer={round.input} picked={picked === null ? null : Number(picked)} onPick={(index) => answer(String(index))} />
              )}
              {(round.kind === "num-predict" || round.kind === "num-diff") && puzzle.numeric && (
                <div className="step">
                  <NumberCase model={puzzle.numeric} x={round.x} />
                  {result ? (
                    <NumberResults model={puzzle.numeric} x={round.x} />
                  ) : (
                    <Keypad
                      key={phase.index}
                      unit={puzzle.numeric.output.unit}
                      decimals={puzzle.numeric.output.decimals}
                      negative={round.kind === "num-diff" || puzzle.numeric.points.some((point) => point.new < 0 || point.old < 0)}
                      answered={picked}
                      onSubmit={answer}
                    />
                  )}
                </div>
              )}
              {(round.kind === "num-split" || round.kind === "num-reach") && puzzle.numeric && (
                <NumberLine key={phase.index} model={puzzle.numeric} target={round.kind === "num-reach" ? round.target : undefined} answer={round.answer} picked={picked} onPick={answer} />
              )}
              {round.kind === "vis-which" && puzzle.visual && stateOf(puzzle, round.state) && (
                <VisualWhich model={puzzle.visual} state={stateOf(puzzle, round.state)!} greenFirst={round.greenFirst} picked={picked} onPick={answer} />
              )}
              {round.kind === "vis-spot" && puzzle.visual && stateOf(puzzle, round.state) && (
                <VisualSpot key={phase.index} model={puzzle.visual} state={stateOf(puzzle, round.state)!} picked={picked} onPick={answer} />
              )}
              {round.kind === "claim" && (
                <>
                  <ClaimCard statement={claimText(puzzle, round)} truth={round.truth} answered={picked === null ? null : picked === "true"} onAnswer={(value) => answer(String(value))} />
                  {result && !round.truth && (
                    <div className="case case-base">
                      <CaseChips puzzle={puzzle} row={result.row} />
                      <span className="case-note">Green: {outcome(puzzle, result.row.new)?.label}</span>
                    </div>
                  )}
                </>
              )}

              {result && (
                <div className="after">
                  <Vote key={`${phase.index}-${result.row.key}`} puzzleId={puzzle.id} row={result.row} initial={initialVotes[result.row.key]} />
                  <button className="px-btn px-btn-go" onClick={() => afterReveal(phase.index)}>
                    {puzzle.explainers?.[phase.index]?.red ? "Why? ▶" : phase.index + 1 < puzzle.rounds.length ? "Next ▶" : "Finish ▶"}
                  </button>
                </div>
              )}
            </div>
          )}

          {phase.kind === "explain" && puzzle.explainers?.[phase.index] && (
            <div className="panel panel-info">
              <div className="explain">
                {result && <CaseRecap puzzle={puzzle} round={puzzle.rounds[phase.index]} row={result.row} />}
                {puzzle.explainers[phase.index].red && <SayBubble kind="del" label="RED · why I did that" text={puzzle.explainers[phase.index].red} />}
                {puzzle.explainers[phase.index].green && <SayBubble kind="add" label="GREEN · why I do this" text={puzzle.explainers[phase.index].green} />}
                {puzzle.explainers[phase.index].why && (
                  <p className="explain-why">
                    <span className="tag">SO</span> {puzzle.explainers[phase.index].why}
                  </p>
                )}
              </div>
              <button className="px-btn px-btn-go panel-sticky" onClick={() => startRound(phase.index + 1)}>
                {phase.index + 1 < puzzle.rounds.length ? "Next puzzle ▶" : "See results ▶"}
              </button>
            </div>
          )}

          {phase.kind === "end" && (
            <div className="panel panel-info end">
              <p className="score">
                <strong>{score}</strong> / {results.length}
              </p>
              {flagged.length > 0 && (
                <div className="flags">
                  <p className="flags-title">Where players doubt Green</p>
                  <ul>
                    {flagged.map(({ row, key, votes }) => (
                      <li key={key}>
                        {row ? <CaseChips puzzle={puzzle} row={row} /> : <span>{caseLabel(puzzle, key)}</span>}
                        <small>
                          {row ? `→ ${outcome(puzzle, row.new)?.label} · ` : ""}
                          {Math.round((votes!.off / (votes!.right + votes!.off)) * 100)}% say off
                        </small>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {puzzle.code && <CodeCard code={puzzle.code} />}
              <a className="pr-card" href={puzzle.pr.url} target="_blank" rel="noreferrer">
                <span className="pr-repo">{puzzle.pr.repository} #{puzzle.pr.number}</span>
                <strong>{puzzle.pr.title}</strong>
                <small>See the whole change on GitHub ↗</small>
              </a>
              <div className="end-actions">
                <button className="px-btn" onClick={() => { phaseIsEnd.current = false; setResults([]); startRound(0); }}>Again</button>
                <Link className="px-btn px-btn-go" href="/">More ▶</Link>
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}
