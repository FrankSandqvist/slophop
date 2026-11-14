import { drawHead, HEAD_SIZE, type MascotKind } from "./mascot";
import { drawText } from "./pixelfont";

/**
 * The SlopHop wordmark in the pixel font, with the mascots' faces as the O's: "SL(Green)P H(Red)P".
 * Shared by the stage's TV and the menu header. Coordinates are canvas pixels; `scale` is the letter size (3 = 15px tall).
 */

const ADVANCE = 4; // pixel font: 3px glyph + 1px gap
const WORD_GAP = 4;
const INK = "#1b1a22";
const WORDS: Array<{ color: string; parts: Array<string | MascotKind> }> = [
  { color: "#28c840", parts: ["SL", "add", "P"] },
  { color: "#ff4757", parts: ["H", "del", "P"] },
];
const isHead = (part: string): part is MascotKind => part === "add" || part === "del";

function partWidth(part: string, scale: number) {
  return isHead(part) ? HEAD_SIZE + scale : part.length * ADVANCE * scale;
}
function wordWidth(parts: string[], scale: number) {
  return parts.reduce((sum, part) => sum + partWidth(part, scale), 0) - scale;
}

/** Width of the wordmark, and its height including the faces' overhang, the drop shadow and room to bounce. */
export function logoSize(scale = 3, bounce = 3) {
  return {
    w: WORDS.reduce((sum, word) => sum + wordWidth(word.parts, scale), 0) + WORD_GAP + 2,
    h: Math.max(HEAD_SIZE, 5 * scale) + 2 + bounce * 2,
  };
}

/**
 * Draws the wordmark with its letters' top edge at y (the faces are centred on the letters and overhang a little).
 * `bounce` lifts the first word and drops the second; `t` makes the faces blink.
 */
export function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, options: { scale?: number; bounce?: number; t?: number } = {}) {
  const scale = options.scale ?? 3;
  const bounce = options.bounce ?? 0;
  const headTop = Math.round((5 * scale - HEAD_SIZE) / 2);
  // Two passes, shadows first, so a shadow never lands on a neighbouring letter.
  for (const pass of ["shadow", "color"] as const) {
    let cursor = x;
    WORDS.forEach((word, index) => {
      const offset = index === 0 ? bounce : -bounce;
      const shift = pass === "shadow" ? 2 : 0;
      for (const part of word.parts) {
        if (isHead(part)) {
          drawHead(ctx, part, cursor + shift, y + headTop + offset + shift, pass === "shadow" ? { silhouette: INK } : { t: options.t });
        } else {
          drawText(ctx, part, cursor + shift, y + offset + shift, pass === "shadow" ? INK : word.color, scale);
        }
        cursor += partWidth(part, scale);
      }
      cursor += WORD_GAP - scale;
    });
  }
}
