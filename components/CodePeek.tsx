"use client";

import { useEffect, useState } from "react";
import type { CodeSpot } from "@/lib/puzzles";

export type Peek = { spot: CodeSpot; happened: string; anchor: { x: number; y: number } | null; at: number };

const TAG_MS = 12_000;

/**
 * Standardized code popup, always tied to something the player just saw:
 * a small "why?" tag appears where it happened; tapping it opens what happened, why, and the real change.
 * Never opens by itself. The latest peek stays reachable from a chip.
 */
export function CodePeek({ peek, stage }: { peek: Peek | null; stage: { width: number; height: number } }) {
  const [open, setOpen] = useState(false);
  const [tagVisible, setTagVisible] = useState(false);

  useEffect(() => {
    if (!peek) return;
    // A fresh peek shows its tag; the card stays closed until the player asks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTagVisible(true);
    setOpen(false);
    const timer = window.setTimeout(() => setTagVisible(false), TAG_MS);
    return () => window.clearTimeout(timer);
  }, [peek]);

  if (!peek) return null;
  const { spot, happened, anchor } = peek;
  const point = anchor ?? { x: stage.width / 2, y: stage.height - 96 };
  const narrow = stage.width < 560;

  const cardStyle: React.CSSProperties | undefined = narrow
    ? undefined
    : {
        left: Math.min(Math.max(point.x - 180, 12), stage.width - 372),
        ...(point.y > stage.height / 2 ? { bottom: stage.height - point.y + 24 } : { top: point.y + 24 }),
      };

  return (
    <>
      {tagVisible && !open && (
        <button
          className="peek-tag"
          style={{ left: point.x, top: point.y }}
          onClick={() => setOpen(true)}
          aria-label="Why did that happen? Show the code behind it"
        >
          why? <span aria-hidden>{"{ }"}</span>
        </button>
      )}

      {!open && !tagVisible && (
        <button className="peek-chip" onClick={() => setOpen(true)} aria-label="Show the last code change you uncovered">
          <span aria-hidden>{"{ }"}</span> code
        </button>
      )}

      {open && (
        <section className={`peek ${narrow ? "peek-sheet" : ""}`} style={cardStyle} role="dialog" aria-label="The code behind what just happened">
          <header>
            <span className="peek-kicker">What just happened</span>
            <button className="peek-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          {happened && <p className="peek-happened">{happened}</p>}
          <p className="peek-why"><span>Why</span>{spot.caption}</p>
          <pre className="peek-code">
            {spot.lines.map((line, index) => {
              const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
              return (
                <span key={index} className={`peek-line peek-${kind}`} style={{ animationDelay: `${index * 60}ms` }}>
                  <i aria-hidden>{kind === "add" ? "+" : kind === "del" ? "−" : " "}</i>
                  {line.slice(1) || " "}
                  {"\n"}
                </span>
              );
            })}
          </pre>
          <p className="peek-file">{spot.file}</p>
        </section>
      )}
    </>
  );
}
