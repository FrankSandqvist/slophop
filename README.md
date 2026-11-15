# SlopHop

**Learn the logic that runs the world, see how it's changing, and weigh in.**

*My submission for Tieto's Earned Trust in AI Code challenge.*

**Play it:** https://slophop.vercel.app

## The problem

The world runs on software, and more and more of it is written by AI. Much of that code is open source: every change is public, for anyone to read. Almost nobody does. Trust in AI-written code can't just be assumed; it has to be earned by people who understand what changed. Following that used to be a coder's job. But you don't need to read code. You need to follow the logic.

## What SlopHop does

SlopHop turns real, recently merged pull requests written with AI coding tools (Claude Code, Copilot, Cursor, Codex, Devin, Jules) into short puzzles anyone can play. Never written a line of code? You're exactly who it's for.

Two pixel mascots star in every puzzle: **Red**, the code that was removed, and **Green**, the code that replaced it.

1. **Meet the change** in a 15-second PS1-style cutscene, then read Red's old rules and Green's new ones.
2. **Work it out** in three to five quick puzzles about what each of them does.
3. **Weigh in** on every case: is Green's way right? Every vote is a human sniff test on code a machine wrote.

There are five kinds: logic, math, UX, business flows, and AI guardrails. So far there are 47 puzzles, such as:

- an invoice that could still be paid after it was cancelled (flexprice);
- an AI agent that wrote its own secret keys into its notes (agentrun);
- a wing simulator that made aircraft parts eight times too heavy (TACS).

Anyone can make a new one, or paste their own pull request link, and play it about a minute later.

## How it earns trust

- **Real code only.** Every puzzle comes from a merged, review-approved PR, links to it, and is only called AI-made when it carries the AI tool's own signature.
- **Computed, not hallucinated.** Gemini runs Python copies of the old and new code, so every answer comes from running the code.
- **The AI fills in data; our code builds the game.**

## How it's built

It all runs in parallel: about 60 seconds from a fresh pull request to a game.

- **Gemini Decisions API:** ranks about 50 candidates at once.
- **Gemini 4 Argon,** with code execution: writes the rules and computes every answer.
- **Lyria:** composes the soundtrack.
- **Gemini Omni Flash:** films the cutscene.
- **Gemini with Google Search,** plus **Context.dev:** shows who the change affects in the real world.

It's a Next.js and three.js app on Vercel.

## What's next

- **Close the loop:** send the votes back to the people who approved the change and to the AI tools that wrote it.
- **Zoom out:** cover whole releases and projects, not just single changes.

**AI writes the code. SlopHop keeps you in the loop.**
**Because trust isn't merged. It's earned.**

## Run it locally

```bash
npm install
npm run dev
```

It needs `GEMINI_KEY` and `GITHUB_TOKEN` in `.env.local`. `CONTEXT_DEV_KEY` (company logos) and `BLOB_READ_WRITE_TOKEN` (Vercel Blob storage; without it, puzzles are saved to `.data/`) are optional. `AGENTS.md` describes how everything fits together. The pitch deck is in `pitch/`.
