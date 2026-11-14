import "server-only";
import { MODELS, runToolLoop, type Tool } from "./gemini";
import { createRepoBrowser, type PullRequestSource } from "./github";

/** What the researcher hands to the puzzle designer. */
export type Likelihood = "likely" | "rare" | "never";

export type ResearchNotes = {
  project: string;
  change: string;
  fixed: { situation: string; before: string; after: string };
  tradeoffs: string[];
  flow: string;
  edgeCases: Array<{
    input: string;
    realTrigger: string;
    whatHappens: string;
    introduced: boolean;
    likelihood: Likelihood;
    evidence: string;
  }>;
  keyCode: string;
  themeHint: string;
};

const MAX_TURNS = Number(process.env.RESEARCH_MAX_TURNS || 6);
const BUDGET_MS = Number(process.env.RESEARCH_BUDGET_MS || 50_000);

const str = (description: string) => ({ type: "string", description });

const finishTool: Tool = {
  name: "finish_research",
  description: "Call this once you understand the change in context. Your arguments are handed to the puzzle designer.",
  parameters: {
    type: "object",
    properties: {
      project: str("What the project is and who uses it, in plain words (max 30 words)."),
      change: str("What this PR changes, in context: which behaviour, for whom, and why (max 60 words)."),
      fixed: {
        type: "object",
        description: "The situation this PR fixes (or the capability it adds): what happened before vs after.",
        properties: {
          situation: str("The real-world situation, max 20 words."),
          before: str("What happened before the PR, max 15 words."),
          after: str("What happens now, max 15 words."),
        },
        required: ["situation", "before", "after"],
      },
      tradeoffs: {
        type: "array",
        items: str("Max 30 words."),
        description: "1-3 tradeoffs of this change: what it gains vs what it gives up or risks (stricter/looser behaviour, performance, compatibility, behaviour users may rely on).",
      },
      flow: str("Inputs -> decision -> outputs for the key changed logic: where values come from, what is decided, where the result is used (max 90 words)."),
      edgeCases: {
        type: "array",
        description: "3-6 concrete edge cases in the WHOLE system most likely to break the PR's promise, each verified against the code you read.",
        items: {
          type: "object",
          properties: {
            input: str("The concrete input reaching the changed code."),
            realTrigger: str("How a real user or real data would cause it, end to end through the system (max 25 words)."),
            whatHappens: str("What the code ACTUALLY does then, after this PR."),
            introduced: { type: "boolean", description: "True if this PR introduced or exposed it; false if it already existed." },
            likelihood: { type: "string", enum: ["likely", "rare", "never"], description: "Your honest estimate of how often this happens in real use." },
            evidence: str("file:line references."),
          },
          required: ["input", "realTrigger", "whatHappens", "introduced", "likelihood", "evidence"],
        },
      },
      keyCode: str("The most important code, copied verbatim with file:line headers (max ~40 lines total)."),
      themeHint: str("The project's own world and vocabulary, which a puzzle theme could borrow (max 15 words)."),
    },
    required: ["project", "change", "fixed", "tradeoffs", "flow", "edgeCases", "keyCode", "themeHint"],
  },
};

function researchPrompt(pr: PullRequestSource, overview: string) {
  return `You are researching a GitHub pull request so a designer can turn it into an edge-case puzzle for people who don't code.
The goal: help a human feel safe (or rightly unsafe) merging this possibly AI-written PR.
Players will judge whether the fix works, whether its tradeoffs are worth it, and whether new edge cases would realistically happen.

Use the tools to find out:
1. What this project is and who uses it.
2. What the PR fixes or adds: the situation, and the behaviour before vs after. Does the fix actually cover the situation?
   What does it trade off (stricter/looser behaviour, performance, compatibility, things users may rely on)?
3. The changed logic in the WHOLE system: who calls it, where its inputs really come from (users, files, other services) and their realistic values, what it returns and where that result ends up.
4. Edge cases: empty / missing / zero / negative / huge values, duplicates, ordering, timing, unusual formats, and anything the PR description or tests hint at.
   For each, trace how a real user or real data would trigger it, whether this PR introduced it, and how likely it is.
   Verify each edge case against the code; don't guess.

Work efficiently: request several tool calls in the same turn when you can. You have at most ${MAX_TURNS} turns.
Start from the excerpts below, read callers and definitions, then call finish_research. Keep the notes tight.

PULL REQUEST: ${pr.repository}#${pr.number}: ${pr.title}
DESCRIPTION:
${pr.body || "(none)"}

${overview}

DIFF:
${pr.diff}

EXCERPTS AROUND THE CHANGES (head version):
${pr.context || "(unavailable)"}`;
}

export async function researchPullRequest(options: {
  pr: PullRequestSource;
  onStep: (detail: string) => void;
  signal?: AbortSignal;
}): Promise<{ notes: ResearchNotes | null; model: string; steps: number; overview: string; fallback: string }> {
  const browser = createRepoBrowser(options.pr);
  const overview = await browser.overview();

  const tools: Tool[] = [
    {
      name: "read_file",
      description: "Read a file at the PR's commit, with line numbers. Max ~220 lines per call; use start_line/end_line to page.",
      parameters: {
        type: "object",
        properties: { path: str("Repo-relative path."), start_line: { type: "integer" }, end_line: { type: "integer" } },
        required: ["path"],
      },
      run: (args) => browser.readFile(String(args.path), Number(args.start_line) || 1, Number(args.end_line) || undefined),
    },
    {
      name: "search_code",
      description: "Search the repository's code (default branch) for an identifier or phrase. Returns paths and matching fragments.",
      parameters: { type: "object", properties: { query: str("Identifier or phrase, e.g. a function name.") }, required: ["query"] },
      run: (args) => browser.searchCode(String(args.query)),
    },
    {
      name: "list_dir",
      description: "List files and folders under a directory at the PR's commit ('' for the root).",
      parameters: { type: "object", properties: { path: str("Directory path.") }, required: ["path"] },
      run: (args) => browser.listDir(String(args.path ?? "")),
    },
    finishTool,
  ];

  // Hard stop: a single slow turn must not blow the whole generation budget.
  const signal = AbortSignal.any([AbortSignal.timeout(BUDGET_MS + 40_000), ...(options.signal ? [options.signal] : [])]);
  const { result, model, log, fallbackText } = await runToolLoop({
    model: MODELS.research,
    prompt: researchPrompt(options.pr, overview),
    tools,
    finishTool: finishTool.name,
    thinking: process.env.GEMINI_RESEARCH_THINKING || "low",
    maxTurns: MAX_TURNS,
    deadline: Date.now() + BUDGET_MS,
    signal,
    onCall: ({ name, args }) => {
      if (name === "read_file") options.onStep(`Reading ${args.path}${args.start_line ? `:${args.start_line}` : ""}`);
      else if (name === "search_code") options.onStep(`Searching "${args.query}"`);
      else if (name === "list_dir") options.onStep(`Looking in ${args.path || "/"}`);
    },
  });

  // If the model never called finish_research, give the designer what it read.
  const fallback = [fallbackText, ...log.slice(-6).map((entry) => `[${entry.name} ${JSON.stringify(entry.args)}]\n${entry.result.slice(0, 3000)}`)]
    .filter(Boolean)
    .join("\n\n");

  return { notes: (result as ResearchNotes | null) ?? null, model, steps: log.length, overview, fallback };
}
