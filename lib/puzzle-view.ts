import type { Puzzle } from "./puzzles";

/** The puzzle's own accent colour (theme colours are [background, ink, accent, ...]). */
export function puzzleAccent(puzzle: Puzzle) {
  return puzzle.theme.colors[2] ?? "#ff4d2e";
}
