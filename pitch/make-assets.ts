/**
 * Renders the pitch deck's pixel art from the game's own drawing code (lib/mascot.ts, lib/logo.ts): transparent PNGs,
 * scaled up with hard pixels. Run from the repo root: npx tsx pitch/make-assets.ts
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { drawHead, drawMascot, HEAD_SIZE, MASCOT_H, MASCOT_W, type MascotKind, type MascotMood } from "../lib/mascot";
import { drawLogo, logoSize } from "../lib/logo";

const OUT = new URL("./assets/", import.meta.url).pathname;

/** Just enough of a canvas context for the game's drawing code, with alpha and the horizontal mirror Red uses. */
class Pixels {
  fillStyle = "#000000";
  private mirror = 0;
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint8Array(w * h * 4);
  }
  save() {}
  restore() {
    this.mirror = 0;
  }
  translate(x: number) {
    this.mirror = x;
  }
  scale() {}
  clearRect() {
    this.data.fill(0);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const hex = this.fillStyle.replace("#", "");
    const rgb = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const px = this.mirror ? this.mirror - 1 - (x + dx) : x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < this.w && py < this.h) this.data.set([...rgb, 255], (py * this.w + px) * 4);
      }
    }
  }
  get ctx() {
    return this as unknown as CanvasRenderingContext2D;
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Saves an RGBA PNG cropped to the drawn pixels, each pixel scaled to a `scale` x `scale` block. */
function save(name: string, image: Pixels, scale: number) {
  let x0 = image.w, y0 = image.h, x1 = -1, y1 = -1;
  for (let y = 0; y < image.h; y++) {
    for (let x = 0; x < image.w; x++) {
      if (!image.data[(y * image.w + x) * 4 + 3]) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  const W = (x1 - x0 + 1) * scale;
  const H = (y1 - y0 + 1) * scale;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      const i = ((y0 + Math.floor(Y / scale)) * image.w + x0 + Math.floor(X / scale)) * 4;
      raw.set(image.data.subarray(i, i + 4), Y * (W * 4 + 1) + 1 + X * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(W, 0);
  header.writeUInt32BE(H, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(`${OUT}${name}.png`, png);
  console.log(`${name}.png ${W}x${H}`);
}

const NAMES: Record<MascotKind, string> = { add: "green", del: "red" };
// A still moment of each mood: cheer at the top of its hop, talk with the mouth open.
const POSES: Array<[MascotMood, number]> = [["idle", 0.6], ["talk", 0.15], ["cheer", Math.PI / 12], ["shake", 0.31]];

for (const kind of ["add", "del"] as MascotKind[]) {
  for (const [mood, t] of POSES) {
    const image = new Pixels(MASCOT_W, MASCOT_H);
    drawMascot(image.ctx, kind, t, mood, { bpm: 96 });
    save(`${NAMES[kind]}-${mood}`, image, 6);
  }
  const head = new Pixels(HEAD_SIZE, HEAD_SIZE);
  drawHead(head.ctx, kind, 0, 0);
  save(`${NAMES[kind]}-head`, head, 24);
}

const size = logoSize(3, 0);
const logo = new Pixels(size.w + 4, size.h + 8);
drawLogo(logo.ctx, 0, 4, { scale: 3, bounce: 0 });
save("logo", logo, 12);
