"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { musicBeat } from "@/lib/sound";
import { drawMascot, MASCOT_H, MASCOT_W, type MascotKind, type MascotMood } from "@/lib/mascot";
import { drawGlyphs } from "@/lib/logo";
import { drawText, LINE, textWidth } from "@/lib/pixelfont";
import type { PropSpec, StageCard } from "@/lib/types";

/** What happens on stage while a puzzle is made (or "idle" for a calm backdrop). */
export type ShowMode = "idle" | "fetching" | "reading" | "picked" | "modelling" | "done" | "error";
export type StageShow = {
  mode: ShowMode;
  cards: StageCard[];
  picked: number | null;
  headline: string;
  beat: boolean;
  /** Two Gemini-designed props for this project, built from primitives in the PS1 style. */
  props?: PropSpec[];
};

/** Read every frame, so callers mutate it instead of re-rendering. */
export type StageState = { add: MascotMood; del: MascotMood; bpm: number; show?: StageShow };

/**
 * Target DS top-screen resolution. The real render size is picked so each art pixel is a whole number of device
 * pixels (no uneven columns), filling the screen: roughly 256 wide, at an integer scale.
 */
const LOW_W = 256;
const LOW_H = 192;

const VERTEX = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform float uLit;
varying vec3 vColor;
varying vec2 vUvAffine;
varying float vW;
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * mv;
  // PS1 vertex snapping: positions land on the low-res pixel grid, so geometry wobbles.
  vec2 grid = uRes * 0.5;
  clip.xy = floor(clip.xy / clip.w * grid + 0.5) / grid * clip.w;
  gl_Position = clip;
  // Gouraud: lighting per vertex, interpolated across the face.
  vec3 n = normalize(mat3(modelMatrix) * normal);
  float diffuse = max(dot(n, normalize(uLightDir)), 0.0);
  vColor = mix(color, color * (uAmbient + (1.0 - uAmbient) * diffuse), uLit);
  // Affine texture mapping (no perspective correction), like the PS1.
  vUvAffine = uv * clip.w;
  vW = clip.w;
  vDepth = -mv.z;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uUseMap;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFog;
varying vec3 vColor;
varying vec2 vUvAffine;
varying float vW;
varying float vDepth;
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
void main() {
  vec4 color = vec4(vColor, 1.0);
  if (uUseMap > 0.5) {
    vec4 tex = texture2D(uMap, vUvAffine / vW);
    if (tex.a < 0.5) discard;
    color.rgb *= tex.rgb;
  }
  color.rgb = mix(color.rgb, uFogColor, smoothstep(uFogNear, uFogFar, vDepth) * uFog);
  // Ordered dither, then crush to 15-bit colour.
  color.rgb += (bayer4(gl_FragCoord.xy) - 0.5) / 31.0;
  color.rgb = floor(color.rgb * 31.0 + 0.5) / 31.0;
  gl_FragColor = color;
}`;

const C = {
  skyTop: new THREE.Color("#5ab8ff"),
  skyLow: new THREE.Color("#d9f3ff"),
  fog: new THREE.Color("#c9ecff"),
  green: new THREE.Color("#28c840"),
  red: new THREE.Color("#ff4757"),
  yellow: new THREE.Color("#ffd447"),
  white: new THREE.Color("#ffffff"),
};
const CONFETTI = ["#28c840", "#ff4757", "#ffd447", "#ff5fa2", "#ffffff"].map((hex) => new THREE.Color(hex));

type Shared = Record<string, THREE.IUniform>;

function ps1Material(shared: Shared, options: { lit?: boolean; map?: THREE.Texture; fog?: boolean; side?: THREE.Side } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    vertexColors: true,
    side: options.side ?? THREE.FrontSide,
    uniforms: {
      ...shared,
      uLit: { value: options.lit === false ? 0 : 1 },
      uMap: { value: options.map ?? null },
      uUseMap: { value: options.map ? 1 : 0 },
      uFog: { value: options.fog === false ? 0 : 1 },
    },
  });
}

/** Paints every vertex of a geometry with one colour (or a function of position / face). */
function paint(geometry: THREE.BufferGeometry, color: THREE.Color | ((p: THREE.Vector3, face: number) => THREE.Color)) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = g.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    const c = typeof color === "function" ? color(p, Math.floor(i / 3)) : color;
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function pixelCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return { canvas, context: canvas.getContext("2d")!, texture };
}

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

/** Splits text into lines of at most `width` characters. */
function wrap(text: string, width: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(current);
      current = word.slice(0, width);
    } else current = (current + " " + word).trim();
  }
  if (current) lines.push(current);
  return lines;
}

/* ---------- Billboard: the stage's big pixel screen ---------- */

const BOARD_W = 160;
const BOARD_H = 96;

function drawBoard(ctx: CanvasRenderingContext2D, show: StageShow | undefined, t: number, since: number) {
  const elapsed = t - since;
  const mode = show?.mode ?? "idle";
  // A dark grey TV: lighter than the mascots' black legs, so they still read in front of it.
  ctx.fillStyle = "#34323f";
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (let y = 0; y < BOARD_H; y += 2) ctx.fillRect(0, y, BOARD_W, 1);

  const cards = show?.cards ?? [];
  const blink = Math.floor(t * 3) % 2 === 0;
  const dots = ".".repeat(1 + (Math.floor(t * 3) % 3));
  const header = (text: string, color = "#ffd447") => {
    ctx.fillStyle = "#1b1a22";
    ctx.fillRect(0, 0, BOARD_W, 11);
    drawText(ctx, text, 4, 3, color);
  };

  if (mode === "idle") {
    const bounce = Math.round(Math.abs(Math.sin(t * 3)) * -3);
    // Plain letters here: the mascots stand right in front of the TV, so faces in the logo would double them up.
    const slop = textWidth("SLOP") * 3;
    const x = Math.round((BOARD_W - (slop + 4 + textWidth("HOP") * 3)) / 2);
    // Squared-off logo letters (lib/logo.ts), same as the menu's, so the shadow stays clean.
    drawGlyphs(ctx, "SLOP", x + 2, 25 + bounce + 2, "#1b1a22", 3);
    drawGlyphs(ctx, "SLOP", x, 25 + bounce, "#28c840", 3);
    drawGlyphs(ctx, "HOP", x + slop + 4 + 2, 25 - bounce + 2, "#1b1a22", 3);
    drawGlyphs(ctx, "HOP", x + slop + 4, 25 - bounce, "#ff4757", 3);
    const ticker = `${show?.headline ? show.headline + "  *  " : ""}REAL CODE CHANGES  *  TINY BRAIN TEASERS  *  `;
    const offset = Math.floor((t * 18) % (ticker.length * 4));
    ctx.fillStyle = "#1b1a22";
    ctx.fillRect(0, 58, BOARD_W, 13);
    drawText(ctx, ticker + ticker, 4 - offset, 62, "#ffd447");
    if (blink) {
      drawText(ctx, "+", 12, 78, "#3ddc5a", 2);
      drawText(ctx, "-", BOARD_W - 20, 78, "#ff4757", 2);
    }
  } else if (mode === "fetching") {
    header(`FETCHING PULL REQUESTS${dots}`);
    cards.forEach((card, index) => {
      if (elapsed < index * 0.45) return;
      drawText(ctx, `${index + 1}. ${card.repository}`.slice(0, 30), 4, 16 + index * LINE * 2, "#5ef07a");
      drawText(ctx, `   #${card.number} +${card.additions} -${card.deletions}`, 4, 16 + index * LINE * 2 + LINE, "#b9b4c9");
      if (card.score !== undefined) drawText(ctx, `${Math.round(card.score * 100)}%`, BOARD_W - 22, 16 + index * LINE * 2, "#ffd447");
    });
    if (!cards.length) {
      drawText(ctx, show?.headline || "", 4, 18, "#fff");
      drawText(ctx, blink ? "_" : "", 4 + textWidth(show?.headline || "") + 2, 18, "#fff");
    }
  } else if (mode === "reading") {
    const lines = cards.flatMap((card) => [`@ ${card.repository}#${card.number}`, ...card.lines, ""]);
    const current = cards.length ? cards[Math.floor(elapsed / 1.1) % cards.length] : undefined;
    header(`READING ${current ? current.repository.split("/")[1] ?? "" : "DIFFS"}`.slice(0, 38));
    const scroll = elapsed * 14;
    const first = Math.floor(scroll / LINE);
    for (let row = 0; row < 12; row++) {
      const line = lines[(first + row) % Math.max(1, lines.length)] ?? "";
      const y = 14 + row * LINE - (scroll % LINE);
      if (y < 11) continue;
      const color = line.startsWith("+") ? "#5ef07a" : line.startsWith("-") ? "#ff6b78" : line.startsWith("@") ? "#ffd447" : "#b9b4c9";
      drawText(ctx, line.slice(0, 39), 3, y, color);
    }
  } else if (mode === "picked" || mode === "modelling") {
    const card = show?.picked != null ? cards[show.picked] : undefined;
    if (mode === "picked") header(blink ? "PICKED!" : "", "#ffd447");
    else header(`RUNNING THE LOGIC${dots}`, "#3ddc5a");
    if (card) {
      drawText(ctx, card.repository.slice(0, 38), 4, 15, "#ffffff");
      drawText(ctx, `#${card.number}`, 4, 15 + LINE, "#b9b4c9");
    }
    if (mode === "picked") {
      wrap(show?.headline || card?.title || "", 25).slice(0, 3).forEach((line, index) => drawText(ctx, line, 4, 36 + index * 12, "#5ef07a", 2));
    } else {
      // A truth table filling in: OLD (red) and NEW (green) results per case.
      drawText(ctx, "CASE", 6, 32, "#b9b4c9");
      drawText(ctx, "RED", 70, 32, "#ff6b78");
      drawText(ctx, "GREEN", 110, 32, "#5ef07a");
      const filled = Math.floor(elapsed * 2.5);
      for (let row = 0; row < 7; row++) {
        const y = 41 + row * 7;
        const index = filled - 6 + row;
        if (index < 0) continue;
        drawText(ctx, String(index + 1).padStart(2, "0"), 6, y, "#b9b4c9");
        ctx.fillStyle = "#5c596b";
        for (let cell = 0; cell < 4; cell++) ctx.fillRect(22 + cell * 9, y, 6, 5);
        const changed = (index * 7) % 5 === 0;
        ctx.fillStyle = "#ff4757";
        ctx.fillRect(70, y, changed ? 14 : 22, 5);
        ctx.fillStyle = "#3ddc5a";
        ctx.fillRect(110, y, changed ? 26 : 22, 5);
        if (changed) drawText(ctx, "!", 142, y, "#ffd447");
      }
    }
  } else if (mode === "done") {
    const width = textWidth("READY!") * 4;
    if (blink || elapsed < 0.3) {
      drawText(ctx, "READY!", (BOARD_W - width) / 2 + 2, 32, "#1b1a22", 4);
      drawText(ctx, "READY!", (BOARD_W - width) / 2, 30, "#28c840", 4);
    }
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = ["#3ddc5a", "#ff4757", "#ffd447", "#ff5fa2"][i % 4];
      ctx.fillRect((i * 37 + Math.floor(t * 40)) % BOARD_W, (i * 53 + Math.floor(t * 30)) % BOARD_H, 2, 2);
    }
  } else if (mode === "error") {
    header("UH OH", "#ff4757");
    wrap(show?.headline || "SOMETHING BROKE", 38).slice(0, 8).forEach((line, index) => drawText(ctx, line, 4, 16 + index * LINE, "#ff8a94"));
  }
  if (show?.beat) drawText(ctx, "♪", BOARD_W - 8, mode === "idle" ? 4 : 3, blink ? "#ff5fa2" : "#ffd447");
}

/* ---------- Generated props: Gemini designs them as primitives, we build them in the PS1 style ---------- */

function primitive(part: PropSpec["parts"][number]): THREE.BufferGeometry {
  const [a, b, c] = part.size;
  switch (part.shape) {
    case "box":
      return new THREE.BoxGeometry(a, b, c);
    case "cylinder":
      return new THREE.CylinderGeometry(a, a, b, 8);
    case "cone":
      return new THREE.ConeGeometry(a, b, 6);
    case "sphere":
      return new THREE.SphereGeometry(a, 6, 4);
    case "torus":
      return new THREE.TorusGeometry(a, Math.max(0.02, b), 4, 10);
  }
}

/** Builds a prop group (low-poly, vertex-coloured) and returns the geometries so they can be disposed. */
function buildProp(spec: PropSpec, material: THREE.Material) {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  for (const part of spec.parts) {
    const raw = primitive(part);
    const painted = paint(raw, new THREE.Color(part.color));
    if (painted !== raw) raw.dispose();
    geometries.push(painted);
    const mesh = new THREE.Mesh(painted, material);
    mesh.position.set(...part.position);
    mesh.rotation.set(...part.rotation);
    group.add(mesh);
  }
  return { group, geometries };
}

/* ---------- PR cards ---------- */

function drawCard(ctx: CanvasRenderingContext2D, card: StageCard) {
  ctx.fillStyle = "#fffbe9";
  ctx.fillRect(0, 0, 64, 42);
  ctx.fillStyle = "#1b1a22";
  ctx.fillRect(0, 0, 64, 2);
  ctx.fillRect(0, 40, 64, 2);
  ctx.fillRect(0, 0, 2, 42);
  ctx.fillRect(62, 0, 2, 42);
  const [owner, repo] = card.repository.split("/");
  drawText(ctx, (repo ?? owner).slice(0, 14), 4, 5, "#1b1a22");
  drawText(ctx, `#${card.number}`, 4, 12, "#6a6576");
  const scale = (n: number) => Math.min(54, Math.round(Math.log2(1 + n) * 7));
  ctx.fillStyle = "#28c840";
  ctx.fillRect(4, 22, Math.max(2, scale(card.additions)), 5);
  ctx.fillStyle = "#ff4757";
  ctx.fillRect(4, 29, Math.max(2, scale(card.deletions)), 5);
  drawText(ctx, `+${card.additions}`, 4, 35 - 1, "#027d0a");
  drawText(ctx, `-${card.deletions}`, 34, 35 - 1, "#8a0c14");
}

/**
 * A tiny PS1 / Nintendo DS style stage: low-poly, vertex-coloured, Gouraud-lit, vertex-snapped, dithered,
 * rendered at 256x192 and upscaled with nearest-neighbour. Green and Red stand on it as paper-thin cut-outs,
 * and it puts on a show while a puzzle is being made.
 */
export function PS1Stage({ state }: { state: React.MutableRefObject<StageState> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    THREE.ColorManagement.enabled = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
    } catch {
      return;
    }
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(1);

    const shared: Shared = {
      uRes: { value: new THREE.Vector2(LOW_W, LOW_H) },
      uLightDir: { value: new THREE.Vector3(0.6, 1, 0.5) },
      uAmbient: { value: 0.55 },
      uFogColor: { value: C.fog },
      uFogNear: { value: 10 },
      uFogFar: { value: 28 },
    };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, LOW_W / LOW_H, 0.1, 100);

    // Integer scaling: k device pixels per art pixel, and a render size that fills the box at that scale.
    const fit = () => {
      const box = canvas.parentElement?.getBoundingClientRect();
      if (!box || !box.width || !box.height) return;
      const dpr = window.devicePixelRatio || 1;
      const deviceW = Math.floor(box.width * dpr);
      const deviceH = Math.floor(box.height * dpr);
      const k = Math.max(1, Math.round(deviceW / LOW_W));
      const w = Math.max(1, Math.floor(deviceW / k));
      const h = Math.max(1, Math.floor(deviceH / k));
      renderer.setSize(w, h, false);
      canvas.style.width = `${(w * k) / dpr}px`;
      canvas.style.height = `${(h * k) / dpr}px`;
      (shared.uRes.value as THREE.Vector2).set(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(fit);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    fit();
    const disposables: Array<{ dispose(): void }> = [];
    const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = scene) => {
      const mesh = new THREE.Mesh(keep(geometry), keep(material));
      parent.add(mesh);
      return mesh;
    };

    // ---- Set: sky, checkerboard floor, round stage, speakers, floating + and -, trees.
    add(
      paint(new THREE.SphereGeometry(60, 10, 8), (p) => C.skyLow.clone().lerp(C.skyTop, THREE.MathUtils.clamp(p.y / 40, 0, 1))),
      ps1Material(shared, { lit: false, fog: false, side: THREE.BackSide }),
    );
    const tiles = 14;
    const floorB = new THREE.Color("#ff9f43");
    const floor = add(
      paint(new THREE.PlaneGeometry(28, 28, tiles, tiles), (_p, face) => {
        const cell = Math.floor(face / 2);
        return (cell % tiles) % 2 === Math.floor(cell / tiles) % 2 ? C.yellow : floorB;
      }),
      ps1Material(shared),
    );
    floor.rotation.x = -Math.PI / 2;
    const platform = add(paint(new THREE.CylinderGeometry(2.1, 2.3, 0.35, 10), new THREE.Color("#ff5fa2")), ps1Material(shared));
    platform.position.y = 0.17;
    const speakers = [-3.4, 3.4].map((x) => {
      const speaker = add(paint(new THREE.BoxGeometry(1.1, 1.6, 1), new THREE.Color("#3b3355")), ps1Material(shared));
      speaker.position.set(x, 0.8, -0.6);
      const cone = add(paint(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 8), C.yellow), ps1Material(shared));
      cone.rotation.x = Math.PI / 2;
      cone.position.set(x, 0.95, -0.08);
      return { speaker, cone };
    });
    const signMaterial = keep(ps1Material(shared));
    const plusGeometry = [keep(paint(new THREE.BoxGeometry(1.2, 0.36, 0.3), C.green)), keep(paint(new THREE.BoxGeometry(0.36, 1.2, 0.3), C.green))];
    const minusGeometry = keep(paint(new THREE.BoxGeometry(1.2, 0.36, 0.3), C.red));
    const plusSign = new THREE.Group();
    for (const geometry of plusGeometry) plusSign.add(new THREE.Mesh(geometry, signMaterial));
    plusSign.position.set(-5.8, 4.6, -6);
    scene.add(plusSign);
    const minusSign = new THREE.Mesh(minusGeometry, signMaterial);
    minusSign.position.set(5.8, 4.8, -6);
    scene.add(minusSign);
    for (const [index, [x, z]] of [[-8, -8], [-11, -3], [9, -9], [12, -4], [-6, -14], [7, -15]].entries()) {
      const tree = add(paint(new THREE.ConeGeometry(0.9, 2.6, 6), new THREE.Color(index % 2 ? "#3ccf7a" : "#2fb36b")), ps1Material(shared));
      tree.position.set(x, 1.3, z);
    }

    // ---- Billboard behind the stage.
    const board = pixelCanvas(BOARD_W, BOARD_H);
    keep(board.texture);
    const frame = add(paint(new THREE.BoxGeometry(6.9, 4.3, 0.3), new THREE.Color("#2a2833")), ps1Material(shared));
    frame.position.set(0, 3.55, -4.6);
    const screen = add(paint(new THREE.PlaneGeometry(6.4, 3.84), C.white), ps1Material(shared, { lit: false, map: board.texture }));
    screen.position.set(0, 3.55, -4.43);
    for (const x of [-2.6, 2.6]) add(paint(new THREE.BoxGeometry(0.25, 1.4, 0.25), new THREE.Color("#2a2833")), ps1Material(shared)).position.set(x, 0.7, -4.6);

    // ---- Mascots: canvas textures redrawn each frame, on thin planes.
    const mascots = (["add", "del"] as const).map((kind) => {
      const art = pixelCanvas(MASCOT_W, MASCOT_H);
      keep(art.texture);
      const height = 3.5;
      const mesh = add(paint(new THREE.PlaneGeometry((height * MASCOT_W) / MASCOT_H, height), C.white), ps1Material(shared, { lit: false, map: art.texture, side: THREE.DoubleSide }));
      mesh.position.set(kind === "add" ? -0.75 : 0.75, 0.35 + height / 2, 0.2);
      return { kind, mesh, ...art };
    });

    // ---- PR cards (rebuilt when the fetched set changes).
    type CardMesh = { mesh: THREE.Mesh; texture: THREE.CanvasTexture; geometry: THREE.BufferGeometry; material: THREE.Material; slot: THREE.Vector3 };
    let cards: CardMesh[] = [];
    let cardsKey = "";
    const cardGeometry = paint(new THREE.PlaneGeometry(1.05, 0.7), C.white);
    keep(cardGeometry);
    const rebuildCards = (list: StageCard[]) => {
      for (const card of cards) {
        scene.remove(card.mesh);
        card.texture.dispose();
        card.material.dispose();
      }
      cards = list.map((entry, index) => {
        const art = pixelCanvas(64, 42);
        drawCard(art.context, entry);
        const material = ps1Material(shared, { lit: false, map: art.texture, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(cardGeometry, material);
        const slot = new THREE.Vector3(-2.6 + index * (5.2 / Math.max(1, list.length - 1 || 1)), 0.55, 2.3);
        if (list.length === 1) slot.x = 0;
        mesh.position.set(slot.x, 9, slot.z);
        scene.add(mesh);
        return { mesh, texture: art.texture, geometry: cardGeometry, material, slot };
      });
    };

    // ---- Generated props (rebuilt when the set changes), standing on the stage either side of the guys.
    const propMaterial = keep(ps1Material(shared));
    let props: { key: string; parts: THREE.Group[]; geometries: THREE.BufferGeometry[] } | null = null;
    const setProps = (specs: PropSpec[] | undefined) => {
      const key = JSON.stringify(specs ?? []);
      if ((props?.key ?? "[]") === key) return;
      if (props) {
        for (const part of props.parts) scene.remove(part);
        for (const geometry of props.geometries) geometry.dispose();
        props = null;
      }
      if (!specs?.length) return;
      const built = specs.slice(0, 2).map((spec) => buildProp(spec, propMaterial));
      built.forEach(({ group }, index) => {
        group.position.set(index ? 1.65 : -1.65, 0.35, 0.55);
        group.scale.setScalar(0.9);
        scene.add(group);
      });
      props = { key, parts: built.map(({ group }) => group), geometries: built.flatMap(({ geometries }) => geometries) };
    };

    // ---- Falling + / - blocks.
    type Piece = { object: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; life: number; active: boolean };
    const pieces: Piece[] = Array.from({ length: 26 }, (_, index) => {
      const plus = index % 2 === 0;
      const object = plus ? new THREE.Group() : new THREE.Mesh(minusGeometry, signMaterial);
      if (plus) for (const geometry of plusGeometry) object.add(new THREE.Mesh(geometry, signMaterial));
      object.scale.setScalar(0.32);
      object.visible = false;
      scene.add(object);
      return { object, velocity: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, active: false };
    });

    // ---- Confetti.
    const confettiGeometry = keep(new THREE.PlaneGeometry(0.13, 0.13));
    const confettiMaterial = keep(ps1Material(shared, { lit: false, side: THREE.DoubleSide }));
    const confetti = Array.from({ length: 60 }, (_, index) => {
      const geometry = keep(paint(confettiGeometry.clone(), CONFETTI[index % CONFETTI.length]));
      const mesh = new THREE.Mesh(geometry, confettiMaterial);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, velocity: new THREE.Vector3(), spin: Math.random() * 10, life: 0 };
    });

    const clock = new THREE.Clock();
    const cameraPosition = new THREE.Vector3(0, 2.3, 6.4);
    const cameraLook = new THREE.Vector3(0, 1.9, 0);
    const desiredPosition = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    let mode: ShowMode = "idle";
    let since = 0;
    let lastBoard = -1;
    let spawnClock = 0;
    let frameId = 0;

    const loop = () => {
      frameId = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const show = state.current.show;
      const nextMode = show?.mode ?? "idle";
      if (nextMode !== mode) {
        mode = nextMode;
        since = t;
        if (mode === "done") {
          for (const piece of confetti) {
            piece.mesh.visible = true;
            piece.life = 3 + Math.random();
            piece.mesh.position.set((Math.random() - 0.5) * 0.6, 2.4, 0.6);
            piece.velocity.set((Math.random() - 0.5) * 7, 4 + Math.random() * 5, (Math.random() - 0.2) * 4);
          }
        }
      }
      const elapsed = t - since;
      // With music playing, everything moves on the track's own beat (measured from the audio); otherwise a fixed tempo.
      const music = musicBeat();
      const bpm = music?.bpm ?? (mode === "modelling" ? 112 : mode === "done" ? 128 : state.current.bpm);
      const beat = music?.beat ?? (bpm / 60) * t;
      const pulse = Math.pow(1 - (beat - Math.floor(beat)), 4);

      // Generated props: a little bob and turn, in time with the beat.
      setProps(show?.props);
      props?.parts.forEach((part, index) => {
        part.rotation.y = Math.sin(t * 0.8 + index * 2) * 0.6 + (index ? -0.3 : 0.3);
        part.position.y = 0.35 + Math.abs(Math.sin((beat + index * 0.5) * Math.PI)) * 0.08;
      });

      // Cards follow the show.
      const key = (show?.cards ?? []).map((card) => `${card.repository}#${card.number}`).join("|");
      if (key !== cardsKey) {
        cardsKey = key;
        rebuildCards(show?.cards ?? []);
      }
      const reading = cards.length ? Math.floor(elapsed / 1.1) % cards.length : -1;
      cards.forEach((card, index) => {
        const { mesh, slot } = card;
        const picked = show?.picked === index;
        if (mode === "fetching" || mode === "reading") {
          const drop = ease((elapsed - index * 0.45) / 0.7);
          const landing = mode === "fetching" ? 9 - (9 - slot.y) * drop + Math.abs(Math.sin(drop * Math.PI)) * 0.3 * (drop < 1 ? 1 : 0) : slot.y;
          const hop = mode === "reading" && index === reading ? Math.abs(Math.sin(((elapsed % 1.1) / 1.1) * Math.PI)) * 0.55 : 0;
          mesh.position.set(slot.x, landing + hop, slot.z);
          mesh.rotation.set(0, Math.sin(t * 1.4 + index) * 0.25, hop ? Math.sin(t * 9) * 0.12 : 0);
          mesh.scale.setScalar(1);
        } else if (mode === "picked" || mode === "modelling" || mode === "done") {
          const k = ease((mode === "picked" ? elapsed : 2) / 1.2);
          if (picked) {
            const target = new THREE.Vector3(0, 2.45 + Math.sin(t * 2) * 0.08, 0.9);
            mesh.position.lerpVectors(slot, target, k);
            mesh.position.y += Math.sin(k * Math.PI) * 1.2;
            mesh.rotation.set(0, k < 1 ? k * Math.PI * 2 : Math.sin(t * 1.2) * 0.2, 0);
            mesh.scale.setScalar(1 + k * 0.7);
          } else {
            mesh.position.set(slot.x, slot.y - k * 0.9, slot.z);
            mesh.rotation.set(-k * Math.PI * 0.5, 0, 0);
            mesh.scale.setScalar(1 - k * 0.4);
          }
        } else if (mode === "error") {
          mesh.position.y = Math.max(-1, mesh.position.y - dt * 3);
          mesh.rotation.z += dt * 2;
        }
      });

      // + and - rain while the diffs are being read and the logic runs.
      if (mode === "reading" || mode === "modelling") {
        spawnClock += dt;
        while (spawnClock > 0.16) {
          spawnClock -= 0.16;
          const piece = pieces.find((candidate) => !candidate.active);
          if (piece) {
            piece.active = true;
            piece.life = 4.5;
            piece.object.visible = true;
            piece.object.position.set((Math.random() - 0.5) * 9, 7 + Math.random() * 2, -3 + Math.random() * 4.5);
            piece.velocity.set((Math.random() - 0.5) * 0.6, 0, 0);
            piece.spin.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          }
        }
      }
      for (const piece of pieces) {
        if (!piece.active) continue;
        piece.life -= dt;
        piece.velocity.y -= 9.8 * dt;
        piece.object.position.addScaledVector(piece.velocity, dt);
        if (piece.object.position.y < 0.18) {
          piece.object.position.y = 0.18;
          piece.velocity.y = Math.abs(piece.velocity.y) > 1 ? -piece.velocity.y * 0.45 : 0;
          piece.spin.multiplyScalar(0.6);
        }
        piece.object.rotation.x += piece.spin.x * dt;
        piece.object.rotation.y += piece.spin.y * dt;
        piece.object.rotation.z += piece.spin.z * dt;
        piece.object.scale.setScalar(0.32 * Math.min(1, piece.life * 2));
        if (piece.life <= 0) {
          piece.active = false;
          piece.object.visible = false;
        }
      }
      for (const piece of confetti) {
        if (piece.life <= 0) continue;
        piece.life -= dt;
        piece.velocity.y -= 6 * dt;
        piece.velocity.multiplyScalar(0.99);
        piece.mesh.position.addScaledVector(piece.velocity, dt);
        piece.mesh.rotation.set(t * piece.spin, t * piece.spin * 0.7, 0);
        if (piece.life <= 0 || piece.mesh.position.y < 0) piece.mesh.visible = false;
      }

      // Mascots: talking wins; otherwise they react to the show.
      for (const mascot of mascots) {
        const base = state.current[mascot.kind];
        drawMascot(mascot.context, mascot.kind, t, base === "talk" ? "talk" : moodFor(mode, mascot.kind, elapsed, reading, base), { bpm, beat });
        mascot.texture.needsUpdate = true;
        mascot.mesh.rotation.y = Math.sin(t * 0.7 + (mascot.kind === "add" ? 0 : 2)) * 0.45;
      }

      if (t - lastBoard > 1 / 12) {
        lastBoard = t;
        drawBoard(board.context, show, t, since);
        board.texture.needsUpdate = true;
      }
      for (const { speaker, cone } of speakers) {
        speaker.scale.set(1 + pulse * 0.06, 1 + pulse * 0.1, 1);
        cone.scale.setScalar(1 + pulse * 0.35);
      }
      plusSign.rotation.y = t * 0.9;
      plusSign.position.y = 4.6 + Math.sin(t * 1.3) * 0.25;
      minusSign.rotation.y = -t * 0.8;
      minusSign.position.y = 4.8 + Math.sin(t * 1.1 + 1) * 0.25;

      // Camera: gentle sway, wider while reading, push in on the pick, swoop at the end.
      if (mode === "fetching") {
        desiredPosition.set(Math.sin(t * 0.3) * 0.6, 3, 7.2);
        desiredLook.set(0, 1.6, 0);
      } else if (mode === "reading" || mode === "modelling") {
        desiredPosition.set(Math.sin(t * 0.35) * 2.2, 2.6 + Math.sin(t * 0.5) * 0.3, 7);
        desiredLook.set(0, 1.9, 0);
      } else if (mode === "picked") {
        desiredPosition.set(Math.sin(t * 0.4) * 0.5, 2.6, 5.2);
        desiredLook.set(0, 2.3, 0.6);
      } else if (mode === "done") {
        desiredPosition.set(Math.sin(t * 0.8) * 1.5, 3.4, 6.2);
        desiredLook.set(0, 2, 0);
      } else {
        desiredPosition.set(Math.sin(t * 0.25) * 0.9, 2.3 + Math.sin(t * 0.4) * 0.1, 6.4);
        desiredLook.set(0, 1.9, 0);
      }
      const follow = 1 - Math.exp(-dt * 2.2);
      cameraPosition.lerp(desiredPosition, follow);
      cameraLook.lerp(desiredLook, follow);
      camera.position.copy(cameraPosition);
      camera.lookAt(cameraLook);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      for (const geometry of props?.geometries ?? []) geometry.dispose();
      for (const card of cards) {
        card.texture.dispose();
        card.material.dispose();
      }
      for (const item of disposables) item.dispose();
      renderer.dispose();
    };
  }, [state]);

  return <canvas ref={canvasRef} className="ps1" width={LOW_W} height={LOW_H} aria-hidden />;
}

/** How the two react to each moment of the show. */
function moodFor(mode: ShowMode, kind: MascotKind, elapsed: number, reading: number, base: MascotMood): MascotMood {
  if (mode === "fetching") return "dance";
  if (mode === "reading") return (reading + (kind === "add" ? 0 : 1)) % 2 === 0 && elapsed % 1.1 < 0.5 ? "cheer" : "dance";
  if (mode === "picked") return "cheer";
  if (mode === "modelling") return "dance";
  if (mode === "done") return "cheer";
  if (mode === "error") return "shake";
  return base;
}
