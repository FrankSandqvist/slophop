import { getPuzzle } from "@/lib/puzzles";
import { readFile } from "@/lib/storage";

export const runtime = "nodejs";

/** The puzzle's cutscene (MP4). X-Size repeats the length for the loading bar: streamed responses can lose Content-Length. The player fetches it whole and plays it from a blob URL, so no range requests are needed. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const puzzle = await getPuzzle(id);
  if (!puzzle?.fmv) return new Response("No cutscene", { status: 404 });
  const file = await readFile(`puzzles/${puzzle.id}/${puzzle.fmv.file}`);
  if (!file) return new Response("No cutscene", { status: 404 });
  return new Response(new Uint8Array(file.body), {
    headers: { "Content-Type": file.contentType, "Content-Length": String(file.body.length), "X-Size": String(file.body.length), "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
