// height-movement.test.mjs — HEIGHT_MOVEMENT guard: when DNO may say heights advanced, and for how long they have not.
// Runs the real updateHeightTracker() from agent.mjs (extracted from the source) against synthetic rounds.
// Run: bun src/height-movement.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sanitizeHeight } from "./public-safety.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "HEIGHT_MOVEMENT";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const decl = SRC.match(/var heightTracker = \{[^;]*\};/)[0];
const fnStart = SRC.indexOf("function updateHeightTracker(");
const fnSrc = SRC.slice(fnStart, SRC.indexOf("\n}\n", fnStart) + 3);
const INTERVAL_S = 20, STATIC_MIN = 5;
// history: rows newest first, as the query returns them ({ ts, median_block }).
function fresh(history) {
  const db = history ? { query: () => ({ all: () => history }) } : null;
  return new Function("sanitizeHeight", "sharedDb", decl + "\n" + fnSrc + "\nreturn { t: heightTracker, update: updateHeightTracker };")(sanitizeHeight, db);
}
const round = (heights) => Object.entries(heights).map(([name, block]) => ({ name, ok: block !== undefined, block }));
// The published values, as computeCanonicalState derives them.
function published(t, observedAt, anyHeight = true) {
  const staticS = t.compared && t.advancedAt && anyHeight ? Math.max(0, Math.round((observedAt - t.advancedAt) / 1000)) : null;
  const advancing = staticS !== null && t.advanceKnown && staticS <= 2 * INTERVAL_S;
  const stalled = staticS !== null && staticS >= STATIC_MIN * 60;
  return { staticS, advancedAt: t.advanceKnown ? t.advancedAt : null, reason: advancing ? "advancing" : stalled ? "unchanged" : "aligned" };
}
const T0 = 1_800_000_000_000, S = 1000;

console.log("\n[" + TAG + "] start, advance, static");
{
  const { t, update } = fresh(null);
  update(round({ a: 100, b: 100 }), T0);
  let p = published(t, T0);
  check("A1 first round after a start: nothing claimed", p.staticS === null && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
  update(round({ a: 101, b: 100 }), T0 + 20 * S);
  p = published(t, T0 + 20 * S);
  check("A2 an observed advance: static 0, advancing", p.staticS === 0 && p.advancedAt === T0 + 20 * S && p.reason === "advancing", JSON.stringify(p));
  update(round({ a: 101, b: 101 }), T0 + 40 * S);
  p = published(t, T0 + 40 * S);
  check("A3 a lagging seed catching up is an advance too", p.staticS === 0, JSON.stringify(p));
  for (let k = 3; k <= 20; k++) update(round({ a: 101, b: 101 }), T0 + k * 20 * S);
  p = published(t, T0 + 400 * S);
  check("A4 six minutes without a higher height: unchanged", p.staticS === 360 && p.reason === "unchanged", JSON.stringify(p));
}
{
  const { t, update } = fresh(null);
  update(round({ a: 100, b: 100 }), T0);
  update(round({ a: 100, b: 100 }), T0 + 20 * S);
  const p = published(t, T0 + 20 * S);
  check("A5 two equal rounds after a start: a lower bound, no advance claimed", p.staticS === 20 && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
}

console.log("\n[" + TAG + "] seeds leaving and joining");
{
  const { t, update } = fresh(null);
  update(round({ a: 200, b: 190 }), T0);
  update(round({ a: 201, b: 191 }), T0 + 20 * S);
  update(round({ b: 191 }), T0 + 40 * S);
  let p = published(t, T0 + 40 * S);
  check("B1 the leading seed stops answering: not an advance, not a stall either", p.staticS === 20 && p.reason === "advancing", JSON.stringify(p));
  update(round({ b: 192 }), T0 + 60 * S);
  p = published(t, T0 + 60 * S);
  check("B2 the remaining seed advancing is seen", p.staticS === 0, JSON.stringify(p));
}
{
  const { t, update } = fresh(null);
  update(round({ a: 300 }), T0);
  update(round({ a: 300 }), T0 + 20 * S);
  update(round({ b: 305 }), T0 + 40 * S);
  const p = published(t, T0 + 40 * S);
  check("B3 a seed answering for the first time above the last round's highest height is an advance", p.staticS === 0, JSON.stringify(p));
}
{
  const { t, update } = fresh(null);
  update(round({ a: 395000, b: 395000 }), T0);
  update(round({ a: 395001, b: 395001 }), T0 + 20 * S);
  update(round({ a: 5, b: 5 }), T0 + 40 * S);
  update(round({ a: 6, b: 5 }), T0 + 60 * S);
  const p = published(t, T0 + 60 * S);
  check("C1 a chain reset is followed by the next advance, not a long stall", p.staticS === 0 && t.maxHeight === 6, JSON.stringify(p));
}
{
  const { t, update } = fresh(null);
  update(round({ a: 100, b: 100 }), T0);
  update(round({ a: undefined, b: undefined }), T0 + 20 * S);
  const p = published(t, T0 + 20 * S, false);
  check("C2 a round without any height publishes nothing about movement", p.staticS === null && t.maxHeight === null, JSON.stringify(p));
}

console.log("\n[" + TAG + "] restart with retained history");
{
  const hist = [];
  for (let k = 1; k <= 30; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 500 });   // 10 minutes at 500
  hist.push({ ts: T0 - 31 * 20 * S, median_block: 499 });
  const { t, update } = fresh(hist);
  update(round({ a: 500, b: 500 }), T0);
  const p = published(t, T0);
  check("D1 a restart during a stall keeps the run and its start", p.staticS === 600 && p.advancedAt === T0 - 30 * 20 * S && p.reason === "unchanged", JSON.stringify(p));
}
{
  const hist = [];
  for (let k = 1; k <= 2000; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 395000 - k });
  const { t, update } = fresh(hist);
  update(round({ a: 12, b: 12 }), T0);
  const p = published(t, T0);
  check("D2 a restart after a chain reset claims nothing from the old chain", p.staticS === null && p.reason === "aligned", JSON.stringify(p));
}
{
  const hist = [{ ts: T0 - 20 * S, median_block: 480 }, { ts: T0 - 40 * S, median_block: 479 }];
  const { t, update } = fresh(hist);
  update(round({ a: 500, b: 500 }), T0);
  const p = published(t, T0);
  check("D3 a restart after the height moved on: nothing claimed until the next round", p.staticS === null, JSON.stringify(p));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
