"use client";

import { useEffect, useRef, useState } from "react";
import { drawMascot, MASCOT_H, MASCOT_W, type MascotKind } from "@/lib/mascot";
import { sfx } from "@/lib/sound";
import { changedInput, formatNumber, outcome, type Puzzle, type PuzzleRow } from "@/lib/types";

/*
 * Every puzzle step is ONE decision that fits the bottom screen. Info screens (rules, intro, end) may scroll.
 */

/* ---------- Showing cases ---------- */

/** One case: each condition and its value. */
export function CaseChips({ puzzle, row, changed }: { puzzle: Puzzle; row: PuzzleRow; changed?: number }) {
  return (
    <span className="chips">
      {puzzle.inputs.map((input, index) => (
        <span key={input.id} className={`chip ${index === changed ? "chip-changed" : ""}`}>
          <small>{input.label}:</small> {input.values.find((value) => value.id === row.values[index])?.label}
        </span>
      ))}
    </span>
  );
}

/** Several cases as a compact table: one column per condition, plus an optional last column. */
export function CaseTable({
  puzzle,
  rows,
  last,
  lastLabel,
  onPick,
  rowClass,
}: {
  puzzle: Puzzle;
  rows: PuzzleRow[];
  last?: (row: PuzzleRow) => React.ReactNode;
  lastLabel?: string;
  onPick?: (row: PuzzleRow) => void;
  rowClass?: (row: PuzzleRow) => string;
}) {
  return (
    <table className="case-table">
      <thead>
        <tr>
          {puzzle.inputs.map((input) => (
            <th key={input.id}>{input.label}</th>
          ))}
          {last && <th>{lastLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            className={`${onPick ? "row-pick" : ""} ${rowClass?.(row) ?? ""}`}
            onClick={onPick ? () => onPick(row) : undefined}
            tabIndex={onPick ? 0 : undefined}
            onKeyDown={onPick ? (event) => (event.key === "Enter" || event.key === " ") && onPick(row) : undefined}
          >
            {row.values.map((value, index) => (
              <td key={index}>{puzzle.inputs[index].values.find((entry) => entry.id === value)?.label}</td>
            ))}
            {last && <td className="case-last">{last(row)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What Red (before) and Green (after) do for a case. */
export function Outcomes({ puzzle, row }: { puzzle: Puzzle; row: PuzzleRow | undefined }) {
  return (
    <div className="outcomes">
      <div className="outcome outcome-del">
        <span className="outcome-who">RED · before</span>
        <span className="outcome-text">{row ? outcome(puzzle, row.old)?.label : "?"}</span>
      </div>
      <div className="outcome outcome-add">
        <span className="outcome-who">GREEN · now</span>
        <span className="outcome-text">{row ? outcome(puzzle, row.new)?.label : "?"}</span>
      </div>
      {row && row.old !== row.new && <span className="outcome-split">CHANGED</span>}
    </div>
  );
}

/** Pick an outcome. After picking, the right one is marked. */
export function OutcomeCards({ puzzle, onPick, picked, answer }: { puzzle: Puzzle; onPick: (id: string) => void; picked: string | null; answer?: string }) {
  return (
    <div className="cards">
      {puzzle.outcomes.map((entry) => (
        <button
          key={entry.id}
          className={`card-pick ${picked ? (entry.id === answer ? "card-right" : entry.id === picked ? "card-wrong" : "") : ""}`}
          disabled={picked !== null}
          onClick={() => {
            sfx.select();
            onPick(entry.id);
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Who did it? (just the heads, so it fits) ---------- */

const HEAD_TOP = MASCOT_H - 137 - 19;

export function MascotHead({ kind }: { kind: MascotKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = ref.current?.getContext("2d");
    if (!context) return;
    let frame = 0;
    const start = performance.now();
    const loop = () => {
      drawMascot(context, kind, (performance.now() - start) / 1000, "idle");
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [kind]);
  return (
    <span className="head-crop">
      <canvas ref={ref} className="mascot" width={MASCOT_W} height={MASCOT_H} style={{ width: MASCOT_W * 2, height: MASCOT_H * 2, marginTop: -(HEAD_TOP - 2) * 2 }} />
    </span>
  );
}

export function WhoPick({ onPick, picked, answer }: { onPick: (who: MascotKind) => void; picked: MascotKind | null; answer: MascotKind }) {
  return (
    <div className="who">
      {(["del", "add"] as const).map((kind) => (
        <button
          key={kind}
          className={`who-pick who-${kind} ${picked ? (kind === answer ? "card-right" : kind === picked ? "card-wrong" : "") : ""}`}
          disabled={picked !== null}
          onClick={() => {
            sfx.select();
            onPick(kind);
          }}
          aria-label={kind === "add" ? "Green, the new code" : "Red, the old code"}
        >
          <MascotHead kind={kind} />
          <span>{kind === "add" ? "GREEN (new)" : "RED (old)"}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Step types ---------- */

/** One tweak: which single "what if…" makes Red and Green disagree (or Green reach a target)? */
export function TweakPick({
  puzzle,
  base,
  goal,
  options,
  answer,
  picked,
  onPick,
}: {
  puzzle: Puzzle;
  base: PuzzleRow;
  goal: "disagree" | "outcome";
  options: PuzzleRow[];
  answer: string;
  picked: string | null;
  onPick: (key: string) => void;
}) {
  const describe = (row: PuzzleRow) => {
    const index = changedInput(base, row);
    const value = puzzle.inputs[index]?.values.find((entry) => entry.id === row.values[index]);
    return value?.story ? `What if ${value.story}?` : `What if ${puzzle.inputs[index]?.label.toLowerCase()} is ${value?.label}?`;
  };
  const chosen = options.find((row) => row.key === picked);
  const now = outcome(puzzle, base.new)?.label;
  return (
    <div className="step">
      <div className="case case-base">
        <CaseChips puzzle={puzzle} row={chosen ?? base} changed={chosen ? changedInput(base, chosen) : undefined} />
        {!chosen && (
          <span className="case-note">
            {goal === "disagree" ? "Right now Red and Green both: " : "Right now Green: "}
            <span className="case-now">{now}</span>
          </span>
        )}
      </div>
      {chosen ? (
        <Outcomes puzzle={puzzle} row={chosen} />
      ) : (
        <div className="cards cards-1 cards-tight">
          {options.map((row) => (
            <button
              key={row.key}
              className={`card-pick ${picked ? (row.key === answer ? "card-right" : row.key === picked ? "card-wrong" : "") : ""}`}
              onClick={() => {
                sfx.select();
                onPick(row.key);
              }}
            >
              {describe(row)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Spot the pattern: solved examples, then a mystery case. */
export function PatternPick({ puzzle, examples, row, picked, onPick }: { puzzle: Puzzle; examples: PuzzleRow[]; row: PuzzleRow; picked: string | null; onPick: (id: string) => void }) {
  // If even the dense layout doesn't fit, one example may be hidden: never the last one that ends differently.
  const spare =
    examples.length > 2 ? examples.find((example) => examples.some((other) => other !== example && other.new !== row.new)) : undefined;
  return (
    <div className="step">
      <CaseTable
        puzzle={puzzle}
        rows={[...examples, row]}
        lastLabel="Green does"
        last={(entry) => (entry.key === row.key && !picked ? <span className="mystery">?</span> : outcome(puzzle, entry.new)?.label)}
        rowClass={(entry) => (entry.key === row.key ? "row-mystery" : entry === spare ? "can-hide" : "")}
      />
      {!picked && <OutcomeCards puzzle={puzzle} picked={picked} answer={row.new} onPick={onPick} />}
    </div>
  );
}

/** Find the tipping point: along an ordered condition, where does Green change its mind? */
export function EdgePick({ puzzle, input, rows, flip, picked, onPick }: { puzzle: Puzzle; input: number; rows: PuzzleRow[]; flip: number; picked: number | null; onPick: (gap: number) => void }) {
  const condition = puzzle.inputs[input];
  const fixed = rows[0];
  return (
    <div className="step">
      <span className="chips">
        {puzzle.inputs.map((other, index) =>
          index === input ? null : (
            <span key={other.id} className="chip">
              <small>{other.label}:</small> {other.values.find((value) => value.id === fixed.values[index])?.label}
            </span>
          ),
        )}
      </span>
      <div className="stones" style={{ gridTemplateColumns: `repeat(${rows.length * 2 - 1}, auto)` }}>
        {rows.map((row, index) => (
          <FragmentStone key={row.key}>
            {index > 0 && (
              <button
                className={`gap ${picked !== null ? (index === flip ? "card-right" : index === picked ? "card-wrong" : "") : ""}`}
                disabled={picked !== null}
                onClick={() => {
                  sfx.select();
                  onPick(index);
                }}
                aria-label={`Between ${condition.values[index - 1]?.label} and ${condition.values[index]?.label}`}
              >
                ▼
              </button>
            )}
            <span className={`stone ${picked !== null && index >= flip ? "stone-after" : ""}`}>
              <strong>{condition.values[index]?.label}</strong>
              {picked !== null && <small>{outcome(puzzle, row.new)?.label}</small>}
            </span>
          </FragmentStone>
        ))}
      </div>
      <p className="hint">{condition.label}: low → high. Tap the ▼ where Green switches.</p>
    </div>
  );
}

function FragmentStone({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Odd one out: three cases end the same way with Green, one doesn't. */
export function OddOneOut({ puzzle, rows, odd, picked, onPick }: { puzzle: Puzzle; rows: PuzzleRow[]; odd: string; picked: string | null; onPick: (key: string) => void }) {
  const oddRow = rows.find((row) => row.key === odd);
  const other = rows.find((row) => row.key !== odd);
  return (
    <div className="step">
      <CaseTable
        puzzle={puzzle}
        rows={rows}
        onPick={picked ? undefined : (row) => {
          sfx.select();
          onPick(row.key);
        }}
        rowClass={(row) => (picked ? (row.key === odd ? "row-right" : row.key === picked ? "row-wrong" : "") : "")}
      />
      {picked && oddRow && other && (
        <p className="hint can-hide">
          Odd one: Green does “{outcome(puzzle, oddRow.new)?.label}”. The others: “{outcome(puzzle, other.new)?.label}”.
        </p>
      )}
    </div>
  );
}

/** Finish Green's rule: pick the value that makes it always true. */
export function RuleFill({ puzzle, input, outcomeId, answers, picked, onPick }: { puzzle: Puzzle; input: number; outcomeId: string; answers: string[]; picked: string | null; onPick: (value: string) => void }) {
  const condition = puzzle.inputs[input];
  return (
    <div className="step">
      <p className="claim-text">
        “When {condition.label.toLowerCase()} is <span className="blank">{picked ? condition.values.find((value) => value.id === picked)?.label : "____"}</span>, I always end at {outcome(puzzle, outcomeId)?.label}.”
      </p>
      <div className="cards">
        {condition.values.map((value) => (
          <button
            key={value.id}
            className={`card-pick ${picked ? (answers.includes(value.id) ? "card-right" : value.id === picked ? "card-wrong" : "") : ""}`}
            disabled={picked !== null}
            onClick={() => {
              sfx.select();
              onPick(value.id);
            }}
          >
            {value.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Which condition decides Green's outcome in this case? */
export function PivotPick({ puzzle, row, answer, picked, onPick }: { puzzle: Puzzle; row: PuzzleRow; answer: number; picked: number | null; onPick: (input: number) => void }) {
  const flip = puzzle.table.find(
    (other) => other.key !== row.key && other.new !== row.new && other.values.every((value, index) => index === answer || value === row.values[index]),
  );
  const decisive = puzzle.inputs[answer];
  return (
    <div className="step">
      <div className="case case-base">
        <CaseChips puzzle={puzzle} row={row} />
        <span className="case-note">Green: {outcome(puzzle, row.new)?.label}</span>
      </div>
      <div className="cards">
        {puzzle.inputs.map((input, index) => (
          <button
            key={input.id}
            className={`card-pick ${picked !== null ? (index === answer ? "card-right" : index === picked ? "card-wrong" : "") : ""}`}
            disabled={picked !== null}
            onClick={() => {
              sfx.select();
              onPick(index);
            }}
          >
            {input.label}
          </button>
        ))}
      </div>
      {picked !== null && flip && (
        <p className="hint">
          Change it to “{decisive.values.find((value) => value.id === flip.values[answer])?.label}” and Green does: {outcome(puzzle, flip.new)?.label}
        </p>
      )}
    </div>
  );
}

/** True or false: Red makes a claim about how Green behaves. */
export function ClaimCard({ statement, answered, truth, onAnswer }: { statement: string; answered: boolean | null; truth: boolean; onAnswer: (value: boolean) => void }) {
  return (
    <div className="step">
      <p className="claim-text">“{statement}”</p>
      <div className="cards">
        {[true, false].map((value) => (
          <button
            key={String(value)}
            className={`card-pick ${answered !== null ? (value === truth ? "card-right" : value === answered ? "card-wrong" : "") : ""}`}
            disabled={answered !== null}
            onClick={() => {
              sfx.select();
              onAnswer(value);
            }}
          >
            {value ? "True" : "False"}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Info sheets (these may scroll) ---------- */

const normalise = (line: string) => line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * One mascot saying their rulebook in a speech bubble: Red his old rules (head on the left), Green his new ones (head on
 * the right). Lines the other doesn't have are tagged GONE (Red) / NEW (Green); shared lines are dimmed.
 */
export function RuleBubble({ rules, side }: { rules: { old: string[]; new: string[] }; side: "old" | "new" }) {
  const kind: MascotKind = side === "new" ? "add" : "del";
  const other = new Set(rules[side === "new" ? "old" : "new"].map(normalise));
  const bubble = (
    <div className={`bubble bubble-${kind}`}>
      <span className="bubble-who">{side === "new" ? "GREEN · how I do it now" : "RED · how I did it"}</span>
      <ul>
        {rules[side].map((line) => {
          const same = other.has(normalise(line));
          return (
            <li key={line} className={same ? "rule-same" : "rule-changed"}>
              {!same && <em className={`rule-tag ${side === "new" ? "rule-new" : "rule-gone"}`}>{side === "new" ? "NEW" : "GONE"}</em>} {line}
            </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <div className={`speaker speaker-${kind}`}>
      {side === "old" && <MascotHead kind="del" />}
      {bubble}
      {side === "new" && <MascotHead kind="add" />}
    </div>
  );
}

/** The two talking: Red says his old rules, Green his new ones. */
function RuleBubbles({ rules }: { rules: { old: string[]; new: string[] } }) {
  return (
    <div className="rulebooks">
      <RuleBubble rules={rules} side="old" />
      <RuleBubble rules={rules} side="new" />
    </div>
  );
}

/** Red's and Green's rulebooks, plus every condition and outcome explained. */
export function RulesSheet({ puzzle, onClose }: { puzzle: Puzzle; onClose?: () => void }) {
  return (
    <div className={onClose ? "sheet-overlay" : "sheet-inline"} role={onClose ? "dialog" : undefined} aria-label="Rules">
      {onClose && (
        <div className="sheet-head">
          <strong>Rules</strong>
          <button className="px-btn px-btn-icon" onClick={onClose} aria-label="Close">×</button>
        </div>
      )}
      {puzzle.rules && <RuleBubbles rules={puzzle.rules} />}
      {puzzle.where && <p><span className="tag">WHERE</span> {puzzle.where}</p>}
      {puzzle.scenario && <p><span className="tag">SCENE</span> {puzzle.scenario}</p>}
      <dl className="glossary">
        {puzzle.numeric && (
          <>
            <div>
              <dt>{puzzle.numeric.input.label}</dt>
              <dd>
                {puzzle.numeric.input.explain}{" "}
                <small>
                  ({formatNumber(puzzle.numeric.input.min, puzzle.numeric.input.unit)} to {formatNumber(puzzle.numeric.input.max, puzzle.numeric.input.unit)})
                </small>
              </dd>
            </div>
            <div>
              <dt>{puzzle.numeric.output.label}</dt>
              <dd>{puzzle.numeric.output.explain}</dd>
            </div>
            {puzzle.numeric.context && (
              <div>
                <dt>Fixed</dt>
                <dd>{puzzle.numeric.context}</dd>
              </div>
            )}
          </>
        )}
        {puzzle.visual?.states.map((state) => (
          <div key={state.id}>
            <dt>{state.label}</dt>
            <dd>{state.story}</dd>
          </div>
        ))}
        {puzzle.inputs.map((input) => (
          <div key={input.id}>
            <dt>{input.label}</dt>
            <dd>
              {input.explain && <span>{input.explain} </span>}
              <small>({input.values.map((value) => value.label).join(" · ")})</small>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ---------- Crowd + code ---------- */

/** The crowd signal, in one line: for this exact case, does Green's behaviour seem right? */
export function Vote({ puzzleId, row, initial }: { puzzleId: string; row: PuzzleRow; initial?: { right: number; off: number } }) {
  const [tally, setTally] = useState<{ right: number; off: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function vote(choice: "right" | "off") {
    if (busy || tally) return;
    sfx.select();
    setBusy(true);
    const fallback = { right: (initial?.right ?? 0) + (choice === "right" ? 1 : 0), off: (initial?.off ?? 0) + (choice === "off" ? 1 : 0) };
    try {
      const response = await fetch(`/api/puzzles/${puzzleId}/votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row: row.key, vote: choice }),
      });
      const data = (await response.json()) as { tally?: { right: number; off: number } };
      setTally(data.tally ?? fallback);
    } catch {
      setTally(fallback);
    } finally {
      setBusy(false);
    }
  }

  const total = tally ? tally.right + tally.off : 0;
  return (
    <div className="vote">
      <span className="vote-q">Green&apos;s way here?</span>
      {tally ? (
        <span className="vote-result">{total ? `${Math.round((tally.right / total) * 100)}% say right` : "Thanks!"}</span>
      ) : (
        <>
          <button className="px-btn px-btn-small" onClick={() => vote("right")} disabled={busy}>Right</button>
          <button className="px-btn px-btn-small" onClick={() => vote("off")} disabled={busy}>Off</button>
        </>
      )}
    </div>
  );
}

/** The real lines behind this puzzle, straight from the PR. */
export function CodeCard({ code }: { code: NonNullable<Puzzle["code"]> }) {
  return (
    <figure className="code">
      <figcaption>{code.file}</figcaption>
      <pre>
        {code.lines.map((line, index) => {
          const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
          return (
            <span key={index} className={`code-${kind}`}>
              {line || " "}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </figure>
  );
}
