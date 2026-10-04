// witnesses.test.mjs — WITNESSES guard: which validators may stand in for a seed, how they are kept, and how they are read.
// Runs src/witnesses.mjs against synthetic validators (Bun.serve on loopback) with a resolver that admits loopback http
// origins only; one check uses the production resolver. The rule that turns the reads into a status is tested in
// status-rule.test.mjs; what a watch round reports about them, in validator-watch.test.mjs (K1 to K12).
// Run: bun src/witnesses.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { createCandidateStore, nextCandidates, readWitnesses, witnessSnapshot, WITNESS_MAX, CANDIDATE_MAX_AGE_MS, WITNESS_LOOKUP_TIMEOUT_MS } from "./witnesses.mjs";
import { parseProbeOrigin } from "./public-safety.mjs";
import { keyOf } from "./validator-watch.mjs";

const TAG = "WITNESSES";
const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + "  want " + JSON.stringify(want));

const K = (n) => n.toString(16).padStart(2, "0").repeat(32);          // a listed key as the watch keeps it: 64 hex, no 0x
const ID = (n) => "0x" + K(n);
// Loopback http origins only, parsed the way production parses them. Names ending in .test map to loopback, so a
// published name and the address DNO connects to can differ.
const loopResolver = async (u) => { const p = parseProbeOrigin(u); return p && p.protocol === "http:" && (p.hostname === "127.0.0.1" || p.hostname.endsWith(".test")) ? "http://127.0.0.1:" + p.port : null; };

// ---- synthetic validators ----------------------------------------------------------------------------------------
const hits = {};
function validator(name, fn) {
  hits[name] = 0;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { hits[name]++; return fn(new URL(req.url), req); } });
  return { name, srv, url: "http://127.0.0.1:" + srv.port };
}
const H = 431000;
const info = (id, height, extra) => Object.assign({ identity: id, version: "0.9.9", peerlist: [
  { identity: "0x" + "ee".repeat(32), sync: { block: H + 777 } },                    // another peer first: its height must never be used
  ...(height === null ? [] : [{ identity: id, sync: { block: height, status: "synced" } }])] }, extra || {});
const V = {
  good: validator("good", (u) => (u.pathname === "/info" ? Response.json(info(ID(0x21), H)) : new Response("nf", { status: 404 }))),
  upper: validator("upper", () => Response.json(info(ID(0x22).toUpperCase().replace("0X", "0x"), H + 1))),     // the key in another case
  other: validator("other", () => Response.json(info(ID(0x77), H))),                                         // another key answers
  noSelf: validator("noSelf", () => Response.json(info(ID(0x24), null))),                                    // lists itself nowhere
  noKey: validator("noKey", () => Response.json({ version: "0.9.9", peerlist: [{ identity: ID(0x25), sync: { block: H } }] })),   // names no key
  err: validator("err", () => new Response("down", { status: 500 })),
  junk: validator("junk", () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })),
  big: validator("big", () => new Response(JSON.stringify(info(ID(0x28), H, { pad: "x".repeat(3 * 1024 * 1024) })), { headers: { "content-type": "application/json" } })),
  slow: validator("slow", async () => { await Bun.sleep(300); return Response.json(info(ID(0x29), H)); }),
  slow2: validator("slow2", async () => { await Bun.sleep(300); return Response.json(info(ID(0x2a), H - 1)); }),
  slow3: validator("slow3", async () => { await Bun.sleep(300); return Response.json(info(ID(0x2b), H - 2)); }),
  text: validator("text", () => Response.json(info(ID(0x2c), "431000<script>"))),                            // a height that is not a number
};
V.bare = validator("bare", () => Response.json(info(K(0x2e), H + 2)));                                    // its key without 0x, in its identity and in its own entry
V.shout = validator("shout", () => Response.json(info(" 0X" + K(0x2f).toUpperCase() + " ", H + 3)));          // 0X, upper case, spaces around it
const trap = validator("trap", () => Response.json(info(ID(0x2d), H)));
V.redirect = validator("redirect", () => new Response(null, { status: 302, headers: { location: trap.url + "/info" } }));
const c = (n, v) => ({ key: K(n), url: v.url });
const resetHits = () => Object.keys(hits).forEach((k) => (hits[k] = 0));
const read = (cands, extra) => readWitnesses(cands, Object.assign({ resolveOrigin: loopResolver, timeoutMs: 2000 }, extra));
// A read that does not end is a failed check, not a suite that waits for ever: the read's result, or NEVER after ms.
const NEVER = [{ key: "", asListed: false, height: null, error: "the read did not end" }];
const within = (promise, ms) => { let timer; return Promise.race([promise, new Promise((res) => { timer = setTimeout(() => res(NEVER), ms); })]).finally(() => clearTimeout(timer)); };

console.log("\n[" + TAG + "] a witness read");
{
  resetHits();
  const [g, u] = await read([c(0x21, V.good), c(0x22, V.upper)]);
  eq("W1 the listed key answers and lists itself: read as listed, with its own height", [g, u], [{ key: K(0x21), asListed: true, height: H, error: null }, { key: K(0x22), asListed: true, height: H + 1, error: null }]);
  check("W2 one GET /info per candidate, nothing else", hits.good === 1 && hits.upper === 1);
  const [bare, shout] = await read([c(0x2e, V.bare), c(0x2f, V.shout)]);
  eq("W2b the key is compared in one form, the validator watch's: without 0x, or as 0X in upper case with spaces around it, it is the listed key, here as there",
    [bare, shout, keyOf(K(0x2e)), keyOf(" 0X" + K(0x2f).toUpperCase() + " ")], [{ key: K(0x2e), asListed: true, height: H + 2, error: null }, { key: K(0x2f), asListed: true, height: H + 3, error: null }, K(0x2e), K(0x2f)]);
  const [o] = await read([c(0x23, V.other)]);
  eq("W3 another key answers at that address: not as listed, no height", o, { key: K(0x23), asListed: false, height: null, error: null });
  const [ns] = await read([c(0x24, V.noSelf)]);
  eq("W4 the listed key answers but lists itself nowhere: as listed, and no height (the first listed peer's height is not its own)", ns, { key: K(0x24), asListed: true, height: null, error: null });
  const [nk] = await read([c(0x25, V.noKey)]);
  eq("W5 an answer that names no key is not the listed key answering, even when its peerlist holds that key", nk, { key: K(0x25), asListed: false, height: null, error: null });
  const bad = await read([c(0x26, V.err), c(0x27, V.junk), c(0x28, V.big), c(0x2e, { url: "http://127.0.0.1:1" }), c(0x2c, V.text)]);
  check("W6 an HTTP error, a body that is not JSON, a body over the cap, a closed port: no witness, nothing thrown, and the reason as a category", bad.slice(0, 4).every((r) => r.asListed === false && r.height === null)
    && bad.slice(0, 4).map((r) => r.error).join(" | ") === "HTTP 500 | invalid response | response too large | connection failed", JSON.stringify(bad));
  eq("W7 a height that is not a plain number is no height", bad[4], { key: K(0x2c), asListed: true, height: null, error: null });
  resetHits();
  const [rd] = await read([c(0x2d, V.redirect)]);
  check("W8 a redirect is not followed: the address it points to is never read", rd.asListed === false && hits.redirect === 1 && hits.trap === 0, JSON.stringify(rd) + " trap " + hits.trap);
  eq("W9 a row holds the key, whether it answered as listed, its height, and why it did not answer: no peerlist, no address, no version", Object.keys(g).sort(), ["asListed", "error", "height", "key"]);
  const faulty = await read([c(0x21, V.good)], { fetch: () => { throw new TypeError("x is not a function"); } });
  check("W10 a fault in DNO's own read is told apart from a validator that does not answer", faulty[0].error === "internal error" && faulty[0].asListed === false && rd.error === "HTTP 302");
}

console.log("\n[" + TAG + "] the address is checked at every read");
{
  resetHits();
  const named = [{ key: K(0x21), url: "http://validator-one.test:" + V.good.srv.port }];
  const [n] = await read(named);
  check("N1 the read goes to the address the resolver returned for the published name", n.asListed === true && n.height === H && hits.good === 1);
  resetHits();
  const [refused] = await read([c(0x21, V.good)], { resolveOrigin: async () => null });
  check("N2 an address the resolver refuses is not read at all", refused.asListed === false && refused.error === "address not resolved to a public http origin" && hits.good === 0);
  const [thrown] = await read([c(0x21, V.good)], { resolveOrigin: async () => { throw new Error("resolver down"); } });
  check("N3 a resolver that throws: no witness, nothing thrown", thrown.asListed === false && hits.good === 0);
  const t0 = Date.now();
  const [hung] = await within(read([c(0x21, V.good)], { resolveOrigin: () => new Promise(() => {}), lookupTimeoutMs: 150 }), 4000);
  check("N4 a name lookup that does not come back within its limit: no witness, and the round goes on", hung.asListed === false && hung.error === "address not resolved to a public http origin" && Date.now() - t0 < 1500 && hits.good === 0, (Date.now() - t0) + " ms " + hung.error);
  resetHits();
  const prod = await readWitnesses([c(0x21, V.good), { key: K(0x30), url: "http://10.0.0.8:53550" }, { key: K(0x31), url: "http://[::1]:53550" }, { key: K(0x32), url: "http://169.254.169.254:80" }], { timeoutMs: 500 });
  check("N5 the production resolver is the default, and it refuses loopback, private and link-local addresses", prod.every((r) => r.asListed === false) && hits.good === 0, JSON.stringify(prod));
  check("N6 the limits", WITNESS_MAX === 8 && CANDIDATE_MAX_AGE_MS === 24 * 3600 * 1000 && WITNESS_LOOKUP_TIMEOUT_MS === 3000);
  // The limits as a read without options gets them: a lookup that never settles, and a validator that never answers.
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });   // accepts and says nothing
  const began = Date.now();
  const [stuckLookup, stuckRead] = await Promise.all([
    within(readWitnesses([c(0x21, V.good)], { resolveOrigin: () => new Promise(() => {}) }), 9000).then((r) => ({ r: r[0], ms: Date.now() - began })),
    within(readWitnesses([{ key: K(0x21), url: "http://127.0.0.1:" + silent.port }], { resolveOrigin: loopResolver }), 9000).then((r) => ({ r: r[0], ms: Date.now() - began }))]);
  silent.stop(true);
  check("N7 with no option given, a name lookup that never settles is given up after 3 s and a read that gets no answer after 5 s", stuckLookup.r.error === "address not resolved to a public http origin" && stuckLookup.ms >= 2900 && stuckLookup.ms < 4200
    && stuckRead.r.asListed === false && stuckRead.r.error === "timeout" && stuckRead.ms >= 4900 && stuckRead.ms < 6500, JSON.stringify([stuckLookup, stuckRead]));
}

console.log("\n[" + TAG + "] one round's reads");
{
  resetHits();
  const t0 = Date.now();
  const rows = await read([c(0x29, V.slow), c(0x2a, V.slow2), c(0x2b, V.slow3)]);
  const took = Date.now() - t0;
  check("P1 the candidates are read at the same time: three answers of 300 ms each in well under 900 ms", rows.every((r) => r.asListed) && took < 750, took + " ms");
  resetHits();
  const many = Array.from({ length: 12 }, (_, i) => ({ key: K(0x40 + i), url: V.good.url }));
  const got = await read(many);
  check("P2 at most " + WITNESS_MAX + " validators are read in a round, the first of the list", got.length === WITNESS_MAX && hits.good === WITNESS_MAX && got[0].key === K(0x40) && got[7].key === K(0x47));
  check("P3 no candidate: nothing read", (await read([])).length === 0 && (await read(null)).length === 0 && (await read(undefined)).length === 0);
  const snap = witnessSnapshot([{ key: K(1), asListed: true, height: H }, { key: K(2), asListed: true, height: null }, { key: K(3), asListed: false, height: null }, { key: K(4), asListed: true, height: H - 1 }, { key: K(5), asListed: false, height: H + 3 }], 1790000000000);
  eq("P4 the snapshot: how many were read, and the heights of those that answered as listed with one (a height on a row that did not answer as listed is not taken)", snap, { listAgreedAt: 1790000000000, read: 5, rows: [{ key: K(1), height: H }, { key: K(4), height: H - 1 }] });
  eq("P5 a round in which none was read", witnessSnapshot([], null), { listAgreedAt: null, read: 0, rows: [] });
}

console.log("\n[" + TAG + "] the candidates, kept");
{
  const T = 1_790_000_000_000;
  const list = [{ key: K(0x51), url: "http://203.0.113.9:53550" }, { key: K(0x52), url: "http://validator.example:53550/" }];
  const kept = [{ key: K(0x51), url: "http://203.0.113.9:53550", at: T }, { key: K(0x52), url: "http://validator.example:53550", at: T }];
  const db = new Database(":memory:");
  db.run("CREATE TABLE dno_meta (key TEXT PRIMARY KEY, value TEXT)");
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dno-witness-"));
  db.run("INSERT INTO dno_meta (key, value) VALUES ('catalog_count_started', '1780000000000')");      // a row 7.1.1 wrote
  const s = createCandidateStore(db);
  eq("C1 a new store has none", s.load(T), { agreedAt: null, candidates: [] });
  check("C2 saved with the time their list was read, and loaded as bare origins, each with the time of its last answer as listed (the list's time when it carries none)", s.save(list, T) === true && JSON.stringify(s.load(T + 1000)) === JSON.stringify({ agreedAt: T, candidates: kept }));
  eq("C3 a restart keeps them: another store on the same database", createCandidateStore(db).load(T + 60000), { agreedAt: T, candidates: kept });
  check("C4 a candidate is kept 24 h after its last answer as listed: one millisecond more and it is gone", s.load(T + CANDIDATE_MAX_AGE_MS).candidates.length === 2 && s.load(T + CANDIDATE_MAX_AGE_MS + 1).candidates.length === 0 && s.load(T + CANDIDATE_MAX_AGE_MS + 1).agreedAt === null);
  check("C5 a clock that went back (now before the list's time): none", s.load(T - 1).candidates.length === 0);
  check("C6 the other rows of dno_meta are left as they were, and the candidates are one row", db.query("SELECT value FROM dno_meta WHERE key = 'catalog_count_started'").get().value === "1780000000000" && db.query("SELECT COUNT(*) AS n FROM dno_meta").get().n === 2);
  const messy = [null, "x", { key: "0x" + K(0x53), url: "http://203.0.113.9:1" }, { key: K(0xab).toUpperCase(), url: "http://203.0.113.9:1" }, { key: "abc", url: "http://203.0.113.9:1" },
    { key: K(0x55), url: "https://203.0.113.9:1" }, { key: K(0x56), url: "http://203.0.113.9:1/info" }, { key: K(0x57), url: "http://user:pw@203.0.113.9:1" }, { key: K(0x58), url: null },
    { key: K(0x59), url: "http://203.0.113.9:1" }, { key: K(0x59), url: "http://203.0.113.10:1" }];
  s.save(messy, T + 5);
  eq("C7 what is not a 64-hex key with a bare http origin is dropped, and a key is kept once", s.load(T + 6).candidates, [{ key: K(0x59), url: "http://203.0.113.9:1", at: T + 5 }]);
  s.save(Array.from({ length: 20 }, (_, i) => ({ key: K(0x60 + i), url: "http://203.0.113.9:" + (1000 + i) })), T + 10);
  check("C8 at most " + WITNESS_MAX + " are kept, the first of the list", s.load(T + 11).candidates.length === WITNESS_MAX && s.load(T + 11).candidates[7].key === K(0x67) && createCandidateStore(db).load(T + 11).candidates.length === WITNESS_MAX);
  s.save([{ key: K(0x70), url: "http://203.0.113.9:7", at: T + 12 }, { key: K(0x71), url: "http://203.0.113.9:8", at: T + 20 - CANDIDATE_MAX_AGE_MS }], T + 20);
  eq("C9 each is aged by its own last answer: one of two saved together is gone a millisecond later", [s.load(T + 20).candidates.map((x) => x.key), s.load(T + 21).candidates.map((x) => x.key), createCandidateStore(db).load(T + 21).candidates[0].at], [[K(0x70), K(0x71)], [K(0x70)], T + 12]);
  s.save([], T + 20);
  eq("C9b an empty list saved is an empty list: who is kept is decided before the save (nextCandidates)", createCandidateStore(db).load(T + 21), { agreedAt: null, candidates: [] });
  check("C10 a time that is not a number saves nothing", s.save(list, undefined) === false && s.load(T + 21).candidates.length === 0);
  db.run("UPDATE dno_meta SET value = ? WHERE key = 'witness_candidates'", ["{not json"]);
  eq("C11 a stored value that is not readable: none, and nothing thrown", createCandidateStore(db).load(T + 30), { agreedAt: null, candidates: [] });
  db.run("UPDATE dno_meta SET value = ? WHERE key = 'witness_candidates'", [JSON.stringify({ agreed_at: T, candidates: [{ key: K(0x51), url: "http://203.0.113.9:1" }, { key: "<script>", url: "javascript:alert(1)" }] })]);
  eq("C12 a stored list is cleaned the same way when it is read; a row an earlier build stored without its time takes the list's", createCandidateStore(db).load(T + 30).candidates, [{ key: K(0x51), url: "http://203.0.113.9:1", at: T }]);
  check("C12b a store that was read says so; one that could not be read says that, which is not the same as keeping none", createCandidateStore(db).readable === true && createCandidateStore(null).readable === true
    && createCandidateStore({ run() { throw new Error("disk"); }, query() { throw new Error("disk"); } }).readable === false);
  const mem = createCandidateStore(null);
  check("C13 without a store they are kept in memory", mem.save(list, T) === true && mem.load(T + 1).candidates.length === 2 && createCandidateStore(null).load(T + 1).candidates.length === 0);
  const closed = new Database(":memory:"); const cs = createCandidateStore(closed); closed.close();
  check("C14 a store that cannot be written: save says so, and this process still has them", cs.save(list, T) === false && cs.load(T + 1).candidates.length === 2);
  // The pre-restart check opens the agent's store read-only: it reads what the agent kept and can write nothing.
  const file = join(dir, "store.db");
  const rw = new Database(file); createCandidateStore(rw).save(list, T); rw.close();
  const ro = new Database(file, { readonly: true }), roStore = createCandidateStore(ro);
  check("C16 a store opened read-only: the kept candidates are read, and a save changes nothing on disk", roStore.load(T + 1).candidates.length === 2 && roStore.save([], T + 5) === false
    && (() => { ro.close(); const again = new Database(file, { readonly: true }); const n = createCandidateStore(again).load(T + 6).candidates.length; again.close(); return n; })() === 2);
  const empty = join(dir, "empty.db"); new Database(empty).close();
  const roEmpty = new Database(empty, { readonly: true });
  check("C17 a read-only store without the table (an agent that never ran this version): none, nothing thrown, and it counts as read", createCandidateStore(roEmpty).load(T).candidates.length === 0 && createCandidateStore(roEmpty).readable === true);
  roEmpty.close(); rmSync(dir, { recursive: true, force: true });
  const broken = { run() { throw new Error("disk"); }, query() { throw new Error("disk"); } };
  check("C15 a store that cannot be read at start: none, nothing thrown", createCandidateStore(broken).load(T).candidates.length === 0);
}

console.log("\n[" + TAG + "] who is kept after a counted round (nextCandidates)");
{
  const T = 1_790_000_000_000, HOUR = 3600000, U = (n) => "http://203.0.113.9:" + n;
  // One row of a round's facts: an ACTIVE key that is not a seed's.
  const row = (n, o) => Object.assign({ key: K(n), addr: "origin", origin: U(n), confirmed: false, since: 1000, rounds: 0 }, o || {});
  const facts = (rows, at) => ({ at: at === undefined ? T : at, seniority: true, rows });
  const keys = (list) => list.map((x) => x.key.slice(0, 2)).join(" ");
  const kept = [{ key: K(0x31), url: U(0x31), at: T - HOUR }, { key: K(0x32), url: U(0x32), at: T - 2 * HOUR }];
  eq("M1 a key that answered as listed at the seeds' height in this round joins, with the address two seeds give for it and this round's time",
    nextCandidates([], facts([row(0x31, { confirmed: true }), row(0x32)])), [{ key: K(0x31), url: U(0x31), at: T }]);
  eq("M2 a kept key that did not answer in this round stays, with the time of its last answer", nextCandidates(kept, facts([row(0x31), row(0x32, { confirmed: true })])),
    [{ key: K(0x31), url: U(0x31), at: T - HOUR }, { key: K(0x32), url: U(0x32), at: T }]);
  eq("M3 a counted round in which nobody answers removes nobody: the first round after a restart, a reference far off", nextCandidates(kept, facts([row(0x31), row(0x32), row(0x33)])), kept);
  check("M4 it leaves on evidence: not ACTIVE on the agreed list any more (or a seed's key now)", keys(nextCandidates(kept, facts([row(0x32)]))) === "32");
  check("M5 it leaves when it publishes no address, or one DNO does not read", keys(nextCandidates(kept, facts([row(0x31, { addr: "none", origin: null }), row(0x32, { addr: "other", origin: null })]))) === "");
  check("M6 it leaves when two seeds give another address for it, and joins again once it answers there", keys(nextCandidates(kept, facts([row(0x31, { origin: U(0x99) }), row(0x32)]))) === "32"
    && JSON.stringify(nextCandidates(kept, facts([row(0x31, { origin: U(0x99), confirmed: true }), row(0x32)]))[0]) === JSON.stringify({ key: K(0x31), url: U(0x99), at: T }));
  eq("M7 seeds that give different addresses for it are no evidence against it: it stays at the address it was confirmed at", nextCandidates(kept, facts([row(0x31, { addr: "disputed", origin: null }), row(0x32, { addr: "disputed", origin: null })])), kept);
  check("M8 it leaves 24 h after its last answer as listed, to the millisecond", keys(nextCandidates([{ key: K(0x31), url: U(0x31), at: T - CANDIDATE_MAX_AGE_MS }, { key: K(0x32), url: U(0x32), at: T - CANDIDATE_MAX_AGE_MS - 1 }], facts([row(0x31), row(0x32)]))) === "31");
  check("M9 a confirmed row needs an address: one whose address is disputed, missing or unread does not join", nextCandidates([], facts([row(0x31, { confirmed: true, addr: "disputed", origin: null }), row(0x32, { confirmed: true, addr: "none", origin: null }), row(0x33, { confirmed: true, addr: "other", origin: null })])).length === 0);
  // order: how long DNO has listed the key, then counted rounds in the window, then key
  const many = [row(0x41, { confirmed: true, since: 300, rounds: 9 }), row(0x42, { confirmed: true, since: 100, rounds: 1 }), row(0x43, { confirmed: true, since: 100, rounds: 5 }), row(0x44, { confirmed: true, since: null, rounds: 60 }), row(0x45, { confirmed: true, since: 100, rounds: 5 })];
  check("M10 the keys DNO has listed longest come first, then the most counted rounds in the window, then key order; a key with no known first list comes last", keys(nextCandidates([], facts(many))) === "43 45 42 41 44");
  const senior = Array.from({ length: 8 }, (_, i) => ({ key: K(0x50 + i), url: U(0x50 + i), at: T - HOUR }));
  const newer = Array.from({ length: 8 }, (_, i) => row(0x10 + i, { confirmed: true, since: 5000, rounds: 60 }));
  check("M11 at most " + WITNESS_MAX + ": eight newer keys that answer in every round, with lower keys, do not take the place of eight older ones that missed this round",
    keys(nextCandidates(senior, facts(senior.map((c) => row(parseInt(c.key.slice(0, 2), 16), { since: 100 })).concat(newer)))) === "50 51 52 53 54 55 56 57" && WITNESS_MAX === 8);
  check("M12 when an older key leaves, the next in order takes its place", keys(nextCandidates(senior, facts(senior.slice(1).map((c) => row(parseInt(c.key.slice(0, 2), 16), { since: 100 })).concat(newer)))) === "51 52 53 54 55 56 57 10");
  check("M13 no order can be given (the first-agreed record is unavailable): nothing is renewed, the kept ones stand", nextCandidates(kept, Object.assign(facts([row(0x33, { confirmed: true })]), { seniority: false })) === null
    && nextCandidates(kept, null) === null && nextCandidates(kept, { rows: [] }) === null);
  check("M14 with no first list known for any key the order is counted rounds, then key", keys(nextCandidates([], facts([row(0x41, { confirmed: true, since: null, rounds: 1 }), row(0x42, { confirmed: true, since: null, rounds: 3 }), row(0x40, { confirmed: true, since: null, rounds: 1 })]))) === "42 40 41");
  // A week of rounds: one bad round in the middle, a restart, and a dead validator.
  let list = [], t = T;
  const day = (confirm, hours = 24) => { for (let i = 0; i < hours; i++) { t += HOUR; list = nextCandidates(list, facts([row(0x61, { confirmed: confirm(0x61, i) }), row(0x62, { confirmed: confirm(0x62, i) }), row(0x63, { confirmed: confirm(0x63, i) })], t)); } };
  day(() => true);
  day((n, i) => i !== 5);                       // one round in which nobody answered
  const afterBad = keys(list);
  day((n) => n !== 0x63);                       // 0x63 stops answering: 24 rounds, the last of them 24 h after its last answer
  const atDay = keys(list);
  day((n) => n !== 0x63, 1);
  check("M15 over days of rounds: one round without answers changes nothing; a validator that stops answering is kept for 24 hours and gone in the round after", afterBad === "61 62 63" && atDay === "61 62 63" && keys(list) === "61 62"
    && keys(nextCandidates([{ key: K(0x63), url: U(0x63), at: t - 23 * HOUR }], facts([row(0x63)], t))) === "63", keys(list));
}

console.log("\n[" + TAG + "] the sources");
{
  const SRC = readFileSync(join(__dir, "witnesses.mjs"), "utf8"), AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8");
  const imports = [...SRC.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort().join();
  check("A1 witnesses.mjs reads only through readSeedInfo: no fetch, no capped read of its own", /await readSeedInfo\(\{ url: origin, identity: "0x" \+ c\.key \}/.test(SRC) && !/cappedJson|nativeFetch|readJsonCapped|\bfetch\(/.test(SRC)
    && imports === "./public-safety.mjs,./seed-read.mjs,./status-rule.mjs", imports);
  check("A2 a witness counts only when the answer named the listed key, and its height only from its own entry", SRC.includes("if (!r.ok) row.error = r.error;\n    else if (r.identityMatch === true) {") && SRC.includes('if (r.height_source === "self") row.height = r.block;') && (SRC.match(/row\.asListed = true;/g) || []).length === 1 && (SRC.match(/row\.height = /g) || []).length === 1);
  check("A3 nothing from a witness read reaches the catalog or the observation tables", !/catalog|discoveredPeers|node_observations|peerlist:/.test(SRC.replace(/^\/\/.*$/gm, "")));
  const fn = AGENT.slice(AGENT.indexOf("async function readRoundWitnesses("), AGENT.indexOf("\n}\n", AGENT.indexOf("async function readRoundWitnesses(")));
  check("A4 the agent reads witnesses only when the dials are on, fewer than two seeds gave their own height, and candidates are kept",
    fn.includes("if (!VALIDATOR_WATCH_DIALS || !witnessCandidates) return null;") && fn.includes("if (publicNodeResults.filter(function(n) { return ownHeight(n) !== null; }).length >= 2) return null;")
    && fn.includes("var candidates = kept.candidates.filter(function(c) { return !SEED_KEYS.has(c.key); });\n  if (!candidates.length) return null;") && fn.includes("await readWitnesses(candidates, {")
    && (AGENT.match(/await readWitnesses\(/g) || []).length === 1 && !/catalogIngestPeerlist/.test(fn));
  check("A4b a configured seed's key is never read as a witness: the keys are compared in the form the candidates are kept in", /const SEED_KEYS = new Set\(Object\.keys\(PUBLIC_NODES\)\.map\(function\(n\) \{ return keyOf\(PUBLIC_NODES\[n\]\.identity\); \}\)\.filter\(Boolean\)\);/.test(AGENT)
    && keyOf("0x" + "AB".repeat(32)) === "ab".repeat(32) && createCandidateStore(null).save([{ key: "ab".repeat(32), url: "http://203.0.113.9:53550" }], 1) === true);
  check("A5 its log line carries counts only", fn.includes('log("  Witnesses: " + snap.read + " validator" + (snap.read === 1 ? "" : "s") + " read, " + snap.rows.length + " answered as listed with a height");') && (fn.match(/\blog\(/g) || []).length === 1);
  const cycle = AGENT.slice(AGENT.indexOf("async function publicObservationCycle()"), AGENT.indexOf("\n}\n", AGENT.indexOf("async function publicObservationCycle()")));
  check("A6 one observation: the seeds, the witnesses and the observation time are set together, with nothing awaited in between",
    /var roundWitnesses = await readRoundWitnesses\(publicNodeResults\);\n  latestPublicNodes = publicNodeResults;\n  latestWitnesses = roundWitnesses;\n  lastPublicObservedAt = Date\.now\(\);/.test(cycle)
    && !/await/.test(cycle.slice(cycle.indexOf("latestPublicNodes = publicNodeResults;"))), cycle.slice(0, 300));
  // What the agent does with the candidates and with the clock each round is run, not read, in round-wiring.test.mjs.
  check("A8 the candidates are loaded before the first public round", AGENT.indexOf("witnessCandidates = createCandidateStore(sharedDb);") > 0
    && AGENT.indexOf("witnessCandidates = createCandidateStore(sharedDb);") < AGENT.indexOf("  startPublicObservationLoop();\n  startValidatorWatchLoop();"));
  check("A9 figures labelled as the seeds' stay the seeds': the catalog's height comparison and the validator watch's reference do not follow the witnesses",
    AGENT.includes("var networkHead = highestSeedHeight();") && !/heightTracker\.maxHeight;\n  var block = live/.test(AGENT)
    && /function seedMedianReference\(\) \{[\s\S]{0,400}latestPublicNodes[\s\S]{0,200}hs\.length >= 2/.test(AGENT) && !/function seedMedianReference\(\) \{[\s\S]{0,500}latestWitnesses/.test(AGENT));
}

Object.values(V).concat([trap]).forEach((v) => v.srv.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
