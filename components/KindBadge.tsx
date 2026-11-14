import { FAMILY_BADGES, type PuzzleFamily } from "@/lib/types";

/**
 * LOGIC / MATH / UX / FLOW: what kind of puzzle this is; mixed puzzles show both ("MATH + UX"). Ink, yellow, white and
 * sky blue, so a badge never reads as Red or Green.
 */
export function KindBadge({ family, families }: { family?: PuzzleFamily; families?: PuzzleFamily[] }) {
  const kinds = families?.length ? families : [family ?? "logic"];
  return (
    <span className="kind-badges">
      {kinds.map((kind, index) => (
        <span key={kind}>
          {index > 0 && <span className="kind-plus">+</span>}
          <span className={`kind-badge kind-${kind}`}>{FAMILY_BADGES[kind]}</span>
        </span>
      ))}
    </span>
  );
}
