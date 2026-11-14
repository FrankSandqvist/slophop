import "server-only";

/**
 * Minimal REST client for the Gemini Interactions API: structured JSON (optionally with built-in tools
 * like code execution) and Lyria music.
 * Docs: https://aistudio.google.com/docs/interactions (Api-Revision 2026-05-20).
 *
 * Gemini 4 notes: no sampling params (temperature/top_p/top_k), no "minimal" thinking, and
 * max_output_tokens caps thinking + output together (foreground calls max 32,768 on Argon/Carbon).
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

export const MODELS = {
  /** Fast backup when the design model is slow (see modelHedged). Hydrogen: fast and cheap. */
  backup: process.env.GEMINI_BACKUP_MODEL || "gemini-4-hydrogen",
  /** Models that logic with code execution. Argon: frontier reasoning with low token spend (Carbon is slower). */
  design: process.env.GEMINI_DESIGN_MODEL || "gemini-4-argon",
  music: process.env.GEMINI_MUSIC_MODEL || "lyria-3-clip-preview",
  /** Video with reference images (Veo is retired in the Gemini API). 360p 15s ≈ $0.35. */
  video: process.env.GEMINI_VIDEO_MODEL || "gemini-omni-1.2-flash",
  /** Fast, calibrated closed-set judgements (yes/no, choice, rubric scores). Input tokens only. */
  decision: process.env.GEMINI_DECISION_MODEL || "gemini-decision-1",
};

const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-4-hydrogen,gemini-4-carbon").split(",").map((model) => model.trim()).filter(Boolean);
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function apiKey() {
  const key = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_KEY is missing. Add it to .env.local (and to the Vercel project env).");
  return key;
}

type Block = { type?: string; text?: string; data?: string; mime_type?: string; uri?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> };
type Step = { type?: string; content?: Block[] };
type Interaction = { id?: string; status?: string; steps?: Step[]; error?: { message?: string } };

class GeminiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Interaction> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey(), "Api-Revision": API_REVISION },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as Interaction;
  if (!response.ok) throw new GeminiError(`Gemini ${body.model} failed (${response.status}): ${json.error?.message ?? "unknown error"}`, response.status);
  return waitForCompletion(json, signal);
}

/** Interactions can come back still running; poll until they finish. */
async function waitForCompletion(interaction: Interaction, signal?: AbortSignal): Promise<Interaction> {
  let current = interaction;
  for (let attempt = 0; attempt < 150 && current.id && ["in_progress", "queued", "pending", "running"].includes(current.status ?? ""); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${ENDPOINT}/${current.id}`, { headers: { "x-goog-api-key": apiKey(), "Api-Revision": API_REVISION }, signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Gemini polling failed (${response.status})`);
    current = (await response.json()) as Interaction;
  }
  if (current.status === "failed") throw new Error(`Gemini interaction failed: ${current.error?.message ?? "unknown"}`);
  if (current.status === "requires_continuation" || current.status === "incomplete") throw new Error(`Gemini ran out of output budget (${current.status}).`);
  return current;
}

/** Tries the model, retries once on overload, then walks the fallbacks. Quota errors are not retried. */
async function call(body: Record<string, unknown>, signal?: AbortSignal, fallbacks: string[] = []) {
  const models = [body.model as string, ...fallbacks.filter((model) => model !== body.model)];
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { interaction: await post({ ...body, model }, signal), model };
      } catch (error) {
        lastError = error;
        if (!(error instanceof GeminiError) || !RETRYABLE.has(error.status) || /limit: 0|per day|quota/i.test(error.message)) throw error;
        console.warn(`${error.message} (attempt ${attempt + 1})`);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  throw lastError;
}

function outputTexts(interaction: Interaction) {
  return (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .map((step) => (step.content ?? []).filter((block) => block.type === "text" && block.text).map((block) => block.text).join(""))
    .filter(Boolean);
}

/** Pulls the JSON object out of a reply that may also contain prose or fenced code (e.g. after code execution). */
function extractJson<T>(texts: string[]): T {
  const candidates = [texts.join(""), ...[...texts].reverse()];
  for (const text of candidates) {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      return JSON.parse(cleaned) as T;
    } catch {}
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {}
    }
  }
  throw new Error("Gemini did not return valid JSON.");
}

export async function generateJson<T>(options: {
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  /** Built-in tools, e.g. [{ type: "code_execution" }]. */
  tools?: Array<Record<string, unknown>>;
  thinking?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Fallback models to walk on overload (default: the shared FALLBACKS). */
  fallbacks?: string[];
}): Promise<{ data: T; model: string; citations: Array<{ title: string; url: string }> }> {
  const { interaction, model } = await call(
    {
      model: options.model,
      input: options.prompt,
      response_format: { type: "text", mime_type: "application/json", schema: options.schema },
      ...(options.tools?.length ? { tools: options.tools } : {}),
      // Runs on Gemini's side and is polled, so long tool-using turns never hold one HTTP request open.
      background: true,
      store: true,
      generation_config: {
        ...(options.thinking ? { thinking_level: options.thinking } : {}),
        max_output_tokens: options.maxOutputTokens ?? 32_768,
      },
    },
    options.signal,
    options.fallbacks ?? FALLBACKS,
  );
  // Grounded answers (e.g. Google Search) may carry url_citation annotations on their text.
  const citations = (interaction.steps ?? [])
    .flatMap((step) => step.content ?? [])
    .flatMap((block) => block.annotations ?? [])
    .filter((annotation) => annotation.type === "url_citation" && annotation.url)
    .map((annotation) => ({ title: annotation.title || annotation.url!, url: annotation.url! }));
  return { data: extractJson<T>(outputTexts(interaction)), model, citations };
}

export async function generateMusic(options: { prompt: string; signal?: AbortSignal }) {
  const { interaction } = await call({ model: MODELS.music, input: options.prompt }, options.signal);
  const audio = (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .find((block) => block.type === "audio" && block.data);
  if (!audio?.data) throw new Error("Lyria returned no audio.");
  const mime = audio.mime_type || "audio/mpeg";
  return { bytes: Buffer.from(audio.data, "base64"), mimeType: mime, extension: mime.includes("wav") ? "wav" : "mp3" };
}

/**
 * A short clip from Gemini Omni Flash at its lowest resolution (360p), with optional reference images (up to 3 per
 * character, 2 characters). Runs in the background and is polled. Returns MP4 bytes.
 */
export async function generateVideo(options: { prompt: string; images?: Array<{ data: Buffer; mimeType: string }>; seconds: number; signal?: AbortSignal }) {
  const { interaction } = await call(
    {
      model: MODELS.video,
      input: [
        ...(options.images ?? []).map((image) => ({ type: "image", data: image.data.toString("base64"), mime_type: image.mimeType })),
        { type: "text", text: options.prompt },
      ],
      response_format: { type: "video", resolution: "360p", aspect_ratio: "16:9", duration: `${options.seconds}s` },
      background: true,
      store: true,
    },
    options.signal,
  );
  const video = (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .find((block) => block.type === "video" && (block.data || block.uri));
  if (video?.data) return { bytes: Buffer.from(video.data, "base64"), mimeType: video.mime_type || "video/mp4" };
  if (video?.uri) {
    const response = await fetch(video.uri, { headers: { "x-goog-api-key": apiKey() }, signal: options.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Video download failed (${response.status})`);
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: video.mime_type || "video/mp4" };
  }
  throw new Error("Gemini Omni returned no video.");
}

/* ---------- Decisions API: calibrated yes/no, choice and rubric answers ---------- */

export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: "noul"; noul: number; confidence: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

/**
 * Asks many closed questions about one shared input in a single fast call (POST /v1beta/decisions).
 * yes/no answers are P(yes); scores are the probability-weighted mean level index (0 = first criterion).
 */
export async function decide(input: string, questions: Record<string, DecisionQuestion>, signal?: AbortSignal) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
    body: JSON.stringify({ model: MODELS.decision, input, questions }),
    signal,
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as { answers?: Record<string, DecisionAnswer>; error?: { message?: string } };
  if (!response.ok || !json.answers) throw new Error(`Gemini Decisions failed (${response.status}): ${json.error?.message ?? "no answers"}`);
  return json.answers;
}
