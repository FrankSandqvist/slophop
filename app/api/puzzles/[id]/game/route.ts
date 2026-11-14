import { getGameHtml, getPuzzle, wrapGame } from "@/lib/puzzles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves the game. The CSP header sandboxes it even if opened directly, so untrusted HTML never runs with our origin. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [puzzle, html] = await Promise.all([getPuzzle(id), getGameHtml(id)]);
  if (!puzzle || !html) return new Response("Not found", { status: 404 });
  const wrapped = wrapGame(html, new URL(request.url).origin, puzzle);
  return new Response(wrapped.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": wrapped.csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
}
