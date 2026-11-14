import type { Puzzle, VerdictTally } from "./puzzles";

/**
 * The standardized outcome of every puzzle: judgments that add up to a merge-confidence review.
 * Safe to import from both client and server code.
 *
 * Question keys: "fix", "tradeoff-<i>", "case-<i>".
 */

export type QuestionKind = "fix" | "tradeoff" | "case";
export type AnswerOption = { value: string; label: string; hint: string };
export type Tally = Record<string, number>;

export const ANSWERS: Record<QuestionKind, AnswerOption[]> = {
  fix: [
    { value: "works", label: "Yes, fixed", hint: "Now it works the way it should" },
    { value: "partly", label: "Partly", hint: "Better, but not all the way" },
    { value: "no", label: "Not fixed", hint: "It still goes wrong" },
  ],
  tradeoff: [
    { value: "worth", label: "Worth it", hint: "What we win beats what we lose" },
    { value: "unsure", label: "Not sure", hint: "Depends on who's using it" },
    { value: "not", label: "Not worth it", hint: "What we lose matters more" },
  ],
  case: [
    { value: "likely", label: "Likely", hint: "People would run into this" },
    { value: "rare", label: "Rare", hint: "Only in an odd situation" },
    { value: "never", label: "Can't happen", hint: "Something else stops it first" },
  ],
};

export const QUESTIONS: Record<QuestionKind, string> = {
  fix: "Did the change fix it?",
  tradeoff: "Is this give-and-take worth it?",
  case: "Could this happen for real?",
};

export function questionKey(kind: QuestionKind, index = 0) {
  return kind === "fix" ? "fix" : `${kind}-${index}`;
}

export function parseQuestionKey(key: string): { kind: QuestionKind; index: number } | null {
  if (key === "fix") return { kind: "fix", index: 0 };
  const match = key.match(/^(tradeoff|case)-(\d)$/);
  return match ? { kind: match[1] as QuestionKind, index: Number(match[2]) } : null;
}

/** Whether a question exists on this puzzle. */
export function hasQuestion(puzzle: Puzzle, key: string) {
  const parsed = parseQuestionKey(key);
  if (!parsed) return false;
  if (parsed.kind === "fix") return Boolean(puzzle.solved);
  if (parsed.kind === "tradeoff") return Boolean(puzzle.tradeoffs?.[parsed.index]);
  return Boolean(puzzle.cases?.[parsed.index]);
}

export function answerLabel(kind: QuestionKind, value: string | undefined) {
  return ANSWERS[kind].find((option) => option.value === value)?.label ?? value ?? "";
}

/** The AI's own answer to a question, revealed after the player answers. */
export function aiAnswer(puzzle: Puzzle, key: string): { value: string; reason: string } | null {
  const parsed = parseQuestionKey(key);
  if (!parsed) return null;
  if (parsed.kind === "fix" && puzzle.solved) return { value: puzzle.solved.aiView, reason: puzzle.solved.aiReason };
  if (parsed.kind === "tradeoff") {
    const entry = puzzle.tradeoffs?.[parsed.index];
    return entry ? { value: entry.aiView, reason: entry.aiReason } : null;
  }
  const entry = puzzle.cases?.[parsed.index];
  return entry ? { value: entry.aiLikelihood, reason: entry.aiReason } : null;
}

function share(tally: Tally | undefined, ...values: string[]) {
  const total = Object.values(tally ?? {}).reduce((sum, count) => sum + count, 0);
  if (!total) return { total: 0, pct: 0 };
  return { total, pct: Math.round((values.reduce((sum, value) => sum + (tally?.[value] ?? 0), 0) / total) * 100) };
}

export type Tone = "good" | "warn" | "bad" | "none";
export type Finding = { label: string; detail: string; tone: Tone };
export type Signal = { level: "safe" | "caution" | "risky" | "unknown"; text: string };

const MIN_VOTES = 3;

export function buildReport(puzzle: Puzzle, judgments: Record<string, Tally>, verdicts: VerdictTally, breaks: string[]) {
  const findings: Finding[] = [];

  if (puzzle.solved) {
    const fixed = share(judgments.fix, "works");
    const tone: Tone = fixed.total < MIN_VOTES ? "none" : fixed.pct >= 70 ? "good" : fixed.pct >= 40 ? "warn" : "bad";
    findings.push({
      label: "The fix",
      detail: fixed.total ? `${fixed.pct}% say it's fixed (${fixed.total} votes) · AI: ${answerLabel("fix", puzzle.solved.aiView)}` : "No votes yet",
      tone,
    });
  }

  (puzzle.tradeoffs ?? []).forEach((entry, index) => {
    const worth = share(judgments[questionKey("tradeoff", index)], "worth");
    const tone: Tone = worth.total < MIN_VOTES ? "none" : worth.pct >= 60 ? "good" : worth.pct >= 35 ? "warn" : "bad";
    findings.push({
      label: `Tradeoff: ${entry.title}`,
      detail: worth.total ? `${worth.pct}% say worth it (${worth.total} votes) · AI: ${answerLabel("tradeoff", entry.aiView)}` : "No votes yet",
      tone,
    });
  });

  (puzzle.cases ?? []).forEach((entry, index) => {
    const tally = judgments[questionKey("case", index)];
    const likely = share(tally, "likely");
    const plausible = share(tally, "likely", "rare");
    const origin = entry.origin === "introduced" ? "new" : "existing";
    let tone: Tone = "good";
    let detail = `Promise holds here · ${origin}`;
    if (entry.brokePromise) {
      tone = likely.total < MIN_VOTES ? "none" : likely.pct >= 50 ? "bad" : plausible.pct >= 50 ? "warn" : "good";
      detail = likely.total
        ? `Promise breaks · ${origin} · ${likely.pct}% likely, ${plausible.pct - likely.pct}% rare (${likely.total} votes) · AI: ${answerLabel("case", entry.aiLikelihood)}`
        : `Promise breaks · ${origin} · no votes yet`;
    }
    findings.push({ label: `Edge case: ${entry.title}`, detail, tone });
  });

  const hunts = verdicts.holds + verdicts.breaks;
  const breakPct = hunts ? Math.round((verdicts.breaks / hunts) * 100) : 0;
  findings.push({
    label: "Free hunt",
    detail: hunts ? `${verdicts.breaks} of ${hunts} players found a way to break it` : "Nobody has hunted yet",
    tone: hunts < MIN_VOTES ? "none" : breakPct >= 40 ? "bad" : breakPct >= 15 ? "warn" : "good",
  });

  const fixVotes = share(judgments.fix).total;
  const tones = findings.map((finding) => finding.tone);
  const signal: Signal =
    fixVotes < MIN_VOTES
      ? { level: "unknown", text: "Not enough votes yet" }
      : tones.includes("bad")
        ? { level: "risky", text: "Risky: players found real problems" }
        : tones.includes("warn")
          ? { level: "caution", text: "Take a closer look before merging" }
          : { level: "safe", text: "Looks safe to merge" };

  const icon: Record<Tone, string> = { good: "✅", warn: "⚠️", bad: "❌", none: "·" };
  const markdown = [
    `### SlopHop crowd review: ${puzzle.title}`,
    `**${signal.text}** (${fixVotes} player${fixVotes === 1 ? "" : "s"})`,
    "",
    ...findings.map((finding) => `- ${icon[finding.tone]} **${finding.label}**: ${finding.detail}`),
    ...(breaks.length ? ["", "Breaking cases reported by players:", ...breaks.map((evidence) => `> ${evidence.replace(/\n/g, " ")}`)] : []),
    "",
    `_From human players' judgments of an interactive model of this change. Promise tested: "${puzzle.promise ?? ""}"._`,
  ].join("\n");

  return { signal, findings, markdown };
}
