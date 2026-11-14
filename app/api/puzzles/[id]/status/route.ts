import { NextResponse } from "next/server";
import { advanceBuild, getPuzzle } from "@/lib/puzzles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Polled while a game builds: moves the background build forward and reports where it is. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const puzzle = await getPuzzle(id);
  if (!puzzle) return NextResponse.json({ error: "Unknown puzzle" }, { status: 404 });
  const current = await advanceBuild(puzzle).catch((error: unknown) => {
    console.error("advanceBuild failed", error);
    return puzzle;
  });
  return NextResponse.json({
    status: current.status,
    kind: current.build?.kind ?? null,
    attempt: current.build?.attempt ?? 0,
    startedAt: current.build?.startedAt ?? null,
  });
}
