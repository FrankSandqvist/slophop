import { getPuzzle } from "@/lib/puzzles";
import { readFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const puzzle = await getPuzzle(id);
  if (!puzzle?.musicFile) return new Response("No soundtrack", { status: 404 });
  const file = await readFile(`puzzles/${puzzle.id}/${puzzle.musicFile}`);
  if (!file) return new Response("No soundtrack", { status: 404 });
  return new Response(new Uint8Array(file.body), {
    headers: { "Content-Type": file.contentType, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
