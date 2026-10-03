// witnesses.test.mjs — WITNESSES guard: which validators may stand in for a seed, how they are kept, and how they are read.
// Runs src/witnesses.mjs against synthetic validators (Bun.serve on loopback) with a resolver that admits loopback http
// origins only; one check uses the production resolver. The rule that turns the reads into a status is tested in
// status-rule.test.mjs; where the candidates come from, in validator-watch.test.mjs (K1 to K8).
// Run: bun src/witnesses.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { createCandidateStore, readWitnesses, witnessSnapshot, WITNESS_MAX, CANDIDATE_MAX_AGE_MS, WITNESS_LOOKUP_TIMEOUT_MS } from "./witnesses.mjs";
import { parseProbeOrigin } from "./public-safety.mjs";

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
const trap = validator("trap", () => Response.json(info(ID(0x2d), H)));
V.redirect = validator("redirect", () => new Response(null, { status: 302, headers: { location: trap.url + "/info" } }));
const c = (n, v) => ({ key: K(n), url: v.url });
const resetHits = () => Object.keys(hits).forEach((k) => (hits[k] = 0));
const read = (cands, extra) => readWitnesses(cands, Object.assign({ resolveOrigin: loopResolver, timeoutMs: 2000 }, extra));

console.log("\n[" + TAG + "] a witness read");
{
  resetHits();
  const [g, u] = await read([c(0x21, V.good), c(0x22, V.upper)]);
  eq("W1 the listed key answers and lists itself: read as listed, with its own height", [g, u], [{ key: K(0x21), asListed: true, height: H, error: null }, { key: K(0x22), asListed: true, height: H + 1, error: null }]);
  check("W2 one GET /info per candidate, nothing else", hits.good === 1 && hits.upper === 1);
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
  const [hung] = await read([c(0x21, V.good)], { resolveOrigin: () => new Promise(() => {}), lookupTimeoutMs: 150 });
  check("N4 a name lookup that does not come back within its limit: no witness, and the round goes on", hung.asListed === false && Date.now() - t0 < 1500 && hits.good === 0, (Date.now() - t0) + " ms");
  resetHits();
  const prod = await readWitnesses([c(0x21, V.good), { key: K(0x30), url: "http://10.0.0.8:53550" }, { key: K(0x31), url: "http://[::1]:53550" }, { key: K(0x32), url: "http://169.254.169.254:80" }], { timeoutMs: 500 });
  check("N5 the production resolver is the default, and it refuses loopback, private and link-local addresses", prod.every((r) => r.asListed === false) && hits.good === 0, JSON.stringify(prod));
  check("N6 the limits", WITNESS_MAX === 8 && CANDIDATE_MAX_AGE_MS === 24 * 3600 * 1000 && WITNESS_LOOKUP_TIMEOUT_MS === 3000);
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
  const snap = witnessSnapshot([{ key: K(1), asListed: true, height: H }, { key: K(2), asListed: true, height: null }, { key: K(3), asListed: false, height: null }, { key: K(4), asListed: true, height: H - 1 }], 1790000000000);
  eq("P4 the snapshot: how many were read, and the heights of those that answered as listed with one", snap, { listAgreedAt: 1790000000000, read: 4, rows: [{ key: K(1), height: H }, { key: K(4), height: H - 1 }] });
  eq("P5 a round in which none was read", witnessSnapshot([], null), { listAgreedAt: null, read: 0, rows: [] });
}

console.log("\n[" + TAG + "] the candidates, kept");
{
  const T = 1_790_000_000_000;
  const list = [{ key: K(0x51), url: "http://203.0.113.9:53550" }, { key: K(0x52), url: "http://validator.example:53550/" }];
  const kept = [{ key: K(0x51), url: "http://203.0.113.9:53550" }, { key: K(0x52), url: "http://validator.example:53550" }];
  const db = new Database(":memory:");
  db.run("CREATE TABLE dno_meta (key TEXT PRIMARY KEY, value TEXT)");
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dno-witness-"));
  db.run("INSERT INTO dno_meta (key, value) VALUES ('catalog_count_started', '1780000000000')");      // a row 7.1.1 wrote
  const s = createCandidateStore(db);
  eq("C1 a new store has none", s.load(T), { agreedAt: null, candidates: [] });
  check("C2 saved with the time their list was read, and loaded as bare origins", s.save(list, T) === true && JSON.stringify(s.load(T + 1000)) === JSON.stringify({ agreedAt: T, candidates: kept }));
  eq("C3 a restart keeps them: another store on the same database", createCandidateStore(db).load(T + 60000), { agreedAt: T, candidates: kept });
  check("C4 at most 24 h after that list was read: one millisecond more and there are none", s.load(T + CANDIDATE_MAX_AGE_MS).candidates.length === 2 && s.load(T + CANDIDATE_MAX_AGE_MS + 1).candidates.length === 0 && s.load(T + CANDIDATE_MAX_AGE_MS + 1).agreedAt === null);
  check("C5 a clock that went back (now before the list's time): none", s.load(T - 1).candidates.length === 0);
  check("C6 the other rows of dno_meta are left as they were, and the candidates are one row", db.query("SELECT value FROM dno_meta WHERE key = 'catalog_count_started'").get().value === "1780000000000" && db.query("SELECT COUNT(*) AS n FROM dno_meta").get().n === 2);
  const messy = [null, "x", { key: "0x" + K(0x53), url: "http://203.0.113.9:1" }, { key: K(0xab).toUpperCase(), url: "http://203.0.113.9:1" }, { key: "abc", url: "http://203.0.113.9:1" },
    { key: K(0x55), url: "https://203.0.113.9:1" }, { key: K(0x56), url: "http://203.0.113.9:1/info" }, { key: K(0x57), url: "http://user:pw@203.0.113.9:1" }, { key: K(0x58), url: null },
    { key: K(0x59), url: "http://203.0.113.9:1" }, { key: K(0x59), url: "http://203.0.113.10:1" }];
  s.save(messy, T + 5);
  eq("C7 what is not a 64-hex key with a bare http origin is dropped, and a key is kept once", s.load(T + 6).candidates, [{ key: K(0x59), url: "http://203.0.113.9:1" }]);
  s.save(Array.from({ length: 20 }, (_, i) => ({ key: K(0x60 + i), url: "http://203.0.113.9:" + (1000 + i) })), T + 10);
  check("C8 at most " + WITNESS_MAX + " are kept, the first of the list", s.load(T + 11).candidates.length === WITNESS_MAX && s.load(T + 11).candidates[7].key === K(0x67) && createCandidateStore(db).load(T + 11).candidates.length === WITNESS_MAX);
  s.save([], T + 20);
  eq("C9 a counted round that names none replaces the ones kept", createCandidateStore(db).load(T + 21), { agreedAt: T + 20, candidates: [] });
  check("C10 a time that is not a number saves nothing", s.save(list, undefined) === false && s.load(T + 21).candidates.length === 0);
  db.run("UPDATE dno_meta SET value = ? WHERE key = 'witness_candidates'", ["{not json"]);
  eq("C11 a stored value that is not readable: none, and nothing thrown", createCandidateStore(db).load(T + 30), { agreedAt: null, candidates: [] });
  db.run("UPDATE dno_meta SET value = ? WHERE key = 'witness_candidates'", [JSON.stringify({ agreed_at: T, candidates: [{ key: K(0x51), url: "http://203.0.113.9:1" }, { key: "<script>", url: "javascript:alert(1)" }] })]);
  eq("C12 a stored list is cleaned the same way when it is read", createCandidateStore(db).load(T + 30).candidates, [{ key: K(0x51), url: "http://203.0.113.9:1" }]);
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
  check("C17 a read-only store without the table (an agent that never ran this version): none, nothing thrown", createCandidateStore(roEmpty).load(T).candidates.length === 0);
  roEmpty.close(); rmSync(dir, { recursive: true, force: true });
  const broken = { run() { throw new Error("disk"); }, query() { throw new Error("disk"); } };
  check("C15 a store that cannot be read at start: none, nothing thrown", createCandidateStore(broken).load(T).candidates.length === 0);
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
    && fn.includes("if (!kept.candidates.length) return null;") && (AGENT.match(/await readWitnesses\(/g) || []).length === 1 && !/catalogIngestPeerlist/.test(fn));
  check("A5 its log line carries counts only", fn.includes('log("  Witnesses: " + snap.read + " validator" + (snap.read === 1 ? "" : "s") + " read, " + snap.rows.length + " answered as listed with a height");') && (fn.match(/\blog\(/g) || []).length === 1);
  const cycle = AGENT.slice(AGENT.indexOf("async function publicObservationCycle()"), AGENT.indexOf("\n}\n", AGENT.indexOf("async function publicObservationCycle()")));
  check("A6 one observation: the seeds, the witnesses and the observation time are set together, with nothing awaited in between",
    /var roundWitnesses = await readRoundWitnesses\(publicNodeResults\);\n  latestPublicNodes = publicNodeResults;\n  latestWitnesses = roundWitnesses;\n  lastPublicObservedAt = Date\.now\(\);/.test(cycle)
    && !/await/.test(cycle.slice(cycle.indexOf("latestPublicNodes = publicNodeResults;"))), cycle.slice(0, 300));
  check("A7 the height clock is given the readings the rule names (clockReadings), not the seeds' rows as such", cycle.includes("updateHeightTracker(clockResults(publicNodeResults, roundWitnesses), lastPublicObservedAt);") && AGENT.includes("return clockReadings(seeds, validators).map("));
  check("A8 the candidates are renewed only by a counted validator round, and loaded before the first public round",
    AGENT.includes("if (latestValidatorRound.witnessCandidates && witnessCandidates && !witnessCandidates.save(latestValidatorRound.witnessCandidates, latestValidatorRound.listAt))")
    && (AGENT.match(/witnessCandidates\.save\(/g) || []).length === 1 && AGENT.indexOf("witnessCandidates = createCandidateStore(sharedDb);") > 0
    && AGENT.indexOf("witnessCandidates = createCandidateStore(sharedDb);") < AGENT.indexOf("  startPublicObservationLoop();\n  startValidatorWatchLoop();"));
  check("A9 figures labelled as the seeds' stay the seeds': the catalog's height comparison and the validator watch's reference do not follow the witnesses",
    AGENT.includes("var networkHead = highestSeedHeight();") && !/heightTracker\.maxHeight;\n  var block = live/.test(AGENT)
    && /function seedMedianReference\(\) \{[\s\S]{0,400}latestPublicNodes[\s\S]{0,200}hs\.length >= 2/.test(AGENT) && !/function seedMedianReference\(\) \{[\s\S]{0,500}latestWitnesses/.test(AGENT));
}

Object.values(V).concat([trap]).forEach((v) => v.srv.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
