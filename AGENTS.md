# SlopHop — Working Notes for Agents

Keep this file current as SlopHop evolves. It is the shared project brief and should describe what is true now, not aspirational architecture.

## Product

SlopHop helps a human feel safe (or rightly unsafe) merging a possibly AI-written pull request. Each PR becomes an intuitive, playable model of the change. Curious non-coders play it and answer a small, **standardized** set of judgments; those add up to a crowd review with a merge signal that can be pasted into the PR.

Flow:

1. **"New puzzle"** (or a pasted PR URL) picks a real, merged, public GitHub PR with puzzle-sized branching logic.
2. **Research** (`lib/research.ts`, Gemini 4 Hydrogen): browses the repo with our own tools (`read_file`, `search_code`, `list_dir`, pinned to the PR's commit, using `GITHUB_TOKEN`) for ≤6 turns / 50s (hard stop 90s), then returns notes via `finish_research`. Built-in `url_context` is not a substitute: it can't list/search a repo, is capped at 20 known URLs and isn't commit-pinned.
3. **Design** (Gemini 4 Carbon, structured JSON): ONE puzzle game: a one-line briefing + `promise` + `system` chain; its own `artDirection` (no predefined styles; recent games' names are passed so it differs); one core `mechanic` (a few shuffled ideas from `lib/catalog.ts` as inspiration); `rulesBefore`/`rules`; 4–6 `levels` with setup + intended solution, one per beat (`intro`?, `fix`, `tradeoff-0`?, `case-N`, `hunt` last); judged subjects (`solved`, ≤1 `tradeoffs`, 1–2 `cases`) with the AI's hidden views; `codeSpots` (resolved against the real diff); 4 sprites + cover prompt.
4. **Build** (Gemini 4 Argon, high thinking): started as a **background interaction** (`background: true`, up to 65,536 output tokens) so long, careful builds aren't capped by the 32,768-token foreground limit or Vercel's function timeout. Art (`gemini-nano-banana-2.1`) and Lyria music run in the request meanwhile. The puzzle is saved as `status: "building"`; `advanceBuild()` (called by `GET /api/puzzles/[id]/status`, the shelf and the play page) collects the result, runs `checkGame`, and starts up to two repair/retry passes.
5. **Play** (`app/play/[id]`): briefing → the game (served from `/api/puzzles/[id]/game` with a sandboxing CSP header) → standardized judgment cards raised by the game → hunt → summary with the crowd review and "Copy as PR comment". Calm: no timers anywhere.

Puzzles carry `format: 5`; anything older is hidden (no backwards compatibility).

SlopHop never approves code itself, never labels a PR as AI-generated, and does not imply PR author endorsement.

## Standardized outcome (`lib/review.ts`)

Question keys and answers (asked by the host, never by the game):

| Key | Question | Answers |
|---|---|---|
| `fix` | Did the change fix it? | `works` / `partly` / `no` |
| `tradeoff-<i>` | Is this tradeoff worth it? | `worth` / `unsure` / `not` |
| `case-<i>` | Could this happen for real? | `likely` / `rare` / `never` |

Plus the free-hunt verdict (`holds` / `breaks` + evidence). `buildReport()` turns tallies into findings (good/warn/bad) and a signal: `safe`, `caution`, `risky`, or `unknown` (<3 fix votes), plus PR-comment markdown. The AI's answer is shown after the player answers, for comparison.

## Stack and layout

- Next.js 16 App Router + TypeScript, plain CSS in `app/globals.css`.
- `lib/style.ts` — app tokens (`--sh-*`, clean thin-line look), `gameCraft` (shared craft bar; each game picks its own theme), `musicDirection`. The owner is putting their own touch on the app style: keep it minimal and easy to edit.
- `lib/gemini.ts` — REST client for the Gemini Interactions API (`POST /v1beta/interactions`, `Api-Revision: 2026-05-20`): text, structured JSON, background interactions (`startBackground`/`getBackground`), images, music, and `runToolLoop()` (function calling via `previous_interaction_id`, parallel calls, forced finish when out of budget). Gemini 4 rules: no sampling params, thinking `low|medium|high` (+`xhigh` on Hydrogen), `max_output_tokens` covers thinking + output, foreground calls capped at 32,768 on Argon/Carbon. Retries/fallbacks across Gemini 4 models on 429/5xx.
- `lib/github.ts` — PR search, diff, excerpts and `createRepoBrowser()` (overview, read file, list dir, code search). Random picks are NOT filtered for AI authorship yet.
- `lib/research.ts` — the research agent and its notes.
- `lib/puzzles.ts` — design/build prompts, pipeline, storage of puzzles, verdicts and judgments, `wrapGame()`.
- `lib/review.ts` — client-safe: questions, answers, AI answers, report.
- `lib/puzzle-view.ts` — client-safe display helpers incl. early-format puzzles.
- `lib/catalog.ts` — mechanic ideas offered as inspiration (no art styles: games invent their own).
- `components/` — `PuzzlePlayer` (iframe host), `Briefing`, `SystemStrip`, `CodePeek` (contextual "why?" tag + card), `JudgeCard`, `Summary`, `ReviewPanel`, `BuildWatcher`, `useSoundtrack`, `Generator`, `PuzzleCard`, `Frog`. Overlays become bottom sheets on phones.
- API: `POST /api/puzzles` (NDJSON progress stream, `maxDuration` 300), `GET /api/puzzles/[id]/game`, `GET /api/puzzles/[id]/status` (advances background builds), `GET /api/puzzles/[id]/assets/[cover|sprites]`, `GET /api/puzzles/[id]/music`, `POST /api/puzzles/[id]/verdicts`, `POST /api/puzzles/[id]/judgments` (`{ key, answer, detail }`).

Storage (answer in the path so tallies need only a list call): `puzzles/{id}/{meta.json,game.html,cover.jpg,sprites.jpg,music.mp3}`, `verdicts/{id}/{holds|breaks}/{ts}-{rand}.json`, `judgments/{id}/{key}/{answer}/{ts}-{rand}.json`.

## Game contract (generated HTML)

- Sandboxed by CSP header (`sandbox allow-scripts`, opaque origin) and the iframe `sandbox`. CSP allows inline code, Google Fonts, three.js r170 (import map) and images from our origin. No network.
- `await SlopHop.started` (sent when the briefing closes). No start or title screen.
- One core mechanic across 4–6 levels; direct manipulation via pointer events; ≤6 buttons; calm (no timers, lives or failure screens).
- After each judged level: `await SlopHop.judge("fix")`, `("tradeoff", 0)`, `("case", i, { outcome, brokePromise })`. The hunt ends with `SlopHop.verdict({ verdict, evidence, score })`.
- Code peeks are contextual: `SlopHop.peek(id, element, "what just happened")` only right AFTER the player saw that effect. The host shows a "why?" tag at the element; the player taps it for what happened → why → the real diff. Never auto-opens.
- Standard elements (injected, styleable via `--sh-ui-*` CSS vars): `<sh-promise>` (+ `SlopHop.promise("ok"|"strained"|"broken")`), `<sh-switch old new>` (old/new code switch, `change` event), `<sh-goal level>`, `<sh-hint>`, `<sh-progress total current>`.
- `SlopHop.sfx(name)` procedural sound kit; `SlopHop.assets.cover` / `SlopHop.sprite(i)` generated art with required fallbacks.
- Art direction is the game's own; craft bar in `STYLE.gameCraft`; text per `STYLE.plainLanguage`. Fun and witty for adults, never childish.
- Game → host: `{ source: "slophop", type: "judge" | "peek" | "verdict" }`. Host → game: `{ source: "slophop-host", type: "start" | "judged" | "mute" }`.

## Rules

- Keep `GEMINI_KEY`, `GITHUB_TOKEN`, `BLOB_READ_WRITE_TOKEN` server-side. Never call Gemini, GitHub or Blob from the client.
- Treat generated game HTML as untrusted: always serve it through `wrapGame()` inside the sandboxed iframe.
- Keep a source link to the PR on every puzzle.
- Keep the UI accessible: semantic HTML, real buttons/labels, visible focus, reduced-motion support.
- Generation costs money (Gemini + Lyria). Discuss before adding auto-generation, crawlers, or removing the human-pressed button.
- The owner does visual QA; agents should test logic (typecheck, lint, API/script runs), not take screenshots.

## Commands

```bash
npm install
npm run dev
npm run lint
npm run build
```

Copy `.env.example` to `.env.local`. Lyria requires a paid-tier Gemini key; without it puzzles are saved without music.

## Known gaps / next steps

- No auth or rate limiting on generation, judgments or verdicts (anyone can trigger paid generation or stuff votes).
- The request takes ~1.5–2 min (research, design, art, music); the background build adds a few minutes, more if a repair pass runs. Two concurrent pollers could both start a repair (harmless but wasteful).
- Random PR picks aren't restricted to AI-authored PRs (proposed: provenance signals like "Generated with Claude Code", Copilot/Devin authors).
- `checkGame()` is a static heuristic (regex), not a play-test; a game can pass and still be confusing.
