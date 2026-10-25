// block-identity.mjs — did the public seeds that reported the same height, in one round, report the same block?
//
// A seed's /info names its latest block by height and by hash (its own peerlist entry: sync.block, sync.block_hash). The
// round reads both (seed-read.mjs); the height enters the reading as before, the hash enters only this comparison. In the
// Demos node's own code a block's hash covers its content, which carries the previous block's hash: two nodes that report
// the same hash at a height report the same block there. That is a statement about what they reported — not that the
// block is final, that every validator holds it, or that either node is still on it a round later.
//
// One round, one observation. The comparison is made only among the seeds of the round in hand: never across rounds and
// never from a cache. In a round the seeds are read in parallel and answer within a fraction of a second of each other;
// when the tip moved between two answers the heights differ and nothing is compared (no_shared_height). During a
// standstill — the case the reading exists to notice — every round is comparable.
//
// With three configured seeds at most one height can be reported by two or more of them, so there is at most one
// comparison a round. It is made over all pairs at that height; no hash is chosen as "the" block, and no majority is
// taken: two equal and one different is `mixed`, and stays `mixed`.
//
// Nothing here enters assess() or computeCanonicalState(): status, confidence, agreement, data quality, trend and
// /organism are the same with and without this module (observation-isolation / block-identity tests).
// Runtime tests: bun src/block-identity.test.mjs

export const BLOCK_IDENTITY_STATES = ["same_block", "different_block", "mixed", "no_shared_height", "insufficient"];
export const BLOCK_IDENTITY_VERSION = 1;
const HASH_PREFIX_CHARS = 16;

// A seed qualifies for the comparison when, in this round, it answered, gave its own height (height_source "self"), and
// its evidence carries a normalized hash. `hashes` is the round's evidence: seed name → 64-hex hash or null, kept apart
// from the published seed rows (the /health serializer copies every key of those rows).
function qualifying(seedResults, hashes) {
  var out = [];
  (seedResults || []).forEach(function(r) {
    if (!r || !r.ok || r.height_source !== "self" || typeof r.block !== "number") return;
    var h = hashes && Object.prototype.hasOwnProperty.call(hashes, r.name) ? hashes[r.name] : null;
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return;
    out.push({ name: r.name, block: r.block, hash: h, latencyMs: typeof r.latencyMs === "number" ? r.latencyMs : null });
  });
  return out;
}

// The round's result. seedResults: probePublicNodes rows. hashes: the round's evidence map. observedAtMs: the round's time.
// Returns the public object (no name, no full hash):
//   state, height, seeds_with_valid_hash, seeds_compared, seeds_other_height, distinct_hashes, pairs_same,
//   largest_group, pairs_different, hash_prefix (16 hex, only when one hash — same_block), observed_at, spread_ms, reason
export function compareBlockIdentity(seedResults, hashes, observedAtMs) {
  var q = qualifying(seedResults, hashes);
  var observedAt = typeof observedAtMs === "number" && observedAtMs > 0 ? new Date(observedAtMs).toISOString() : null;
  var base = { version: BLOCK_IDENTITY_VERSION, state: null, height: null, seeds_with_valid_hash: q.length, seeds_compared: 0, seeds_other_height: 0,
    distinct_hashes: null, largest_group: null, pairs_same: 0, pairs_different: 0, hash_prefix: null, observed_at: observedAt, spread_ms: null, reason: null };
  if (q.length < 2) { base.state = "insufficient"; base.reason = "fewer_than_two_seeds_with_hash"; return base; }
  // The height reported by the most qualifying seeds; a tie (impossible with three seeds, possible with more) takes the highest.
  var byHeight = {};
  q.forEach(function(s) { (byHeight[s.block] = byHeight[s.block] || []).push(s); });
  var best = null;
  Object.keys(byHeight).forEach(function(k) {
    var h = Number(k), g = byHeight[k];
    if (best === null || g.length > byHeight[best].length || (g.length === byHeight[best].length && h > best)) best = h;
  });
  var group = byHeight[best];
  if (group.length < 2) { base.state = "no_shared_height"; base.reason = "heights_differ_this_round"; base.seeds_other_height = q.length; return base; }
  base.height = best; base.seeds_compared = group.length; base.seeds_other_height = q.length - group.length;
  var counts = {};
  group.forEach(function(s) { counts[s.hash] = (counts[s.hash] || 0) + 1; });
  var distinct = Object.keys(counts);
  var pairsSame = 0;
  distinct.forEach(function(h) { var c = counts[h]; pairsSame += c * (c - 1) / 2; });
  var pairsAll = group.length * (group.length - 1) / 2;
  base.distinct_hashes = distinct.length; base.pairs_same = pairsSame; base.pairs_different = pairsAll - pairsSame;
  base.largest_group = Math.max.apply(null, distinct.map(function(h) { return counts[h]; }));
  if (distinct.length === 1) { base.state = "same_block"; base.hash_prefix = distinct[0].slice(0, HASH_PREFIX_CHARS); }
  else if (distinct.length === group.length) base.state = "different_block";
  else base.state = "mixed";
  var lat = group.map(function(s) { return s.latencyMs; }).filter(function(l) { return l !== null; });
  if (lat.length === group.length) base.spread_ms = Math.max.apply(null, lat) - Math.min.apply(null, lat);
  return base;
}

// A count of the rounds' outcomes over the last hour: how often there was a comparison and what it found. It keeps
// states and times only — no height and no hash — so it can never become a comparison across rounds.
export function createBlockIdentityTracker(windowMs) {
  var win = typeof windowMs === "number" && windowMs > 0 ? windowMs : 60 * 60 * 1000;
  var rounds = [];   // { at, state }
  function prune(nowMs) { while (rounds.length && rounds[0].at <= nowMs - win) rounds.shift(); }
  return {
    record: function(result, nowMs) {
      if (!result || BLOCK_IDENTITY_STATES.indexOf(result.state) === -1) return;
      rounds.push({ at: nowMs, state: result.state }); prune(nowMs);
    },
    lastHour: function(nowMs) {
      prune(nowMs);
      var c = { window_seconds: Math.round(win / 1000), rounds: rounds.length, rounds_compared: 0, rounds_same: 0, rounds_different: 0, rounds_mixed: 0 };
      rounds.forEach(function(r) {
        if (r.state === "same_block" || r.state === "different_block" || r.state === "mixed") c.rounds_compared++;
        if (r.state === "same_block") c.rounds_same++;
        if (r.state === "different_block") c.rounds_different++;
        if (r.state === "mixed") c.rounds_mixed++;
      });
      return c;
    }
  };
}

// The sentence /health carries beside the result: the licensed wording, at the level of what was reported. Never "same
// chain", "synced", "majority", "canonical", "finalized", "consensus", "healthy", "the network".
export function describeBlockIdentity(r) {
  if (!r) return null;
  var n = r.seeds_compared, of = r.seeds_with_valid_hash;
  switch (r.state) {
    case "same_block": return "The public seeds that reported height " + r.height + " in this observation (" + n + " of " + of + " with a hash) reported the same block hash.";
    case "different_block": return "The public seeds that reported height " + r.height + " in this observation (" + n + ") reported different block hashes. DNO cannot tell which, if either, the validators follow.";
    case "mixed": return "Of the " + n + " public seeds that reported height " + r.height + " in this observation, " + r.largest_group + " reported the same block hash and " + (n - r.largest_group) + " reported " + (n - r.largest_group === 1 ? "a different one." : "others.");
    case "no_shared_height": return "The public seeds reported different heights in this observation, so their blocks were not compared.";
    case "insufficient": return "Fewer than two public seeds gave a comparable height and hash in this observation.";
    default: return null;
  }
}
