"use client";

import type { Line } from "./DS";
import { MascotHead } from "./Rounds";

export const TUTORIAL_KEY = "slophop-tutorial-done";

/** A tutorial line; `item` lights up that step of the How to play card while it's being said. */
export type TutorialLine = Line & { item?: number };

/** What the three say on a first visit to the landing page. */
export const TUTORIAL: TutorialLine[] = [
  { who: "narrator", text: "Welcome to SlopHop! Real code changes from the software around you, as tiny brain teasers." },
  { who: "del", text: "I'm Red: the OLD code. I show how things worked before a change." },
  { who: "add", text: "And I'm Green: the NEW code. I show how things work now!" },
  { who: "narrator", text: "Each puzzle opens with a short movie and our two rulebooks: that's the change.", item: 0 },
  { who: "add", text: "Then you use our rules to work out what we do, in a few quick puzzles.", item: 1 },
  { who: "del", text: "After each one, vote: is Green's new way right? Your votes help people judge the change.", item: 2 },
  { who: "add", text: "Or press + New puzzle: we grab a real, recent pull request made with an AI coding tool and puzzle it up.", item: 3 },
  { who: "narrator", text: "Pick a puzzle below to start!" },
];

const STEPS = [
  "Meet the change: a short movie, then Red's old rules and Green's new rules.",
  "Solve 3 to 5 quick puzzles with those rules. Stuck? The Rules button has them.",
  "Vote after each one: is Green's way right for that case?",
  "Make your own: + New puzzle turns a real, recent AI-made pull request into a new puzzle.",
];

/** The How to play card on the landing page: who's who, and the steps (the one being explained lights up). */
export function HowToPlay({ item, onClose }: { item?: number; onClose: () => void }) {
  return (
    <section className="howto" aria-label="How to play">
      <div className="howto-head">
        <span className="howto-title">HOW TO PLAY</span>
        <button className="px-btn px-btn-small" onClick={onClose} aria-label="Close how to play">Got it</button>
      </div>
      <div className="howto-cast">
        <span className="howto-who"><MascotHead kind="del" /> RED = old code</span>
        <span className="howto-who"><MascotHead kind="add" /> GREEN = new code</span>
      </div>
      <ol>
        {STEPS.map((step, index) => (
          <li key={step} className={index === item ? "howto-on" : ""}>{step}</li>
        ))}
      </ol>
    </section>
  );
}
