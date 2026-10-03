// height-movement.test.mjs — HEIGHT_MOVEMENT guard: when DNO may say a new height was seen, and for how long none was.
// The height clock is a fold over the median each round publishes (clockHeight, stepHeightClock, heightMovementOf in
// status-rule.mjs). The cases run those functions on synthetic rounds; the restart cases run the agent's own
// stepPublicHeightClock() (extracted from agent.mjs) against a history table that honours the query's bounds.
// Run: bun src/height-movement.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { sanitizeHeight } from "./public-safety.mjs";
import { RULE, assess, clockHeight, newHeightClock, stepHeightClock, heightMovementOf } from "./status-rule.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "HEIGHT_MOVEMENT";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const extract = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n}\n", i) + 3); };
const line = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n", i) + 1); };
const MONITOR_INTERVAL_MS = Number(SRC.match(/const MONITOR_INTERVAL_MS = parseInt\(process\.env\.MONITOR_INTERVAL_MS \|\| "(\d+)"\)/)[1]);
const CHAIN_STATIC_RUN_MIN_24H = Number(SRC.match(/var CHAIN_STATIC_RUN_MIN_24H = parseInt\(process\.env\.PHASE_B_CHAIN_STATIC_RUN_MIN \|\| '(\d+)'/)[1]);
const CFG = { roundSeconds: MONITOR_INTERVAL_MS / 1000, stalledSeconds: CHAIN_STATIC_RUN_MIN_24H * 60 };
const T0 = 1_800_000_000_000, S = 1000, MIN = 60 * S;

// A clock driven by rounds. seeds: { name: own height } (undefined: the seed did not give one); validators: the heights
// of the validators read this round, or null when none was read.
function clock() {
  let state = newHeightClock(), had = false;
  const api = {
    round(seeds, at, validators = null) {
      const v = clockHeight(Object.values(seeds).filter((h) => h !== undefined), validators);
      state = stepHeightClock(state, v, at); had = v !== null; return api;
    },
    at(now) {
      const m = heightMovementOf(state, now, had, CFG);
      return { staticS: m.staticSeconds, advancedAt: m.advancedAt, reason: m.advancing ? "advancing" : m.stalled ? "unchanged" : "aligned", since: m.since };
    },
    get state() { return state; }
  };
  return api;
}

console.log("\n[" + TAG + "] start, a new height, no new height");
{
  const c = clock().round({ a: 100, b: 100 }, T0);
  let p = c.at(T0);
  check("A1 first round after a start: nothing claimed", p.staticS === null && p.advancedAt === null && p.reason === "aligned" && p.since === null, JSON.stringify(p));
  p = c.round({ a: 101, b: 100 }, T0 + 20 * S).at(T0 + 20 * S);
  check("A2 a new height seen arriving: static 0, advancing", p.staticS === 0 && p.advancedAt === T0 + 20 * S && p.reason === "advancing", JSON.stringify(p));
  p = c.round({ a: 101, b: 101 }, T0 + 40 * S).at(T0 + 40 * S);
  check("A3 a lagging seed catching up is no new height: the median already stood there", p.staticS === 20 && p.advancedAt === T0 + 20 * S, JSON.stringify(p));
  for (let k = 3; k <= 20; k++) c.round({ a: 101, b: 101 }, T0 + k * 20 * S);
  p = c.at(T0 + 400 * S);
  check("A4 six minutes without a new height: unchanged, counted from the round that showed it", p.staticS === 380 && p.reason === "unchanged", JSON.stringify(p));
  check("A6 since when, for a condition record: the round of the last new height", p.since === T0 + 20 * S, p.since);
  c.round({ a: undefined, b: undefined }, T0 + 420 * S);
  check("A7 and nothing when the latest round had no height; the clock itself is not moved", c.at(T0 + 420 * S).since === null && c.at(T0 + 420 * S).staticS === null && c.state.top === 101 && c.state.topSince === T0 + 20 * S);
  p = c.round({ a: 101, b: 101 }, T0 + 440 * S).at(T0 + 440 * S);
  check("A8 the next round with a height carries on from where the clock stood", p.staticS === 420 && p.advancedAt === T0 + 20 * S, JSON.stringify(p));
}
{
  const p = clock().round({ a: 100, b: 100 }, T0).round({ a: 100, b: 100 }, T0 + 20 * S).at(T0 + 20 * S);
  check("A5 two equal rounds after a start: a lower bound, and no new height is claimed to have been seen", p.staticS === 20 && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
}

console.log("\n[" + TAG + "] seeds leaving and joining");
{
  const c = clock().round({ a: 200, b: 190 }, T0).round({ a: 201, b: 191 }, T0 + 20 * S).round({ b: 191 }, T0 + 40 * S);
  let p = c.at(T0 + 40 * S);
  check("B1 the leading seed stops answering: the median drops, which is neither a new height nor 'advancing'", p.staticS === 20 && p.advancedAt === T0 + 20 * S && p.reason === "aligned", JSON.stringify(p));
  p = c.round({ b: 192 }, T0 + 60 * S).at(T0 + 60 * S);
  check("B2 the remaining seed rising towards the height the leader left on is no new height", p.staticS === 40 && p.advancedAt === T0 + 20 * S, JSON.stringify(p));
  for (let k = 4; k <= 12; k++) c.round({ b: 189 + k }, T0 + k * 20 * S);      // 193 ... 201
  p = c.at(T0 + 240 * S);
  check("B2b nor when it reaches that height", p.staticS === 220, JSON.stringify(p));
  p = c.round({ b: 202 }, T0 + 260 * S).at(T0 + 260 * S);
  check("B2c the first median above it is the new height", p.staticS === 0 && p.advancedAt === T0 + 260 * S && p.reason === "advancing", JSON.stringify(p));
}
{
  const c = clock().round({ a: 200, b: 100 }, T0).round({ a: 201, b: 101 }, T0 + 20 * S);
  for (let k = 2; k <= 31; k++) c.round({ b: 100 + k }, T0 + k * 20 * S);      // the leader is away; b keeps rising, far below 201
  let p = c.at(T0 + 620 * S);
  check("B8 while the highest median was read within ten minutes, a lower seed rising is no new height", p.staticS === 600 && p.reason === "unchanged", JSON.stringify(p));
  p = c.round({ b: 132 }, T0 + 640 * S).at(T0 + 640 * S);
  check("B9 ten minutes after it was last read, with the median below it rising, the clock starts over from that median: nothing claimed in that round", p.staticS === null && p.advancedAt === null && c.state.top === 132, JSON.stringify(p));
  p = c.round({ b: 133 }, T0 + 660 * S).at(T0 + 660 * S);
  check("B9b and the next higher median is a new height", p.staticS === 0 && p.reason === "advancing", JSON.stringify(p));
}
{
  // 2 October 2026, as n3's store shows it: one seed alone advanced until 11:47 UTC and then stood on one height; the
  // other seed came back an hour later, far behind, and caught up over eight minutes. Before 1.2 every step of that
  // catching up counted as an advance, and the published "last advance" moved to 12:52.
  const c = clock(), HEAD = 429825;
  let at = T0, n3 = HEAD - 60;
  c.round({ n2: n3, n3 }, at);
  while (n3 < HEAD) { at += 20 * S; n3 += 2; c.round({ n3 }, at); }
  const stoodAt = at;
  while (at < stoodAt + 57 * MIN) { at += 20 * S; c.round({ n3: HEAD }, at); }
  let n2 = HEAD - 1200;
  while (n2 < HEAD) { at += 20 * S; n2 = Math.min(HEAD, n2 + 50); c.round({ n2, n3: HEAD }, at); }
  let p = c.at(at);
  check("H1 2 October: a seed returning far behind and catching up does not restart the clock", p.advancedAt === stoodAt && p.staticS === Math.round((at - stoodAt) / 1000) && p.staticS > 57 * 60 && p.reason === "unchanged", JSON.stringify(p));
  while (at < stoodAt + 179 * MIN) { at += 20 * S; c.round({ n2: HEAD, n3: HEAD }, at); }
  p = c.at(at);
  check("H2 and three hours on the published last new height is still the round the median last rose", p.advancedAt === stoodAt && p.staticS === 179 * 60, JSON.stringify(p));
  p = c.round({ n2: HEAD, n3: HEAD + 1 }, at + 20 * S).at(at + 20 * S);
  check("H3 the next new height ends it", p.staticS === 0 && p.advancedAt === at + 20 * S, JSON.stringify(p));
}
{
  const p = clock().round({ a: 300 }, T0).round({ a: 300 }, T0 + 20 * S).round({ b: 305 }, T0 + 40 * S).at(T0 + 40 * S);
  check("B3 a seed answering for the first time above the highest median is a new height", p.staticS === 0, JSON.stringify(p));
}
{
  const c = clock().round({ a: 501, b: 500 }, T0);
  for (let k = 1; k <= 18; k++) c.round({ a: 501, b: 500 }, T0 + k * 20 * S);
  const before = c.at(T0 + 360 * S).staticS;
  c.round({ b: 500 }, T0 + 380 * S).round({ a: 501, b: 500 }, T0 + 400 * S);   // the leader times out for one round and comes back at the same height
  let p = c.at(T0 + 400 * S);
  check("B4 a leader that skips a round during a standstill does not reset the clock", before === 360 && p.staticS === 400 && p.reason === "unchanged", JSON.stringify({ before, p }));
  for (let k = 21; k <= 25; k++) c.round({ b: 500 }, T0 + k * 20 * S);   // absent for five rounds
  p = c.round({ a: 501, b: 500 }, T0 + 520 * S).at(T0 + 520 * S);
  check("B5 nor after a longer absence", p.staticS === 520 && p.reason === "unchanged", JSON.stringify(p));
}
{
  const c = clock().round({ a: 480, b: 480 }, T0).round({ b: 500 }, T0 + 20 * S);
  for (let k = 2; k <= 20; k++) c.round({ b: 500 }, T0 + k * 20 * S);     // b stands at 500; a is away
  const p = c.round({ a: 500, b: 500 }, T0 + 420 * S).at(T0 + 420 * S);    // a returns at the standing height
  check("B6 a seed back after a long gap at the height the others stand on is no new height", p.staticS === 400 && p.reason === "unchanged", JSON.stringify(p));
}
{
  const c = clock().round({ a: 510, b: 500 }, T0).round({ a: 510, b: 500 }, T0 + 20 * S);
  for (let k = 2; k <= 50; k++) c.round({ b: 500 }, T0 + k * 20 * S);     // the leader is away for 16 minutes; the other seed stands 10 below
  let p = c.at(T0 + 1000 * S);
  check("B7a a leader away for more than ten minutes while the other seed stands still below it: the clock runs on (a standstill is not forgotten)", p.staticS === 1000 && p.reason === "unchanged" && c.state.top === 510, JSON.stringify(p));
  p = c.round({ a: 510, b: 500 }, T0 + 1020 * S).at(T0 + 1020 * S);         // and returns at its own height
  check("B7 a leader back after more than ten minutes, at its own last height, is no new height", p.staticS === 1020 && p.reason === "unchanged", JSON.stringify(p));
}

console.log("\n[" + TAG + "] what cannot move the clock");
{
  // Validators alone, the chain standing at H. One of four alternates between H and H+1: before the clock followed the
  // median, each H+1 was "a new height" and the standstill never reached 30 minutes.
  const H = 431000, c = clock();
  let at = T0;
  c.round({}, at, [H, H, H, H]);
  for (let k = 1; k <= 95; k++) { at += 20 * S; c.round({}, at, [H, H, H, k % 2 ? H + 1 : H]); }
  const p = c.at(at);
  check("N1 one validator of four alternating between two heights does not move the median: the standstill is counted", p.staticS === 1900 && p.advancedAt === null && c.state.top === H
    && assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 0, seedHeights: [], validators: { read: 4, heights: [H, H, H, H + 1], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0,
      movement: heightMovementOf(c.state, at, true, CFG) }).status === "degraded", JSON.stringify(p));
}
{
  // Two readings, one of them alternating: the median is the higher of the two, so it does move. One new height, once.
  const H = 431000, c = clock();
  let at = T0;
  c.round({ a: H, b: H }, at);
  for (let k = 1; k <= 100; k++) { at += 20 * S; c.round({ a: H, b: k % 2 ? H + 1 : H }, at); }
  let p = c.at(at);
  check("N2 a seed alternating between two heights gives one new height, not one every other round", p.advancedAt === T0 + 20 * S && p.staticS === 1980, JSON.stringify(p));
  // slowly: the higher height once every eleven minutes
  const d = clock(); at = T0; d.round({ a: H, b: H }, at);
  for (let k = 1; k <= 200; k++) { at += 20 * S; d.round({ a: H, b: k % 33 === 1 ? H + 1 : H }, at); }
  p = d.at(at);
  check("N2b nor when it shows the higher height only once every eleven minutes: a median that stands still below the top does not start the clock over", p.advancedAt === T0 + 20 * S && p.staticS === 3980 && d.state.top === H + 1, JSON.stringify(p));
}
{
  // A halt at H under two seeds; then no seed answers and validators stand in.
  const H = 431000, c = clock();
  let at = T0;
  c.round({ a: H - 1, b: H - 1 }, at); at += 20 * S; c.round({ a: H, b: H }, at); const rose = at;
  for (let k = 0; k < 60; k++) { at += 20 * S; c.round({ a: H, b: H }, at); }           // 20 minutes at H
  at += 20 * S; c.round({}, at, [H, H, H, H + 1]);                                        // one validator a block ahead
  let p = c.at(at);
  check("N3 a switch from seeds to validators is no new height while their median is the height the seeds stood on", p.advancedAt === rose && p.staticS === Math.round((at - rose) / 1000), JSON.stringify(p));
  at += 20 * S; c.round({}, at, [H, H + 1, H + 1, H + 1]);
  p = c.at(at);
  check("N3b a validators' median above it is a new height, once", p.staticS === 0 && p.advancedAt === at, JSON.stringify(p));
  const second = at;
  for (let k = 0; k < 10; k++) { at += 20 * S; c.round({}, at, [H, H + 1, H + 1, H + 1]); }
  at += 20 * S; c.round({ a: H, b: H }, at);                                              // the seeds are back, one block under that median
  p = c.at(at);
  check("N3c the seeds returning below it are no new height either: the count runs on from the last one", p.advancedAt === second && p.staticS === Math.round((at - second) / 1000) && p.reason !== "advancing", JSON.stringify(p));
  at += 20 * S; c.round({ a: H + 2, b: H + 2 }, at);
  check("N3d and the first median above it is", c.at(at).staticS === 0);
}
{
  // No height for twenty minutes (no seed and no reading from validators), then a reading again.
  const mk = () => { const c = clock(); c.round({ a: 700, b: 700 }, T0).round({ a: 701, b: 701 }, T0 + 20 * S).round({ a: 701, b: 701 }, T0 + 40 * S); for (let k = 3; k <= 62; k++) c.round({}, T0 + k * 20 * S, null); return c; };
  const back = T0 + 63 * 20 * S;
  let c = mk(), p = c.round({ a: 760, b: 760 }, back).at(back);
  check("N4 after a gap, a higher median is a new height seen now: not 'unchanged for 20 minutes'", p.staticS === 0 && p.advancedAt === back && p.reason === "advancing", JSON.stringify(p));
  c = mk(); p = c.round({ a: 701, b: 701 }, back).at(back);
  check("N4b the same median as before the gap: no new height since the last one", p.staticS === 1240 && p.advancedAt === T0 + 20 * S && p.reason === "unchanged", JSON.stringify(p));
  c = mk(); p = c.round({ a: 650, b: 650 }, back).at(back);
  check("N4c a lower median after the gap: nothing is claimed in that round (whether it is rising is not known yet)", p.staticS === null && p.advancedAt === null && p.since === null && c.state.hold === true, JSON.stringify(p));
  p = c.round({ a: 651, b: 651 }, back + 20 * S).at(back + 20 * S);
  check("N4d it rises: a chain on a lower base; the clock starts over from it, and claims nothing until the next comparison", p.staticS === null && c.state.top === 651 && c.state.advanceKnown === false, JSON.stringify(p));
  check("N4e then counts from there", c.round({ a: 652, b: 652 }, back + 40 * S).at(back + 40 * S).staticS === 0);
  c = mk(); c.round({ a: 650, b: 650 }, back); p = c.round({ a: 650, b: 650 }, back + 20 * S).at(back + 20 * S);
  check("N4f it stands still below the top: the clock runs on from the last new height", p.staticS === 1260 && p.advancedAt === T0 + 20 * S, JSON.stringify(p));
}
{
  // A chain restarted lower while DNO keeps reading.
  const c = clock().round({ a: 395000, b: 395000 }, T0).round({ a: 395001, b: 395001 }, T0 + 20 * S);
  let at = T0 + 20 * S, h = 5, max = 0, startedOver = null;
  for (let k = 0; k < 40; k++) { at += 20 * S; c.round({ a: h, b: h }, at); h += 3; const p = c.at(at); if (p.staticS !== null) max = Math.max(max, p.staticS); if (startedOver === null && c.state.top < 395000) startedOver = at; }
  check("C1 a chain restarted lower: no new height for ten minutes, then the lower chain is followed; never a standstill", max <= 620 && max < RULE.standstillSeconds && startedOver === T0 + 20 * S + 31 * 20 * S && c.at(at).staticS === 0 && c.at(at).reason === "advancing",
    JSON.stringify({ max, startedOver: startedOver && (startedOver - T0) / 1000, now: c.at(at) }));
}
{
  const c = clock().round({ a: 100, b: 100 }, T0).round({ a: undefined, b: undefined }, T0 + 20 * S);
  const p = c.at(T0 + 20 * S);
  check("C2 a round without any height publishes nothing about movement", p.staticS === null && c.state.top === 100, JSON.stringify(p));
}

console.log("\n[" + TAG + "] the height the clock follows");
{
  const H = 431000;
  check("K1 two or more seeds: their upper median; one seed: its own height, whatever the validators say", clockHeight([H, H + 7]) === H + 7 && clockHeight([H - 300, H, H + 7]) === H && clockHeight([H], [H + 20, H + 400]) === H && clockHeight([H], null) === H);
  check("K2 no seed: the validators' median when they form a reading, else nothing", clockHeight([], [H, H, H + 1, H + 100]) === H + 1 && clockHeight([], [H]) === null && clockHeight([], [H, H + 900]) === null && clockHeight([], null) === null && clockHeight([], []) === null);
  // The clock's height is the median the reading publishes, for any round.
  let seed = 7, bad = null, n = 0; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 20000 && !bad; i++) {
    const pick = () => H + Math.floor(rnd() * 80) - 40 + (rnd() < 0.1 ? 900 : 0);
    const seeds = Array.from({ length: Math.floor(rnd() * 4) }, pick), vals = rnd() < 0.2 ? null : Array.from({ length: Math.floor(rnd() * 9) }, pick);
    const r = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: seeds.length, seedHeights: seeds, validators: vals ? { read: vals.length, heights: vals, listAgreedAt: null } : null, maxIncidentSeverity: "none", publicIncidentCount: 0, movement: {} });
    n++; if (clockHeight(seeds, vals) !== r.agreement.median_block) bad = { seeds, vals, clock: clockHeight(seeds, vals), median: r.agreement.median_block };
  }
  check("K3 it is the median the reading publishes, in 20,000 random rounds", !bad && n === 20000, JSON.stringify(bad));
  check("K4 a first-peer height is not a seed's own height, so it never reaches the clock (the agent passes own heights only)", /var seedHeights = publicNodeResults\.map\(ownHeight\)\.filter\(function\(h\) \{ return h !== null; \}\);/.test(extract("function stepPublicHeightClock(")));
  check("K5 what is not a height, or has no time, does not move the clock", [null, undefined, -1, 1.5, "431000", NaN].every((v) => stepHeightClock(newHeightClock(), v, T0).top === null) && stepHeightClock(newHeightClock(), H, NaN).top === null);
  check("K6 the limits the methodology states", RULE.clockForgetSeconds === 600 && RULE.standstillSeconds === 1800);
}

console.log("\n[" + TAG + "] restart: the stored rounds are replayed by the same rule");
// The agent's stepPublicHeightClock, with a history table that honours the query's bounds, order and limit.
function agent(history, ownSince = 0) {
  const db = history ? { query: (sql) => ({ all: (bound, since) => {
    if (!/ts < \? AND ts >= \? ORDER BY ts DESC LIMIT 2000/.test(sql)) throw new Error("unexpected history query: " + sql);
    return history.filter((r) => r.median_block !== null && r.ts < bound && r.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, 2000);
  } }) } : null;
  const code = "var heightClock = newHeightClock();\nvar heightClockHadHeight = false, heightClockRestored = false;\n" + line("function ownHeight(") + extract("function stepPublicHeightClock(")
    + "\nreturn { step: stepPublicHeightClock, view: function(now) { return heightMovementOf(heightClock, now, heightClockHadHeight, CFG); }, state: function() { return heightClock; } };";
  return new Function("sanitizeHeight", "sharedDb", "OWN_HEIGHT_SINCE", "clockHeight", "newHeightClock", "stepHeightClock", "heightMovementOf", "CFG", code)(sanitizeHeight, db, ownSince, clockHeight, newHeightClock, stepHeightClock, heightMovementOf, CFG);
}
const seedRows = (heights) => Object.entries(heights).map(([name, block]) => ({ name, ok: block !== undefined, block, height_source: block === undefined ? null : "self" }));
const pub = (a, now) => { const m = a.view(now); return { staticS: m.staticSeconds, advancedAt: m.advancedAt, reason: m.advancing ? "advancing" : m.stalled ? "unchanged" : "aligned" }; };
{
  const hist = [];
  for (let k = 1; k <= 30; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 500 });   // 10 minutes at 500
  hist.push({ ts: T0 - 31 * 20 * S, median_block: 499 });
  hist.push({ ts: T0, median_block: 501 }, { ts: T0 + 20 * S, median_block: 501 });   // rows at or after this round are outside the query's bound
  const a = agent(hist); a.step(seedRows({ a: 500, b: 500 }), null, T0);
  const p = pub(a, T0);
  check("D1 a restart during a standstill keeps it and its start", p.staticS === 600 && p.advancedAt === T0 - 30 * 20 * S && p.reason === "unchanged", JSON.stringify(p));
}
{
  const hist = [];
  for (let k = 1; k <= 2000; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 395000 - k });
  const a = agent(hist); a.step(seedRows({ a: 12, b: 12 }), null, T0);
  let p = pub(a, T0);
  check("D2 a restart right after a chain restarted lower: no new height is claimed, and nothing says 'advancing'", p.staticS === 20 && p.reason === "aligned", JSON.stringify(p));
  let at = T0, h = 12, max = 0;
  for (let k = 0; k < 40; k++) { at += 20 * S; h += 2; a.step(seedRows({ a: h, b: h }), null, at); const q = pub(a, at); if (q.staticS !== null) max = Math.max(max, q.staticS); }
  check("D2b ten minutes on the lower chain is followed; the old chain never gives a standstill", max <= 620 && a.state().top === h && pub(a, at).reason === "advancing", JSON.stringify({ max, top: a.state().top }));
}
{
  const hist = [];
  for (let k = 1; k <= 200; k++) hist.push({ ts: T0 - 3600 * S - k * 20 * S, median_block: 395000 - k });   // the agent was down for an hour
  const a = agent(hist); a.step(seedRows({ a: 12, b: 12 }), null, T0);
  let p = pub(a, T0);
  check("D2c a restart an hour after the last stored round, on a lower chain: nothing is claimed from the old chain", p.staticS === null && p.advancedAt === null, JSON.stringify(p));
  a.step(seedRows({ a: 14, b: 14 }), null, T0 + 20 * S); a.step(seedRows({ a: 16, b: 16 }), null, T0 + 40 * S);
  check("D2d and two rounds on the lower chain is followed", pub(a, T0 + 40 * S).staticS === 0 && a.state().top === 16);
}
{
  const hist = [{ ts: T0 - 20 * S, median_block: 480 }, { ts: T0 - 40 * S, median_block: 479 }];
  const a = agent(hist); a.step(seedRows({ a: 500, b: 500 }), null, T0);
  const p = pub(a, T0);
  check("D3 a restart after the height moved on: the higher median is a new height seen now", p.staticS === 0 && p.advancedAt === T0 && p.reason === "advancing", JSON.stringify(p));
}
{
  const hist = [];
  for (let k = 1; k <= 30; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 500 });   // 10 minutes at 500, all before the rule change
  const a = agent(hist, T0 - 5 * 20 * S);                                                // own heights since 100 s ago
  a.step(seedRows({ a: 500, b: 500 }), null, T0);
  const p = pub(a, T0);
  check("D4 history from before seeds counted only their own heights is not replayed (a lower bound from the change)", p.staticS === 100 && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
}
{
  // A halted chain: the head seed misses a round, so that stored round's median is the other seed's, 10 below. Before
  // the clock was a fold, a restart stopped at that row and published it as the last advance.
  const hist = [];
  for (let k = 120; k >= 1; k--) hist.push({ ts: T0 - k * 20 * S, median_block: k === 7 ? 490 : 500 });
  hist.push({ ts: T0 - 121 * 20 * S, median_block: 499 });
  const a = agent(hist); a.step(seedRows({ a: 500, b: 490 }), null, T0);
  const p = pub(a, T0);
  check("D5 a stored round whose median dipped is not taken for the last new height: the standstill and its start survive the restart", p.staticS === 2400 && p.advancedAt === T0 - 120 * 20 * S && p.reason === "unchanged", JSON.stringify(p));
}
{
  // Live rounds and a replay of the same rounds end in the same clock.
  let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let differ = null;
  for (let run = 0; run < 300 && !differ; run++) {
    const rows = []; let h = 1000, at = T0;
    for (let k = 0; k < 150; k++) { at += 20 * S + (rnd() < 0.03 ? 900 * S : 0); const r = rnd(); if (r < 0.45) h += 1; else if (r < 0.5) h -= Math.floor(rnd() * 30); else if (r < 0.52) h = Math.floor(rnd() * 50); rows.push({ ts: at, median_block: rnd() < 0.08 ? null : Math.max(0, h) }); }
    let live = newHeightClock(); for (const r of rows) live = stepHeightClock(live, r.median_block, r.ts);
    const last = rows[rows.length - 1], a = agent(rows.slice(0, -1));
    a.step(last.median_block === null ? [] : seedRows({ a: last.median_block, b: last.median_block }), null, last.ts);
    if (JSON.stringify(a.state()) !== JSON.stringify(live)) differ = { run, live, replayed: a.state() };
  }
  check("D6 300 random histories: a restart before the last round leaves the same clock as no restart", !differ, JSON.stringify(differ));
  const src = extract("function stepPublicHeightClock(");
  check("D7 the replay happens once, before the first step, oldest row first, with the bounded query", (src.match(/heightClockRestored = true;/g) || []).length === 1 && src.includes("for (var i = rows.length - 1; i >= 0; i--) heightClock = stepHeightClock(heightClock, rows[i].median_block, rows[i].ts);")
    && src.includes('.all(observedAt, OWN_HEIGHT_SINCE)'));
}

console.log("\n[" + TAG + "] the agent's use of the clock");
{
  const cycle = extract("async function publicObservationCycle() {"), ccs = extract("function computeCanonicalState() {");
  check("U1 one step per public round, after the observation is set, on that round's seeds and witness reads", (cycle.match(/stepPublicHeightClock\(/g) || []).length === 1
    && cycle.includes("  lastPublicObservedAt = Date.now();\n  catalogFinishCrawl(publicNodeResults, lastPublicObservedAt);\n  stepPublicHeightClock(publicNodeResults, roundWitnesses, lastPublicObservedAt);\n")
    && (SRC.match(/heightClock = stepHeightClock\(/g) || []).length === 2 && (SRC.match(/stepPublicHeightClock\(/g) || []).length === 2);
  check("U2 the published movement is the clock's, with the agent's round length and its 'unchanged' limit", ccs.includes("var hm = heightMovementOf(heightClock, observedAtMs, heightClockHadHeight, { roundSeconds: Math.round(MONITOR_INTERVAL_MS / 1000), stalledSeconds: CHAIN_STATIC_RUN_MIN_24H * 60 });")
    && ccs.includes('var advancedAtIso = hm.advancedAt === null ? null : new Date(hm.advancedAt).toISOString();') && ccs.includes('var staticSince = hm.since === null ? null : new Date(hm.since).toISOString().slice(0, 16).replace("T", " ");')
    && ccs.includes("height_last_advanced_at: advancedAtIso, height_static_seconds: hm.staticSeconds") && ccs.includes("staticSince: staticSince } });"));
  check("U3 no second clock: the per-node tracker is gone", !/heightTracker|updateHeightTracker|lastBySeed|HEIGHT_WINDOW_MS|clockReadings|clockResults/.test(SRC));
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
  const used = db.query("SELECT ts, median_block FROM public_node_history WHERE median_block IS NOT NULL AND ts < ? AND ts >= ? ORDER BY ts DESC LIMIT 2000").all(T0 + 99 * 20 * S, since(db));
  check("O5 the start-up query then reads only rows written after the rollback, all under the own-height rule", used.length === 2 && used.every((r) => r.median_block >= 526), JSON.stringify(used));
  check("O6 this version's INSERT sets the mark", /node_states, own_height\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 1\)/.test(THIS), THIS);
  check("O7 no stored stamp for it: the agent neither reads nor writes own_height_since", !/own_height_since/.test(SRC));
  check("O8 every read of median, spread or agreement from stored rows is bounded by the start: the start-up clock, 24 h chain movement, the trend",
    /\.all\(since, OWN_HEIGHT_SINCE\)/.test(SRC) && /\.all\(observedAt, OWN_HEIGHT_SINCE\)/.test(SRC) && /WHERE ts > \? AND ts >= \? ORDER BY ts DESC LIMIT 15 OFFSET 1"\)\.all\(trendSince, OWN_HEIGHT_SINCE\)/.test(SRC));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
