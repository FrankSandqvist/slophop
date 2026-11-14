import "server-only";
import { commonProperties, type CommonDesign } from "./families";
import type { PullRequestSource } from "./github";
import { flowKey, reachable, runFlow, type FlowModel, type FlowScenario, type FlowStateDef, type FlowTransition, type Round, type Tone } from "./types";

/**
 * FLOW puzzles: a business process (states and the events that move between them) before and after the change.
 * Gemini describes the two maps and some scenarios; our code simulates every scenario through both maps, so the answers
 * are exact. Built for bigger, business-logic PRs: refunds, subscriptions, checkout, approvals, order statuses.
 */

const str = (description: string) => ({ type: "string", description });

// No minItems/maxItems on these nested arrays: Gemini rejects deeply nested schemas with them. Validation enforces limits.
export const flowSchema = {
  type: "object",
  properties: {
    ...commonProperties("process", "Describe how things move, e.g. 'A refund is only allowed after the parcel is delivered.'"),
    flow: {
      type: "object",
      properties: {
        start: str("Id of the state everything starts in."),
        states: {
          type: "array",
          description: "4-8 states of the process (union of before and after).",
          items: {
            type: "object",
            properties: {
              id: str("Short lowercase slug."),
              label: str("Plain name, 1-2 words, max 12 characters (e.g. 'Paid', 'On hold')."),
              tone: { type: "string", enum: ["good", "bad", "neutral"], description: "How a user would feel about ending up here." },
              explain: str("What this state means in the scene, plain words, max 14 words."),
            },
            required: ["id", "label", "tone", "explain"],
          },
        },
        events: {
          type: "array",
          description: "3-8 things that can happen (actions, timeouts, failures).",
          items: {
            type: "object",
            properties: {
              id: str("Short lowercase slug."),
              label: str("Plain name, 1-2 words, max 12 characters (e.g. 'Refund', 'Times out')."),
              story: str("The event as a short second-person phrase, max 9 words (e.g. 'you ask for your money back')."),
            },
            required: ["id", "label", "story"],
          },
        },
        old: { type: "array", description: "Red's map (BEFORE): every arrow from state + event to state. Max 14.", items: transitionSchema() },
        new: { type: "array", description: "Green's map (AFTER): every arrow from state + event to state. Max 14.", items: transitionSchema() },
        scenarios: {
          type: "array",
          description: "4-8 realistic stories, each 2-5 events in order. Include ones where Red and Green end differently and ones where they agree.",
          items: {
            type: "object",
            properties: { id: str("Short lowercase slug."), events: { type: "array", items: str("An event id.") } },
            required: ["id", "events"],
          },
        },
      },
      required: ["start", "states", "events", "old", "new", "scenarios"],
    },
  },
  required: ["title", "project", "change", "where", "scenario", "rules", "component", "lines", "codeAnchor", "flow"],
};

function transitionSchema() {
  return {
    type: "object",
    properties: { from: str("State id."), event: str("Event id."), to: str("State id.") },
    required: ["from", "event", "to"],
  };
}

export type FlowDesign = CommonDesign & {
  flow: {
    start: string;
    states: Array<{ id: string; label: string; tone: string; explain: string }>;
    events: Array<{ id: string; label: string; story: string }>;
    old: FlowTransition[];
    new: FlowTransition[];
    scenarios: Array<{ id: string; events: string[] }>;
  };
};

export function flowPrompt(pr: PullRequestSource) {
  return `You design SlopHop puzzles. SlopHop shows curious people what is changing in the public software around them, as a tiny brain teaser.
Two characters star in every puzzle: GREEN is the code this pull request ADDED, RED is the code it REMOVED.

This puzzle is about a FLOW: a business process that people, orders, payments, tickets or accounts move through (statuses,
lifecycles, workflows, approvals, subscriptions, refunds). Pick the one process this PR changes and draw it as a small map,
before and after.

HOW TO MODEL IT
- States: 4-8 plain steps of the process (e.g. Cart, Paid, Shipped, Delivered, Refunded, Stuck). Mark each good/bad/neutral.
- Events: 3-8 things that happen (a person acts, a payment fails, a timer runs out). Conditions become separate events
  (e.g. "refund within 30 days" vs "refund after 30 days").
- Maps: every arrow "from state + event -> to state", for Red (before) and Green (after). Mirror the real code faithfully,
  quirks included. Keep it coarse: the journey, not every detail. An event with no arrow from a state does nothing there.
- Scenarios: 4-8 realistic stories (2-5 events each) that show the change: some where Red and Green end differently, some
  where they agree. Our code runs them through both maps, so just list the events.
- Rulebooks: plain lines that let a player trace both maps ("After shipping, a refund needs the parcel back first.").
- Set the scene ("where", "scenario", second person). Plain language, no code or jargon; clear and witty, never childish.

=== PULL REQUEST: ${pr.repository}#${pr.number}: ${pr.title}
DESCRIPTION:
${pr.body.slice(0, 1500) || "(none)"}
DIFF:
${pr.diff}
CODE AROUND THE CHANGES:
${pr.context || "(unavailable)"}`;
}

const slug = (value: unknown, fallback: string) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || fallback;
const tones = ["good", "bad", "neutral"];

/** Cleans the design, simulates every scenario through both maps, and checks the change actually shows. */
export function validateFlow(design: FlowDesign): FlowModel {
  const raw = design.flow;
  if (!raw) throw new Error("The flow puzzle came back without its map.");
  const states: FlowStateDef[] = [];
  for (const [index, state] of (raw.states ?? []).entries()) {
    const id = slug(state?.id, `s${index}`);
    if (states.some((entry) => entry.id === id) || states.length >= 8) continue;
    states.push({ id, label: String(state?.label ?? id).slice(0, 14), tone: (tones.includes(state?.tone) ? state.tone : "neutral") as Tone, explain: String(state?.explain ?? "").slice(0, 110) });
  }
  const stateIds = new Set(states.map((state) => state.id));
  const events = (raw.events ?? [])
    .map((event, index) => ({ id: slug(event?.id, `e${index}`), label: String(event?.label ?? "").slice(0, 14), story: String(event?.story ?? "").slice(0, 70) }))
    .filter((event, index, all) => all.findIndex((other) => other.id === event.id) === index)
    .slice(0, 8);
  const eventIds = new Set(events.map((event) => event.id));
  const clean = (list: FlowTransition[] | undefined) => {
    const seen = new Set<string>();
    return (list ?? [])
      .map((transition) => ({ from: slug(transition?.from, ""), event: slug(transition?.event, ""), to: slug(transition?.to, "") }))
      .filter((transition) => stateIds.has(transition.from) && stateIds.has(transition.to) && eventIds.has(transition.event))
      // One arrow per state + event (the first wins), so the map is deterministic.
      .filter((transition) => (seen.has(`${transition.from}|${transition.event}`) ? false : (seen.add(`${transition.from}|${transition.event}`), true)))
      .slice(0, 14);
  };
  const old = clean(raw.old);
  const next = clean(raw.new);
  const start = stateIds.has(slug(raw.start, "")) ? slug(raw.start, "") : states[0]?.id;
  if (!start || states.length < 3 || events.length < 2 || !old.length || !next.length) throw new Error("The flow puzzle's map is too thin.");
  // States no arrow can reach on either map (and not the start) would only clutter the map: drop them.
  const reach = new Set([...reachable(start, old), ...reachable(start, next)]);
  for (let index = states.length - 1; index >= 0; index--) if (!reach.has(states[index].id)) states.splice(index, 1);
  const scenarios: FlowScenario[] = [];
  for (const [index, scenario] of (raw.scenarios ?? []).entries()) {
    const sequence = (scenario?.events ?? []).map((id) => slug(id, "")).filter((id) => eventIds.has(id)).slice(0, 5);
    if (sequence.length < 1) continue;
    const id = slug(scenario?.id, `story-${index}`);
    if (scenarios.some((entry) => entry.id === id || entry.events.join() === sequence.join())) continue;
    scenarios.push({ id, events: sequence, old: runFlow(start, old, sequence), new: runFlow(start, next, sequence) });
  }
  const oldKeys = new Set(old.map(flowKey));
  const changedArrows = next.some((transition) => !oldKeys.has(flowKey(transition))) || old.length !== next.length;
  if (!changedArrows) throw new Error("Red's and Green's maps are the same.");
  if (scenarios.length < 3) throw new Error("The flow puzzle needs more scenarios.");
  return { start, states, events, old, new: next, scenarios: scenarios.slice(0, 8) };
}

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];
const shuffle = <T,>(items: T[]) => [...items].sort(() => Math.random() - 0.5);
const end = (path: string[]) => path[path.length - 1];

/** Trace a story on Green's map, spot the arrow that changed, find the dead end, break it, trace Red's. 3-5 steps. */
export function buildFlowRounds(model: FlowModel): Round[] {
  const differ = model.scenarios.filter((scenario) => end(scenario.old) !== end(scenario.new));
  const rounds: Round[] = [];
  const first = pick(differ.length ? differ : model.scenarios);
  rounds.push({ kind: "flow-trace", scenario: first.id, side: "new" });

  const oldKeys = new Set(model.old.map((transition) => flowKey(transition)));
  const added = model.new.some((transition) => !oldKeys.has(flowKey(transition)));
  rounds.push({ kind: "flow-change", side: added ? "new" : "old" });

  const middle: Round[] = [];
  const before = reachable(model.start, model.old);
  const after = reachable(model.start, model.new);
  const lost = model.states.filter((state) => before.has(state.id) && !after.has(state.id));
  const gained = model.states.filter((state) => after.has(state.id) && !before.has(state.id));
  if (lost.length === 1) middle.push({ kind: "flow-dead", mode: "lost", answer: lost[0].id });
  else if (gained.length === 1) middle.push({ kind: "flow-dead", mode: "gained", answer: gained[0].id });

  const toneOf = (id: string) => model.states.find((state) => state.id === id)?.tone;
  const bad = model.scenarios.filter((scenario) => toneOf(end(scenario.new)) === "bad");
  const fine = model.scenarios.filter((scenario) => toneOf(end(scenario.new)) !== "bad");
  if (bad.length && fine.length >= 2) {
    const answer = pick(bad);
    middle.push({ kind: "flow-break", options: shuffle([answer.id, ...shuffle(fine).slice(0, 2).map((scenario) => scenario.id)]), answer: answer.id });
  }
  const forRed = differ.filter((scenario) => scenario.id !== first.id);
  if (forRed.length) middle.push({ kind: "flow-trace", scenario: pick(forRed).id, side: "old" });
  return [...rounds, ...shuffle(middle)].slice(0, 5);
}
