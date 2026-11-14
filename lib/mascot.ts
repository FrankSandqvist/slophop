/**
 * The two mascots: Green (code additions) and Red (code removals).
 * The head is the exact 19x19 reference pixel map; the leg is drawn procedurally, one pixel row at a time,
 * so it can sway, bounce and step. Render the canvas scaled up with nearest-neighbour (image-rendering: pixelated).
 */

export type MascotKind = "add" | "del";
export type MascotMood = "idle" | "talk" | "dance" | "cheer" | "shake";

export const MASCOT_W = 31;
export const MASCOT_H = 172;

const HEAD = [
  ".......AAA.........",
  "....AAAAAAAAA......",
  "...AAAAAAAAAAA.....",
  "..AAAABBBBBAAAAA...",
  ".AAABBBBBBBBBAAAA..",
  "AAABBBBBBBBBBBAAAAA",
  "AAABBBBBBBBBBBBBAAA",
  "AABBBCCBBBBBBBBBBAA",
  "AABBBCCBBBBCCBBBBAA",
  "AABBBBBBBBBCCBBBBAA",
  "AABBBBBBBBBBBBBBBAA",
  "AAABBBBBBBBBBBBBBAA",
  "AAABBCCCCCBBBBBBAAA",
  ".AAABCCCCCCCCCBAAAA",
  "..AAABBBCCCCCCBAAA.",
  "..AAAABBBBBBBAAAA..",
  "...AAABBBBBAAAAAA..",
  "....AAAAAAAAAAA....",
  ".....AAAAAAAA......",
];
const HEAD_SIZE = 19;
/** Column (in head coordinates) where the leg attaches, as in the reference. */
const LEG_ATTACH = 7;
const LEG_LENGTH = 137;
const EYES = new Set(["5,7", "6,7", "5,8", "6,8", "11,8", "12,8", "11,9", "12,9"]);
const MOUTH_TOP = 12;

export const PALETTES: Record<MascotKind, { outline: string; fill: string; ink: string }> = {
  add: { outline: "#027d0a", fill: "#82dc88", ink: "#000000" },
  del: { outline: "#8a0c14", fill: "#f08890", ink: "#000000" },
};

type Options = {
  /** Beats per minute for dancing. */
  bpm?: number;
  /** Phase offset so the two mascots don't move in lockstep. */
  seed?: number;
  /** The music's position in beats (whole numbers = the kick). Overrides bpm × t, so dancing follows the track. */
  beat?: number;
};

export { HEAD_SIZE };

/**
 * Just a mascot's head, at (x, y), for logos and badges. Red is mirrored like his body (the two face each other).
 * Pass `t` (seconds) to let them blink; `silhouette` paints every pixel one colour (for drop shadows).
 */
export function drawHead(ctx: CanvasRenderingContext2D, kind: MascotKind, x: number, y: number, options: { t?: number; silhouette?: string } = {}) {
  const palette = PALETTES[kind];
  const seed = kind === "add" ? 0 : 1.7;
  const blinking = options.t !== undefined && (options.t + seed * 2.3) % 4.2 < 0.13;
  for (let row = 0; row < HEAD_SIZE; row++) {
    for (let column = 0; column < HEAD_SIZE; column++) {
      const source = kind === "del" ? HEAD_SIZE - 1 - column : column;
      let cell = HEAD[row][source];
      if (cell === ".") continue;
      if (blinking && EYES.has(`${source},${row}`)) cell = (source < 9 && row === 8) || (source > 9 && row === 9) ? "C" : "B";
      ctx.fillStyle = options.silhouette ?? (cell === "A" ? palette.outline : cell === "B" ? palette.fill : palette.ink);
      ctx.fillRect(x + column, y + row, 1, 1);
    }
  }
}

/**
 * Draws one frame of a mascot into a MASCOT_W x MASCOT_H context. `t` is in seconds.
 * Red (removals) is mirrored so the two face each other.
 */
export function drawMascot(ctx: CanvasRenderingContext2D, kind: MascotKind, t: number, mood: MascotMood, options: Options = {}) {
  const palette = PALETTES[kind];
  const seed = options.seed ?? (kind === "add" ? 0 : 1.7);
  const beat = options.beat ?? ((options.bpm ?? 96) / 60) * t;
  const beatPhase = beat - Math.floor(beat);

  // Body motion per mood.
  let sway = 1.4;
  let swaySpeed = 1.1;
  let squash = 0;
  let hop = 0;
  let jitter = 0;
  if (mood === "dance") {
    sway = 3;
    swaySpeed = 0;
    squash = Math.round(6 * Math.pow(1 - beatPhase, 3));
  } else if (mood === "cheer") {
    sway = 2;
    swaySpeed = 2.4;
    hop = Math.round(12 * Math.abs(Math.sin(t * 6)));
  } else if (mood === "shake") {
    sway = 1;
    jitter = Math.round(Math.sin(t * 60)) ;
  } else if (mood === "talk") {
    sway = 1.8;
    swaySpeed = 1.6;
  }

  const legLength = LEG_LENGTH - squash;
  const footY = MASCOT_H - 1 - hop;
  const legTopY = footY - legLength + 1;
  const headTopY = legTopY - HEAD_SIZE;
  const baseX = 11;
  const phase = mood === "dance" ? Math.sin(beat * Math.PI) * 1.2 : t * swaySpeed + seed;

  /** Leg centre x at s (0 = hip, 1 = foot): an S-curve that swings most near the hip, plus the curled foot. */
  const legX = (s: number) => {
    const swing = sway * Math.sin(2 * Math.PI * 0.85 * s + phase) * (1 - s * 0.85);
    const curl = s > 0.88 ? Math.pow((s - 0.88) / 0.12, 2) * 5 : 0;
    const settle = -2.5 * Math.sin(Math.PI * Math.min(1, s * 1.15));
    return baseX + swing + curl + settle;
  };

  ctx.clearRect(0, 0, MASCOT_W, MASCOT_H);
  ctx.save();
  if (kind === "del") {
    ctx.translate(MASCOT_W, 0);
    ctx.scale(-1, 1);
  }

  // Leg: 2px wide; where it steps sideways, fill the gap so the line stays connected (the reference's 3px rows).
  const spans: Array<[number, number]> = [];
  let previous = Math.round(legX(0));
  for (let i = 0; i < legLength; i++) {
    const x = Math.round(legX(i / (legLength - 1)));
    spans.push([Math.min(x, previous), Math.max(x, previous) + 1]);
    previous = x;
  }
  const headX = Math.round(legX(0)) - LEG_ATTACH + jitter;

  ctx.fillStyle = palette.ink;
  spans.forEach(([from, to], i) => ctx.fillRect(from, legTopY + i, to - from + 1, 1));

  // Head, attached to the top of the leg.
  const blinking = (t + seed * 2.3) % 4.2 < 0.13;
  const mouthClosed = mood === "talk" && Math.floor(t * 9) % 2 === 0;
  for (let y = 0; y < HEAD_SIZE; y++) {
    for (let x = 0; x < HEAD_SIZE; x++) {
      let cell = HEAD[y][x];
      if (cell === ".") continue;
      if (blinking && EYES.has(`${x},${y}`)) cell = (x < 9 && y === 8) || (x > 9 && y === 9) ? "C" : "B";
      if (mouthClosed && cell === "C" && y >= MOUTH_TOP && y !== 13) cell = "B";
      ctx.fillStyle = cell === "A" ? palette.outline : cell === "B" ? palette.fill : palette.ink;
      ctx.fillRect(headX + x, headTopY + y, 1, 1);
    }
  }
  ctx.restore();
}
