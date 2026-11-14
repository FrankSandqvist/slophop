import { NextResponse } from "next/server";
import { getPuzzle, isValidAnswer, saveJudgment, tallyJudgments } from "@/lib/puzzles";
import { hasQuestion } from "@/lib/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Records one standardized judgment ("fix", "tradeoff-<i>", "case-<i>") and returns that question's tally. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const puzzle = await getPuzzle(id);
  if (!puzzle) return NextResponse.json({ error: "Unknown puzzle" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { key?: unknown; answer?: unknown; detail?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  const answer = typeof body?.answer === "string" ? body.answer : "";
  if (!hasQuestion(puzzle, key) || !isValidAnswer(key, answer)) {
    return NextResponse.json({ error: "Unknown question or answer." }, { status: 400 });
  }
  await saveJudgment(id, { key, answer, detail: typeof body?.detail === "string" ? body.detail : "" });
  const tally = await tallyJudgments(id);
  return NextResponse.json({ tally: tally[id]?.[key] ?? {} });
}
