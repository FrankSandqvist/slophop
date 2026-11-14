"use client";

import { useEffect, useRef, useState } from "react";
import { drawText } from "@/lib/pixelfont";
import { sfx } from "@/lib/sound";
import { formatNumber, pointAt, type MockShape, type NumericModel, type VisualModel, type VisualState } from "@/lib/types";

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
