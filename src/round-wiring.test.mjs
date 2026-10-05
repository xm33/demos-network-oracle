// round-wiring.test.mjs — ROUND_WIRING guard: the agent's own round functions, executed together.
//
// agent.mjs starts the agent when it is imported, so its functions cannot be imported one by one. As the other suites
// take single functions from its text, this one takes the whole public round and the validator round and runs them:
//   the start-up lines that open the stores, the public round (startPublicObservationLoop, publicObservationCycle,
//   probePublicNodes, readRoundWitnesses, stepPublicHeightClock, replayHeightClock, clockInputOfRow,
//   computeCanonicalState, recordPublicNodeHistory, evaluatePublicIncidents and the record writers) and the validator
//   round (startValidatorWatchLoop, validatorWatchRound, seedMedianReference), with the declarations they use.
// They run on a real bun:sqlite database with DNO's own modules (seed-read, witnesses, validator-watch, status-rule,
// public-safety), on a clock and a transport this suite holds: the seeds and the validators are tables in memory, and
// every read of them goes through the modules' own code. Nothing here opens a socket.
// What the modules do alone is in their own suites; what is checked here is what the agent makes of them: which
// reads a round makes, what it stores, what it publishes, and that a restart says what the running agent said.
// Run: bun src/round-wiring.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { sanitizeHeight, keyOf, parseProbeOrigin } from "./public-safety.mjs";
import { readSeedInfo, seedsSufficient } from "./seed-read.mjs";
import { RULE, assess, stepConditionRecords, clockRound, newHeightClock, stepHeightClock, heightMovementOf, VALIDATORS_SOURCE } from "./status-rule.mjs";
import { createCandidateStore, nextCandidates, readWitnesses, witnessSnapshot } from "./witnesses.mjs";
import { runValidatorRound, createWatchHistory, createFirstAgreedStore, roundLogLine, dialsEnabled } from "./validator-watch.mjs";

const TAG = "ROUND_WIRING";
const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const J = (x) => JSON.stringify(x);
const brief = (x, n) => J(x).slice(0, n || 400);

// ---- the agent's own text ---------------------------------------------------------------------------------------------
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
// A function declared at the start of a line, to its closing brace at the start of a line.
function fn(start) { const i = SRC.indexOf("\n" + start); if (i < 0) throw new Error("agent.mjs has no '" + start + "'"); return SRC.slice(i + 1, SRC.indexOf("\n}\n", i) + 3); }
// One line that starts so.
function line(start) { const i = SRC.indexOf("\n" + start); if (i < 0) throw new Error("agent.mjs has no line '" + start + "'"); return SRC.slice(i + 1, SRC.indexOf("\n", i + 1) + 1); }
// From one text up to another.
function span(start, end, keepEnd) { const i = SRC.indexOf(start); const j = i < 0 ? -1 : SRC.indexOf(end, i); if (i < 0 || j < 0) throw new Error("agent.mjs has no '" + (i < 0 ? start : end) + "'"); return SRC.slice(i, keepEnd ? j + end.length : j) + "\n"; }

const DECLARATIONS = ["var CHAIN_STATIC_RUN_MIN_24H = ", "var API_VERSION = ", "const MONITOR_INTERVAL_MS = ", "const PUBLIC_NODE_HISTORY_RETENTION_DAYS = ",
  "const PUBLIC_INCIDENT_OPEN_CYCLES = ", "const PUBLIC_INCIDENT_RESOLVE_CYCLES = ", "const PUBLIC_VISIBILITY_MARKER = ", "const PUBLIC_DEGRADED_MARKER = ", "const PUBLIC_UNSTABLE_MARKER = ", "const MARKER_NODES = ",
  "var publicIncidentCounters = ", "var publicBackfillChecked = ", "let activeIncidents = ", "let incidentCounter = ", "const INCIDENT_RECONCILIATION_START_AT = ",
  "let lastPublicObservedAt = ", "const AGENT_STARTED_AT = ", "var heightClock = ", "var heightClockHadReading = ", "var heightClockRow = ", "const CLOCK_REPLAY_MAX_ROWS = ", "var OWN_HEIGHT_SINCE = ", "const PUBLIC_STALE_AFTER_SECONDS = ",
  "const INFO_BODY_MAX_BYTES = ", "function envMs(", "const VALIDATOR_WATCH_INTERVAL_MS = ", "const VALIDATOR_WATCH_WINDOW_MS = ", "const VALIDATOR_WATCH_DIALS = ", "var VALIDATOR_ORIGIN_RESOLVER = ", "var validatorRoundNumber = ",
  "var validatorHistory = ", "var validatorFirstAgreed = ", "const SEED_KEYS = ", "var latestValidatorRound = ", "var witnessCandidates = ", "let latestWitnesses = ", "let latestPublicNodes = ",
  "function ownHeight(", "function isFleetName("];
const FUNCTIONS = ["function isPublicConditionMarker(inc) {", "function incidentScope(", "function countActivePublicConditions() {", "function getNextIncidentId() {", "function openIncident(", "function resolveIncident(",
  "function evaluatePublicIncidents() {", "function loadIncidentCounter() {", "function ownHeightSince(db) {", "function computeCanonicalState() {", "function recordPublicNodeHistory() {", "async function probePublicNodes() {",
  "function clockInputOfRow(row) {", "function replayHeightClock(before) {", "function stepPublicHeightClock(", "async function publicObservationCycle() {", "function startPublicObservationLoop() {",
  "async function readRoundWitnesses(", "function witnessInput() {", "function seedMedianReference() {", "async function validatorWatchRound() {", "function startValidatorWatchLoop() {"];
// The start, in main()'s order: the incidents table, the open records read back, the history table and its own-height
// mark, the record counter, and the witness candidates.
const START = span("sharedDb.exec(`CREATE TABLE IF NOT EXISTS incidents (", ")`);", true)
  + span("  // --- Rehydrate activeIncidents from DB", "  // Validator discovery tracking table")
  + span("sharedDb.run(`CREATE TABLE IF NOT EXISTS public_node_history (", ")`);", true)
  + span("  try {\n    OWN_HEIGHT_SINCE = ", "\n\n  // node_metadata")
  + "  loadIncidentCounter();\n"
  + line("  witnessCandidates = createCandidateStore(") + line('  log("  Witness candidates kept: "');
const CODE = '"use strict";\nvar FLEET_NODE_NAMES = [], FLEET_NODES_24H = new Set();\n' + DECLARATIONS.map(line).join("") + FUNCTIONS.map(fn).join("")
  + "function startUp() {\n" + START + "}\n"
  + `return { startUp: startUp, startPublicObservationLoop: startPublicObservationLoop, startValidatorWatchLoop: startValidatorWatchLoop,
    canonical: function() { return computeCanonicalState(); }, clock: function() { return heightClock; }, restored: function() { return heightClockRestored; },
    openIncident: openIncident, resolveIncident: resolveIncident,
    active: function() { return activeIncidents; }, kept: function() { return witnessCandidates.load(Date.now()); }, round: function() { return latestValidatorRound; },
    witnesses: function() { return latestWitnesses; }, observedAt: function() { return lastPublicObservedAt; }, ownSince: function() { return OWN_HEIGHT_SINCE; },
    dials: function() { return VALIDATOR_WATCH_DIALS; }, growth: function() { return validatorFirstAgreed; } };`;
const NAMES = ["Date", "process", "setTimeout", "sharedDb", "log", "logError", "PUBLIC_NODES", "sanitizeHeight", "keyOf", "resolvePublicProbeOrigin", "readSeedInfo", "seedsSufficient",
  "RULE", "assess", "stepConditionRecords", "clockRound", "newHeightClock", "stepHeightClock", "heightMovementOf", "VALIDATORS_SOURCE", "createCandidateStore", "nextCandidates", "readWitnesses", "witnessSnapshot",
  "runValidatorRound", "createWatchHistory", "createFirstAgreedStore", "roundLogLine", "dialsEnabled", "catalogBeginCrawl", "catalogIngestPeerlist", "catalogFinishCrawl", "recordObservationHistory", "refreshValidatorUptimeCache"];
const BUILD = new Function(...NAMES, CODE);

// ---- the world the agent reads ----------------------------------------------------------------------------------------
const K = (n) => n.toString(16).padStart(2, "0").repeat(32);     // a key as the watch keeps it
const ID = (n) => "0x" + K(n);
const SEEDS = { "seed-a": { url: "http://seed-a.test:53550", identity: ID(0xa1) }, "seed-b": { url: "http://seed-b.test:53550", identity: ID(0xa2) }, "seed-c": { url: "http://seed-c.test:53550", identity: ID(0xa3) } };
const SEED_NAMES = Object.keys(SEEDS);
const hostOf = (url) => new URL(url).host;
function makeWorld() {
  const w = { seeds: {}, vals: new Map(), requests: [], refused: new Set(), resolved: [] };
  SEED_NAMES.forEach((n) => { w.seeds[n] = { up: true, h: 1000, own: true, names: SEEDS[n].identity, rows: null }; });
  // A validator: listed ACTIVE at its own address, answering as its key with its own height, unless told otherwise.
  w.validator = (n, o) => { const key = K(n); w.vals.set(key, Object.assign({ key, host: "v" + n.toString(16) + ".test:53550", publish: undefined, status: "2", up: true, h: 1000, own: true, names: "0x" + key, listed: true }, o)); return key; };
  w.rows = () => [...w.vals.values()].filter((v) => v.listed).map((v) => ({ address: "0x" + v.key, status: v.status, connectionUrl: v.publish === undefined ? "http://" + v.host : v.publish }));
  w.set = (heights) => { SEED_NAMES.forEach((n, i) => { const x = heights[i], s = w.seeds[n]; s.up = x !== "down"; s.own = typeof x === "number"; if (typeof x === "number") s.h = x; }); return w; };
  w.vset = (heights) => { [...w.vals.values()].forEach((v, i) => { const x = heights[i]; if (x === undefined) return; v.up = x !== "down"; v.own = typeof x === "number"; if (typeof x === "number") v.h = x; }); return w; };
  w.asked = (what, to) => w.requests.filter((r) => r.what === what && (to === undefined || r.to === to)).length;
  const info = (identity, own, h) => Response.json({ identity: identity, version: "0.9.9", peerlist: [{ identity: ID(0xee), sync: { block: h + 500 } }].concat(own ? [{ identity: own, sync: { block: h } }] : []) });
  // Every read the modules make arrives here, through cappedJson.
  // w.fault(u, method): when it says so, the read itself throws a TypeError, as a fault in DNO's own read path does.
  w.transport = async (url, init) => {
    const u = new URL(url), method = (init && init.method) || "GET";
    if (w.fault && w.fault(u, method)) throw new TypeError("resp.body.getReader is not a function");
    const name = SEED_NAMES.find((n) => hostOf(SEEDS[n].url) === u.host);
    if (name) {
      const s = w.seeds[name], what = method === "GET" && u.pathname === "/info" ? "info" : JSON.parse(init.body).params[0].message;
      w.requests.push({ to: name, what });
      if (!s.up) throw new Error("connection refused");
      if (what === "info") return info(s.names, s.own ? SEEDS[name].identity : null, s.h);
      if (what === "getValidators") return Response.json({ result: 200, response: s.rows ? s.rows(w.rows()) : w.rows() });
      return Response.json({ result: 200, response: { minValidatorStake: "1000" } });
    }
    const v = [...w.vals.values()].find((x) => x.host === u.host);
    w.requests.push({ to: v ? v.key : u.host, what: v && method === "GET" && u.pathname === "/info" ? "info" : "other" });
    if (w.dial) w.dial();   // a dial takes time, when the test says so
    if (!v || !v.up) throw new Error("connection refused");
    // pad: a body of that many bytes beyond the answer itself (an answer larger than the agent's cap).
    if (v.pad) return new Response(JSON.stringify({ identity: v.names, version: "0.9.9", pad: "x".repeat(v.pad), peerlist: [{ identity: v.names, sync: { block: v.h } }] }), { headers: { "content-type": "application/json" } });
    return info(v.names, v.own ? v.names : null, v.h);
  };
  // The address check: every .test name is a public http origin here, except the names this world refuses.
  w.resolver = async (url) => { const p = parseProbeOrigin(url); if (!p || p.protocol !== "http:" || !p.hostname.endsWith(".test") || w.refused.has(p.hostname)) return null; w.resolved.push(p.host); return "http://" + p.host; };
  return w;
}

// ---- one agent process on a store -------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0), S = 1000;
// db: the store. w: the world. time: { t } in ms, moved by the caller. env: the process environment the agent reads.
// Starting runs the start-up lines and both loops; the public loop makes its first round at once, as in main().
async function startAgent(db, w, time, env, hooks) {
  const h = Object.assign({ beginCrawl: () => {}, finishCrawl: () => {} }, hooks);
  const a = { logs: [], errors: [], ingested: [], timers: { public: null, watch: null }, db };
  class FakeDate extends Date { constructor(...x) { if (x.length) super(...x); else super(time.t); } static now() { return time.t; } }
  let owner = null, waiting = null;
  const timer = (f, ms) => { a.timers[owner] = { fn: f, ms }; if (waiting) { const r = waiting; waiting = null; r(); } return 0; };
  const api = BUILD(FakeDate, { env: Object.assign({}, env) }, timer, db, (m) => a.logs.push(m), (m) => a.errors.push(m), SEEDS, sanitizeHeight, keyOf, w.resolver,
    (node, o) => readSeedInfo(node, Object.assign({}, o, { fetch: w.transport })), seedsSufficient,
    RULE, assess, stepConditionRecords, clockRound, newHeightClock, stepHeightClock, heightMovementOf, VALIDATORS_SOURCE, createCandidateStore, nextCandidates,
    (c, o) => readWitnesses(c, Object.assign({}, o, { fetch: w.transport })), witnessSnapshot,
    (o) => runValidatorRound(Object.assign({}, o, { fetch: w.transport, now: () => time.t })), createWatchHistory, createFirstAgreedStore, roundLogLine, dialsEnabled,
    () => h.beginCrawl(), (source, peerlist) => a.ingested.push({ source, peers: peerlist.length }), () => h.finishCrawl(), () => {}, () => {});
  Object.assign(a, api);
  // One turn of a loop: its tick runs to the point where it arms its next timer. A loop that does not arm one has
  // stopped: that is an error here, not a wait without end.
  const turn = (name, start) => { let giveUp; return Promise.race([new Promise((res) => { owner = name; waiting = res; start(); }),
    new Promise((_, rej) => { giveUp = setTimeout(() => rej(new Error("the " + name + " loop did not arm its next round")), 5000); })]).finally(() => clearTimeout(giveUp)); };
  a.publicRound = async () => { await turn("public", a.timers.public.fn); return a.canonical(); };
  a.watchRound = async () => { await turn("watch", a.timers.watch.fn); return a.round(); };
  a.rows = () => db.query("SELECT * FROM public_node_history ORDER BY id").all();
  a.lastRow = () => db.query("SELECT * FROM public_node_history ORDER BY id DESC LIMIT 1").get();
  a.records = () => db.query("SELECT id, status, severity, started_at, resolved_at, affected_nodes, description FROM incidents ORDER BY rowid").all();
  a.startUp();
  await turn("public", a.startPublicObservationLoop);      // the first public round
  owner = "watch"; a.startValidatorWatchLoop();              // arms the first validator round
  return a;
}
const newDb = () => new Database(":memory:");
const iso = (ms) => new Date(ms).toISOString();

console.log("\n[" + TAG + "] the start");
{
  const db = newDb(), w = makeWorld(), time = { t: T0 };
  const a = await startAgent(db, w, time, {});
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  check("S1 the start opens the stores on the agent's database: incidents, public_node_history with the own-height mark, the witness candidates and the first-agreed record",
    ["incidents", "public_node_history", "dno_meta", "validator_first_agreed", "validator_first_agreed_meta"].every((t) => tables.includes(t))
    && ["own_height", "witness_clock"].every((n) => db.query("SELECT name FROM pragma_table_info('public_node_history')").all().some((c) => c.name === n)) && a.ownSince() === 0 && a.growth().available() === true, J(tables));
  check("S2 it says how many witness candidates it kept, and the public loop's first round ran at once: one row, at the observation's time",
    a.logs.includes("  Witness candidates kept: 0") && a.rows().length === 1 && a.lastRow().ts === T0 && a.observedAt() === T0, J([a.logs.slice(0, 3), a.rows().length]));
  {
    // A store whose kept candidates cannot be read (the row is not JSON): that is not "the agent keeps none".
    const broken = newDb();
    broken.run("CREATE TABLE dno_meta (key TEXT PRIMARY KEY, value TEXT)"); broken.run("INSERT INTO dno_meta (key, value) VALUES ('witness_candidates', '{not json')");
    const ab = await startAgent(broken, makeWorld(), { t: T0 }, {});
    check("S2b when the kept candidates cannot be read the start line says so, and not 'kept: 0': none is read until a validator round has counted",
      ab.logs.includes("  Witness candidates kept: not readable (none is read until a validator round has counted)") && !ab.logs.some((l) => /Witness candidates kept: \d/.test(l)) && ab.kept().candidates.length === 0, J(ab.logs.filter((l) => /Witness candidates/.test(l))));
  }
  check("S3 the loops arm themselves: the next public round a round's length after this one began, the first validator round within 10 s",
    a.timers.public.ms === 20000 && a.timers.watch.ms === 10000 && a.dials() === true, J([a.timers.public.ms, a.timers.watch.ms]));
  time.t += 20 * S;
  let thrown = 0;
  const b = await startAgent(newDb(), w, time, {}, { beginCrawl: () => { if (thrown++ === 1) throw new Error("boom"); } });
  time.t += 20 * S; const failedRound = await b.publicRound().catch((e) => e);
  const afterFail = b.rows().length;
  time.t += 20 * S; if (!(failedRound instanceof Error)) await b.publicRound();
  check("S4 a public round that throws is logged, writes nothing, and the loop goes on to the next round",
    !(failedRound instanceof Error) && b.errors.some((e) => e === "[public] observation round failed: boom") && afterFail === 1 && b.rows().length === 2 && b.timers.public.ms === 20000, J([String(failedRound instanceof Error ? failedRound.message : ""), b.errors, afterFail, b.rows().length]));
  // The catalog's part of the round fails in every round after the first: the reading's steps still run.
  let crawls = 0; const tc = { t: T0 }, wc = makeWorld();
  const c = await startAgent(newDb(), wc, tc, {}, { finishCrawl: () => { if (crawls++ >= 1) throw new Error("catalog boom"); } });
  const seenC = [];
  for (let i = 1; i <= 3; i++) { tc.t += 20 * S; wc.set([1000 + 2 * i, 1000 + 2 * i, 1000 + 2 * i]); const r = await c.publicRound(); seenC.push([r.status, r.height_static_seconds, r.height_last_advanced_at, c.clock().top, c.lastRow().ts === tc.t, c.lastRow().median_block]); }
  check("S5 when the catalog's part of a round fails, it is logged and the round still steps the clock, writes its row and publishes the reading: three such rounds, three new heights",
    J(seenC) === J([1, 2, 3].map((i) => ["stable", 0, iso(T0 + i * 20 * S), 1000 + 2 * i, true, 1000 + 2 * i])) && c.rows().length === 4
    && c.errors.filter((e) => e === "[catalog] the crawl could not be finished: catalog boom").length === 3 && !c.errors.some((e) => /observation round failed/.test(e)), brief([seenC, c.errors], 700));
}

{
  const w = makeWorld(), time = { t: T0 }; w.set([1000, 1000, 1000]);
  const a = await startAgent(newDb(), w, time, {});
  time.t += 20 * S; w.set([1002, 1002, 1002]); const fresh = await a.publicRound();
  time.t += 300 * S; const still = a.canonical();
  time.t += 1 * S; const stale = a.canonical();
  check("S6 an observation that has gone stale is no reading, and nothing is said about heights from it: 300 s after the round the count and the time of the last new height are published, a second later neither is",
    fresh.height_static_seconds === 0 && fresh.height_last_advanced_at === iso(T0 + 20 * S) && still.status === "stable" && still.height_static_seconds === 0 && still.height_last_advanced_at === iso(T0 + 20 * S) && still.staleness_seconds === 300
    && stale.status === "unknown" && stale.data_quality_reason === "stale" && stale.height_static_seconds === null && stale.height_last_advanced_at === null && !/no new height|advancing/i.test(J(stale)), brief([still.status, still.height_static_seconds, stale.status, stale.height_static_seconds, stale.height_last_advanced_at]));
}

console.log("\n[" + TAG + "] one round in each mode: what is read, what is published, what is stored");
// Seven listed validators, and seed-c's own key listed too. Only 21 and 22 can stand in for a seed.
function fullWorld() {
  const w = makeWorld();
  w.validator(0x21, { h: 1000 }); w.validator(0x22, { h: 1001 });
  w.validator(0x23, { h: 2000 });                                   // answers as listed, far from the seeds
  w.validator(0x24, { up: false });                                 // does not answer
  w.validator(0x25, { names: ID(0x77) });                           // another key answers at its address
  w.validator(0x26, { publish: "https://v26.test:53550" });         // an address DNO does not read
  w.validator(0x27, { publish: "" });                               // publishes no address
  w.vals.set(K(0xa3), { key: K(0xa3), host: hostOf(SEEDS["seed-c"].url), publish: undefined, status: "2", up: true, h: 1000, own: true, names: ID(0xa3), listed: true });   // a configured seed's key
  return w;
}
{
  const db = newDb(), w = fullWorld(), time = { t: T0 };
  w.set([1000, 1001, 1002]);
  const a = await startAgent(db, w, time, {});
  const c1 = a.canonical(), row1 = a.lastRow();
  check("M1 three seeds with their own height: stable, seeds_only, and no validator is read",
    c1.status === "stable" && c1.witnesses.mode === "seeds_only" && c1.witnesses.validators === null && J(c1.witnesses.public_seeds) === J({ configured: 3, answered: 3, own_height: 3 }) && c1.agreement.median_block === 1001
    && w.asked("info") === 3 && w.requests.every((r) => SEED_NAMES.includes(r.to)) && a.witnesses() === null, brief([c1.status, c1.witnesses, w.requests]));
  check("M2 its row: the observation's time, the reading, the seeds that gave their own height (in nodes_total), each seed's own height by name, and the own-height mark",
    row1.ts === T0 && iso(row1.ts) === c1.observed_at && row1.status === "stable" && row1.data_quality === "sufficient" && row1.agreement_state === "strong" && row1.median_block === 1001 && row1.block_spread === 2
    && row1.nodes_total === 3 && row1.nodes_reachable === 3 && row1.own_height === 1 && row1.witness_clock === null && J(JSON.parse(row1.node_states).map((n) => [n.name, n.block, n.ok])) === J([["seed-a", 1000, true], ["seed-b", 1001, true], ["seed-c", 1002, true]]), brief(row1));
  check("M3 each answering seed's peerlist goes to the catalog intake under the key that answered", J(a.ingested) === J(SEED_NAMES.map((n) => ({ source: SEEDS[n].identity, peers: 2 }))), J(a.ingested));

  // The validator round: an agreed list, a known seed median, one dial per published address. Each dial takes 3 ms
  // here, so the time the list was read and the time the round ended differ.
  time.t += 5 * S; w.dial = () => { time.t += 3; };
  const r1 = await a.watchRound(), kept1 = a.kept(); w.dial = null;
  check("V1 a counted validator round names the candidates: ACTIVE, a bare http address, answered there as listed at the seeds' height; not the far one, the silent one, another key's, an https address, no address, nor a seed's key",
    r1.counted === true && r1.list.agreed === true && J(kept1.candidates.map((c) => [c.key, c.url, c.at])) === J([[K(0x21), "http://v21.test:53550", r1.roundAt], [K(0x22), "http://v22.test:53550", r1.roundAt]]), brief([r1.counted, r1.list.reason, kept1]));
  const storedRow = db.query("SELECT value FROM dno_meta WHERE key = 'witness_candidates'").get(), stored = storedRow ? JSON.parse(storedRow.value) : { candidates: [] };
  check("V2 they are written to the store with the time the list was read (the round ended later), and the first-agreed record holds the listed keys on the database",
    stored.agreed_at === r1.listAt && kept1.agreedAt === r1.listAt && r1.roundAt > r1.listAt && stored.candidates.length === 2 && db.query("SELECT COUNT(*) c FROM validator_first_agreed").get().c === 8, brief([stored, r1.listAt]));
  check("V2b the validator loop arms its next round a minute after this one began, less the time the round took", r1.roundAt - r1.listAt === 15 && a.timers.watch.ms === 60000 - 15, J([r1.roundAt - r1.listAt, a.timers.watch.ms]));
  check("V3 the round's log line is the watch's own, and nothing was written to the error log", a.logs.includes("  " + roundLogLine(r1)) && a.errors.length === 0, J(a.errors));

  // One seed with its own height; one down; one that answers without its own entry (its first peer's height is not its own).
  time.t += 15 * S; w.requests.length = 0; w.resolved.length = 0; a.ingested.length = 0;
  w.set([1010, "down", "noheight"]).vset([1009, 1012]);
  const c2 = await a.publicRound(), row2 = a.lastRow();
  check("M4 one seed height: the two candidates are read in the same round, each once, at the address that was checked, and nothing else is",
    w.asked("info", K(0x21)) === 1 && w.asked("info", K(0x22)) === 1 && w.requests.filter((r) => !SEED_NAMES.includes(r.to)).length === 2 && J(w.resolved.slice().sort()) === J(["v21.test:53550", "v22.test:53550"]), brief([w.requests, w.resolved]));
  check("M5 the reading: seed_and_validators, the median is the seed's own height, the counts, and the time of the list the candidates came from",
    c2.status === "stable" && c2.risk === "elevated" && c2.witnesses.mode === "seed_and_validators" && c2.witnesses.counted === 3 && c2.agreement.median_block === 1010
    && J(c2.witnesses.validators) === J({ read: 2, own_height: 2, counted: 2, list_agreed_at: iso(r1.listAt) }) && J(c2.witnesses.public_seeds) === J({ configured: 3, answered: 2, own_height: 1 }), brief(c2.witnesses));
  check("M6 its row is sufficient with one seed height, its median is the seed's, it keeps the highest height among the validators counted (for the replay), and a validator's peerlist never reaches the catalog intake",
    row2.data_quality === "sufficient" && row2.nodes_total === 1 && row2.nodes_reachable === 2 && row2.median_block === 1010 && row2.witness_clock === J({ max: 1012 }) && J(a.ingested.map((x) => x.source)) === J([ID(0xa1), ID(0xa3)]), brief([row2, a.ingested]));
  check("M6b nothing of a validator is kept between rounds besides the candidates: the store holds no validator's height", J(db.query("SELECT key FROM dno_meta ORDER BY key").all().map((r) => r.key).filter((k) => /witness/.test(k))) === J(["witness_candidates"])
    && !/"h"|height/.test(db.query("SELECT value FROM dno_meta WHERE key = 'witness_candidates'").get().value), J(db.query("SELECT key FROM dno_meta").all()));

  // No seed.
  time.t += 20 * S; w.requests.length = 0;
  w.set(["down", "down", "down"]).vset([1020, 1022]);
  const c3 = await a.publicRound(), row3 = a.lastRow();
  check("M7 no seed: validators_only, uncertain. The published median is the validators' upper median (1022); the count stands on the height more than half of the counted have reached (1020), starts in this round, and no arrival is claimed. The row stores no median (that column is a seed's height) and keeps the height the count stood on and the highest counted height",
    c3.status === "stable" && c3.confidence === "uncertain" && c3.witnesses.mode === "validators_only" && c3.agreement.median_block === 1022 && c3.witnesses.counted === 2 && c3.height_static_seconds === 0 && c3.height_last_advanced_at === null && c3.status_reason === "2 validators aligned, no public seed"
    && a.clock().top === 1020 && a.clock().topSince === a.observedAt() && a.clock().read === 1022
    && row3.data_quality === "sufficient" && row3.nodes_total === 0 && row3.nodes_reachable === 0 && row3.median_block === null && row3.witness_clock === J({ h: 1020, max: 1022 }), brief([c3.witnesses, c3.height_last_advanced_at, c3.status_reason, row3, a.clock()], 900));
  time.t += 20 * S; w.vset([1020, "down"]);
  const c4 = await a.publicRound(), row4 = a.lastRow();
  check("M8 one validator alone is no reading: unknown, the reason says what the validators did, and nothing is said about height movement: no seconds, no time of a last new height. The row is insufficient and keeps nothing of the validators, and the clock is as it was",
    c4.status === "unknown" && c4.witnesses.mode === "insufficient" && c4.witnesses.counted === 0 && c4.height_static_seconds === null && c4.height_last_advanced_at === null && row4.data_quality === "insufficient" && row4.status === "unknown"
    && row4.median_block === null && row4.witness_clock === null && a.clock().top === 1020 && a.clock().topSince === a.observedAt() - 20 * S
    && c4.status_reason === "Insufficient data: no public seed reported its own block height, and one validator answered as listed with its own height, where a reading needs two", brief([c4.status_reason, c4.height_static_seconds]));

  // What is never read.
  time.t += 20 * S; w.requests.length = 0;
  w.set([1030, 1031, "down"]).vset([1030, 1030]);
  const c5 = await a.publicRound();
  check("M9 two seed heights again: no validator is read, whatever the store keeps", c5.witnesses.mode === "seeds_only" && c5.witnesses.validators === null && w.requests.every((r) => SEED_NAMES.includes(r.to)) && a.witnesses() === null, brief(w.requests));
}
{
  // The store holds a candidate with a configured seed's key (kept before that seed was configured) and one at a name
  // the address check refuses.
  const db = newDb(), w = fullWorld(), time = { t: T0 };
  w.validator(0x31, { h: 1000 });
  createCandidateStore(db).save([{ key: K(0x21), url: "http://v21.test:53550", at: T0 - 60 * S }, { key: K(0xa3), url: SEEDS["seed-c"].url, at: T0 - 60 * S }, { key: K(0x31), url: "http://v31.test:53550", at: T0 - 60 * S }], T0 - 70 * S);
  w.refused.add("v31.test"); w.set([1000, "down", "down"]);
  const a = await startAgent(db, w, time, {});
  const c = a.canonical();
  check("M10 a kept candidate with a seed's key is not read, and one whose address is refused is not requested: the seed's address gets its one seed read, the refused name none",
    a.logs.includes("  Witness candidates kept: 3") && w.asked("info", "seed-c") === 1 && w.asked("info", K(0x31)) === 0 && w.asked("info", K(0x21)) === 1
    && J(c.witnesses.validators) === J({ read: 2, own_height: 1, counted: 1, list_agreed_at: iso(T0 - 70 * S) }) && c.witnesses.mode === "seed_and_validators", brief([c.witnesses, w.requests]));
  check("M11 the round says how many validators it read", a.logs.includes("  Witnesses: 2 validators read, 1 answered as listed with a height"), J(a.logs.filter((l) => /Witnesses/.test(l))));
  {
    // The agent's own cap (2 MB) reaches the witness read: an answer over it is not read, whatever it says.
    const dbc = newDb(), wc = fullWorld(), tc = { t: T0 };
    wc.validator(0x31, { h: 1000, pad: 2 * 1024 * 1024 + 1000 });
    createCandidateStore(dbc).save([{ key: K(0x21), url: "http://v21.test:53550", at: T0 - 60 * S }, { key: K(0x31), url: "http://v31.test:53550", at: T0 - 60 * S }], T0 - 70 * S);
    wc.set([1000, "down", "down"]);
    const ac = await startAgent(dbc, wc, tc, {}), cc = ac.canonical();
    check("M11b a validator's answer larger than the agent's 2 MB is not read: it was asked once and gives no height, and the reading rests on the seed and the other validator",
      wc.asked("info", K(0x31)) === 1 && J(cc.witnesses.validators) === J({ read: 2, own_height: 1, counted: 1, list_agreed_at: iso(T0 - 70 * S) }) && cc.witnesses.mode === "seed_and_validators" && ac.errors.length === 0, brief([cc.witnesses, ac.errors]));
  }
  // A day and a second after their last answer as listed the candidates are not read.
  time.t = T0 - 60 * S + RULE.candidateMaxAgeMs; w.requests.length = 0;
  const still = await a.publicRound();
  time.t += 1 * S; w.requests.length = 0;
  const gone = await a.publicRound();
  check("M12 a candidate is read up to 24 h after its last answer as listed, and not after: then the reading is unknown, in the words used when no validator is read",
    still.witnesses.mode === "seed_and_validators" && gone.status === "unknown" && gone.witnesses.validators === null && w.requests.every((r) => SEED_NAMES.includes(r.to))
    && gone.status_reason === "Insufficient data: fewer than 2 public nodes answered", brief([still.witnesses.mode, gone.status_reason, w.requests]));
}
{
  // The switch: VALIDATOR_WATCH_DIALS=0 stops the witness reads and the watch's dials; the list is still read.
  const db = newDb(), w = fullWorld(), time = { t: T0 };
  createCandidateStore(db).save([{ key: K(0x21), url: "http://v21.test:53550", at: T0 - 60 * S }, { key: K(0x22), url: "http://v22.test:53550", at: T0 - 60 * S }], T0 - 70 * S);
  w.set([1000, "down", "down"]);
  const a = await startAgent(db, w, time, { VALIDATOR_WATCH_DIALS: "0" });
  const c = a.canonical();
  time.t += 5 * S; w.set([1000, 1001, 1002]); await a.publicRound(); w.requests.length = 0;
  const r = await a.watchRound();
  check("M13 with the dials switched off no validator is read in a public round (unknown, as before 1.2) and none is dialed by the watch, which still reads the list; the kept candidates stay",
    a.dials() === false && c.status === "unknown" && c.witnesses.validators === null && c.status_reason === "Insufficient data: fewer than 2 public nodes answered"
    && r.list.agreed === true && r.counted === false && w.asked("getValidators") === 3 && w.requests.every((x) => SEED_NAMES.includes(x.to)) && a.kept().candidates.length === 2, brief([c.status_reason, r.counted, w.requests]));
}

console.log("\n[" + TAG + "] a fault in DNO's own read is not an answer of a validator");
{
  const db = newDb(), w = fullWorld(), time = { t: T0 };
  w.set([1000, 1001, 1002]);
  const a = await startAgent(db, w, time, {});
  time.t += 5 * S; const r1 = await a.watchRound(), kept1 = J(a.kept());
  const isValidator = (u) => /^v[0-9a-f]+\.test$/.test(u.hostname);
  // One seed height; the candidates' reads end in an internal error inside DNO.
  time.t += 15 * S; w.set([1010, "down", "down"]).vset([1009, 1012]);
  w.fault = (u, m) => m === "GET" && isValidator(u);
  const c = await a.publicRound(), row = a.lastRow();
  check("X1 the witness reads end in an internal error: no validator is counted, and the reading does not say that none answered. It is unknown in the words used when no validator is read, the fault is in the error log, and the row keeps nothing of them",
    c.status === "unknown" && c.witnesses.mode === "insufficient" && c.witnesses.validators === null && c.status_reason === "Insufficient data: fewer than 2 public nodes answered" && a.witnesses() === null
    && a.errors.filter((e) => e === "[witnesses] 2 of 2 validator reads ended in an internal error (a fault in DNO's own read): no validator is counted in this round").length === 1 && !a.logs.some((l) => /Witnesses: /.test(l))
    && row.witness_clock === null && row.data_quality === "insufficient", brief([c.status_reason, c.witnesses, a.errors, row.witness_clock], 700));
  // The validator round: every dial ends so.
  time.t += 40 * S; w.set([1020, 1021, 1022]); w.fault = null; await a.publicRound(); a.errors.length = 0; a.logs.length = 0;
  w.fault = (u, m) => m === "GET" && isValidator(u);
  const r2 = await a.watchRound();
  check("X2 the validator round's dials end in an internal error: the round has no outcome and renews no candidate (the kept ones stand), its log line and the error log say 'internal error'",
    r1.counted === true && r2.faults.dials > 0 && r2.faults.list === 0 && r2.outcomes === null && r2.counted === false && r2.witnessFacts === null && J(a.kept()) === kept1
    && a.logs.some((l) => /dials? ended in an internal error \(a fault in DNO's own read\): no counts for this round/.test(l)) && a.errors.length === 1 && a.errors[0] === "[validators] " + r2.faults.dials + " reads of this round ended in an internal error (a fault in DNO's own read)",
    brief([r2.faults, r2.counted, a.kept().candidates.length, a.logs, a.errors], 900));
  // The list read of one seed ends so while the two others agree: the list stands, and the fault is still logged as one.
  time.t += 60 * S; w.fault = null; await a.publicRound(); a.errors.length = 0;
  w.fault = (u, m) => m === "POST" && u.hostname === "seed-c.test";
  const r3 = await a.watchRound();
  check("X3 one seed's list read ends in an internal error while two seeds agree: the round counts as before, and the fault goes to the error log",
    r3.list.agreed === true && r3.counted === true && r3.faults.list === 1 && r3.faults.dials === 0 && a.errors.length === 1 && a.errors[0] === "[validators] 1 read of this round ended in an internal error (a fault in DNO's own read)", brief([r3.faults, a.errors]));
  w.fault = null;
}

console.log("\n[" + TAG + "] the validator round: who is kept, in which order, and who is asked");
{
  const db = newDb(), w = makeWorld(), time = { t: T0 };
  w.set([1000, 1000, 1000]);
  // Listed from the first list: 41 and 42 answer; 4d is listed and silent. 40 is listed later, with the lowest key.
  w.validator(0x41, {}); w.validator(0x42, {}); w.validator(0x4d, { up: false }); w.validator(0x40, { listed: false });
  const a = await startAgent(db, w, time, {});
  time.t += 5 * S; const r1 = await a.watchRound();
  time.t += 60 * S; await a.publicRound();
  w.vals.get(K(0x40)).listed = true; w.vals.get(K(0x4d)).up = true;
  const r2 = await a.watchRound();
  check("W1 order: the keys DNO has listed longest come first (the first-agreed record is given to the round), then the most counted rounds, then the key: a new low key is last",
    J(a.kept().candidates.map((c) => c.key)) === J([K(0x41), K(0x42), K(0x4d), K(0x40)]) && r2.witnessFacts.seniority === true && r1.counted && r2.counted, brief(a.kept().candidates.map((c) => c.key.slice(0, 2))));
  // The kept candidates are dialed before any other row.
  w.validator(0x10, {}); w.validator(0x11, {}); w.validator(0x12, {});
  time.t += 60 * S; await a.publicRound(); w.requests.length = 0;
  await a.watchRound();
  const dialed = w.requests.filter((r) => r.what === "info" && !SEED_NAMES.includes(r.to)).map((r) => r.to.slice(0, 2));
  check("W2 the kept candidates are dialed first, before rows with lower keys", J(dialed.slice(0, 4).sort()) === J(["40", "41", "42", "4d"]) && dialed.length === 7, J(dialed));
  // Fewer than two seed heights: the watch has no seed median, the round does not count, and the candidates stand.
  const before = J(a.kept());
  time.t += 60 * S; w.set([1001, "down", "noheight"]).vset([1001, 1001, 1001, 1001]); await a.publicRound();
  const r4 = await a.watchRound();
  check("W3 with one seed height the round is not counted (the seeds' median needs two), and the candidates stay as they were",
    r4.counted === false && r4.reference === null && r4.witnessFacts === null && J(a.kept()) === before, brief([r4.counted, r4.reference, a.kept().candidates.length]));
  // A seed whose last /info named another key is not asked for the list.
  time.t += 60 * S; w.set([1002, 1002, 1002]); w.seeds["seed-b"].names = ID(0x99); await a.publicRound(); w.requests.length = 0;
  const r5 = await a.watchRound();
  check("W4 a seed whose last /info named another key is not asked for the list; the other two still agree on it",
    w.asked("getValidators", "seed-b") === 0 && w.asked("getValidators") === 2 && r5.list.agreed === true && r5.seedErrors.find((e) => e.name === "seed-b").list === "its last /info answered with another key", brief(r5.seedErrors));
  w.seeds["seed-b"].names = ID(0xa2);
  // A counted round in which no validator answers removes nobody; one that is no longer ACTIVE leaves.
  time.t += 60 * S; await a.publicRound();
  [...w.vals.values()].forEach((v) => { v.up = false; });
  const r6 = await a.watchRound(), afterSilence = a.kept().candidates.map((c) => c.key);
  w.vals.get(K(0x42)).status = "3";
  time.t += 60 * S; await a.publicRound();
  const r7 = await a.watchRound();
  check("W5 a counted round in which no validator answers removes nobody; a key that is no longer ACTIVE on the agreed list leaves",
    r6.counted && afterSilence.length === 7 && afterSilence.includes(K(0x42)) && r7.counted && a.kept().candidates.length === 6 && !a.kept().candidates.some((c) => c.key === K(0x42)), brief([afterSilence.length, a.kept().candidates.length]));
  // A restart keeps the candidates and their order's record.
  const b = await startAgent(db, w, time, {});
  check("W6 a restart on the same store keeps the candidates and the first-agreed times", b.logs.includes("  Witness candidates kept: 6") && J(b.kept()) === J(a.kept()) && b.growth().firstAgreedAt(K(0x41)) === r1.listAt && b.growth().firstAgreedAt(K(0x40)) === r2.listAt,
    brief([b.logs.filter((l) => /kept/.test(l)), b.growth().firstAgreedAt(K(0x41)), r1.listAt]));
  // After the restart the watch has no record of its own yet: the kept candidates are still dialed before lower keys.
  [...w.vals.values()].forEach((v) => { v.up = true; }); w.validator(0x01, {}); w.validator(0x02, {}); w.requests.length = 0;
  time.t += 5 * S; const rb = await b.watchRound();
  const dialedB = w.requests.filter((r) => r.what === "info" && !SEED_NAMES.includes(r.to)).map((r) => r.to.slice(0, 2));
  // Rows that never answer are dialed starting at another row each round, so none of them is always first.
  {
    const w2 = makeWorld(), t2 = { t: T0 }; w2.set([1000, 1000, 1000]);
    w2.validator(0x71, { up: false }); w2.validator(0x72, { up: false }); w2.validator(0x73, { up: false }); w2.validator(0x7f, {});
    const c = await startAgent(newDb(), w2, t2, {}), orders = [];
    for (let i = 0; i < 4; i++) { t2.t += 60 * S; await c.publicRound(); w2.requests.length = 0; await c.watchRound(); orders.push(w2.requests.filter((r) => !SEED_NAMES.includes(r.to)).map((r) => r.to.slice(0, 2)).join(" ")); }
    check("W8 the agent gives each validator round its number: the rows that never answered are dialed starting one row later each round, and a row that answered is dialed before them from the second round on",
      J(orders) === J(["71 72 73 7f", "7f 72 73 71", "7f 73 71 72", "7f 71 72 73"]), J(orders));
  }
  check("W7 the first validator round after a restart dials the kept candidates first (the store's, not the window's), before two new rows with lower keys",
    rb.counted && J(dialedB.slice(0, 6).sort()) === J(["10", "11", "12", "40", "41", "4d"]) && J(dialedB.slice(6).sort()) === J(["01", "02"]), J(dialedB));
}

console.log("\n[" + TAG + "] the height clock over rounds, and the standstill");
// A script: one entry per public round, 20 s apart. seeds: three of height | "down" | "noheight". vals: heights of the
// kept validators, or undefined to leave them. Runs the rounds on one store, starting a new agent process at each index
// in restarts (and at index 0). Returns what each round published.
async function play(script, opts) {
  const o = Object.assign({ restarts: [], db: newDb(), validators: [0x21, 0x22, 0x23], t0: T0, env: {}, workMs: 0 }, opts);
  const w = makeWorld(), time = { t: o.t0 };
  // workMs: how long the round's own work takes between the observation and its row (the catalog's part of the round).
  const hooks = { finishCrawl: () => { time.t += o.workMs; } };
  o.validators.forEach((n) => w.validator(n, {}));
  // The kept candidates, as a counted validator round left them just before the first round here. (A script runs for
  // less than the 24 h a candidate is kept, and its seeds are too few for another counted round in the fallback rounds.)
  if (o.validators.length && !o.db.query("SELECT name FROM sqlite_master WHERE name = 'dno_meta'").get())
    createCandidateStore(o.db).save(o.validators.map((n) => ({ key: K(n), url: "http://v" + n.toString(16) + ".test:53550", at: o.t0 })), o.t0);
  const out = []; let a = null;
  for (let i = 0; i < script.length; i++) {
    const r = script[i];
    time.t = o.t0 + (r.at !== undefined ? r.at : i * 20) * S;
    w.set(r.seeds); if (r.vals) w.vset(r.vals);
    if (o.before) o.before(i, o.db, a);
    let c;
    if (a === null || o.restarts.includes(i)) { a = await startAgent(o.db, w, time, o.env, hooks); c = a.canonical(); }
    else c = await a.publicRound();
    out.push({ i, at: time.t, c, clock: a.clock(), restored: a.restored() });
  }
  return { out, agent: a, w, db: o.db };
}
// What a reader of /organism sees of a round, less the count of open condition records (their counters start again
// with the process, so a record can open or close a few rounds later after a restart).
const said = (c) => { const x = Object.assign({}, c); delete x.active_public_conditions; return J(x); };
// A restarted agent's round against the running agent's: what it published, and its clock.
const sameRound = (x, y) => said(x.c) === said(y.c) && J(x.clock) === J(y.clock);
const up = (h) => ({ seeds: [h, h, h] });
{
  // Blocks arrive for five rounds, then none for forty minutes.
  const script = [];
  for (let i = 0; i < 5; i++) script.push(up(1000 + 2 * i));
  for (let i = 0; i < 125; i++) script.push(up(1008));
  for (let i = 0; i < 12; i++) script.push(up(1010 + 2 * i));           // and then they arrive again
  const live = await play(script);
  const at = (i) => live.out[i].c, lastNew = T0 + 4 * 20 * S;
  check("C1 the first round on a new store starts the count and claims no arrival; a new height: 'Heights advancing', the time it arrived, zero seconds without one",
    at(4).status === "stable" && at(4).status_reason === "Heights advancing; public nodes aligned" && at(4).height_last_advanced_at === iso(lastNew) && at(4).height_static_seconds === 0 && at(0).height_static_seconds === 0 && at(0).height_last_advanced_at === null && at(0).status_reason === "Public nodes aligned", brief([at(0).height_static_seconds, at(4).status_reason, at(4).height_static_seconds]));
  check("C1b 'Heights advancing' is said for two rounds after a new height, and not in the third",
    at(5).status_reason === "Heights advancing; public nodes aligned" && at(5).height_static_seconds === 20 && at(6).status_reason === "Heights advancing; public nodes aligned" && at(7).status_reason === "Public nodes aligned" && at(7).height_static_seconds === 60
    && at(7).height_last_advanced_at === iso(lastNew), brief([at(5).status_reason, at(6).status_reason, at(7).status_reason]));
  check("C2 no new height for five minutes: still stable, and said from then on (not at 4 min 40 s); at 29 min 40 s still stable",
    at(18).status_reason === "Public nodes aligned" && at(19).status === "stable" && at(19).height_static_seconds === 300 && at(19).status_reason === "Public nodes aligned; no new height for 5 min" && at(93).status === "stable" && at(93).height_static_seconds === 1780, brief([at(18).status_reason, at(19).status_reason, at(93).status, at(93).height_static_seconds]));
  check("C3 at 30 minutes the reading is degraded, and says why; the limit is published",
    at(94).status === "degraded" && at(94).height_static_seconds === 1800 && at(94).status_reason === "No new height for 30 min; public nodes aligned" && at(94).height_standstill_after_seconds === 1800 && at(94).agreement.state === "strong" && at(94).active_incidents === 0,
    brief([at(94).status, at(94).status_reason]));
  const recs = live.agent.records(), text = "Public network condition observed: No new height from " + iso(lastNew).slice(0, 19).replace("T", " ") + " UTC until this record opened";
  check("C4 after three such rounds the degraded record opens, with a text anchored at both ends: when the last new height arrived, to the second, and the opening",
    recs.length === 1 && recs[0].description === text && recs[0].severity === "warning" && recs[0].affected_nodes === J(["PUBLIC_NETWORK_DEGRADED"]) && recs[0].started_at === iso(T0 + 96 * 20 * S)
    && at(95).active_public_conditions === 0 && at(96).active_public_conditions === 1 && at(96).active_incidents === 0, brief(recs));
  const back = 5 + 125;   // the first round with a new height after the standstill
  check("C4b when a new height arrives the reading is stable in that same round, and the record closes after nine rounds without the condition",
    at(back - 1).status === "degraded" && at(back).status === "stable" && at(back).status_reason === "Heights advancing; public nodes aligned" && at(back).height_static_seconds === 0
    && recs[0].resolved_at === iso(live.out[back + 8].at) && at(back + 7).active_public_conditions === 1 && at(back + 8).active_public_conditions === 0, brief([at(back).status, at(back).status_reason, recs[0].resolved_at]));
  check("C5 every row carries its round's observation time and the status that round published (the clock steps before the row is written)", J(live.agent.rows().map((r) => [r.ts, r.status])) === J(live.out.map((x) => [x.at, x.c.status])));
  // A round takes time: 1.5 s pass between the observation and its row. Nothing published may depend on it, and the
  // row still carries the observation's time, so a restart replays the rounds at the times the clock stepped on.
  const noAge = (c) => { const x = JSON.parse(said(c)); delete x.staleness_seconds; return J(x); };
  const slow = await play(script, { workMs: 1500 }), slowRe = await play(script, { workMs: 1500, restarts: [4, 60, 95] });
  let off = null;
  for (let i = 0; i < script.length && !off; i++) if (noAge(slow.out[i].c) !== noAge(live.out[i].c) || said(slowRe.out[i].c) !== said(slow.out[i].c) || slow.out[i].c.staleness_seconds !== 2) off = { round: i, slow: [slow.out[i].c.status_reason, slow.out[i].c.height_static_seconds, slow.out[i].c.staleness_seconds], live: [live.out[i].c.status_reason, live.out[i].c.height_static_seconds], restarted: [slowRe.out[i].c.status_reason, slowRe.out[i].c.height_static_seconds] };
  check("C5b when a round's own work takes 1.5 s, every round publishes the same reading, its row carries the observation's time (not the time of writing), and a restart still says what the running agent says",
    off === null && J(slow.agent.rows().map((r) => r.ts)) === J(live.out.map((x) => x.at)), brief(off, 600));

  // A restart at any point says what the agent that never restarted says, in every later round.
  const points = [1, 3, 5, 6, 50, 93, 94, 95, 96, 97, 110];
  let differ = null;
  for (const k of points) {
    const re = await play(script, { restarts: [k] });
    for (let i = k; i < script.length && !differ; i++) if (!sameRound(re.out[i], live.out[i])) differ = { restart: k, round: i, restarted: re.out[i].c.status_reason, live: live.out[i].c.status_reason, a: re.out[i].clock, b: live.out[i].clock };
    if (differ) break;
    if (k === 97 && (re.agent.records().length !== 1 || re.agent.records()[0].description !== text)) differ = { restart: k, records: re.agent.records() };
  }
  check("C6 a restart during the rise, during the standstill, at its 30th minute or after the record opened: every later round publishes what the running agent published, the clock is the same, and the open record is neither lost nor opened twice", differ === null, brief(differ, 700));
}
{
  // The modes in turn, each with a standstill of its own, and restarts in each.
  const script = [];
  for (let i = 0; i < 6; i++) script.push({ seeds: [2000 + i, 2000 + i, "down"], vals: [2000 + i, 2000 + i, 2000 + i] });
  for (let i = 0; i < 6; i++) script.push({ seeds: [2006 + i, "down", "noheight"], vals: [2006 + i, 2005 + i, 2600] });           // one seed; one validator far away
  for (let i = 0; i < 6; i++) script.push({ seeds: ["down", "down", "down"], vals: [2012 + 2 * i, 2011 + 2 * i, 2600] });          // no seed: the upper median of the three validators
  for (let i = 0; i < 100; i++) script.push({ seeds: ["down", "down", "down"], vals: [2022, 2021, 2600] });                        // and it stops
  for (let i = 0; i < 4; i++) script.push({ seeds: ["down", "noheight", "down"], vals: [2022, "down", "down"] });                  // no reading
  for (let i = 0; i < 6; i++) script.push({ seeds: [2023 + i, 2023 + i, 2023 + i] });
  const live = await play(script);
  const at = (i) => live.out[i].c;
  check("C7 beside one seed the count follows the seed, and its new heights are seen arriving; with no seed it stands on the height more than half of the counted validators have reached, moves with them, and no arrival is claimed; the far validator moves nothing",
    at(8).witnesses.mode === "seed_and_validators" && at(8).status_reason === "Heights advancing; one public seed and 2 validators aligned" && at(8).agreement.median_block === 2008
    && at(14).witnesses.mode === "validators_only" && at(14).height_static_seconds === 0 && at(14).height_last_advanced_at === null && at(14).status_reason === "2 validators aligned, no public seed" && at(14).agreement.median_block === 2016
    && live.out[14].clock.top === 2015 && live.agent.rows()[14].median_block === null && live.agent.rows()[14].witness_clock === J({ h: 2015, max: 2016 })
    && live.agent.rows()[8].median_block === 2008 && live.agent.rows()[8].witness_clock === J({ max: 2008 }), brief([at(8).status_reason, at(14).witnesses.mode, at(14).height_static_seconds, at(14).agreement.median_block, live.agent.rows()[14].witness_clock]));
  const stop = 17, deg = stop + 90;
  check("C8 validators alone standing still for 30 minutes read degraded too, counted from the round their height was first read, with no time of a last new height (none is claimed from validators alone); the rounds without a reading that follow say nothing about height movement",
    at(deg - 1).status === "stable" && at(deg).status === "degraded" && at(deg).status_reason === "No new height for 30 min; 2 validators aligned, no public seed" && at(deg).height_static_seconds === 1800 && at(deg).height_last_advanced_at === null && live.out[deg].clock.topSince === live.out[stop].at
    && [118, 119, 120, 121].every((i) => at(i).status === "unknown" && at(i).height_static_seconds === null && at(i).height_last_advanced_at === null)
    && at(122).status === "stable" && at(122).height_static_seconds === 0 && at(122).height_last_advanced_at === iso(live.out[122].at), brief([at(deg - 1).status, at(deg).status_reason, at(deg).height_last_advanced_at, at(118).height_last_advanced_at, at(122).status_reason]));
  let differ = null;
  for (const k of [2, 7, 9, 13, 15, 18, 60, deg, deg + 5, 118, 119, 121, 123]) {
    const re = await play(script, { restarts: [k] });
    for (let i = k; i < script.length && !differ; i++) if (!sameRound(re.out[i], live.out[i])) differ = { restart: k, round: i, restarted: [re.out[i].c.status_reason, re.out[i].c.height_static_seconds], live: [live.out[i].c.status_reason, live.out[i].c.height_static_seconds], a: re.out[i].clock, b: live.out[i].clock };
    if (differ) break;
  }
  check("C9 a restart in any of the modes, also in a round without a reading: the stored rounds give the clock the running agent has", differ === null, brief(differ, 900));
}
{
  // Worlds drawn at random: a chain that produces, halts and (in one world) restarts lower; three seeds and three
  // validators that follow it, drop out, stick, fall back and catch up. Each world is played once without a restart
  // and then with restarts at five points, two each.
  let seed = 20261004; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let differ = null, rounds = 0, restarts = 0; const seen = { seeds_only: 0, seed_and_validators: 0, validators_only: 0, insufficient: 0, degraded: 0, gave: 0, ended: 0 };
  for (let wi = 0; wi < 6 && !differ; wi++) {
    let head = 5000 + wi * 1000, halted = 0; const nodes = Array.from({ length: 6 }, () => ({ h: head, up: true, stuck: 0, own: true }));
    const script = [];
    for (let i = 0; i < 300; i++) {
      if (halted > 0) halted--; else { head += rnd() < 0.8 ? 2 : 1; if (rnd() < 0.012) halted = 40 + Math.floor(rnd() * 140); }
      if (wi === 3 && i === 120) { head = 40; halted = 0; nodes.forEach((x) => { x.h = 0; x.stuck = 0; }); }                       // the chain restarts lower
      if (wi === 4 && i === 59) { halted = 201; nodes.forEach((x) => { x.h = head; x.stuck = 0; x.up = true; x.own = true; }); }  // every seed reads the head, and the chain halts there
      if (wi === 4 && i === 60) nodes.forEach((x) => { x.h = head - 2000; });                                                     // then every node resyncs from far below, up to that same head
      nodes.forEach((x, j) => {
        if (wi === 4 && i >= 59 && i < 135) { if (x.h < head) x.h = Math.min(head, x.h + 15 + Math.floor(rnd() * 40)); return; }
        if (x.up ? rnd() < (j < 3 && (wi === 1 || wi === 2) ? 0.06 : 0.02) : rnd() < (j < 3 && (wi === 1 || wi === 2) ? 0.1 : 0.15)) x.up = !x.up;
        if (j < 3 && rnd() < (x.own ? 0.01 : 0.2)) x.own = !x.own;
        if (x.stuck > 0) { x.stuck--; return; }
        if (wi !== 4 && rnd() < 0.01) { x.stuck = Math.floor(rnd() * 60); if (rnd() < 0.5) x.h = Math.max(0, x.h - Math.floor(rnd() * 400)); return; }
        x.h = x.h < head - 30 ? Math.min(head, x.h + 15 + Math.floor(rnd() * 40)) : Math.max(x.h, head - (rnd() < 0.2 ? 1 : 0));
      });
      const cell = (x) => (!x.up ? "down" : x.own ? x.h : "noheight");
      script.push({ seeds: nodes.slice(0, 3).map(cell), vals: nodes.slice(3).map((x) => (x.up ? x.h : "down")) });
    }
    const live = await play(script);
    live.out.forEach((x, i) => { seen[x.c.witnesses.mode]++; if (x.c.status === "degraded" && /^No new height/.test(x.c.status_reason)) seen.degraded++; if (x.clock.gave) seen.gave++; if (i > 0 && live.out[i - 1].clock.gave && !x.clock.gave) seen.ended++; });
    rounds += script.length;
    for (const k of [7, 61, 133, 190, 241]) {
      const re = await play(script, { restarts: [k, k + 9] }); restarts += 2;
      for (let i = k; i < script.length && !differ; i++) if (!sameRound(re.out[i], live.out[i])) differ = { world: wi, restart: k, round: i, restarted: [re.out[i].c.status, re.out[i].c.status_reason, re.out[i].c.height_static_seconds], live: [live.out[i].c.status, live.out[i].c.status_reason, live.out[i].c.height_static_seconds], a: re.out[i].clock, b: live.out[i].clock };
      if (differ) break;
    }
  }
  check("C10 " + rounds.toLocaleString("en-US") + " rounds in 6 worlds drawn at random, " + restarts + " restarts: after each one every round publishes what the running agent published, and the clock is the same", differ === null && rounds === 1800, brief(differ, 900));
  if (process.env.WIRING_SEEN) console.log("  seen " + J(seen));
  check("C11 and the worlds did reach every mode, standstills that read degraded, start-overs and the end of one",
    seen.seeds_only > 600 && seen.seed_and_validators > 150 && seen.validators_only > 30 && seen.insufficient > 30 && seen.degraded > 100 && seen.gave > 20 && seen.ended > 0, J(seen));
}
{
  // The chain stands at 6000. Both seeds fall 500 blocks back and climb 10 blocks a round for more than ten minutes
  // (a resync, or a chain restarted lower: heights cannot tell), land on 6000 again, and then a block arrives.
  const script = [];
  for (let i = 0; i < 4; i++) script.push(up(5994 + 2 * i));             // 6000 is first read in round 3
  for (let i = 0; i < 3; i++) script.push(up(6000));
  for (let i = 0; i < 50; i++) script.push(up(5500 + 10 * i));           // rounds 7 to 56; the first rise below the top is round 8
  script.push(up(6000), up(6000), up(6002));                             // rounds 57, 58, 59
  const live = await play(script), at = (i) => live.out[i].c;
  const FOLLOW = "DNO has been following heights below a height it read earlier";
  check("C12 from the round everything DNO reads is far below it the last arrival is no longer claimed; while they rise below the highest height for ten minutes the count runs on and the reading is clear; then DNO follows them, and says so: uncertain with the reason, risk elevated, no arrival claimed",
    at(38).confidence === "clear" && at(38).status_reason === "Public nodes aligned; no new height for 11 min" && at(38).height_static_seconds === 700 && at(6).height_last_advanced_at === iso(live.out[3].at) && at(7).height_last_advanced_at === null && at(38).height_last_advanced_at === null
    && at(39).height_static_seconds === 0 && at(39).height_last_advanced_at === null && at(39).confidence === "uncertain" && at(39).confidence_reason === FOLLOW + ", and cannot tell why from here: a chain restarted lower, nodes catching up, and one answer far above the others look the same" && at(39).risk === "elevated"
    && at(40).status === "stable" && at(40).status_reason === "Public nodes aligned" && at(40).height_static_seconds === 0 && at(40).height_last_advanced_at === null && at(40).confidence === "uncertain"
    && at(40).risk_factors.join("|") === "following heights below a height read earlier" && at(40).summary === "All 3 public seeds answered and their reported heights agree. " + FOLLOW + ".",
    brief([at(38).status_reason, at(39).confidence_reason, at(40).status_reason, at(40).height_static_seconds, at(40).risk_factors]));
  check("C13 the round they land on the old height the following ends: that height counts from its first reading, the reading is clear again, and no time of a last new height is given (DNO did not see it arrive again); then a block arrives",
    at(56).confidence === "uncertain" && at(57).confidence === "clear" && at(57).risk === "low" && at(57).height_static_seconds === 54 * 20 && at(57).height_last_advanced_at === null && at(57).status_reason === "Public nodes aligned; no new height for 18 min" && !/following/i.test(at(57).summary)
    && at(58).height_static_seconds === 55 * 20 && at(58).height_last_advanced_at === null
    && at(59).height_static_seconds === 0 && at(59).height_last_advanced_at === iso(live.out[59].at) && at(59).status_reason === "Heights advancing; public nodes aligned", brief([at(57).confidence, at(57).height_static_seconds, at(57).status_reason, at(58).status_reason, at(59).status_reason]));
  let differ = null;
  for (const k of [20, 39, 40, 50, 57, 58, 59]) {
    const re = await play(script, { restarts: [k] });
    for (let i = k; i < script.length && !differ; i++) if (!sameRound(re.out[i], live.out[i])) differ = { restart: k, round: i, restarted: [re.out[i].c.confidence, re.out[i].c.height_static_seconds], live: [live.out[i].c.confidence, live.out[i].c.height_static_seconds], a: re.out[i].clock, b: live.out[i].clock };
    if (differ) break;
  }
  check("C14 a restart while DNO follows the lower heights, in the round it starts over or in the round they land: the same readings, the same clock", differ === null, brief(differ, 900));
}
{
  // Review 6, through the agent's own rounds: only a seed is a node. The seeds bring 6000 and stop answering. Three
  // validators stand in 940 blocks below and rise 10 blocks a round for 15 minutes (a chain restarted lower, or
  // validators that answer in turn: their height cannot tell). Then one seed answers among them and rises with them.
  const script = [];
  for (let i = 0; i < 4; i++) script.push(up(5994 + 2 * i));             // 6000 arrives in round 3
  for (let i = 4; i < 6; i++) script.push(up(6000));
  for (let i = 6; i <= 50; i++) script.push({ seeds: ["down", "down", "down"], vals: [5000 + 10 * i, 5000 + 10 * i, 4999 + 10 * i] });       // rounds 6 to 50: validators alone
  for (let i = 51; i <= 84; i++) script.push({ seeds: [5000 + 10 * i, "down", "down"], vals: [5000 + 10 * i, 5000 + 10 * i, 4999 + 10 * i] });   // one seed among them; its first rise is round 52
  const live = await play(script), at = (i) => live.out[i].c, says = (i) => at(i).summary + " | " + at(i).risk_factors.join(" | ") + " | " + at(i).confidence_reason;
  check("C15 validators alone far below the height that arrived: from their first round the arrival is no longer claimed and nothing reads 'advancing'; while they rise for 15 minutes DNO gives no height up (no run of rises, nothing says it follows lower heights) and the count runs on from the arrival",
    at(5).height_last_advanced_at === iso(live.out[3].at) && at(6).witnesses.mode === "validators_only" && at(6).height_last_advanced_at === null && at(6).status_reason === "3 validators aligned, no public seed"
    && [6, 20, 37, 50].every((i) => live.out[i].clock.gave === null && live.out[i].clock.low === null && live.out[i].clock.top === 6000 && !/following/i.test(says(i)) && at(i).height_last_advanced_at === null)
    && at(50).height_static_seconds === 47 * 20 && at(50).status === "stable" && at(50).status_reason === "3 validators aligned, no public seed; no new height for 15 min" && at(50).agreement.median_block === 5500,
    brief([at(6).status_reason, at(6).height_last_advanced_at, live.out[37].clock.gave, live.out[37].clock.low, at(50).status_reason, at(50).height_static_seconds]));
  check("C16 a seed that then answers among them is a node: ten minutes after its first rise, and not a round earlier, DNO gives the old height up, follows the lower heights and says so",
    at(51).witnesses.mode === "seed_and_validators" && live.out[51].clock.low === null && live.out[52].clock.low !== null && live.out[52].clock.low.since === live.out[52].at
    && live.out[82].clock.gave === null && !/following/i.test(says(82)) && J(live.out[83].clock.gave) === J({ top: 6000, since: live.out[3].at, at: live.out[83].at })
    && at(83).height_static_seconds === 0 && at(83).confidence === "uncertain" && at(83).risk_factors.includes("following heights below a height read earlier") && at(83).height_last_advanced_at === null,
    brief([live.out[52].clock.low, live.out[82].clock.gave, live.out[83].clock.gave, at(83).risk_factors]));
  let differ = null;
  for (const k of [6, 7, 30, 51, 52, 83, 84]) {
    const re = await play(script, { restarts: [k] });
    for (let i = k; i < script.length && !differ; i++) if (!sameRound(re.out[i], live.out[i])) differ = { restart: k, round: i, restarted: [re.out[i].c.status_reason, re.out[i].c.height_static_seconds], live: [live.out[i].c.status_reason, live.out[i].c.height_static_seconds], a: re.out[i].clock, b: live.out[i].clock };
    if (differ) break;
  }
  check("C17 a restart while validators stand in below the held height, or while the seed's run of rises is on: the same readings, the same clock", differ === null, brief(differ, 900));
}
{
  // What the replay reads.
  const script = []; for (let i = 0; i < 12; i++) script.push(up(3000));
  // (a) the stored rounds cannot be read at the first round after a restart: nothing is said, it is logged once, and the next round has them.
  const live = await play(script);
  let fail = 2;
  const re = await play(script, { restarts: [6], before: (i, db) => {
    if (i !== 6 || db.__wrapped) return; db.__wrapped = true; const q = db.query.bind(db);
    // The replay is the one read of the column the clock keeps in the rows; whatever else its query says, it fails twice here.
    db.query = (sql) => { if (/^\s*SELECT\b[^;]*\bwitness_clock\b[^;]*\bFROM public_node_history\b/.test(sql) && fail > 0) { fail--; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); } return q(sql); };
  } });
  check("R1 when the stored rounds cannot be read after a restart, nothing is said about height movement, the fault is logged once, no round is stepped, and the replay is tried again until it works: then the clock is the running agent's",
    fail === 0 && re.out[6].c.height_static_seconds === null && re.out[6].restored === false && J(re.out[6].clock) === J(newHeightClock()) && re.out[7].restored === false && re.out[7].c.height_static_seconds === null && re.out[8].restored === true && J(re.out[8].clock) === J(live.out[8].clock)
    && said(re.out[8].c) === said(live.out[8].c) && re.agent.errors.filter((e) => /could not be replayed into the height clock \(SQLITE_BUSY\)/.test(e)).length === 1, brief([re.out[6].c.height_static_seconds, re.out[7].restored, re.out[8].restored, re.agent.errors]));
  // (a2) the same with one seed and validators beside it: the rounds that could not replay still write their own row
  // in full, so that a later replay has them.
  const beside = []; for (let i = 0; i < 12; i++) beside.push({ seeds: [3000 + (i > 8 ? 2 : 0), "down", "down"], vals: [3001, 3001, 3001] });
  const liveB = await play(beside); let failB = 2;
  const reB = await play(beside, { restarts: [6], before: (i, db) => {
    if (i !== 6 || db.__wrapped) return; db.__wrapped = true; const q = db.query.bind(db);
    db.query = (sql) => { if (/^\s*SELECT\b[^;]*\bwitness_clock\b[^;]*\bFROM public_node_history\b/.test(sql) && failB > 0) { failB--; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); } return q(sql); };
  } });
  check("R1b a round whose replay failed still writes what its validators gave the clock: the rows of those rounds are whole, and from the round the replay works the restarted agent says what the running one says",
    failB === 0 && reB.out[6].restored === false && reB.out[7].restored === false && reB.out[8].restored === true && J(reB.agent.rows().map((r) => r.witness_clock)) === J(liveB.agent.rows().map((r) => r.witness_clock))
    && reB.agent.rows()[6].witness_clock === J({ max: 3001 }) && reB.agent.rows()[7].witness_clock === J({ max: 3001 }) && [8, 9, 10, 11].every((i) => sameRound(reB.out[i], liveB.out[i])) && liveB.out[8].c.height_static_seconds === 8 * 20 && liveB.out[9].c.height_static_seconds === 0 && liveB.out[9].c.height_last_advanced_at === iso(liveB.out[9].at),
    brief([reB.agent.rows().slice(5, 9).map((r) => r.witness_clock), reB.out[8].c.height_static_seconds, liveB.out[8].c.height_static_seconds, liveB.out[9].c.height_static_seconds]));
  // (b) a first round without a reading still replays.
  const quiet = script.map((r, i) => (i === 6 ? { seeds: ["down", "down", "down"], vals: ["down", "down", "down"] } : r));
  const liveQ = await play(quiet), reQ = await play(quiet, { restarts: [6] });
  check("R2 a restart whose first round has no reading still replays the stored rounds: the next round carries the count on", reQ.out[6].restored === true && reQ.out[6].c.height_static_seconds === null && reQ.out[7].c.height_static_seconds === 140 && said(reQ.out[7].c) === said(liveQ.out[7].c), brief([reQ.out[6].restored, reQ.out[7].c.height_static_seconds]));
  // (c) rows an agent before the own-height rule wrote are not replayed, nor rows older than a day.
  const db = newDb(), first = await play(script.slice(0, 6), { db });
  db.run("UPDATE public_node_history SET own_height = NULL WHERE id <= 3");
  const after = await play(script.slice(6, 8), { db, t0: T0 + 6 * 20 * S });
  check("R3 rows written before the own-height rule are not replayed: the count starts at the first row under it",
    after.agent.ownSince() === first.out[2].at + 1 && after.out[0].clock.topSince === first.out[3].at && after.out[0].c.height_static_seconds === 60, brief([after.agent.ownSince(), after.out[0].clock.topSince, after.out[0].c.height_static_seconds]));
  const day = RULE.clockRememberSeconds * S, lateAt = [];
  for (const extra of [0, 1 * S]) {
    const db2 = newDb(), old = await play(script, { db: db2 });
    const late = await play(script.slice(0, 1), { db: db2, t0: old.out[9].at + day + extra });
    lateAt.push([late.out[0].clock.topSince - T0, late.out[0].c.height_static_seconds, late.out[0].c.height_last_advanced_at, late.out[0].c.status]);
  }
  check("R4 a restart replays the last 24 hours of stored rounds and no more (a round exactly 24 h old is the oldest replayed): a standstill older than that is counted from the oldest round replayed, a lower bound",
    J(lateAt) === J([[9 * 20 * S, 86400, null, "degraded"], [10 * 20 * S, 86400 + 1 - 20, null, "degraded"]]), J(lateAt));
  // (d) every round of the day is replayed: at the 20 s cadence that is 4,320 rows, the oldest exactly 24 h before the
  // restart. A standstill of 4,320 rounds, and a restart: the count is the standstill's whole length, to the round. A
  // limit on rows one below a day of rounds would cut it 20 s short.
  const long = []; for (let i = 0; i < 4323; i++) long.push(up(7000));
  const t4 = Date.now(), liveL = await play(long), reL = await play(long, { restarts: [4320] });
  check("R4b a restart after 4,320 rounds of standstill (24 h at the 20 s cadence) replays every one of them: the count is 86,400 s as in the agent that kept running, and the readings after it are the same",
    liveL.out[4320].c.height_static_seconds === 86400 && reL.out[4320].restored === true && reL.out[4320].c.height_static_seconds === 86400 && [4320, 4321, 4322].every((i) => sameRound(reL.out[i], liveL.out[i]))
    && reL.out[4320].c.status === "degraded", brief([liveL.out[4320].c.height_static_seconds, reL.out[4320].c.height_static_seconds, reL.out[4320].restored, Date.now() - t4]));
}

console.log("\n[" + TAG + "] what a round without a reading keeps, and who can show a new height");
{
  const restartsAgree = async (script, points, opts) => {
    const live = await play(script, opts);
    for (const k of points) {
      const re = await play(script, Object.assign({}, opts, { restarts: [k] }));
      for (let i = k; i < script.length; i++) if (!sameRound(re.out[i], live.out[i])) return { restart: k, round: i, restarted: [re.out[i].c.status_reason, re.out[i].c.height_static_seconds, re.out[i].clock], live: [live.out[i].c.status_reason, live.out[i].c.height_static_seconds, live.out[i].clock] };
    }
    return null;
  };
  // (1) Two seeds rise to 1008. One goes silent; the other, alone, reaches 1018 and stands there for 40 minutes. No
  // validator is kept, so those rounds have no reading. Then the second seed answers on 1018.
  const s1 = [];
  for (let i = 0; i < 5; i++) s1.push({ seeds: [1000 + 2 * i, 1000 + 2 * i, "down"] });
  for (let i = 0; i < 5; i++) s1.push({ seeds: [1010 + 2 * i, "down", "down"] });
  for (let i = 0; i < 120; i++) s1.push({ seeds: [1018, "down", "down"] });
  for (let i = 0; i < 6; i++) s1.push({ seeds: [1018, 1018, "down"] });
  const l1 = await play(s1, { validators: [] }), a1 = (i) => l1.out[i].c, first1018 = l1.out[9].at;
  check("N1 a lone seed's heights are kept in rounds without a reading, which say nothing about heights. When the second seed answers on the height the first has shown for 40 minutes, no new height is claimed: the reading is degraded, 'No new height for 40 min', counted from the round that height was first read",
    a1(4).height_last_advanced_at === iso(l1.out[4].at) && [5, 9, 60, 129].every((i) => a1(i).status === "unknown" && a1(i).height_static_seconds === null && a1(i).height_last_advanced_at === null)
    && a1(130).status === "degraded" && a1(130).status_reason === "No new height for 40 min; public nodes aligned" && a1(130).height_static_seconds === 2420 && a1(130).height_last_advanced_at === iso(first1018)
    && l1.out[129].clock.top === 1018 && l1.out[129].clock.topSince === first1018 && l1.out[130].clock.topSince === first1018,
    brief([a1(129).status, a1(129).height_last_advanced_at, a1(130).status, a1(130).status_reason, a1(130).height_static_seconds, a1(130).height_last_advanced_at, l1.out[130].clock], 800));
  check("N1b a restart while the seed is alone, in the round the second seed returns, or after it: the rows of the rounds without a reading give the clock the running agent has", await restartsAgree(s1, [7, 9, 10, 60, 129, 130, 131], { validators: [] }) === null,
    brief(await restartsAgree(s1, [7, 9, 10, 60, 129, 130, 131], { validators: [] }), 900));

  // (2) One seed and three validators two blocks above it stand still for 40 minutes. Then the seed stops answering.
  const s2 = [];
  for (let i = 0; i < 125; i++) s2.push({ seeds: [1000, "down", "down"], vals: [1002, 1002, 1002] });
  for (let i = 0; i < 20; i++) s2.push({ seeds: ["down", "down", "down"], vals: [1002, 1002, 1002] });
  const l2 = await play(s2), a2 = (i) => l2.out[i].c, recs2 = l2.agent.records();
  check("N2 when the one seed stops answering, the validators stand two blocks above it, at a height DNO has read since the first round: the count moves to their height and is as old as that reading. No new height is claimed, the reading stays degraded, and the open record stays open",
    a2(89).status === "stable" && a2(90).status === "degraded" && a2(124).witnesses.mode === "seed_and_validators" && a2(124).status === "degraded" && a2(125).witnesses.mode === "validators_only" && a2(125).agreement.median_block === 1002
    && a2(125).status === "degraded" && a2(125).status_reason === "No new height for 41 min; 3 validators aligned, no public seed" && a2(125).height_static_seconds === 2500 && l2.out.every((x) => x.c.height_last_advanced_at === null)
    && l2.out.slice(90).every((x) => x.c.status === "degraded") && l2.out[124].clock.top === 1000 && l2.out[144].clock.top === 1002 && l2.out[144].clock.topSince === T0
    && recs2.length === 1 && recs2[0].status === "active" && a2(124).status_reason === "The seed has shown no new height for 41 min; one public seed and 3 validators aligned"
    && recs2[0].description === "Public network condition observed: No new height at the seed from " + iso(T0).slice(0, 19).replace("T", " ") + " UTC until this record opened"
    && l2.agent.rows()[124].witness_clock === J({ max: 1002 }) && l2.agent.rows()[125].witness_clock === J({ h: 1002, max: 1002 }),
    brief([a2(124).status, a2(125).status, a2(125).status_reason, a2(125).height_static_seconds, recs2, l2.agent.rows()[125].witness_clock], 900));
  check("N2b a restart at the switch, before it or after it says the same", await restartsAgree(s2, [60, 124, 125, 126, 140]) === null, brief(await restartsAgree(s2, [60, 124, 125, 126, 140]), 900));

  // (3) No seed. Three validators stand on 1000, 1000 and 1003; the third is silent for half an hour, then answers
  // again while the first misses every other round: the median of those answering moves between 1000 and 1003.
  const s3 = [];
  for (let i = 0; i < 3; i++) s3.push({ seeds: ["down", "down", "down"], vals: [1000, 1000, 1003] });
  for (let i = 0; i < 92; i++) s3.push({ seeds: ["down", "down", "down"], vals: [1000, 1000, "down"] });
  for (let i = 0; i < 12; i++) s3.push({ seeds: ["down", "down", "down"], vals: [i % 2 ? 1000 : "down", 1000, 1003] });
  const l3 = await play(s3), a3 = (i) => l3.out[i].c, recs3 = l3.agent.records();
  check("N3 no node changes its height: when another validator answers and the median of those answering is higher, the count stays on the height more than half of them stand on. No new height is claimed, the standstill stays degraded and its record stays open",
    a3(89).status === "stable" && a3(94).status === "degraded" && a3(94).agreement.median_block === 1000 && a3(95).agreement.median_block === 1003 && a3(95).status === "degraded" && a3(95).status_reason === "No new height for 31 min; 2 validators aligned, no public seed"
    && a3(95).height_static_seconds === 1900 && a3(96).agreement.median_block === 1000 && l3.out.slice(90).every((x) => x.c.status === "degraded") && l3.out.every((x) => x.c.height_last_advanced_at === null && x.clock.top === 1000 && x.clock.topSince === T0 && x.clock.gave === null)
    && recs3.length === 1 && recs3[0].status === "active" && l3.agent.rows()[95].witness_clock === J({ h: 1000, max: 1003 }),
    brief([a3(94).status, a3(95).status, a3(95).status_reason, a3(95).agreement.median_block, l3.out[95].clock, recs3], 900));
  check("N3b a restart in those rounds says the same: the stored rows give the clock what it stood on", await restartsAgree(s3, [2, 50, 95, 96, 97, 100]) === null, brief(await restartsAgree(s3, [2, 50, 95, 96, 97, 100]), 900));

  // (4) A seed goes back and forth between 980 and 981, below a top of 1000 that the third seed gave once. The second
  // stands on 990 and misses one round in 40 (validators on 985 stand in then).
  const s4 = [{ seeds: [980, 990, 1000], vals: [985, 985, 985] }];
  for (let i = 1; i < 200; i++) s4.push({ seeds: [i % 2 ? 981 : 980, i % 40 === 24 ? "down" : 990, "down"], vals: [985, 985, 985] });
  const l4 = await play(s4), a4 = (i) => l4.out[i].c;
  check("N4 a seed that goes back and forth between two heights below the top, for more than an hour: no start-over, DNO never says it follows lower heights, and the count runs from the top's first reading to degraded at 30 minutes",
    l4.out.every((x) => x.clock.gave === null && x.clock.top === 1000 && x.clock.topSince === T0) && l4.out.every((x) => !/following/i.test(J(x.c))) && a4(24).witnesses.mode === "seed_and_validators" && a4(89).status === "stable"
    && l4.out.slice(90).every((x) => x.c.status === "degraded") && a4(90).height_static_seconds === 1800 && a4(199).height_static_seconds === 3980,
    brief([a4(89).status, a4(90).status, a4(90).height_static_seconds, a4(199).status, l4.out.filter((x) => x.clock.gave !== null).length, l4.out[199].clock], 900));

  // (5) The chain stands on 5240. The host clock is set back 30 minutes after round 20.
  const s5 = [];
  for (let i = 0; i < 10; i++) s5.push({ seeds: [5222 + 2 * i, 5222 + 2 * i, "down"], at: i * 20 });
  for (let i = 10; i < 21; i++) s5.push({ seeds: [5240, 5240, "down"], at: i * 20 });
  for (let i = 21; i < 50; i++) s5.push({ seeds: [5240, 5240, "down"], at: i * 20 - 1800 });
  const l5 = await play(s5, { validators: [] }), a5 = (i) => l5.out[i].c;
  check("N5 after the host clock is set back, nothing is said about height movement while the clock is behind the count's start, and no new height is claimed",
    a5(20).height_static_seconds === 220 && l5.out.slice(21).every((x) => x.c.status === "stable" && x.c.height_static_seconds === null && x.c.height_last_advanced_at === null && x.clock.top === 5240 && x.clock.topSince === T0 + 180 * S),
    brief([a5(20).height_static_seconds, a5(21).status_reason, a5(21).height_static_seconds, a5(21).height_last_advanced_at, l5.out[21].clock], 700));
  check("N5b a restart after the clock was set back replays the stored rounds in the order they were written, not by their time: it says what the running agent says", await restartsAgree(s5, [21, 22, 23, 40], { validators: [] }) === null,
    brief(await restartsAgree(s5, [21, 22, 23, 40], { validators: [] }), 900));
}

console.log("\n[" + TAG + "] incidents that are not DNO's own condition records");
{
  const db = newDb(), w = makeWorld(), time = { t: T0 };
  w.set([1000, 1000, 1000]);
  const a = await startAgent(db, w, time, {});
  const base = a.canonical();
  a.openIncident("critical", ["CHAIN"], "Chain-level issue detected", 0);
  a.openIncident("critical", ["n1"], "Fleet reference: nodes not answering", 0);
  const withOwn = a.canonical();
  check("F1 a record about the operator's own nodes does not enter the public reading: status, risk, the count of active incidents and every word are as they were",
    base.status === "stable" && said(withOwn) === said(base) && withOwn.active_incidents === 0 && Object.keys(a.active()).length === 2, brief([withOwn.status, withOwn.active_incidents, withOwn.summary]));
  a.openIncident("warning", ["public-a"], "A public incident of another kind", 0);
  const warn = a.canonical();
  a.openIncident("info", ["public-b"], "An info-level public incident", 0);
  const warnInfo = a.canonical();
  check("F2 a public incident that is not a condition record does: a warning reads degraded with one active incident, and an info-level incident opened after it does not lower that",
    warn.status === "degraded" && warn.active_incidents === 1 && warnInfo.status === "degraded" && warnInfo.active_incidents === 2, brief([warn.status, warn.active_incidents, warnInfo.status, warnInfo.active_incidents, warnInfo.summary]));
  a.resolveIncident("public-a", 0);
  const infoOnly = a.canonical();
  a.openIncident("critical", ["public-c"], "A critical public incident", 0);
  const crit = a.canonical();
  check("F3 an info-level incident alone leaves the status stable and is said in the summary; a critical one reads unstable",
    infoOnly.status === "stable" && infoOnly.active_incidents === 1 && / 1 info-level incident active\.$/.test(infoOnly.summary) && crit.status === "unstable" && crit.active_incidents === 2, brief([infoOnly.status, infoOnly.summary, crit.status, crit.summary]));
}

console.log("\n[" + TAG + "] the condition records");
{
  // No reading for three rounds opens the visibility record; while it is open no degraded record opens; nine rounds with a reading close it.
  const script = [];
  for (let i = 0; i < 2; i++) script.push(up(4000));
  for (let i = 0; i < 4; i++) script.push({ seeds: [4000, "down", "down"], vals: ["down", "down", "down"] });
  for (let i = 0; i < 12; i++) script.push(up(4000));
  const run = await play(script), recs = run.agent.records();
  check("I1 three rounds without a reading open the visibility record with the reading's own reason; nine rounds with one close it; it is a condition record, not an incident that feeds status",
    recs.length === 1 && recs[0].affected_nodes === J(["PUBLIC_NETWORK_VISIBILITY"]) && recs[0].description === "Insufficient public visibility: one public seed reported its own block height, and no validator answered as listed with its own height."
    && recs[0].started_at === iso(run.out[4].at) && recs[0].resolved_at === iso(run.out[14].at) && recs[0].status === "resolved" && run.out[4].c.active_public_conditions === 1 && run.out[4].c.active_incidents === 0 && run.out[14].c.active_public_conditions === 0, brief(recs));
  // A restart with the record open reads it back and opens no second one.
  const re = await play(script, { restarts: [6] });
  check("I2 a restart while a record is open reads it back from the store: one record, closed once", re.agent.records().length === 1 && re.agent.records()[0].status === "resolved" && re.out[6].c.active_public_conditions === 1, brief(re.agent.records()));

  // Two seeds far apart: unstable. The record follows the reading.
  const su = [];
  for (let i = 0; i < 4; i++) su.push({ seeds: [9000 + 2 * i, 9500 + 2 * i, "down"] });
  for (let i = 4; i < 15; i++) su.push({ seeds: [9600 + 2 * i, 9600 + 2 * i, "down"] });
  const lu = await play(su, { validators: [] }), ru = lu.agent.records();
  check("I3 two seeds 500 blocks apart read unstable; after three such rounds the unstable record opens, critical, with the reading's own reason; nine rounds without the condition close it; it does not feed status",
    lu.out.slice(0, 4).every((x) => x.c.status === "unstable") && ru.length === 1 && ru[0].severity === "critical" && ru[0].affected_nodes === J(["PUBLIC_NETWORK_UNSTABLE"])
    && ru[0].description === "Public network condition observed: Significant disagreement among public node heights" && ru[0].started_at === iso(lu.out[2].at) && ru[0].resolved_at === iso(lu.out[12].at)
    && lu.out[2].c.active_public_conditions === 1 && lu.out[2].c.active_incidents === 0 && lu.out[4].c.status === "stable", brief([lu.out.slice(0, 5).map((x) => x.c.status), ru], 700));

  // The first round after a start, when it has no reading (as before 1.2, the record opens at once then). The round's
  // row is written before the records are looked at, so the record starts at the round's observation, not when the
  // round's work ended 1.5 s later.
  const wa = makeWorld(); wa.set([1000, "down", "down"]);
  const ta = { t: T0 }, fresh = await startAgent(newDb(), wa, ta, {}, { finishCrawl: () => { ta.t += 1500; } }), rf = fresh.records();
  check("I4 a first round without a reading on a new store opens the visibility record at once, from that round's observation, and says the store holds nothing earlier",
    rf.length === 1 && rf[0].description === "Insufficient public visibility: fewer than 2 public nodes answered. Continuous since earliest retained public observation; actual start may be earlier." && rf[0].started_at === iso(T0), brief(rf));
  const dbb = newDb(); await play([up(1000), up(1002), up(1004)], { db: dbb, validators: [] });
  const wb = makeWorld(); wb.set([1004, "down", "down"]);
  const tb = { t: T0 + 60 * S }, later = await startAgent(dbb, wb, tb, {}, { finishCrawl: () => { tb.t += 1500; } }), rb = later.records();
  check("I5 the same on a store that holds readings before it: the record starts at that round's observation and does not say 'since the earliest retained observation' (the store shows readings before it)",
    rb.length === 1 && rb[0].description === "Insufficient public visibility: fewer than 2 public nodes answered." && rb[0].started_at === iso(T0 + 60 * S) && later.rows().length === 4, brief(rb));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
