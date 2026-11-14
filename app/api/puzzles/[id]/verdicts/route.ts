import { NextResponse } from "next/server";
import { getPuzzle, saveVerdict, tallyVerdicts } from "@/lib/puzzles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getPuzzle(id))) return NextResponse.json({ error: "Unknown puzzle" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { verdict?: unknown; evidence?: unknown; score?: unknown } | null;
  if (!body || (body.verdict !== "holds" && body.verdict !== "breaks")) {
    return NextResponse.json({ error: "Verdict must be 'holds' or 'breaks'." }, { status: 400 });
  }
  await saveVerdict(id, {
    verdict: body.verdict,
    evidence: typeof body.evidence === "string" ? body.evidence : "",
    score: Math.max(0, Math.min(50, Number(body.score) || 0)),
  });
  const tally = await tallyVerdicts(id);
  return NextResponse.json({ tally: tally[id] ?? { holds: 0, breaks: 0 } });
}
