import "server-only";

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
  /** Commit the PR's code is read at (merge commit when merged, else head). */
  ref: string;
  changedFiles: string[];
};

type SearchItem = { html_url: string; user: { login: string }; title: string };
type PullFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
type Pull = {
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string };
  merged_at: string | null;
  merge_commit_sha: string | null;
  number: number;
  head: { sha: string };
};

const SEARCHES = [
  "fix in:title is:pr is:public is:merged language:TypeScript",
  "fix in:title is:pr is:public is:merged language:Python",
  "fix in:title is:pr is:public is:merged language:JavaScript",
  "fix in:title is:pr is:public is:merged language:Go",
  "fix in:title is:pr is:public is:merged language:Rust",
  "edge case in:title is:pr is:public is:merged",
  "off by one in:title is:pr is:public is:merged",
  "validation in:title is:pr is:public is:merged language:TypeScript",
];

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h)$/i;
const NOISE_FILE = /(lock|\.min\.|snap|generated|dist\/|vendor\/|__snapshots__|\.d\.ts$)/i;
const MAX_DIFF_CHARS = 18_000;
const MAX_CONTEXT_CHARS = 24_000;
const CONTEXT_FILES = 3;
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

function pick<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

/** Rough "how much branching logic is in here" score, used to prefer puzzle-worthy PRs. */
function logicScore(files: PullFile[]) {
  const code = files.filter((file) => CODE_FILE.test(file.filename) && !NOISE_FILE.test(file.filename) && file.patch);
  const changed = code.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (!code.length || changed < 6 || changed > 500) return 0;
  const patch = code.map((file) => file.patch).join("\n");
  const branches = (patch.match(/^[+-].*(\bif\b|\belse\b|\?|&&|\|\||\bswitch\b|\bcase\b|[<>]=?|===?|!==?|\bmatch\b)/gm) ?? []).length;
  return branches * 10 + Math.min(changed, 120);
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

async function toSource(loaded: LoadedPull): Promise<PullRequestSource> {
  const { pull, files, owner, repo } = loaded;
  return {
    url: pull.html_url,
    repository: `${owner}/${repo}`,
    number: pull.number,
    title: pull.title,
    body: (pull.body ?? "").slice(0, 3000),
    author: pull.user.login,
    mergedAt: pull.merged_at,
    diff: buildDiff(files),
    context: await loadContext(loaded),
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

/** Find a random merged public PR with juicy, puzzle-sized logic. */
export async function findPuzzleWorthyPullRequest(): Promise<PullRequestSource> {
  for (let round = 0; round < 3; round++) {
    const page = 1 + Math.floor(Math.random() * 5);
    const search = await gh<{ items: SearchItem[] }>(
      `/search/issues?q=${encodeURIComponent(pick(SEARCHES))}&sort=updated&order=desc&per_page=30&page=${page}`,
    );
    const humans = search.items.filter(
      (item) => !/\[bot\]|dependabot|renovate/i.test(item.user.login) && !/^(ci|docs|chore|build|test|style)(\(|:|\s)/i.test(item.title),
    );
    const candidates = humans.sort(() => Math.random() - 0.5).slice(0, 4);
    const loaded = await Promise.all(
      candidates.map((item) => {
        const parsed = parsePullUrl(item.html_url);
        return parsed ? loadPull(parsed.owner, parsed.repo, parsed.number).catch(() => null) : null;
      }),
    );
    const best = loaded.filter((pull): pull is LoadedPull => Boolean(pull && pull.score > 0)).sort((a, b) => b.score - a.score)[0];
    if (best) return toSource(best);
  }
  throw new Error("Couldn't find a puzzle-worthy PR this time. Hop again!");
}

/* ---------- Repo browsing (used as Gemini tools during research) ---------- */

const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|target|\.git|\.next|coverage|__pycache__)\/|\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|lock|min\.js|map|pdf|zip)$/i;
const MAX_TREE_PATHS = 350;
const MAX_READ_LINES = 220;

export type RepoBrowser = ReturnType<typeof createRepoBrowser>;

/** A tiny read-only view of a repo at one commit, with caching, for tool calls. */
export function createRepoBrowser(source: PullRequestSource) {
  const { owner, repo, ref } = source;
  const files = new Map<string, Promise<string>>();
  let tree: Promise<string[]> | null = null;

  function allPaths() {
    tree ??= gh<{ tree: Array<{ path: string; type: string }>; truncated: boolean }>(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`)
      .then((data) => data.tree.filter((entry) => entry.type === "blob" && !SKIP_PATH.test(entry.path)).map((entry) => entry.path))
      .catch(() => []);
    return tree;
  }

  function fileText(path: string) {
    const clean = path.replace(/^\/+/, "");
    if (!files.has(clean)) {
      const encoded = clean.split("/").map(encodeURIComponent).join("/");
      files.set(clean, ghResponse(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`, "application/vnd.github.raw+json").then((response) => response.text()));
    }
    return files.get(clean)!;
  }

  return {
    /** Repo description, README start and a file list biased towards the changed folders. */
    async overview() {
      const [info, readme, paths] = await Promise.all([
        gh<{ description: string | null; topics?: string[]; language: string | null; homepage: string | null }>(`/repos/${owner}/${repo}`).catch(() => null),
        ghResponse(`/repos/${owner}/${repo}/readme`, "application/vnd.github.raw+json").then((r) => r.text()).catch(() => ""),
        allPaths(),
      ]);
      const changedDirs = new Set(source.changedFiles.map((file) => file.split("/").slice(0, -1).join("/")));
      const near = paths.filter((path) => changedDirs.has(path.split("/").slice(0, -1).join("/")));
      const rest = paths.filter((path) => !near.includes(path));
      const listed = [...near, ...rest].slice(0, MAX_TREE_PATHS);
      return [
        `REPO: ${owner}/${repo}${info?.language ? ` (${info.language})` : ""}`,
        info?.description ? `DESCRIPTION: ${info.description}` : "",
        info?.topics?.length ? `TOPICS: ${info.topics.join(", ")}` : "",
        readme ? `README (start):\n${readme.split("\n").slice(0, 60).join("\n").slice(0, 4000)}` : "",
        `FILES (${paths.length} total, changed folders first${paths.length > listed.length ? `, first ${listed.length} shown` : ""}):\n${listed.join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    },

    async readFile(path: string, startLine = 1, endLine = startLine + MAX_READ_LINES - 1) {
      const text = await fileText(path);
      const lines = text.split("\n");
      const start = Math.max(1, Math.floor(startLine));
      const end = Math.min(lines.length, Math.floor(endLine), start + MAX_READ_LINES - 1);
      const body = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5)} | ${line}`).join("\n");
      return `${path} — lines ${start}-${end} of ${lines.length}${end < lines.length ? " (call again with start_line to read more)" : ""}\n${body}`;
    },

    async listDir(path: string) {
      const prefix = path.replace(/^\/+|\/+$/g, "");
      const paths = await allPaths();
      const children = new Set<string>();
      for (const file of paths) {
        if (prefix && !file.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? file.slice(prefix.length + 1) : file;
        const [head, ...tail] = rest.split("/");
        children.add(tail.length ? `${head}/` : head);
      }
      return children.size ? [...children].sort().slice(0, 200).join("\n") : `No entries under "${prefix}".`;
    },

    /** GitHub code search (default branch). Needs GITHUB_TOKEN. */
    async searchCode(query: string) {
      const q = encodeURIComponent(`${query} repo:${owner}/${repo}`);
      const result = await ghResponse(`/search/code?q=${q}&per_page=12`, "application/vnd.github.text-match+json")
        .then((response) => response.json() as Promise<{ items: Array<{ path: string; text_matches?: Array<{ fragment: string }> }> }>);
      if (!result.items.length) return `No matches for "${query}".`;
      return result.items
        .map((item) => `${item.path}\n${(item.text_matches ?? []).map((match) => `    ${match.fragment.replace(/\n/g, "\n    ")}`).join("\n    ...\n")}`)
        .join("\n\n")
        .slice(0, 6000);
    },
  };
}
