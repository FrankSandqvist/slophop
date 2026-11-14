import "server-only";
import { randomBytes } from "node:crypto";
import { MODELS, decide, generateJson, generateMusic, generateVideo, type DecisionQuestion } from "./gemini";
import { addContext, findCandidatePullRequests, getPullRequest, prKey, type PullRequestSource } from "./github";
import {
  buildNumericRounds,
  buildVisualRounds,
  numericPrompt,
  numericSchema,
  validateNumeric,
  validateVisual,
  visualPrompt,
  visualSchema,
  type CommonDesign,
  type NumericDesign,
  type VisualDesign,
} from "./families";
import { explainRounds } from "./explain";
import { buildFlowRounds, flowPrompt, flowSchema, validateFlow, type FlowDesign } from "./flows";
import { aiPrompt, aiSchema, buildAiRounds, validateAi, type AiDesign } from "./ai";
import { clearJob, saveJob } from "./jobs";
import { researchWorld } from "./world";
import { settleLimited } from "./limit";
import { mascotReferences } from "./sprites";
import { listFiles, readText, saveFile } from "./storage";
import { rowKey, type AiModel, type FlowModel, type FmvLine, type NumericModel, type PropSpec, type PuzzleFamily, type VisualModel, type Puzzle, type PuzzleInput, type PuzzleOutcome, type PuzzleRow, type Round, type StageCard, type VoteTally } from "./types";

export type { Puzzle } from "./types";

/** Bump when the puzzle shape changes; older puzzles are hidden. */
const FORMAT = 6;
const MAX_ROWS = 48;
export const BPM = 96;
/** How many AI-made PRs to fetch and rank per new puzzle. */
const CANDIDATES = 50;

export type ProgressEvent =
  | {
      type: "stage";
      stage: "fetch" | "rank" | "pick" | "model" | "music" | "fmv" | "world" | "save";
      status: "active" | "done" | "skipped";
      detail?: string;
      /** rank/done: the top-ranked candidate PRs, best first. */
      cards?: StageCard[];
      /** pick/done: index of the chosen PR, and the piece of logic. */
      pick?: number;
      component?: string;
      /** pick/done: the kind of puzzle being made. */
      family?: PuzzleFamily;
      /** music/active: the generated stage props. */
      props?: PropSpec[];
    }
  | { type: "done"; puzzle: Puzzle }
  | { type: "error"; message: string };

const ID_PATTERN = /^[a-z0-9]{6,12}-[a-f0-9]{6}$/;
export const isPuzzleId = (id: string) => ID_PATTERN.test(id);

/* ---------- Step 1: rank the candidates with the Gemini Decisions API ---------- */

/** Calibrated questions asked about every candidate PR (one fast Decisions call each, in parallel). */
const RANK_QUESTIONS: Record<string, DecisionQuestion> = {
  worth: {
    type: "score",
    instructions:
      "This is a GitHub pull request. How much does it change something a curious non-coder could reason about: a decision (what happens when), a number (a price, fee, limit, rounding, size, timing) or a look (layout, sizes, colours, what shows or hides)?",
    criteria: ["Nothing: docs, renames, config, dependency bumps or tests", "A little", "A clear change", "A crisp change with interesting edge cases"],
  },
  kind: {
    type: "choice",
    instructions: "Which kind of brain teaser would this change make best?",
    criteria: {
      logic: "Logic: conditions or limits decide what happens (accept or reject, allow or block, show or hide, which path is taken)",
      numeric: "Numbers: a calculated amount changes (a price, fee, total, discount, rounding, duration, score or size worked out from other numbers)",
      visual: "UX: what a person sees or experiences changes: a screen's layout, messages or what shows and hides, terminal output, or a device's buttons, lights and little displays",
      flow: "Flow: how things move through a multi-step process changes (order or payment statuses, refunds, subscriptions, approvals, workflows)",
      ai: "AI: how an AI feature is guarded or checked changes (prompt-injection defences, safety filters, tool permissions for agents, checks on model output, redaction)",
      none: "None of these: refactors, docs, tooling, tests or dependencies",
    },
  },
  small: {
    type: "score",
    instructions: "Can ONE small, self-contained decision from this change be understood and explained without knowing the rest of the codebase?",
    criteria: ["No, it is tangled across many parts", "Only with a lot of background", "Mostly", "Yes, one tidy decision"],
  },
  relatable: {
    type: "score",
    instructions: "Would the people who use this software notice or care about the behaviour this change affects?",
    criteria: ["Invisible to users", "Only maintainers would notice", "Some users would notice", "Many users would notice"],
  },
  plain: { type: "noul", instructions: "Could the changed behaviour be explained in everyday language, with no programming jargon, in two sentences?" },
  noise: { type: "noul", instructions: "Is this change mostly noise: only tests, formatting, generated files, version bumps or comments?" },
  process: {
    type: "noul",
    instructions: "Does this change how people, orders, payments, tickets or accounts move through a multi-step process (statuses, lifecycles, workflows, approvals, refunds, subscriptions)?",
  },
  // Crypto projects are star-rich and AI-heavy, so they crowd the picks; a small hit keeps the mix varied.
  crypto: {
    type: "noul",
    instructions: "Is this project about cryptocurrency or blockchain: coins, tokens, crypto wallets, exchanges, NFTs, DeFi, chains or crypto trading?",
  },
};

type Fit = Record<PuzzleFamily, number>;

/** 0..1: how good a SlopHop puzzle this PR would make, and how well it fits each kind of puzzle. */
async function rankScore(pr: PullRequestSource, signal?: AbortSignal) {
  const input = `${pr.repository}#${pr.number}: ${pr.title}\n\n${pr.body.slice(0, 800)}\n\nDIFF:\n${pr.diff.slice(0, 6000)}`;
  const answers = await decide(input, RANK_QUESTIONS, signal);
  const level = (key: string) => {
    const answer = answers[key];
    return answer?.type === "score" ? answer.score / 3 : 0;
  };
  const yes = (key: string) => {
    const answer = answers[key];
    return answer?.type === "noul" ? answer.noul : 0;
  };
  const kind = answers.kind;
  const probabilities = kind?.type === "choice" ? kind.probabilities : {};
  const fit: Fit = { logic: probabilities.logic ?? 0, numeric: probabilities.numeric ?? 0, visual: probabilities.visual ?? 0, flow: probabilities.flow ?? 0, ai: probabilities.ai ?? 0 };
  const base = Math.max(0, 0.35 * level("worth") + 0.25 * level("small") + 0.25 * level("relatable") + 0.15 * yes("plain") - 0.4 * yes("noise"));
  // Small hit for crypto (at most -15%): it can still win when it's clearly the best puzzle.
  const score = base * (1 - 0.15 * yes("crypto"));
  // Flows are about bigger business changes, so their score doesn't count size against them; "is it a process" counts instead.
  const flowBase = Math.max(0, 0.35 * level("worth") + 0.25 * level("relatable") + 0.15 * yes("plain") + 0.25 * yes("process") - 0.4 * yes("noise"));
  return { score, fit, flowScore: flowBase * (1 - 0.15 * yes("crypto")) };
}

/** 0..1 for how widely known a repo is: log scale, 10k+ stars = 1. */
const prevalence = (stars: number | null | undefined) => Math.min(1, Math.log10((stars ?? 0) + 1) / 4);
const KNOWN_STARS = Number(process.env.MIN_STARS || 50);

/** How often each kind of puzzle is aimed for, so the puzzle list gets variety. */
const FAMILY_WEIGHTS: Fit = { logic: 0.25, numeric: 0.2, visual: 0.2, flow: 0.17, ai: 0.18 };

/**
 * Aims for a random kind of puzzle and takes the best PR that fits it (a clear fit, and not much worse than the best PR).
 * Falls back to the best PR overall, as whatever kind it fits best.
 */
/**
 * A second kind when the chosen PR clearly fits two (e.g. a calculation that changes what's visible): the puzzle becomes
 * mixed. Both fits must be solid; logic only pairs when its fit is strong too.
 */
function secondFamily(fit: Fit | null, primary: PuzzleFamily): PuzzleFamily | undefined {
  if (!fit || fit[primary] < 0.3) return undefined;
  const other = (Object.keys(fit) as PuzzleFamily[]).filter((family) => family !== primary).sort((a, b) => fit[b] - fit[a])[0];
  return other && fit[other] >= 0.3 ? other : undefined;
}

/**
 * The odds of aiming for each kind, leaning toward kinds that have been rare in recent puzzles (mixed ones count for
 * both): base weight × sqrt(intended share / recent share), so the lean is gentle. E.g. 6 logic, 5 maths, 1 layout
 * moves 40/30/30 to roughly 30/21/49.
 */
function familyWeights(recent: PuzzleFamily[]): Fit {
  if (!recent.length) return FAMILY_WEIGHTS;
  const families = Object.keys(FAMILY_WEIGHTS) as PuzzleFamily[];
  const raw = Object.fromEntries(
    families.map((family) => {
      const share = recent.filter((kind) => kind === family).length / recent.length;
      return [family, FAMILY_WEIGHTS[family] * Math.sqrt(FAMILY_WEIGHTS[family] / Math.max(share, 0.05))];
    }),
  ) as Fit;
  const total = families.reduce((sum, family) => sum + raw[family], 0);
  return Object.fromEntries(families.map((family) => [family, raw[family] / total])) as Fit;
}

function chooseCandidate(
  ranked: Array<{ score: number | null; flowScore?: number | null; fit: Fit | null; pr: { stars: number | null } }>,
  recent: PuzzleFamily[] = [],
  asked?: PuzzleFamily,
): { index: number; family: PuzzleFamily; second?: PuzzleFamily } {
  const best = ranked[0]?.score;
  if (best === null || best === undefined) return { index: 0, family: "logic" };
  let roll = Math.random();
  // PUZZLE_FAMILY=numeric|visual|logic forces the aim (testing); otherwise it's drawn by FAMILY_WEIGHTS.
  // The player's choice wins, then PUZZLE_FAMILY (testing).
  const forced = asked ?? (process.env.PUZZLE_FAMILY as PuzzleFamily | undefined);
  const weights = familyWeights(recent);
  const target = forced && forced in FAMILY_WEIGHTS ? forced : ((Object.keys(weights) as PuzzleFamily[]).find((family) => (roll -= weights[family]) < 0) ?? "logic");
  // The best fit for the kind; a well-known repo (players may know it) wins only if it's nearly as good (within 15%).
  // Flows use their own score (size doesn't count against them).
  const scoreFor = (entry: (typeof ranked)[number]) => (target === "flow" ? (entry.flowScore ?? entry.score) : entry.score);
  const bestFor = Math.max(0, ...ranked.map((entry) => scoreFor(entry) ?? 0));
  const value = (entry: (typeof ranked)[number]) => {
    const fit = entry.fit?.[target] ?? 0;
    const score = scoreFor(entry);
    return score === null || score === undefined || fit < 0.45 || score < bestFor * 0.6 ? 0 : score * fit;
  };
  const top = Math.max(0, ...ranked.map(value));
  // Asked for a kind but nothing clearly fits: take the PR that fits it best anyway (any real fit) rather than switch kinds.
  if (top <= 0 && forced && forced in FAMILY_WEIGHTS) {
    let index = -1;
    let bestValue = 0;
    ranked.forEach((entry, i) => {
      const score = scoreFor(entry) ?? 0;
      const fit = entry.fit?.[target] ?? 0;
      if (fit > 0.1 && score * fit > bestValue) {
        bestValue = score * fit;
        index = i;
      }
    });
    if (index >= 0) return { index, family: target, second: secondFamily(ranked[index].fit, target) };
  }
  if (top > 0) {
    const known = ranked.findIndex((entry) => (entry.pr.stars ?? 0) >= KNOWN_STARS && value(entry) >= top * 0.85);
    const index = known >= 0 ? known : ranked.findIndex((entry) => value(entry) === top);
    return { index, family: target, second: secondFamily(ranked[index]?.fit ?? null, target) };
  }
  const fit = ranked[0].fit;
  const family = fit ? (Object.keys(fit) as PuzzleFamily[]).sort((a, b) => fit[b] - fit[a])[0] : "logic";
  const primary = fit && fit[family] > 0.3 ? family : "logic";
  return { index: 0, family: primary, second: secondFamily(fit, primary) };
}

/** Scores every candidate in parallel and returns them best first (falls back to the GitHub heuristic order). */
async function rankCandidates(candidates: PullRequestSource[], signal?: AbortSignal) {
  // At most 10 Decisions calls at once, so 50 candidates don't trip Gemini's request rate limit. A single pasted PR is
  // still scored: that tells us which kind of puzzle it makes.
  const scores = await settleLimited(candidates, 10, (pr) => rankScore(pr, signal));
  const ranked = candidates.map((pr, index) => {
    const result = scores[index];
    // Popularity only nudges the score (a 10k-star repo gets +10%): interesting first, well-known second.
    return {
      pr,
      score: result.status === "fulfilled" ? result.value.score * (0.9 + 0.1 * prevalence(pr.stars)) : (null as number | null),
      flowScore: result.status === "fulfilled" ? result.value.flowScore * (0.9 + 0.1 * prevalence(pr.stars)) : (null as number | null),
      fit: result.status === "fulfilled" ? result.value.fit : (null as Fit | null),
      order: index,
    };
  });
  if (ranked.every((entry) => entry.score === null)) {
    console.error("Gemini Decisions ranking failed; using the heuristic order", scores.find((result) => result.status === "rejected"));
    return ranked;
  }
  return ranked.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.order - b.order);
}

/* ---------- Flair: Gemini designs the stage props and the music's project-specific part ---------- */

const num3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const flairSchema = {
  type: "object",
  properties: {
    music: {
      type: "string",
      description:
        "One or two sentences that make the SlopHop beat about THIS project: a lead instrument and themed sound effects that evoke its world (e.g. for a phone app: a ringing-bell synth lead over dial-tone blips). Max 40 words. Instrumental only.",
    },
    bpm: {
      type: "integer",
      description:
        "The beat's tempo in BPM, 76-132, chosen to fit this project's world while staying a bouncy hip hop groove: laid-back for calm or careful things (e.g. notes, docs, finance ~80-90), mid for everyday apps (~96-105), driving for fast, realtime or playful things (e.g. games, networking, media ~110-128).",
    },
    fmv: {
      type: "array",
      minItems: 3,
      maxItems: 4,
      description:
        "A 15-second cutscene that shortly explains what this pull request changes, in 3-4 beats. Green does the NEW behaviour, Red the OLD one.",
      items: {
        type: "object",
        properties: {
          at: { type: "number", description: "Second the beat starts: the first at 0, then about every 3.5-5 seconds, the last by 11." },
          who: { type: "string", enum: ["narrator", "add", "del"], description: "Who says the line: narrator, add (Green) or del (Red)." },
          line: {
            type: "string",
            description: "One short spoken line in plain words a non-coder gets (no code terms), max 90 characters. Together the lines say what changed and why it matters.",
          },
          scene: {
            type: "string",
            description:
              "What we SEE during this beat, max 35 words: Green and Red acting the change out in the project's world as a visual metaphor. Concrete action and camera. They are heads on one stick leg with NO arms or hands: they act by hopping, bouncing, head-butting and nudging things with their heads, never grabbing, holding or pointing. No text, signs, labels or screens with words.",
          },
        },
        required: ["at", "who", "line", "scene"],
      },
    },
    props: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      description: "Two small, instantly recognisable objects from this project's world, to stand next to the mascots on a PS1-style stage.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Max 4 words." },
          parts: {
            type: "array",
            minItems: 2,
            maxItems: 12,
            description: "Low-poly primitives. Units: the whole prop fits in a 1x1x1 box, base on y=0, centred on x=0,z=0; front faces +z.",
            items: {
              type: "object",
              properties: {
                shape: { type: "string", enum: ["box", "cylinder", "sphere", "cone", "torus"] },
                color: { type: "string", description: "Bright, saturated hex colour like #ffd447." },
                position: { ...num3, description: "Centre of the part [x, y, z]." },
                size: { ...num3, description: "box: [width, height, depth]; cylinder/cone: [radius, height, 0]; sphere: [radius, 0, 0]; torus: [radius, tube, 0]." },
                rotation: { ...num3, description: "Radians [x, y, z]." },
              },
              required: ["shape", "color", "position", "size", "rotation"],
            },
          },
        },
        required: ["name", "parts"],
      },
    },
  },
  required: ["music", "bpm", "fmv", "props"],
};

type FmvBeat = { at: number; who: FmvLine["who"]; line: string; scene: string };
type Flair = { music: string; bpm: number; props: PropSpec[]; fmv: FmvBeat[] };

const FMV_SECONDS = 15;

/** Beats in order, starting at 0, at least 2.5s apart, the last starting by 12s. */
function cleanFmv(beats: FmvBeat[] | undefined): FmvBeat[] {
  const who = ["narrator", "add", "del"];
  const clean: FmvBeat[] = [];
  for (const beat of [...(beats ?? [])].sort((a, b) => Number(a?.at) - Number(b?.at)).slice(0, 4)) {
    const line = String(beat?.line ?? "").trim().slice(0, 110);
    const scene = String(beat?.scene ?? "").trim().slice(0, 300);
    if (!line || !scene) continue;
    const at = clean.length ? Math.max(clean[clean.length - 1].at + 2.5, clamp(beat.at, 0, 12, 0)) : 0;
    if (at > 12) break;
    clean.push({ at: Math.round(at * 10) / 10, who: who.includes(beat.who) ? beat.who : "narrator", line, scene });
  }
  return clean;
}

/**
 * The cutscene prompt: the mascots as in the reference images, the fixed PS1 FMV look, and the beats with timecodes so
 * the picture matches the dialogue shown in the text box.
 */
function fmvPrompt(pr: PullRequestSource, beats: FmvBeat[]) {
  const timeline = beats.map((beat, index) => `[${beat.at}-${beats[index + 1]?.at ?? FMV_SECONDS}s] ${beat.scene}`).join(" ");
  return [
    "A 15-second cutscene, like the pre-rendered FMV intro of a 1998 PlayStation game.",
    "Characters, exactly as in the reference images: GREEN is a round light-green pixel-art head with a dark green outline,",
    "two black dot eyes and a wide grin, on one long thin wobbly black leg. RED is the same character in light red with a dark",
    "red outline. Their whole body is just that: a head on ONE thin black stick leg. They have NO arms, NO hands, NO torso,",
    "NO second leg and NO feet or shoes, at every moment of the clip; never add limbs or clothes. They move only by hopping,",
    "bouncing and bending on their single leg, tilting and spinning their heads, and pushing or nudging things with their heads.",
    "They stay flat, chunky pixel sprites moving through a 3D world, like paper cut-outs.",
    `Setting: the world of the software project "${pr.repository.split("/")[1] ?? pr.repository}".`,
    "Look: low-poly 3D sets, chunky low-resolution textures, warm saturated colours, slight dithering, soft Gouraud lighting,",
    "smooth simple camera moves, one continuous scene with no cuts.",
    `Timeline: ${timeline}`,
    "No text anywhere: no letters, words, numbers, captions, subtitles, signs, labels, logos or interface. No dialogue or voices,",
    "only light playful ambient sound.",
  ].join(" ");
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const vec = (value: unknown, min: number, max: number, fallback: number): [number, number, number] => {
  const list = Array.isArray(value) ? value : [];
  return [clamp(list[0], min, max, fallback), clamp(list[1], min, max, fallback), clamp(list[2], min, max, fallback)];
};

/** Keeps generated props small, valid and on-style. */
function cleanProps(props: PropSpec[] | undefined): PropSpec[] {
  const shapes = ["box", "cylinder", "sphere", "cone", "torus"];
  return (props ?? []).slice(0, 2).map((prop) => ({
    name: String(prop?.name ?? "").slice(0, 40),
    parts: (prop?.parts ?? [])
      .slice(0, 12)
      .filter((part) => shapes.includes(part?.shape))
      .map((part) => ({
        shape: part.shape,
        color: /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : "#ffd447",
        position: vec(part.position, -0.8, 1.4, 0),
        size: vec(part.size, 0.02, 1.2, 0.2),
        rotation: vec(part.rotation, -Math.PI * 2, Math.PI * 2, 0),
      })),
  }));
}

/** One quick call: the project's props and the project-specific line of the music prompt. */
async function designFlair(pr: PullRequestSource, signal?: AbortSignal): Promise<Flair> {
  const { data } = await generateJson<Flair>({
    model: MODELS.backup,
    prompt: `SlopHop turns real pull requests into tiny brain teasers. Its stage is a 90s PlayStation-style low-poly set where two mascots
(Green, the added code, and Red, the removed code) dance to a funky lo-fi hip hop rhythm-game beat.

For the project below:
1. Write the music line: what makes the beat about THIS project (a lead instrument and themed sound effects that evoke its world),
   and pick the tempo that suits it.
2. Write the 15-second cutscene that shortly explains what this pull request changes (read the diff), as 3-4 beats: the line
   someone says and what we see, with Green and Red acting it out in the project's world.
3. Design two small props from this project's world to stand next to the mascots, built from a few chunky low-poly primitives,
   bold and readable at tiny resolution (think PS1 / Nintendo DS). Keep each prop simple: 3-10 parts, bright colours,
   but no green or red: those colours only ever mean the two mascots.

PROJECT: ${pr.repository}
PULL REQUEST: ${pr.title}
${pr.body.slice(0, 700)}

DIFF (excerpt):
${pr.diff.slice(0, 4000)}`,
    schema: flairSchema,
    thinking: "low",
    signal,
  });
  return { music: String(data.music ?? "").slice(0, 300), fmv: cleanFmv(data.fmv), bpm: Math.round(clamp(data.bpm, 76, 132, BPM)), props: cleanProps(data.props) };
}

/** Project line first (LLM-written), then the fixed SlopHop groove so every beat keeps the same vibe. */
async function composeMusic(pr: PullRequestSource, style: string, bpm: number, signal?: AbortSignal) {
  const project = pr.repository.split("/")[1]?.replace(/[-_]+/g, " ") ?? "";
  return generateMusic({
    prompt: [
      `Instrumental only, no vocals. A theme tune for "${project}". ${style}`,
      "Make that lead and those sounds front and centre for the whole loop.",
      `Groove: a 90s PlayStation rhythm-game beat, funky, bouncy lo-fi hip hop with plucky bass and crisp drums.`,
      `Tempo: exactly ${bpm} BPM, steady from the first beat to the last.`,
      "Made to loop seamlessly: start right on the groove at full energy from the very first beat (no intro, no build-up, no count-in),",
      "keep the same groove and energy to the very last beat (no fade-out, no ending, no final hit), so the end flows straight back into the start.",
    ].join(" "),
    signal,
  });
}

/* ---------- Step 2: model that piece as a truth table (code execution) ---------- */

const str = (description: string) => ({ type: "string", description });
const slug = "Short lowercase slug, letters/digits/dashes.";

const schema = {
  type: "object",
  properties: {
    title: str("Puzzle title, 2-5 words, witty."),
    project: str("What the project is and who it affects, plain words, max 20 words."),
    change: str("What this PR changes, plain words, max 25 words."),
    where: str("Where this code lives, as a player would see it: which app/tool and which screen, button or moment. Plain words, max 22 words."),
    scenario: str("Set the scene in second person: who you are, what you're doing, and the moment this decision happens. Plain, vivid, max 40 words."),
    rules: {
      type: "object",
      description: "Plain-language rulebooks a player can apply to work out EVERY row of your table. Must match the table exactly.",
      properties: {
        old: { type: "array", minItems: 1, maxItems: 4, items: str("One of Red's rules (BEFORE the change), max 16 words, plain, 'If..., then...' style."), description: "Red's rulebook." },
        new: { type: "array", minItems: 1, maxItems: 4, items: str("One of Green's rules (AFTER the change), max 16 words, plain, 'If..., then...' style."), description: "Green's rulebook." },
      },
      required: ["old", "new"],
    },
    component: {
      type: "object",
      properties: {
        name: str("The small piece of logic, in plain words, max 5 words."),
        what: str("What it decides, plain words, max 20 words."),
        file: str("File path from the diff."),
      },
      required: ["name", "what", "file"],
    },
    lines: {
      type: "object",
      properties: {
        add: str("Green (the added code) introduces itself in first person: what it does now. Rhythmic, witty, max 14 words."),
        del: str("Red (the removed code) in first person: what it used to do. Rhythmic, witty, max 14 words."),
      },
      required: ["add", "del"],
    },
    inputs: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          id: str(slug),
          label: str("Plain name, max 4 words."),
          explain: str("What this condition means in the scene, plain words, max 16 words."),
          kind: {
            type: "string",
            enum: ["toggle", "scale", "choice"],
            description: "toggle = exactly 2 values (on/off, yes/no). scale = ordered values listed low to high (sizes, counts, times, limits). choice = unordered categories.",
          },
          values: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: str(slug),
                label: str("Plain value, max 4 words."),
                story: str("This value as a short phrase in the scene, second person, max 8 words, e.g. 'your mouse drifted off the card'."),
              },
              required: ["id", "label", "story"],
            },
          },
        },
        required: ["id", "label", "explain", "kind", "values"],
      },
    },
    outcomes: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          id: str(slug),
          label: str("What happens, plain words, max 6 words."),
          tone: { type: "string", enum: ["good", "bad", "neutral"], description: "How a user would feel about it." },
        },
        required: ["id", "label", "tone"],
      },
    },
    table: {
      type: "array",
      description: "EVERY combination of input values (cartesian product), with the outcome before and after the change, computed by running your Python model.",
      items: {
        type: "object",
        properties: {
          values: { type: "array", items: str("A value id, one per input, in input order.") },
          old: str("Outcome id before the change (Red)."),
          new: str("Outcome id after the change (Green)."),
        },
        required: ["values", "old", "new"],
      },
    },
    codeAnchor: str("A distinctive piece of ONE added or removed line of the chosen component in the DIFF, copied exactly (10-60 chars)."),
  },
  required: ["title", "project", "change", "where", "scenario", "rules", "component", "lines", "inputs", "outcomes", "table", "codeAnchor"],
};

type Design = {
  title: string;
  project: string;
  change: string;
  where: string;
  scenario: string;
  rules: { old: string[]; new: string[] };
  component: { name: string; what: string; file: string };
  lines: { add: string; del: string };
  inputs: PuzzleInput[];
  outcomes: PuzzleOutcome[];
  table: Array<{ values: string[]; old: string; new: string }>;
  codeAnchor: string;
};

const FOCUS = "Choose it yourself: the SMALLEST meaningful piece of logic this PR changes (one decision, one function, one condition).";

function modelPrompt(pr: PullRequestSource, focus: string) {
  return `You design SlopHop puzzles. SlopHop shows curious people what is changing in the public software around them, as a tiny brain teaser.
Two characters star in every puzzle: GREEN is the code this pull request ADDED, RED is the code it REMOVED.

THE PIECE OF LOGIC TO MODEL: ${focus}

YOUR JOB
1. Model that one decision as 1-3 inputs with 2-4 plain values each (include the edge values: empty, zero, too many, odd formats...)
   and 2-5 plain outcomes. Keep the full table at ${MAX_ROWS} rows or fewer.
2. Use code execution: write two small Python functions, old(...) and new(...), that faithfully mirror the code BEFORE and AFTER this PR
   for your abstract inputs (bugs and quirks included; do not fix anything). If the logic didn't exist before, old() returns the closest
   outcome to "nothing happens". Run them over every combination and fill "table" from the printed results.
   Be quick: write the code once, run it once, then answer. Only re-run if it errors.
   Pick each input's kind so it gets the right control: a yes/no condition is a "toggle", a limit/size/count/time is a "scale"
   (values in order, include the boundary on both sides), anything else is a "choice".
3. Write the two rulebooks: Red's rules (before) and Green's rules (after), short plain "If..., then..." lines that let a player
   work out EVERY row of your table by reasoning. Check them against the table; puzzles are only fair if the rules are complete.
4. Set the scene so a curious non-coder knows exactly where they are: "where" (which app, which screen or moment) and "scenario"
   (second person: you're doing X when Y happens). Explain every input, and give every value a short story phrase in that scene.
5. Write everything players see in plain language: no code, identifiers, symbols or jargon. Clear and witty for grown-ups; never childish.

The game is generated from your table by our own code. Make the table right.

=== PULL REQUEST: ${pr.repository}#${pr.number}: ${pr.title}
DESCRIPTION:
${pr.body.slice(0, 1500) || "(none)"}
DIFF:
${pr.diff}
CODE AROUND THE CHANGES:
${pr.context || "(unavailable)"}`;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

function cleanId(value: string, fallback: string) {
  const id = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return SLUG.test(id) ? id : fallback;
}

/** Cut the component's lines out of the real diff, so players see real code, never invented code. */
function resolveCode(anchor: string, diff: string): Puzzle["code"] {
  const norm = (text: string) => text.replace(/\s+/g, " ").trim();
  const wanted = norm(anchor ?? "");
  if (wanted.length < 4) return null;
  const blocks = diff
    .split(/^--- (?=\S[^\n]* \((?:added|removed|modified|renamed|changed|copied|unchanged)[,)])/m)
    .filter(Boolean)
    .map((block) => {
      const [header, ...lines] = block.split("\n");
      return { file: header.replace(/ \([^)]*\)\s*$/, "").trim(), lines };
    });
  for (const block of blocks) {
    const at = block.lines.findIndex((line) => /^[+-]/.test(line) && norm(line.slice(1)).includes(wanted));
    if (at < 0) continue;
    let start = at;
    let end = at;
    while (start > 0 && at - start < 5 && !block.lines[start - 1].startsWith("@@")) start--;
    while (end < block.lines.length - 1 && end - at < 7 && block.lines[end + 1] !== "" && !block.lines[end + 1].startsWith("@@")) end++;
    return { file: block.file, lines: block.lines.slice(start, end + 1).map((line) => line.slice(0, 120)) };
  }
  return null;
}

function shuffle<T>(items: T[]) {
  return [...items].sort(() => Math.random() - 0.5);
}

/** A claim Red can make about Green: "when <input> is <value>, Green always <outcome>". True or false, from the table. */
function makeClaim(table: PuzzleRow[], inputs: PuzzleInput[]): Extract<Round, { kind: "claim" }> | null {
  const options: Array<Extract<Round, { kind: "claim" }>> = [];
  inputs.forEach((input, index) => {
    for (const value of input.values) {
      const rows = table.filter((row) => row.values[index] === value.id);
      if (rows.length < 2) continue;
      const outcomes = [...new Set(rows.map((row) => row.new))];
      if (outcomes.length === 1) options.push({ kind: "claim", input: index, value: value.id, outcome: outcomes[0], truth: true, counter: null });
      else {
        const common = outcomes.sort((a, b) => rows.filter((row) => row.new === b).length - rows.filter((row) => row.new === a).length)[0];
        const counter = rows.find((row) => row.new !== common)!;
        options.push({ kind: "claim", input: index, value: value.id, outcome: common, truth: false, counter: counter.key });
      }
    }
  });
  if (!options.length) return null;
  const wantTrue = Math.random() < 0.5;
  const preferred = options.filter((option) => option.truth === wantTrue);
  return shuffle(preferred.length ? preferred : options)[0];
}

/** Rows that differ from `row` in exactly one input (optionally: in that particular input). */
function neighbours(table: PuzzleRow[], row: PuzzleRow, input?: number) {
  return table.filter(
    (other) =>
      other.key !== row.key &&
      other.values.filter((value, index) => value !== row.values[index]).length === 1 &&
      (input === undefined || other.values[input] !== row.values[input]),
  );
}

/** A case where exactly one condition decides Green's outcome (changing it changes the outcome; changing the others doesn't). */
function makePivot(table: PuzzleRow[], inputs: PuzzleInput[]): Extract<Round, { kind: "pivot" }> | null {
  if (inputs.length < 2) return null;
  for (const row of shuffle(table)) {
    const complete = inputs.every((_, index) => neighbours(table, row, index).length > 0);
    const decisive = inputs.map((_, index) => neighbours(table, row, index).some((other) => other.new !== row.new));
    if (complete && decisive.filter(Boolean).length === 1) return { kind: "pivot", row: row.key, input: decisive.indexOf(true) };
  }
  return null;
}

/** Three cases with the same Green outcome and one with a different one. */
function makeOdd(table: PuzzleRow[]): Extract<Round, { kind: "odd" }> | null {
  const groups = new Map<string, PuzzleRow[]>();
  for (const row of table) groups.set(row.new, [...(groups.get(row.new) ?? []), row]);
  const big = shuffle([...groups.values()].filter((rows) => rows.length >= 3))[0];
  const others = table.filter((row) => big && row.new !== big[0].new);
  if (!big || !others.length) return null;
  const odd = shuffle(others)[0];
  return { kind: "odd", rows: shuffle([...shuffle(big).slice(0, 3), odd]).map((row) => row.key), odd: odd.key };
}

/** "When <input> is ___, Green always ends at <outcome>": only rules that really hold, with at least one wrong option. */
function makeRule(table: PuzzleRow[], inputs: PuzzleInput[]): Extract<Round, { kind: "rule" }> | null {
  const options: Array<Extract<Round, { kind: "rule" }>> = [];
  inputs.forEach((input, index) => {
    for (const outcomeId of new Set(table.map((row) => row.new))) {
      const answers = input.values
        .map((value) => value.id)
        .filter((value) => {
          const rows = table.filter((row) => row.values[index] === value);
          return rows.length >= 2 && rows.every((row) => row.new === outcomeId);
        });
      if (answers.length && answers.length < input.values.length) options.push({ kind: "rule", input: index, outcome: outcomeId, answers });
    }
  });
  return shuffle(options)[0] ?? null;
}

/**
 * One tweak: from a base case, up to three "what if…" single changes; exactly one makes Red and Green disagree
 * (goal "disagree") or makes Green reach `target` (goal "outcome").
 */
function makeTweak(table: PuzzleRow[], goal: "disagree" | "outcome", target?: string): Extract<Round, { kind: "tweak" }> | null {
  const hits = (row: PuzzleRow) => (goal === "disagree" ? row.old !== row.new : row.new === target);
  for (const base of shuffle(table)) {
    if (hits(base)) continue;
    const options = neighbours(table, base);
    const right = shuffle(options.filter(hits));
    const wrong = shuffle(options.filter((row) => !hits(row)));
    if (right.length && wrong.length) {
      const picked = shuffle([right[0], ...wrong.slice(0, 2)]);
      return { kind: "tweak", base: base.key, goal, target, options: picked.map((row) => row.key), answer: right[0].key };
    }
  }
  return null;
}

/** Solved examples, then a mystery case. Examples are the mystery's neighbours, so the pattern is learnable. */
function makePattern(table: PuzzleRow[]): Extract<Round, { kind: "pattern" }> | null {
  for (const row of shuffle(table)) {
    const examples = shuffle(neighbours(table, row)).slice(0, 3);
    if (examples.length >= 2 && examples.some((example) => example.new !== row.new)) return { kind: "pattern", examples: examples.map((example) => example.key), row: row.key };
  }
  return null;
}

/** Along an ordered input (others fixed), Green's outcome flips exactly once: where? */
function makeEdge(table: PuzzleRow[], inputs: PuzzleInput[]): Extract<Round, { kind: "edge" }> | null {
  for (const index of shuffle(inputs.map((_, i) => i))) {
    const input = inputs[index];
    if (input.kind !== "scale" || input.values.length < 3) continue;
    const contexts = new Map<string, PuzzleRow[]>();
    for (const row of table) {
      const context = row.values.filter((_, i) => i !== index).join("~");
      contexts.set(context, [...(contexts.get(context) ?? []), row]);
    }
    for (const rows of shuffle([...contexts.values()])) {
      const ordered = input.values.map((value) => rows.find((row) => row.values[index] === value.id));
      if (ordered.some((row) => !row)) continue;
      const flips = ordered.slice(1).map((row, i) => (row!.new !== ordered[i]!.new ? i + 1 : -1)).filter((flip) => flip > 0);
      if (flips.length === 1) return { kind: "edge", input: index, rows: ordered.map((row) => row!.key), flip: flips[0] };
    }
  }
  return null;
}

/**
 * Rounds, built by our code from the table (never by the model). Each is ONE decision that fits the screen and can be
 * reasoned out from the rulebooks: open on an applied rule, find where the change bites, a shuffled mix, try to break it.
 */
/**
 * How many steps a logic puzzle deserves: about one per two cases (2-5), and at most 3 when only one case changed.
 * A simple change gets a short puzzle instead of repeating itself.
 */
export function logicBudget(table: PuzzleRow[]) {
  const changed = table.filter((row) => row.old !== row.new).length;
  const budget = Math.max(2, Math.min(5, Math.ceil(table.length / 2)));
  return changed <= 1 ? Math.min(budget, 3) : budget;
}

export function buildRounds(table: PuzzleRow[], outcomes: PuzzleOutcome[], inputs: PuzzleInput[]): Round[] {
  const limit = logicBudget(table);
  const changed = shuffle(table.filter((row) => row.old !== row.new));
  const same = shuffle(table.filter((row) => row.old === row.new));
  const opener: Round[] = [];
  const first = changed[0] ?? same[0];
  if (first) opener.push({ kind: "predict", row: first.key, side: "new" });
  const disagree = makeTweak(table, "disagree");
  if (disagree) opener.push(disagree);

  const middle: Round[] = [];
  const add = (round: Round | null) => {
    if (round) middle.push(round);
  };
  add(makePattern(table));
  add(makeEdge(table, inputs));
  add(makeOdd(table));
  add(makeRule(table, inputs) ?? makeClaim(table, inputs));
  add(makePivot(table, inputs));
  if (changed[1]) middle.push({ kind: "who", row: changed[1].key, shown: Math.random() < 0.5 ? "old" : "new" });
  if (changed[2] ?? changed[1]) middle.push({ kind: "predict", row: (changed[2] ?? changed[1]).key, side: "old" });

  const closer: Round[] = [];
  const bad = outcomes.find((entry) => entry.tone === "bad" && table.some((row) => row.new === entry.id));
  const breaker = bad ? makeTweak(table, "outcome", bad.id) : null;
  if (breaker) closer.push(breaker);

  // Opener and closer first; the shuffled middle fills what the budget allows. Short puzzles keep the opener.
  const middleRoom = Math.max(0, limit - opener.length - closer.length);
  return [...opener, ...shuffle(middle).slice(0, middleRoom), ...closer].slice(0, limit);
}

/** Validates the model's design against itself; throws when it's unusable. */
function validate(design: Design) {
  const usedInputIds = new Set<string>();
  const inputs = (design.inputs ?? []).slice(0, 3).map((input, index) => {
    const id = cleanId(input.id, `input-${index}`);
    usedInputIds.add(id);
    const values = (input.values ?? []).slice(0, 4).map((value, valueIndex) => ({
      id: cleanId(value.id, `v${valueIndex}`),
      label: String(value.label ?? "").slice(0, 40),
      story: String(value.story ?? "").slice(0, 80),
    }));
    const unique = values.filter((value, i) => values.findIndex((other) => other.id === value.id) === i);
    const kind: PuzzleInput["kind"] = input.kind === "toggle" && unique.length === 2 ? "toggle" : input.kind === "scale" ? "scale" : "choice";
    return { id, label: String(input.label ?? "").slice(0, 40), explain: String(input.explain ?? "").slice(0, 120), kind, values: unique };
  });
  if (!inputs.length || inputs.some((input) => input.values.length < 2)) throw new Error("The puzzle design had unusable inputs.");

  const outcomes = (design.outcomes ?? []).slice(0, 5).map((entry, index) => ({
    id: cleanId(entry.id, `o${index}`),
    label: String(entry.label ?? "").slice(0, 60),
    tone: (["good", "bad", "neutral"].includes(entry.tone) ? entry.tone : "neutral") as PuzzleOutcome["tone"],
  }));
  const outcomeIds = new Set(outcomes.map((entry) => entry.id));

  const valid = (values: string[]) => values.length === inputs.length && values.every((value, index) => inputs[index].values.some((candidate) => candidate.id === value));
  const table: PuzzleRow[] = [];
  for (const row of design.table ?? []) {
    const values = (row.values ?? []).map((value, index) => cleanId(value, `v${index}`));
    const old = cleanId(row.old, "");
    const next = cleanId(row.new, "");
    if (!valid(values) || !outcomeIds.has(old) || !outcomeIds.has(next)) continue;
    const key = rowKey(values);
    if (!table.some((existing) => existing.key === key)) table.push({ key, values, old, new: next });
  }
  if (table.length < 2) throw new Error("The puzzle's logic table came back empty. Try again.");

  return { inputs, outcomes: outcomes.filter((entry) => table.some((row) => row.old === entry.id || row.new === entry.id)), table: table.slice(0, MAX_ROWS) };
}

/* ---------- Pipeline ---------- */

const HEDGE_MS = Number(process.env.MODEL_HEDGE_MS || 40_000);

/**
 * Code-execution turns vary a lot in length. Start the primary model; if it hasn't answered after HEDGE_MS (or fails),
 * start a fast backup in parallel and take the first VALID answer. The loser is aborted (we stop polling it).
 */
export type Modelled =
  | { family: "logic"; inputs: PuzzleInput[]; outcomes: PuzzleOutcome[]; table: PuzzleRow[] }
  | { family: "numeric"; numeric: NumericModel }
  | { family: "visual"; visual: VisualModel }
  | { family: "flow"; flow: FlowModel }
  | { family: "ai"; ai: AiModel };

/** Per kind of puzzle: what to ask, the answer's shape, whether it runs Python, and how we check the answer. */
const DESIGNS: Record<PuzzleFamily, { prompt: (pr: PullRequestSource) => string; schema: Record<string, unknown>; python: boolean; check: (data: never) => Modelled }> = {
  logic: { prompt: (pr) => modelPrompt(pr, FOCUS), schema, python: true, check: (data: Design) => ({ family: "logic", ...validate(data) }) },
  numeric: { prompt: numericPrompt, schema: numericSchema, python: true, check: (data: NumericDesign) => ({ family: "numeric", numeric: validateNumeric(data) }) },
  visual: { prompt: visualPrompt, schema: visualSchema, python: false, check: (data: VisualDesign) => ({ family: "visual", visual: validateVisual(data) }) },
  flow: { prompt: flowPrompt, schema: flowSchema, python: false, check: (data: FlowDesign) => ({ family: "flow", flow: validateFlow(data) }) },
  ai: { prompt: aiPrompt, schema: aiSchema, python: true, check: (data: AiDesign) => ({ family: "ai", ai: validateAi(data) }) },
};

export async function modelHedged(pr: PullRequestSource, family: PuzzleFamily, signal?: AbortSignal) {
  const design = DESIGNS[family];
  const prompt = design.prompt(pr);
  const controllers: AbortController[] = [];
  const run = (model: string, thinking: string) => {
    const controller = new AbortController();
    controllers.push(controller);
    return generateJson<CommonDesign>({
      model,
      prompt,
      schema: design.schema,
      tools: design.python ? [{ type: "code_execution" }] : [],
      thinking,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    }).then(({ data, model: used }) => ({ data, model: used, result: design.check(data as never) }));
  };

  return new Promise<Awaited<ReturnType<typeof run>>>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let backupStarted = false;
    const finish = (result: Awaited<ReturnType<typeof run>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const controller of controllers) controller.abort();
      resolve(result);
    };
    const fail = (error: unknown) => {
      failures += 1;
      if (!backupStarted) startBackup();
      else if (failures >= 2 && !settled) {
        settled = true;
        reject(error);
      }
    };
    const startBackup = () => {
      if (backupStarted || settled) return;
      backupStarted = true;
      run(MODELS.backup, "low").then(finish, fail);
    };
    const timer = setTimeout(startBackup, HEDGE_MS);
    run(MODELS.design, process.env.GEMINI_DESIGN_THINKING || "medium").then(finish, fail);
  });
}

/** A small, real slice of a PR for the stage: counts and a few changed lines. */
function stageCard(pr: PullRequestSource): StageCard {
  const changed = pr.diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)( |$)/.test(line) && line.trim().length > 2);
  return {
    repository: pr.repository,
    number: pr.number,
    title: pr.title,
    additions: changed.filter((line) => line.startsWith("+")).length,
    deletions: changed.filter((line) => line.startsWith("-")).length,
    lines: changed.slice(0, 18).map((line) => line.replace(/\s+/g, " ").slice(0, 44)),
  };
}

/** Fetch-done detail when a pasted PR already has a puzzle (the client says so and opens it). */
export const ALREADY_MADE = "already made";

const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

export async function createPuzzle(options: { prUrl?: string; family?: PuzzleFamily; emit: (event: ProgressEvent) => void; signal?: AbortSignal }) {
  const id = newId();
  const startedAt = new Date().toISOString();
  await saveJob({ id, startedAt });
  try {
    return await makePuzzle(id, startedAt, options);
  } finally {
    await clearJob(id);
  }
}

async function makePuzzle(id: string, startedAt: string, options: { prUrl?: string; family?: PuzzleFamily; emit: (event: ProgressEvent) => void; signal?: AbortSignal }) {
  const { emit, signal } = options;

  emit({ type: "stage", stage: "fetch", status: "active" });
  // Existing puzzles (read while GitHub is searched): their PRs are skipped, and their repos get a small ranking hit.
  const existing = listPuzzles(200).catch(() => [] as Puzzle[]);
  const candidates = options.prUrl
    ? [await getPullRequest(options.prUrl)]
    : await findCandidatePullRequests(CANDIDATES, existing.then((puzzles) => new Set(puzzles.map((puzzle) => prKey(puzzle.pr.url)))));
  // A pasted PR (or issue) that already has a puzzle: no new one, the player is sent to the existing game.
  if (options.prUrl) {
    const made = (await existing).find((puzzle) => prKey(puzzle.pr.url) === prKey(candidates[0].url));
    if (made) {
      emit({ type: "stage", stage: "fetch", status: "done", detail: ALREADY_MADE });
      return made;
    }
  }
  emit({ type: "stage", stage: "fetch", status: "done", detail: `${candidates.length} pull request${candidates.length === 1 ? "" : "s"}` });

  // Step 1: Gemini Decisions scores every candidate; the best one wins.
  emit({ type: "stage", stage: "rank", status: "active", detail: `Scoring ${candidates.length} with Gemini Decisions` });
  const recentRepos = new Set((await existing).slice(0, 12).map((puzzle) => puzzle.pr.repository.toLowerCase()));
  // A repo that's in the recent puzzles scores 15% lower, so one busy repo doesn't keep winning with different PRs.
  const scored = (await rankCandidates(candidates, signal))
    .map((entry) => (entry.score !== null && recentRepos.has(entry.pr.repository.toLowerCase()) ? { ...entry, score: entry.score * 0.85 } : entry))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.order - b.order);
  // Aim for a kind of puzzle (variety) and put the PR chosen for it first: everything below uses ranked[0].
  // Lean toward the kinds that have been rare in the last 12 puzzles.
  const recentFamilies = (await existing).slice(0, 12).flatMap((puzzle) => puzzle.families ?? [puzzle.family ?? "logic"]);
  const chosen = chooseCandidate(scored, recentFamilies, options.family);
  const ranked = [scored[chosen.index], ...scored.filter((_, index) => index !== chosen.index)];
  void saveJob({ id, startedAt, repository: ranked[0].pr.repository, title: ranked[0].pr.title });
  const top = ranked.slice(0, 5);
  emit({
    type: "stage",
    stage: "rank",
    status: "done",
    detail: `${ranked[0].pr.repository}#${ranked[0].pr.number}${ranked[0].score !== null ? ` scored ${Math.round(ranked[0].score * 100)}%` : ""}`,
    cards: top.map(({ pr: candidate, score }) => ({ ...stageCard(candidate), ...(score !== null ? { score } : {}) })),
  });
  // Flair (generated props + the music's project line), then the beat, all in parallel with the modelling below.
  const flairTask = designFlair(ranked[0].pr, signal).catch((error: unknown) => {
    console.error("Flair design failed", error);
    return { music: "A bouncy synth lead with playful toy-like sound effects.", bpm: BPM, props: [], fmv: [] } as Flair;
  });
  const musicTask = flairTask
    .then(async (flair) => {
      emit({ type: "stage", stage: "music", status: "active", props: flair.props });
      const music = await composeMusic(ranked[0].pr, flair.music, flair.bpm, signal);
      const file = `music.${music.extension}`;
      await saveFile(`puzzles/${id}/${file}`, music.bytes, music.mimeType);
      emit({ type: "stage", stage: "music", status: "done" });
      return file;
    })
    .catch((error: unknown) => {
      console.error("Music generation failed", error);
      emit({ type: "stage", stage: "music", status: "skipped" });
      return null;
    });

  // How this reaches the world: Google Search research + company enrichment, alongside everything else. Never waited for
  // beyond a short grace at save time, so it can't slow generation down.
  const worldTask = researchWorld(ranked[0].pr, signal).then((world) => {
    if (world) emit({ type: "stage", stage: "world", status: "done", detail: world.headline || world.reach });
    return world;
  });

  // The cutscene: as soon as its script is written, Gemini Omni films it (360p) with the real mascots as references.
  const fmvTask = flairTask
    .then(async (flair): Promise<Puzzle["fmv"]> => {
      // FMV=off skips the cutscene (e.g. for test runs: it's the priciest part).
      if (flair.fmv.length < 2 || process.env.FMV === "off") return null;
      emit({ type: "stage", stage: "fmv", status: "active" });
      const video = await generateVideo({
        prompt: fmvPrompt(ranked[0].pr, flair.fmv),
        images: [...mascotReferences("add"), ...mascotReferences("del")],
        seconds: FMV_SECONDS,
        signal,
      });
      await saveFile(`puzzles/${id}/fmv.mp4`, video.bytes, video.mimeType);
      emit({ type: "stage", stage: "fmv", status: "done" });
      return { file: "fmv.mp4", lines: flair.fmv.map(({ at, who, line }) => ({ at, who, text: line })) };
    })
    .catch((error: unknown) => {
      console.error("Cutscene generation failed", error);
      emit({ type: "stage", stage: "fmv", status: "skipped" });
      return null;
    });

  const pr = await addContext(ranked[0].pr);
  const kindName = { logic: "logic", numeric: "numbers", visual: "UX", flow: "flow", ai: "AI" }[chosen.family];
  const choice = {
    reason:
      ranked[0].score !== null
        ? `Gemini Decisions picked it from ${candidates.length} as a ${kindName} puzzle (${Math.round(ranked[0].score * 100)}%).`
        : "Best by the GitHub heuristic.",
  };
  emit({ type: "stage", stage: "pick", status: "done", detail: `${pr.repository}#${pr.number} · ${pr.title}`, pick: 0, component: pr.title, family: chosen.family });

  // Step 2: model that one piece with code execution, on the chosen PR only (hedged against slow runs).
  emit({ type: "stage", stage: "model", status: "active" });
  // A numbers or looks design that doesn't hold up falls back to a logic puzzle of the same PR.
  // Mixed puzzles model their second kind at the same time (no extra wait); if it fails, the puzzle stays single-kind.
  const secondTask = chosen.second
    ? modelHedged(pr, chosen.second, signal).catch((error: unknown) => {
        console.warn(`The second (${chosen.second}) design failed; the puzzle stays single-kind`, error);
        return null;
      })
    : Promise.resolve(null);
  const modelled = await modelHedged(pr, chosen.family, signal).catch((error: unknown) => {
    if (chosen.family === "logic") throw error;
    console.warn(`The ${chosen.family} design failed; falling back to logic`, error);
    return modelHedged(pr, "logic", signal);
  });
  const { data, model, result } = modelled;
  const secondModel = await secondTask;
  const second = secondModel && secondModel.result.family !== result.family ? secondModel : null;
  const detail =
    result.family === "logic"
      ? `${result.table.length} cases · ${result.table.filter((row) => row.old !== row.new).length} changed`
      : result.family === "numeric"
        ? `${result.numeric.points.length} numbers · ${result.numeric.points.filter((point) => point.old !== point.new).length} changed`
        : result.family === "flow"
          ? `${result.flow.states.length} steps · ${result.flow.scenarios.length} stories`
          : result.family === "ai"
            ? `${result.ai.examples.length} examples · ${result.ai.examples.filter((example) => example.old !== example.new).length} changed`
            : `${result.visual.states.length} situations`;
  emit({ type: "stage", stage: "model", status: "done", detail });

  // Rounds come from our code; the case explainers (one Gemini call) run while the music and cutscene finish.
  const rules = mixedRules(data.rules, second?.data.rules);
  const family = composeFamilies(result, second?.result);
  const rounds = composeRounds(result, second?.result);
  const explainTask = explainRounds({ ...family, project: String(data.project ?? ""), change: String(data.change ?? ""), scenario: String(data.scenario ?? ""), rules, rounds }, signal).catch(
    (error: unknown) => {
      console.error("Case explainers failed", error);
      return undefined;
    },
  );
  const [musicFile, flair, fmv, explainers] = await Promise.all([musicTask, flairTask, fmvTask, explainTask]);
  const world = await Promise.race([worldTask, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
  emit({ type: "stage", stage: "save", status: "active" });
  const puzzle: Puzzle = {
    format: FORMAT,
    id,
    createdAt: new Date().toISOString(),
    pr: { url: pr.url, repository: pr.repository, number: pr.number, title: pr.title, author: pr.author, mergedAt: pr.mergedAt, madeWith: pr.madeWith, stars: pr.stars },
    candidates: candidates.map((candidate) => ({ repository: candidate.repository, number: candidate.number, title: candidate.title, url: candidate.url })),
    pickReason: String(choice.reason ?? ""),
    title: String(data.title ?? pr.title),
    project: String(data.project ?? ""),
    change: String(data.change ?? ""),
    where: String(data.where ?? ""),
    scenario: String(data.scenario ?? ""),
    rules,
    component: { name: String(data.component?.name ?? ""), what: String(data.component?.what ?? ""), file: String(data.component?.file ?? "") },
    lines: { add: String(data.lines?.add ?? ""), del: String(data.lines?.del ?? "") },
    ...family,
    rounds,
    ...(explainers ? { explainers } : {}),
    world,
    code: resolveCode(data.codeAnchor, pr.diff),
    props: flair.props,
    musicStyle: flair.music,
    bpm: flair.bpm,
    fmv,
    musicFile,
    models: { design: model, music: musicFile ? MODELS.music : null },
  };
  await saveFile(`puzzles/${id}/meta.json`, JSON.stringify(puzzle, null, 2), "application/json");
  emit({ type: "stage", stage: "save", status: "done" });
  return puzzle;
}

/* ---------- Mixed puzzles: two kinds of the same change in one puzzle ---------- */

/** The family fields of a puzzle from one or two modelled kinds (primary first). */
export function composeFamilies(primary: Modelled, extra?: Modelled | null) {
  const parts = [primary, ...(extra ? [extra] : [])];
  const logic = parts.find((part) => part.family === "logic");
  const numeric = parts.find((part) => part.family === "numeric");
  const visual = parts.find((part) => part.family === "visual");
  const flow = parts.find((part) => part.family === "flow");
  const ai = parts.find((part) => part.family === "ai");
  return {
    family: primary.family,
    ...(extra ? { families: parts.map((part) => part.family) } : {}),
    inputs: logic?.family === "logic" ? logic.inputs : [],
    outcomes: logic?.family === "logic" ? logic.outcomes : [],
    table: logic?.family === "logic" ? logic.table : [],
    ...(numeric?.family === "numeric" ? { numeric: numeric.numeric } : {}),
    ...(visual?.family === "visual" ? { visual: visual.visual } : {}),
    ...(flow?.family === "flow" ? { flow: flow.flow } : {}),
    ...(ai?.family === "ai" ? { ai: ai.ai } : {}),
  };
}

function roundsOf(part: Modelled): Round[] {
  return part.family === "logic"
    ? buildRounds(part.table, part.outcomes, part.inputs)
    : part.family === "numeric"
      ? buildNumericRounds(part.numeric)
      : part.family === "flow"
        ? buildFlowRounds(part.flow)
        : part.family === "ai"
          ? buildAiRounds(part.ai)
          : buildVisualRounds(part.visual);
}

/** Steps for one kind, or both kinds interleaved (primary first), at most 5 in all. */
export function composeRounds(primary: Modelled, extra?: Modelled | null): Round[] {
  return extra ? interleaveRounds(roundsOf(primary), roundsOf(extra)) : roundsOf(primary);
}

export function interleaveRounds(a: Round[], b: Round[], max = 5): Round[] {
  const out: Round[] = [];
  for (let i = 0; out.length < max && (i < a.length || i < b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length && out.length < max) out.push(b[i]);
  }
  return out;
}

/** One rulebook from both kinds' rules: up to 3 lines each, duplicates dropped. */
export function mixedRules(first: { old?: string[]; new?: string[] } | undefined, extra?: { old?: string[]; new?: string[] } | null) {
  const pick = (a: string[] = [], b: string[] = []) =>
    [...a.slice(0, extra ? 3 : 4), ...(extra ? b.slice(0, 3) : [])]
      .map((line) => String(line).slice(0, 140))
      .filter((line, index, all) => all.indexOf(line) === index);
  return { old: pick(first?.old, extra?.old), new: pick(first?.new, extra?.new) };
}

/* ---------- Reading ---------- */

function parse(text: string | null): Puzzle | null {
  if (!text) return null;
  const puzzle = JSON.parse(text) as Puzzle;
  return puzzle.format === FORMAT ? puzzle : null;
}

export async function getPuzzle(id: string) {
  return isPuzzleId(id) ? parse(await readText(`puzzles/${id}/meta.json`)) : null;
}

export async function listPuzzles(limit = 40): Promise<Puzzle[]> {
  const metas = (await listFiles("puzzles/"))
    .filter((file) => file.pathname.endsWith("/meta.json"))
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    .slice(0, limit * 2);
  const puzzles = await Promise.all(metas.map((file) => readText(file.pathname).then(parse).catch(() => null)));
  return puzzles.filter((puzzle): puzzle is Puzzle => puzzle !== null).slice(0, limit);
}

/* ---------- Crowd votes: does Green's behaviour seem right for this exact case? ---------- */

export async function saveVote(id: string, row: string, vote: "right" | "off") {
  await saveFile(`votes/${id}/${row}/${vote}/${Date.now()}-${randomBytes(3).toString("hex")}.json`, "{}", "application/json");
}

export async function tallyVotes(id: string): Promise<VoteTally> {
  const tally: VoteTally = {};
  for (const file of await listFiles(`votes/${id}/`)) {
    const [, , row, vote] = file.pathname.split("/");
    if (vote !== "right" && vote !== "off") continue;
    tally[row] ??= { right: 0, off: 0 };
    tally[row][vote] += 1;
  }
  return tally;
}
