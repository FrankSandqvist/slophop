import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlayDS } from "@/components/PlayDS";
import { getPuzzle, tallyVotes } from "@/lib/puzzles";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const puzzle = await getPuzzle((await params).id);
  return puzzle ? { title: `${puzzle.title} · SlopHop`, description: puzzle.change } : { title: "SlopHop" };
}

export default async function PlayPage({ params }: Props) {
  const { id } = await params;
  const [puzzle, votes] = await Promise.all([getPuzzle(id), tallyVotes(id)]);
  if (!puzzle) notFound();
  return <PlayDS puzzle={puzzle} initialVotes={votes} />;
}
