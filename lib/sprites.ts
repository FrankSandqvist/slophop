import "server-only";
import { deflateSync } from "node:zlib";
import { drawMascot, MASCOT_H, MASCOT_W, PALETTES, type MascotKind } from "./mascot";

/**
 * Renders the real mascot pixel art to PNGs on the server, so the video model can see exactly what Green and Red look
 * like (reference images). Uses drawMascot through a tiny pixel-buffer stand-in for a canvas context.
 */

const BACKGROUND: [number, number, number] = [214, 214, 220];

/** Just enough of CanvasRenderingContext2D for drawMascot: fillRect / clearRect with a horizontal mirror. */
class PixelContext {
  fillStyle = "#000000";
  private mirror = 0;
  readonly pixels = new Uint8Array(MASCOT_W * MASCOT_H * 4);

  save() {}
  restore() {
    this.mirror = 0;
  }
  translate(x: number) {
    this.mirror = x;
  }
  scale() {}
  clearRect() {
    this.pixels.fill(0);
  }
  fillRect(x: number, y: number, width: number, height: number) {
    const hex = this.fillStyle.replace("#", "");
    const rgb = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const px = this.mirror ? this.mirror - 1 - (x + dx) : x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= MASCOT_W || py >= MASCOT_H) continue;
        this.pixels.set([...rgb, 255], (py * MASCOT_W + px) * 4);
      }
    }
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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
/** Minimal RGB PNG encoder. */
function png(width: number, height: number, rgb: Uint8Array) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Crops [x0, y0, w, h] of the sprite, scales it up by `scale` with hard pixels and centres it on a padded plain canvas. */
function render(pixels: Uint8Array, crop: [number, number, number, number], scale: number, width: number, height: number) {
  const [x0, y0, w, h] = crop;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(BACKGROUND, i * 3);
  const left = Math.floor((width - w * scale) / 2);
  const top = Math.floor((height - h * scale) / 2);
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const source = ((y0 + Math.floor(y / scale)) * MASCOT_W + x0 + Math.floor(x / scale)) * 4;
      if (pixels[source + 3] === 0) continue;
      rgb.set(pixels.subarray(source, source + 3), ((top + y) * width + left + x) * 3);
    }
  }
  return png(width, height, rgb);
}

/** Two reference PNGs per mascot: the full figure (head on its one long leg) and a close-up of the head. */
export function mascotReferences(kind: MascotKind) {
  const context = new PixelContext();
  drawMascot(context as unknown as CanvasRenderingContext2D, kind, 0, "idle");
  const { pixels } = context;
  const rows = Array.from({ length: MASCOT_H }, (_, y) => Array.from({ length: MASCOT_W }, (_, x) => pixels[(y * MASCOT_W + x) * 4 + 3]).some(Boolean));
  const top = Math.max(0, rows.indexOf(true));
  // Columns the head covers, found from its outline colour.
  const outline = PALETTES[kind].outline.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(outline.slice(offset, offset + 2), 16));
  const headColumns = Array.from({ length: MASCOT_W }, (_, x) =>
    Array.from({ length: 19 }, (_, dy) => (top + dy) * MASCOT_W + x).some((i) => pixels[i * 4] === r && pixels[i * 4 + 1] === g && pixels[i * 4 + 2] === b),
  );
  const left = headColumns.indexOf(true);
  const right = headColumns.lastIndexOf(true);
  return [
    { data: render(pixels, [0, 0, MASCOT_W, MASCOT_H], 5, 360, 900), mimeType: "image/png" },
    { data: render(pixels, [left, top, right - left + 1, 19], 16, 400, 400), mimeType: "image/png" },
  ];
}
