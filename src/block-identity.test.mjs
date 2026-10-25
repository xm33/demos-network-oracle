// block-identity.test.mjs — BLOCK_ID guard: the seeds' block identity within one round (src/block-identity.mjs), its
// wiring in the agent, and its isolation from the reading.
// Run: bun src/block-identity.test.mjs   (executable harness, not `bun test`)
// With --write-vectors it also writes test-vectors/block-identity.json (the fixtures below as input → expected pairs).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareBlockIdentity, createBlockIdentityTracker, describeBlockIdentity, BLOCK_IDENTITY_STATES } from "./block-identity.mjs";
import { publicLanguageHit } from "./banned-public-language.mjs";

const TAG = "BLOCK_ID";
const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const H = (c) => String(c).repeat(64);
const row = (name, block, o) => Object.assign({ name: name, ok: true, block: block, height_source: "self", latencyMs: 100 }, o || {});
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

// Fixtures: [name, seedResults, hashes, expected subset]. These are the public test vectors.
const FIX = [
  ["BLOCK-ID-1 two seeds, same height, same hash → same_block", [row("a", 10), row("b", 10)], { a: H("1"), b: H("1") },
    { state: "same_block", height: 10, seeds_with_valid_hash: 2, seeds_compared: 2, seeds_other_height: 0, distinct_hashes: 1, pairs_same: 1, pairs_different: 0, hash_prefix: "1".repeat(16) }],
  ["BLOCK-ID-2 two seeds, same height, hashes equal on 16 hex and different in the tail → different_block (full-value test)", [row("a", 10), row("b", 10)], { a: "1".repeat(63) + "a", b: "1".repeat(63) + "b" },
    { state: "different_block", distinct_hashes: 2, pairs_same: 0, pairs_different: 1, hash_prefix: null }],
  ["BLOCK-ID-3 heights differ this round → no_shared_height, even when the hashes are equal", [row("a", 10), row("b", 11)], { a: H("1"), b: H("1") },
    { state: "no_shared_height", height: null, seeds_with_valid_hash: 2, seeds_compared: 0, seeds_other_height: 2, reason: "heights_differ_this_round" }],
  ["BLOCK-ID-4 one qualifying seed → insufficient", [row("a", 10), row("b", 10, { ok: false })], { a: H("1") },
    { state: "insufficient", seeds_with_valid_hash: 1, reason: "fewer_than_two_seeds_with_hash" }],
  ["BLOCK-ID-6 three seeds, two equal and one different at the same height → mixed, never same_block", [row("a", 10), row("b", 10), row("c", 10)], { a: H("1"), b: H("1"), c: H("2") },
    { state: "mixed", seeds_compared: 3, distinct_hashes: 2, largest_group: 2, pairs_same: 1, pairs_different: 2, hash_prefix: null }],
  ["BLOCK-ID-7 three seeds, three distinct hashes → different_block", [row("a", 10), row("b", 10), row("c", 10)], { a: H("1"), b: H("2"), c: H("3") },
    { state: "different_block", distinct_hashes: 3, pairs_same: 0, pairs_different: 3 }],
  ["BLOCK-ID-7b three seeds, one hash → same_block from three", [row("a", 10), row("b", 10), row("c", 10)], { a: H("1"), b: H("1"), c: H("1") },
    { state: "same_block", seeds_compared: 3, distinct_hashes: 1, pairs_same: 3, pairs_different: 0 }],
  ["BLOCK-ID-8 two seeds at h, one at h+1 → the pair is compared; seeds_other_height 1", [row("a", 10), row("b", 11), row("c", 10)], { a: H("1"), b: H("1"), c: H("1") },
    { state: "same_block", height: 10, seeds_compared: 2, seeds_other_height: 1 }],
  ["BLOCK-ID-9 a seed with no hash in the evidence (another identity answered, or malformed) is not qualifying; the remaining pair is evaluated", [row("a", 10), row("b", 10), row("c", 10)], { a: H("1"), b: H("2"), c: null },
    { state: "different_block", seeds_with_valid_hash: 2, seeds_compared: 2 }],
  ["BLOCK-ID-10 a first_peer height carries no comparison, whatever the evidence says", [row("a", 10), row("b", 10, { height_source: "first_peer" })], { a: H("1"), b: H("1") },
    { state: "insufficient", seeds_with_valid_hash: 1 }],
  ["BLOCK-ID-11 a malformed hash in the evidence (0x, upper case, short) does not qualify", [row("a", 10), row("b", 10), row("c", 10)], { a: H("a"), b: "0x" + H("a"), c: H("a").toUpperCase() },
    { state: "insufficient", seeds_with_valid_hash: 1 }],
  ["BLOCK-ID-12 no seeds → insufficient", [], {}, { state: "insufficient", seeds_with_valid_hash: 0 }],
];

console.log("\n[" + TAG + "] the comparison, one round at a time");
const vectors = [];
for (const [name, seeds, hashes, exp] of FIX) {
  const before = JSON.stringify(seeds);
  const r = compareBlockIdentity(seeds, hashes, T0);
  const bad = Object.keys(exp).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(exp[k]));
  check(name, bad.length === 0, bad.map((k) => k + "=" + JSON.stringify(r[k]) + " (want " + JSON.stringify(exp[k]) + ")").join(", "));
  check(name.split(" ")[0] + " leaves its inputs unchanged and publishes no full hash and no seed name", JSON.stringify(seeds) === before && !JSON.stringify(r).match(/[0-9a-f]{64}/) && !("a" in r) && JSON.stringify(r).indexOf('"a"') === -1);
  vectors.push({ name: name, input: { seeds: seeds, hashes: hashes, observed_at: new Date(T0).toISOString() }, expected: r });
}
{
  const r = compareBlockIdentity([row("a", 10, { latencyMs: 120 }), row("b", 10, { latencyMs: 480 })], { a: H("1"), b: H("1") }, T0);
  check("BLOCK-ID-5 observed_at is the round's time and spread_ms the latency difference of the compared seeds", r.observed_at === "2026-10-25T12:00:00.000Z" && r.spread_ms === 360, JSON.stringify([r.observed_at, r.spread_ms]));
  check("BLOCK-ID-5b states are exactly the five", JSON.stringify(BLOCK_IDENTITY_STATES) === JSON.stringify(["same_block", "different_block", "mixed", "no_shared_height", "insufficient"]));
}

console.log("\n[" + TAG + "] the sentence");
{
  const sentences = FIX.map(([, seeds, hashes]) => describeBlockIdentity(compareBlockIdentity(seeds, hashes, T0)));
  const banned = /\b(same chain|synced|majority|unanimous\w*|canonical|finalized|final\b|consensus|healthy|the network agrees|verified|confirmed)\b/i;
  check("LANG-A1 no sentence uses a banned form, and none trips the public-language guard", sentences.every((t) => t && !banned.test(t) && !publicLanguageHit(t)), sentences.filter((t) => !t || banned.test(t) || publicLanguageHit(t)).join(" | "));
  const mixed = describeBlockIdentity(compareBlockIdentity(FIX[4][1], FIX[4][2], T0));
  check("LANG-A1b the mixed sentence gives counts, not a verdict", mixed === "Of the 3 public seeds that reported height 10 in this observation, 2 reported the same block hash and 1 reported a different one.", mixed);
  const two = describeBlockIdentity(compareBlockIdentity(FIX[0][1], FIX[0][2], T0)), three = describeBlockIdentity(compareBlockIdentity(FIX[6][1], FIX[6][2], T0));
  check("LANG-A1c a two-seed match never reads like a three-seed one", two !== three && /\(2 of 2 with a hash\)/.test(two) && /\(3 of 3 with a hash\)/.test(three), two + " || " + three);
}

console.log("\n[" + TAG + "] the last-hour counter keeps states and times only");
{
  const t = createBlockIdentityTracker(3600 * 1000);
  const rs = [compareBlockIdentity(FIX[0][1], FIX[0][2], T0), compareBlockIdentity(FIX[4][1], FIX[4][2], T0), compareBlockIdentity(FIX[2][1], FIX[2][2], T0), compareBlockIdentity(FIX[1][1], FIX[1][2], T0)];
  rs.forEach((r, i) => t.record(r, T0 + i * 20000));
  const c = t.lastHour(T0 + 60000);
  check("TRACK-1 counts rounds compared / same / different / mixed over the window", c.rounds === 4 && c.rounds_compared === 3 && c.rounds_same === 1 && c.rounds_mixed === 1 && c.rounds_different === 1 && c.window_seconds === 3600, JSON.stringify(c));
  const late = t.lastHour(T0 + 3600 * 1000 + 30000);
  check("TRACK-2 rounds older than the window drop out", late.rounds === 2 && late.rounds_compared === 1, JSON.stringify(late));
  const src = readFileSync(join(__dir, "block-identity.mjs"), "utf8");
  const trackerBody = src.slice(src.indexOf("export function createBlockIdentityTracker"), src.indexOf("export function describeBlockIdentity"));
  check("TRACK-3 the tracker stores no height and no hash (it can never become a cross-round comparison)", !/\.block\b|hash|height/i.test(trackerBody.replace(/\/\/.*$/gm, "")), "tracker body references a height or hash");
  check("TRACK-4 a result with an unknown state is not recorded", (() => { const u = createBlockIdentityTracker(); u.record({ state: "something" }, T0); u.record(null, T0); return u.lastHour(T0).rounds === 0; })());
}

console.log("\n[" + TAG + "] wiring and isolation in the agent (static)");
{
  const AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8");
  const SEEDREAD = readFileSync(join(__dir, "seed-read.mjs"), "utf8");
  check("WIRE-1 the round computes block identity from this round's rows and this round's evidence, at the round's time, and records it",
    /latestBlockIdentity = compareBlockIdentity\(publicNodeResults, roundSeedHashes, lastPublicObservedAt\);\s*\n\s*blockIdentityTracker\.record\(latestBlockIdentity, lastPublicObservedAt\);/.test(AGENT));
  check("WIRE-2 the evidence map is emptied at the start of every probe and filled per seed from readSeedInfo", /var names = Object\.keys\(PUBLIC_NODES\);\s*\n\s*roundSeedHashes = \{\};/.test(AGENT) && /roundSeedHashes\[name\] = r\.block_hash \|\| null;/.test(AGENT));
  // A1-PUBLIC-PROJECTION (static half): the published seed row is built from named fields and block_hash is not one of them;
  // the /health serializer copies every key of those rows, so a hash there would be published whole.
  const rowBuild = AGENT.match(/return Object\.assign\(base, \{ ok: true, latencyMs: r\.latencyMs[^\n]*\}\);/);
  check("A1-PUBLIC-PROJECTION-1 the published seed row is assembled from named fields, and block_hash is not among them", !!rowBuild && !/block_hash|hash/.test(rowBuild[0]), rowBuild ? rowBuild[0] : "row build not found");
  const healthProj = AGENT.slice(AGENT.indexOf("publicNodes: (latestPublicNodes || []).map("), AGENT.indexOf("signals: publicSignals"));
  check("A1-PUBLIC-PROJECTION-2 /health still copies the seed rows' keys (the reason the hash must not be on them) — if this changes, revisit the rule", /for \(var k in n\)/.test(healthProj));
  check("A1-PUBLIC-PROJECTION-3 /health publishes block_identity through publicBlockIdentity, which copies the result's keys (no name, no full hash) and adds the sentence, last_hour and enters_status: false",
    /block_identity: publicBlockIdentity\(Date\.now\(\)\),/.test(AGENT) && /o\.sentence = describeBlockIdentity\(r\);\s*\n\s*o\.last_hour = blockIdentityTracker\.lastHour\(nowMs\);\s*\n\s*o\.enters_status = false;/.test(AGENT));
  // A1-COMPATIBILITY (static half): nothing in the reading reads the hash or the result.
  const names = ["computeCanonicalState", "readRoundWitnesses", "stepPublicHeightClock", "recordPublicNodeHistory", "recordObservationHistory", "evaluatePublicIncidents", "getLast24h"];
  const bodies = names.map((n) => { const i = AGENT.indexOf("function " + n + "("); if (i < 0) return [n, null]; let d = 0, j = AGENT.indexOf("{", i); for (let k = j; k < AGENT.length; k++) { if (AGENT[k] === "{") d++; else if (AGENT[k] === "}") { d--; if (d === 0) return [n, AGENT.slice(i, k + 1)]; } } return [n, null]; });
  const leaks = bodies.filter(([, b]) => b === null || /roundSeedHashes|latestBlockIdentity|blockIdentityTracker|block_hash|compareBlockIdentity/.test(b)).map(([n]) => n);
  check("A1-COMPATIBILITY-1 the reading's functions (" + names.join(", ") + ") never reference the hash evidence or the block-identity result", leaks.length === 0, leaks.join(", "));
  for (const f of ["status-rule.mjs", "witnesses.mjs", "consensus.mjs", "home-cycle.mjs", "validator-watch.mjs"]) {
    const p = join(__dir, f); if (!existsSync(p)) continue;
    check("A1-COMPATIBILITY-2 " + f + " does not read block hashes or block identity", !/block_hash|block-identity|blockIdentity/.test(readFileSync(p, "utf8")));
  }
  check("A1-IDENTITY the hash is read only from the seed's own entry, only with the height, and only when the answer named the configured identity",
    /if \(block !== null\) \{ heightSource = "self"; if \(identityMatch === true\) blockHash = normalizeBlockHash\(selfEntry\.sync\.block_hash\); \}/.test(SEEDREAD) && !/peerlist\[0\][^\n]*block_hash/.test(SEEDREAD));
  const home = readFileSync(join(__dir, "..", "homepage.html"), "utf8");
  check("HOME-A1 the homepage no longer says block hashes are not compared, and points at block_identity", !/block hashes are not\./.test(home) && /<code>block_identity<\/code>, and does not enter this reading/.test(home));
  const meth = readFileSync(join(__dir, "..", "methodology.html"), "utf8"), srcs = readFileSync(join(__dir, "..", "sources.html"), "utf8");
  check("METH-A1 the methodology has the block-identity section with the five states, the one-round rule and the reproduction recipe", /<section id="block-identity">/.test(meth) && ["same_block", "different_block", "mixed", "no_shared_height", "insufficient"].every((s) => meth.indexOf("<code>" + s + "</code>") !== -1) && /never across rounds and never from a cache/.test(meth) && /getBlockByNumber/.test(meth));
  const srcRow = (srcs.match(/<tr><td data-label="Layer">Block identity<\/td>[\s\S]*?<\/tr>/) || [""])[0];
  check("SRC-A1 the sources layers table has the block-identity row, enters status: no", /block hash/.test(srcRow) && /data-label="Enters status">no<\/td>/.test(srcRow) && !/data-label="Enters status">yes/.test(srcRow), srcRow.slice(-80));
  const newCopy = [home.match(/<li>Whether a block the seeds agree on[^<]*/)[0], meth.slice(meth.indexOf('<section id="block-identity">'), meth.indexOf("</section>", meth.indexOf('<section id="block-identity">'))), srcs.match(/Block identity<\/td>[\s\S]*?<\/tr>/)[0]].join("\n").replace(/<[^>]+>/g, " ");
  const bannedCopy = /\b(same chain|synced|majority|unanimous\w*|canonical|finalized|consensus confirmed|healthy|the network agrees|verified)\b/i;
  check("LANG-A1d the new page copy uses none of the banned forms and does not trip the public-language guard", !bannedCopy.test(newCopy) && !publicLanguageHit(newCopy), (newCopy.match(bannedCopy) || [])[0]);
}

if (process.argv.indexOf("--write-vectors") !== -1) {
  const dir = join(__dir, "..", "test-vectors"); mkdirSync(dir, { recursive: true });
  const out = { description: "DNO block identity (A1): the seeds' own block hashes compared within one round. Input: the round's seed rows (name, ok, block, height_source, latencyMs) and the evidence map (name → 64-hex hash or null). Expected: compareBlockIdentity() output. Hashes are synthetic.", version: 1, vectors: vectors };
  writeFileSync(join(dir, "block-identity.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("  wrote test-vectors/block-identity.json (" + vectors.length + " vectors)");
} else if (existsSync(join(__dir, "..", "test-vectors", "block-identity.json"))) {
  const file = JSON.parse(readFileSync(join(__dir, "..", "test-vectors", "block-identity.json"), "utf8"));
  const same = file.vectors.length === vectors.length && file.vectors.every((v, i) => JSON.stringify(v.expected) === JSON.stringify(vectors[i].expected) && v.name === vectors[i].name);
  check("VECTORS the published test vectors match the fixtures (regenerate with --write-vectors when a fixture changes on purpose)", same);
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
