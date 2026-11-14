/**
 * SlopHop's look and sound, in one place.
 *
 * - `tokens` are the app's CSS custom properties (see app/globals.css).
 * - Games pick their OWN theme per puzzle. `gameCraft` is only the shared
 *   craft bar every game should meet, whatever its theme.
 * - `musicDirection` is the base brief for every Lyria soundtrack; each puzzle adds its own vibe.
 */
export const STYLE = {
  fontsHref:
    "https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap",
  tokens: {
    "--sh-bg": "#f7f6f2",
    "--sh-surface": "#ffffff",
    "--sh-ink": "#161616",
    "--sh-muted": "#8a867d",
    "--sh-line-soft": "#dcd9d1",
    "--sh-accent": "#ff4d2e",
    "--sh-good": "#2f9e5b",
    "--sh-bad": "#e5484d",
    "--sh-hair": "1px",
    "--sh-radius": "14px",
    "--sh-font-body": "'Geist', system-ui, sans-serif",
    "--sh-font-mono": "'Geist Mono', ui-monospace, monospace",
    "--sh-font-display": "'Instrument Serif', Georgia, serif",
  } as Record<string, string>,
  /** The craft bar every microgame meets, whatever its art style (see lib/catalog.ts). */
  gameCraft: `
Clean AND fun. Think Brilliant.org's elegance, Brain Age's clarity, WarioWare's punch and wit.
- One idea per screen. Big, confident shapes; strong hierarchy; generous empty space. Nothing decorative that doesn't move or matter.
- Fun comes from feel, not decoration: satisfying physics, snappy springs, anticipation and payoff, a surprising twist, sound on every touch.
- Witty, not childish: dry humour and clever visual gags for grown-ups. No baby talk, no exclamation spam, no cartoon mascots or googly eyes
  unless the art style truly calls for it.
- Feedback is instant and readable without words: things glow, snap, crack, tip over, fill up.
`.trim(),
  /** How everything players read should sound. Used by both the design and the build prompts. */
  plainLanguage: `
Write for a smart adult who has never written code. Every word on screen must make sense on its own. Clear, never condescending.
- Name buttons after what they DO in the game's world, as a verb: "Ring the bell", "Pour it in", "Stamp the letter", "Try again".
  Never generic machine words like Run, Execute, Submit, Process, Toggle, Input, Output, Set up, Reset state.
- Name things after what they ARE in the world: "the red jar", "the late train", "a blank ticket". Never variables or IDs.
- Translate tech concepts into everyday equivalents that mean the same thing:
  error / exception / crash -> "gets stuck", "jams", "gives up" | empty / null / missing -> "nothing there", "blank"
  invalid / malformed -> "smudged", "doesn't make sense" | parse / validate -> "read", "check"
  limit / overflow / out of bounds -> "too many", "past the end of the shelf" | index / offset -> "spot", "shelf number"
  cache -> "memory", "notes" | request / response / API / server -> "message", "reply", "the office"
  flag / boolean -> "on/off switch" | default -> "what it does if nobody says" | timeout -> "waited too long"
  edge case -> "tricky situation" | regression -> "something that used to work breaks" | fallback -> "plan B"
  format / schema / version -> "the old way" / "the new way" of writing it | legacy -> "old" | nested -> "inside another"
  resolve / evaluate / compute -> "work out" | trigger -> "set off" | instance -> "one of them"
  byte / character / ASCII -> "letter", "squiggle", "odd symbol" | percent over 100 -> prefer "x times as strong"
- Never show: code, symbols like * / () [] {} _ ==, hex numbers, file names, function or variable names, or words like
  function, variable, string, array, parse, null, boolean, bug, PR, merge, commit, deploy, config, query, payload, render.
- Short sentences. Concrete numbers small (0-10).
`.trim(),
  musicDirection:
    "Instrumental only, no vocals. Background loop for a short logic puzzle: calm enough to think, with a playful hook. Seamless loop, steady energy, no big intro or ending.",
};

export function tokensCss(selector = ":root") {
  const body = Object.entries(STYLE.tokens).map(([key, value]) => `${key}:${value};`).join("");
  return `${selector}{${body}}`;
}
