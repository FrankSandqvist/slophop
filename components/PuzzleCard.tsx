import Link from "next/link";
import type { Puzzle, VerdictTally } from "@/lib/puzzles";
import { puzzleAccent } from "@/lib/puzzle-view";
import type { Signal } from "@/lib/review";

const SIGNAL_SHORT: Record<Signal["level"], string> = { safe: "Looks safe", caution: "Take a look", risky: "Risky", unknown: "Needs votes" };

export function PuzzleCard({ puzzle, tally, signal }: { puzzle: Puzzle; tally?: VerdictTally; signal?: Signal | null }) {
  const reviews = (tally?.holds ?? 0) + (tally?.breaks ?? 0);
  const colors = puzzle.theme.colors;
  return (
    <Link href={`/play/${puzzle.id}`} className="card" style={{ "--accent": puzzleAccent(puzzle) } as React.CSSProperties}>
      {puzzle.assets.cover && (
        // eslint-disable-next-line @next/next/no-img-element -- generated art served by our own route
        <img className="card-cover" src={`/api/puzzles/${puzzle.id}/assets/cover`} alt="" loading="lazy" />
      )}
      <div className="card-top">
        <span className="card-emoji" aria-hidden>{puzzle.emoji}</span>
        <span className="card-tags">
          <span className="tag">{puzzle.theme.name}</span>
          {puzzle.theme.dimension === "3d" && <span className="tag">3D</span>}
          {puzzle.musicFile && <span className="tag" title="Has a soundtrack">♪</span>}
        </span>
      </div>
      <h2 className="card-title">{puzzle.title}</h2>
      <p className="card-repo">{puzzle.source.repository}#{puzzle.source.number}</p>
      <p className="card-blurb">{puzzle.premise}</p>
      <div className="card-foot">
        <span className="swatches" aria-hidden>
          {colors.map((color) => <i key={color} style={{ background: color }} />)}
        </span>
        {puzzle.status !== "ready" ? (
          <span className="signal-chip signal-unknown">{puzzle.status === "failed" ? "Build failed" : "Building…"}</span>
        ) : signal ? (
          <span className={`signal-chip signal-${signal.level}`}>{SIGNAL_SHORT[signal.level]}</span>
        ) : (
          <span>{reviews ? `${reviews} review${reviews === 1 ? "" : "s"}` : "unplayed"}</span>
        )}
      </div>
    </Link>
  );
}
