"use client";

import { useEffect, useId, useRef, useState } from "react";
import { drawText } from "@/lib/pixelfont";
import { sfx } from "@/lib/sound";
import { flowKey, flowStory, formatNumber, pointAt, type AiExample, type AiModel, type FlowModel, type FlowScenario, type MockShape, type NumericModel, type VisualModel, type VisualState } from "@/lib/types";

/*
 * Steps for the NUMBERS and LOOKS families. Same rules as every step: one decision, fits the fixed bottom screen.
 * Colours: Red's line/picture is red, Green's is green; the player's marker and highlights are yellow.
 */

const INK = "#1b1a22";
const YELLOW = "#ffcf33";
const RED_LINE = "#e8394a";
const GREEN_LINE = "#1f9e3a";

/** A canvas ref, kept at a whole-number device-pixel scale that fills its box's width without exceeding `maxHeight` CSS px. */
function useIntegerFit(width: number, height: number, maxHeight: number) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const box = element?.parentElement;
    if (!element || !box) return;
    const fit = () => {
      const ratio = window.devicePixelRatio || 1;
      const byWidth = (box.clientWidth * ratio) / width;
      const byHeight = (maxHeight * ratio) / height;
      const scale = Math.max(1, Math.floor(Math.min(byWidth, byHeight)));
      element.style.width = `${(width * scale) / ratio}px`;
      element.style.height = `${(height * scale) / ratio}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [width, height, maxHeight]);
  return canvas;
}

/* ---------- Numbers ---------- */

/** The case for a number step: the input value, plus what's held fixed. */
export function NumberCase({ model, x }: { model: NumericModel; x: number }) {
  return (
    <div className="case case-base">
      <span className="chips">
        <span className="chip">
          <small>{model.input.label}:</small> {formatNumber(x, model.input.unit)}
        </span>
      </span>
      {model.context && <span className="case-note">{model.context}</span>}
    </div>
  );
}

/** What Red (before) and Green (after) give at x. */
export function NumberResults({ model, x }: { model: NumericModel; x: number }) {
  const point = pointAt(model, x);
  const show = (value: number | undefined) => (value === undefined ? "?" : formatNumber(value, model.output.unit, model.output.decimals));
  return (
    <div className="outcomes">
      <div className="outcome outcome-del">
        <span className="outcome-who">RED · before</span>
        <span className="outcome-text">{show(point?.old)}</span>
      </div>
      <div className="outcome outcome-add">
        <span className="outcome-who">GREEN · now</span>
        <span className="outcome-text">{show(point?.new)}</span>
      </div>
      {point && point.old !== point.new && <span className="outcome-split">CHANGED</span>}
    </div>
  );
}

/** Brain Age style number entry: type the answer, OK. Shows the unit; ± for negatives when they're possible. */
export function Keypad({ unit, decimals, negative, answered, onSubmit }: { unit: string; decimals: number; negative: boolean; answered: string | null; onSubmit: (value: string) => void }) {
  const [text, setText] = useState("");
  const shown = answered ?? text;
  const press = (key: string) => {
    if (answered !== null) return;
    sfx.cycle();
    setText((current) => {
      if (key === "⌫") return current.slice(0, -1);
      if (key === "±") return current.startsWith("-") ? current.slice(1) : `-${current}`;
      if (key === ".") return decimals > 0 && !current.includes(".") ? `${current || "0"}.` : current;
      const [, fraction = ""] = current.split(".");
      if (current.includes(".") && fraction.length >= decimals) return current;
      if (current.replace(/[-.]/g, "").length >= 9) return current;
      return current === "0" ? key : current === "-0" ? `-${key}` : current + key;
    });
  };
  const keys = ["7", "8", "9", "⌫", "4", "5", "6", decimals > 0 ? "." : "±", "1", "2", "3", "0"];
  return (
    <div className="keypad">
      <div className="keypad-display" aria-live="polite">
        <span>{shown === "" || shown === "-" ? "_" : shown}</span>
        {unit && <small>{unit}</small>}
      </div>
      <div className="keypad-keys">
        {keys.map((key) => (
          <button key={key} className="keypad-key" onClick={() => press(key)} disabled={answered !== null} aria-label={key === "⌫" ? "Delete" : key === "±" ? "Plus or minus" : key}>
            {key}
          </button>
        ))}
        {decimals > 0 && negative && (
          <button className="keypad-key" onClick={() => press("±")} disabled={answered !== null} aria-label="Plus or minus">
            ±
          </button>
        )}
        <button
          className="px-btn px-btn-go keypad-ok"
          disabled={answered !== null || text === "" || text === "-"}
          onClick={() => {
            sfx.select();
            onSubmit(text.endsWith(".") ? text.slice(0, -1) : text);
          }}
        >
          OK ▶
        </button>
      </div>
    </div>
  );
}

const CHART_W = 192;
const CHART_H = 80;

/**
 * The number line as a little pixel chart. Red's line is drawn; Green's appears after answering. Drag (or tap) to move the
 * yellow marker along the input; it snaps to the sampled values. `target` draws the result to reach as a dashed line.
 */
export function NumberLine({
  model,
  target,
  answer,
  picked,
  onPick,
}: {
  model: NumericModel;
  target?: number;
  answer: number;
  picked: string | null;
  onPick: (x: string) => void;
}) {
  const canvas = useIntegerFit(CHART_W, CHART_H, 150);
  const dragging = useRef(false);
  const { points } = model;
  const [index, setIndex] = useState(() => Math.floor(points.length / 2));

  const values = [...points.flatMap((point) => [point.old, point.new]), ...(target !== undefined ? [target] : [])];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const left = 4;
  const right = CHART_W - 4;
  const top = 6;
  const bottom = CHART_H - 12;
  const px = (i: number) => Math.round(left + ((right - left) * i) / Math.max(1, points.length - 1));
  const py = (value: number) => Math.round(bottom - ((bottom - top) * (value - low)) / span);
  const answered = picked !== null;
  const pickedIndex = answered ? points.findIndex((point) => String(point.x) === picked) : index;
  const answerIndex = points.findIndex((point) => point.x === answer);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, CHART_W, CHART_H);
    context.fillStyle = INK;
    context.fillRect(left, bottom + 1, right - left + 1, 1);
    const line = (key: "old" | "new", color: string) => {
      context.fillStyle = color;
      for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0, x1, y1] = [px(i), py(points[i][key]), px(i + 1), py(points[i + 1][key])];
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let s = 0; s <= steps; s++) context.fillRect(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), 2, 2);
      }
    };
    if (target !== undefined) {
      context.fillStyle = "#b8a020";
      for (let x = left; x < right; x += 4) context.fillRect(x, py(target), 2, 1);
    }
    line("old", RED_LINE);
    if (answered) line("new", GREEN_LINE);
    // Answer (after answering) as an ink tick; the player's marker in yellow.
    if (answered && answerIndex >= 0) {
      context.fillStyle = INK;
      context.fillRect(px(answerIndex) - 1, top - 4, 3, bottom - top + 6);
    }
    if (pickedIndex >= 0) {
      context.fillStyle = YELLOW;
      context.fillRect(px(pickedIndex), top - 4, 1, bottom - top + 6);
      context.fillStyle = INK;
      context.fillRect(px(pickedIndex) - 3, bottom + 3, 7, 1);
      context.fillStyle = YELLOW;
      context.fillRect(px(pickedIndex) - 2, bottom + 4, 5, 4);
    }
    drawText(context, formatNumber(model.input.min, model.input.unit).replace(/\s/g, ""), left, CHART_H - 5, "#6a6576");
    const maxLabel = formatNumber(model.input.max, model.input.unit).replace(/\s/g, "");
    drawText(context, maxLabel, right - maxLabel.length * 4 + 1, CHART_H - 5, "#6a6576");
  });

  const setFrom = (clientX: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || answered) return;
    const fraction = ((clientX - rect.left) / rect.width) * CHART_W;
    const next = Math.max(0, Math.min(points.length - 1, Math.round(((fraction - left) / (right - left)) * (points.length - 1))));
    if (next !== index) {
      sfx.cycle();
      setIndex(next);
    }
  };
  const current = points[pickedIndex] ?? points[index];
  return (
    <div className="step">
      <div className="numline">
        <canvas
          ref={canvas}
          className="ps1 numline-canvas"
          width={CHART_W}
          height={CHART_H}
          role="slider"
          tabIndex={0}
          aria-label={model.input.label}
          aria-valuemin={model.input.min}
          aria-valuemax={model.input.max}
          aria-valuenow={current?.x}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            setFrom(event.clientX);
          }}
          onPointerMove={(event) => dragging.current && setFrom(event.clientX)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
          onKeyDown={(event) => {
            if (answered) return;
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            setIndex((value) => Math.max(0, Math.min(points.length - 1, value + step)));
          }}
        />
      </div>
      <div className="numline-row">
        <span className="numline-value">
          <small>{model.input.label}:</small> {current ? formatNumber(current.x, model.input.unit) : ""}
        </span>
        {!answered && (
          <button
            className="px-btn px-btn-go"
            onClick={() => {
              sfx.select();
              onPick(String(points[index].x));
            }}
          >
            Here ▶
          </button>
        )}
      </div>
      {answered && <NumberResults model={model} x={answer} />}
    </div>
  );
}

/* ---------- Looks ---------- */

/** Draws a mock screen in the pixel style. `highlight` ids get a yellow outline; `onTap` reports the topmost element tapped. */
export function MockScreen({
  frame,
  shapes,
  highlight = [],
  maxHeight,
  onTap,
}: {
  frame: VisualModel["frame"];
  shapes: MockShape[];
  highlight?: string[];
  maxHeight: number;
  onTap?: (id: string | null) => void;
}) {
  const canvas = useIntegerFit(frame.w, frame.h, maxHeight);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, frame.w, frame.h);
    for (const shape of shapes) {
      if (shape.kind === "box") {
        if (shape.fill) {
          context.fillStyle = shape.fill;
          context.fillRect(shape.x, shape.y, shape.w, shape.h);
        }
        if (shape.stroke) {
          context.fillStyle = shape.stroke;
          context.fillRect(shape.x, shape.y, shape.w, 1);
          context.fillRect(shape.x, shape.y + shape.h - 1, shape.w, 1);
          context.fillRect(shape.x, shape.y, 1, shape.h);
          context.fillRect(shape.x + shape.w - 1, shape.y, 1, shape.h);
        }
      } else if (shape.kind === "button") {
        // Raised: the face, a light top/left edge, a dark bottom/right edge, and the outline.
        context.fillStyle = shape.fill || "#d9d6e0";
        context.fillRect(shape.x, shape.y, shape.w, shape.h);
        context.fillStyle = "rgba(255, 255, 255, .6)";
        context.fillRect(shape.x + 1, shape.y + 1, shape.w - 2, 1);
        context.fillRect(shape.x + 1, shape.y + 1, 1, shape.h - 2);
        context.fillStyle = "rgba(0, 0, 0, .3)";
        context.fillRect(shape.x + 1, shape.y + shape.h - 2, shape.w - 2, 1);
        context.fillRect(shape.x + shape.w - 2, shape.y + 1, 1, shape.h - 2);
        context.fillStyle = shape.stroke || INK;
        context.fillRect(shape.x, shape.y, shape.w, 1);
        context.fillRect(shape.x, shape.y + shape.h - 1, shape.w, 1);
        context.fillRect(shape.x, shape.y, 1, shape.h);
        context.fillRect(shape.x + shape.w - 1, shape.y, 1, shape.h);
      } else if (shape.kind === "led") {
        // A round light: a pixel disc in its colour (dark grey when off), with a 1px highlight when lit.
        const r = Math.max(1, Math.floor(Math.min(shape.w, shape.h) / 2));
        const cx = shape.x + r;
        const cy = shape.y + r;
        context.fillStyle = shape.stroke || INK;
        for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) if (dx * dx + dy * dy <= (r + 1) * (r + 1)) context.fillRect(cx + dx, cy + dy, 1, 1);
        context.fillStyle = shape.fill || "#4a4954";
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) context.fillRect(cx + dx, cy + dy, 1, 1);
        if (shape.fill) {
          context.fillStyle = "rgba(255, 255, 255, .75)";
          context.fillRect(cx - Math.ceil(r / 2), cy - Math.ceil(r / 2), 1, 1);
        }
      } else if (shape.kind === "line") {
        context.fillStyle = shape.stroke || INK;
        const steps = Math.max(Math.abs(shape.w), Math.abs(shape.h), 1);
        for (let s = 0; s <= steps; s++) context.fillRect(Math.round(shape.x + (shape.w * s) / steps), Math.round(shape.y + (shape.h * s) / steps), 1, 1);
      } else if (shape.text) {
        drawText(context, shape.text, shape.x, shape.y, shape.color || INK);
      }
    }
    context.fillStyle = YELLOW;
    for (const shape of shapes.filter((entry) => highlight.includes(entry.id))) {
      const x = Math.min(shape.x, shape.x + shape.w) - 2;
      const y = Math.min(shape.y, shape.y + shape.h) - 2;
      const w = Math.abs(shape.w) + 4;
      const h = Math.abs(shape.h) + 4;
      context.fillRect(x, y, w, 1);
      context.fillRect(x, y + h - 1, w, 1);
      context.fillRect(x, y, 1, h);
      context.fillRect(x + w - 1, y, 1, h);
    }
  });
  return (
    <div className="mock">
      <canvas
        ref={canvas}
        className={`ps1 mock-canvas ${onTap ? "mock-tappable" : ""}`}
        width={frame.w}
        height={frame.h}
        onPointerDown={(event) => {
          if (!onTap) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const fx = ((event.clientX - rect.left) / rect.width) * frame.w;
          const fy = ((event.clientY - rect.top) / rect.height) * frame.h;
          const hit = [...shapes].reverse().find((shape) => {
            const x = Math.min(shape.x, shape.x + shape.w) - 2;
            const y = Math.min(shape.y, shape.y + shape.h) - 2;
            return fx >= x && fx <= x + Math.abs(shape.w) + 4 && fy >= y && fy <= y + Math.abs(shape.h) + 4;
          });
          onTap(hit?.id ?? null);
        }}
      />
    </div>
  );
}

/** Two pictures of one situation, A and B: which is Green's? After answering, they're labelled and the change outlined. */
export function VisualWhich({ model, state, greenFirst, picked, onPick }: { model: VisualModel; state: VisualState; greenFirst: boolean; picked: string | null; onPick: (side: string) => void }) {
  const sides = greenFirst ? (["after", "before"] as const) : (["before", "after"] as const);
  return (
    <div className="step">
      <div className="mock-pair">
        {sides.map((version, index) => {
          const letter = index === 0 ? "a" : "b";
          const label = picked ? (version === "after" ? "GREEN · now" : "RED · before") : letter.toUpperCase();
          return (
            <button
              key={version}
              className={`mock-pick ${picked ? (version === "after" ? "mock-green" : "mock-red") : ""} ${picked === letter ? "mock-picked" : ""}`}
              disabled={picked !== null}
              onClick={() => {
                sfx.select();
                onPick(letter);
              }}
            >
              <span className="mock-label">{label}</span>
              <MockScreen frame={model.frame} shapes={state[version]} highlight={picked && version === "after" ? state.changed : []} maxHeight={150} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Green's picture of one situation: tap the part that changed. After answering, it flips between before and after. */
export function VisualSpot({ model, state, picked, onPick }: { model: VisualModel; state: VisualState; picked: string | null; onPick: (id: string) => void }) {
  const [showBefore, setShowBefore] = useState(false);
  useEffect(() => {
    if (picked === null) return;
    const timer = window.setInterval(() => setShowBefore((value) => !value), 900);
    return () => window.clearInterval(timer);
  }, [picked]);
  const version = picked !== null && showBefore ? "before" : "after";
  return (
    <div className="step">
      <div className={`mock-frame ${picked !== null ? (version === "after" ? "mock-green" : "mock-red") : ""}`}>
        <span className="mock-label">{picked === null ? "GREEN · now" : version === "after" ? "GREEN · now" : "RED · before"}</span>
        <MockScreen
          frame={model.frame}
          shapes={state[version]}
          highlight={picked !== null ? state.changed.filter((id) => state[version].some((shape) => shape.id === id)) : []}
          maxHeight={170}
          onTap={
            picked === null
              ? (id) => {
                  sfx.select();
                  onPick(id ?? "none");
                }
              : undefined
          }
        />
      </div>
      {picked !== null && <span className="case-note can-hide">Flipping between before and after. The change is outlined.</span>}
    </div>
  );
}

/* ---------- Flows: a process map, drawn in the pixel style ---------- */

type FlowHit = { type: "state"; id: string } | { type: "edge"; key: string };

const CHAR = 8; // DotGothic16 at 16px: Latin characters are 8px wide
const NODE_H = 26;
const GAP_ONE = 30; // gap under a row when its arrow labels fit on one line
const GAP_TWO = 52; // ... and when they need two staggered lines

/**
 * Rows by steps from the start, top to bottom (over both maps, so boxes sit in the same place on Red's and Green's);
 * boxes in a row spread across the width. Real px, so the 16px UI font stays crisp.
 */
function layoutFlow(model: FlowModel, width: number, side: "old" | "new") {
  const all = [...model.old, ...model.new];
  const depth = new Map<string, number>([[model.start, 0]]);
  const queue = [model.start];
  while (queue.length) {
    const state = queue.shift()!;
    for (const transition of all) {
      if (transition.from === state && !depth.has(transition.to)) {
        depth.set(transition.to, depth.get(state)! + 1);
        queue.push(transition.to);
      }
    }
  }
  const rows = new Map<number, FlowModel["states"]>();
  for (const state of model.states) {
    const row = depth.get(state.id) ?? 0;
    rows.set(row, [...(rows.get(row) ?? []), state]);
  }
  // Each gap is as tall as its arrow labels need: one line, or two staggered lines when they won't fit across.
  const lastRow = Math.max(0, ...[...rows.keys()]);
  const gapLabels = new Map<number, number>();
  for (const transition of model[side]) {
    const from = depth.get(transition.from) ?? 0;
    if ((depth.get(transition.to) ?? 0) > from) {
      const label = model.events.find((event) => event.id === transition.event)?.label ?? transition.event;
      gapLabels.set(from, (gapLabels.get(from) ?? 0) + label.length * CHAR + 14);
    }
  }
  const gapOf = (row: number) => ((gapLabels.get(row) ?? 0) > width - 8 ? GAP_TWO : GAP_ONE);
  const rowTop = new Map<number, number>();
  let top = 4;
  for (let row = 0; row <= lastRow; row++) {
    rowTop.set(row, top);
    top += NODE_H + gapOf(row);
  }
  const boxes = new Map<string, { x: number; y: number; w: number; row: number; label: string; gap: number }>();
  for (const [row, states] of rows) {
    const widths = states.map((state) => Math.min(state.label.length * CHAR + 18, Math.floor((width - 40) / states.length) - 6));
    const total = widths.reduce((sum, w) => sum + w, 0);
    const gap = Math.max(6, (width - 30 - total) / (states.length + 1));
    let x = gap;
    states.forEach((state, index) => {
      boxes.set(state.id, { x: Math.round(x), y: rowTop.get(row)!, w: widths[index], row, label: state.label, gap: gapOf(row) });
      x += widths[index] + gap;
    });
  }
  const height = rowTop.get(lastRow)! + NODE_H + 4;
  return { boxes, height };
}

/**
 * A process map: states as boxes (bad endings shaded, the start marked), arrows labelled with their events. Forward arrows
 * go straight down; arrows back up or across route around the right. `highlight*` paint yellow; states and arrow labels
 * are tappable when `onTap` is set.
 */
export function FlowMap({
  model,
  side,
  highlightStates = [],
  highlightEdges = [],
  onTap,
}: {
  model: FlowModel;
  side: "old" | "new";
  highlightStates?: string[];
  highlightEdges?: string[];
  onTap?: (hit: FlowHit) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const marker = `flow-arrow-${useId().replace(/[^a-z0-9]/gi, "")}`;
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const fit = () => setWidth(Math.max(240, Math.floor(element.clientWidth)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { boxes, height } = layoutFlow(model, width, side);
  type Edge = { key: string; label: string; path: string; at: { x: number; y: number }; w: number };
  const labelWidth = (label: string) => label.length * CHAR + 8;
  const edges: Edge[] = [];
  // Forward arrows (down a row or more): their labels are packed per gap, on the line where each arrow crosses the
  // middle of the gap below its source, pushed apart so none overlap; two staggered lines when one won't fit.
  const gaps = new Map<number, Edge[]>();
  let lane = 0;
  for (const transition of model[side]) {
    const a = boxes.get(transition.from)!;
    const b = boxes.get(transition.to)!;
    const key = flowKey(transition);
    const label = model.events.find((event) => event.id === transition.event)?.label ?? transition.event;
    const w = labelWidth(label);
    if (b.row > a.row) {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + b.w / 2;
      const y2 = b.y - 2;
      const mid = y1 + a.gap / 2;
      const t = (mid - y1) / (y2 - y1);
      const edge = { key, label, path: `M${x1},${y1} L${x2},${y2}`, at: { x: x1 + (x2 - x1) * t, y: mid }, w };
      edges.push(edge);
      gaps.set(a.row, [...(gaps.get(a.row) ?? []), edge]);
    } else {
      // Back up, across, or a loop: out to the right, along, and back in; the label sits on the vertical stretch.
      const out = Math.max(a.x + a.w, b.x + b.w) + 10 + 10 * lane++;
      const y1 = a.y + NODE_H / 2 - 4;
      const y2 = b.y + NODE_H / 2 + 4;
      edges.push({ key, label, path: `M${a.x + a.w},${y1} H${out} V${y2} H${b.x + b.w + 3}`, at: { x: Math.min(out, width - w / 2 - 2), y: (y1 + y2) / 2 }, w });
    }
  }
  for (const list of gaps.values()) {
    const total = list.reduce((sum, edge) => sum + edge.w + 6, 0);
    const lines = total > width - 8 ? [list.filter((_, i) => i % 2 === 0), list.filter((_, i) => i % 2 === 1)] : [list];
    lines.forEach((line, index) => {
      if (lines.length > 1) for (const edge of line) edge.at.y += index === 0 ? -11 : 11;
      line.sort((p, q) => p.at.x - q.at.x);
      let right = 4;
      for (const edge of line) {
        const left = Math.max(edge.at.x - edge.w / 2, right + 6);
        edge.at.x = left + edge.w / 2;
        right = left + edge.w;
      }
      const overflow = right - (width - 4);
      if (overflow > 0) for (const edge of line) edge.at.x = Math.max(4 + edge.w / 2, edge.at.x - overflow);
    });
  }
  const tap = (hit: FlowHit) => () => onTap?.(hit);
  return (
    <div className="flow-map" ref={holder}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${side === "new" ? "Green's" : "Red's"} map`}>
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const lit = highlightEdges.includes(edge.key);
          return <path key={`line-${edge.key}`} d={edge.path} fill="none" stroke={lit ? "#b8920e" : "#6a6576"} strokeWidth={lit ? 3 : 2} markerEnd={`url(#${marker})`} shapeRendering="crispEdges" />;
        })}
        {edges.map((edge) => {
          const lit = highlightEdges.includes(edge.key);
          const w = edge.w;
          return (
            <g key={`label-${edge.key}`} className={onTap ? "flow-hit" : ""} onClick={onTap ? tap({ type: "edge", key: edge.key }) : undefined} role={onTap ? "button" : undefined} aria-label={onTap ? `Arrow: ${edge.label}` : undefined}>
              <rect x={edge.at.x - w / 2} y={edge.at.y - 10} width={w} height={20} fill={lit ? YELLOW : "#f4f1e8"} stroke={lit ? INK : "#c9c4b5"} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={edge.at.x} y={edge.at.y + 1} textAnchor="middle" dominantBaseline="middle" className="flow-text">
                {edge.label}
              </text>
            </g>
          );
        })}
        {model.states.map((state) => {
          const box = boxes.get(state.id)!;
          const lit = highlightStates.includes(state.id);
          return (
            <g key={state.id} className={onTap ? "flow-hit" : ""} onClick={onTap ? tap({ type: "state", id: state.id }) : undefined} role={onTap ? "button" : undefined} aria-label={onTap ? state.label : undefined}>
              <rect x={box.x} y={box.y} width={box.w} height={NODE_H} fill={lit ? YELLOW : state.tone === "bad" ? "#d9d6e0" : "#ffffff"} stroke={INK} strokeWidth={3} shapeRendering="crispEdges" />
              {state.id === model.start && <rect x={box.x - 7} y={box.y + 7} width={4} height={NODE_H - 14} fill={INK} shapeRendering="crispEdges" />}
              <text x={box.x + box.w / 2} y={box.y + NODE_H / 2 + 1} textAnchor="middle" dominantBaseline="middle" className="flow-text">
                {state.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const endOf = (path: string[]) => path[path.length - 1];
const stateLabel = (model: FlowModel, id: string) => model.states.find((state) => state.id === id)?.label ?? id;

/** The story card: a scenario as events in order. */
export function FlowStory({ model, scenario }: { model: FlowModel; scenario: FlowScenario }) {
  return (
    <div className="case case-base flow-story">
      <span>{flowStory(model, scenario)}.</span>
    </div>
  );
}

/** Where a scenario ends with Red (before) and Green (now). */
export function FlowEnds({ model, scenario }: { model: FlowModel; scenario: FlowScenario }) {
  const old = endOf(scenario.old);
  const now = endOf(scenario.new);
  return (
    <div className="outcomes">
      <div className="outcome outcome-del">
        <span className="outcome-who">RED · ended at</span>
        <span className="outcome-text">{stateLabel(model, old)}</span>
      </div>
      <div className="outcome outcome-add">
        <span className="outcome-who">GREEN · ends at</span>
        <span className="outcome-text">{stateLabel(model, now)}</span>
      </div>
      {old !== now && <span className="outcome-split">CHANGED</span>}
    </div>
  );
}

function MapFrame({ side, children }: { side: "old" | "new"; children: React.ReactNode }) {
  return (
    <div className={`mock-frame ${side === "new" ? "mock-green" : "mock-red"}`}>
      <span className="mock-label">{side === "new" ? "GREEN'S MAP · now" : "RED'S MAP · before"}</span>
      {children}
    </div>
  );
}

/** Trace: read the story, tap where it ends on that side's map. After: the path lights up and both endings show. */
export function FlowTrace({ model, scenario, side, picked, onPick }: { model: FlowModel; scenario: FlowScenario; side: "old" | "new"; picked: string | null; onPick: (id: string) => void }) {
  const path = side === "new" ? scenario.new : scenario.old;
  const edges = path.slice(1).map((to, index) => model[side].find((transition) => transition.from === path[index] && transition.to === to && scenario.events.includes(transition.event))).filter(Boolean).map((transition) => flowKey(transition!));
  return (
    <div className="step">
      <div className="can-hide">
        <FlowStory model={model} scenario={scenario} />
      </div>
      <MapFrame side={side}>
        <FlowMap
          model={model}
          side={side}
          highlightStates={picked ? [endOf(path)] : []}
          highlightEdges={picked ? edges : []}
          onTap={picked ? undefined : (hit) => hit.type === "state" && (sfx.select(), onPick(hit.id))}
        />
      </MapFrame>
      {picked && <FlowEnds model={model} scenario={scenario} />}
    </div>
  );
}

/** Change: tap the arrow only this side's map has. After: those arrows light up. */
export function FlowChange({ model, side, picked, onPick }: { model: FlowModel; side: "old" | "new"; picked: string | null; onPick: (key: string) => void }) {
  const other = new Set(model[side === "new" ? "old" : "new"].map(flowKey));
  const only = model[side].filter((transition) => !other.has(flowKey(transition))).map(flowKey);
  return (
    <div className="step">
      <MapFrame side={side}>
        <FlowMap
          model={model}
          side={side}
          highlightEdges={picked ? only : []}
          onTap={picked ? undefined : (hit) => hit.type === "edge" && (sfx.select(), onPick(hit.key))}
        />
      </MapFrame>
      <span className="case-note">{picked ? (side === "new" ? "Lit up: the arrows only Green has." : "Lit up: the arrows Green dropped.") : "Tap an arrow's label."}</span>
    </div>
  );
}

/** Dead end: tap the step that can't be reached any more (or only now). Shown on Green's map. */
export function FlowDead({ model, answer, picked, onPick }: { model: FlowModel; answer: string; picked: string | null; onPick: (id: string) => void }) {
  return (
    <div className="step">
      <MapFrame side="new">
        <FlowMap
          model={model}
          side="new"
          highlightStates={picked ? [answer] : []}
          onTap={picked ? undefined : (hit) => hit.type === "state" && (sfx.select(), onPick(hit.id))}
        />
      </MapFrame>
    </div>
  );
}

/** Break it: which story ends somewhere bad with Green? After: each card shows where Green ends it. */
export function FlowBreak({ model, options, answer, picked, onPick }: { model: FlowModel; options: FlowScenario[]; answer: string; picked: string | null; onPick: (id: string) => void }) {
  return (
    <div className="step">
      <div className="cards cards-1 cards-tight">
        {options.map((scenario) => (
          <button
            key={scenario.id}
            className={`card-pick ${picked ? (scenario.id === answer ? "card-right" : scenario.id === picked ? "card-wrong" : "can-hide") : ""}`}
            disabled={picked !== null}
            onClick={() => {
              sfx.select();
              onPick(scenario.id);
            }}
          >
            {flowStory(model, scenario)}
            {picked && <small className="flow-end"> → Green: {stateLabel(model, endOf(scenario.new))}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- AI guards: example inputs and what the guard does with them ---------- */

/** One example input, tagged with what it is (a message, a tool call...). */
export function AiInput({ example }: { example: AiExample }) {
  return (
    <div className="case case-base ai-input">
      <span className="ai-kind">{example.kind.toUpperCase()}</span>
      <q className="ai-text">{example.text}</q>
    </div>
  );
}

const aiLabel = (model: AiModel, id: string) => model.outcomes.find((outcome) => outcome.id === id)?.label ?? id;

/** What Red's guard did (before) and Green's does (now) with an input. */
export function AiResults({ model, example, intent }: { model: AiModel; example: AiExample; intent?: string }) {
  return (
    <div className="step-tight">
      {intent && (
        <span className="case-note">
          You said it should: <span className="case-now">{aiLabel(model, intent)}</span>
          {intent === example.new ? " · Green agrees" : " · Green does something else"}
        </span>
      )}
      <div className="outcomes">
        <div className="outcome outcome-del">
          <span className="outcome-who">RED · before</span>
          <span className="outcome-text">{aiLabel(model, example.old)}</span>
        </div>
        <div className="outcome outcome-add">
          <span className="outcome-who">GREEN · now</span>
          <span className="outcome-text">{aiLabel(model, example.new)}</span>
        </div>
        {example.old !== example.new && <span className="outcome-split">CHANGED</span>}
      </div>
    </div>
  );
}

/** The guard's possible outcomes as answer cards. `judged` = mark right/wrong after picking; off for "Should it?". */
function AiChoices({ model, picked, answer, judged, onPick }: { model: AiModel; picked: string | null; answer?: string; judged: boolean; onPick: (id: string) => void }) {
  return (
    <div className="cards">
      {model.outcomes.map((outcome) => (
        <button
          key={outcome.id}
          className={`card-pick ${picked && judged ? (outcome.id === answer ? "card-right" : outcome.id === picked ? "card-wrong" : "") : picked === outcome.id ? "card-chosen" : ""}`}
          disabled={picked !== null}
          onClick={() => {
            sfx.select();
            onPick(outcome.id);
          }}
        >
          {outcome.label}
        </button>
      ))}
    </div>
  );
}

/** Gate: an input arrives; what does Green's (or Red's) guard do with it? */
export function AiGate({ model, example, side, picked, onPick }: { model: AiModel; example: AiExample; side: "old" | "new"; picked: string | null; onPick: (id: string) => void }) {
  return (
    <div className="step">
      <AiInput example={example} />
      {picked ? <AiResults model={model} example={example} /> : <AiChoices model={model} picked={picked} answer={side === "new" ? example.new : example.old} judged onPick={onPick} />}
    </div>
  );
}

/** Should it?: intent first. Pick what SHOULD happen; then see what Red and Green actually do. */
export function AiShould({ model, example, picked, onPick }: { model: AiModel; example: AiExample; picked: string | null; onPick: (id: string) => void }) {
  return (
    <div className="step">
      <AiInput example={example} />
      {picked ? <AiResults model={model} example={example} intent={picked} /> : <AiChoices model={model} picked={picked} judged={false} onPick={onPick} />}
    </div>
  );
}

/** Slip past / Before & after: pick one of three inputs. After: each shows what the guards did with it. */
export function AiPickInput({ model, options, answer, showRed, picked, onPick }: { model: AiModel; options: AiExample[]; answer: string; showRed: boolean; picked: string | null; onPick: (id: string) => void }) {
  return (
    <div className="step">
      <div className="cards cards-1 cards-tight">
        {options.map((example) => (
          <button
            key={example.id}
            className={`card-pick ai-card ${picked ? (example.id === answer ? "card-right" : example.id === picked ? "card-wrong" : "can-hide") : ""}`}
            disabled={picked !== null}
            onClick={() => {
              sfx.select();
              onPick(example.id);
            }}
          >
            <span className="ai-kind">{example.kind.toUpperCase()}</span> <q className="ai-text">{example.text}</q>
            {picked && (
              <small className="flow-end">
                {" "}
                → {showRed ? `Red: ${aiLabel(model, example.old)} · ` : ""}Green: {aiLabel(model, example.new)}
              </small>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
