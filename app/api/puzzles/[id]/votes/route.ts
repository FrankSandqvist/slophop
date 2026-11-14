import { NextResponse } from "next/server";
import { getPuzzle, saveVote, tallyVotes } from "@/lib/puzzles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One crowd vote on one case: does Green's (the new code's) behaviour seem right here? */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const puzzle = await getPuzzle(id);
  if (!puzzle) return NextResponse.json({ error: "Unknown puzzle" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { row?: unknown; vote?: unknown } | null;
  const row = puzzle.table.find((entry) => entry.key === body?.row);
  if (!row || (body?.vote !== "right" && body?.vote !== "off")) return NextResponse.json({ error: "Bad vote" }, { status: 400 });
  await saveVote(id, row.key, body.vote);
  const tally = await tallyVotes(id);
  return NextResponse.json({ tally: tally[row.key] ?? { right: 0, off: 0 } });
}
