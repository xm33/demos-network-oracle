// seed-read.mjs — one configured seed's /info read, and what the answer says.
//
// The agent's public round (probePublicNodes in agent.mjs) and the pre-restart check (tools/pre-restart-check.mjs) both
// call readSeedInfo, so the check runs the agent's own read and its own reading of the answer, not a copy of them.
// The read is cappedJson (public-safety.mjs): the runtime's fetch, a body cap, redirects refused, the request stopped
// when the read ends.
// Runtime tests: bun src/seed-read.test.mjs

import { cappedJson, isValidIdentity, keyOf, sanitizeHeight, versionOf, probeErrorCategory } from "./public-safety.mjs";
import { seedReasonOf } from "./status-rule.mjs";

export const SEED_INFO_TIMEOUT_MS = 5000;
export const SEED_INFO_MAX_BYTES = 2 * 1024 * 1024;   // a real /info is tens of KB

// node: { url, identity } as configured. Resolves, never throws:
//   answered:     { ok: true, latencyMs, block, height_source, version, peers, identityMatch, peerlist, answeredId }
//   not answered: { ok: false, error, status? }   error is a category (probeErrorCategory), never runtime text or a host
// A seed's height is its own peerlist entry (height_source "self"). The first listed peer's height is used only when the
// seed does not list itself, and height_source says so ("first_peer"); it is counted nowhere.
// identityMatch: whether the identity this /info names is the configured one (null when it names none). When it names
// another key, the URL was answered by a different node: that answer is not this seed's, so it gives no height. Keys are
// compared in one form (keyOf: trimmed, lower case, 0x or not), the form the validator watch compares in: a node is
// not "as listed" for one of them and "another key" for the other.
// peerlist and answeredId are for the catalog intake (one node answering two URLs is one peerlist); the agent does not
// publish them.
export async function readSeedInfo(node, opts) {
  var o = opts || {};
  try {
    var res = await cappedJson(node.url + "/info", null, { timeoutMs: o.timeoutMs || SEED_INFO_TIMEOUT_MS, maxBytes: o.maxBytes || SEED_INFO_MAX_BYTES, fetch: o.fetch });
    if (!res.ok) return { ok: false, error: probeErrorCategory(null, res.status), status: res.status };
    var data = res.data;
    var peerlist = data && Array.isArray(data.peerlist) ? data.peerlist : [];
    var block = null, heightSource = null;
    var nodeKey = keyOf(node.identity), answeredKey = data ? keyOf(data.identity) : null;
    var answeredId = data && typeof data.identity === "string" && isValidIdentity(data.identity) ? data.identity.toLowerCase() : null;
    var identityMatch = answeredKey === null ? null : answeredKey === nodeKey;
    if (identityMatch !== false) {
      var selfEntry = nodeKey === null ? null : peerlist.find(function(p) { return p && keyOf(p.identity) === nodeKey; });
      if (selfEntry && selfEntry.sync) { block = sanitizeHeight(selfEntry.sync.block); if (block !== null) heightSource = "self"; }
      if (block === null && peerlist[0] && peerlist[0].sync) { block = sanitizeHeight(peerlist[0].sync.block); if (block !== null) heightSource = "first_peer"; }
    }
    return { ok: true, latencyMs: res.headersMs, block: block, height_source: heightSource, version: versionOf(data && data.version) || "?",   // a release version, or none: a seed's free text is not published
      peers: peerlist.length, identityMatch: identityMatch, peerlist: peerlist, answeredId: answeredId };
  } catch (err) {
    return { ok: false, error: probeErrorCategory(err) };
  }
}

// Whether a set of seed readings is enough for the agent to publish a status: at least two seeds answered and at least
// two of them gave their own height (computeCanonicalState's data-quality rule, less the age of the observation).
// readings: readSeedInfo results, or the agent's publicNodes rows. Returns { answered, ownHeights, sufficient, reason }.
export function seedsSufficient(readings) {
  var answered = readings.filter(function(r) { return r && r.ok; });
  var own = answered.filter(function(r) { return r.height_source === "self" && sanitizeHeight(r.block) !== null; });
  var reason = seedReasonOf(answered.length, own.length);   // one text for the seed-level rule (status-rule.mjs)
  return { answered: answered.length, ownHeights: own.length, sufficient: reason === null, reason: reason };
}
