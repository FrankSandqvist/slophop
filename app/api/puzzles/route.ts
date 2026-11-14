import { after } from "next/server";
import { createPuzzle, type ProgressEvent } from "@/lib/puzzles";
import type { PuzzleFamily } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Generates a puzzle and streams progress as newline-delimited JSON. The generation itself is kept alive with after(), so
 * it finishes (and lands in the menu) even if the player leaves the page: the stream just stops reporting.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { prUrl?: unknown; family?: unknown };
  const prUrl = typeof body.prUrl === "string" && body.prUrl.trim() ? body.prUrl.trim() : undefined;
  // The kind the player picked (or none: random).
  const family = typeof body.family === "string" && ["logic", "numeric", "visual", "flow", "ai"].includes(body.family) ? (body.family as PuzzleFamily) : undefined;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      // The player left: stop writing, keep generating.
      controller = null;
    },
  });
  const emit = (event: ProgressEvent) => {
    try {
      controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      controller = null;
    }
  };
  const job = createPuzzle({ prUrl, family, emit })
    .then((puzzle) => emit({ type: "done", puzzle }))
    .catch((error: unknown) => {
      console.error("Puzzle generation failed", error);
      emit({ type: "error", message: error instanceof Error ? error.message : "Puzzle generation failed." });
    })
    .finally(() => {
      try {
        controller?.close();
      } catch {}
    });
  after(job);
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
