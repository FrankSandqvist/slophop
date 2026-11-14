"use client";

import { useState } from "react";
import type { CodeSpot, Puzzle } from "@/lib/puzzles";
import { ANSWERS, QUESTIONS, aiAnswer, answerLabel, parseQuestionKey, type Tally } from "@/lib/review";

/**
 * The standardized judging card. The game decides WHEN (after the player has seen the thing);
 * the host decides WHAT is asked, so every puzzle produces comparable review data.
 */
export function JudgeCard(props: {
  puzzle: Puzzle;
  questionKey: string;
  step: string;
  outcome: string;
  brokePromise: boolean;
  spot: CodeSpot | null;
  onJudge: (answer: string) => Promise<Tally | null>;
  onDone: () => void;
}) {
  const { puzzle, questionKey, step, outcome, brokePromise, spot, onJudge, onDone } = props;
  const parsed = parseQuestionKey(questionKey)!;
  const options = ANSWERS[parsed.kind];
  const ai = aiAnswer(puzzle, questionKey);
  const [choice, setChoice] = useState<string | null>(null);
  const [tally, setTally] = useState<Tally | null>(null);
  const [saving, setSaving] = useState(false);

  async function judge(value: string) {
    setChoice(value);
    setSaving(true);
    setTally(await onJudge(value));
    setSaving(false);
  }

  const votes = tally ? Object.values(tally).reduce((sum, count) => sum + count, 0) : 0;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="judge-title">
      <div className="sheet judge">
        <p className="label">{step}</p>
        <Subject puzzle={puzzle} kind={parsed.kind} index={parsed.index} outcome={outcome} brokePromise={brokePromise} />
        {spot && (
          <details className="judge-code">
            <summary>The real change behind this</summary>
            <p>{spot.caption}</p>
            <pre className="peek-code">
              {spot.lines.map((line, index) => {
                const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
                return <span key={index} className={`peek-line peek-${kind}`}>{line}{"\n"}</span>;
              })}
            </pre>
          </details>
        )}

        <p className="label" id="judge-title">{QUESTIONS[parsed.kind]}</p>
        <div className="choices" role="group" aria-labelledby="judge-title">
          {options.map((option) => (
            <button
              key={option.value}
              className={`choice ${choice === option.value ? "choice-picked" : ""}`}
              onClick={() => judge(option.value)}
              disabled={choice !== null}
              aria-pressed={choice === option.value}
            >
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </button>
          ))}
        </div>

        {choice && !saving && (
          <div className="judge-after">
            {tally && votes > 0 && (
              <div className="crowd-mini" aria-label="How everyone answered">
                {options.map((option) => {
                  const pct = Math.round(((tally[option.value] ?? 0) / votes) * 100);
                  return (
                    <div key={option.value}>
                      <span>{option.label}</span>
                      <i style={{ width: `${pct}%` }} />
                      <b>{pct}%</b>
                    </div>
                  );
                })}
              </div>
            )}
            {ai && (
              <p className="ai-guess">
                The AI said <strong>{answerLabel(parsed.kind, ai.value)}</strong>: {ai.reason}
              </p>
            )}
            <button className="button button-primary" onClick={onDone} autoFocus>
              Continue <span className="button-arrow" aria-hidden>→</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Subject({ puzzle, kind, index, outcome, brokePromise }: { puzzle: Puzzle; kind: string; index: number; outcome: string; brokePromise: boolean }) {
  if (kind === "fix" && puzzle.solved) {
    return (
      <>
        <h2>{puzzle.solved.situation}</h2>
        <div className="before-after">
          <div><span>Before</span>{puzzle.solved.before}</div>
          <div><span>After</span>{puzzle.solved.after}</div>
        </div>
      </>
    );
  }
  if (kind === "tradeoff" && puzzle.tradeoffs?.[index]) {
    const entry = puzzle.tradeoffs[index];
    return (
      <>
        <h2>{entry.title}</h2>
        <div className="before-after">
          <div><span>We win</span>{entry.gain}</div>
          <div><span>We lose</span>{entry.cost}</div>
        </div>
      </>
    );
  }
  const entry = puzzle.cases?.[index];
  if (!entry) return null;
  return (
    <>
      <h2>
        {entry.title} <small className={`origin origin-${entry.origin}`}>{entry.origin === "introduced" ? "New with this change" : "Was already like this"}</small>
      </h2>
      <p className="briefing-text">{entry.scenario}</p>
      <p className={`result ${brokePromise ? "result-broken" : "result-kept"}`}>
        <strong>{brokePromise ? "Promise broken" : "Promise kept"}</strong> · {outcome || entry.outcome}
      </p>
    </>
  );
}
