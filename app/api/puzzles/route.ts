import { createPuzzle, type ProgressEvent } from "@/lib/puzzles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Generates a new puzzle and streams progress as newline-delimited JSON. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { prUrl?: unknown };
  const prUrl = typeof body.prUrl === "string" && body.prUrl.trim() ? body.prUrl.trim() : undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: ProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client went away; keep generating so the puzzle still lands in the list.
        }
      };
      try {
        const puzzle = await createPuzzle({ prUrl, emit });
        emit({ type: "done", puzzle });
      } catch (error) {
        console.error("Puzzle generation failed", error);
        emit({ type: "error", message: error instanceof Error ? error.message : "Puzzle generation failed." });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
