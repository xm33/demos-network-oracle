// witnesses.mjs — validators that can stand in for a public seed that did not give its height.
//
// A candidate is an ACTIVE validator on the last validator list two public seeds agreed on that, in that round,
// answered as the key the list holds, at the address it published on chain, at the seeds' height (the validator watch,
// validator-watch.mjs). A configured seed's own key is never a candidate. The candidates are kept in the store
// (dno_meta, one row), so a restart while seeds are not answering keeps them; after candidateMaxAgeMs without a new
// agreed list there are none.
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
import { parseProbeOrigin, resolvePublicProbeOrigin } from "./public-safety.mjs";
import { RULE } from "./status-rule.mjs";

export const WITNESS_MAX = RULE.witnessMax;
export const CANDIDATE_MAX_AGE_MS = RULE.candidateMaxAgeMs;
export const WITNESS_LOOKUP_TIMEOUT_MS = 3000;   // one name lookup; a name that does not resolve in time is not read
const STORE_KEY = "witness_candidates";
const KEY_RE = /^[0-9a-f]{64}$/;                 // a Demos identity without its 0x, as the watch compares keys

// A candidate as kept: { key, url }. key: the listed key, lower case, without 0x. url: the bare http origin the row
// published. Anything else is dropped, whether it comes from the watch or from the store.
function cleanCandidates(list) {
  var out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach(function(c) {
    if (out.length >= WITNESS_MAX || !c || typeof c.key !== "string" || !KEY_RE.test(c.key) || seen.has(c.key)) return;
    var p = parseProbeOrigin(c.url);
    if (!p || p.protocol !== "http:") return;
    seen.add(c.key);
    out.push({ key: c.key, url: p.protocol + "//" + p.host });
  });
  return out;
}

// The candidates, in memory and in the store. db: a bun:sqlite Database, or null (memory only).
//   save(list, agreedAt): the candidates of an agreed round and when its list was read. Returns false when the store
//     could not be written (memory is still updated, so this process uses them).
//   load(now): { agreedAt, candidates } while the list they came from is at most CANDIDATE_MAX_AGE_MS old, else none.
export function createCandidateStore(db) {
  var mem = { agreedAt: null, candidates: [] };
  if (db) {
    try {
      db.run("CREATE TABLE IF NOT EXISTS dno_meta (key TEXT PRIMARY KEY, value TEXT)");
      var row = db.query("SELECT value FROM dno_meta WHERE key = ?").get(STORE_KEY);
      var kept = row ? JSON.parse(row.value) : null;
      if (kept && Number.isFinite(kept.agreed_at)) mem = { agreedAt: kept.agreed_at, candidates: cleanCandidates(kept.candidates) };
    } catch (e) { mem = { agreedAt: null, candidates: [] }; }
  }
  return {
    save: function(list, agreedAt) {
      if (!Number.isFinite(agreedAt)) return false;
      mem = { agreedAt: agreedAt, candidates: cleanCandidates(list) };
      if (!db) return true;
      try { db.run("INSERT OR REPLACE INTO dno_meta (key, value) VALUES (?, ?)", [STORE_KEY, JSON.stringify({ agreed_at: mem.agreedAt, candidates: mem.candidates })]); return true; }
      catch (e) { return false; }
    },
    load: function(now) {
      var age = mem.agreedAt === null ? null : now - mem.agreedAt;
      if (age === null || age < 0 || age > CANDIDATE_MAX_AGE_MS) return { agreedAt: null, candidates: [] };
      return { agreedAt: mem.agreedAt, candidates: mem.candidates.slice() };
    }
  };
}

function withTimeout(promise, ms) {
  var timer;
  return Promise.race([promise, new Promise(function(resolve) { timer = setTimeout(function() { resolve(null); }, ms); })]).finally(function() { clearTimeout(timer); });
}

// Read the candidates once, all at the same time. Resolves, never throws: one row per candidate read,
// { key, asListed, height }. asListed: the answer named the listed key. height: that key's own height from its own
// peerlist entry, or null. opts: { resolveOrigin, fetch, timeoutMs, lookupTimeoutMs, maxBytes }.
export async function readWitnesses(candidates, opts) {
  var o = Object.assign({ resolveOrigin: resolvePublicProbeOrigin, timeoutMs: SEED_INFO_TIMEOUT_MS, lookupTimeoutMs: WITNESS_LOOKUP_TIMEOUT_MS, maxBytes: SEED_INFO_MAX_BYTES }, opts);
  return Promise.all(cleanCandidates(candidates).map(async function(c) {
    var row = { key: c.key, asListed: false, height: null };
    try {
      // The address is checked again at every read: it must still be a public http origin, and the read goes to the
      // address that was checked.
      var origin = await withTimeout(Promise.resolve().then(function() { return o.resolveOrigin(c.url); }).catch(function() { return null; }), o.lookupTimeoutMs);
      if (!origin) return row;
      var r = await readSeedInfo({ url: origin, identity: "0x" + c.key }, { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, fetch: o.fetch });
      if (r.ok && r.identityMatch === true) {
        row.asListed = true;
        if (r.height_source === "self") row.height = r.block;
      }
    } catch (e) { /* a read that fails is a validator that did not answer */ }
    return row;
  }));
}

// What one round's witness reads give the status rule: how many were read, and the heights of those that answered as
// listed with their own height. rows keeps each height with its key for the height clock; the agent publishes neither.
export function witnessSnapshot(reads, listAgreedAt) {
  var rows = (Array.isArray(reads) ? reads : []).filter(function(r) { return r && r.asListed && r.height !== null; }).map(function(r) { return { key: r.key, height: r.height }; });
  return { listAgreedAt: Number.isFinite(listAgreedAt) ? listAgreedAt : null, read: Array.isArray(reads) ? reads.length : 0, rows: rows };
}
