/**
 * Prints pitch/deck.html to pitch/SlopHop-pitch.pdf with headless Chrome (one 1920x1080 page per slide), after the pixel
 * font has loaded, and reports anything that sticks out of its slide or its box. Run from the repo root:
 *   node pitch/build.mjs            (assets: npx tsx pitch/make-assets.ts)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "slophop-pitch-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });

const endpoint = await new Promise((resolve, reject) => {
  let log = "";
  chrome.stderr.on("data", (data) => {
    log += data;
    const match = log.match(/ws:\/\/[^\s]+/);
    if (match) resolve(match[0]);
  });
  chrome.on("exit", () => reject(new Error(`Chrome exited:\n${log}`)));
});

const browser = new WebSocket(endpoint);
await new Promise((resolve) => browser.addEventListener("open", resolve, { once: true }));
let id = 0;
const pending = new Map();
browser.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const call = ++id;
    pending.set(call, { resolve, reject });
    browser.send(JSON.stringify({ id: call, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page("Page.enable");
  await page("Page.navigate", { url: `file://${join(here, "deck.html")}` });
  const evaluate = async (expression) => (await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  for (let tries = 0; tries < 50 && (await evaluate("document.readyState")) !== "complete"; tries++) await new Promise((r) => setTimeout(r, 100));
  await evaluate("document.fonts.ready.then(() => document.fonts.check('48px DotGothic16'))");

  // Anything outside its slide, or text wider than its box, is a layout bug.
  const problems = await evaluate(`(() => {
    const out = [];
    document.querySelectorAll('.slide').forEach((slide, index) => {
      const box = slide.getBoundingClientRect();
      slide.querySelectorAll('*').forEach((el) => {
        if (el.matches('.cast, .bg')) return; // meant to bleed off the edge
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const name = el.className || el.tagName;
        if (r.right > box.right + 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.top < box.top - 1) out.push('slide ' + (index + 1) + ': ' + name + ' leaves the slide');
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push('slide ' + (index + 1) + ': ' + name + ' overflows sideways');
      });
      // A yellow highlight must not wrap onto an extra line (it breaks into uneven blocks); break lines on purpose instead.
      slide.querySelectorAll('.hl').forEach((el) => {
        const lines = new Set([...el.getClientRects()].map((r) => Math.round(r.top)));
        if (lines.size > 1 + el.querySelectorAll('br').length) out.push('slide ' + (index + 1) + ': highlight wraps: ' + el.textContent);
      });
      // Nor may it cover any other text on the slide.
      const texts = [...slide.querySelectorAll('h1, h2, p, li, span, b, div')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      slide.querySelectorAll('.hl').forEach((el) => {
        const a = el.getBoundingClientRect();
        texts.forEach((other) => {
          if (other === el || el.contains(other) || other.contains(el)) return;
          const range = document.createRange();
          range.selectNodeContents(other);
          // The letters fill about one em around the middle of the font's (taller) content box.
          const em = parseFloat(getComputedStyle(other).fontSize);
          for (const r of range.getClientRects()) {
            const mid = (r.top + r.bottom) / 2;
            const b = { left: r.left, right: r.right, top: mid - em / 2, bottom: mid + em / 2 };
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) { out.push('slide ' + (index + 1) + ': highlight "' + el.textContent + '" covers "' + other.textContent.trim().slice(0, 30) + '"'); break; }
          }
        });
      });
      // Headlines break lines on purpose (<br>, or one block per line in .stack); any other wrap strands a word.
      slide.querySelectorAll('h1:not(.stack)').forEach((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const em = parseFloat(getComputedStyle(el).fontSize);
        const mids = [];
        for (const r of range.getClientRects()) {
          const mid = (r.top + r.bottom) / 2;
          if (!mids.some((m) => Math.abs(m - mid) < em / 2)) mids.push(mid);
        }
        if (mids.length > 1 + el.querySelectorAll('br').length) out.push('slide ' + (index + 1) + ': headline wraps: ' + el.textContent.trim().slice(0, 40));
      });
      // Siblings in grids and rows must not overlap each other.
      slide.querySelectorAll('.grid4, .pillars, .crew, .rules, .next, .loop, .chips, .stats, .meet, .kinds, .end-row, .partners, .title').forEach((group) => {
        const kids = [...group.children].map((k) => k.getBoundingClientRect());
        kids.forEach((a, i) => kids.slice(i + 1).forEach((b) => {
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push('slide ' + (index + 1) + ': overlap in ' + group.className);
        }));
      });
    });
    return { slides: document.querySelectorAll('.slide').length, font: document.fonts.check('48px DotGothic16'), out };
  })()`);
  console.log(`${problems.slides} slides, pixel font loaded: ${problems.font}`);
  for (const line of problems.out) console.log("  ! " + line);

  const { data } = await page("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  writeFileSync(join(here, "SlopHop-pitch.pdf"), Buffer.from(data, "base64"));
  console.log("Wrote pitch/SlopHop-pitch.pdf");
} finally {
  browser.close();
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
