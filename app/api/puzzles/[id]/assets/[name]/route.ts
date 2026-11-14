import { getAsset, getPuzzle } from "@/lib/puzzles";

export const runtime = "nodejs";

/** Generated art (cover, sprite sheet) for a puzzle. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  const puzzle = await getPuzzle(id);
  const file = puzzle ? await getAsset(puzzle, name) : null;
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.body), {
    headers: { "Content-Type": file.contentType, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
