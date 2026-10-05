// witnesses.mjs — validators that can stand in for a public seed that did not give its height.
//
// Who is a candidate is decided by evidence, one counted round of the validator watch at a time (nextCandidates):
//   a validator joins when it is ACTIVE on the list two public seeds agreed on, publishes a bare http origin that at
//     least two of them give alike, is not a configured seed's key, and answered there as the listed key at the seeds'
//     height in that round;
//   it stays for candidateMaxAgeMs after its last such answer, and leaves earlier only on evidence: it is no longer
//     ACTIVE on an agreed list, it publishes no address or another one, or its key is a configured seed's.
//   One round in which nobody answers, the first round after a restart, or seeds that give different addresses for a
//   row remove nobody. Order: the keys DNO has listed longest first (the first agreed list that showed each; a new key
//   cannot be made older, so it cannot be ground to the front), then the most counted rounds in the watch window, then
//   key order; the first WITNESS_MAX are kept.
// The candidates are kept in the store (dno_meta, one row), so a restart while seeds are not answering keeps them.
//
// A witness read is the seed read itself (readSeedInfo in seed-read.mjs): GET /info at the published address, pinned to
// the public address it was checked against, redirects refused, the body capped. The validator counts as read "as
// listed" only when the answer names the listed key, and its height is its own peerlist entry's.
//
// The agent reads witnesses in its public round, and only when fewer than two seeds gave their own height. What the
// reads mean for status is status-rule.mjs. Nothing here is published except counts: never a key, an address or a
// height, and a witness read's peerlist goes nowhere (it does not reach the catalog).
// Runtime tests: bun src/witnesses.test.mjs

import { readSeedInfo, SEED_INFO_TIMEOUT_MS, SEED_INFO_MAX_BYTES } from "./seed-read.mjs";
import { parseProbeOrigin, resolvePublicProbeOrigin, isInternalError } from "./public-safety.mjs";
import { RULE } from "./status-rule.mjs";

export const WITNESS_MAX = RULE.witnessMax;
export const CANDIDATE_MAX_AGE_MS = RULE.candidateMaxAgeMs;
export const WITNESS_LOOKUP_TIMEOUT_MS = 3000;   // one name lookup; a name that does not resolve in time is not read
const STORE_KEY = "witness_candidates";
const KEY_RE = /^[0-9a-f]{64}$/;                 // a Demos identity without its 0x, as the watch compares keys
// A time in ms that a Date can hold: a stored number outside that range is not one (new Date(9e15) cannot be printed).
const isTime = function(t) { return typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 8.64e15; };

// A candidate as kept: { key, url, at }. key: the listed key, lower case, without 0x. url: the bare http origin the row
// published. at: when it last answered there as listed at the seeds' height in a counted round (ms). Anything else is
// dropped, whether it comes from the watch or from the store. fallbackAt: the time for a row that carries none.
function cleanCandidates(list, fallbackAt) {
  var out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach(function(c) {
    if (out.length >= WITNESS_MAX || !c || typeof c.key !== "string" || !KEY_RE.test(c.key) || seen.has(c.key)) return;
    var p = parseProbeOrigin(c.url);
    if (!p || p.protocol !== "http:") return;
    var at = isTime(c.at) ? c.at : fallbackAt;   // every caller gives a time
    seen.add(c.key);
    out.push({ key: c.key, url: p.protocol + "//" + p.host, at: at });
  });
  return out;
}

// The candidates after one counted round of the watch. kept: [{ key, url, at }] before it. facts: the round's
// witnessFacts (validator-watch.mjs). null when the round gives no order (facts.seniority false): nothing is renewed.
export function nextCandidates(kept, facts) {
  if (!facts || !Array.isArray(facts.rows) || !Number.isFinite(facts.at) || facts.seniority === false) return null;
  var rows = new Map(), out = new Map();
  facts.rows.forEach(function(r) { if (r && typeof r.key === "string" && KEY_RE.test(r.key)) rows.set(r.key, r); });   // a key that cannot be kept takes none of the places
  (Array.isArray(kept) ? kept : []).forEach(function(c) {
    var r = c && rows.get(c.key);
    if (!r) return;                                               // no longer ACTIVE on the agreed list, or a configured seed's key
    if (!Number.isFinite(c.at) || facts.at - c.at > CANDIDATE_MAX_AGE_MS) return;   // too long since its last answer as listed at the seeds' height
    if (r.addr === "none" || r.addr === "other") return;          // it publishes no address, or one DNO does not read
    if (r.addr === "origin" && r.origin !== c.url) return;        // it publishes another address: it joins again when it answers there
    out.set(c.key, { key: c.key, url: c.url, at: c.at });         // "disputed": the seeds give different addresses, which is no evidence against it
  });
  rows.forEach(function(r) { if (r.confirmed && r.addr === "origin" && typeof r.origin === "string") out.set(r.key, { key: r.key, url: r.origin, at: facts.at }); });
  var order = function(key) { var r = rows.get(key); return { since: Number.isFinite(r.since) ? r.since : Infinity, rounds: Number.isInteger(r.rounds) ? r.rounds : 0 }; };
  return Array.from(out.values()).sort(function(a, b) {
    var x = order(a.key), y = order(b.key);
    return (x.since === y.since ? 0 : x.since < y.since ? -1 : 1) || y.rounds - x.rounds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }).slice(0, WITNESS_MAX);
}

// The candidates, in memory and in the store. db: a bun:sqlite Database, or null (memory only).
//   save(list, agreedAt): the candidates after a counted round (nextCandidates) and when its list was read. Returns
//     false when the store could not be written (memory is still updated, so this process uses them).
//   load(now): { agreedAt, candidates }: those whose last answer as listed is at most CANDIDATE_MAX_AGE_MS old.
//     agreedAt is the list time of the last counted round, or null when there is no candidate.
//   readable: false when a store was given and could not be read.
export function createCandidateStore(db) {
  var mem = { agreedAt: null, candidates: [] }, readable = true;
  if (db) {
    // A store opened read-only (the pre-restart check reads the agent's) cannot create the table; it can still be read.
    try { db.run("CREATE TABLE IF NOT EXISTS dno_meta (key TEXT PRIMARY KEY, value TEXT)"); } catch (e) {}
    try {
      // A store without the table (read-only, from an agent that never kept candidates) holds none: that is not a failed read.
      var has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dno_meta'").get();
      var row = has ? db.query("SELECT value FROM dno_meta WHERE key = ?").get(STORE_KEY) : null;
      var kept = row ? JSON.parse(row.value) : null;
      if (kept && isTime(kept.agreed_at)) mem = { agreedAt: kept.agreed_at, candidates: cleanCandidates(kept.candidates, kept.agreed_at) };
    } catch (e) { mem = { agreedAt: null, candidates: [] }; readable = false; }
  }
  return {
    readable: readable,
    save: function(list, agreedAt) {
      if (!isTime(agreedAt)) return false;
      mem = { agreedAt: agreedAt, candidates: cleanCandidates(list, agreedAt) };
      if (!db) return true;
      try { db.run("INSERT OR REPLACE INTO dno_meta (key, value) VALUES (?, ?)", [STORE_KEY, JSON.stringify({ agreed_at: mem.agreedAt, candidates: mem.candidates })]); return true; }
      catch (e) { return false; }
    },
    load: function(now) {
      var live = mem.candidates.filter(function(c) { var age = now - c.at; return age >= 0 && age <= CANDIDATE_MAX_AGE_MS; });
      return live.length ? { agreedAt: mem.agreedAt, candidates: live.map(function(c) { return { key: c.key, url: c.url, at: c.at }; }) } : { agreedAt: null, candidates: [] };
    }
  };
}

function withTimeout(promise, ms) {
  var timer;
  return Promise.race([promise, new Promise(function(resolve) { timer = setTimeout(function() { resolve(null); }, ms); })]).finally(function() { clearTimeout(timer); });
}

// Read the candidates once, all at the same time. Resolves, never throws: the address check's failure is caught here
// (a fault of DNO's own in it is the category "internal error", like one in the read), and readSeedInfo turns every
// failure into a category. One row per candidate read: { key, asListed, height, error }.
// asListed: the answer named the listed key. height: that key's own height from its own peerlist entry, or null.
// error: why there was no answer, as a category (never runtime text or a host), else null; "internal error" is a
// fault in DNO's own read (readSeedInfo's category), which the pre-restart check looks for.
// opts: { resolveOrigin, fetch, timeoutMs, lookupTimeoutMs, maxBytes }.
export async function readWitnesses(candidates, opts) {
  var o = Object.assign({ resolveOrigin: resolvePublicProbeOrigin, timeoutMs: SEED_INFO_TIMEOUT_MS, lookupTimeoutMs: WITNESS_LOOKUP_TIMEOUT_MS, maxBytes: SEED_INFO_MAX_BYTES }, opts);
  return Promise.all(cleanCandidates(candidates, 0).map(async function(c) {   // a read needs no time: a row without one is still read
    var row = { key: c.key, asListed: false, height: null, error: null };
    // The address is checked again at every read: it must still be a public http origin, and the read goes to the
    // address that was checked.
    // A fault in DNO's own check (a TypeError or ReferenceError) is not the validator's address being refused.
    var fault = false;
    var origin = await withTimeout(Promise.resolve().then(function() { return o.resolveOrigin(c.url); }).catch(function(e) { fault = isInternalError(e); return null; }), o.lookupTimeoutMs);
    if (fault) { row.error = "internal error"; return row; }
    if (!origin) { row.error = "address not resolved to a public http origin"; return row; }
    var r = await readSeedInfo({ url: origin, identity: "0x" + c.key }, { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, fetch: o.fetch });
    if (!r.ok) row.error = r.error;
    else if (r.identityMatch === true) {
      row.asListed = true;
      if (r.height_source === "self") row.height = r.block;
    }
    return row;
  }));
}

// What one round's witness reads give the status rule: how many were read, and the heights of those that answered as
// listed with their own height. rows keeps each height with its key; the agent publishes neither.
export function witnessSnapshot(reads, listAgreedAt) {
  var rows = (Array.isArray(reads) ? reads : []).filter(function(r) { return r && r.asListed && r.height !== null; }).map(function(r) { return { key: r.key, height: r.height }; });
  return { listAgreedAt: Number.isFinite(listAgreedAt) ? listAgreedAt : null, read: Array.isArray(reads) ? reads.length : 0, rows: rows };
}
