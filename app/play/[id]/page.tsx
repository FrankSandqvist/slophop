import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PuzzlePlayer } from "@/components/PuzzlePlayer";
import { getPuzzle, recentBreaks, tallyJudgments, tallyVerdicts } from "@/lib/puzzles";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const puzzle = await getPuzzle((await params).id);
  return puzzle ? { title: `${puzzle.emoji} ${puzzle.title} · SlopHop`, description: puzzle.premise } : { title: "Puzzle not found · SlopHop" };
}

export default async function PlayPage({ params }: Props) {
  const { id } = await params;
  const [puzzle, verdicts, judgments, breaks] = await Promise.all([getPuzzle(id), tallyVerdicts(id), tallyJudgments(id), recentBreaks(id)]);
  if (!puzzle) notFound();
  return (
    <PuzzlePlayer
      puzzle={puzzle}
      initialTally={verdicts[id] ?? { holds: 0, breaks: 0 }}
      initialJudgments={judgments[id] ?? {}}
      initialBreaks={breaks}
    />
  );
}
