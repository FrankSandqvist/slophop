/**
 * Mechanic ideas offered to the designer as inspiration (a shuffled few per puzzle), so games don't all
 * converge on the same interaction. The designer may pick one or invent something better.
 * Art direction is NOT catalogued: every game invents its own.
 */

export type Mechanic = { id: string; name: string; how: string; goodFor: string };

export const MECHANICS: Mechanic[] = [
  { id: "sort", name: "Sorting", how: "Drag items into bins; the bins react to the rule.", goodFor: "conditions, categories" },
  { id: "gate", name: "Gatekeeping", how: "Items arrive at a gate; shape each one so the gate accepts or rejects it.", goodFor: "checks, filters" },
  { id: "balance", name: "Balancing", how: "Place weights on a scale until it settles exactly; overshooting tips it.", goodFor: "limits, thresholds, totals" },
  { id: "dial", name: "Tuning", how: "Rotate a dial; the output morphs live. Find the zone where behaviour flips.", goodFor: "ranges, boundaries" },
  { id: "scrub", name: "Finding the edge", how: "Slide a marker along a line of values and watch the result flip. Pin the exact edge.", goodFor: "off-by-one, boundaries" },
  { id: "assemble", name: "Assembling", how: "Snap pieces into a chain or recipe that produces a target result.", goodFor: "composition, parsing, formats" },
  { id: "predict", name: "Predicting", how: "Before releasing something, place a marker where you think it ends up; then watch it go.", goodFor: "prediction, flow" },
  { id: "route", name: "Routing", how: "Flip switches or draw paths so each item reaches the right destination.", goodFor: "branching, decisions" },
  { id: "stack", name: "Stacking", how: "Stack blocks; the tower holds or topples according to the rule.", goodFor: "ordering, capacity" },
  { id: "pour", name: "Pouring", how: "Press and hold to pour; release at the right amount. Too much overflows.", goodFor: "limits, overflow, quantities" },
  { id: "slice", name: "Slicing", how: "Cut a strand exactly where it should split.", goodFor: "splitting, parsing" },
  { id: "line-up", name: "Sequencing", how: "Arrange cards in the order things really happen; then watch it play out.", goodFor: "ordering, timing, races" },
  { id: "trace", name: "Tracing", how: "Guide a token along its real path through the system; branches open and close as you go.", goodFor: "the whole system" },
  { id: "tile", name: "Tiling", how: "Fit shaped pieces into a grid; some shapes are only allowed in some places.", goodFor: "constraints, validation" },
  { id: "mirror", name: "Mirroring", how: "Two machines side by side, old and new; set one up so they disagree.", goodFor: "showing a fix, differences" },
];

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** A shuffled handful of mechanic ideas for one puzzle. */
export function offerMechanics(count = 5) {
  return shuffle(MECHANICS).slice(0, count);
}
