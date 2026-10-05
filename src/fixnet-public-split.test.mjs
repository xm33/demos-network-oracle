// fixnet-public-split.test.mjs — FIXNET_PUBLIC_SPLIT guard: the fixnet probe neither keeps nor dials an identity the
// public seeds' peerlists list.
// On 2026-10-02 the "Fixnet probe" table on /reference held 21 public-testnet identities, and DNO dialed them: one of the
// operator's own nodes is on the public testnet, so its peerlist is the public one. The table said "This is not the
// public testnet catalog", and the catalog says its identities are never dialed.
// Runs the agent's own publicListedIdentities(), discoverFixnetValidators() and probeDiscoveredFixnetNodes() (extracted
// from agent.mjs) against an in-memory store and a loopback endpoint.
// Run: bun src/fixnet-public-split.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { isValidIdentity, sanitizeHeight, probeErrorCategory, mapWithConcurrency, cappedJson } from "./public-safety.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "FIXNET_PUBLIC_SPLIT";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const extract = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n}\n", i) + 3); };
const ID = (b) => "0x" + b.repeat(32);

// A fixnet endpoint that answers /info, counting its hits. The test's resolver admits loopback, as production's does not.
let hits = 0;
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { hits++; return Response.json({ identity: ID("f1"), peerlist: [{ identity: ID("f1"), sync: { block: 77 } }] }); } });
const ORIGIN = "http://127.0.0.1:" + srv.port;

function agent(resolve, category) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE fixnet_validator_discoveries (identity TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, connection TEXT, online INTEGER, last_block INTEGER, last_probed_at INTEGER, last_latency_ms INTEGER, probe_ok INTEGER)");
  db.run("CREATE TABLE validator_discoveries (identity TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, public_listed_since INTEGER)");
  const logs = [];
  const code = "var publicPeerlistRead = false, latestPublicListed = new Set(), catalogPending = new Map(), FIXNET_IDENTITIES = { '" + ID("cd") + "': 'fleet-n3' };\n"
    + "function isExcludedFromDiscovered(id) { return id === '" + ID("a2") + "'; }\n"
    + extract("function publicListedIdentities() {") + extract("function discoverFixnetValidators(anchorInfoData) {") + extract("async function probeDiscoveredFixnetNodes() {")
    + "\nreturn { discover: discoverFixnetValidators, probe: probeDiscoveredFixnetNodes, listed: publicListedIdentities,"
    + " crawl: function(ids, read) { latestPublicListed = new Set(ids); if (read) publicPeerlistRead = true; }, wait: function(id) { catalogPending.set(id, { sources: ['seed'] }); } };";
  const api = new Function("sharedDb", "isValidIdentity", "sanitizeHeight", "log", "logError", "resolvePublicProbeOrigin", "cappedJson", "INFO_BODY_MAX_BYTES", "probeErrorCategory", "mapWithConcurrency", code)(
    db, isValidIdentity, sanitizeHeight, (m) => logs.push(m), (m) => logs.push(m), resolve || (async (u) => (String(u).startsWith("http://127.0.0.1:") ? u : null)), cappedJson, 2 * 1024 * 1024, category || probeErrorCategory, mapWithConcurrency);
  return Object.assign(api, { db, logs, kept: () => db.query("SELECT identity FROM fixnet_validator_discoveries ORDER BY identity").all().map((r) => r.identity) });
}
const peer = (id, conn) => ({ identity: id, connection: { string: conn || "http://203.0.113.9:53550" }, status: { online: true }, sync: { block: 431000 } });
const LATEST = ID("b1"), WAITING = ID("b2"), RETAINED = ID("b3"), LEGACY = ID("b4"), FIXNET = ID("f1"), SEED = ID("a2"), OWN = ID("cd");
const peerlist = { peerlist: [peer(OWN), peer(SEED), peer(LATEST), peer(WAITING), peer(RETAINED), peer(LEGACY), peer(FIXNET, ORIGIN), peer("0xnot-a-key")] };

console.log("\n[" + TAG + "] what the fixnet probe keeps");
{
  const a = agent();
  check("F1 before this process has read a public peerlist it keeps nothing: it cannot tell a public identity from a fixnet one yet", a.listed() === null && a.discover(peerlist) === 0 && a.kept().length === 0);
  a.crawl([], false);
  check("F2 a public round that read no peerlist changes nothing", a.listed() === null && a.discover(peerlist) === 0);
  a.db.run("INSERT INTO validator_discoveries VALUES (?, 1, 2, 3)", [RETAINED]);
  a.db.run("INSERT INTO validator_discoveries VALUES (?, 1, 2, NULL)", [LEGACY]);
  a.crawl([LATEST], true); a.wait(WAITING);
  const set = a.listed();
  check("F3 the identities the public peerlists list: in the latest crawl, waiting for a second peerlist, retained in the catalog", set.has(LATEST) && set.has(WAITING) && set.has(RETAINED) && set.size === 3);
  const added = a.discover(peerlist);
  check("F4 none of them is kept; nor a configured seed, nor the operator's own node, nor what is not a key", !a.kept().some((x) => [LATEST, WAITING, RETAINED, SEED, OWN].includes(x)) && !a.kept().some((x) => !/^0x[0-9a-f]{64}$/.test(x)), a.kept().join());
  check("F5 an identity no public peerlist lists is kept: the fixnet one, and a row an older agent recorded without a public listing", added === 2 && a.kept().join() === [LEGACY, FIXNET].sort().join(), a.kept().join());
  check("F6 an identity that differs only in case is the same identity", (() => { const b = agent(); b.crawl([LATEST], true); return b.discover({ peerlist: [peer(LATEST.toUpperCase().replace("0X", "0x"))] }) === 0 && b.kept().length === 0; })());
}

console.log("\n[" + TAG + "] what the fixnet probe dials and shows");
{
  const a = agent();
  // What 7.1.1 left in the store: public-testnet identities beside a fixnet one, each with an address DNO would dial.
  for (const id of [LATEST, WAITING, RETAINED, FIXNET]) a.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [id, ORIGIN]);
  a.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [RETAINED.toUpperCase().replace("0X", "0x") + "", ORIGIN]);
  a.db.run("DELETE FROM fixnet_validator_discoveries WHERE identity = ?", [RETAINED]);   // keep the upper-case form of it only
  hits = 0;
  const early = await a.probe();
  check("P1 before a public peerlist has been read nothing is dialed and nothing is shown; the stored rows stay", early.length === 0 && hits === 0 && a.kept().length === 4);
  a.db.run("INSERT INTO validator_discoveries VALUES (?, 1, 2, 3)", [RETAINED]);
  a.crawl([LATEST], true); a.wait(WAITING);
  hits = 0;
  const shown = await a.probe();
  check("P2 then the rows a public peerlist lists are removed from the store, in whatever case they were stored", a.kept().join() === FIXNET && a.logs.includes("  [fixnet-discovery] removed 3 row(s) that the public peerlists list"), a.kept().join() + " | " + a.logs.join(" / "));
  check("P3 none of them was dialed: one dial, to the fixnet row", hits === 1, "hits " + hits);
  check("P4 and only the fixnet row is shown, with what the probe read", shown.length === 1 && shown[0].identity === FIXNET && shown[0].online === true && shown[0].block === 77, JSON.stringify(shown));
  hits = 0;
  a.crawl([LATEST, FIXNET], true);
  const later = await a.probe();
  check("P5 a row that a public peerlist lists later is removed then, undialed", later.length === 0 && hits === 0 && a.kept().length === 0);
  // The address check rejects only with a fault of its own. One row's check does; another's address is refused.
  const OTHER = ID("f2"), FAULTY = ID("f3");
  const b = agent(async (u) => { if (String(u).includes(":7001")) throw new TypeError("isPublicIp is not a function"); return String(u).startsWith("http://127.0.0.1:") ? u : null; });
  b.crawl([LATEST], true);
  b.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [FIXNET, ORIGIN]);
  b.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [OTHER, "http://10.0.0.8:53550"]);
  b.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [FAULTY, "http://203.0.113.7:7001"]);
  hits = 0;
  const mixed = await b.probe().catch(() => []), rowOf = (id) => b.db.query("SELECT probe_ok, last_probed_at FROM fixnet_validator_discoveries WHERE identity = ?").get(id), shownOf = (id) => mixed.find((x) => x.identity === id);
  check("P6 a fault in DNO's own address check does not end the cycle and is not read as an address that is not public: the other rows are probed, that row is left as it was (not probed, due again), and the log line counts it apart",
    mixed.length === 3 && hits === 1 && shownOf(FIXNET) && shownOf(FIXNET).online === true && rowOf(OTHER).last_probed_at !== null && rowOf(OTHER).probe_ok === null
    && rowOf(FAULTY).last_probed_at === null && rowOf(FAULTY).probe_ok === null && shownOf(FAULTY) && shownOf(FAULTY).probed === false
    && b.logs.includes("  [fixnet-discovery] probed 1 discovered node(s), 1 skipped (address not public), 1 not checked (an internal error in DNO's own address check)"), JSON.stringify([mixed.length, hits, rowOf(OTHER), rowOf(FAULTY)]) + " | " + b.logs.join(" / "));
  // A discovered node that answers 200 with a body that is no object (null, or a list): that is the peer's answer.
  // DNO's own code must not throw on it: no error is categorised at all, and the row reads as a failed probe.
  const nul = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { return new Response(new URL(req.url).port && req.url.includes("list") ? "[]" : "null", { headers: { "content-type": "application/json" } }); } });
  const lst = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response("[1,2]", { headers: { "content-type": "application/json" } }); } });
  const seenErrors = [], NUL = ID("f4"), LST = ID("f5");
  const c = agent(null, (e, st) => { seenErrors.push(e && e.name); return probeErrorCategory(e, st); });
  c.crawl([LATEST], true);
  c.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [NUL, "http://127.0.0.1:" + nul.port]);
  c.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [LST, "http://127.0.0.1:" + lst.port]);
  c.db.run("INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, 1, 2, ?, 1, 5)", [FIXNET, ORIGIN]);
  const shownC = await c.probe().catch(() => []);
  const okOf = (id) => c.db.query("SELECT probe_ok, last_block FROM fixnet_validator_discoveries WHERE identity = ?").get(id);
  check("P7 a discovered node that answers 200 with null, or with a list, is a failed probe and no fault of DNO's: nothing throws in DNO's own code (no error is categorised), and the node beside it is probed as before",
    okOf(NUL).probe_ok === 0 && okOf(LST).probe_ok === 0 && okOf(FIXNET).probe_ok === 1 && okOf(FIXNET).last_block === 77 && seenErrors.length === 0, JSON.stringify([okOf(NUL), okOf(LST), okOf(FIXNET), seenErrors]));
  check("P7b and the cycle's log line counts all three as probed: none is said to be 'not checked' for an internal error (the runbook counts those words in the agent's log)",
    c.logs.includes("  [fixnet-discovery] probed 3 discovered node(s)") && !c.logs.some((l) => /internal error/.test(l)), c.logs.join(" / "));
  const whenOf = (id) => c.db.query("SELECT last_probed_at FROM fixnet_validator_discoveries WHERE identity = ?").get(id).last_probed_at, seenOf = (id) => shownC.find((x) => x.identity === id) || {};
  check("P7c and each of the two is a row that was probed in this cycle: its probe time is written, and it is shown as probed and not online, not as a row that was never dialed",
    Number.isFinite(whenOf(NUL)) && whenOf(NUL) > 0 && whenOf(NUL) === whenOf(FIXNET) && Number.isFinite(whenOf(LST)) && seenOf(NUL).probed === true && seenOf(NUL).online === false && seenOf(LST).probed === true && seenOf(LST).online === false
    && seenOf(NUL).last_probed_at === whenOf(NUL), JSON.stringify([whenOf(NUL), whenOf(LST), whenOf(FIXNET), seenOf(NUL), seenOf(LST)]));
  nul.stop(true); lst.stop(true);
}

console.log("\n[" + TAG + "] the sources");
{
  const finish = extract("function catalogFinishCrawl(results, observedAt) {");
  check("S1 the public round names what it listed, and marks a public peerlist as read only when it read one", finish.includes("latestPublicListed = new Set(ids);\n  if (crawl.peerlistsRead > 0) publicPeerlistRead = true;")
    && (SRC.match(/publicPeerlistRead = true/g) || []).length === 1 && (SRC.match(/latestPublicListed = /g) || []).length === 2);
  check("S2 the fixnet probe asks before it keeps and before it dials", extract("function discoverFixnetValidators(anchorInfoData) {").includes("if (!publicListed) return 0;")
    && extract("async function probeDiscoveredFixnetNodes() {").includes("if (!publicListed) return [];") && (SRC.match(/publicListedIdentities\(\)/g) || []).length === 3);
}

srv.stop(true);
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
