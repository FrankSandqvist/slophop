import "server-only";
import { settleLimited } from "./limit";

export type PullRequestSource = {
  url: string;
  repository: string;
  number: number;
  title: string;
  body: string;
  author: string;
  mergedAt: string | null;
  diff: string;
  /** Short excerpts around the changed hunks (head version): a starting point for repo research. */
  context: string;
  owner: string;
  repo: string;
  /** The AI coding tool the PR itself says made it (signature footer, agent author, Codex link), or null. Never guessed. */
  madeWith: string | null;
  /** Commit the PR's code is read at (merge commit when merged, else head). */
  ref: string;
  changedFiles: string[];
};

type SearchItem = { html_url: string; user: { login: string }; title: string; body: string | null; labels?: Array<{ name: string }> };
type PullFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
type Pull = {
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string };
  labels?: Array<{ name: string }>;
  merged_at: string | null;
  merge_commit_sha: string | null;
  number: number;
  head: { sha: string };
};

/**
 * Recent merged public PRs made with AI coding tools, found by each tool's own signature. Search matches loosely, so every
 * loaded PR is checked again with `madeWithTool` and dropped unless it really carries a signature.
 */
const SEARCHES = {
  /** Fixes in general: mostly logic. */
  general: [
    'fix in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'edge case in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'fix in:title author:app/copilot-swe-agent is:pr is:public is:merged',
    'fix in:title "chatgpt.com/codex/tasks" in:body is:pr is:public is:merged',
    'fix in:title author:app/devin-ai-integration is:pr is:public is:merged',
    'fix in:title author:app/google-labs-jules is:pr is:public is:merged',
    'fix in:title "Made with Cursor" in:body is:pr is:public is:merged',
    'validation in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
  ],
  /** Calculations: prices, rounding, limits. */
  numeric: [
    'rounding in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'calculation in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'price in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'limit in:title author:app/copilot-swe-agent is:pr is:public is:merged',
    'total in:title "chatgpt.com/codex/tasks" in:body is:pr is:public is:merged',
  ],
  /** Looks: layout, CSS, small screens. */
  visual: [
    'layout in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'css in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'mobile in:title "Generated with Claude Code" in:body is:pr is:public is:merged',
    'layout in:title author:app/copilot-swe-agent is:pr is:public is:merged',
    'overflow in:title "Made with Cursor" in:body is:pr is:public is:merged',
  ],
};

/** The AI tool a PR says made it, from its own signature only: agent author accounts, footers, Codex task links. */
export function madeWithTool(pull: { body: string | null; user: { login: string }; labels?: Array<{ name: string }> }): string | null {
  const login = pull.user.login.toLowerCase();
  const body = pull.body ?? "";
  if (login === "copilot" || login.startsWith("copilot-swe-agent")) return "GitHub Copilot";
  if (login.startsWith("devin-ai-integration")) return "Devin";
  if (login.startsWith("google-labs-jules")) return "Jules";
  if (/generated with \[?claude code/i.test(body)) return "Claude Code";
  if (/chatgpt\.com\/codex\/tasks\//i.test(body)) return "OpenAI Codex";
  if (/(made|generated) with \[?cursor/i.test(body)) return "Cursor";
  return null;
}

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|css|scss|sass|less|vue|svelte|html|astro)$/i;
const NOISE_FILE = /(lock|\.min\.|snap|generated|dist\/|vendor\/|__snapshots__|\.d\.ts$)/i;
const MAX_DIFF_CHARS = 9_000;
const MAX_CONTEXT_CHARS = 6_000;
const CONTEXT_FILES = 2;
const CONTEXT_PADDING = 25;

function headers() {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghResponse(path: string, accept?: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { ...headers(), ...(accept ? { Accept: accept } : {}) },
    cache: "no-store",
  });
  if (response.status === 403 || response.status === 429) throw new Error("GitHub is rate-limiting SlopHop. Try again in a minute.");
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
  return response;
}

async function gh<T>(path: string): Promise<T> {
  return (await (await ghResponse(path)).json()) as T;
}

export function parsePullUrl(input: string) {
  const match = input.trim().match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** Rough "is there a puzzle in here" score: branching logic, arithmetic, or layout/styling changes. */
function logicScore(files: PullFile[]) {
  const code = files.filter((file) => CODE_FILE.test(file.filename) && !NOISE_FILE.test(file.filename) && file.patch);
  const changed = code.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (!code.length || changed < 6 || changed > 500) return 0;
  const patch = code.map((file) => file.patch).join("\n");
  const count = (pattern: RegExp) => (patch.match(pattern) ?? []).length;
  const branches = count(/^[+-].*(\bif\b|\belse\b|\?|&&|\|\||\bswitch\b|\bcase\b|[<>]=?|===?|!==?|\bmatch\b)/gm);
  const maths = count(/^[+-].*(Math\.|\bround|\bfloor|\bceil|\bclamp|\bmin\(|\bmax\(|\d\.\d|\d+\s*[*/%]|[*/%]\s*\d)/gm);
  const looks = count(/^[+-].*(\b(margin|padding|width|height|gap|flex|grid|font-size|color|background|overflow|wrap|z-index|display|position)\b|\d+(px|rem|em|vh|vw|%)\b|@media)/gm);
  return branches * 10 + maths * 6 + looks * 6 + Math.min(changed, 120);
}

function buildDiff(files: PullFile[]) {
  let diff = "";
  for (const file of files) {
    if (!file.patch || NOISE_FILE.test(file.filename)) continue;
    const chunk = `--- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n${file.patch}\n\n`;
    if (diff.length + chunk.length > MAX_DIFF_CHARS) {
      diff += `--- ${file.filename} (omitted for length)\n`;
      continue;
    }
    diff += chunk;
  }
  return diff.trim();
}

type LoadedPull = { pull: Pull; files: PullFile[]; owner: string; repo: string; score: number };

async function loadPull(owner: string, repo: string, number: number): Promise<LoadedPull> {
  const [pull, files] = await Promise.all([
    gh<Pull>(`/repos/${owner}/${repo}/pulls/${number}`),
    gh<PullFile[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=40`),
  ]);
  return { pull, files, owner, repo, score: logicScore(files) };
}

/** New-file line ranges touched by a unified-diff patch ("@@ -a,b +c,d @@"). */
function changedRanges(patch: string) {
  const ranges: Array<[number, number]> = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push([start, start + Math.max(length, 1) - 1]);
  }
  return ranges;
}

/** Cut windows of the file around the changed lines, merging overlaps, with line numbers. */
function windowsAround(text: string, ranges: Array<[number, number]>, budget: number) {
  const lines = text.split("\n");
  const windows: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    const start = Math.max(1, from - CONTEXT_PADDING);
    const end = Math.min(lines.length, to + CONTEXT_PADDING);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }
  let out = "";
  for (const [start, end] of windows) {
    const chunk = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5)} | ${line}`).join("\n");
    if (out.length + chunk.length > budget) {
      out += `${out ? "\n" : ""}  ... (more omitted)`;
      break;
    }
    out += `${out ? "\n  ...\n" : ""}${chunk}`;
  }
  return out;
}

/** Fetch the head version of the most-changed code files and keep only the code around each change. */
function refOf(pull: Pull) {
  return (pull.merged_at && pull.merge_commit_sha) || pull.head.sha;
}

async function loadContext({ pull, files, owner, repo }: LoadedPull) {
  const ref = refOf(pull);
  const targets = files
    .filter((file) => file.patch && file.status !== "removed" && CODE_FILE.test(file.filename) && !NOISE_FILE.test(file.filename))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, CONTEXT_FILES);
  const perFile = Math.floor(MAX_CONTEXT_CHARS / Math.max(targets.length, 1));
  const sections = await Promise.all(
    targets.map(async (file) => {
      try {
        const path = file.filename.split("/").map(encodeURIComponent).join("/");
        const text = await (await ghResponse(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "application/vnd.github.raw+json")).text();
        return `=== ${file.filename} (around the changes) ===\n${windowsAround(text, changedRanges(file.patch ?? ""), perFile)}`;
      } catch {
        return null;
      }
    }),
  );
  return sections.filter(Boolean).join("\n\n");
}

async function toSource(loaded: LoadedPull, withContext = true): Promise<PullRequestSource> {
  const { pull, files, owner, repo } = loaded;
  return {
    url: pull.html_url,
    repository: `${owner}/${repo}`,
    number: pull.number,
    title: pull.title,
    body: (pull.body ?? "").slice(0, 3000),
    author: pull.user.login,
    madeWith: madeWithTool(pull),
    mergedAt: pull.merged_at,
    diff: buildDiff(files),
    context: withContext ? await loadContext(loaded) : "",
    owner,
    repo,
    ref: refOf(pull),
    changedFiles: files.map((file) => file.filename),
  };
}

export async function getPullRequest(url: string): Promise<PullRequestSource> {
  const parsed = parsePullUrl(url);
  if (!parsed) throw new Error("That doesn't look like a GitHub pull request URL.");
  const loaded = await loadPull(parsed.owner, parsed.repo, parsed.number);
  if (!buildDiff(loaded.files)) throw new Error("That PR has no readable code changes to turn into a puzzle.");
  return toSource(loaded);
}

/**
 * Many random merged public PRs with puzzle-sized logic (diffs only, no surrounding code yet), ordered by a quick
 * branching-logic heuristic. Several searches run in parallel. Use `addContext` on the one you pick.
 */
export async function findCandidatePullRequests(count = 50): Promise<PullRequestSource[]> {
  // Four searches of 100 (the max per page), at most two at a time: GitHub's search API has a burst ("secondary") limit
  // that parallel searches trip easily.
  // Two general searches plus one aimed at numbers and one at looks, so every kind of puzzle has candidates.
  const shuffled = (list: string[]) => [...list].sort(() => Math.random() - 0.5);
  const queries = [...shuffled(SEARCHES.general).slice(0, 2), shuffled(SEARCHES.numeric)[0], shuffled(SEARCHES.visual)[0]];
  const searched = await settleLimited(queries, 2, (query) =>
    gh<{ items: SearchItem[] }>(`/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100&page=${1 + Math.floor(Math.random() * 2)}`).then((result) => result.items),
  );
  if (searched.every((result) => result.status === "rejected")) {
    throw new Error("GitHub asked us to slow down for a few minutes. Try again soon, or paste a PR link.");
  }
  const results = searched.map((result) => (result.status === "fulfilled" ? result.value : []));
  const seen = new Set<string>();
  const items = results
    .flat()
    // Coding agents may post as bots; dependency bots never write logic worth a puzzle.
    .filter((item) => !/dependabot|renovate|github-actions/i.test(item.user.login) && !/^(ci|docs|chore|build|test|style)(\(|:|\s)/i.test(item.title))
    // Search results carry the description and author, so unsigned PRs are dropped before costing two API calls each.
    .filter((item) => madeWithTool(item))
    .filter((item) => (seen.has(item.html_url) ? false : (seen.add(item.html_url), true)))
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.ceil(count * 1.4));
  if (!items.length) throw new Error("GitHub search came back empty. Try again in a minute.");

  // At most 12 PRs load at once (2 calls each), well under GitHub's limit on simultaneous requests.
  const loaded = (
    await settleLimited(items, 12, async (item) => {
      const parsed = parsePullUrl(item.html_url);
      return parsed ? loadPull(parsed.owner, parsed.repo, parsed.number) : null;
    })
  ).map((result) => (result.status === "fulfilled" ? result.value : null));
  const best = loaded
    .filter((pull): pull is LoadedPull => Boolean(pull && pull.score > 0 && madeWithTool(pull.pull)))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
  if (!best.length) throw new Error("Couldn't find puzzle-worthy PRs this time. Try again!");
  return Promise.all(best.map((pull) => toSource(pull, false)));
}

/** Loads the code around the changes for a PR fetched without it. */
export async function addContext(pr: PullRequestSource): Promise<PullRequestSource> {
  if (pr.context) return pr;
  const loaded = await loadPull(pr.owner, pr.repo, pr.number);
  return { ...pr, context: await loadContext(loaded) };
}
