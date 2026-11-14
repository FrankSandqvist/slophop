import "server-only";

/**
 * Minimal REST client for the Gemini Interactions API: text, structured JSON, tool use,
 * background (long) interactions, images and Lyria music.
 * Docs: https://aistudio.google.com/docs/interactions (Api-Revision 2026-05-20).
 *
 * Gemini 4 notes: no sampling params (temperature/top_p/top_k are rejected or ignored), no "minimal"
 * thinking, max_output_tokens caps thinking + output together, and non-streaming foreground calls are
 * capped at 32,768 tokens on Argon/Carbon, so long generations run as background interactions.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

/**
 * Model per job (all overridable):
 * - research: Hydrogen batches read/search tool calls in parallel and is cheapest.
 * - design: Carbon is the strongest reasoner with the strictest schema adherence.
 * - build: Argon, a frontier model with lower token spend per turn than Carbon.
 */
export const MODELS = {
  research: process.env.GEMINI_RESEARCH_MODEL || "gemini-4-hydrogen",
  design: process.env.GEMINI_DESIGN_MODEL || "gemini-4-carbon",
  build: process.env.GEMINI_BUILD_MODEL || "gemini-4-argon",
  music: process.env.GEMINI_MUSIC_MODEL || "lyria-3-clip-preview",
  image: process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1",
};

function apiKey() {
  const key = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_KEY is missing. Add it to .env.local (and to the Vercel project env).");
  return key;
}

type Block = { type?: string; text?: string; data?: string; mime_type?: string; mimeType?: string };
type Step = { type?: string; content?: Block[]; id?: string; name?: string; arguments?: unknown };
type Interaction = {
  id?: string;
  status?: string;
  steps?: Step[];
  outputs?: Block[];
  error?: { message?: string };
};

/** Text models to fall back to when the preferred one is overloaded. */
const TEXT_FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-4-argon,gemini-4-hydrogen,gemini-4-carbon").split(",").map((model) => model.trim()).filter(Boolean);
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

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
  const json = (await response.json().catch(() => ({}))) as Interaction & { error?: { message?: string } };
  if (!response.ok) {
    throw new GeminiError(`Gemini ${body.model} failed (${response.status}): ${json.error?.message ?? "unknown error"}`, response.status);
  }
  return json;
}

async function callOnce(body: Record<string, unknown>, signal?: AbortSignal): Promise<Interaction> {
  const interaction = await waitForCompletion(await post(body, signal), signal);
  if (interaction.status === "requires_continuation" || interaction.status === "incomplete") {
    throw new Error(`Gemini ${body.model} ran out of output budget (${interaction.status}). Use a background interaction for long outputs.`);
  }
  return interaction;
}

/** Models that recently answered 503/overloaded are skipped for a while. */
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 3 * 60_000;

/**
 * Retries a transiently failing model once, then walks the fallback list (text models only).
 * Quota errors ("limit: 0", per-day caps) are not retried: they will not clear in seconds.
 */
async function call(body: Record<string, unknown>, signal?: AbortSignal, fallbacks: string[] = []): Promise<{ interaction: Interaction; model: string }> {
  const all = [body.model as string, ...fallbacks.filter((model) => model !== body.model)];
  const warm = all.filter((model) => (cooldownUntil.get(model) ?? 0) < Date.now());
  const models = warm.length ? warm : all;
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const interaction = await callOnce({ ...body, model }, signal);
        cooldownUntil.delete(model);
        return { interaction, model };
      } catch (error) {
        lastError = error;
        if (!(error instanceof GeminiError) || !RETRYABLE.has(error.status)) throw error;
        if (/limit: 0|per day|quota/i.test(error.message)) throw error;
        console.warn(`${error.message} (attempt ${attempt + 1})`);
        if (error.status === 503) cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
        if (attempt === 0 && models.length === 1) await new Promise((resolve) => setTimeout(resolve, 2000));
        else break;
      }
    }
  }
  throw lastError;
}

/** Interactions can come back still running; poll until they finish. */
async function waitForCompletion(interaction: Interaction, signal?: AbortSignal): Promise<Interaction> {
  let current = interaction;
  for (let attempt = 0; attempt < 120 && current.id && isPending(current.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${ENDPOINT}/${current.id}`, {
      headers: { "x-goog-api-key": apiKey(), "Api-Revision": API_REVISION },
      signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Gemini polling failed (${response.status})`);
    current = (await response.json()) as Interaction;
  }
  if (current.status === "failed") throw new Error(`Gemini interaction failed: ${current.error?.message ?? "unknown"}`);
  return current;
}

function isPending(status?: string) {
  return status === "in_progress" || status === "pending" || status === "running" || status === "queued";
}

/** Generation config with Gemini 4 knobs only (thinking level + output budget). */
function config(thinking?: string, maxOutputTokens?: number) {
  const generation: Record<string, unknown> = {};
  if (thinking) generation.thinking_level = thinking;
  if (maxOutputTokens) generation.max_output_tokens = maxOutputTokens;
  return Object.keys(generation).length ? { generation_config: generation } : {};
}

/* ---------- Background interactions (long generations, polled later) ---------- */

/** Starts a long text generation that runs on Gemini's side; poll it with getBackground(). */
export async function startBackground(options: { model: string; prompt: string; thinking?: string; maxOutputTokens?: number }) {
  const models = [options.model, ...TEXT_FALLBACKS.filter((model) => model !== options.model)];
  let lastError: unknown;
  for (const model of models) {
    try {
      const interaction = await post({ model, input: options.prompt, background: true, store: true, ...config(options.thinking, options.maxOutputTokens) });
      if (!interaction.id) throw new Error("Gemini returned no interaction id for a background run.");
      return { id: interaction.id, model };
    } catch (error) {
      lastError = error;
      if (!(error instanceof GeminiError) || !RETRYABLE.has(error.status) || /limit: 0|per day|quota/i.test(error.message)) throw error;
      console.warn(`${error.message} (trying next model)`);
    }
  }
  throw lastError;
}

export type BackgroundState = { status: "running" | "completed" | "failed"; text: string; error?: string };

export async function getBackground(id: string): Promise<BackgroundState> {
  const response = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}`, {
    headers: { "x-goog-api-key": apiKey(), "Api-Revision": API_REVISION },
    cache: "no-store",
  });
  if (!response.ok) return { status: "failed", text: "", error: `Polling failed (${response.status})` };
  const interaction = (await response.json()) as Interaction;
  if (isPending(interaction.status)) return { status: "running", text: "" };
  const text = outputText(interaction);
  if (interaction.status === "completed" && text) return { status: "completed", text };
  return { status: "failed", text, error: interaction.error?.message ?? `Ended with status ${interaction.status}` };
}

function outputBlocks(interaction: Interaction): Block[] {
  const fromSteps = (interaction.steps ?? []).filter((step) => step.type === "model_output").flatMap((step) => step.content ?? []);
  return fromSteps.length ? fromSteps : interaction.outputs ?? [];
}

function outputText(interaction: Interaction) {
  return outputBlocks(interaction).filter((block) => block.type === "text" && block.text).map((block) => block.text).join("");
}

export async function generateText(options: { model: string; prompt: string; thinking?: string; maxOutputTokens?: number; signal?: AbortSignal }) {
  const { interaction, model } = await call(
    {
      model: options.model,
      input: options.prompt,
      ...config(options.thinking, options.maxOutputTokens ?? 32_768),
    },
    options.signal,
    TEXT_FALLBACKS,
  );
  const text = outputText(interaction);
  if (!text) throw new Error(`Gemini ${model} returned no text.`);
  return { text, model };
}

export async function generateJson<T>(options: {
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  thinking?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<{ data: T; model: string }> {
  const { interaction, model } = await call(
    {
      model: options.model,
      input: options.prompt,
      response_format: { type: "text", mime_type: "application/json", schema: options.schema },
      ...config(options.thinking, options.maxOutputTokens ?? 32_768),
    },
    options.signal,
    TEXT_FALLBACKS,
  );
  const text = outputText(interaction).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return { data: JSON.parse(text) as T, model };
  } catch {
    throw new Error("Gemini returned a puzzle design that was not valid JSON.");
  }
}

export async function generateMusic(options: { prompt: string; signal?: AbortSignal }) {
  const { interaction } = await call({ model: MODELS.music, input: options.prompt }, options.signal);
  const audio = outputBlocks(interaction).find((block) => block.type === "audio" && block.data);
  if (!audio?.data) throw new Error("Lyria returned no audio.");
  const mime = audio.mime_type || audio.mimeType || "audio/mpeg";
  return { bytes: Buffer.from(audio.data, "base64"), mimeType: mime, extension: mime.includes("wav") ? "wav" : "mp3" };
}

/** One image via the Interactions API. Paid-tier only; callers must cope with failure. */
export async function generateImage(options: { prompt: string; aspectRatio?: string; signal?: AbortSignal }) {
  const { interaction } = await call(
    {
      model: MODELS.image,
      input: options.prompt,
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: options.aspectRatio ?? "1:1", image_size: "1K" },
    },
    options.signal,
  );
  const image = outputBlocks(interaction).filter((block) => block.type === "image" && block.data).pop();
  if (!image?.data) throw new Error("Image model returned no image.");
  const bytes = Buffer.from(image.data, "base64");
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  return { bytes, mimeType: isPng ? "image/png" : "image/jpeg", extension: isPng ? "png" : "jpg" };
}

/* ---------- Tool use (function calling) ---------- */

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Runs the tool; return text for the model. Throwing reports the error back to the model. */
  run?: (args: Record<string, unknown>) => Promise<string>;
};

type ToolCall = { id: string; name: string; args: Record<string, unknown> };

function toolCalls(interaction: Interaction): ToolCall[] {
  return (interaction.steps ?? [])
    .filter((step) => step.type === "function_call" && step.id && step.name)
    .map((step) => {
      let args = step.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return { id: step.id!, name: step.name!, args: (args ?? {}) as Record<string, unknown> };
    });
}

/**
 * Lets the model think and call tools for several turns (stateful via previous_interaction_id),
 * until it calls `finishTool`, stops calling tools, or runs out of turns/time.
 * The finish tool is declared like any other but has no `run`; its arguments are the result.
 */
export async function runToolLoop(options: {
  model: string;
  prompt: string;
  tools: Tool[];
  finishTool: string;
  thinking?: string;
  maxTurns: number;
  deadline: number;
  onCall?: (call: ToolCall) => void;
  signal?: AbortSignal;
}) {
  const declarations = options.tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));
  const genConfig = options.thinking ? { thinking_level: options.thinking } : {};
  const log: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];

  let model = options.model;
  try {
    const first = await call(
      { model: options.model, input: options.prompt, tools: declarations, generation_config: genConfig },
      options.signal,
      TEXT_FALLBACKS,
    );
    model = first.model;
    let interaction = first.interaction;

    for (let turn = 1; ; turn++) {
      const calls = toolCalls(interaction);
      const finish = calls.find((entry) => entry.name === options.finishTool);
      if (finish) return { result: finish.args, model, log, fallbackText: "" };
      if (!calls.length) return { result: null, model, log, fallbackText: outputText(interaction) };

      const results = await Promise.all(
        calls.map(async (entry) => {
          options.onCall?.(entry);
          const tool = options.tools.find((candidate) => candidate.name === entry.name);
          let text: string;
          let isError = false;
          try {
            if (!tool?.run) throw new Error(`Unknown tool ${entry.name}`);
            text = await tool.run(entry.args);
          } catch (error) {
            text = error instanceof Error ? error.message : "Tool failed";
            isError = true;
          }
          log.push({ name: entry.name, args: entry.args, result: text });
          return { type: "function_result", name: entry.name, call_id: entry.id, is_error: isError, result: [{ type: "text", text }] };
        }),
      );

      const outOfBudget = turn >= options.maxTurns || Date.now() > options.deadline;
      try {
        ({ interaction } = await call(
          {
            model,
            previous_interaction_id: interaction.id,
            input: results,
            tools: declarations,
            generation_config: outOfBudget
              ? { ...config, tool_choice: { allowed_tools: { mode: "any", tools: [options.finishTool] } } }
              : config,
          },
          options.signal,
        ));
      } catch (error) {
        console.error("Tool loop stopped early", error);
        return { result: null, model, log, fallbackText: "" };
      }
      if (outOfBudget) {
        const finishCall = toolCalls(interaction).find((entry) => entry.name === options.finishTool);
        return { result: finishCall?.args ?? null, model, log, fallbackText: outputText(interaction) };
      }
    }
  } catch (error) {
    // Timeouts/aborts or API errors: hand back whatever was gathered so far.
    console.error("Tool loop ended early", error);
    return { result: null, model, log, fallbackText: "" };
  }
}
