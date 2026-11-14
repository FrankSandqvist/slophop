# SlopHop — Working Notes for Agents

Keep this file current as SlopHop evolves. It describes what is true now.

## Product

SlopHop shows curious people what is changing in the public software around them, as tiny brain teasers.
Every puzzle is built from one real, public GitHub pull request, cut down to one small change, so players'
answers and votes can be crowdsourced per case. Three kinds ("families", `lib/families.ts` for the last two):
- **logic** — conditions decide an outcome (truth table).
- **numeric** — a calculation over one real input (price, fee, rounding, duration...), sampled by running Python.
- **visual** — how a small screen looks before/after in 3-4 situations, described as shapes and drawn by our `MockScreen`.

Two mascots star in everything:
- **Green** = code the PR **added**.
- **Red** = code the PR **removed**.

They are pixel-art (exact 19x19 head from the reference + a procedurally drawn 2px leg), rendered at native size and
scaled up with nearest-neighbour. Look and feel: PS1 / Nintendo DS shading, Parappa the Rapper vibes, two-screen handheld UI.

## How a puzzle is made (`lib/puzzles.ts`)

Everything that can run in parallel does:

1. `findCandidatePullRequests(50)` (`lib/github.ts`): four GitHub searches (100 results each, two at a time: the search API
   has a burst limit) for recent merged PRs **made with AI
   coding tools**, found by each tool's own signature (Claude Code footer, Copilot / Devin / Jules agent authors, Codex task
   links, Cursor footer); every result is re-checked with `madeWithTool` before loading and dropped without a real signature
   (search matches loosely). Dependency bots and chore PRs filtered out; ~70 loaded with diffs, 12 at a time (`settleLimited`,
   `lib/limit.ts`; ~140 GitHub calls of the 5,000/hour budget), top 50 by a branching-logic heuristic (no surrounding code yet). A pasted PR URL skips this. (~8s)
2. **Rank with the Gemini Decisions API** (`gemini-decision-1`, `POST /v1beta/decisions`, `decide()` in `lib/gemini.ts`): one call
   per candidate, 10 at a time, asking calibrated rubric/yes-no questions (logic, small & self-contained, relatable, plain,
   noise) plus which kind of puzzle it makes (`kind`: logic / numeric / visual / none). Combined into a 0–1 score.
   `chooseCandidate` aims for a random kind (`FAMILY_WEIGHTS` 40/30/30; `PUZZLE_FAMILY` env forces one for tests) and takes
   the best PR that clearly fits it, else the best PR overall as its own kind. Falls back to the heuristic order if the API fails. (a few seconds for 50)
3. **In parallel from here:** `designFlair` (`gemini-4-hydrogen`, low thinking) writes the project's music line (lead
   instrument and sounds, ≤40 words), picks a tempo that fits the project (76–132 BPM, saved as `bpm`) and two **props** built from PS1 primitives (`PropSpec`: box/cylinder/sphere/cone/torus parts,
   clamped by `cleanProps`); then Lyria composes the loop (`composeMusic`): that line up front over the same base every time (90s
   PlayStation rhythm-game, lo-fi hip hop, seamless) at that tempo. (~15s) The same call writes a 15s **cutscene** script (3–4 beats:
   time, speaker, one plain line about the change, what we see), and **Gemini Omni Flash** (`generateVideo`, `gemini-omni-1.2-flash`,
   360p, 15s, ≈$0.35; Veo is retired in the Gemini API) films it as a 1998 PlayStation FMV with the real mascot sprites as
   reference images (`lib/sprites.ts` renders them to PNG), timecoded from the beats, no on-screen text. The prompt
   insists the mascots are a head on one stick leg (no arms, hands, torso or second leg) and act with their heads. (~40s, runs alongside
   the modelling; saved as `fmv.mp4`.) Meanwhile `addContext()` loads the code around the winner's changes.
4. **Model** (`gemini-4-argon`, background interaction, JSON schema; `DESIGNS` picks prompt/schema/validator per kind; numeric
   and logic use `code_execution`). A numeric/visual design that fails validation falls back to logic. For logic it picks the smallest meaningful decision,
   writes **rulebooks** (Red's old rules, Green's new rules, plain "If…, then…" lines that let a player derive every case), the
   scene (`where`, `scenario`, condition explanations, a story phrase per value), and fills the full truth table by **running
   Python** old()/new() models. **Hedged:** if Argon hasn't answered in 40s (or fails), `gemini-4-hydrogen` starts in parallel and
   the first valid answer wins (`modelHedged`). (~30–50s)
5. Our code validates the table, cuts the real diff lines (`resolveCode`) and **builds the rounds itself** (`buildRounds`).
   Gemini never writes UI, styles or game code. Saved as `puzzles/{id}/meta.json` (+ `music.mp3`), `format: 6`.

Progress events carry the top-5 ranked cards (with scores) and drive the top-screen show. The home screen shows a stage
progress bar (`PROGRESS`), queues dialogue so every line can be read, stages a drawn-out winner reveal, and fills the long
modelling wait with kind-specific banter. `FMV=off` skips the cutscene (cheap test runs). A run takes ~60s (the cutscene finishes last).

## Playing

- Home (`components/HomeDS.tsx`): DS shell, PS1 stage with both mascots dancing, dialogue box, menu of puzzles, "+ New puzzle"
  (progress narrated by Green and Red), optional PR link. While generating, the stage puts on a show (`StageShow` modes):
  fetching (billboard types the PR list, 5 PR cards drop in) → reading (real diff lines scroll in green/red, cards hop, +/− rain)
  → picked (the winner hops onto the stage, the rest sink) → modelling (a truth table fills in, faster beat) → done (confetti).
  `/?demo` plays the whole show with sample data and no API calls. Intro music: a random puzzle's track, from the first tap.
- Tutorial (`components/HowToPlay.tsx`), on the landing page: first visit only (localStorage `slophop-tutorial-done`), Red, Green
  and SlopHop explain the game on the top screen while a How to play card in the menu lights up step by step (including making
  your own puzzle from a real AI-made PR); "?" replays it.
- Play (`components/PlayDS.tsx`): the cutscene, if the puzzle has one (`components/Fmv.tsx`: drawn into a ~256px canvas with
  the stage's dither + 15-bit colour, whole-number scale, its lines typed into the text box at their times, tap to skip), then intro dialogue (project, where the code lives, the scene, the change, Red's and Green's lines,
  each condition explained, the decision) with the PR card and the rulebooks as speech bubbles (Red's head + his old rules,
  Green's head + his new ones; changed lines tagged NEW / GONE, unchanged ones dimmed); rounds describe their case as a story built from each value's
  `story` phrase; a "?" glossary lists every condition and outcome →
  3–5 rounds on the bottom screen → end screen with score, "where players doubt Green", the real diff and the PR link.
- Every step is ONE decision that fits the fixed bottom screen and can be reasoned out from the rulebooks (shown on the intro and
  behind the "Rules" button). Round kinds (`lib/types.ts`, chosen by `buildRounds`):
  - `predict` — given a case, what does Green (or, for `side: "old"`, Red) do?
  - `who` — given a case and a result: Red's old rules or Green's new ones?
  - `tweak` — from a case where they agree, which ONE "what if…" change makes them disagree (or makes Green hit a bad outcome)?
  - `pattern` — a mini table of solved neighbouring cases and a mystery row: what goes in the "?"
  - `edge` — along an ordered condition, tap the gap where Green changes its mind.
  - `odd` — odd one out: three cases end the same with Green, one doesn't.
  - `rule` — finish Green's rule: "when ___, I always end at X" (only rules that really hold).
  - `pivot` — in this case only one condition decides Green's outcome: which?
  - `claim` — Red claims "when X is Y, Green always does Z"; true or false.
  Order: apply a rule → where the change bites (tweak) → shuffled mix → try to break it (tweak to a bad outcome).
  Each step shows the rules it is about as the owner's speech bubble (`RuleBubble`: Green's, Red's for "what did Red do", both
  for `who`) above a case box tagged THE CASE. If a step would overflow, PlayDS adds `.dense` (tighter padding), then `.no-rules`
  (the bubble becomes a one-line "tap to read" strip), then `.denser` (drops the strip and `.can-hide`, e.g. one spare pattern row).
  `/play/{id}?round=N` jumps to step N; `&qa` logs whether the step overflows (`&qa=answer` also auto-answers).
- Numeric steps (`components/Families.tsx`): `num-predict` (key Green's/Red's result into a Brain Age style `Keypad`),
  `num-diff` (how much more Green gives), `num-split` / `num-reach` (drag a marker along the `NumberLine` pixel chart: where
  Green starts to differ, where it first hits a target; Green's line appears after answering).
- Visual steps: `vis-which` (two mock screens: which is Green's?) and `vis-spot` (tap what changed in Green's picture; then it
  flips between before and after with the change outlined). One step per situation (seeing both gives the next answer away).
- Crowd signal: after each reveal, "Is Green's way right for this case?" → `votes/{id}/{rowKey}/{right|off}/{ts}.json`.

## Enforced components and style

- `lib/mascot.ts` — pixel data + `drawMascot(ctx, kind, t, mood)`; moods: idle, talk, dance, cheer, shake.
- `components/PS1Stage.tsx` — three.js at ~256 wide, at a whole-number device-pixel scale (render size adapts to the box): vertex snapping, Gouraud vertex lighting, affine UVs, 4×4 ordered dither,
  15-bit colour, fog; checkerboard floor, pink stage, beat-thumping speakers, floating +/−, a dark-grey pixel-text "TV" (lighter than
  the mascots' black legs, so they still read in front of it), PR cards, +/− rain, confetti; mascots as
  paper-thin billboards. Driven by a mutable `StageState` ref (moods, bpm, `show`).
- `lib/pixelfont.ts` — hand-drawn 3×5 pixel font (`drawText`) for crisp text on tiny canvases.
- `components/DS.tsx` — `DSShell` (two screens + hinge), `TextBox` (typewriter dialogue, name tags GREEN/RED/SLOPHOP), `Mascot`.
- `components/Rounds.tsx` — `InputTiles`, `Outcomes`, `OutcomeCards`, `WhoPick`, `Vote`, `CodeCard`.
- Screens: top 4:3, bottom 25:23, fixed; on desktop the handheld is sized from the window height so the page never scrolls; on
  phones it is exactly one viewport. Puzzle steps never scroll; info panels (intro, rules, end, home menu) may.
- `app/globals.css` — all tokens and components (pixel buttons, controls, cases, dialogue, code). Font: DotGothic16, only at
  16/32/48px so every dot is a whole pixel (no letter-spacing, no synthetic bold). Colour rule: green and red ONLY mean Green
  (new code / added lines) and Red (old code / removed lines); feedback and actions use yellow, ink and greys.
  On phones the shell disappears and the two screens fill the viewport.
- `lib/sound.ts` — shared AudioContext: gapless music loop, chiptune UI blips, mute. `musicBeat()` is a beat clock at the puzzle's
  `bpm` (96 for older puzzles) from the track's start, restarting each loop; the stage and every mascot dance to it. `loopable` makes
  the clip loop cleanly: trims MP3 padding and any fade-out, cuts to whole bars at `bpm`, and crossfades the seam. Lyria clip has
  no tempo setting, so the tempo is only asked for in the prompt and can be a little off. `voice(who, char)`: Animal
  Crossing-style babble per letter, Green high and chirpy, Red low and gruff, with a rise at the end of questions.

## Stack

- Next.js 16 App Router + TypeScript, three.js 0.170, plain CSS.
- `lib/gemini.ts` — Interactions API (`Api-Revision: 2026-05-20`): `generateJson` (background + polling, optional built-in tools,
  robust JSON extraction), `generateMusic`. Gemini 4: no sampling params, thinking `low|medium|high`.
- `lib/storage.ts` — Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, else local `.data/`.
- API: `POST /api/puzzles` (NDJSON progress), `GET /api/puzzles/[id]/music`, `GET /api/puzzles/[id]/fmv`, `POST /api/puzzles/[id]/votes`.

## Rules

- Keep `GEMINI_KEY`, `GITHUB_TOKEN`, `BLOB_READ_WRITE_TOKEN` server-side.
- Gemini only fills data (`lib/types.ts`). New visuals or mechanics are added as our own components, not generated code.
- Keep every puzzle about ONE small decision so votes map to concrete cases.
- Keep a link to the real PR on every puzzle. Only say a PR was made with an AI tool when its own signature says so
  (`pr.madeWith`, from `madeWithTool`); never guess from style.
- Generation costs money (Gemini + Lyria + Omni video ≈$0.35). Never backfill cutscenes for older puzzles. Discuss before adding auto-generation or crawlers.
- The owner does visual QA; agents test logic (typecheck, lint, scripted pipeline runs), not screenshots.

## Commands

```bash
npm install
npm run dev
npm run lint
npm run build
```

## Known gaps

- No rate limiting on generation or votes.
- The truth table / sampled numbers are only as faithful as Gemini's Python model of the diff; nothing cross-checks them.
- Visual puzzles are Gemini's reading of CSS/markup drawn as shapes; nothing renders the real code.
- Puzzles where nothing changes behaviour (pure refactors) produce weaker rounds.
