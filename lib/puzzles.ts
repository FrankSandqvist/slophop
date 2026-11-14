import "server-only";
import { randomBytes } from "node:crypto";
import { offerMechanics, type Mechanic } from "./catalog";
import { MODELS, generateImage, generateJson, generateMusic, getBackground, startBackground } from "./gemini";
import { findPuzzleWorthyPullRequest, getPullRequest, type PullRequestSource } from "./github";
import { researchPullRequest, type Likelihood, type ResearchNotes } from "./research";
import { ANSWERS, parseQuestionKey, type Tally } from "./review";
import { listFiles, readFile, readText, saveFile } from "./storage";
import { STYLE } from "./style";

export type { Likelihood } from "./research";

/** Bump when the puzzle shape changes; older puzzles are hidden. */
const FORMAT = 5;
const IMAGES_ENABLED = process.env.IMAGES !== "off";
/** Thinking levels (Gemini 4: low | medium | high; Hydrogen also xhigh). */
const DESIGN_THINKING = process.env.GEMINI_DESIGN_THINKING || "medium";
const BUILD_THINKING = process.env.GEMINI_BUILD_THINKING || "high";
const BUILD_MAX_TOKENS = Number(process.env.GEMINI_BUILD_MAX_TOKENS || 65_536);
const MAX_BUILD_ATTEMPTS = 3;

export type PuzzleTheme = {
  /** 2-4 word name of the game's own art direction. */
  name: string;
  /** [background, ink, accent, ...extras] as hex colours. */
  colors: string[];
  dimension: "2d" | "3d";
};

/** One stage of the whole system the data travels through. */
export type SystemStage = { name: string; emoji: string; role: string; changed: boolean };

export type PuzzleSolved = { situation: string; before: string; after: string; aiView: "works" | "partly" | "no"; aiReason: string };
export type PuzzleTradeoff = { title: string; gain: string; cost: string; aiView: "worth" | "unsure" | "not"; aiReason: string };
export type PuzzleCase = {
  title: string;
  scenario: string;
  outcome: string;
  brokePromise: boolean;
  origin: "introduced" | "existing";
  aiLikelihood: Likelihood;
  aiReason: string;
};

/** A moment where the game reveals the real diff. Lines are cut from the actual diff on the server. */
export type CodeSpot = { id: string; caption: string; file: string; lines: string[] };
type DesignCodeSpot = { id: string; caption: string; file: string; anchor: string };

/** One level of the game. `beat` links it to the standardized judgment asked after it (intro has none). */
export type Level = {
  beat: string;
  title: string;
  goal: string;
  setup: string;
  solution: string;
  teaches: string;
  codeSpot: string;
  peekMoment: string;
};

export type GameMechanic = { name: string; core: string; twist: string };

type Design = {
  coreDecision: string;
  title: string;
  emoji: string;
  premise: string;
  projectSummary: string;
  changeSummary: string;
  promise: string;
  styleName: string;
  artDirection: string;
  colors: string[];
  dimension: "2d" | "3d";
  system: SystemStage[];
  switchLabels: { old: string; new: string };
  solved: PuzzleSolved;
  tradeoffs: PuzzleTradeoff[];
  cases: PuzzleCase[];
  mechanic: GameMechanic;
  rulesBefore: string[];
  rules: string[];
  levels: Level[];
  codeSpots: DesignCodeSpot[];
  sprites: Array<{ name: string; look: string }>;
  coverPrompt: string;
  verdictQuestion: string;
  aiSuspicion: string;
  codeMap: Array<{ inPuzzle: string; inCode: string }>;
  musicVibe: string;
};

export type PuzzleDesign = Omit<Design, "codeSpots" | "styleName" | "colors" | "dimension"> & {
  theme: PuzzleTheme;
  codeSpots: CodeSpot[];
};

export type BuildState = {
  interactionId: string;
  model: string;
  attempt: number;
  kind: "build" | "repair";
  startedAt: string;
  problems: string[];
};

export type Puzzle = PuzzleDesign & {
  format: number;
  id: string;
  createdAt: string;
  status: "building" | "ready" | "failed";
  build: BuildState | null;
  /** File names inside the puzzle folder, or null when generation failed or was off. */
  musicFile: string | null;
  assets: { cover: string | null; sprites: string | null };
  models: { research?: string; design: string; build: string; music: string | null; image: string | null };
  research: ResearchNotes | null;
  source: Pick<PullRequestSource, "url" | "repository" | "number" | "title" | "author" | "mergedAt">;
};

export type VerdictTally = { holds: number; breaks: number };
export type Verdict = "holds" | "breaks";
export type JudgmentTally = Tally;

export type ProgressEvent =
  | { type: "stage"; stage: "source" | "research" | "design" | "build" | "art" | "music" | "save"; status: "active" | "done" | "skipped"; detail?: string }
  | { type: "done"; puzzle: Puzzle }
  | { type: "error"; message: string };

const ID_PATTERN = /^[a-z0-9]{6,12}-[a-f0-9]{6}$/;

export function isPuzzleId(id: string) {
  return ID_PATTERN.test(id);
}

/* ---------- Design ---------- */

const short = (description: string) => ({ type: "string", description });
const views = (values: string[], description: string) => ({ type: "string", enum: values, description });

const designSchema = {
  type: "object",
  properties: {
    coreDecision: short("Hidden, for reviewers. The ONE decision you distilled, as 2-6 lines of plain pseudo-rules naming the real identifiers. Write this first."),
    title: short("Game name, 2-4 words. Witty, not childish."),
    emoji: short("One emoji."),
    premise: short("Card teaser, max 12 words."),
    projectSummary: short("Briefing: what the project is and who uses it, one plain sentence, max 18 words."),
    changeSummary: short("Briefing: what this change does and why, one plain sentence, max 20 words."),
    promise: short("What should always be true after this change, max 10 words."),
    styleName: short("2-4 word name for this game's own art direction."),
    artDirection: short("This game's own art direction: palette, shapes, materials, type, motion. Specific, original, clean. Max 60 words."),
    colors: { type: "array", items: short("Hex colour like #1a2b3c"), minItems: 3, maxItems: 5, description: "[background, ink, accent, ...extras]" },
    dimension: views(["2d", "3d"], "3d only if depth makes the logic clearer."),
    system: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      description: "The WHOLE system as a chain the data travels through, start to where a person sees the result. Mark the changed stage(s).",
      items: {
        type: "object",
        properties: { name: short("Max 3 words."), emoji: short("One emoji."), role: short("Max 8 words."), changed: { type: "boolean" } },
        required: ["name", "emoji", "role", "changed"],
      },
    },
    switchLabels: {
      type: "object",
      description: "World words for the old vs new version of the changed part.",
      properties: { old: short("Max 3 words."), new: short("Max 3 words.") },
      required: ["old", "new"],
    },
    solved: {
      type: "object",
      properties: {
        situation: short("What the change fixes or adds, max 14 words."),
        before: short("Old behaviour, max 12 words."),
        after: short("New behaviour, max 12 words."),
        aiView: views(["works", "partly", "no"], "Your honest view: does the fix work for this situation and close variants?"),
        aiReason: short("Why, max 20 words."),
      },
      required: ["situation", "before", "after", "aiView", "aiReason"],
    },
    tradeoffs: {
      type: "array",
      minItems: 0,
      maxItems: 1,
      description: "0-1 real tradeoff a player can FEEL by playing.",
      items: {
        type: "object",
        properties: {
          title: short("Max 6 words."),
          gain: short("What gets better, max 12 words."),
          cost: short("What gets worse, max 12 words."),
          aiView: views(["worth", "unsure", "not"], "Your honest view."),
          aiReason: short("Why, max 20 words."),
        },
        required: ["title", "gain", "cost", "aiView", "aiReason"],
      },
    },
    cases: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      description: "1-2 tricky situations from the research, realistic in the WHOLE system. Prefer ones the change introduced; include one that breaks the promise if the code really has a weak spot.",
      items: {
        type: "object",
        properties: {
          title: short("Max 6 words."),
          scenario: short("The real-life situation, max 20 words."),
          outcome: short("What the system does then, max 14 words."),
          brokePromise: { type: "boolean" },
          origin: views(["introduced", "existing"], "Introduced/exposed by this change, or already there."),
          aiLikelihood: views(["likely", "rare", "never"], "Your honest estimate of how often this happens in real use."),
          aiReason: short("Why, max 20 words."),
        },
        required: ["title", "scenario", "outcome", "brokePromise", "origin", "aiLikelihood", "aiReason"],
      },
    },
    mechanic: {
      type: "object",
      description: "The ONE core mechanic the whole game is built on.",
      properties: {
        name: short("Max 4 words."),
        core: short("What the player physically does, and how the game responds. Max 40 words."),
        twist: short("What makes it this game's own, and how it embodies the code's logic. Max 25 words."),
      },
      required: ["name", "core", "twist"],
    },
    rulesBefore: { type: "array", items: short("Max 14 words."), minItems: 1, maxItems: 3, description: "How the changed part behaved BEFORE the change." },
    rules: { type: "array", items: short("Max 14 words."), minItems: 1, maxItems: 4, description: "How it behaves AFTER the change, quirks included." },
    levels: {
      type: "array",
      minItems: 4,
      maxItems: 6,
      description:
        'The level progression, in order: optional "intro" (teaches the mechanic, not judged), "fix", "tradeoff-0" (if a tradeoff), "case-0", "case-1" (one per case), and "hunt" last. Each level deepens the same mechanic with one new wrinkle.',
      items: {
        type: "object",
        properties: {
          beat: views(["intro", "fix", "tradeoff-0", "case-0", "case-1", "hunt"], "Which standardized moment this level is."),
          title: short("Level name, max 4 words."),
          goal: short("What to make happen, max 10 words."),
          setup: short("The starting state of the board: which objects, where, in what state. Max 40 words."),
          solution: short("The intended solution, so the level is a real puzzle with an answer. Max 30 words. (The hunt: a known way to break it.)"),
          teaches: short("What the player learns about the logic, max 12 words."),
          codeSpot: short("id of the code spot to reveal in this level, or empty."),
          peekMoment: short("The exact moment to reveal the code, max 12 words."),
        },
        required: ["beat", "title", "goal", "setup", "solution", "teaches", "codeSpot", "peekMoment"],
      },
    },
    codeSpots: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      description: "2-4 moments where peeking at the real changed code links 'this line' to 'what you just saw'.",
      items: {
        type: "object",
        properties: {
          id: short("Short slug."),
          caption: short("Plain caption: what this code does, in the world's words. Max 16 words."),
          file: short("The file path exactly as in the DIFF header."),
          anchor: short("A distinctive piece of ONE added or removed line in the DIFF, copied character for character (10-60 chars)."),
        },
        required: ["id", "caption", "file", "anchor"],
      },
    },
    sprites: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      description: "Exactly 4 key objects of the game, drawn as one 2x2 sprite sheet in its art direction.",
      items: { type: "object", properties: { name: short("Max 3 words."), look: short("What it looks like, max 15 words.") }, required: ["name", "look"] },
    },
    coverPrompt: short("A cover illustration in the game's art direction (no text, no letters), max 40 words."),
    verdictQuestion: short("Question for the final free hunt, max 12 words."),
    aiSuspicion: short("Hidden. Your honest guess at the weakest spot, 1-2 sentences, may use code terms."),
    codeMap: {
      type: "array",
      maxItems: 6,
      items: { type: "object", properties: { inPuzzle: { type: "string" }, inCode: { type: "string" } }, required: ["inPuzzle", "inCode"] },
      description: "Hidden decoder: game element -> identifier in the code.",
    },
    musicVibe: short("6-10 words: instruments and mood that fit the game. Calm enough to think."),
  },
  required: [
    "coreDecision", "title", "emoji", "premise", "projectSummary", "changeSummary", "promise", "styleName", "artDirection", "colors",
    "dimension", "system", "switchLabels", "solved", "tradeoffs", "cases", "mechanic", "rulesBefore", "rules", "levels", "codeSpots",
    "sprites", "coverPrompt", "verdictQuestion", "aiSuspicion", "codeMap", "musicVibe",
  ],
};

function researchSection(notes: ResearchNotes | null, fallback: string, pr: PullRequestSource) {
  if (!notes) return `RESEARCH (incomplete; raw findings):\n${fallback || "(none)"}\n\nEXCERPTS AROUND THE CHANGES:\n${pr.context || "(unavailable)"}`;
  return `RESEARCH NOTES (from browsing the repo)
Project: ${notes.project}
Change: ${notes.change}
Fixed: ${notes.fixed?.situation} | before: ${notes.fixed?.before} | after: ${notes.fixed?.after}
Tradeoffs: ${(notes.tradeoffs ?? []).join(" | ") || "(none noted)"}
Flow: ${notes.flow}
Edge cases:
${notes.edgeCases
  .map((edge) => `- ${edge.input}\n  real trigger: ${edge.realTrigger}\n  result: ${edge.whatHappens}\n  ${edge.introduced ? "introduced by this PR" : "already existed"}; likelihood: ${edge.likelihood} [${edge.evidence}]`)
  .join("\n")}
Theme hint: ${notes.themeHint}

KEY CODE:
${notes.keyCode}`;
}

function designPrompt(pr: PullRequestSource, research: string, mechanics: Mechanic[], recent: Puzzle[]) {
  return `You are the lead designer of SlopHop. Each SlopHop puzzle is ONE carefully designed puzzle game (think the craft of Brilliant.org,
the clarity of Brain Age, the wit of WarioWare, the depth of a great indie puzzle game) that lets smart adults who don't code see, test
and judge a real code change, so a human can feel safe (or rightly unsafe) merging a possibly AI-written pull request.

THE GAME
- ONE core mechanic, explored across 4-6 levels. Each level adds one new wrinkle; nothing is thrown away. By the end, the player
  genuinely understands how the change behaves in the whole system.
- Every level is a real puzzle with an intended solution, never a quiz. The player solves it by manipulating the world.
- Calm and unhurried: no timers, no countdowns, no failure screens. Gentle hints when someone is stuck. Let people think.
- Fun and witty for grown-ups. Never banal, never childish.

STANDARDIZED MOMENTS (the host app asks these questions after the level that sets them up)
- "fix": the player flips between old and new behaviour (switchLabels) and sees what the change fixed. Then: did it fix it?
- "tradeoff-0" (optional): the player feels both sides. Then: is the give-and-take worth it?
- "case-N": the player DISCOVERS a tricky situation by building it. Then: could this really happen?
- "hunt" (last): a sandbox of the same mechanic. Can the player find another way to break the promise?
- "intro" (optional, first): teaches the mechanic, no question.

METHOD
1. The system: trace where the data starts, every stage it passes, where a person finally sees the result. Mark the changed stage.
2. The promise: the ONE thing the change guarantees that matters most.
3. The mechanic: find the interaction that best EMBODIES this logic. Ideas below for inspiration; pick one, combine, or invent better.
4. Levels: design each board (setup) and its intended solution. Make sure each is solvable and teaches one thing.
5. Code spots: 2-4 moments where a peek at the real changed code links "this line" to "what you just saw". Anchors copied exactly from the DIFF.
6. Art direction: invent this game's own look. Clean and confident, but specific and surprising: palette, materials, type, motion.
   It must be clearly different from these recent games: ${recent.map((puzzle) => `"${puzzle.theme.name}"`).join(", ") || "(none yet)"}.
7. Art assets: 4 sprites (key objects) and a cover illustration in that art direction.
8. Honest views (fix, tradeoff, likelihoods): hidden until players answer, then compared with the crowd.

RULES
- Faithful: the game behaves like the code (before and after), bugs and quirks included. Do not fix it.
- Players see EVERY field except coreDecision, aiSuspicion, aiReason, codeMap, the levels' solutions, and codeSpots' file/anchor.
  All player-facing fields follow PLAIN LANGUAGE. Translate, don't simplify away: e.g. "SF_25" -> "the 25th rune".

PLAIN LANGUAGE
${STYLE.plainLanguage}

MECHANIC IDEAS (inspiration only)
${mechanics.map((mechanic) => `- ${mechanic.name}: ${mechanic.how} Good for ${mechanic.goodFor}.`).join("\n")}

PULL REQUEST: ${pr.repository}#${pr.number}: ${pr.title}
DESCRIPTION:
${pr.body || "(none)"}

${research}

DIFF:
${pr.diff}`;
}

/** Cut each code spot's lines out of the real diff, so popups never show invented code. */
function resolveCodeSpots(spots: DesignCodeSpot[], diff: string): CodeSpot[] {
  const blocks = diff
    .split(/^--- (?=\S[^\n]* \((?:added|removed|modified|renamed|changed|copied|unchanged)[,)])/m)
    .filter(Boolean)
    .map((block) => {
      const [header, ...lines] = block.split("\n");
      return { file: header.replace(/ \([^)]*\)\s*$/, "").trim(), lines };
    });
  const norm = (text: string) => text.replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const resolved: CodeSpot[] = [];
  for (const spot of spots ?? []) {
    const anchor = norm(spot.anchor ?? "");
    if (anchor.length < 4 || !spot.id || seen.has(spot.id)) continue;
    const sameFile = blocks.filter((block) => block.file === spot.file || block.file.endsWith(spot.file) || spot.file.endsWith(block.file));
    for (const block of [...sameFile, ...blocks]) {
      const at = block.lines.findIndex((line) => /^[+-]/.test(line) && norm(line.slice(1)).includes(anchor));
      if (at < 0) continue;
      let start = at;
      let end = at;
      while (start > 0 && at - start < 4 && !block.lines[start - 1].startsWith("@@")) start--;
      while (end < block.lines.length - 1 && end - at < 6 && block.lines[end + 1] !== "" && !block.lines[end + 1].startsWith("@@")) end++;
      resolved.push({ id: spot.id, caption: spot.caption, file: block.file, lines: block.lines.slice(start, end + 1).map((line) => line.slice(0, 140)) });
      seen.add(spot.id);
      break;
    }
  }
  return resolved;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Clamp the design and guarantee the level order: [intro], fix, [tradeoff-0], case-0..N, hunt. */
function normaliseDesign(design: Design, diff: string): PuzzleDesign {
  const colors = (design.colors ?? []).filter((color) => HEX.test(color));
  const system = (design.system ?? []).slice(0, 5);
  if (system.length && !system.some((stage) => stage.changed)) system[Math.floor(system.length / 2)].changed = true;
  const tradeoffs = (design.tradeoffs ?? []).slice(0, 1).map((entry) => ({ ...entry, aiView: ["worth", "unsure", "not"].includes(entry.aiView) ? entry.aiView : "unsure" }) as PuzzleTradeoff);
  const cases = (design.cases ?? []).slice(0, 2).map((entry) => ({
    ...entry,
    origin: entry.origin === "existing" ? "existing" : "introduced",
    aiLikelihood: ["likely", "rare", "never"].includes(entry.aiLikelihood) ? entry.aiLikelihood : "rare",
  }) as PuzzleCase);
  const codeSpots = resolveCodeSpots(design.codeSpots, diff);
  const spotIds = new Set(codeSpots.map((spot) => spot.id));

  const designed = design.levels ?? [];
  const beats = [
    ...(designed.some((level) => level.beat === "intro") ? ["intro"] : []),
    "fix",
    ...tradeoffs.map((_, index) => `tradeoff-${index}`),
    ...cases.map((_, index) => `case-${index}`),
    "hunt",
  ];
  const levels: Level[] = beats.map((beat) => {
    const found = designed.find((level) => level.beat === beat);
    const parsed = parseQuestionKey(beat);
    const subject = parsed?.kind === "case" ? cases[parsed.index] : undefined;
    const fallback: Level = {
      beat,
      title: subject?.title ?? (beat === "fix" ? "What changed" : beat === "hunt" ? "Break it" : tradeoffs[0]?.title ?? "Warm-up"),
      goal: beat === "fix" ? `Make it work: ${design.solved?.after ?? ""}` : beat === "hunt" ? design.verdictQuestion : subject ? `Make it happen: ${subject.title}` : "",
      setup: subject ? subject.scenario : beat === "fix" ? design.solved?.situation ?? "" : "",
      solution: subject ? subject.outcome : "",
      teaches: "",
      codeSpot: "",
      peekMoment: "",
    };
    const level = found ? { ...fallback, ...found, beat } : fallback;
    return { ...level, codeSpot: spotIds.has(level.codeSpot) ? level.codeSpot : "" };
  });
  for (const spot of codeSpots) {
    if (levels.some((level) => level.codeSpot === spot.id)) continue;
    const free = levels.find((level) => !level.codeSpot && level.beat !== "hunt" && level.beat !== "intro");
    if (free) free.codeSpot = spot.id;
  }

  const { styleName, colors: _colors, dimension, codeSpots: _spots, ...rest } = design;
  void _colors;
  void _spots;
  return {
    ...rest,
    theme: {
      name: styleName || design.title,
      colors: colors.length >= 3 ? colors.slice(0, 5) : ["#f7f6f2", "#161616", "#ff4d2e"],
      dimension: dimension === "3d" ? "3d" : "2d",
    },
    system,
    switchLabels: { old: design.switchLabels?.old || "Old way", new: design.switchLabels?.new || "New way" },
    solved: { ...design.solved, aiView: ["works", "partly", "no"].includes(design.solved?.aiView) ? design.solved.aiView : "partly" },
    tradeoffs,
    cases,
    levels,
    codeSpots,
    sprites: (design.sprites ?? []).slice(0, 4),
  };
}

export async function designPuzzle(pr: PullRequestSource, notes: ResearchNotes | null, fallback: string, recent: Puzzle[] = [], signal?: AbortSignal) {
  const { data, model } = await generateJson<Design>({
    model: MODELS.design,
    prompt: designPrompt(pr, researchSection(notes, fallback, pr), offerMechanics(), recent),
    schema: designSchema,
    thinking: DESIGN_THINKING,
    signal,
  });
  return { design: normaliseDesign(data, pr.diff), model };
}

/* ---------- Build (one game, as a background interaction) ---------- */

const THREE_VERSION = "0.170.0";
const THREE_BASE = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/`;
const SFX_NAMES = "tap, pick, drop, snap, pop, whoosh, tick, success, fail, buzz, crack, coin";

function levelBrief(design: PuzzleDesign, level: Level, index: number) {
  const parsed = parseQuestionKey(level.beat);
  const spot = design.codeSpots.find((candidate) => candidate.id === level.codeSpot);
  const head = `Level ${index + 1} "${level.title}" [${level.beat}]
  Goal: ${level.goal}
  Setup: ${level.setup}
  Intended solution (don't reveal; use it to verify the level is solvable and to write hints): ${level.solution}
  Teaches: ${level.teaches}`;
  const peek = spot
    ? `\n  Code peek: right AFTER the player has seen this happen: ${level.peekMoment || spot.caption}, call
  SlopHop.peek("${spot.id}", <the element where it happened>, "<what just happened, plain words, max 12 words>").`
    : "";
  let end = "";
  if (level.beat === "intro") end = "When solved: move on (no judgment).";
  else if (level.beat === "fix") {
    end = `Use <sh-switch old="${design.switchLabels.old}" new="${design.switchLabels.new}"> to flip the changed part between old and new; the player must see it go wrong the old way and right the new way.
  When solved: await SlopHop.judge("fix");`;
  } else if (parsed?.kind === "tradeoff") {
    const entry = design.tradeoffs[parsed.index];
    end = `Give and take "${entry.title}": they must feel what we win (${entry.gain}) and what we lose (${entry.cost}).
  When solved: await SlopHop.judge("tradeoff", ${parsed.index});`;
  } else if (parsed?.kind === "case") {
    const entry = design.cases[parsed.index];
    end = `Tricky situation "${entry.title}": ${entry.scenario} Result: ${entry.outcome} (${entry.brokePromise ? "BREAKS the promise" : "promise holds"}).
  The player discovers it by building it; don't set it up for them.
  When they reach it: await SlopHop.judge("case", ${parsed.index}, { outcome: "<what happened, plain words>", brokePromise: ${entry.brokePromise} });`;
  } else if (level.beat === "hunt") {
    end = `The hunt: a sandbox of the same mechanic, everything can be grabbed, emptied, stretched. Show "${design.verdictQuestion}" small.
  Two buttons: "I broke it" (capture what they built + what happened + optional one-line note) and "Couldn't break it".
  Then SlopHop.verdict({ verdict: "breaks" | "holds", evidence: "<what they set up and what happened>", score: <levels solved> }) and a short, warm ending.`;
  }
  return `${head}${peek}\n  ${end}`;
}

function buildPrompt(design: PuzzleDesign) {
  const sprites = design.sprites.map((sprite, index) => `${index}: ${sprite.name} (${sprite.look})`).join("; ");
  return `Build "${design.title}": ONE complete, carefully crafted puzzle game in a single self-contained HTML file.
It lets smart adults who don't code see, test and judge a real code change. Bar: the craft of Brilliant.org, the clarity of Brain Age,
the wit of WarioWare, the depth of a great indie puzzle game. Fun for grown-ups; never banal or childish.

THE WORLD
Promise: "${design.promise}"
The whole system, in order: ${design.system.map((entry) => `${entry.emoji} ${entry.name}${entry.changed ? " [CHANGED]" : ""} (${entry.role})`).join(" -> ")}
How the changed part behaved BEFORE: ${design.rulesBefore.join(" | ")}
How it behaves NOW (implement exactly, quirks included, for ANY state the player can create): ${design.rules.join(" | ")}

THE MECHANIC: ${design.mechanic.name}
${design.mechanic.core}
Twist: ${design.mechanic.twist}

LEVELS (one mechanic, each level adds one wrinkle)
${design.levels.map((level, index) => levelBrief(design, level, index)).join("\n\n")}

PACING
- Calm. NO timers, countdowns, lives or failure screens. Let people think and experiment.
- If someone seems stuck (~30s without progress), gently pulse something useful or make the <sh-hint> available.
- Levels flow into each other with a short, satisfying transition; the player can replay the current level (a small reset).

THE CONTRACT (must)
- Begin with: await SlopHop.started; (the host shows a briefing first). No start screen, no title screen.
- Direct manipulation with pointer events (drag, rotate, hold, swipe, stack). No multiple-choice, no option-button rows, chips or dropdowns.
  At most 6 <button> elements in total, including the hunt's two buttons and a reset.
- Never ask the judgment questions yourself; the host asks after each SlopHop.judge(...).
- Never render code. Code peeks: call SlopHop.peek(id, element, "what just happened") only right AFTER the player has visibly seen
  the effect of that code (never before, never at random). The host shows a small "why?" tag next to that element; the player taps it
  to see what happened, why, and the real code.
- Sound: SlopHop.sfx(name) on every meaningful touch and event. Names: ${SFX_NAMES}.

STANDARD ELEMENTS (provided by the host; use them where they fit, and style them via CSS variables:
--sh-ui-ink, --sh-ui-bg, --sh-ui-accent, --sh-ui-font, --sh-ui-radius)
- <sh-promise>${design.promise}</sh-promise>: keep it visible. SlopHop.promise("ok" | "strained" | "broken") updates it (it cracks when broken).
- <sh-switch old="..." new="...">: the old/new code switch. Listen for its "change" event (event.detail.value is "old" or "new").
- <sh-goal level="2/5">goal text</sh-goal>: the current level's goal.
- <sh-hint>hint text</sh-hint>: a small "?" that reveals the hint.
- <sh-progress total="5" current="2"></sh-progress>: level dots.

ART DIRECTION (this game's own): "${design.theme.name}"
${design.artDirection}
Palette: ${design.theme.colors.join(", ")} (background, ink, accent, extras). Any Google Fonts via <link>. ${design.theme.dimension === "3d" ? "This game is 3D (three.js)." : ""}
${STYLE.gameCraft}
Generated art (may be unavailable: ALWAYS draw a clean fallback with CSS/SVG/canvas):
- SlopHop.assets.cover: URL of a cover illustration or null.
- SlopHop.sprite(i): CSS declarations for sprite i of a 2x2 sheet on a white backdrop (or ""). Use "mix-blend-mode: multiply" on light
  surfaces to drop the white, or set sprites on light tiles. Sprites: ${sprites}.

PHONE FIRST, NO CLUTTER
- Portrait phone (390x700) first; one screen, no scroll; scales up gracefully on desktop.
- One focus area. Touch targets at least 48px. At most two short lines of text visible at once.
- Leave the bottom 64px free of important controls (the host's code chip sits there).

TECH
- Output ONLY the HTML document, starting with <!doctype html>. Inline CSS and JS. No network requests, no external images.
- three.js r170 is available via import map (import * as THREE from "three"; addons under "three/addons/"); keep it light, cap DPR at 2,
  fall back to 2D if WebGL fails.
- No music (the host plays it).

PLAIN LANGUAGE (every label, hint and message)
${STYLE.plainLanguage}
Before finishing: play each level in your head against its intended solution, and reread every visible string.`;
}

/** Static checks for the game contract. Returns human-readable problems (empty = fine). */
export function checkGame(html: string, design: PuzzleDesign) {
  const problems: string[] = [];
  const has = (pattern: RegExp) => pattern.test(html);
  const buttons = (html.match(/<button\b/gi) ?? []).length + (html.match(/createElement\(\s*["']button["']/gi) ?? []).length;
  if (!has(/pointer(down|move)|touchstart/i)) problems.push("No direct manipulation: use pointer events to drag/rotate/hold/swipe objects.");
  if (buttons > 7) problems.push(`Too many buttons (${buttons}); at most 6. Replace option buttons with objects to manipulate.`);
  if (!has(/SlopHop\??\.started/)) problems.push("Missing `await SlopHop.started;` before the game begins.");
  if (!has(/judge\??\.?\(\s*["']fix["']/)) problems.push('Missing `await SlopHop.judge("fix")` after the fix level.');
  if (design.tradeoffs.length && !has(/["']tradeoff["']/)) problems.push('Missing `await SlopHop.judge("tradeoff", 0)` after the give-and-take level.');
  if (!has(/["']case["']/)) problems.push('Missing `await SlopHop.judge("case", i, { outcome, brokePromise })` after each tricky-situation level.');
  if (!has(/SlopHop\??\.verdict\??\.?\(/)) problems.push("Missing SlopHop.verdict(...) at the end of the hunt.");
  for (const spot of design.codeSpots) {
    if (!has(new RegExp(`peek\\??\\.?\\(\\s*["'\`]${spot.id}`))) problems.push(`Never calls SlopHop.peek("${spot.id}", element, "what just happened") after the player sees that effect.`);
  }
  if (!has(/SlopHop\??\.sfx/)) problems.push("No sound: call SlopHop.sfx(name) on touches and events.");
  if (has(/setInterval\([^)]*(countdown|timeLeft|timer)/i) || has(/time'?s up|out of time/i)) problems.push("Remove timers and countdowns: the game must be calm and untimed.");
  return problems;
}

function cleanHtml(raw: string) {
  const html = raw.trim().replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!/<html|<body|<!doctype/i.test(html)) throw new Error("Gemini did not return a playable HTML game.");
  return html;
}

function repairPrompt(design: PuzzleDesign, html: string, problems: string[]) {
  return `${buildPrompt(design)}

----
Here is a draft of this game that breaks the contract. Fix ALL of these problems, keep everything that already works, and output the
complete corrected HTML document only.

PROBLEMS
${problems.map((problem) => `- ${problem}`).join("\n")}

DRAFT
${html}`;
}

async function startBuild(design: PuzzleDesign, attempt: number, draft?: { html: string; problems: string[] }): Promise<BuildState> {
  const prompt = draft ? repairPrompt(design, draft.html, draft.problems) : buildPrompt(design);
  const { id, model } = await startBackground({ model: MODELS.build, prompt, thinking: BUILD_THINKING, maxOutputTokens: BUILD_MAX_TOKENS });
  return { interactionId: id, model, attempt, kind: draft ? "repair" : "build", startedAt: new Date().toISOString(), problems: draft?.problems ?? [] };
}

async function savePuzzle(puzzle: Puzzle) {
  await saveFile(`puzzles/${puzzle.id}/meta.json`, JSON.stringify(puzzle, null, 2), "application/json");
}

/**
 * Moves a building puzzle forward: checks the background interaction, saves the game when done,
 * and starts a repair or retry when the result breaks the contract. Safe to call repeatedly.
 */
export async function advanceBuild(puzzle: Puzzle): Promise<Puzzle> {
  if (puzzle.status !== "building" || !puzzle.build) return puzzle;
  const state = await getBackground(puzzle.build.interactionId);
  if (state.status === "running") return puzzle;

  const existingDraft = await readText(`puzzles/${puzzle.id}/game.html`);
  let html: string | null = null;
  try {
    html = state.status === "completed" ? cleanHtml(state.text) : null;
  } catch {
    html = null;
  }

  if (html) {
    const problems = checkGame(html, puzzle);
    const better = !existingDraft || problems.length <= (puzzle.build.problems.length || Infinity);
    if (better) await saveFile(`puzzles/${puzzle.id}/game.html`, html, "text/html; charset=utf-8");
    if (problems.length && puzzle.build.attempt < MAX_BUILD_ATTEMPTS) {
      const next = await startBuild(puzzle, puzzle.build.attempt + 1, { html, problems }).catch(() => null);
      if (next) return saveAndReturn({ ...puzzle, build: next });
    }
    if (problems.length) console.warn(`Game ${puzzle.id} still has contract problems`, problems);
    return saveAndReturn({ ...puzzle, status: "ready", build: { ...puzzle.build, problems }, models: { ...puzzle.models, build: puzzle.build.model } });
  }

  console.error(`Build ${puzzle.build.interactionId} failed`, state.error);
  if (existingDraft) return saveAndReturn({ ...puzzle, status: "ready" });
  if (puzzle.build.attempt < MAX_BUILD_ATTEMPTS) {
    const next = await startBuild(puzzle, puzzle.build.attempt + 1).catch(() => null);
    if (next) return saveAndReturn({ ...puzzle, build: next });
  }
  return saveAndReturn({ ...puzzle, status: "failed" });

  async function saveAndReturn(next: Puzzle) {
    await savePuzzle(next);
    return next;
  }
}

/* ---------- Art + music ---------- */

function spriteSheetPrompt(design: PuzzleDesign) {
  return `A 2x2 grid sprite sheet of four separate objects, each centred in its own quadrant with generous padding, on a pure white background.
No text, no letters, no labels, no borders, no grid lines, no shadows crossing quadrants.
Top-left: ${design.sprites[0]?.look}. Top-right: ${design.sprites[1]?.look}. Bottom-left: ${design.sprites[2]?.look}. Bottom-right: ${design.sprites[3]?.look}.
Art direction: ${design.artDirection}. Keep the background pure white.`;
}

function musicPrompt(design: PuzzleDesign) {
  return `${STYLE.musicDirection} Game: ${design.theme.name}. Flavour: ${design.musicVibe}.`;
}

/* ---------- Pipeline ---------- */

function newId() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * Research + design + art + music happen in this request. The game itself is built by a Gemini
 * background interaction; the puzzle is saved as "building" and finished by advanceBuild() when polled.
 */
export async function createPuzzle(options: { prUrl?: string; emit: (event: ProgressEvent) => void; signal?: AbortSignal }) {
  const { emit, signal } = options;
  const id = newId();

  emit({ type: "stage", stage: "source", status: "active" });
  const [pr, recent] = await Promise.all([
    options.prUrl ? getPullRequest(options.prUrl) : findPuzzleWorthyPullRequest(),
    listPuzzles(6).catch(() => [] as Puzzle[]),
  ]);
  emit({ type: "stage", stage: "source", status: "done", detail: `${pr.repository}#${pr.number} · ${pr.title}` });

  emit({ type: "stage", stage: "research", status: "active" });
  const research = await researchPullRequest({
    pr,
    signal,
    onStep: (detail) => emit({ type: "stage", stage: "research", status: "active", detail }),
  }).catch((error: unknown) => {
    console.error("Research failed", error);
    return { notes: null, model: undefined, steps: 0, overview: "", fallback: "" };
  });
  emit({
    type: "stage",
    stage: "research",
    status: research.notes ? "done" : "skipped",
    detail: research.notes ? `${research.steps} look-ups · ${research.notes.edgeCases.length} edge cases found` : "Went with the diff alone",
  });

  emit({ type: "stage", stage: "design", status: "active" });
  const { design, model: designModel } = await designPuzzle(pr, research.notes, research.fallback, recent, signal);
  emit({
    type: "stage",
    stage: "design",
    status: "done",
    detail: `${design.emoji} ${design.title} · ${design.theme.name} · ${design.mechanic.name} · ${design.levels.length} levels`,
  });

  emit({ type: "stage", stage: "build", status: "active", detail: "Starting the build" });
  const build = await startBuild(design, 1);
  emit({ type: "stage", stage: "build", status: "active", detail: `${build.model} is building the game (takes a few minutes)` });
  emit({ type: "stage", stage: "art", status: IMAGES_ENABLED ? "active" : "skipped", detail: IMAGES_ENABLED ? undefined : "Images are off" });
  emit({ type: "stage", stage: "music", status: "active" });

  const saveImage = (name: string, prompt: string, aspectRatio: string) =>
    generateImage({ prompt, aspectRatio, signal })
      .then(async (image) => {
        const file = `${name}.${image.extension}`;
        await saveFile(`puzzles/${id}/${file}`, image.bytes, image.mimeType);
        return file;
      })
      .catch((error: unknown) => {
        console.error(`Image ${name} failed`, error);
        return null;
      });
  const artTask = IMAGES_ENABLED
    ? Promise.all([
        saveImage("cover", `${design.coverPrompt}. Art direction: ${design.artDirection}. No text or letters anywhere.`, "4:3"),
        saveImage("sprites", spriteSheetPrompt(design), "1:1"),
      ]).then(([cover, sprites]) => {
        emit({ type: "stage", stage: "art", status: cover || sprites ? "done" : "skipped", detail: cover || sprites ? "Cover and sprites drawn" : "No art this time" });
        return { cover, sprites };
      })
    : Promise.resolve({ cover: null, sprites: null });

  const musicTask = generateMusic({ prompt: musicPrompt(design), signal })
    .then(async (music) => {
      await saveFile(`puzzles/${id}/music.${music.extension}`, music.bytes, music.mimeType);
      emit({ type: "stage", stage: "music", status: "done", detail: "Soundtrack composed" });
      return music.extension;
    })
    .catch((error: unknown) => {
      console.error("Music generation failed", error);
      emit({ type: "stage", stage: "music", status: "skipped", detail: "No soundtrack this time" });
      return null;
    });

  const [assets, musicExtension] = await Promise.all([artTask, musicTask]);

  emit({ type: "stage", stage: "save", status: "active" });
  const puzzle: Puzzle = {
    ...design,
    format: FORMAT,
    id,
    createdAt: new Date().toISOString(),
    status: "building",
    build,
    musicFile: musicExtension ? `music.${musicExtension}` : null,
    assets,
    models: {
      research: research.model,
      design: designModel,
      build: build.model,
      music: musicExtension ? MODELS.music : null,
      image: assets.cover || assets.sprites ? MODELS.image : null,
    },
    research: research.notes,
    source: { url: pr.url, repository: pr.repository, number: pr.number, title: pr.title, author: pr.author, mergedAt: pr.mergedAt },
  };
  await savePuzzle(puzzle);
  emit({ type: "stage", stage: "save", status: "done", detail: "Saved; the game finishes building in the background" });
  return puzzle;
}

/* ---------- Reading ---------- */

function parsePuzzle(text: string | null): Puzzle | null {
  if (!text) return null;
  const puzzle = JSON.parse(text) as Puzzle;
  return puzzle.format === FORMAT ? puzzle : null;
}

export async function getPuzzle(id: string): Promise<Puzzle | null> {
  if (!isPuzzleId(id)) return null;
  return parsePuzzle(await readText(`puzzles/${id}/meta.json`));
}

export async function getGameHtml(id: string) {
  if (!isPuzzleId(id)) return null;
  return readText(`puzzles/${id}/game.html`);
}

export async function getAsset(puzzle: Puzzle, name: string) {
  const file = name === "cover" ? puzzle.assets.cover : name === "sprites" ? puzzle.assets.sprites : null;
  return file ? readFile(`puzzles/${puzzle.id}/${file}`) : null;
}

/** Newest first, by creation time (meta files are rewritten while building). */
export async function listPuzzles(limit = 60): Promise<Puzzle[]> {
  const files = await listFiles("puzzles/");
  const metas = files
    .filter((file) => file.pathname.endsWith("/meta.json"))
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    .slice(0, limit * 2);
  const puzzles = await Promise.all(metas.map((file) => readText(file.pathname).then(parsePuzzle).catch(() => null)));
  return puzzles
    .filter((puzzle): puzzle is Puzzle => puzzle !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/* ---------- Crowd signals ---------- */
// One small file per signal, with the answer in the path, so tallies need only a list call.

export async function saveVerdict(id: string, input: { verdict: Verdict; evidence: string; score: number }) {
  const record = { ...input, evidence: input.evidence.slice(0, 2000), createdAt: new Date().toISOString() };
  await saveFile(`verdicts/${id}/${input.verdict}/${Date.now()}-${randomBytes(3).toString("hex")}.json`, JSON.stringify(record), "application/json");
}

export async function tallyVerdicts(id?: string): Promise<Record<string, VerdictTally>> {
  const files = await listFiles(id ? `verdicts/${id}/` : "verdicts/");
  const tally: Record<string, VerdictTally> = {};
  for (const file of files) {
    const [, puzzleId, verdict] = file.pathname.split("/");
    if (verdict !== "holds" && verdict !== "breaks") continue;
    tally[puzzleId] ??= { holds: 0, breaks: 0 };
    tally[puzzleId][verdict] += 1;
  }
  return tally;
}

/** Most recent breaking cases players reported in the hunt. */
export async function recentBreaks(id: string, limit = 5): Promise<string[]> {
  const files = (await listFiles(`verdicts/${id}/breaks/`)).sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()).slice(0, limit);
  const records = await Promise.all(files.map((file) => readFile(file.pathname).then((found) => (found ? JSON.parse(found.body.toString("utf8")) : null)).catch(() => null)));
  return records.map((record) => (record?.evidence as string | undefined)?.trim()).filter((evidence): evidence is string => Boolean(evidence));
}

/** Standardized judgments (see lib/review.ts), one file each: judgments/<puzzle>/<question>/<answer>/<ts>.json */
export function isValidAnswer(key: string, answer: string) {
  const parsed = parseQuestionKey(key);
  return Boolean(parsed && ANSWERS[parsed.kind].some((option) => option.value === answer));
}

export async function saveJudgment(id: string, input: { key: string; answer: string; detail: string }) {
  const record = { ...input, detail: input.detail.slice(0, 500), createdAt: new Date().toISOString() };
  await saveFile(`judgments/${id}/${input.key}/${input.answer}/${Date.now()}-${randomBytes(3).toString("hex")}.json`, JSON.stringify(record), "application/json");
}

/** Tallies per puzzle -> question -> answer. */
export async function tallyJudgments(id?: string): Promise<Record<string, Record<string, Tally>>> {
  const files = await listFiles(id ? `judgments/${id}/` : "judgments/");
  const tally: Record<string, Record<string, Tally>> = {};
  for (const file of files) {
    const [, puzzleId, key, answer] = file.pathname.split("/");
    if (!isValidAnswer(key, answer)) continue;
    tally[puzzleId] ??= {};
    tally[puzzleId][key] ??= {};
    tally[puzzleId][key][answer] = (tally[puzzleId][key][answer] ?? 0) + 1;
  }
  return tally;
}

/* ---------- Serving the game ---------- */

/** Standard elements every game can use: <sh-promise>, <sh-switch>, <sh-goal>, <sh-hint>, <sh-progress>. */
const UI_CSS = `
:root{--sh-ui-ink:currentColor;--sh-ui-bg:rgba(255,255,255,.9);--sh-ui-accent:#ff4d2e;--sh-ui-font:inherit;--sh-ui-radius:999px}
sh-promise,sh-goal,sh-switch,sh-hint,sh-progress{font-family:var(--sh-ui-font);color:var(--sh-ui-ink);box-sizing:border-box}
sh-promise{display:inline-flex;align-items:baseline;gap:8px;padding:6px 14px;border:1px solid var(--sh-ui-ink);border-radius:var(--sh-ui-radius);background:var(--sh-ui-bg);font-size:14px;line-height:1.3;position:relative;transition:color .3s,border-color .3s}
sh-promise .sh-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.6}
sh-promise[state=strained]{border-style:dashed;animation:sh-wobble .6s ease}
sh-promise[state=broken]{color:var(--sh-ui-accent);border-color:var(--sh-ui-accent);animation:sh-shake .45s ease}
sh-promise[state=broken] .sh-text{text-decoration:line-through;text-decoration-thickness:2px}
sh-promise[state=broken]::after{content:"";position:absolute;left:12%;right:12%;top:50%;height:2px;background:var(--sh-ui-accent);transform:rotate(-4deg);clip-path:polygon(0 0,18% 100%,36% 0,54% 100%,72% 0,90% 100%,100% 0,100% 100%,0 100%)}
sh-goal{display:inline-flex;align-items:baseline;gap:8px;font-size:16px;line-height:1.3}
sh-goal .sh-level{font-size:11px;letter-spacing:.06em;opacity:.55}
sh-switch{display:inline-flex;position:relative;padding:3px;border:1px solid var(--sh-ui-ink);border-radius:var(--sh-ui-radius);background:var(--sh-ui-bg);touch-action:none;user-select:none}
sh-switch button{position:relative;z-index:1;min-height:40px;padding:0 16px;border:0;background:none;color:inherit;font:inherit;font-size:14px;cursor:pointer;border-radius:var(--sh-ui-radius);transition:color .25s}
sh-switch .sh-thumb{position:absolute;top:3px;bottom:3px;border-radius:var(--sh-ui-radius);background:var(--sh-ui-ink);transition:left .3s cubic-bezier(.3,1.4,.5,1),width .3s}
sh-switch button[aria-pressed=true]{color:var(--sh-ui-bg)}
sh-hint{display:inline-flex;align-items:center;gap:8px;position:relative}
sh-hint button{width:40px;height:40px;border:1px solid var(--sh-ui-ink);border-radius:50%;background:var(--sh-ui-bg);color:inherit;font:inherit;cursor:pointer}
sh-hint .sh-bubble{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:max-content;max-width:min(280px,80vw);padding:10px 12px;border:1px solid var(--sh-ui-ink);border-radius:12px;background:var(--sh-ui-bg);font-size:14px;line-height:1.35;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
sh-hint[open] .sh-bubble{opacity:1;transform:translate(-50%,-4px)}
sh-progress{display:inline-flex;gap:6px}
sh-progress i{width:8px;height:8px;border:1px solid var(--sh-ui-ink);border-radius:50%;transition:background .3s,transform .3s}
sh-progress i.sh-done{background:var(--sh-ui-ink)}
sh-progress i.sh-now{background:var(--sh-ui-accent);border-color:var(--sh-ui-accent);transform:scale(1.3)}
@keyframes sh-shake{20%{transform:translateX(-5px) rotate(-1deg)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
@keyframes sh-wobble{50%{transform:scale(1.03)}}
`;

/**
 * Host <-> game bridge, injected into the game: standard elements, a tiny procedural sound kit,
 * judgments, anchored code peeks and the final verdict.
 * Game -> host: { source: "slophop", type: "judge" | "peek" | "verdict" }.
 * Host -> game: { source: "slophop-host", type: "start" | "judged" | "mute" }.
 */
function bridge(assets: { cover: string | null; sprites: string | null }) {
  return `
(function () {
  var send = function (message) { message.source = "slophop"; parent.postMessage(message, "*"); };
  var resolveStart, muted = false, ctx = null, pending = {}, verdictSent = false;
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data || event.data.source !== "slophop-host") return;
    var d = event.data;
    if (d.type === "start" && resolveStart) { resolveStart(); resolveStart = null; }
    if (d.type === "mute") muted = !!d.muted;
    if (d.type === "judged" && pending[d.key]) { pending[d.key](d.answer); delete pending[d.key]; }
  });

  function ac() {
    if (!ctx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(type, f1, f2, dur, vol, delay) {
    var c = ac(); if (!c) return;
    var t = c.currentTime + (delay || 0), o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f1, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.03);
  }
  function noise(dur, vol, freq, delay) {
    var c = ac(); if (!c) return;
    var t = c.currentTime + (delay || 0), b = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    var s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = b; f.type = "bandpass"; f.frequency.value = freq || 1200;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(c.destination); s.start(t);
  }
  var SFX = {
    tap: function () { tone("sine", 660, 520, 0.06, 0.08); },
    pick: function () { tone("triangle", 440, 720, 0.08, 0.08); },
    drop: function () { tone("sine", 300, 140, 0.12, 0.1); },
    snap: function () { noise(0.04, 0.12, 2400); tone("square", 900, 600, 0.04, 0.03); },
    pop: function () { tone("sine", 500, 1100, 0.07, 0.09); },
    whoosh: function () { noise(0.25, 0.08, 800); },
    tick: function () { tone("square", 1400, 0, 0.02, 0.025); },
    success: function () { tone("triangle", 523, 0, 0.12, 0.08); tone("triangle", 659, 0, 0.12, 0.08, 0.09); tone("triangle", 784, 0, 0.24, 0.08, 0.18); },
    fail: function () { tone("sawtooth", 220, 140, 0.25, 0.04); },
    buzz: function () { tone("square", 120, 0, 0.18, 0.04); },
    crack: function () { noise(0.18, 0.16, 500); tone("sawtooth", 160, 60, 0.2, 0.03); },
    coin: function () { tone("square", 988, 0, 0.06, 0.04); tone("square", 1319, 0, 0.16, 0.04, 0.06); }
  };
  function sfx(name) { if (muted) return; try { (SFX[name] || SFX.tap)(); } catch (e) {} }

  var style = document.createElement("style");
  style.textContent = ${JSON.stringify(UI_CSS)};
  document.head.appendChild(style);

  function define(name, setup) {
    if (customElements.get(name)) return;
    customElements.define(name, class extends HTMLElement {
      connectedCallback() { if (this._ready) return; this._ready = true; setup(this); }
      static get observedAttributes() { return ["state", "current", "total", "level"]; }
      attributeChangedCallback() { if (this._ready && this._update) this._update(); }
    });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  define("sh-promise", function (host) {
    var text = host.textContent.trim(); host.textContent = "";
    host.append(el("span", "sh-label", "Promise"), el("span", "sh-text", text));
    host.setAttribute("role", "status");
  });
  define("sh-goal", function (host) {
    var text = host.textContent.trim(); host.textContent = "";
    var level = el("span", "sh-level"), body = el("span", "sh-text", text);
    host.append(level, body);
    host._update = function () { level.textContent = host.getAttribute("level") || ""; };
    host._update();
  });
  define("sh-hint", function (host) {
    var text = host.textContent.trim(); host.textContent = "";
    var button = el("button", "", "?"), bubble = el("span", "sh-bubble", text);
    button.setAttribute("aria-label", "Hint"); button.type = "button";
    button.addEventListener("click", function () { host.toggleAttribute("open"); sfx("pop"); });
    host.append(button, bubble);
  });
  define("sh-progress", function (host) {
    host._update = function () {
      host.textContent = "";
      var total = Number(host.getAttribute("total")) || 0, current = Number(host.getAttribute("current")) || 0;
      for (var i = 1; i <= total; i++) host.append(el("i", i < current ? "sh-done" : i === current ? "sh-now" : ""));
    };
    host._update();
  });
  define("sh-switch", function (host) {
    var thumb = el("span", "sh-thumb"), a = el("button", "", host.getAttribute("old") || "Old"), b = el("button", "", host.getAttribute("new") || "New");
    a.type = b.type = "button";
    host.setAttribute("role", "group");
    host.append(thumb, a, b);
    function set(value, quiet) {
      host.value = value;
      a.setAttribute("aria-pressed", String(value === "old")); b.setAttribute("aria-pressed", String(value === "new"));
      var on = value === "old" ? a : b;
      thumb.style.left = on.offsetLeft + "px"; thumb.style.width = on.offsetWidth + "px";
      if (!quiet) { sfx("snap"); host.dispatchEvent(new CustomEvent("change", { detail: { value: value }, bubbles: true })); }
    }
    a.addEventListener("click", function () { set("old"); });
    b.addEventListener("click", function () { set("new"); });
    requestAnimationFrame(function () { set(host.getAttribute("value") === "new" ? "new" : "old", true); });
  });

  var ASSETS = ${JSON.stringify(assets)};
  window.SlopHop = {
    started: new Promise(function (resolve) { resolveStart = resolve; setTimeout(resolve, 120000); }),
    assets: ASSETS,
    sprite: function (i) {
      if (!ASSETS.sprites) return "";
      i = Math.max(0, Math.min(3, Number(i) || 0));
      return "background-image:url(" + ASSETS.sprites + ");background-size:200% 200%;background-repeat:no-repeat;background-position:" + (i % 2 ? "100%" : "0%") + " " + (i > 1 ? "100%" : "0%") + ";";
    },
    sfx: sfx,
    promise: function (state) {
      state = state === "broken" || state === "strained" ? state : "ok";
      var nodes = document.querySelectorAll("sh-promise");
      for (var i = 0; i < nodes.length; i++) {
        if (state === "broken" && nodes[i].getAttribute("state") !== "broken") sfx("crack");
        nodes[i].setAttribute("state", state);
      }
    },
    peek: function (id, element, happened) {
      if (typeof element === "string") { happened = element; element = null; }
      var anchor = null;
      if (element && element.getBoundingClientRect) {
        var r = element.getBoundingClientRect();
        anchor = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      send({ type: "peek", id: String(id || ""), anchor: anchor, happened: String(happened || "").slice(0, 200) });
    },
    judge: function (kind, index, data) {
      if (typeof kind === "number") { data = index; index = kind; kind = "case"; }
      kind = kind === "fix" || kind === "tradeoff" ? kind : "case";
      index = Number(index) || 0; data = data || {};
      var key = kind === "fix" ? "fix" : kind + "-" + index;
      return new Promise(function (resolve) {
        pending[key] = resolve;
        send({ type: "judge", key: key, outcome: String(data.outcome || "").slice(0, 500), brokePromise: !!data.brokePromise });
        setTimeout(function () { if (pending[key]) { pending[key](null); delete pending[key]; } }, 600000);
      });
    },
    verdict: function (data) {
      if (verdictSent) return; verdictSent = true; data = data || {};
      send({ type: "verdict", verdict: data.verdict === "breaks" ? "breaks" : "holds", evidence: String(data.evidence || "").slice(0, 2000), score: Number(data.score) || 0 });
    }
  };
})();`;
}

/** Wraps the stored game with the three.js import map and the bridge. The route serves it with a sandboxing CSP header. */
export function wrapGame(html: string, origin: string, puzzle: Puzzle) {
  const assets = {
    cover: puzzle.assets.cover ? `${origin}/api/puzzles/${puzzle.id}/assets/cover` : null,
    sprites: puzzle.assets.sprites ? `${origin}/api/puzzles/${puzzle.id}/assets/sprites` : null,
  };
  const head = `
<script type="importmap">{"imports":{"three":"${THREE_BASE}build/three.module.js","three/addons/":"${THREE_BASE}examples/jsm/"}}</script>
<script>${bridge(assets)}</script>`;
  const wrapped = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (match) => `${match}${head}`) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${THREE_BASE}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `img-src data: blob: ${origin}`,
    "media-src data: blob:",
    "connect-src 'none'",
  ].join("; ");
  return { html: wrapped, csp };
}
