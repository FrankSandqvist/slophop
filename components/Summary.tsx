import Link from "next/link";
import type { Puzzle, Verdict, VerdictTally } from "@/lib/puzzles";
import type { Tally } from "@/lib/review";
import { ReviewPanel } from "./ReviewPanel";

/** End of the run: the crowd review, plus ways out. */
export function Summary(props: {
  puzzle: Puzzle;
  judgments: Record<string, Tally>;
  verdicts: VerdictTally;
  breaks: string[];
  myVerdict: { verdict: Verdict; evidence: string } | null;
  onReplay: () => void;
}) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Crowd review">
      <div className="sheet summary">
        <ReviewPanel puzzle={props.puzzle} judgments={props.judgments} verdicts={props.verdicts} breaks={props.breaks} myVerdict={props.myVerdict} />
        <div className="summary-actions">
          <button className="button" onClick={props.onReplay}>Play again</button>
          <Link className="button button-primary" href="/">More puzzles <span className="button-arrow" aria-hidden>→</span></Link>
        </div>
      </div>
    </div>
  );
}
