import Link from "next/link";
import { Frog } from "@/components/Frog";
import { Generator } from "@/components/Generator";
import { PuzzleCard } from "@/components/PuzzleCard";
import { advanceBuild, listPuzzles, tallyJudgments, tallyVerdicts, type Puzzle, type VerdictTally } from "@/lib/puzzles";
import { buildReport, type Signal, type Tally } from "@/lib/review";

export const dynamic = "force-dynamic";

async function loadShelf(): Promise<{
  puzzles: Puzzle[];
  tallies: Record<string, VerdictTally>;
  judgments: Record<string, Record<string, Tally>>;
  error?: string;
}> {
  try {
    const [listed, tallies, judgments] = await Promise.all([listPuzzles(), tallyVerdicts(), tallyJudgments()]);
    // Nudge background builds forward (a few at most), then hide failures.
    const puzzles = (
      await Promise.all(listed.map((puzzle, index) => (puzzle.status === "building" && index < 4 ? advanceBuild(puzzle).catch(() => puzzle) : puzzle)))
    ).filter((puzzle) => puzzle.status !== "failed");
    return { puzzles, tallies, judgments };
  } catch (error) {
    console.error("Could not load puzzles", error);
    return { puzzles: [], tallies: {}, judgments: {}, error: "Couldn't load puzzles right now." };
  }
}

function signalFor(puzzle: Puzzle, verdicts: VerdictTally | undefined, judgments: Record<string, Tally> | undefined): Signal {
  return buildReport(puzzle, judgments ?? {}, verdicts ?? { holds: 0, breaks: 0 }, []).signal;
}

export default async function Home() {
  const { puzzles, tallies, judgments, error } = await loadShelf();
  const reviews = Object.values(tallies).reduce((sum, tally) => sum + tally.holds + tally.breaks, 0);

  return (
    <div className="page">
      <header className="site-header">
        <Link className="brand" href="/">
          <Frog />
          <span>SlopHop</span>
        </Link>
        <p className="meta">
          {puzzles.length} puzzle{puzzles.length === 1 ? "" : "s"} · {reviews} review{reviews === 1 ? "" : "s"}
        </p>
      </header>

      <main>
        <section className="hero">
          <h1>
            Real pull requests,
            <br />
            tiny <em className="squiggle">logic puzzles</em>.
          </h1>
          <p className="lede">Play with what a change does, judge its fix and edge cases, and help decide if it&apos;s safe to merge. No coding needed.</p>
          <Generator />
        </section>

        <section className="shelf" aria-label="Puzzles">
          {error && <p className="note" role="alert">{error}</p>}
          {!error && puzzles.length === 0 && <p className="note">No puzzles yet. Make the first one.</p>}
          <ul className="grid">
            {puzzles.map((puzzle) => (
              <li key={puzzle.id}>
                <PuzzleCard puzzle={puzzle} tally={tallies[puzzle.id]} signal={signalFor(puzzle, tallies[puzzle.id], judgments[puzzle.id])} />
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="site-footer">Puzzles by Gemini · music by Lyria · from public GitHub PRs · humans decide</footer>
    </div>
  );
}
