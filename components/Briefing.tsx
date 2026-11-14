import type { Puzzle } from "@/lib/puzzles";
import { SystemStrip } from "./SystemStrip";

/** The standard context card shown before every puzzle (and reopenable): what it is, what changed, the system, the promise. */
export function Briefing({ puzzle, onStart, started }: { puzzle: Puzzle; onStart: () => void; started: boolean }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="briefing-title">
      <div className="sheet briefing">
        {puzzle.assets.cover && (
          // eslint-disable-next-line @next/next/no-img-element -- generated art served by our own route
          <img className="briefing-cover" src={`/api/puzzles/${puzzle.id}/assets/cover`} alt="" />
        )}
        <p className="briefing-line"><span className="label">What this is</span>{puzzle.projectSummary}</p>
        <p className="briefing-line"><span className="label">What changed</span>{puzzle.changeSummary}</p>
        <SystemStrip stages={puzzle.system} />
        <p className="label">The promise</p>
        <h2 id="briefing-title" className="promise">{puzzle.promise}</h2>
        <button className="button button-primary briefing-start" onClick={onStart} autoFocus>
          {started ? "Back to the game" : puzzle.status === "ready" ? "Play" : "Look around while it builds"} <span className="button-arrow" aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
}
