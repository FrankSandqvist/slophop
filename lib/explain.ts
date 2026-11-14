import "server-only";
import { MODELS, generateJson } from "./gemini";
import { formatNumber, outcome, pointAt, voteRow, type Explainer, type Puzzle, type PuzzleRow, type Round } from "./types";

/**
 * Case explainers: after each step, Red and Green say why they did what they did in that exact case, plus a takeaway.
 * One fast Gemini call per puzzle, from a precise description of every step's case (values, results, neighbours).
 */

type Explainable = Pick<Puzzle, "family" | "project" | "change" | "scenario" | "rules" | "inputs" | "outcomes" | "table" | "numeric" | "visual" | "rounds">;

function rowText(puzzle: Explainable, row: PuzzleRow | undefined) {
  if (!row) return "(unknown case)";
  const values = row.values
    .map((valueId, index) => {
      const input = puzzle.inputs[index];
      return `${input?.label}: ${input?.values.find((value) => value.id === valueId)?.label ?? valueId}`;
    })
    .join(", ");
  const said = (id: string) => outcome(puzzle as Puzzle, id)?.label ?? id;
  return `${values} → Red (before): "${said(row.old)}"; Green (after): "${said(row.new)}"`;
}

/** What the step asked and the exact case(s) it's about, in plain words for the explainer writer. */
function describe(puzzle: Explainable, round: Round): string {
  const byKey = (key: string | null | undefined) => puzzle.table.find((row) => row.key === key);
  const model = puzzle.numeric;
  const num = (x: number) => {
    if (!model) return "";
    const point = pointAt(model, x);
    const out = (value: number | undefined) => (value === undefined ? "?" : formatNumber(value, model.output.unit, model.output.decimals));
    return `${model.input.label} ${formatNumber(x, model.input.unit)} → Red: ${out(point?.old)}, Green: ${out(point?.new)}`;
  };
  const neighbour = (x: number, offset: number) => {
    const index = (model?.points.findIndex((point) => point.x === x) ?? -1) + offset;
    const point = model?.points[index];
    return point ? num(point.x) : "";
  };
  switch (round.kind) {
    case "predict":
      return `Asked what ${round.side === "new" ? "Green" : "Red"} does in this case. ${rowText(puzzle, byKey(round.row))}`;
    case "who":
      return `Shown one result and asked whose rules gave it (it was ${round.shown === "new" ? "Green's" : "Red's"}). ${rowText(puzzle, byKey(round.row))}`;
    case "tweak":
      return `Asked which ONE change to the starting case makes ${round.goal === "disagree" ? "Red and Green disagree" : `Green end at "${outcome(puzzle as Puzzle, round.target ?? "")?.label}"`}. Starting case: ${rowText(puzzle, byKey(round.base))}. The right change gives: ${rowText(puzzle, byKey(round.answer))}`;
    case "pattern":
      return `Shown solved neighbouring cases, asked what Green does in a new one. ${rowText(puzzle, byKey(round.row))}`;
    case "edge": {
      const before = byKey(round.rows[round.flip - 1]);
      const after = byKey(round.rows[round.flip]);
      return `Asked where Green changes its mind along "${puzzle.inputs[round.input]?.label}". Just before: ${rowText(puzzle, before)}. Just after: ${rowText(puzzle, after)}`;
    }
    case "odd":
      return `Odd one out: three cases end the same with Green, one doesn't. The odd one: ${rowText(puzzle, byKey(round.odd))}`;
    case "rule":
      return `Finish Green's rule: when ${puzzle.inputs[round.input]?.label} is (${round.answers.map((id) => puzzle.inputs[round.input]?.values.find((value) => value.id === id)?.label).join(" or ")}), Green always ends at "${outcome(puzzle as Puzzle, round.outcome)?.label}". Example: ${rowText(puzzle, voteRow(puzzle as Puzzle, round))}`;
    case "pivot":
      return `Asked which one condition decides Green's result here (it's "${puzzle.inputs[round.input]?.label}"). ${rowText(puzzle, byKey(round.row))}`;
    case "claim":
      return `Red claimed: when ${puzzle.inputs[round.input]?.label} is ${puzzle.inputs[round.input]?.values.find((value) => value.id === round.value)?.label}, Green always ends at "${outcome(puzzle as Puzzle, round.outcome)?.label}". That's ${round.truth ? "TRUE" : "FALSE"}.${round.counter ? ` Counterexample: ${rowText(puzzle, byKey(round.counter))}` : ""}`;
    case "num-predict":
      return `Asked to work out ${round.side === "new" ? "Green's" : "Red's"} ${model?.output.label}. ${num(round.x)}`;
    case "num-diff":
      return `Asked how much more Green gives than Red. ${num(round.x)}`;
    case "num-split":
      return `Asked for the first ${model?.input.label} where Green differs from Red. Just before: ${neighbour(round.answer, -1)}. At the answer: ${num(round.answer)}`;
    case "num-reach":
      return `Asked for the smallest ${model?.input.label} where Green's ${model?.output.label} reaches ${formatNumber(round.target, model?.output.unit ?? "", model?.output.decimals)}. Just before: ${neighbour(round.answer, -1)}. At the answer: ${num(round.answer)}`;
    case "vis-which":
    case "vis-spot": {
      const state = puzzle.visual?.states.find((entry) => entry.id === round.state);
      const texts = (shapes: NonNullable<typeof state>["after"]) => shapes.filter((shape) => shape.text).map((shape) => shape.text).join(" / ");
      const changed = state?.after.filter((shape) => state.changed.includes(shape.id)).map((shape) => (shape.text ? `${shape.id} ("${shape.text}")` : shape.id)).join(", ");
      return `${round.kind === "vis-which" ? "Shown both pictures, asked which is Green's" : "Shown Green's picture, asked to tap what changed"}. Situation: ${state?.label} (${state?.story}). Red's screen text: ${texts(state?.before ?? [])}. Green's screen text: ${texts(state?.after ?? [])}. Elements that look different in Green's: ${changed}`;
    }
  }
}

const schema = {
  type: "object",
  properties: {
    explainers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "integer", description: "Step number, starting at 1." },
          red: { type: "string", description: "RED in first person: what he did in THIS exact case and which of his old rules made him do it. Specific (use the case's values), plain words, max 28 words." },
          green: { type: "string", description: "GREEN in first person: what he does in THIS exact case and which of his new rules makes him do it. Specific, plain words, max 28 words." },
          why: { type: "string", description: "The takeaway: what this case shows about the change, one plain sentence, max 25 words." },
        },
        required: ["step", "red", "green", "why"],
      },
    },
  },
  required: ["explainers"],
};

/** One explainer per round (same order). Rounds the model skips get a plain, data-only explainer instead. */
export async function explainRounds(puzzle: Explainable, signal?: AbortSignal): Promise<Explainer[]> {
  const steps = puzzle.rounds.map((round, index) => `STEP ${index + 1}: ${describe(puzzle, round)}`).join("\n");
  const { data } = await generateJson<{ explainers: Array<Explainer & { step: number }> }>({
    model: MODELS.backup,
    thinking: "low",
    schema,
    signal,
    prompt: `SlopHop turns real code changes into small puzzles. GREEN is the code the change ADDED (how it works now); RED is the code
it REMOVED (how it worked before). After each puzzle step, Red and Green explain that exact case to the player.

For every step below, write Red's line, Green's line and the takeaway. Be really specific to that case: use its values and
numbers, and say which rule (in plain words, not code) made each of them do what they did. If they agree, say so and why.
Plain language, no code or jargon, clear and a little witty, never childish. Don't repeat the question.

THE CHANGE: ${puzzle.change}
SCENE: ${puzzle.scenario ?? ""}
RED'S RULES (before): ${(puzzle.rules?.old ?? []).join(" | ")}
GREEN'S RULES (after): ${(puzzle.rules?.new ?? []).join(" | ")}

${steps}`,
  });
  const clip = (text: unknown, max: number) => String(text ?? "").trim().slice(0, max);
  return puzzle.rounds.map((_, index) => {
    const found = data.explainers?.find((entry) => Number(entry.step) === index + 1);
    return found && found.red && found.green
      ? { red: clip(found.red, 220), green: clip(found.green, 220), why: clip(found.why, 200) }
      : { red: "", green: "", why: "" };
  });
}
