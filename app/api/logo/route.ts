export const runtime = "nodejs";

/**
 * Same-origin copy of a company logo from context.dev's CDN, so the page can draw it into a canvas (pixel style) and
 * read its brightness to pick a tile colour. Only that CDN is allowed: this is not an open proxy.
 */
const ALLOWED_HOST = "media.brand.dev";
const MAX_BYTES = 1_000_000;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("u") ?? "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Bad logo URL", { status: 400 });
  }
  if (target.protocol !== "https:" || target.hostname !== ALLOWED_HOST) return new Response("Logo host not allowed", { status: 400 });
  const upstream = await fetch(target, { signal: AbortSignal.timeout(8000), redirect: "error" }).catch(() => null);
  const type = upstream?.headers.get("content-type") ?? "";
  if (!upstream?.ok || !type.startsWith("image/")) return new Response("Logo unavailable", { status: 502 });
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return new Response("Logo too large", { status: 502 });
  return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=604800, immutable", "X-Content-Type-Options": "nosniff" } });
}
