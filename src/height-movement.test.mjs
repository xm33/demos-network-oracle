// height-movement.test.mjs — HEIGHT_MOVEMENT guard: when DNO may say heights advanced, and for how long they have not.
// Runs the real heightTracker, updateHeightTracker() and heightMovement() from agent.mjs (extracted from the source,
// with the source's default intervals) against synthetic rounds and a history table that honours the query's bounds.
// Run: bun src/height-movement.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
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
const decl = SRC.match(/var heightTracker = \{[^;]*\};\nconst HEIGHT_WINDOW_MS = [^;]*;/)[0];
const line = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n", i) + 1); };
const code = decl + "\n" + line("function ownHeight(") + extract("function updateHeightTracker(") + extract("function heightMovement(");
const MONITOR_INTERVAL_MS = Number(SRC.match(/const MONITOR_INTERVAL_MS = parseInt\(process\.env\.MONITOR_INTERVAL_MS \|\| "(\d+)"\)/)[1]);
const CHAIN_STATIC_RUN_MIN_24H = Number(SRC.match(/var CHAIN_STATIC_RUN_MIN_24H = parseInt\(process\.env\.PHASE_B_CHAIN_STATIC_RUN_MIN \|\| '(\d+)'/)[1]);
// history: { ts, median_block } rows; the stub applies the query's bound, order and limit.
function fresh(history, ownSince = 0) {
  const db = history ? { query: (sql) => ({ all: (bound, since) => {
    if (!/ts < \? AND ts >= \? ORDER BY ts DESC LIMIT 2000/.test(sql)) throw new Error("unexpected history query: " + sql);
    return history.filter((r) => r.ts < bound && r.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, 2000);
  } }) } : null;
  return new Function("sanitizeHeight", "sharedDb", "MONITOR_INTERVAL_MS", "CHAIN_STATIC_RUN_MIN_24H", "OWN_HEIGHT_SINCE",
    code + "\nreturn { t: heightTracker, update: updateHeightTracker, movement: heightMovement };")(sanitizeHeight, db, MONITOR_INTERVAL_MS, CHAIN_STATIC_RUN_MIN_24H, ownSince);
}
// A seed's own height comes from its own peerlist entry (height_source "self").
const round = (heights) => Object.entries(heights).map(([name, block]) => ({ name, ok: block !== undefined, block, height_source: block === undefined ? null : "self" }));
// The published values: heightMovement() is what computeCanonicalState uses.
let current = null;
function published(t, observedAt, anyHeight = true) {
  const m = current.movement(observedAt, anyHeight);
  return { staticS: m.staticSeconds, advancedAt: m.advancedAtIso ? Date.parse(m.advancedAtIso) : null, reason: m.advancing ? "advancing" : m.stalled ? "unchanged" : "aligned" };
}
function fresh2(history, ownSince) { current = fresh(history, ownSince); return current; }
const T0 = 1_800_000_000_000, S = 1000;

console.log("\n[" + TAG + "] start, advance, static");
{
  const { t, update } = fresh2(null);
  update(round({ a: 100, b: 100 }), T0);
  let p = published(t, T0);
  check("A1 first round after a start: nothing claimed", p.staticS === null && p.advancedAt === null && p.reason === "aligned" && current.movement(T0, true).staticSince === null, JSON.stringify(p));
  update(round({ a: 101, b: 100 }), T0 + 20 * S);
  p = published(t, T0 + 20 * S);
  check("A2 an observed advance: static 0, advancing", p.staticS === 0 && p.advancedAt === T0 + 20 * S && p.reason === "advancing", JSON.stringify(p));
  update(round({ a: 101, b: 101 }), T0 + 40 * S);
  p = published(t, T0 + 40 * S);
  check("A3 a lagging seed catching up is no advance: the height it reaches was already reported", p.staticS === 20 && p.advancedAt === T0 + 20 * S, JSON.stringify(p));
  for (let k = 3; k <= 20; k++) update(round({ a: 101, b: 101 }), T0 + k * 20 * S);
  p = published(t, T0 + 400 * S);
  check("A4 six minutes without a new height: unchanged, counted from the round that showed it", p.staticS === 380 && p.reason === "unchanged", JSON.stringify(p));
  const since = current.movement(T0 + 400 * S, true).staticSince;
  check("A6 since when, for a condition record: the minute of the last new height, UTC", since === new Date(T0 + 20 * S).toISOString().slice(0, 16).replace("T", " ") && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(since), since);
  check("A7 and nothing when no height movement is published", current.movement(T0 + 400 * S, false).staticSince === null);
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 100, b: 100 }), T0);
  update(round({ a: 100, b: 100 }), T0 + 20 * S);
  const p = published(t, T0 + 20 * S);
  check("A5 two equal rounds after a start: a lower bound, no advance claimed", p.staticS === 20 && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
}

console.log("\n[" + TAG + "] seeds leaving and joining");
{
  const { t, update } = fresh2(null);
  update(round({ a: 200, b: 190 }), T0);
  update(round({ a: 201, b: 191 }), T0 + 20 * S);
  update(round({ b: 191 }), T0 + 40 * S);
  let p = published(t, T0 + 40 * S);
  check("B1 the leading seed stops answering: not an advance, not a stall either", p.staticS === 20 && p.reason === "advancing", JSON.stringify(p));
  update(round({ b: 192 }), T0 + 60 * S);
  p = published(t, T0 + 60 * S);
  check("B2 the remaining seed rising towards the height the leader left on is no advance", p.staticS === 40 && p.advancedAt === T0 + 20 * S, JSON.stringify(p));
  for (let k = 4; k <= 12; k++) update(round({ b: 189 + k }), T0 + k * 20 * S);      // 193 ... 201
  p = published(t, T0 + 240 * S);
  check("B2b nor when it reaches that height", p.staticS === 220, JSON.stringify(p));
  update(round({ b: 202 }), T0 + 260 * S);
  p = published(t, T0 + 260 * S);
  check("B2c the first height above it is the advance", p.staticS === 0 && p.advancedAt === T0 + 260 * S && p.reason === "advancing", JSON.stringify(p));
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 200, b: 100 }), T0);
  update(round({ a: 201, b: 101 }), T0 + 20 * S);
  for (let k = 2; k <= 31; k++) update(round({ b: 100 + k }), T0 + k * 20 * S);      // the leader is away; b keeps rising, far below 201
  let p = published(t, T0 + 620 * S);
  check("B8 while the leader's last height is within the window, a lower seed rising is no advance", p.staticS === 600 && p.reason === "unchanged", JSON.stringify(p));
  update(round({ b: 132 }), T0 + 640 * S);
  p = published(t, T0 + 640 * S);
  check("B9 ten minutes after the leader's last answer its height is forgotten, and the seed that still answers is followed", p.staticS === 0 && p.reason === "advancing", JSON.stringify(p));
}
{
  // 2 October 2026, as n3's store shows it: one seed alone advanced until 11:47 UTC and then stood on one height; the
  // other seed came back an hour later, far behind, and caught up over eight minutes. Before 1.2 every step of that
  // catching up counted as an advance, and the published "last advance" moved to 12:52.
  const { t, update } = fresh2(null);
  const HEAD = 429825, MIN = 60 * S;
  let at = T0, n3 = HEAD - 60;
  update(round({ n2: n3, n3 }), at);
  while (n3 < HEAD) { at += 20 * S; n3 += 2; update(round({ n3 }), at); }
  const stoodAt = at;
  while (at < stoodAt + 57 * MIN) { at += 20 * S; update(round({ n3: HEAD }), at); }
  let n2 = HEAD - 1200;
  while (n2 < HEAD) { at += 20 * S; n2 = Math.min(HEAD, n2 + 50); update(round({ n2, n3: HEAD }), at); }
  let p = published(t, at);
  check("H1 2 October: a seed returning far behind and catching up does not restart the clock", p.advancedAt === stoodAt && p.staticS === Math.round((at - stoodAt) / 1000) && p.staticS > 57 * 60 && p.reason === "unchanged", JSON.stringify(p));
  while (at < stoodAt + 179 * MIN) { at += 20 * S; update(round({ n2: HEAD, n3: HEAD }), at); }
  p = published(t, at);
  check("H2 and three hours on the published last advance is still the round the height last rose", p.advancedAt === stoodAt && p.staticS === 179 * 60, JSON.stringify(p));
  update(round({ n2: HEAD, n3: HEAD + 1 }), at + 20 * S);
  p = published(t, at + 20 * S);
  check("H3 the next new height ends it", p.staticS === 0 && p.advancedAt === at + 20 * S, JSON.stringify(p));
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 300 }), T0);
  update(round({ a: 300 }), T0 + 20 * S);
  update(round({ b: 305 }), T0 + 40 * S);
  const p = published(t, T0 + 40 * S);
  check("B3 a seed answering for the first time above the last round's highest height is an advance", p.staticS === 0, JSON.stringify(p));
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 395000, b: 395000 }), T0);
  update(round({ a: 395001, b: 395001 }), T0 + 20 * S);
  update(round({ a: 5, b: 5 }), T0 + 40 * S);
  update(round({ a: 6, b: 5 }), T0 + 60 * S);
  const p = published(t, T0 + 60 * S);
  check("C1 a chain reset is followed by the next advance, not a long stall", p.staticS === 0 && t.maxHeight === 6, JSON.stringify(p));
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 100, b: 100 }), T0);
  update(round({ a: undefined, b: undefined }), T0 + 20 * S);
  const p = published(t, T0 + 20 * S, false);
  check("C2 a round without any height publishes nothing about movement", p.staticS === null && t.maxHeight === null, JSON.stringify(p));
}

{
  const { t, update } = fresh2(null);
  update(round({ a: 501, b: 500 }), T0);
  for (let k = 1; k <= 18; k++) update(round({ a: 501, b: 500 }), T0 + k * 20 * S);
  let p = published(t, T0 + 360 * S);
  const before = p.staticS;
  update(round({ b: 500 }), T0 + 380 * S);                   // the leader times out for one round
  update(round({ a: 501, b: 500 }), T0 + 400 * S);           // and comes back at the same height
  p = published(t, T0 + 400 * S);
  check("B4 a leader that skips a round during a stall does not reset the clock", before === 360 && p.staticS === 400 && p.reason === "unchanged", JSON.stringify({ before, p }));
  for (let k = 21; k <= 25; k++) update(round({ b: 500 }), T0 + k * 20 * S);   // absent for five rounds
  update(round({ a: 501, b: 500 }), T0 + 520 * S);
  p = published(t, T0 + 520 * S);
  check("B5 nor after a longer absence", p.staticS === 520 && p.reason === "unchanged", JSON.stringify(p));
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 480, b: 480 }), T0);
  update(round({ b: 500 }), T0 + 20 * S);
  for (let k = 2; k <= 20; k++) update(round({ b: 500 }), T0 + k * 20 * S);     // b stalls at 500; a is away
  update(round({ a: 500, b: 500 }), T0 + 420 * S);                               // a returns at the stalled height
  const p = published(t, T0 + 420 * S);
  check("B6 a seed back after a long gap at the height the others stalled on is no advance", p.staticS === 400 && p.reason === "unchanged", JSON.stringify(p));
}
{
  const { t, update } = fresh2(null);
  update(round({ a: 510, b: 500 }), T0);
  update(round({ a: 510, b: 500 }), T0 + 20 * S);
  for (let k = 2; k <= 50; k++) update(round({ b: 500 }), T0 + k * 20 * S);     // the leader is away for 16 minutes
  update(round({ a: 510, b: 500 }), T0 + 1020 * S);                              // and returns at its own height
  const p = published(t, T0 + 1020 * S);
  check("B7 a leader back after more than the window, at its own last height, is no advance", p.staticS === 1020 && p.reason === "unchanged", JSON.stringify(p));
}

console.log("\n[" + TAG + "] a height taken from a seed's first listed peer");
{
  const { t, update } = fresh2(null);
  update(round({ a: 700, b: 700 }), T0);
  update(round({ a: 700, b: 700 }), T0 + 20 * S);
  const firstPeer = round({ a: 700 }).concat([{ name: "b", ok: true, block: 760, height_source: "first_peer" }]);
  update(firstPeer, T0 + 40 * S);
  const p = published(t, T0 + 40 * S);
  check("E1 a first-peer height is not the seed's height: no advance, no new maximum", t.maxHeight === 700 && p.staticS === 40 && p.reason === "aligned" && !("b" in t.lastBySeed && t.lastBySeed.b.h === 760), JSON.stringify({ p, max: t.maxHeight }));
  update([{ name: "a", ok: true, block: 690, height_source: "first_peer" }, { name: "b", ok: true, block: 690, height_source: "first_peer" }], T0 + 60 * S);
  const q = published(t, T0 + 60 * S, false);
  check("E2 a round with first-peer heights only publishes nothing about movement", t.maxHeight === null && q.staticS === null, JSON.stringify({ q, max: t.maxHeight }));
}

console.log("\n[" + TAG + "] restart with retained history");
{
  const hist = [];
  for (let k = 1; k <= 30; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 500 });   // 10 minutes at 500
  hist.push({ ts: T0 - 31 * 20 * S, median_block: 499 });
  hist.push({ ts: T0, median_block: 501 }, { ts: T0 + 20 * S, median_block: 501 });   // rows at or after this round are outside the query's bound
  const { t, update } = fresh2(hist);
  update(round({ a: 500, b: 500 }), T0);
  const p = published(t, T0);
  check("D1 a restart during a stall keeps the run and its start", p.staticS === 600 && p.advancedAt === T0 - 30 * 20 * S && p.reason === "unchanged", JSON.stringify(p));
}
{
  const hist = [];
  for (let k = 1; k <= 2000; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 395000 - k });
  const { t, update } = fresh2(hist);
  update(round({ a: 12, b: 12 }), T0);
  const p = published(t, T0);
  check("D2 a restart after a chain reset claims nothing from the old chain", p.staticS === null && p.reason === "aligned", JSON.stringify(p));
}
{
  const hist = [{ ts: T0 - 20 * S, median_block: 480 }, { ts: T0 - 40 * S, median_block: 479 }];
  const { t, update } = fresh2(hist);
  update(round({ a: 500, b: 500 }), T0);
  const p = published(t, T0);
  check("D3 a restart after the height moved on: nothing claimed until the next round", p.staticS === null, JSON.stringify(p));
}

{
  const hist = [];
  for (let k = 1; k <= 30; k++) hist.push({ ts: T0 - k * 20 * S, median_block: 500 });   // 10 minutes at 500, all before the rule change
  const { t, update } = fresh2(hist, T0 - 5 * 20 * S);                                   // own heights since 100 s ago
  update(round({ a: 500, b: 500 }), T0);
  const p = published(t, T0);
  check("D4 history from before seeds counted only their own heights is not read (a lower bound from the change)", p.staticS === 100 && p.advancedAt === null && p.reason === "aligned", JSON.stringify(p));
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
