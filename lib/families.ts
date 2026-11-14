import "server-only";
import type { PullRequestSource } from "./github";
import { roundTo, type MockShape, type NumericModel, type Round, type VisualModel, type VisualState } from "./types";

/**
 * The two puzzle families next to logic: NUMBERS (a calculation over one real input, sampled by running Python) and LOOKS
 * (a small mock screen before/after in a few situations, described as data and drawn by our own MockScreen).
 * Gemini only fills data; the rounds are built here by our code.
 */

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/** Fields every family shares (scene, rulebooks, intro lines, code anchor). `subject` names what the puzzle is about. */
export function commonProperties(subject: string, ruleStyle: string) {
  return {
    title: str("Puzzle title, 2-5 words, witty."),
    project: str("What the project is and who it affects, plain words, max 20 words."),
    change: str("What this PR changes, plain words, max 25 words."),
    where: str("Where this lives, as a player would see it: which app/tool and which screen, button or moment. Plain words, max 22 words."),
    scenario: str("Set the scene in second person: who you are, what you're doing, and the moment this matters. Plain, vivid, max 40 words."),
    rules: {
      type: "object",
      description: `Plain-language rulebooks a player can apply to work out EVERY case you give. ${ruleStyle}`,
      properties: {
        old: { type: "array", minItems: 1, maxItems: 4, items: str("One of Red's rules (BEFORE the change), max 16 words, plain."), description: "Red's rulebook." },
        new: { type: "array", minItems: 1, maxItems: 4, items: str("One of Green's rules (AFTER the change), max 16 words, plain."), description: "Green's rulebook." },
      },
      required: ["old", "new"],
    },
    component: {
      type: "object",
      properties: {
        name: str(`The small ${subject}, in plain words, max 5 words.`),
        what: str("What it does, plain words, max 20 words."),
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
    codeAnchor: str("A distinctive piece of ONE added or removed line of the chosen part in the DIFF, copied exactly (10-60 chars)."),
  };
}
const COMMON_REQUIRED = ["title", "project", "change", "where", "scenario", "rules", "component", "lines", "codeAnchor"];

export type CommonDesign = {
  title: string;
  project: string;
  change: string;
  where: string;
  scenario: string;
  rules: { old: string[]; new: string[] };
  component: { name: string; what: string; file: string };
  lines: { add: string; del: string };
  codeAnchor: string;
};

function prBlock(pr: PullRequestSource) {
  return `=== PULL REQUEST: ${pr.repository}#${pr.number}: ${pr.title}
DESCRIPTION:
${pr.body.slice(0, 1500) || "(none)"}
DIFF:
${pr.diff}
CODE AROUND THE CHANGES:
${pr.context || "(unavailable)"}`;
}

const PLAIN = "Write everything players see in plain language: no code, identifiers, symbols or jargon. Clear and witty for grown-ups; never childish.";

/* ---------- Numbers ---------- */

export const numericSchema = {
  type: "object",
  properties: {
    ...commonProperties("calculation", "Write them as simple arithmetic a player can do in their head, e.g. 'The fee is 3% of the amount, but never under 5 kr.'"),
    numeric: {
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            label: str("The one number that varies, plain name, max 4 words (e.g. 'Order total')."),
            unit: str("Its unit, short: '$', 'kr', 's', 'px', '%', 'items', or '' for none."),
            explain: str("What this number means in the scene, plain words, max 16 words."),
            min: num("Lowest value shown."),
            max: num("Highest value shown."),
            step: num("Step between sampled values; friendly (1, 5, 10, 0.5...)."),
          },
          required: ["label", "unit", "explain", "min", "max", "step"],
        },
        output: {
          type: "object",
          properties: {
            label: str("The result, plain name, max 4 words (e.g. 'Delivery fee')."),
            unit: str("Its unit, short, or ''."),
            explain: str("What the result means in the scene, plain words, max 16 words."),
            decimals: { type: "integer", description: "Decimals results are rounded to: 0, 1 or 2 (prefer 0)." },
          },
          required: ["label", "unit", "explain", "decimals"],
        },
        context: str("Everything else held fixed, plain words, max 16 words (e.g. 'Standard delivery, one parcel')."),
        points: {
          type: "array",
          description: "Every sampled input from min to max in steps of `step` (8-41 points), with Red's and Green's result computed by RUNNING your Python model.",
          items: {
            type: "object",
            properties: { x: num("Input value."), old: num("Red's result (before)."), new: num("Green's result (after).") },
            required: ["x", "old", "new"],
          },
        },
      },
      required: ["input", "output", "context", "points"],
    },
  },
  required: [...COMMON_REQUIRED, "numeric"],
};

export type NumericDesign = CommonDesign & { numeric: NumericModel };

export function numericPrompt(pr: PullRequestSource) {
  return `You design SlopHop puzzles. SlopHop shows curious people what is changing in the public software around them, as a tiny brain teaser.
Two characters star in every puzzle: GREEN is the code this pull request ADDED, RED is the code it REMOVED.

This puzzle is about NUMBERS: pick the one calculation this PR changes (a price, fee, total, discount, rounding, duration,
size, score...) and model it as ONE number that varies (the input) giving ONE calculated amount (the result), everything
else held fixed. The result must be a real quantity: never yes/no written as 1/0.

YOUR JOB
1. Use code execution: write two small Python functions, old(x) and new(x), that faithfully mirror the code BEFORE and AFTER this
   PR (quirks included; do not fix anything). If the calculation didn't exist before, old() returns what happened instead.
   Run them for every x from min to max in steps of step (8-41 points) and fill "points" from the printed results, rounded to
   "decimals". Be quick: write the code once, run it once, then answer. Only re-run if it errors.
2. Choose a range and step so the numbers are friendly (whole numbers where possible) and the change shows: include inputs where
   Red and Green agree AND where they differ, with the turning points inside the range.
3. Write the two rulebooks as simple arithmetic a player can do in their head with your numbers, complete enough to work out
   EVERY point. Check them against your points.
4. Set the scene: "where" and "scenario" (second person). Explain the input and the result in the scene.
5. ${PLAIN}

The game is generated from your points by our own code. Make them right.

${prBlock(pr)}`;
}

export function validateNumeric(design: NumericDesign): NumericModel {
  const model = design.numeric;
  if (!model?.input || !model.output) throw new Error("The number puzzle came back without its numbers.");
  const decimals = Math.max(0, Math.min(2, Math.round(Number(model.output.decimals) || 0)));
  const seen = new Set<number>();
  const points = (model.points ?? [])
    .map((point) => ({ x: Number(point?.x), old: Number(point?.old), new: Number(point?.new) }))
    .filter((point) => [point.x, point.old, point.new].every(Number.isFinite))
    .sort((a, b) => a.x - b.x)
    .filter((point) => (seen.has(point.x) ? false : (seen.add(point.x), true)))
    .slice(0, 61)
    .map((point) => ({ x: roundTo(point.x, 4), old: roundTo(point.old, decimals), new: roundTo(point.new, decimals) }));
  if (points.length < 6) throw new Error("The number puzzle needs more sampled points.");
  if (!points.some((point) => point.old !== point.new)) throw new Error("Red and Green never differ in the number puzzle.");
  // Yes/no dressed up as 1/0 is a logic puzzle, not a numbers one (the caller falls back to logic).
  if (points.every((point) => [point.old, point.new].every((value) => value === 0 || value === 1))) throw new Error("The number puzzle is really yes/no.");
  const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);
  return {
    input: {
      label: text(model.input.label, 40),
      unit: text(model.input.unit, 8),
      explain: text(model.input.explain, 120),
      min: points[0].x,
      max: points[points.length - 1].x,
      step: Number(model.input.step) > 0 ? Number(model.input.step) : points[1].x - points[0].x,
    },
    output: { label: text(model.output.label, 40), unit: text(model.output.unit, 8), explain: text(model.output.explain, 120), decimals },
    context: text(model.context, 120),
    points,
  };
}

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];
const shuffle = <T,>(items: T[]) => [...items].sort(() => Math.random() - 0.5);

/**
 * How many steps a number puzzle deserves: 2, plus one per point where Red and Green start or stop agreeing, plus one if
 * Green levels off at a limit (max 5). A single flat change doesn't need five questions.
 */
export function numericBudget(model: NumericModel) {
  const { points } = model;
  const flips = points.filter((point, index) => index > 0 && (point.old === point.new) !== (points[index - 1].old === points[index - 1].new)).length;
  const last = points[points.length - 1].new;
  const plateau = points.filter((point) => point.new === last).length >= 2 && points.some((point) => point.new !== last);
  return Math.max(2, Math.min(5, 2 + flips + (plateau ? 1 : 0)));
}

/** Key it in, find the split, how much more, reach a target, what did Red say. 2-5 steps (see numericBudget). */
export function buildNumericRounds(model: NumericModel): Round[] {
  const { points } = model;
  const limit = numericBudget(model);
  const differing = points.filter((point) => point.old !== point.new);
  const opener: Round[] = [];
  const first = pick(differing);
  opener.push({ kind: "num-predict", x: first.x, side: "new" });
  const split = points.findIndex((point) => point.old !== point.new);
  if (split > 0) opener.push({ kind: "num-split", answer: points[split].x });

  const middle: Round[] = [];
  const others = differing.filter((point) => point.x !== first.x);
  if (others.length) middle.push({ kind: "num-diff", x: pick(others).x });
  // Reach: Green never goes down, and some value is first reached inside the range (a cap, a step up...).
  const rising = points.every((point, index) => index === 0 || point.new >= points[index - 1].new);
  if (rising) {
    const steps = points.map((point, index) => index).filter((index) => index > 0 && points[index].new > points[index - 1].new && index < points.length - 1);
    const capIndex = points.findIndex((point) => point.new >= points[points.length - 1].new);
    const index = capIndex > 0 && capIndex < points.length - 1 ? capIndex : steps.length ? pick(steps) : -1;
    if (index > 0) middle.push({ kind: "num-reach", target: points[index].new, answer: points[index].x });
  }
  const forRed = differing.filter((point) => point.x !== first.x);
  if (forRed.length) middle.push({ kind: "num-predict", x: pick(forRed).x, side: "old" });
  const same = points.filter((point) => point.old === point.new);
  if (same.length) middle.push({ kind: "num-predict", x: pick(same).x, side: "new" });
  return [...opener, ...shuffle(middle)].slice(0, limit);
}

/* ---------- Looks ---------- */

/** Frame sizes in mock pixels: our pixel font is 3x5 (4px per letter, 6px per line). */
export const FRAMES = { wide: { w: 128, h: 80 }, phone: { w: 72, h: 128 } } as const;

const shapeSchema = {
  type: "object",
  properties: {
    id: str("Stable id for this element, the same in before and after (e.g. 'title', 'save-button')."),
    kind: { type: "string", enum: ["box", "text", "line"], description: "box = panel/button/image/bar; text = a short label; line = a divider (x,y to x+w,y+h)." },
    x: num("Left, in frame pixels."),
    y: num("Top, in frame pixels."),
    w: num("Width in frame pixels (text: ignored, computed)."),
    h: num("Height in frame pixels (text: 5)."),
    fill: str("Box fill as #rrggbb, or '' for none."),
    stroke: str("Box/line colour as #rrggbb, or ''."),
    text: str("Text only: max 24 characters; drawn UPPERCASE."),
    color: str("Text only: colour #rrggbb."),
  },
  required: ["id", "kind", "x", "y", "w", "h", "fill", "stroke", "text", "color"],
};

export const visualSchema = {
  type: "object",
  properties: {
    ...commonProperties("visual change", "Describe looks a player can picture, e.g. 'On a narrow screen, Save drops under the title.'"),
    visual: {
      type: "object",
      properties: {
        frame: { type: "string", enum: ["wide", "phone"], description: `wide = ${FRAMES.wide.w}x${FRAMES.wide.h} px (desktop/tablet), phone = ${FRAMES.phone.w}x${FRAMES.phone.h} px.` },
        // No minItems/maxItems on these nested arrays: Gemini rejects the schema with them (INVALID_ARGUMENT). Validation
        // enforces the limits instead.
        states: {
          type: "array",
          description: "3-4 situations where the look matters (e.g. a narrow screen, a very long name, an empty list, dark mode, an error). Each must show a visible difference between before and after.",
          items: {
            type: "object",
            properties: {
              id: str("Short lowercase slug."),
              label: str("The situation, plain words, max 4 words."),
              story: str("The situation as a short phrase in the scene, second person, max 10 words."),
              before: { type: "array", items: shapeSchema, description: "The screen BEFORE the change (Red), back to front, max 18 elements." },
              after: { type: "array", items: shapeSchema, description: "The same screen AFTER the change (Green), back to front, max 18 elements." },
            },
            required: ["id", "label", "story", "before", "after"],
          },
        },
      },
      required: ["frame", "states"],
    },
  },
  required: [...COMMON_REQUIRED, "visual"],
};

type ShapeDesign = MockShape & { kind: string };
export type VisualDesign = CommonDesign & {
  visual: { frame: keyof typeof FRAMES; states: Array<{ id: string; label: string; story: string; before: ShapeDesign[]; after: ShapeDesign[] }> };
};

export function visualPrompt(pr: PullRequestSource) {
  return `You design SlopHop puzzles. SlopHop shows curious people what is changing in the public software around them, as a tiny brain teaser.
Two characters star in every puzzle: GREEN is the code this pull request ADDED, RED is the code it REMOVED.

This puzzle is about HOW SOMETHING LOOKS: pick the one visual change this PR makes (layout, wrapping, sizes, spacing, colours,
what shows or hides, what overflows or gets cut off...) and draw it as a tiny mock screen, before and after, in 3-4 situations.

HOW THE MOCK SCREEN IS DRAWN (by our own code, in a chunky pixel style)
- Frame: "wide" is ${FRAMES.wide.w}x${FRAMES.wide.h} px, "phone" is ${FRAMES.phone.w}x${FRAMES.phone.h} px. Coordinates are whole pixels from the top left.
- "box": a filled rectangle (panel, button, card, image, bar), optional 1px outline. "line": a 1px line.
- "text": a 3x5 pixel font, UPPERCASE, 4 px per character and 5 px tall; keep labels short (max 24 chars) and place them inside
  their boxes with 2-3 px padding. Text that would not fit is exactly the kind of thing to show (cut off, wrapping, overlapping).
- Use the project's real colours where the diff shows them, otherwise plain sensible UI colours. Keep it simple: 4-14 elements.

YOUR JOB
1. Read the diff (CSS, markup, layout code) and work out faithfully how the screen looked BEFORE and looks AFTER in each
   situation. Mirror the real change; do not invent a different one. Give the same element the same id in before and after.
2. Choose 3-4 situations where the difference is visible (e.g. a narrow screen, a very long name, many items, dark mode).
3. Write the two rulebooks so a player can picture BOTH versions in every situation from the rules alone.
4. Set the scene: "where" and "scenario" (second person).
5. ${PLAIN}

${prBlock(pr)}`;
}

const HEX = /^#[0-9a-f]{6}$/i;

function cleanShapes(shapes: ShapeDesign[] | undefined, frame: { w: number; h: number }): MockShape[] {
  const kinds = ["box", "text", "line"];
  const clamp = (value: unknown, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number(value) || 0)));
  const seen = new Set<string>();
  return (shapes ?? [])
    .filter((shape) => kinds.includes(shape?.kind))
    .slice(0, 18)
    .map((shape, index) => {
      let id = String(shape.id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 30) || `el-${index}`;
      while (seen.has(id)) id += "-x";
      seen.add(id);
      const text = String(shape.text ?? "").toUpperCase().slice(0, 24);
      const kind = shape.kind as MockShape["kind"];
      const x = clamp(shape.x, -frame.w, frame.w * 2);
      const y = clamp(shape.y, -frame.h, frame.h * 2);
      return {
        id,
        kind,
        x,
        y,
        w: kind === "text" ? Math.max(0, text.length * 4 - 1) : clamp(shape.w, kind === "line" ? -frame.w : 1, frame.w * 2),
        h: kind === "text" ? 5 : clamp(shape.h, kind === "line" ? -frame.h : 1, frame.h * 2),
        ...(HEX.test(shape.fill ?? "") ? { fill: shape.fill } : {}),
        ...(HEX.test(shape.stroke ?? "") ? { stroke: shape.stroke } : {}),
        ...(kind === "text" ? { text, color: HEX.test(shape.color ?? "") ? shape.color : "#1b1a22" } : {}),
      };
    });
}

/** Ids of elements that look different between before and after (moved, resized, recoloured, added or removed). Computed, not trusted. */
function changedIds(before: MockShape[], after: MockShape[]) {
  const sign = (shape: MockShape) => JSON.stringify([shape.kind, shape.x, shape.y, shape.w, shape.h, shape.fill, shape.stroke, shape.text, shape.color]);
  const old = new Map(before.map((shape) => [shape.id, sign(shape)]));
  return after.filter((shape) => old.get(shape.id) !== sign(shape)).map((shape) => shape.id);
}

export function validateVisual(design: VisualDesign): VisualModel {
  const frame = FRAMES[design.visual?.frame] ?? FRAMES.wide;
  const states: VisualState[] = (design.visual?.states ?? []).slice(0, 4).map((state, index) => {
    const before = cleanShapes(state.before, frame);
    const after = cleanShapes(state.after, frame);
    return {
      id: String(state.id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 30) || `state-${index}`,
      label: String(state.label ?? "").slice(0, 40),
      story: String(state.story ?? "").slice(0, 90),
      before,
      after,
      changed: changedIds(before, after),
    };
  });
  // A situation where only removed elements differ has nothing to tap in Green's picture; it can't be a step.
  const usable = states.filter((state) => state.changed.length && state.before.length && state.after.length);
  if (usable.length < 2) throw new Error("The looks puzzle needs at least two situations with a visible change.");
  return { frame: { ...frame }, states: usable };
}

/**
 * One step per situation (seeing both pictures gives the next answer away): pick Green's picture, or tap what changed.
 * Situations whose change is the same elements as an earlier one are skipped: same lesson, no new step.
 */
export function buildVisualRounds(model: VisualModel): Round[] {
  const seen = new Set<string>();
  const distinct = model.states.filter((state) => {
    const signature = [...state.changed].sort().join("|");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  const states = distinct.length >= 2 ? distinct : model.states.slice(0, 2);
  return states.slice(0, 4).map((state, index): Round =>
    index % 2 === 0 ? { kind: "vis-which", state: state.id, greenFirst: Math.random() < 0.5 } : { kind: "vis-spot", state: state.id },
  );
}
