// height-movement.test.mjs — HEIGHT_MOVEMENT guard: when DNO may say a new height was seen, and for how long none was.
// The height clock (clockRound, stepHeightClock, heightMovementOf in status-rule.mjs) keeps what each seed showed about
// itself, the highest height read, and the height the count stands on. The cases run those functions on synthetic
// rounds. Then four searches, because a rule about what "new" means is easy to state and easy to get wrong:
//   - a world in which no height ever changes, every sequence of which seeds and validators answer: nothing may be
//     claimed, no start-over may happen, and the count may start only at the first reading of a height;
//   - the fold against a second, plain reading of its text, on random rounds;
//   - worlds with a ground truth taken from what DNO read (every node's every answer, in rounds with and without a
//     reading): what must never be said is never said;
//   - the same worlds replayed from what a round's stored row keeps: a restart publishes what the running process does.
// The agent's own use of the clock (its step, its stored row, its replay at start) is run in round-wiring.test.mjs.
// Run: bun src/height-movement.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { RULE, VALIDATORS_SOURCE, assess, clockRound, newHeightClock, stepHeightClock, heightMovementOf } from "./status-rule.mjs";
import { sanitizeHeight } from "./public-safety.mjs";

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

// A clock driven by rounds, through clockRound as the agent drives it. seeds: { name: own height } (undefined: the seed
// gave none); validators: the heights of the validators that answered as listed this round (undefined: that one did
// not answer), or null when none was read.
const VK = (i) => (0xc0 + i).toString(16).repeat(32);
const heightsOf = (validators) => (validators ? validators.filter((h) => h !== undefined && h !== null) : null);
function clock() {
  let state = newHeightClock(), had = false;
  const api = {
    round(seeds, at, validators = null) {
      const r = clockRound(Object.entries(seeds).map(([id, h]) => ({ id, h: h === undefined ? null : h })), heightsOf(validators));
      state = stepHeightClock(state, r.sources, at, r.counted); had = r.reading; return api;
    },
    at(now) {
      const m = heightMovementOf(state, now, had, CFG);
      return { staticS: m.staticSeconds, advancedAt: m.advancedAt, reason: m.advancing ? "advancing" : m.stalled ? "no new height" : "aligned", since: m.since, following: m.following };
    },
    get state() { return state; },
    get reading() { return had; }
  };
  return api;
}
const t = (sec) => T0 + sec * S;

console.log("\n[" + TAG + "] start, a new height, no new height");
{
  const c = clock().round({ a: 100, b: 100 }, t(0));
  let p = c.at(t(0));
  check("A1 first round after a start: the count starts here, and no arrival is claimed", p.staticS === 0 && p.advancedAt === null && p.reason === "aligned" && p.since === t(0), JSON.stringify(p));
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
  check("A5 nothing when the latest round read no height at all; the clock itself is not moved", c.at(t(420)).since === null && c.at(t(420)).staticS === null && c.state.top === 101 && c.state.topSince === t(20));
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
  check("B5 other seeds answering after a gap, each on its own standing height: no start-over, no new height", p.staticS === 680 && p.advancedAt === null && c.state.top === 500 && c.state.gave === null && c.state.low === null, JSON.stringify([p, c.state]));
}
{
  const c = clock().round({ b: 495, c: 495 }, t(0)).round({ b: 495, c: 495 }, t(20)).round({ b: 495, c: 495 }, t(40));
  let p = c.round({ a: 500, b: 495 }, t(60)).at(t(60));
  check("B6 a seed heard for the first time, above everything read: the count starts in that round and no arrival is claimed (DNO did not see that height arrive)", p.staticS === 0 && p.advancedAt === null && p.reason === "aligned" && c.state.top === 500 && c.state.topSince === t(60) && c.state.seen === false, JSON.stringify(p));
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
  check("V3 of two validators the count stands on the lower: one of two is not more than half, so it alone moves nothing, at its first step up or after", c.state.top === H + 1 && p.staticS === at - 20 && p.advancedAt === t(20) && c.state.last[VALIDATORS_SOURCE] === H + 1, JSON.stringify([p, c.state.top]));
  at += 20; p = c.round({}, t(at), [H + 3, H + 3]).at(t(at));
  check("V3b when both rise, to a height below one a counted validator showed before (V1: " + (H + 20) + " beside the seed, first read at second 40): the count moves there and nothing is new; it runs from that first reading", c.state.top === H + 3 && p.staticS === at - 40 && p.advancedAt === null
    && p.reason === "no new height" && c.state.read === H + 20 && c.state.readSince === t(40), JSON.stringify([p, c.state.read]));
  at += 20; p = c.round({}, t(at), [H + 30, H + 30]).at(t(at));
  check("V3c above everything DNO has read the count starts in that round; with validators alone no arrival is claimed", c.state.top === H + 30 && p.staticS === 0 && p.advancedAt === null && p.reason === "aligned" && c.state.seen === false, JSON.stringify(p));
}
{
  // Three validators stand on 1000, 1000 and 1003 and never move. Which of them answer changes their median.
  const c = clock().round({ a: 1000, b: 1000 }, t(0)).round({ a: 1000, b: 1000 }, t(20)).round({}, t(40), [1000, 1000, 1003]);
  let at = 40, said = 0;
  for (let k = 0; k < 100; k++) {
    at += 20; c.round({}, t(at), k % 3 === 0 ? [1000, 1000, undefined] : k % 3 === 1 ? [1000, undefined, 1003] : [undefined, 1000, 1003]);
    const p = c.at(t(at)); if (p.staticS !== at || p.advancedAt !== null || p.reason === "advancing") said++;
  }
  check("V7 validators that stop answering in turn, each on its own standing height: the reading's median moves between 1000 and 1003, the count stays on the height more than half of them stand on, and nothing is claimed", said === 0 && c.state.top === 1000 && c.state.topSince === t(0) && c.state.seen === false
    && c.state.gave === null && c.state.low === null && c.state.read === 1003 && c.at(t(at)).staticS === at && at > 1800, JSON.stringify([said, c.state]));
}
{
  // One seed stands on 1000 and three validators on 1002, read together for 40 minutes. Then the seed stops answering.
  const c = clock().round({ a: 999 }, t(0), [1002, 1002, 1002]).round({ a: 1000 }, t(20), [1002, 1002, 1002]);
  let at = 20;
  for (let k = 0; k < 120; k++) { at += 20; c.round({ a: 1000 }, t(at), [1002, 1002, 1002]); }
  const before = c.at(t(at)); at += 20;
  const p = c.round({}, t(at), [1002, 1002, 1002]).at(t(at));
  check("V8 the one seed stops answering and the validators it was read beside stand two blocks above it: the count moves to their height, which DNO has read since second 0, so the standstill is as old as it was. (The seed's own step to 1000 was no new height either, for the same reason.)", before.staticS === at - 20 && before.advancedAt === null
    && p.staticS === at && p.advancedAt === null && p.reason === "no new height" && c.state.top === 1002 && c.state.topSince === t(0) && c.state.read === 1002 && c.reading === true, JSON.stringify([before, p]));
  for (let k = 0; k < 5; k++) { at += 20; c.round({}, t(at), [1002, 1002, 1002]); }
  const one = c.round({}, t(at + 20), [1003, 1002, 1002]).at(t(at + 20));
  const up = c.round({}, t(at + 40), [1003, 1003, 1002]).at(t(at + 40));
  check("V8b one of them a block higher moves nothing; when more than half of them stand there the count moves to that height, as old as its first reading (the round before), and no arrival is claimed", one.staticS === at + 20 && up.staticS === 20 && up.advancedAt === null && up.reason === "aligned" && c.state.top === 1003 && c.state.topSince === t(at + 20), JSON.stringify([one, up]));
}
{
  // The count keeps one time, not one for every height. Beside a seed that stands on H, counted validators show H+3
  // from second 20 and H+6 from second 100. Then the seed steps up to H+2.
  const H = 5000, c = clock().round({ a: H }, t(0), [H, H]);
  for (let k = 1; k <= 4; k++) c.round({ a: H }, t(k * 20), [H + 3, H + 3]);
  for (let k = 5; k <= 8; k++) c.round({ a: H }, t(k * 20), [H + 6, H + 6]);
  const p = c.round({ a: H + 2 }, t(180), [H + 6, H + 6]).at(t(180));
  check("V8c the seed steps up to a height below two that counted validators showed before it (H+3 from second 20, H+6 from second 100): the count runs from the first reading of the highest height read (80 s). DNO first read a height at or above the count's own 160 s ago, so the count is younger than that, not older, and no arrival is claimed",
    c.state.top === H + 2 && p.staticS === 80 && p.since === t(100) && p.advancedAt === null && c.state.read === H + 6 && c.state.readSince === t(100) && c.state.seen === false, JSON.stringify([p, c.state]));
}
{
  // An arrival DNO saw at a seed is still reported for two rounds when the seed then stops answering and validators
  // stand alone at that height. From validators alone DNO takes no arrival.
  const c = clock().round({ a: 100 }, t(0), [100, 100]).round({ a: 101 }, t(20), [101, 101]);
  const seen = c.at(t(20));
  const v1 = c.round({}, t(40), [101, 101]).at(t(40)), v2 = c.round({}, t(60), [101, 101]).at(t(60)), v3 = c.round({}, t(80), [101, 101]).at(t(80));
  const v4 = c.round({}, t(100), [102, 102]).at(t(100)), v5 = c.round({}, t(120), [103, 103]).at(t(120));
  check("V8d a seed's new height, then validators alone at that height: 'advancing' is still said for the two rounds after the seed's arrival and its time stands; when the validators rise above everything read the count starts again and no arrival is taken from them",
    seen.advancedAt === t(20) && seen.reason === "advancing" && v1.reason === "advancing" && v1.advancedAt === t(20) && v2.reason === "advancing" && v3.reason === "aligned" && v3.advancedAt === t(20) && v3.staticS === 60
    && v4.advancedAt === null && v4.staticS === 0 && v4.reason === "aligned" && v5.advancedAt === null && v5.staticS === 0 && v5.reason === "aligned" && c.reading === true && c.state.seen === false, JSON.stringify([seen, v1, v2, v3, v4, v5]));
}
{
  // Validators on 1000, 1001 and 1002, below a top of 1003, one of them answering every other round: their median
  // goes up and down, and no validator rises.
  const c = clock().round({ a: 1003, b: 1003 }, t(0)).round({ a: 1003, b: 1003 }, t(20));
  let at = 20;
  for (let k = 0; k < 200; k++) { at += 20; c.round({}, t(at), [k % 2 ? undefined : 1000, 1001, 1002]); }
  const p = c.at(t(at));
  check("V9 a median that goes up and down below the top as a validator comes and goes is no run of rises: no start-over, and the count runs on", c.state.gave === null && c.state.low === null && c.state.top === 1003 && p.staticS === at && p.following === false, JSON.stringify([p, c.state]));
}
{
  const H = 431000, c = clock();
  for (let k = 0; k <= 60; k++) c.round({ a: H, b: H }, t(k * 20));
  let p = c.round({}, t(61 * 20), [H + 1, H + 1, H + 1]).at(t(61 * 20));
  check("V4 seeds give way to validators that stand one above: the count starts there in that round, and no arrival is claimed", p.staticS === 0 && p.advancedAt === null && c.state.top === H + 1 && c.state.topSince === t(61 * 20) && c.state.seen === false, JSON.stringify(p));
  p = c.round({}, t(62 * 20), [H + 1, H + 1, H + 1]).round({ a: H, b: H }, t(63 * 20)).round({}, t(64 * 20), [H + 1, H + 1, H + 1]).at(t(64 * 20));
  check("V4b going back and forth between seeds and validators after that restarts nothing", p.staticS === 60 && p.advancedAt === null && c.state.top === H + 1, JSON.stringify(p));
  for (let k = 0; k <= 60; k++) c.round({}, t((65 + k) * 20), [H, H, H]);
  const one = clock().round({ a: H, b: H }, t(0)).round({ a: H + 1 }, t(20), [H + 1, H + 1]);
  check("V5 two seeds, then one seed alone a block higher beside validators: the seed is the source, by its name, so its rise is a new height seen arriving", one.at(t(20)).staticS === 0 && one.at(t(20)).advancedAt === t(20)
    && one.state.last.a === H + 1 && one.state.last[VALIDATORS_SOURCE] === undefined, JSON.stringify([one.at(t(20)), one.state.last]));
  const ids = (list) => list.map((x) => x.id + ":" + x.h).join(" ");
  check("V6 with no seed the reading publishes the upper median of every validator height read (102 here); the count stands on the lower median of those counted (101): more than half of them have reached it",
    ids(clockRound([], [100, 101, 102, 200, 200]).sources) === VALIDATORS_SOURCE + ":101" && assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 0, seedHeights: [], validators: { read: 5, heights: [100, 101, 102, 200, 200], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0, movement: {} }).agreement.median_block === 102,
    ids(clockRound([], [100, 101, 102, 200, 200]).sources));
  check("V4c validators that stand on the seeds' top restart nothing either", clock().round({ a: H, b: H }, t(0)).round({ a: H, b: H }, t(20)).round({}, t(40), [H, H, H]).at(t(40)).staticS === 40);
}

console.log("\n[" + TAG + "] a round without a reading says nothing, and what a seed showed in it is kept");
{
  // Two seeds rise to 1008. One goes silent and no validator is read: the other alone is no reading. It reaches 1018
  // and shows it for 40 minutes. Then the second seed answers on 1018.
  const c = clock(); let at = 0, h = 1000, said = 0;
  for (let k = 0; k < 5; k++) { c.round({ a: h, b: h }, t(at)); at += 20; h += 2; }
  h -= 2;                                                     // both on 1008 at second 80
  for (let k = 0; k < 5; k++) { h += 2; c.round({ a: h }, t(at)); const p = c.at(t(at)); if (c.reading || p.staticS !== null || p.advancedAt !== null || p.following || p.reason !== "aligned") said++; at += 20; }
  const arrived = at - 20;                                    // 1018, first shown at second 180
  for (let k = 0; k < 120; k++) { c.round({ a: h }, t(at)); const p = c.at(t(at)); if (c.reading || p.staticS !== null || p.advancedAt !== null) said++; at += 20; }
  check("L1 one seed alone is no reading: nothing is said in any such round, and the clock keeps each height it showed and when the last one arrived", said === 0 && c.state.top === 1018 && c.state.topSince === t(arrived) && c.state.seen === true && c.state.last.a === 1018 && c.state.last.b === 1008, JSON.stringify(c.state));
  const p = c.round({ a: h, b: h }, t(at)).at(t(at));
  check("L2 when the reading is back on that height it is not a new height: DNO read it " + Math.round((at - arrived) / 60) + " minutes before, and the count and the time of its arrival say so", c.reading === true && p.staticS === at - arrived && p.advancedAt === t(arrived) && p.reason === "no new height"
    && c.state.top === 1018, JSON.stringify(p));
  const r = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 2, seedHeights: [h, h], validators: null, maxIncidentSeverity: "none", publicIncidentCount: 0,
    movement: { staticSeconds: p.staticS, advancing: p.reason === "advancing", stalled: true, staticSince: "2026-10-04 12:03:00" } });
  check("L3 so the reading is degraded at once, where a count that began at its return would have read stable for another 30 minutes", r.status === "degraded" && r.standstill === true && r.status_reason.startsWith("No new height for " + Math.floor((at - arrived) / 60) + " min"), r.status_reason);
}
{
  // The chain stands at 429825. The head seed goes silent; the other returns 2,000 behind and gains 40 a round, with
  // three validators on the head. One seed far from every validator read is no reading, and validators far from the
  // one seed are not read (they are not witnesses of that round). So nothing shows the top any more: after ten minutes
  // of its rising DNO follows the seed. When it comes within 25 blocks of the validators they count, the top is read
  // again, and the standstill is the old one.
  const H = 429825, c = clock();
  for (let k = 0; k <= 170; k++) c.round({ head: H, other: H }, t(k * 20));
  let at = 170 * 20, h = H - 2000, said = 0;
  while (h + 40 < H - 25) { at += 20; h += 40; c.round({ other: h }, t(at), [H, H, H]); const p = c.at(t(at)); if (c.reading || p.staticS !== null || p.advancedAt !== null || p.following || p.reason !== "aligned") said++; }
  check("L4 a lone seed catching up from far behind is no reading: nothing is said. Validators far from it are not read, so after ten minutes of its rising DNO follows it and remembers the top", said === 0 && c.state.gave !== null && c.state.gave.top === H && c.state.gave.since === t(0) && c.state.gave.at === t(170 * 20 + 40 + 620)
    && c.state.top === h && c.state.last.other === h && at - 170 * 20 > 900, JSON.stringify(c.state));
  at += 20; let p = c.round({ other: H - 20 }, t(at), [H, H, H]).at(t(at));
  check("L5 when it comes within 25 blocks the validators count: the top is read again, the following ends, and the reading that is back is the standstill that began before", c.reading === true && c.state.gave === null && c.state.read === H && c.state.readSince === t(0) && p.staticS === at && p.advancedAt === null && p.reason === "no new height" && p.following === false, JSON.stringify(p));
  at += 20; p = c.round({ other: H }, t(at), [H, H, H]).at(t(at));
  check("L6 and arriving on the head changes nothing: the standstill is " + Math.floor(at / 60) + " minutes old, not zero", p.staticS === at && c.state.top === H && c.state.gave === null, JSON.stringify(p));
  const r = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 1, seedHeights: [H], validators: { read: 3, heights: [H, H, H], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0,
    movement: { staticSeconds: p.staticS, advancing: false, stalled: true, following: p.following, staticSince: "2026-10-02 10:50:00" } });
  check("L7 so the reading is degraded at once, where a count that began again would have read stable for another 30 minutes", r.status === "degraded" && r.standstill === true && r.status_reason === "The seed has shown no new height for " + Math.floor(at / 60) + " min; one public seed and 3 validators aligned", r.status_reason);
}
{
  // The same lone seed with no validator read at all (none kept, or the dials off): nothing shows the top any more, so
  // after ten minutes of its rising DNO follows it, as it would follow two seeds. Nothing is said without a reading.
  const H = 429825, c = clock();
  for (let k = 0; k <= 170; k++) c.round({ head: H, other: H }, t(k * 20));
  let at = 170 * 20, h = H - 2000, said = 0, over = null;
  while (h + 40 < H) { at += 20; h += 40; c.round({ other: h }, t(at)); const p = c.at(t(at)); if (c.reading || p.staticS !== null || p.advancedAt !== null || p.following) said++; if (over === null && c.state.gave) over = at; }
  check("L8 with no validator read, a lone seed rising below the top for more than ten minutes is followed and the top is remembered; nothing is said in a round without a reading", said === 0 && over === 170 * 20 + 40 + 620 && c.state.gave.top === H && c.state.gave.since === t(0), JSON.stringify({ said, over, state: c.state }));
  at += 20; c.round({ other: H }, t(at));
  at += 20; const p = c.round({ head: H, other: H }, t(at)).at(t(at));
  check("L9 it lands on the old top (that height is as old as its first reading), and when a second seed makes it a reading the standstill is the one that began before", c.state.gave === null && c.state.topSince === t(0) && p.staticS === at && p.following === false && p.reason === "no new height", JSON.stringify(p));
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
  check("R6 the round they land on the old top: the following ends, and that height is as old as its first reading", c.state.top === H && c.state.topSince === t(0) && c.state.gave === null && c.state.seen === false && c.at(t(at)).staticS === at && c.at(t(at)).following === false, JSON.stringify(c.state));
  at += 20; const p = c.round({ x: H, y: H }, t(at)).at(t(at));
  check("R7 from the next round the standstill is the one that began at second 0", p.staticS === at && p.reason === "no new height", JSON.stringify(p));
}
{
  // A seed catches up to the top itself: that is no rise below the top, so it begins no run of such rises. Later both
  // seeds fall back and rise for 40 seconds: far too short for a start-over, whatever happened ten minutes before.
  const c = clock().round({ a: 500, b: 480 }, t(0)).round({ a: 500, b: 500 }, t(20));
  c.round({ a: 300, b: 300 }, t(600)).round({ a: 301, b: 301 }, t(620)).round({ a: 302, b: 302 }, t(640)).round({ a: 303, b: 303 }, t(660));
  check("R7b a rise that reaches the top is not a rise below it: forty seconds of rising later do not make a start-over", c.state.gave === null && c.state.top === 500 && c.state.low !== null && c.state.low.since === t(620) && c.at(t(660)).staticS === 660, JSON.stringify(c.state));
  // A new height seen arriving, then a start-over, then a seed back exactly on the old top: the following ends in that
  // round, and the count is that height's again, from its first reading. DNO does not say it saw it arrive a second time.
  const d = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20));
  let at = 20, h = 400;
  while (!d.state.gave) { at += 20; h += 1; d.round({ a: h, b: h }, t(at)); }
  at += 20; d.round({ a: 701, b: h }, t(at));
  const back = d.at(t(at)); at += 20; d.round({ a: 701, b: 701 }, t(at));
  check("R7d the reading is told that DNO follows lower heights from the round it starts over until a seed is back on the old top, and not before or after",
    (() => { const e = clock().round({ a: 700, b: 700 }, t(0)).round({ a: 701, b: 701 }, t(20)); let k = 20, x = 400, before = [], during = [];
      while (!e.state.gave) { before.push(e.at(t(k)).following); k += 20; x += 1; e.round({ a: x, b: x }, t(k)); }
      during.push(e.at(t(k)).following); k += 20; e.round({ a: x + 1, b: x + 1 }, t(k)); during.push(e.at(t(k)).following);
      k += 20; e.round({ a: 701, b: x + 1 }, t(k)); const onTop = e.at(t(k)).following; k += 20; e.round({ a: 701, b: 701 }, t(k));
      const noReading = heightMovementOf(Object.assign({}, e.state, { gave: { top: 9, since: 0, at: 0 } }), t(k), false, CFG).following;
      return before.every((f) => f === false) && before.length > 30 && during.every((f) => f === true) && onTop === false && e.at(t(k)).following === false && noReading === false; })());
  check("R7c the round a seed is back on the old top reads that height's old count, and no time of a last new height: DNO did not see it arrive again", d.state.gave === null && back.staticS === at - 20 - 20 && back.since === t(20) && back.advancedAt === null && back.following === false
    && d.at(t(at)).advancedAt === null && d.at(t(at)).staticS === at - 20, JSON.stringify([back, d.at(t(at))]));
}
{
  // A chain restarted lower with one seed left on the old chain, answering in every seventh round. The height it gives
  // is read again every 140 seconds, so it holds the count: DNO cannot tell it from the head of a chain that stands
  // still (a stated limit). Once it has been silent for ten minutes while the others kept rising, DNO follows them.
  const c = clock().round({ a: 395000, b: 395000, stale: 395000 }, t(0)).round({ a: 395001, b: 395001, stale: 395001 }, t(20));
  let at = 20, h = 5, held = 0, rounds = 0, lastStale = null;
  for (let k = 0; k < 400; k++) {
    at += 20; h += 2;
    const round = k % 7 === 3 ? { a: h, b: h, stale: 395001 } : { a: h, b: h };
    if (k % 7 === 3) lastStale = at;
    c.round(round, t(at)); const p = c.at(t(at)); rounds++;
    if (c.state.gave === null && c.state.top === 395001 && p.staticS === at - 20 && p.following === false) held++;
  }
  check("R8 a seed left on the old chain that answers at least every ten minutes holds the count there: no start-over, and 'no new height' in every round", held === rounds && c.state.gave === null, JSON.stringify({ held, rounds, state: c.state }));
  let over = null;
  while (over === null && at < lastStale + 2000) { at += 20; h += 2; c.round({ a: h, b: h }, t(at)); if (c.state.gave) over = at; }
  check("R8a once it has been silent for ten minutes while the others kept rising, DNO follows them: the run began with the first rise after its last answer", over === lastStale + 20 + 620 && c.state.gave.top === 395001 && c.at(t(at)).following === true && c.at(t(at)).staticS === 0, JSON.stringify({ over, lastStale, state: c.state }));
}
{
  // The same with the seed on the old chain answering in every round: the top is read in every round, so nothing below
  // it is followed. DNO cannot tell that seed from the head of a chain that stands still (a stated limit).
  const c = clock().round({ a: 395000, b: 395000, stale: 395000 }, t(0)).round({ a: 395001, b: 395001, stale: 395001 }, t(20));
  let at = 20, h = 5;
  for (let k = 0; k < 400; k++) { at += 20; h += 2; c.round({ a: h, b: h, stale: 395001 }, t(at)); }
  check("R8b a node that gives the old top in every round holds the count there: no start-over, and 'no new height' for as long as it answers", c.state.gave === null && c.state.top === 395001 && c.at(t(at)).staticS === at - 20 && c.at(t(at)).following === false, JSON.stringify(c.at(t(at))));
}
{
  // A seed going back and forth between two heights below the top, while the seed that gave the top is silent.
  const c = clock().round({ a: 1000, b: 990 }, t(0)).round({ a: 1000, b: 990 }, t(20));
  let at = 20;
  for (let k = 0; k < 4400; k++) { at += 20; c.round({ b: k % 2 ? 981 : 980, c: 985 }, t(at)); }
  check("R8c a seed that only goes back and forth below the top never makes a run of rises: no start-over in 24 hours of it, and the count runs on from the top", c.state.gave === null && c.state.top === 1000 && c.at(t(at)).staticS === at && at > 86400, JSON.stringify(c.state));
}
{
  // A rollback of a few blocks while blocks are produced: the heights pass the old top again.
  const c = clock().round({ a: 1000, b: 1000 }, t(0)).round({ a: 1001, b: 1001 }, t(20));
  let at = 20, h = 940, said = [];
  for (let k = 0; k < 45; k++) { at += 20; h += 1; c.round({ a: h, b: h }, t(at)); }      // 15 minutes below the top: followed after ten
  check("R9 a rollback that is still below the old top after ten minutes is followed", c.state.gave !== null && c.state.top === h, JSON.stringify(c.state));
  while (h < 1001) { at += 20; h += 1; c.round({ a: h, b: h }, t(at)); }
  check("R9b the round it lands on the old top reads that height's count, from its first reading", c.state.gave === null && c.state.top === 1001 && c.at(t(at)).staticS === at - 20 && c.at(t(at)).following === false);
  at += 20; c.round({ a: 1002, b: 1002 }, t(at));
  check("R9c and the next height is an ordinary new height, seen arriving", c.at(t(at)).staticS === 0 && c.at(t(at)).advancedAt === t(at) && c.state.gave === null, JSON.stringify(c.at(t(at))));
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
  // Three seeds and three validators on fixed heights. Every sequence of rounds over which of them answer, read as
  // the agent reads: validators only when fewer than two seeds gave a height. Nothing may ever be claimed, no run of
  // rises may begin, nothing may be given up, and the count may start only at the first reading of a height: in a round
  // that reads a node for the first time (a seed's own height; a validator when it counts), or at the time of such a
  // round (a height first read then).
  const SEEDS = ["a", "b", "c"];
  let sequences = 0, bad = null;
  const walk = (heights, vals, state, heard, freshAt, at, depth, dts, path) => {
    if (bad) return;
    for (let sm = 0; sm < 8; sm++) {
      const seeds = SEEDS.map((id, i) => ({ id, h: sm & (1 << i) ? heights[i] : null })), own = seeds.filter((x) => x.h !== null).length;
      for (let vm = 0; vm < (own >= 2 ? 1 : 8); vm++) for (const dt of dts) {
        const read = own >= 2 ? null : vals.filter((h, i) => vm & (1 << i));
        const now = at + dt * S, r = clockRound(seeds, read), s = stepHeightClock(state, r.sources, now, r.counted), m = heightMovementOf(s, now, r.reading, CFG);
        // whose height was read in this round, by this test's own arithmetic: every seed that gave one; a validator when it counts
        // (within 25 blocks of the one seed; with no seed, of the validators' upper median, when those are two or more and more than half)
        const hs = (read || []).slice().sort((x, y) => x - y), ref = own === 1 ? seeds.find((x) => x.h !== null).h : hs.length ? hs[Math.floor(hs.length / 2)] : null;
        const near = hs.filter((h) => Math.abs(h - ref) <= 25), counts = own === 1 ? near.length > 0 : own === 0 && near.length >= 2 && near.length * 2 > hs.length;
        const vmask = own >= 2 || !counts ? 0 : vals.reduce((mm, h, i) => (vm & (1 << i)) && Math.abs(h - ref) <= 25 ? mm | (1 << i) : mm, 0);
        const mask = sm | (vmask << 3), fresh = (mask & ~heard) !== 0, step = [sm, own >= 2 ? "-" : vm, dt];
        const times = fresh ? freshAt.concat([now]) : freshAt;
        if (s.seen || s.gave !== null || s.low !== null || m.advancedAt !== null || m.advancing || m.following) { bad = { why: "something was claimed", heights, vals, path: path.concat([step]), state: s }; return; }
        if (s.topSince !== null && !times.includes(s.topSince)) { bad = { why: "the count starts at a round that read no node for the first time", heights, vals, path: path.concat([step]), state: s }; return; }
        if (r.reading && m.staticSeconds === null) { bad = { why: "a reading without a count", heights, vals, path: path.concat([step]), state: s }; return; }
        if (depth > 1) walk(heights, vals, s, heard | mask, times, now, depth - 1, dts, path.concat([step])); else sequences++;
        if (bad) return;
      }
    }
  };
  for (const [heights, vals] of [[[500, 497, 495], [499, 499, 502]], [[500, 500, 495], [503, 503, 480]], [[500, 500, 500], [500, 500, 500]], [[500, 497, 495], [1000, 1000, 1003]]]) {
    walk(heights, vals, newHeightClock(), 0, [], T0, 3, [20, 620], []);
    walk(heights, vals, newHeightClock(), 0, [], T0, 4, [20], []);
  }
  check("W1 " + sequences.toLocaleString("en-US") + " sequences of who answers, seeds and validators: never a new height, never 'advancing', never a run of rises or a start-over, a count in every reading, and the count starts only at the first reading of a height",
    !bad && sequences === 4 * (Math.pow(72, 3) + Math.pow(36, 4)), JSON.stringify(bad));
}

console.log("\n[" + TAG + "] the fold against a plain reading of its text");
{
  // The same rule, written once more from the words in status-rule.mjs.
  function plain(rounds) {
    const lastAnswer = new Map(); let highest = null, countFrom = null, sawArrive = false, everRead = null, everReadAt = null, remembered = null, run = null;
    for (const r of rounds) {
      const roundTop = Math.max(...r.src.map((x) => x.h)), roundRead = Math.max(roundTop, r.counted === null ? -1 : r.counted);
      // of the sources at the round's highest height: who is above its own last answer; and has any source fallen back by more than 25 blocks
      const tops = r.src.filter((x) => x.h === roundTop);
      // only a seed is said to fall back: the validators' height can drop because other validators answered
      const up = tops.filter((x) => lastAnswer.has(x.id) && x.h > lastAnswer.get(x.id)), fellBack = r.src.some((x) => x.id !== VALIDATORS_SOURCE && lastAnswer.has(x.id) && lastAnswer.get(x.id) - x.h > 25);
      const seedUp = up.some((x) => x.id !== VALIDATORS_SOURCE);
      r.src.forEach((x) => lastAnswer.set(x.id, x.h));
      if (highest === null) { highest = roundTop; countFrom = r.at; everRead = roundRead; everReadAt = r.at; continue; }
      if (fellBack) sawArrive = false;                   // after a seed fell back the last arrival is no longer claimed
      // what DNO had read before this round, and when its highest height was first read
      let readBefore = everRead, readBeforeAt = everReadAt;
      if (remembered) {
        if (r.at - remembered.at > 86400000) remembered = null;
        else if (roundRead >= remembered.height) {      // the height given up is read again: it, and the height the count stands on, are as old as its first reading
          readBefore = remembered.height; readBeforeAt = remembered.firstRead; countFrom = remembered.firstRead; sawArrive = false; remembered = null;
        }
      }
      if (roundRead > readBefore) { everRead = roundRead; everReadAt = r.at; } else { everRead = readBefore; everReadAt = readBeforeAt; }
      if (roundRead >= readBefore) run = null;           // the held height is read, or passed
      else {
        if (run && (fellBack || r.at - run.latest > 600000)) run = null;   // a node on another height now, or a pause
        const rising = up.filter((x) => !run || !run.best.has(x.id) || roundTop > run.best.get(x.id));   // above every answer it gave in this run
        if (rising.length) {
          if (run && r.at - run.began > 600000) {        // the start-over
            remembered = remembered ? { height: remembered.height, firstRead: remembered.firstRead, at: r.at } : { height: readBefore, firstRead: readBeforeAt, at: r.at };
            highest = roundTop; countFrom = r.at; sawArrive = false; everRead = roundRead; everReadAt = r.at; run = null;
            continue;
          }
          if (!run) run = { began: r.at, latest: r.at, height: roundTop, best: new Map() };
          run.latest = r.at; run.height = roundTop;
        } else if (!up.length && run && roundTop > run.height + 25) run = null;
        if (run) r.src.forEach((x) => { if (!run.best.has(x.id) || x.h > run.best.get(x.id)) run.best.set(x.id, x.h); });
      }
      if (roundTop > highest) {
        if (roundTop <= readBefore) { highest = roundTop; countFrom = readBeforeAt; sawArrive = false; }      // a height read before: as old as the first reading of the highest height read
        else { highest = roundTop; countFrom = r.at; sawArrive = seedUp && remembered === null; }                // above everything read
      }
    }
    return { top: highest, topSince: countFrom, seen: sawArrive, gave: remembered ? [remembered.height, remembered.firstRead, remembered.at] : null, run: run ? [run.height, run.began, run.latest, [...run.best.entries()].sort()] : null, read: everRead, readSince: everReadAt };
  }
  let seed = 4242, differ = null, steps = 0; const seenKinds = { gaveUp: 0, gaveUpAgain: 0, ended: 0, forgotten: 0, arrivals: 0, followed: 0, validators: 0, holder: 0, back: 0, pause: 0 }; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 1500 && !differ; run++) {
    const rounds = []; let state = newHeightClock(), at = T0; const hs = { a: 1000, b: 1000 - Math.floor(rnd() * 4), c: 990, [VALIDATORS_SOURCE]: 1000 }, ids = Object.keys(hs);
    const calm = rnd() < 0.5;     // in half of the runs the heights mostly rise and rounds follow each other closely, so that runs of rises get long enough for a start-over
    const dies = calm && rnd() < 0.6 ? ["a", "b", "c"][Math.floor(rnd() * 3)] : null, diesAt = 20 + Math.floor(rnd() * 50);   // one seed stops answering for good: what it showed last is then read by nobody
    for (let k = 0; k < 90 && !differ; k++) {
      at += (calm && rnd() < 0.93 ? 20 : [20, 20, 20, 599, 600, 601, 900, 86400, 86401][Math.floor(rnd() * 9)]) * S + (rnd() < 0.02 ? -3600 * S : 0);
      ids.forEach((id) => { const p = rnd(); if (p < (calm ? 0.8 : 0.35)) hs[id] += 1; else if (p < 0.84) hs[id] += Math.floor(rnd() * 40); else if (p < 0.88) hs[id] = Math.max(0, hs[id] - Math.floor(rnd() * 30)); else if (p < 0.89) hs[id] = Math.floor(rnd() * 60); else if (p < 0.93) hs[id] = Math.max(0, hs[id] - 1); else if (p < 0.94) hs[id] += 100000; });
      // as clockRound gives them: the seeds that answered, or with none of them the validators as one source
      let src = ["a", "b", "c"].filter((id) => rnd() < (calm ? 0.7 : 0.5) && !(id === dies && k >= diesAt)).map((id) => ({ id, h: hs[id] }));
      if (!src.length) { if (rnd() < 0.3) continue; seenKinds.validators++; src = [{ id: VALIDATORS_SOURCE, h: hs[VALIDATORS_SOURCE] }]; }
      // beside a seed, or with no seed, the reading may have counted validators: the highest of them, sometimes above the sources
      const counted = src.length < 2 && rnd() < 0.5 ? Math.max(...src.map((x) => x.h)) + (rnd() < 0.2 ? 30 + Math.floor(rnd() * 60) : Math.floor(rnd() * 6) - 2) : null;
      const was = state;
      rounds.push({ at, src, counted }); state = stepHeightClock(state, src, at, counted); steps++;
      if (!was.gave && state.gave) seenKinds.gaveUp++; if (was.gave && state.gave && state.gave.at !== was.gave.at) seenKinds.gaveUpAgain++;
      if (was.gave && !state.gave) seenKinds[at - was.gave.at > 86400000 ? "forgotten" : "ended"]++;
      if (state.seen && state.topSince === at) seenKinds.arrivals++; if (state.top !== was.top && state.topSince !== at && !state.gave) seenKinds.followed++;
      if (was.low && !state.low && !state.gave === !was.gave && Math.max(Math.max(...src.map((x) => x.h)), counted === null ? -1 : counted) < was.read) seenKinds[at - was.low.last > 600000 ? "pause" : src.some((x) => was.last[x.id] - x.h > 25) ? "back" : "holder"]++;
      const want = plain(rounds), got = { top: state.top, topSince: state.topSince, seen: state.seen, gave: state.gave ? [state.gave.top, state.gave.since, state.gave.at] : null, run: state.low ? [state.low.h, state.low.since, state.low.last, Object.entries(state.low.hi).sort()] : null, read: state.read, readSince: state.readSince };
      if (JSON.stringify(want) !== JSON.stringify(got)) differ = { run, k, want, got };
    }
  }
  check("P1 " + steps.toLocaleString("en-US") + " random rounds (rises, drops, steps back and up again, resets, far-off answers, pauses at 599, 600 and 601 s, a day, a clock set back, validators alone): the fold says what its text says",
    !differ && steps > 60000 && seenKinds.gaveUp > 100 && seenKinds.ended > 50 && seenKinds.forgotten > 20 && seenKinds.arrivals > 5000 && seenKinds.followed > 500 && seenKinds.validators > 3000 && seenKinds.holder > 20 && seenKinds.back > 100 && seenKinds.pause > 100, JSON.stringify(differ || seenKinds));
  // A second start-over while lower heights are followed is rare in random rounds: here is one, on purpose. The chain
  // restarts lower twice; the second time a seed is left on the first lower chain's last height and stops answering.
  const twice = []; let at2 = T0;
  const push = (o, counted) => { at2 += 20 * S; twice.push({ at: at2, src: Object.entries(o).map(([id, h]) => ({ id, h })), counted: counted === undefined ? null : counted }); };
  push({ a: 9000, b: 9000 }); push({ a: 9001, b: 9001 });
  for (let k = 0; k < 40; k++) push({ a: 500 + k, b: 500 + k });          // the first lower chain: followed after ten minutes
  push({ a: 600 });                                                        // a jumps ahead on it, and is not heard again
  for (let k = 0; k < 40; k++) push({ b: 20 + k });                        // the second lower chain, far below what a showed
  for (let k = 0; k < 8; k++) push({ b: 60 + k }, 9001);                   // then validators counted on the first height given up: the following ends
  let st2 = newHeightClock(), again = 0, endedBy = 0, differ2 = null;
  twice.forEach((r, i) => { const was = st2; st2 = stepHeightClock(st2, r.src, r.at, r.counted); if (was.gave && st2.gave && st2.gave.at !== was.gave.at) again++; if (was.gave && !st2.gave) endedBy++;
    const want = plain(twice.slice(0, i + 1)), got = { top: st2.top, topSince: st2.topSince, seen: st2.seen, gave: st2.gave ? [st2.gave.top, st2.gave.since, st2.gave.at] : null, run: st2.low ? [st2.low.h, st2.low.since, st2.low.last, Object.entries(st2.low.hi).sort()] : null, read: st2.read, readSince: st2.readSince };
    if (!differ2 && JSON.stringify(want) !== JSON.stringify(got)) differ2 = { i, want, got }; });
  check("P2 a second start-over while lower heights are followed, and its end when the first height given up is read again by a counted validator: the fold and its text agree round by round; the first height stays the one remembered, and the count is then as old as that height's first reading",
    !differ2 && again === 1 && endedBy === 1 && st2.gave === null && st2.topSince === T0 + 40 * S && st2.read === 9001 && st2.readSince === T0 + 40 * S, JSON.stringify(differ2 || { again, endedBy, st2 }));
}

console.log("\n[" + TAG + "] worlds with a ground truth: what DNO read, from every node, in every round");
{
  // A chain produces blocks, halts, resumes and (rarely) restarts lower. Three seeds and six validators follow it, lag,
  // stick, fall back and catch up. DNO reads the seeds every 20 s, and the validators it keeps as candidates when fewer
  // than two seeds gave a height; sometimes it keeps none, is blind, or restarts. The ground truth is every (node,
  // height) pair DNO read, whether or not the rule calls the round a reading.
  //   A0 a new height claimed in a world where no node ever changes its height
  //   A1 a new height claimed in a round in which no seed rose above its own previous answer to a height new for itself
  //   A2 a new height claimed at or below a height a seed had shown DNO before, outside a start-over
  //   A3 a new height claimed at or below a height DNO had read before from a seed or from a validator counted in a reading
  //   A4 a new height claimed while lower heights are followed, or in a round that rests on validators alone
  //   B1 a stable reading although for 1,840 s or more no node DNO read has risen to a height new for itself and none
  //      was heard for the first time, and DNO had a reading 1,800 s before
  //   C1 degraded by standstill although a seed showed a height above everything DNO had read from anybody, in the last 1,800 s
  //   D1 a restart (the stored rounds replayed) publishing something else than the process that never restarted
  //   E1 something said about heights in a round without a reading
  //   K1 a count that runs from before DNO first read the height it stands on, or a higher one (from a seed in any
  //      round, or from a validator counted in a reading): DNO would say a height has stood for longer than it can know
  let seed = 20261004, seed2 = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, rnd2 = () => (seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const n = { A0: 0, A1: 0, A2: 0, A3: 0, A4: 0, B1: 0, C1: 0, D1: 0, E1: 0, K1: 0, younger: 0, rounds: 0, readings: 0, noReading: 0, loneSeed: 0, validatorsOnly: 0, validatorsMoved: 0, newHeights: 0, standstills: 0, startOvers: 0, ended: 0, replays: 0, following: 0 }; let first = null;
  for (let wi = 0; wi < 420; wi++) {
    const profile = wi % 7;   // 0 calm, 1 halts, 2 flaky seeds, 3 halts with seeds stuck apart, 4 restarts lower, 5 halts with nodes resyncing, 6 nothing ever changes
    let head = 400000 + Math.floor(rnd() * 1000), halted = profile === 6, haltLeft = profile === 6 ? 1e9 : 0;
    const mk = (isSeed, i) => ({ id: isSeed ? "seed" + i : VK(i), isSeed, mode: "follow", lag: Math.floor(rnd() * (profile === 3 || profile === 6 ? 6 : 2)), h: 0, up: rnd() < 0.9, left: 0, sync: 0 });
    const nodes = [mk(true, 1), mk(true, 2), mk(true, 3), mk(false, 1), mk(false, 2), mk(false, 3), mk(false, 4), mk(false, 5), mk(false, 6)];
    nodes.forEach((x) => { x.h = head - x.lag; if (profile === 6) x.mode = "stuck"; });
    if (profile === 2 || profile === 5) nodes.filter((x) => x.isSeed).forEach((x, i) => { x.flaky = i === 0 ? 0.01 : 0.12; });   // often one seed alone, or none
    let state = newHeightClock(), at = T0, blind = 0, candidates = rnd() < 0.8;
    const rows = [], shown = new Map(), readingAt = [], readLog = []; let seedTop = null, allTop = null, countedTop = null, lastSeedAboveAllAt = null, lastNews = null, firstReadingAt = null;
    for (let r = 0; r < 300; r++) {
      at += 20 * S;
      let produced = 0;
      if (halted) { if (--haltLeft <= 0) halted = false; }
      else {
        produced = rnd() < 0.8 ? 2 : 1;
        const p = rnd();
        if ((profile === 1 || profile === 3 || profile === 5) && p < 0.012) { halted = true; haltLeft = 60 + Math.floor(rnd() * 220); produced = 0; }
        else if (profile === 4 && p < 0.004) {
          head = 5 + Math.floor(rnd() * 50); produced = 0;
          nodes.forEach((x) => { if (x.mode !== "stuck" && rnd() < 0.93) { x.h = Math.max(0, head - x.lag); x.mode = "follow"; } else x.mode = "stuck"; });
          if (rnd() < 0.4) { halted = true; haltLeft = 30 + Math.floor(rnd() * 150); }
        }
      }
      head += produced;
      nodes.forEach((x) => {
        if (profile === 6) { if (x.left > 0) x.left--; else if (rnd() < 0.2) { x.up = !x.up; x.left = rnd() < 0.2 ? 35 : Math.floor(rnd() * 3); } return; }
        if (x.left > 0) x.left--;
        else {
          const flaky = x.flaky || (profile === 5 && halted ? 0.05 : 0.015);
          if (x.up && rnd() < flaky) { x.up = false; x.left = rnd() < 0.3 ? 30 + Math.floor(rnd() * 120) : Math.floor(rnd() * 4); if (profile === 5 && halted && rnd() < 0.6) { x.h = Math.max(0, x.h - 200 - Math.floor(rnd() * 3000)); x.mode = "sync"; x.sync = 15 + Math.floor(rnd() * 60); } }
          else if (!x.up) { x.up = true; if (x.h < head - 30 && x.mode === "follow") { x.mode = "sync"; x.sync = 20 + Math.floor(rnd() * 60); } }
        }
        if (x.mode === "follow") { if (x.h <= head) x.h = Math.max(x.h, halted ? head : head - x.lag); if (rnd() < (profile === 3 ? 0.006 : 0.002)) x.mode = "stuck"; }
        else if (x.mode === "sync" && x.up) { if (x.h <= head) { x.h = Math.min(head - (halted ? 0 : x.lag), x.h + x.sync); if (x.h >= head - x.lag) x.mode = "follow"; } }
        else if (x.mode === "stuck" && x.h <= head && rnd() < 0.01) { x.mode = "sync"; x.sync = 20 + Math.floor(rnd() * 60); }
      });
      if (rnd() < 0.004) candidates = !candidates;
      if (blind > 0) { blind--; continue; }
      if (profile !== 6 && rnd() < 0.002) { blind = 5 + Math.floor(rnd() * 150); continue; }
      const seeds = nodes.filter((x) => x.isSeed).map((x) => ({ id: x.id, h: x.up ? x.h : null })), own = seeds.filter((x) => x.h !== null);
      const entries = own.length >= 2 || !candidates ? null : nodes.filter((x) => !x.isSeed && x.up).map((x) => ({ key: x.id, h: x.h }));
      const before = state, rd = clockRound(seeds, entries ? entries.map((x) => x.h) : null);
      state = stepHeightClock(state, rd.sources, at, rd.counted);
      const had = rd.reading, mv = heightMovementOf(state, at, had, CFG);
      const reading = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: own.length, seedHeights: own.map((x) => x.h), validators: entries ? { read: entries.length, heights: entries.map((x) => x.h), listAgreedAt: null } : null,
        maxIncidentSeverity: "none", publicIncidentCount: 0, movement: { staticSeconds: mv.staticSeconds, advancing: mv.advancing, stalled: mv.stalled, following: mv.following, staticSince: null } });
      rows.push({ seeds: own, row: rd.row, reading: had, at }); n.rounds++;
      // the validators this reading counted, by this test's own arithmetic: within 25 blocks of the one seed, or of their upper median
      const vh = entries ? entries.map((x) => x.h).sort((x, y) => x - y) : [], ref = own.length === 1 ? own[0].h : vh.length ? vh[Math.floor(vh.length / 2)] : null;
      const countedNow = had && entries && own.length < 2 ? vh.filter((h) => Math.abs(h - ref) <= 25) : [];
      if (had) { n.readings++; if (firstReadingAt === null) firstReadingAt = at; } else n.noReading++;
      if (!had && own.length === 1) n.loneSeed++;
      if (rd.row && rd.row.h !== undefined) { n.validatorsOnly++; if (state.top !== before.top) n.validatorsMoved++; }
      const note = (k, o) => { n[k]++; if (!first) first = Object.assign({ kind: k, world: wi, round: r, profile }, o); };
      // what DNO read in this round, by this test's own arithmetic, and the first reading of the count's height or a higher one
      if (own.length || countedNow.length) readLog.push([at, Math.max(...own.map((x) => x.h).concat(countedNow))]);
      if (state.top !== null) { const firstAt = readLog.find(([, h]) => h >= state.top); if (!firstAt || firstAt[0] > state.topSince) note("K1", { top: state.top, topSince: state.topSince, firstAt }); else if (firstAt[0] < state.topSince && state.gave === null && had) n.younger++; }
      // the ground truth: what every node read this round shows against what that node, and any seed, showed before
      const read = own.map((x) => ({ id: x.id, h: x.h, seed: true })).concat((entries || []).map((x) => ({ id: x.key, h: x.h, seed: false })));
      const rose = read.some((x) => shown.has(x.id) && x.h > shown.get(x.id).prev && !shown.get(x.id).heights.has(x.h));
      const seedRose = read.some((x) => x.seed && shown.has(x.id) && x.h > shown.get(x.id).prev && !shown.get(x.id).heights.has(x.h));
      const heardFirst = read.some((x) => !shown.has(x.id));
      const seedMax = own.length ? Math.max(...own.map((x) => x.h)) : null, seedAboveAll = seedMax !== null && allTop !== null && seedMax > allTop;
      const claim = mv.advancedAt !== null && mv.advancedAt === at;
      if (before.gave === null && state.gave !== null) n.startOvers++;
      if (before.gave !== null && state.gave === null && at - before.gave.at <= 86400 * S) n.ended++;
      if (claim) {
        n.newHeights++;
        if (profile === 6) note("A0", { top: state.top });
        if (!seedRose) note("A1", { top: state.top, sources: rd.sources });
        if (state.gave !== null || !own.length) note("A4", { top: state.top, sources: rd.sources, gave: state.gave });
        if (seedTop !== null && state.top <= seedTop && before.gave === null && state.gave === null) note("A2", { top: state.top, seedTop });
        if (countedTop !== null && state.top <= countedTop && before.gave === null && state.gave === null) note("A3", { top: state.top, countedTop, mode: reading.witnesses.mode });
      }
      if (had && state.gave !== null) n.following++;
      const since = lastNews === null ? firstReadingAt : lastNews;
      if (had && reading.status === "stable" && !rose && !heardFirst && since !== null && at - since >= 1840 * S && readingAt.some(([t0, h0]) => h0 && t0 <= at - 1800 * S && t0 >= since)) note("B1", { state, staticSeconds: mv.staticSeconds, mode: reading.witnesses.mode });
      if (reading.standstill) {
        n.standstills++;
        if (seedAboveAll || (lastSeedAboveAllAt !== null && at - lastSeedAboveAllAt < 1800 * S)) note("C1", { state, allTop, lastSeedAboveAllAt, at });
      }
      if (!had && (mv.staticSeconds !== null || mv.advancedAt !== null || mv.advancing || mv.stalled || mv.following || reading.standstill)) note("E1", { mv });
      if (rnd2() < 0.03) {
        n.replays++;
        let s2 = newHeightClock(), had2 = false;
        rows.forEach((x) => { s2 = stepHeightClock(s2, x.seeds.length ? x.seeds : x.row && x.row.h !== undefined ? [{ id: VALIDATORS_SOURCE, h: x.row.h }] : [], x.at, x.row ? x.row.max : null); had2 = x.reading; });
        if (JSON.stringify(heightMovementOf(s2, at, had2, CFG)) !== JSON.stringify(mv)) note("D1", { live: mv, replayed: heightMovementOf(s2, at, had2, CFG) });
      }
      read.forEach((x) => { const e = shown.get(x.id) || { prev: null, heights: new Set() }; e.prev = x.h; e.heights.add(x.h); shown.set(x.id, e); });
      if (rose || heardFirst) lastNews = at;
      if (seedAboveAll) lastSeedAboveAllAt = at;
      if (seedMax !== null && (seedTop === null || seedMax > seedTop)) seedTop = seedMax;
      own.map((x) => x.h).concat(countedNow).forEach((h) => { if (countedTop === null || h > countedTop) countedTop = h; });
      if (before.gave === null && state.gave !== null) countedTop = Math.max(...own.map((x) => x.h).concat(countedNow));   // a start-over: what was read on the heights given up is set aside, as the rule says
      read.forEach((x) => { if (allTop === null || x.h > allTop) allTop = x.h; });
      readingAt.push([at, had]);
    }
  }
  check("X1 " + n.rounds.toLocaleString("en-US") + " rounds in 420 worlds: no new height where nothing changes, none without a seed that rose, none at a height a seed or a counted validator had shown, none while lower heights are followed or from validators alone; no stable reading while no node has risen for 30 minutes; no standstill within 30 minutes of a seed's new height; no restart that says something else; nothing said without a reading; no count that runs from before DNO first read the height it stands on, or a higher one",
    n.A0 + n.A1 + n.A2 + n.A3 + n.A4 + n.B1 + n.C1 + n.D1 + n.E1 + n.K1 === 0, JSON.stringify({ A0: n.A0, A1: n.A1, A2: n.A2, A3: n.A3, A4: n.A4, B1: n.B1, C1: n.C1, D1: n.D1, E1: n.E1, K1: n.K1, first }).slice(0, 1200));
  check("X2 and the worlds did exercise the rule: rounds without a reading and with one seed alone, readings from validators alone (their count moving), new heights, standstills, start-overs, their ends, replays, and counts younger than the first reading of their height (a height between it and the highest was read earlier) all occurred",
    n.readings > 60000 && n.noReading > 3000 && n.loneSeed > 1000 && n.validatorsOnly > 2000 && n.validatorsMoved > 500 && n.newHeights > 20000 && n.standstills > 5000
    && n.startOvers > 10 && n.ended > 0 && n.replays > 1000 && n.following > 100 && n.younger > 100, JSON.stringify(n));
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
  const args = (ts, h) => [ts, "stable", "low", "clear", "sufficient", "strong", h, 0, 3, 3, JSON.stringify([{ name: "a", block: h }, { name: "b", block: h }])];
  const mine = (ts, h, o) => { const x = Object.assign({ dq: "sufficient", states: JSON.stringify([{ name: "a", block: h }, { name: "b", block: h }]), median: h, kept: null }, o); return [ts, "stable", "low", "clear", x.dq, "strong", x.median, 0, 3, 3, x.states, x.kept]; };
  const since = new Function(extract("function ownHeightSince(") + "\nreturn ownHeightSince;")();
  // The agent's own replay and its reading of a stored row, on a table of this test.
  const replayOn = (db, start, maxRows) => new Function("sharedDb", "OWN_HEIGHT_SINCE", "RULE", "CLOCK_REPLAY_MAX_ROWS", "newHeightClock", "stepHeightClock", "sanitizeHeight", "VALIDATORS_SOURCE", "logError",
    "var heightClock = null, heightClockReplaySaid = false;\n" + extract("function clockInputOfRow(") + extract("function replayHeightClock(") + "\nreturn function(before) { var ok = replayHeightClock(before); return { ok: ok, clock: heightClock }; };")(
    db, start, RULE, maxRows || 20000, newHeightClock, stepHeightClock, sanitizeHeight, VALIDATORS_SOURCE, () => {});
  const db = new Database(":memory:");
  db.run(create);
  check("O1 a new store: every row will carry the mark, so no row is excluded; the column for what the clock took from the validators is there too", since(db) === 0 && ["own_height", "witness_clock"].every((c) => db.query("SELECT name FROM pragma_table_info('public_node_history')").all().some((x) => x.name === c)));
  for (let k = 0; k < 5; k++) db.run(OLDER, args(T0 + k * 20 * S, 900 + k));
  check("O2 rows the older agent wrote: the start is just after the newest of them", since(db) === T0 + 4 * 20 * S + 1, since(db));
  for (let k = 5; k < 10; k++) db.run(THIS, mine(T0 + k * 20 * S, 500 + k));
  check("O3 then this version's rows: the start stays at the end of the older rows, and all of this version's rows are after it",
    since(db) === T0 + 4 * 20 * S + 1 && db.query("SELECT COUNT(*) AS n FROM public_node_history WHERE own_height = 1 AND ts >= ?").get(since(db)).n === 5, since(db));
  for (let k = 10; k < 13; k++) db.run(OLDER, args(T0 + k * 20 * S, 900 + k));              // a rollback: the older agent runs on the same store
  check("O4 after a rollback the older agent's INSERT still works, and the start moves past its rows (this version's earlier rows are no longer used)",
    since(db) === T0 + 12 * 20 * S + 1, since(db));
  for (let k = 13; k < 15; k++) db.run(THIS, mine(T0 + k * 20 * S, 513 + k));
  const used = replayOn(db, since(db))(T0 + 99 * 20 * S);
  check("O5 the replay at start then steps only the rows written after the rollback, all under the own-height rule: the clock knows their heights and nothing older", used.ok === true && used.clock.top === 527 && used.clock.topSince === T0 + 14 * 20 * S && used.clock.seen === true
    && JSON.stringify(used.clock.last) === JSON.stringify({ a: 527, b: 527 }), JSON.stringify(used.clock));
  check("O6 this version's INSERT sets the mark, and names the column a round's validators are kept in for the clock", /node_states, own_height, witness_clock\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 1, \?\)/.test(THIS), THIS);
  check("O7 no stored stamp for it: the agent neither reads nor writes own_height_since", !/own_height_since/.test(SRC));
  check("O8 every read of median, spread or agreement from stored rows is bounded by the start: 24 h chain movement and the trend (the replay's bound is run in O5)",
    /\.all\(since, OWN_HEIGHT_SINCE\)/.test(SRC) && /WHERE ts > \? AND ts >= \? ORDER BY ts DESC LIMIT 15 OFFSET 1"\)\.all\(trendSince, OWN_HEIGHT_SINCE\)/.test(SRC));

  // The replay itself, on rows as this version writes them.
  const fresh = () => { const d = new Database(":memory:"); d.run(create); since(d); return d; };
  const liveOf = (rounds) => rounds.reduce((s, [src, at, counted]) => stepHeightClock(s, src, at, counted === undefined ? null : counted), newHeightClock());
  const two = (h) => [{ id: "a", h }, { id: "b", h }];
  {
    // The host clock was set back 30 minutes after the fourth row: time order is not the order the rounds were lived in.
    const d = fresh(), times = [0, 20, 40, 60, 80 - 1800, 100 - 1800, 120 - 1800], hs = [5200, 5220, 5240, 5240, 5240, 5240, 5240];
    times.forEach((sec, k) => d.run(THIS, mine(T0 + sec * S, hs[k])));
    const got = replayOn(d, 0)(T0 + (140 - 1800) * S), want = liveOf(times.map((sec, k) => [two(hs[k]), T0 + sec * S]));
    check("O9 rows are replayed in the order they were written, also after the host clock was set back: the clock is the one the running process had (the last new height at second 40, not at the row with the latest time)",
      JSON.stringify(got.clock) === JSON.stringify(want) && got.clock.topSince === T0 + 40 * S && got.clock.seen === true, JSON.stringify(got.clock));
  }
  {
    const d = fresh();
    d.run(THIS, mine(T0, 700)); d.run(THIS, mine(T0 + 20 * S, 701));
    d.run(THIS, mine(T0 + 40 * S, 0, { states: "{not json" }));                                              // a row that cannot be read
    d.run(THIS, mine(T0 + 60 * S, 0, { states: JSON.stringify([{ name: "a", block: "x" }, null, { block: 5 }]), median: null }));   // nothing usable in it
    d.run(THIS, mine(T0 + 80 * S, 701));
    const got = replayOn(d, 0)(T0 + 100 * S);
    check("O10 a stored row that cannot be read is skipped, and the rows after it are still replayed", got.ok === true && got.clock.top === 701 && got.clock.topSince === T0 + 20 * S && got.clock.seen === true && JSON.stringify(got.clock.last) === JSON.stringify({ a: 701, b: 701 }), JSON.stringify(got));
  }
  {
    // A lone seed's rows have no reading (data_quality insufficient) and are replayed all the same: the heights it showed are kept.
    const d = fresh(), lone = (h) => JSON.stringify([{ name: "a", block: h }, { name: "b", block: null }]);
    d.run(THIS, mine(T0, 1008)); d.run(THIS, mine(T0 + 20 * S, 1010, { dq: "insufficient", states: lone(1010) })); d.run(THIS, mine(T0 + 40 * S, 1018, { dq: "insufficient", states: lone(1018) }));
    for (let k = 3; k < 10; k++) d.run(THIS, mine(T0 + k * 20 * S, 1018, { dq: "insufficient", states: lone(1018) }));
    const got = replayOn(d, 0)(T0 + 200 * S);
    check("O11 rows without a reading are replayed for what each seed showed in them: a lone seed's heights move the clock as they did live", got.clock.top === 1018 && got.clock.topSince === T0 + 40 * S && got.clock.seen === true && got.clock.last.a === 1018 && got.clock.last.b === 1008, JSON.stringify(got.clock));
  }
  {
    // Rounds that rested on validators alone: no seed height in node_states, no median_block, and in witness_clock the height their count stood on and the highest counted.
    const d = fresh(), none = JSON.stringify([{ name: "a", block: null }, { name: "b", block: null }]), vrow = (ts, h, o) => mine(ts, h, Object.assign({ states: none, median: null, kept: JSON.stringify({ h, max: h + 1 }) }, o));
    d.run(THIS, mine(T0, 1000)); d.run(THIS, mine(T0 + 20 * S, 1000));
    d.run(THIS, vrow(T0 + 40 * S, 1003)); d.run(THIS, vrow(T0 + 60 * S, 1004)); d.run(THIS, vrow(T0 + 80 * S, 1004));
    d.run(THIS, vrow(T0 + 100 * S, 1010, { dq: "insufficient" }));                                           // not a reading: not a source
    d.run(THIS, vrow(T0 + 120 * S, 1011, { kept: JSON.stringify({ h: 1011.5, max: 1012 }) }));               // a height that is not one is not a source
    d.run(THIS, mine(T0 + 140 * S, 0, { states: none, median: 2000, kept: null }));                          // a median without the column is not the validators'
    d.run(THIS, vrow(T0 + 160 * S, 1005, { kept: "{not json" }));                                            // a row that cannot be read gives nothing
    const got = replayOn(d, 0)(T0 + 180 * S);
    const V1 = (h) => [{ id: VALIDATORS_SOURCE, h }];
    const want = liveOf([[two(1000), T0], [two(1000), T0 + 20 * S], [V1(1003), T0 + 40 * S, 1004], [V1(1004), T0 + 60 * S, 1005], [V1(1004), T0 + 80 * S, 1005]]);
    check("O12 a row that rested on validators alone is replayed from the height its count stood on and its highest counted height: the count moves as it did live and no arrival is claimed; a row without a reading, with a height that is not one, or that cannot be read is no source",
      JSON.stringify(got.clock) === JSON.stringify(want) && got.clock.top === 1004 && got.clock.topSince === T0 + 40 * S && got.clock.seen === false && got.clock.read === 1005 && got.clock.readSince === T0 + 60 * S && got.clock.last[VALIDATORS_SOURCE] === 1004, JSON.stringify(got.clock));
    // Beside one seed the row keeps the highest counted validator height, and the seed's own height stays its median.
    const e = fresh(), one = (h) => JSON.stringify([{ name: "a", block: h }, { name: "b", block: null }]);
    e.run(THIS, mine(T0, 1000, { states: one(1000), kept: JSON.stringify({ max: 1002 }) })); e.run(THIS, mine(T0 + 20 * S, 1001, { states: one(1001), kept: JSON.stringify({ max: 1002 }) }));
    e.run(THIS, mine(T0 + 40 * S, 1003, { states: one(1003), kept: JSON.stringify({ max: 1003 }) }));
    const g2 = replayOn(e, 0)(T0 + 60 * S);
    check("O12b beside one seed the stored row gives the clock the seed and the highest counted validator height: the seed's step to a height a validator had shown is no new height (the count runs from that validator's first reading); its step above it is one, seen arriving",
      JSON.stringify(g2.clock) === JSON.stringify(liveOf([[[{ id: "a", h: 1000 }], T0, 1002], [[{ id: "a", h: 1001 }], T0 + 20 * S, 1002], [[{ id: "a", h: 1003 }], T0 + 40 * S, 1003]])) && g2.clock.top === 1003 && g2.clock.seen === true && g2.clock.read === 1003
      && liveOf([[[{ id: "a", h: 1000 }], T0, 1002], [[{ id: "a", h: 1001 }], T0 + 20 * S, 1002]]).seen === false && liveOf([[[{ id: "a", h: 1000 }], T0, 1002], [[{ id: "a", h: 1001 }], T0 + 20 * S, 1002]]).topSince === T0 && g2.clock.topSince === T0 + 40 * S, JSON.stringify(g2.clock));
  }
  {
    const d = fresh();
    for (let k = 0; k < 10; k++) d.run(THIS, mine(T0 + k * 20 * S, 800 + k));
    const got = replayOn(d, 0, 3)(T0 + 200 * S);
    check("O13 with more rows than the replay takes, it takes the newest: the clock knows the last three rounds", got.clock.top === 809 && got.clock.topSince === T0 + 9 * 20 * S && got.clock.seen === true, JSON.stringify(got.clock));
    const old = replayOn(d, 0)(T0 + 9 * 20 * S + 86400 * S + 1);
    check("O14 rows older than 24 hours are not replayed; one exactly 24 hours old is", old.clock.top === null && replayOn(d, 0)(T0 + 9 * 20 * S + 86400 * S).clock.top === 809, JSON.stringify(old.clock));
    const broken = new Function("sharedDb", "OWN_HEIGHT_SINCE", "RULE", "CLOCK_REPLAY_MAX_ROWS", "newHeightClock", "stepHeightClock", "sanitizeHeight", "VALIDATORS_SOURCE", "logError",
      "var heightClock = 'untouched', heightClockReplaySaid = false;\n" + extract("function clockInputOfRow(") + extract("function replayHeightClock(") + "\nreturn function(before) { var ok = replayHeightClock(before); return { ok: ok, clock: heightClock }; };")(
      { query() { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); } }, 0, RULE, 20000, newHeightClock, stepHeightClock, sanitizeHeight, VALIDATORS_SOURCE, () => {})(T0);
    check("O15 a store that cannot be read: the replay says it failed and leaves the clock as it was", broken.ok === false && broken.clock === "untouched");
  }
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
