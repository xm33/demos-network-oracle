// height-movement.test.mjs — HEIGHT_MOVEMENT guard: when DNO may say a new height was seen, and for how long none was.
// The height clock keeps what each source showed about itself (clockSources, stepHeightClock, heightMovementOf in
// status-rule.mjs). The cases run those functions on synthetic rounds. Then four searches, because a rule about what
// "new" means is easy to state and easy to get wrong:
//   - a world in which no height ever changes, every sequence of who answers: nothing may be claimed;
//   - the fold against a second, plain reading of its text, on random rounds;
//   - worlds with a ground truth (a chain that produces, halts and restarts lower; nodes that lag, stick and catch up):
//     what must never be said is never said;
//   - the same worlds replayed from their stored rounds: a restart publishes what the running process publishes.
// The agent's own use of the clock (its step, its stored row, its replay at start) is run in round-wiring.test.mjs.
// Run: bun src/height-movement.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { RULE, VALIDATORS_SOURCE, assess, clockSources, newHeightClock, stepHeightClock, heightMovementOf } from "./status-rule.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "HEIGHT_MOVEMENT";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const extract = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n}\n", i) + 3); };
const MONITOR_INTERVAL_MS = Number(SRC.match(/const MONITOR_INTERVAL_MS = parseInt\(process\.env\.MONITOR_INTERVAL_MS \|\| "(\d+)"\)/)[1]);
const CHAIN_STATIC_RUN_MIN_24H = Number(SRC.match(/var CHAIN_STATIC_RUN_MIN_24H = parseInt\(process\.env\.PHASE_B_CHAIN_STATIC_RUN_MIN \|\| '(\d+)'/)[1]);
const CFG = { roundSeconds: MONITOR_INTERVAL_MS / 1000, stalledSeconds: CHAIN_STATIC_RUN_MIN_24H * 60 };
const T0 = 1_800_000_000_000, S = 1000, MIN = 60 * S;

// A clock driven by rounds. seeds: { name: own height } (undefined: the seed gave none); validators: the heights of the
// validators read this round, or null when none was read.
function clock() {
  let state = newHeightClock(), had = false;
  const api = {
    round(seeds, at, validators = null) {
      const src = clockSources(Object.entries(seeds).filter(([, h]) => h !== undefined).map(([id, h]) => ({ id, h })), validators);
      state = stepHeightClock(state, src, at); had = src.length > 0; return api;
    },
    at(now) {
      const m = heightMovementOf(state, now, had, CFG);
      return { staticS: m.staticSeconds, advancedAt: m.advancedAt, reason: m.advancing ? "advancing" : m.stalled ? "no new height" : "aligned", since: m.since, following: m.following };
    },
    get state() { return state; }
  };
  return api;
}
const t = (sec) => T0 + sec * S;

console.log("\n[" + TAG + "] start, a new height, no new height");
{
  const c = clock().round({ a: 100, b: 100 }, t(0));
  let p = c.at(t(0));
  check("A1 first round after a start: nothing claimed", p.staticS === null && p.advancedAt === null && p.reason === "aligned" && p.since === null, JSON.stringify(p));
  p = c.round({ a: 101, b: 100 }, t(20)).at(t(20));
  check("A2 a seed above its own last answer and above everything read: a new height, static 0, advancing", p.staticS === 0 && p.advancedAt === t(20) && p.reason === "advancing", JSON.stringify(p));
  p = c.round({ a: 101, b: 101 }, t(40)).at(t(40));
  check("A3 a lagging seed catching up is no new height: that height was read before", p.staticS === 20 && p.advancedAt === t(20), JSON.stringify(p));
  for (let k = 3; k <= 20; k++) c.round({ a: 101, b: 101 }, t(k * 20));
  p = c.at(t(400));
  check("A3b 'advancing' is said up to two rounds after a new height (40 s), and 'no new height' from 5 minutes (300 s) on: both limits are inclusive", c.at(t(60)).reason === "advancing" && c.at(t(61)).reason === "aligned"
    && c.at(t(319)).reason === "aligned" && c.at(t(320)).reason === "no new height", JSON.stringify([c.at(t(60)).reason, c.at(t(61)).reason, c.at(t(319)).reason, c.at(t(320)).reason]));
  check("A4 six minutes without a new height: said, and counted from the round that showed it", p.staticS === 380 && p.reason === "no new height" && p.since === t(20), JSON.stringify(p));
  c.round({ a: undefined, b: undefined }, t(420));
  check("A5 nothing when the latest round had no source; the clock itself is not moved", c.at(t(420)).since === null && c.at(t(420)).staticS === null && c.state.top === 101 && c.state.topSince === t(20));
  p = c.round({ a: 101, b: 101 }, t(440)).at(t(440));
  check("A6 the next round with a reading carries on from where the clock stood", p.staticS === 420 && p.advancedAt === t(20), JSON.stringify(p));
}
{
  const p = clock().round({ a: 100, b: 100 }, t(0)).round({ a: 100, b: 100 }, t(20)).at(t(20));
  check("A7 two equal rounds after a start: a lower bound, and no new height is claimed to have been seen", p.staticS === 20 && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
}

console.log("\n[" + TAG + "] who answers changes; no height does");
{
  const c = clock().round({ a: 200, b: 190 }, t(0)).round({ a: 201, b: 191 }, t(20)).round({ b: 191 }, t(40), [201, 201]);
  let p = c.at(t(40));
  check("B1 the leading seed stops answering: no new height, and not 'advancing' for longer than two rounds after the last one", p.staticS === 20 && p.advancedAt === t(20), JSON.stringify(p));
  p = c.round({ a: 201, b: 191 }, t(60)).at(t(60));
  check("B2 it answers again at the height it left on: no new height", p.staticS === 40 && p.advancedAt === t(20), JSON.stringify(p));
}
{
  // 2 October 2026: node2 at the head, node3 ten behind; node2 goes silent, node3 catches up, node2 returns.
  const c = clock().round({ n2: 429825, n3: 429815 }, t(0)).round({ n2: 429825, n3: 429815 }, t(20));
  let at = 20; const said = [];
  for (const h of [429817, 429820, 429823, 429825]) { at += 20; c.round({ n3: h }, t(at), [429825, 429825, 429825]); said.push(c.at(t(at))); }
  check("B3 the 2 October sequence: a seed that fell behind and catches up while the other is silent shows no new height", said.every((p, i) => p.staticS === 20 * (i + 2) && p.advancedAt === null && p.reason !== "advancing") && c.state.top === 429825 && c.state.gave === null, JSON.stringify(said));
  const p = c.round({ n2: 429825, n3: 429825 }, t(at + 20)).at(t(at + 20));
  check("B3b and the count runs on from the first round that showed that height", p.staticS === at + 20 && p.since === t(0), JSON.stringify(p));
}
{
  // Three seeds standing on H, H-3, H-3: the median hides the highest. One seed missing a round changes the median.
  const H = 431000, c = clock();
  for (let k = 0; k <= 180; k++) c.round({ a: H, b: H - 3, c: H - 3 }, t(k * 20));
  let p = c.round({ a: H, b: undefined, c: H - 3 }, t(181 * 20)).at(t(181 * 20));
  check("B4 a seed missing a round is no new height, whatever it does to the median", p.staticS === 3620 && p.advancedAt === null && p.reason === "no new height" && c.state.top === H, JSON.stringify(p));
  p = c.round({ a: undefined, b: H - 3, c: H - 3 }, t(182 * 20)).round({ a: H, b: H - 3, c: H - 3 }, t(183 * 20)).at(t(183 * 20));
  check("B4b nor is the highest seed missing one and returning", p.staticS === 3660 && p.advancedAt === null && c.state.gave === null, JSON.stringify(p));
}
{
  // The reviewer's shortest case in a world where no height changes: [500], 620 s, [495], [497], [500].
  const c = clock().round({ a: 500, x: 500 }, t(0)).round({ a: 500, x: 500 }, t(20)).round({ c: 495, y: 495 }, t(640)).round({ b: 497, c: 495 }, t(660)).round({ a: 500, b: 497, c: 495 }, t(680));
  const p = c.at(t(680));
  check("B5 other seeds answering after a gap, each on its own standing height: no start-over, no new height", p.staticS === 680 && p.advancedAt === null && c.state.top === 500 && c.state.gave === null && c.state.lowSince === null, JSON.stringify([p, c.state]));
}
{
  const c = clock().round({ b: 495, c: 495 }, t(0)).round({ b: 495, c: 495 }, t(20)).round({ b: 495, c: 495 }, t(40));
  let p = c.round({ a: 500, b: 495 }, t(60)).at(t(60));
  check("B6 a seed heard for the first time, above everything read: the count starts again and nothing is claimed (DNO did not see that height arrive)", p.staticS === null && p.advancedAt === null && c.state.top === 500 && c.state.topSince === t(60) && c.state.seen === false, JSON.stringify(p));
  p = c.round({ a: 500, b: 495 }, t(80)).at(t(80));
  check("B6b from the next round the count is a lower bound from there", p.staticS === 20 && p.advancedAt === null, JSON.stringify(p));
  p = c.round({ a: 501, b: 495 }, t(100)).at(t(100));
  check("B6c and its own rise is then a new height", p.staticS === 0 && p.advancedAt === t(100), JSON.stringify(p));
}

console.log("\n[" + TAG + "] validators");
{
  const H = 431000, c = clock().round({ a: H, b: H }, t(0)).round({ a: H + 1, b: H + 1 }, t(20));
  let at = 20;
  for (let k = 0; k < 100; k++) { at += 20; c.round({ a: H + 1 }, t(at), [H + 1 + (k % 2), H + 1, H + 20]); }
  let p = c.at(t(at));
  check("V1 beside one seed no validator moves the clock, whatever heights it gives", p.staticS === at - 20 && p.advancedAt === t(20) && c.state.top === H + 1, JSON.stringify(p));
  for (let k = 0; k < 100; k++) { at += 20; c.round({}, t(at), [H + 1, H + 1, H + 1, H + 1 + (k % 2)]); }
  p = c.at(t(at));
  check("V2 with no seed, one validator of four alternating between two heights never produces a new height", p.staticS === at - 20 && c.state.top === H + 1 && c.state.last[VALIDATORS_SOURCE] === H + 1, JSON.stringify(p));
  for (let k = 0; k < 6; k++) { at += 20; c.round({}, t(at), [H + 1, H + 1 + (k % 2)]); }
  p = c.at(t(at));
  check("V3 of two validators the higher is their median: its first step up is a new height (a stated limit), and going back and forth after that is none", c.state.top === H + 2 && p.staticS === 80 && p.advancedAt === t(at - 80), JSON.stringify([p, c.state.top]));
}
{
  const H = 431000, c = clock();
  for (let k = 0; k <= 60; k++) c.round({ a: H, b: H }, t(k * 20));
  let p = c.round({}, t(61 * 20), [H + 1, H + 1, H + 1]).at(t(61 * 20));
  check("V4 seeds give way to validators whose median is one above: the count starts again there, and nothing is claimed", p.staticS === null && p.advancedAt === null && c.state.top === H + 1 && c.state.seen === false, JSON.stringify(p));
  p = c.round({}, t(62 * 20), [H + 1, H + 1, H + 1]).round({ a: H, b: H }, t(63 * 20)).round({}, t(64 * 20), [H + 1, H + 1, H + 1]).at(t(64 * 20));
  check("V4b going back and forth between seeds and validators after that restarts nothing", p.staticS === 60 && p.advancedAt === null && c.state.top === H + 1, JSON.stringify(p));
  for (let k = 0; k <= 60; k++) c.round({}, t((65 + k) * 20), [H, H, H]);
  const one = clock().round({ a: H, b: H }, t(0)).round({ a: H + 1 }, t(20), [H + 1, H + 1]);
  check("V5 two seeds, then one seed alone a block higher beside validators: the seed is the source, by its name, so its rise is a new height seen arriving", one.at(t(20)).staticS === 0 && one.at(t(20)).advancedAt === t(20)
    && one.state.last.a === H + 1 && one.state.last[VALIDATORS_SOURCE] === undefined, JSON.stringify([one.at(t(20)), one.state.last]));
  const ids = (list) => list.map((x) => x.id + ":" + x.h).join(" ");
  check("V6 with no seed the source is the upper median of every validator height read (102 here), which is what the reading publishes; not the median of those counted (101)",
    ids(clockSources([], [100, 101, 102, 200, 200])) === VALIDATORS_SOURCE + ":102" && assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 0, seedHeights: [], validators: { read: 5, heights: [100, 101, 102, 200, 200], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0, movement: {} }).agreement.median_block === 102,
    ids(clockSources([], [100, 101, 102, 200, 200])));
  check("V4c validators whose median equals the seeds' top restart nothing either", clock().round({ a: H, b: H }, t(0)).round({ a: H, b: H }, t(20)).round({}, t(40), [H, H, H]).at(t(40)).staticS === 40);
}

console.log("\n[" + TAG + "] a round without a reading does not move the clock");
{
  // The chain stands at 429825. The head seed goes silent; the other returns 2,000 behind and gains 40 a round, with
  // three validators on the head. One seed far from every validator read is no reading.
  const H = 429825, c = clock();
  for (let k = 0; k <= 170; k++) c.round({ head: H, other: H }, t(k * 20));
  let at = 170 * 20, h = H - 2000, claimed = 0, readings = 0;
  while (h + 40 < H - 25) { at += 20; h += 40; c.round({ other: h }, t(at), [H, H, H]); const p = c.at(t(at)); if (p.staticS !== null) readings++; if (p.advancedAt !== null) claimed++; }
  check("L1 a lone seed catching up from far behind is no reading: nothing is said, and the clock keeps the standstill", readings === 0 && claimed === 0 && c.state.top === H && c.state.topSince === t(0) && c.state.gave === null && c.state.lowSince === null, JSON.stringify(c.state));
  at += 20; let p = c.round({ other: H - 20 }, t(at), [H, H, H]).at(t(at));
  check("L2 when it comes within 25 blocks the reading is back, and it is the standstill that began before", p.staticS === at && p.advancedAt === null && p.reason === "no new height", JSON.stringify(p));
  at += 20; p = c.round({ other: H }, t(at), [H, H, H]).at(t(at));
  check("L3 and arriving on the head changes nothing: the standstill is " + Math.floor(at / 60) + " minutes old, not zero", p.staticS === at && c.state.top === H && c.state.gave === null, JSON.stringify(p));
  const r = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 1, seedHeights: [H], validators: { read: 3, heights: [H, H, H], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0,
    movement: { staticSeconds: p.staticS, advancing: false, stalled: true, staticSince: "2026-10-02 10:50:00" } });
  check("L4 so the reading is degraded at once, where a restarted count would have read stable for another 30 minutes", r.status === "degraded" && r.standstill === true && r.status_reason.startsWith("No new height for " + Math.floor(at / 60) + " min"), r.status_reason);
}

console.log("\n[" + TAG + "] a chain on a lower base, or nodes catching up: DNO cannot tell which");
{
  // A chain restarted lower while DNO keeps reading: both seeds on it, three blocks a round.
  const c = clock().round({ a: 395000, b: 395000 }, t(0)).round({ a: 395001, b: 395001 }, t(20));
  let at = 20, h = 5, max = 0, over = null, arrivals = 0, advancing = 0;
  for (let k = 0; k < 60; k++) { at += 20; c.round({ a: h, b: h }, t(at)); h += 3; const p = c.at(t(at)); if (p.staticS !== null) max = Math.max(max, p.staticS); if (over === null && c.state.gave) over = at; if (over !== null) { if (p.advancedAt !== null) arrivals++; if (p.reason === "advancing") advancing++; } }
  check("R1 a chain restarted lower: no new height while it has risen for less than ten minutes, then it is followed; never a standstill", over === 20 + 40 + 620 && max === over - 20 - 20 && max < RULE.standstillSeconds && c.state.top === h - 3 && c.state.gave.top === 395001,
    JSON.stringify({ over, max, top: c.state.top }));
  check("R2 while the old top is remembered no arrival is claimed and 'advancing' is not said; the count runs from each rise", arrivals === 0 && advancing === 0 && c.at(t(at)).staticS === 0 && c.state.seen === false, JSON.stringify({ arrivals, advancing, now: c.at(t(at)) }));
  for (let k = 0; k < 10; k++) { at += 20; c.round({ a: h - 3, b: h - 3 }, t(at)); }
  check("R3 and a stop of the followed heights shows", c.at(t(at)).staticS === 200 && c.at(t(at + 1800 * 1)).staticS === 2000);
  at += 86400; c.round({ a: h, b: h }, t(at)); at += 20; c.round({ a: h + 2, b: h + 2 }, t(at));
  check("R4 after 24 h the old top is forgotten: new heights are seen arriving again", c.state.gave === null && c.state.seen === true && c.at(t(at)).advancedAt === t(at) && c.at(t(at)).reason === "advancing", JSON.stringify(c.state));
}
{
  // The chain stands at H from second 0. The head seed goes silent and two seeds catch up together from 2,000 behind,
  // within 25 blocks of each other, for longer than ten minutes: a reading of two seeds, below the top and rising.
  const H = 429825, c = clock();
  for (let k = 0; k <= 170; k++) c.round({ head: H, x: H, y: H }, t(k * 20));
  let at = 170 * 20, h = H - 2000, over = null, arrivals = 0, stableAfter = 0;
  while (h < H) {
    at += 20; h = Math.min(H, h + 40); c.round({ x: h, y: Math.min(H, h + 3) }, t(at));
    const p = c.at(t(at)); if (over === null && c.state.gave) over = at; if (p.advancedAt !== null) arrivals++;
  }
  check("R5 two seeds catching up together for more than ten minutes are followed, and no arrival is claimed for any of their rises", over !== null && over === 170 * 20 + 40 + 620 && arrivals === 0, JSON.stringify({ over, arrivals }));
  check("R6 the round they land on the old top: the old count is back, and that round says nothing", c.state.top === H && c.state.topSince === t(0) && c.state.gave === null && c.state.hold === true && c.at(t(at)).staticS === null, JSON.stringify(c.state));
  at += 20; const p = c.round({ x: H, y: H }, t(at)).at(t(at));
  check("R7 from the next round the standstill is the one that began at second 0", p.staticS === at && p.reason === "no new height", JSON.stringify(p));
}
{
  // A seed catches up to the top itself: that is no rise below the top, so it begins no run of such rises. Later both
  // seeds fall back and rise for 40 seconds: far too short for a start-over, whatever happened ten minutes before.
  const c = clock().round({ a: 500, b: 480 }, t(0)).round({ a: 500, b: 500 }, t(20));
  c.round({ a: 300, b: 300 }, t(600)).round({ a: 301, b: 301 }, t(620)).round({ a: 302, b: 302 }, t(640)).round({ a: 303, b: 303 }, t(660));
  check("R7b a rise that reaches the top is not a rise below it: forty seconds of rising later do not make a start-over", c.state.gave === null && c.state.top === 500 && c.state.lowSince === t(620) && c.at(t(660)).staticS === 660, JSON.stringify(c.state));
  // A new height seen arriving, then a start-over, then a seed back exactly on the old top: in that round nothing is
  // said, not even when the last new height arrived; from the next round the old arrival time is back.
  const d = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20));
  let at = 20, h = 400;
  while (!d.state.gave) { at += 20; h += 1; d.round({ a: h, b: h }, t(at)); }
  at += 20; d.round({ a: 701, b: h }, t(at));
  const hold = d.at(t(at)); at += 20; d.round({ a: 701, b: 701 }, t(at));
  check("R7d the reading is told that DNO follows lower heights from the round it starts over to the round a seed is back on the old top, both included, and not before or after",
    (() => { const e = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20)); let k = 20, x = 400, before = [], during = [];
      while (!e.state.gave) { before.push(e.at(t(k)).following); k += 20; x += 1; e.round({ a: x, b: x }, t(k)); }
      during.push(e.at(t(k)).following); k += 20; e.round({ a: x + 1, b: x + 1 }, t(k)); during.push(e.at(t(k)).following);
      k += 20; e.round({ a: 701, b: x + 1 }, t(k)); const onHold = e.at(t(k)).following && e.state.hold; k += 20; e.round({ a: 701, b: 701 }, t(k));
      const noSource = heightMovementOf(Object.assign({}, e.state, { gave: { top: 9, since: 0, seen: false, at: 0 } }), t(k), false, CFG).following;
      return before.every((f) => f === false) && before.length > 30 && during.every((f) => f === true) && onHold === true && e.at(t(k)).following === false && noSource === false; })());
  check("R7c the round a seed is back on the old top says nothing, not even the time of the last new height; the next round has both again", d.state.gave === null && hold.staticS === null && hold.advancedAt === null && hold.since === null
    && d.at(t(at)).advancedAt === t(20) && d.at(t(at)).staticS === at - 20, JSON.stringify([hold, d.at(t(at))]));
}
{
  // A chain restarted lower with one seed left on the old chain, answering now and then.
  const c = clock().round({ a: 395000, b: 395000, stale: 395000 }, t(0)).round({ a: 395001, b: 395001, stale: 395001 }, t(20));
  let at = 20, h = 5, falseStandstill = 0, saidAfter = 0;
  for (let k = 0; k < 400; k++) {
    at += 20; h += 2;
    const round = k % 7 === 3 ? { a: h, b: h, stale: 395001 } : { a: h, b: h };
    c.round(round, t(at)); const p = c.at(t(at));
    if (k % 7 !== 3 && p.staticS !== null && p.staticS >= RULE.standstillSeconds) falseStandstill++;
    if (k > 40 && k % 7 !== 3 && p.staticS !== null) saidAfter++;
  }
  check("R8 a seed left on the old chain that still answers does not hold the clock there: the producing chain is never read as standing", falseStandstill === 0 && saidAfter > 200, JSON.stringify({ falseStandstill, saidAfter }));
}
{
  // A rollback of a few blocks while blocks are produced: the heights pass the old top again.
  const c = clock().round({ a: 1000, b: 1000 }, t(0)).round({ a: 1001, b: 1001 }, t(20));
  let at = 20, h = 940, said = [];
  for (let k = 0; k < 45; k++) { at += 20; h += 1; c.round({ a: h, b: h }, t(at)); }      // 15 minutes below the top: followed after ten
  check("R9 a rollback that is still below the old top after ten minutes is followed", c.state.gave !== null && c.state.top === h, JSON.stringify(c.state));
  while (h < 1001) { at += 20; h += 1; c.round({ a: h, b: h }, t(at)); }
  check("R9b the round it lands on the old top says nothing", c.state.hold === true && c.at(t(at)).staticS === null && c.state.top === 1001);
  at += 20; c.round({ a: 1002, b: 1002 }, t(at));
  check("R9c and the next height is an ordinary new height: the old standstill count was never shown", c.at(t(at)).staticS === 0 && c.at(t(at)).advancedAt === t(at) && c.state.gave === null, JSON.stringify(c.at(t(at))));
}

console.log("\n[" + TAG + "] gaps and the host clock");
{
  const c = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20));
  check("G6 forty minutes without a reading, then the same height: the count runs on (no block was produced in between)", c.round({ a: 701, b: 701 }, t(20 + 2400)).at(t(20 + 2400)).staticS === 2400);
  const d = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20)).round({ a: 760, b: 760 }, t(20 + 2400));
  check("G7 then a higher height: a new height seen now", d.at(t(20 + 2400)).staticS === 0 && d.at(t(20 + 2400)).advancedAt === t(20 + 2400));
  // then lower heights that rise: a chain restarted lower during the gap
  const e = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20)).round({ a: 699, b: 699 }, t(40));
  let at = 40 + 2400, h = 50, max = 0, over = null;
  for (let k = 0; k < 40; k++) { e.round({ a: h, b: h }, t(at)); const p = e.at(t(at)); if (over === null && e.state.gave) over = at; if (over === null && p.staticS !== null) max = Math.max(max, p.staticS); at += 20; h += 2; }
  check("G8 then lower heights that rise: no new height is said for ten minutes of their rising, whatever was read before the gap, then they are followed", over === 40 + 2400 + 20 + 620 && max === over - 20 - 20, JSON.stringify({ over, max }));
}
{
  const c = clock().round({ a: 100, b: 100 }, t(3600)).round({ a: 101, b: 101 }, t(3620));
  let wrong = 0;
  for (let k = 0; k < 170; k++) { c.round({ a: 101, b: 101 }, t(k * 20)); const p = c.at(t(k * 20)); if (p.staticS !== null || p.advancedAt !== null || p.reason === "advancing") wrong++; }   // the host clock was set back an hour
  check("G9 a host clock set back: nothing is said until it has passed the count's start again", wrong === 0, "rounds that said something: " + wrong);
  check("G9b and then the count is from that start, never negative and never zero by clamping", c.round({ a: 101, b: 101 }, t(3700)).at(t(3700)).staticS === 80);
}

console.log("\n[" + TAG + "] a world in which no height ever changes");
{
  // Four sources on fixed heights; every sequence of four rounds over which of them answer, after 20 s or after 620 s.
  let sequences = 0, bad = null;
  for (const heights of [{ a: 500, b: 497, c: 495, [VALIDATORS_SOURCE]: 499 }, { a: 500, b: 500, c: 495, [VALIDATORS_SOURCE]: 503 }, { a: 500, b: 500, c: 500, [VALIDATORS_SOURCE]: 500 }]) {
    const ids = Object.keys(heights);
    const walk = (state, at, depth, path) => {
      if (bad) return;
      for (let mask = 1; mask < 16; mask++) for (const dt of [20, 620]) {
        const src = ids.filter((_, i) => mask & (1 << i)).map((id) => ({ id, h: heights[id] }));
        const s = stepHeightClock(state, src, at + dt * S), m = heightMovementOf(s, at + dt * S, true, CFG);
        if (s.seen || s.gave !== null || s.lowSince !== null || m.advancedAt !== null || m.advancing) { bad = { heights, path: path.concat([[mask, dt]]), state: s }; return; }
        if (depth > 1) walk(s, at + dt * S, depth - 1, path.concat([[mask, dt]])); else sequences++;
      }
    };
    walk(newHeightClock(), T0, 4, []);
  }
  check("W1 " + sequences.toLocaleString("en-US") + " sequences: never a new height, never 'advancing', never a start-over", !bad && sequences === 3 * Math.pow(30, 4), JSON.stringify(bad));
}

console.log("\n[" + TAG + "] the fold against a plain reading of its text");
{
  // The same rule, written once more from the words in status-rule.mjs, scanning the whole history each time.
  function plain(rounds) {
    const lastAnswer = new Map(); let highest = null, countFrom = null, sawArrive = false, comparedYet = false, remembered = null, runFirst = null, runLatest = null, silent = false;
    for (const r of rounds) {
      silent = false;
      const ceiling = remembered ? remembered.highest : highest, roundTop = Math.max(...r.src.map((x) => x.h));
      const rises = r.src.filter((x) => lastAnswer.has(x.id) && x.h > lastAnswer.get(x.id)), bestRise = rises.length ? Math.max(...rises.map((x) => x.h)) : null;
      const roseBelow = ceiling !== null && rises.some((x) => x.h < ceiling);
      r.src.forEach((x) => lastAnswer.set(x.id, x.h));
      if (roseBelow) { if (runFirst === null || r.at - runLatest > 600000) runFirst = r.at; runLatest = r.at; }
      const startCount = () => { highest = roundTop; countFrom = r.at; comparedYet = false; sawArrive = false; };
      if (highest === null) { startCount(); continue; }
      if (remembered) {
        if (r.at - remembered.at > 86400000 || roundTop > remembered.highest) remembered = null;
        else if (roundTop === remembered.highest) { highest = remembered.highest; countFrom = remembered.countFrom; sawArrive = remembered.sawArrive; comparedYet = true; remembered = null; silent = true; continue; }
      }
      if (roundTop > highest) {
        if (bestRise === roundTop) { highest = roundTop; countFrom = r.at; comparedYet = true; sawArrive = remembered === null; if (remembered === null) { runFirst = null; runLatest = null; } }
        else startCount();
        continue;
      }
      if (roundTop === highest) { comparedYet = true; continue; }
      if (roseBelow && r.at - runFirst > 600000) { if (!remembered) remembered = { highest, countFrom, sawArrive, at: r.at }; startCount(); continue; }
      comparedYet = true;
    }
    return { top: highest, topSince: countFrom, seen: sawArrive, compared: comparedYet, gave: remembered ? remembered.highest : null, hold: silent };
  }
  let seed = 4242, differ = null, steps = 0; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 1500 && !differ; run++) {
    const rounds = []; let state = newHeightClock(), at = T0; const hs = { a: 1000, b: 1000 - Math.floor(rnd() * 4), c: 990, [VALIDATORS_SOURCE]: 1000 }, ids = Object.keys(hs);
    for (let k = 0; k < 90 && !differ; k++) {
      at += [20, 20, 20, 599, 600, 601, 900, 86400, 86401][Math.floor(rnd() * 9)] * S * (rnd() < 0.85 ? 1 : 0) + 20 * S * (rnd() < 0.85 ? 0 : 1) + (rnd() < 0.02 ? -3600 * S : 0);
      ids.forEach((id) => { const p = rnd(); if (p < 0.35) hs[id] += 1; else if (p < 0.4) hs[id] += Math.floor(rnd() * 40); else if (p < 0.45) hs[id] = Math.max(0, hs[id] - Math.floor(rnd() * 30)); else if (p < 0.46) hs[id] = Math.floor(rnd() * 60); });
      const src = ids.filter(() => rnd() < 0.6).map((id) => ({ id, h: hs[id] }));
      if (!src.length) continue;
      rounds.push({ at, src }); state = stepHeightClock(state, src, at); steps++;
      const want = plain(rounds), got = { top: state.top, topSince: state.topSince, seen: state.seen, compared: state.compared, gave: state.gave ? state.gave.top : null, hold: state.hold };
      if (JSON.stringify(want) !== JSON.stringify(got)) differ = { run, k, want, got };
    }
  }
  check("P1 " + steps.toLocaleString("en-US") + " random rounds (rises, drops, resets, pauses at 599, 600 and 601 s, a day, a clock set back): the fold says what its text says", !differ && steps > 60000, JSON.stringify(differ));
}

console.log("\n[" + TAG + "] worlds with a ground truth");
{
  // A chain produces blocks, halts, resumes and (rarely) restarts lower. Three seeds and six validators follow it, lag,
  // stick and catch up; DNO reads them every 20 s, is sometimes blind, and restarts.
  //   A1 a new height claimed at a height DNO had already read, outside a start-over
  //   B1 a stable reading although DNO read the standing head 1,840 s or more ago (outside a start-over, not a hold round)
  //   C1 a standstill while a seed that follows the chain answered in every round of the last 700 s and blocks were produced
  //   B2 a stable reading with clear confidence in that situation at any time, a start-over and its hold round included
  //   D1 a restart (the stored rounds replayed) publishing something else than the process that never restarted
  let seed = 20261004, seed2 = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, rnd2 = () => (seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const n = { A1: 0, B1: 0, B2: 0, C1: 0, D1: 0, rounds: 0, readings: 0, newHeights: 0, standstills: 0, startOvers: 0, restores: 0, replays: 0 }; let first = null;
  for (let wi = 0; wi < 420; wi++) {
    const profile = wi % 7;   // 0 calm, 1 halts, 2 flaky seeds, 3 halts with seeds stuck apart, 4 restarts lower, 5 halts with nodes resyncing, 6 nothing ever changes
    let head = 400000 + Math.floor(rnd() * 1000), halted = profile === 6, haltLeft = profile === 6 ? 1e9 : 0, lastMove = T0, resetAt = null;
    const mk = (isSeed, i) => ({ id: (isSeed ? "seed" : "val") + i, isSeed, mode: "follow", lag: Math.floor(rnd() * (profile === 3 || profile === 6 ? 6 : 2)), h: 0, up: rnd() < 0.9, left: 0, sync: 0 });
    const nodes = [mk(true, 1), mk(true, 2), mk(true, 3), mk(false, 1), mk(false, 2), mk(false, 3), mk(false, 4), mk(false, 5), mk(false, 6)];
    nodes.forEach((x) => { x.h = head - x.lag; if (profile === 6) x.mode = "stuck"; });
    let state = newHeightClock(), at = T0, blind = 0, dnoMax = null, headReadAt = null; const rows = [], producedAt = [], followerAt = [];
    for (let r = 0; r < 300; r++) {
      at += 20 * S;
      let produced = 0;
      if (halted) { if (--haltLeft <= 0) halted = false; }
      else {
        produced = rnd() < 0.8 ? 2 : 1;
        const p = rnd();
        if ((profile === 1 || profile === 3 || profile === 5) && p < 0.012) { halted = true; haltLeft = 60 + Math.floor(rnd() * 220); produced = 0; }
        else if (profile === 4 && p < 0.004) {
          head = 5 + Math.floor(rnd() * 50); produced = 0; resetAt = at; dnoMax = null; headReadAt = null;
          nodes.forEach((x) => { if (x.mode !== "stuck" && rnd() < 0.93) { x.h = Math.max(0, head - x.lag); x.mode = "follow"; } else x.mode = "stuck"; });
          if (rnd() < 0.4) { halted = true; haltLeft = 30 + Math.floor(rnd() * 150); }
        }
      }
      if (produced) { head += produced; lastMove = at; headReadAt = null; }
      nodes.forEach((x) => {
        if (profile === 6) { if (x.left > 0) x.left--; else if (rnd() < 0.2) { x.up = !x.up; x.left = rnd() < 0.2 ? 35 : Math.floor(rnd() * 3); } return; }
        if (x.left > 0) x.left--;
        else {
          const flaky = profile === 2 ? 0.06 : profile === 5 && halted ? 0.05 : 0.015;
          if (x.up && rnd() < flaky) { x.up = false; x.left = rnd() < 0.3 ? 30 + Math.floor(rnd() * 120) : Math.floor(rnd() * 4); if (profile === 5 && halted && rnd() < 0.6) { x.h = Math.max(0, x.h - 200 - Math.floor(rnd() * 3000)); x.mode = "sync"; x.sync = 15 + Math.floor(rnd() * 60); } }
          else if (!x.up) { x.up = true; if (x.h < head - 30 && x.mode === "follow") { x.mode = "sync"; x.sync = 20 + Math.floor(rnd() * 60); } }
        }
        if (x.mode === "follow") { if (x.h <= head) x.h = Math.max(x.h, halted ? head : head - x.lag); if (rnd() < (profile === 3 ? 0.006 : 0.002)) x.mode = "stuck"; }
        else if (x.mode === "sync" && x.up) { if (x.h <= head) { x.h = Math.min(head - (halted ? 0 : x.lag), x.h + x.sync); if (x.h >= head - x.lag) x.mode = "follow"; } }
        else if (x.mode === "stuck" && x.h <= head && rnd() < 0.01) { x.mode = "sync"; x.sync = 20 + Math.floor(rnd() * 60); }
      });
      if (blind > 0) { blind--; producedAt.push(produced > 0); followerAt.push(false); continue; }
      if (profile !== 6 && rnd() < 0.002) { blind = 5 + Math.floor(rnd() * 150); producedAt.push(produced > 0); followerAt.push(false); continue; }
      const seeds = nodes.filter((x) => x.isSeed && x.up).map((x) => ({ id: x.id, h: x.h }));
      const vals = seeds.length >= 2 ? null : nodes.filter((x) => !x.isSeed && x.up).map((x) => x.h);
      const before = state, src = clockSources(seeds, vals), had = src.length > 0;
      state = stepHeightClock(state, src, at);
      const mv = heightMovementOf(state, at, had, CFG);
      const reading = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: seeds.length, seedHeights: seeds.map((x) => x.h), validators: vals ? { read: vals.length, heights: vals, listAgreedAt: null } : null,
        maxIncidentSeverity: "none", publicIncidentCount: 0, movement: { staticSeconds: mv.staticSeconds, advancing: mv.advancing, stalled: mv.stalled, following: mv.following, staticSince: null } });
      rows.push({ src, at }); n.rounds++; if (had) n.readings++;
      producedAt.push(produced > 0); followerAt.push(had && nodes.some((x) => x.isSeed && x.up && x.mode === "follow" && x.h >= head - 2 && x.h <= head));
      const srcMax = had && seeds.length ? Math.max(...seeds.map((x) => x.h)) : null;
      const note = (k, o) => { n[k]++; if (!first) first = Object.assign({ kind: k, world: wi, round: r, profile }, o); };
      if (before.gave === null && state.gave !== null) n.startOvers++;
      if (before.gave !== null && state.gave === null && state.hold) n.restores++;
      if (state.seen && state.compared && state.topSince === at) {
        n.newHeights++;
        if (at - lastMove >= 40 * S && dnoMax !== null && state.top <= dnoMax && before.gave === null && state.gave === null) note("A1", { top: state.top, dnoMax, head });
      }
      if (srcMax !== null) dnoMax = dnoMax === null ? srcMax : Math.max(dnoMax, srcMax);
      if (srcMax !== null && srcMax === head && headReadAt === null) headReadAt = at;
      if (had && reading.status === "stable" && at - lastMove >= 1840 * S && headReadAt !== null && at - headReadAt >= 1840 * S && state.gave === null && !state.hold) note("B1", { head, state, staticSeconds: mv.staticSeconds });
      if (had && reading.status === "stable" && reading.confidence === "clear" && at - lastMove >= 1840 * S && headReadAt !== null && at - headReadAt >= 1840 * S) note("B2", { head, state, staticSeconds: mv.staticSeconds });
      if (had && (state.gave !== null || state.hold)) n.following = (n.following || 0) + 1;
      if (reading.standstill) {
        n.standstills++;
        let all = r >= 35; for (let j = r - 34; all && j <= r; j++) if (!producedAt[j] || !followerAt[j]) all = false;
        if (all && (resetAt === null || at - resetAt > 700 * S)) note("C1", { head, state });
      }
      if (rnd2() < 0.03) {
        n.replays++;
        let s2 = newHeightClock(), had2 = false; rows.forEach((x) => { s2 = stepHeightClock(s2, x.src, x.at); had2 = x.src.length > 0; });
        if (JSON.stringify(heightMovementOf(s2, at, had2, CFG)) !== JSON.stringify(mv)) note("D1", { live: mv });
      }
    }
  }
  check("X1 " + n.rounds.toLocaleString("en-US") + " rounds in 420 worlds: no new height at a height already read, no stable reading of a standstill DNO has known for 30 minutes (and none that reads clear while DNO follows lower heights), no standstill on a producing chain a seed follows, no restart that says something else",
    n.A1 + n.B1 + n.B2 + n.C1 + n.D1 === 0, JSON.stringify({ A1: n.A1, B1: n.B1, B2: n.B2, C1: n.C1, D1: n.D1, first }).slice(0, 900));
  check("X2 and the worlds did exercise the rule: new heights, standstills, start-overs, restores and replays all occurred", n.readings > 80000 && n.newHeights > 20000 && n.standstills > 10000 && n.startOvers > 20 && n.restores > 0 && n.replays > 1000 && n.following > 200, JSON.stringify(n));
}

console.log("\n[" + TAG + "] blocks advanced in the last 24 hours (as observed)");
{
  const cm = new Function("CHAIN_BUCKET_MIN_24H", "CHAIN_STATIC_RUN_MIN_24H", "CHAIN_ADVANCE_PCT_24H",
    extract("function computeChainMovement_24h(") + "\nreturn computeChainMovement_24h;")(5, CHAIN_STATIC_RUN_MIN_24H, 0.95);
  const M = 60 * S, rows = (fn, n = 80) => Array.from({ length: n }, (_, k) => ({ ts: T0 + k * M, median_block: fn(k) }));
  const steady = cm(rows((k) => 1000 + 15 * k));
  check("G1 newest median minus oldest", steady.blocks_advanced === 15 * 79 && steady.state === "normal", JSON.stringify(steady));
  const jitter = cm(rows((k) => 1000 + 15 * k - (k % 2 ? 5 : 0)));
  check("G2 the median dipping inside the band does not hide it", Number.isInteger(jitter.blocks_advanced) && jitter.blocks_advanced > 0, JSON.stringify(jitter));
  const reset = cm(rows((k) => (k < 40 ? 900000 + 15 * k : 15 * k)));
  check("G3 a reset in the window: not published", reset.blocks_advanced === null, JSON.stringify(reset));
  const back = cm(rows((k) => (k === 30 ? 1000 : 2000 + 15 * k)));
  check("G4 the median going down by more than the band once: not published", back.blocks_advanced === null, JSON.stringify(back));
  const lone = cm(rows((k) => 2000 + 15 * k).map((r, k) => (k === 30 ? { ts: r.ts, median_block: 1000, data_quality: "insufficient" } : Object.assign(r, { data_quality: "sufficient" }))));
  check("G4b a round where one seed alone answered is not a comparison point", lone.blocks_advanced === 15 * 79, JSON.stringify(lone));
  const none = cm(rows(() => null, 20));
  check("G5 no heights: no figure", none.blocks_advanced === undefined || none.blocks_advanced === null, JSON.stringify(none));
}

console.log("\n[" + TAG + "] which rule wrote a history row is on the row");
{
  // The shipped table, the older agent's INSERT (def1a71: it names its columns, so a column added later stays empty in
  // its rows) and this version's INSERT, taken from the source.
  const create = "CREATE TABLE public_node_history (" + SRC.match(/CREATE TABLE IF NOT EXISTS public_node_history \(([\s\S]*?)\)`/)[1] + ")";
  const OLDER = "INSERT INTO public_node_history (ts, status, risk, confidence, data_quality, agreement_state, median_block, block_spread, nodes_total, nodes_reachable, node_states) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const THIS = SRC.match(/"(INSERT INTO public_node_history \([^)]*\) VALUES \([^)]*\))"/)[1];
  const args = (ts, h) => [ts, "stable", "low", "clear", "sufficient", "strong", h, 0, 3, 3, "[]"];
  const since = new Function(extract("function ownHeightSince(") + "\nreturn ownHeightSince;")();
  const db = new Database(":memory:");
  db.run(create);
  check("O1 a new store: every row will carry the mark, so no row is excluded", since(db) === 0 && db.query("SELECT name FROM pragma_table_info('public_node_history')").all().some((c) => c.name === "own_height"));
  for (let k = 0; k < 5; k++) db.run(OLDER, args(T0 + k * 20 * S, 900 + k));
  check("O2 rows the older agent wrote: the start is just after the newest of them", since(db) === T0 + 4 * 20 * S + 1, since(db));
  for (let k = 5; k < 10; k++) db.run(THIS, args(T0 + k * 20 * S, 500 + k));
  check("O3 then this version's rows: the start stays at the end of the older rows, and all of this version's rows are after it",
    since(db) === T0 + 4 * 20 * S + 1 && db.query("SELECT COUNT(*) AS n FROM public_node_history WHERE own_height = 1 AND ts >= ?").get(since(db)).n === 5, since(db));
  for (let k = 10; k < 13; k++) db.run(OLDER, args(T0 + k * 20 * S, 900 + k));              // a rollback: the older agent runs on the same store
  check("O4 after a rollback the older agent's INSERT still works, and the start moves past its rows (this version's earlier rows are no longer used)",
    since(db) === T0 + 12 * 20 * S + 1, since(db));
  for (let k = 13; k < 15; k++) db.run(THIS, args(T0 + k * 20 * S, 513 + k));
  const REPLAY = SRC.match(/"(SELECT ts, data_quality, median_block, node_states FROM public_node_history WHERE ts < \? AND ts >= \? ORDER BY ts DESC LIMIT \?)"/)[1];
  const used = db.query(REPLAY).all(T0 + 99 * 20 * S, since(db), 20000);
  check("O5 the start-up query then reads only rows written after the rollback, all under the own-height rule", used.length === 2 && used.every((r) => r.median_block >= 526), JSON.stringify(used));
  check("O6 this version's INSERT sets the mark", /node_states, own_height\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 1\)/.test(THIS), THIS);
  check("O7 no stored stamp for it: the agent neither reads nor writes own_height_since", !/own_height_since/.test(SRC));
  check("O8 every read of median, spread or agreement from stored rows is bounded by the start: the start-up clock, 24 h chain movement, the trend",
    /\.all\(since, OWN_HEIGHT_SINCE\)/.test(SRC) && SRC.includes("var from = Math.max(OWN_HEIGHT_SINCE, before - RULE.clockRememberSeconds * 1000);") && SRC.includes(".all(before, from, CLOCK_REPLAY_MAX_ROWS)")
    && /WHERE ts > \? AND ts >= \? ORDER BY ts DESC LIMIT 15 OFFSET 1"\)\.all\(trendSince, OWN_HEIGHT_SINCE\)/.test(SRC));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
