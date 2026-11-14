"use client";

import { useState } from "react";
import type { Puzzle, Verdict, VerdictTally } from "@/lib/puzzles";
import { buildReport, type Tally } from "@/lib/review";
import { SystemStrip } from "./SystemStrip";

/** The puzzle's outcome as PR information: merge signal, findings, and a copyable review comment. */
export function ReviewPanel(props: {
  puzzle: Puzzle;
  judgments: Record<string, Tally>;
  verdicts: VerdictTally;
  breaks: string[];
  myVerdict: { verdict: Verdict; evidence: string } | null;
}) {
  const { puzzle, judgments, verdicts, breaks, myVerdict } = props;
  const report = buildReport(puzzle, judgments, verdicts, breaks);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(report.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <>
      <p className="label">Crowd review of</p>
      <h2>{puzzle.source.title}</h2>
      <a className="mono-link" href={puzzle.source.url} target="_blank" rel="noreferrer">
        {puzzle.source.repository}#{puzzle.source.number} ↗
      </a>

      <SystemStrip stages={puzzle.system} />

      <p className={`signal signal-${report.signal.level}`}>{report.signal.text}</p>

      <ul className="findings">
        {report.findings.map((finding) => (
          <li key={finding.label} className={`finding tone-${finding.tone}`}>
            <span className="finding-dot" aria-hidden />
            <span>
              <strong>{finding.label}</strong>
              <small>{finding.detail}</small>
            </span>
          </li>
        ))}
      </ul>

      {breaks.length > 0 && (
        <>
          <p className="label">Breaking cases from players</p>
          {breaks.map((evidence, index) => <blockquote key={index}>{evidence}</blockquote>)}
        </>
      )}

      <button className="button button-small copy-button" onClick={copy}>
        {copied ? "Copied" : "Copy as PR comment"}
      </button>

      {puzzle.codeSpots.length > 0 && (
        <>
          <p className="label">The code that changed</p>
          {puzzle.codeSpots.map((spot) => (
            <div key={spot.id} className="spot">
              <p>{spot.caption}</p>
              <pre className="peek-code">
                {spot.lines.map((line, index) => {
                  const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
                  return <span key={index} className={`peek-line peek-${kind}`}>{line}{"\n"}</span>;
                })}
              </pre>
              <small className="mono-link">{spot.file}</small>
            </div>
          ))}
        </>
      )}

      {myVerdict ? (
        <div className="reveal">
          <p className="label">The AI suspected</p>
          <p>{puzzle.aiSuspicion}</p>
          {puzzle.research?.edgeCases?.length ? (
            <>
              <p className="label">Edge cases found in the repo</p>
              <ul className="decoder">
                {puzzle.research.edgeCases.map((edge) => (
                  <li key={edge.input}><span>{edge.input}</span><code>{edge.whatHappens}</code></li>
                ))}
              </ul>
            </>
          ) : null}
          {puzzle.coreDecision && (
            <>
              <p className="label">The logic, distilled</p>
              <pre className="core">{puzzle.coreDecision}</pre>
            </>
          )}
          <p className="label">Puzzle → code</p>
          <ul className="decoder">
            {puzzle.codeMap.map((row) => (
              <li key={row.inPuzzle}><span>{row.inPuzzle}</span><code>{row.inCode}</code></li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="locked">Finish the game to see what the AI suspected and how the puzzle maps to the code.</p>
      )}
    </>
  );
}
