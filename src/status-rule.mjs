// status-rule.mjs — how one round's readings become the public reading. Pure: no imports, no clock, no I/O.
//
// One text for the rule: the agent (computeCanonicalState and evaluatePublicIncidents in agent.mjs), the pre-restart
// check (tools/validator-set-probe.mjs) and the tests all call these functions.
// Runtime tests: bun src/status-rule.test.mjs
//
// A witness is a node DNO read directly this round that named its own key and reported its own height:
//   - a configured public seed, or
//   - an ACTIVE validator that answered as the key the validator list holds, at the address it published on chain.
//
// Two or more seed heights: the seeds decide, as before 1.2, and no validator is read (mode seeds_only).
// One seed height h: a validator within the band of h counts with it; one further away is left out. With at least one
//   counted there is a reading (seed_and_validators). Agreement compares the seed with the validator closest to it, and
//   the published median is the seed's own height: a validator can count with the seed, and it can neither count
//   against it nor pull the reading towards a number of its own. When the validators within the band are not more than
//   half of those that gave a height, confidence is uncertain and the reading says how many were left out.
// No seed height: validators within the band of the upper median of all validator heights are counted; a reading
//   needs at least two of them and more than half of those that gave a height (validators_only). Agreement is taken
//   around that same median, so every counted validator is aligned and validators alone can never read weak.
// Anything else is no reading: status unknown, as before (insufficient).

export const RULE = Object.freeze({
  bandBlocks: 25,            // aligned: within this many blocks of the upper median; in the fallback, of the one seed
  strongSpreadBlocks: 20,    // strong: every compared height aligned and the spread at most this
  moderateShare: 0.6,        // moderate: at least this share of the compared heights aligned
  confidenceGapBlocks: 50,   // confidence is uncertain when the compared heights are further apart than this
  standstillSeconds: 1800,   // a reading that would be stable reads degraded after this long without a new height
  clockForgetSeconds: 600,   // the top is given up when sources below it have been rising for longer than this
  clockRememberSeconds: 86400,   // a top given up is remembered this long: a source back on it restores the old count; also the stored rounds replayed at start
  witnessMax: 8,             // validators read in one round, at most (witnesses.mjs)
  candidateMaxAgeMs: 24 * 3600 * 1000   // a validator stays a candidate this long after the last agreed list
});

export const MODES = Object.freeze(["seeds_only", "seed_and_validators", "validators_only", "insufficient"]);

const isHeight = function(h) { return typeof h === "number" && Number.isInteger(h) && h >= 0; };
const sorted = function(list) { return (Array.isArray(list) ? list : []).filter(isHeight).slice().sort(function(a, b) { return a - b; }); };
// The middle height, or the upper of the two middle heights when the count is even.
export function upperMedian(heights) { var s = sorted(heights); return s.length ? s[Math.floor(s.length / 2)] : null; }

// Agreement among compared heights: the 1.1 function. reference, when given, is the height the others are measured
// from and the one published as the median (the one seed's height, or the validators' median); without it, the
// compared heights' own upper median, as in 1.1.
export function agreementOf(heights, reference) {
  var hs = sorted(heights);
  if (!hs.length) return { state: "unknown", aligned_nodes: null, total_nodes: 0, median_block: null, block_spread: null };
  var medianBlock = isHeight(reference) ? reference : hs[Math.floor(hs.length / 2)];
  var blockSpread = hs[hs.length - 1] - hs[0];
  var alignedCount = hs.filter(function(h) { return Math.abs(h - medianBlock) <= RULE.bandBlocks; }).length;
  var state;
  if (alignedCount === hs.length && blockSpread <= RULE.strongSpreadBlocks) state = "strong";
  else if (alignedCount >= Math.ceil(hs.length * RULE.moderateShare)) state = "moderate";
  else state = "weak";
  return { state: state, aligned_nodes: alignedCount, total_nodes: hs.length, median_block: medianBlock, block_spread: blockSpread, max_block: hs[hs.length - 1], min_block: hs[0] };
}

// Why the seeds alone give no reading, or null when two of them gave their own height. seedsSufficient (seed-read.mjs)
// and assess() both use it.
export function seedReasonOf(answered, ownHeights) { return answered < 2 ? "too_few_answers" : ownHeights < 2 ? "too_few_heights" : null; }

// Which heights are counted this round, and which are compared.
// seedHeights: the own heights of the seeds that gave one. validatorHeights: the own heights of the validator candidates
// read this round, or null when none were read (two seeds gave a height, or there is no candidate).
// -> { mode, counted, compare, reference, seedCount, validatorsWithHeight, validatorsCounted }
//    counted: the heights of every witness that counts (sorted). compare: the heights agreement is computed from.
//    reference: the height the compared are measured from and the published median, when it is not the compared
//    heights' own median: the one seed's height, or the upper median of every validator height read.
export function selectWitnesses(input) {
  var seeds = sorted(input && input.seedHeights);
  var read = !!input && Array.isArray(input.validatorHeights);
  var vals = read ? sorted(input.validatorHeights) : [];
  var out = { mode: "insufficient", counted: seeds.slice(), compare: seeds.slice(), reference: null, seedCount: seeds.length,
    validatorsWithHeight: read ? vals.length : null, validatorsCounted: read ? 0 : null };
  if (seeds.length >= 2) { out.mode = "seeds_only"; out.validatorsWithHeight = null; out.validatorsCounted = null; return out; }
  if (!read) return out;
  if (seeds.length === 1) {
    var h = seeds[0];
    var near = vals.filter(function(v) { return Math.abs(v - h) <= RULE.bandBlocks; });
    if (!near.length) return out;
    // The closest validator; of two equally close, the lower (the one that claims less).
    var closest = near.reduce(function(best, v) { return Math.abs(v - h) < Math.abs(best - h) ? v : best; }, near[0]);
    out.mode = "seed_and_validators"; out.counted = sorted([h].concat(near)); out.compare = sorted([h, closest]); out.reference = h;
    out.validatorsCounted = near.length;
    return out;
  }
  var m = upperMedian(vals);
  var around = vals.filter(function(v) { return Math.abs(v - m) <= RULE.bandBlocks; });
  if (around.length < 2 || around.length * 2 <= vals.length) return out;   // at least two counted, and more than half of those that gave a height
  out.mode = "validators_only"; out.counted = around; out.compare = around.slice(); out.reference = m; out.validatorsCounted = around.length;
  return out;
}

// ---- the height clock -----------------------------------------------------------------------------------------------
// What DNO can say about new blocks is what the nodes it reads show about themselves, round after round.
//
// A source is a node whose own height can move the clock: each public seed that gave its own height, by its name, in a
// round that has a reading; with no seed height, the validators' median as one source. Beside a seed no validator is a
// source. A round without a reading has no source and does not move the clock.
//
// The clock keeps each source's last answer and the highest height read (the top).
//   A new height: a source above its own last answer, that is the highest of its round and above the top. Nothing else
//     is one. A change in which nodes answered never is: a node heard for the first time, or back at a height it showed
//     before, shows nothing new about itself. So a seed that catches up, a seed that misses a round and a validator
//     that alternates between two heights produce none.
//   A height above the top from a source that did not rise to it: the top moves there, the count starts again and the
//     round claims nothing (DNO did not see it arrive).
//   The top again: read again. Below the top: no new height.
//   Start-over: when a source has been rising below the top for more than RULE.clockForgetSeconds (a rise that long
//     ago, one in this round, and no pause between rises longer than that) and this round has nothing at the top,
//     either a chain on a lower base is producing or the nodes DNO reads are catching up; DNO cannot tell which. It
//     follows the lower heights, claims nothing in that round, and remembers the old top for RULE.clockRememberSeconds.
//     While it is remembered the count runs from each rise of the followed heights, as a lower bound, and no arrival is
//     claimed: "Heights advancing" is not said and no time of a last new height is given. A source exactly on the old
//     top within that time was catching up, or the old top still stands: the old count is restored and that round
//     claims nothing. A source above it is an ordinary new height.
//     Whether a node still gives the old top does not decide it: a node left on an old chain would otherwise hold the
//     clock there for as long as it answers.
//     While DNO follows the lower heights, and in the round a source is back on the old top, the reading says that it
//     does (heightMovementOf: following; assess: confidence uncertain).
// The stored rounds a restart replays go through the same fold, so the live rule and the restart rule are one.

export const VALIDATORS_SOURCE = "validators:median";

// The sources of one round. seeds: [{ id, h }], the own height of each seed that gave one, by name. validatorHeights:
// the own heights of the validator candidates read this round, or null. -> [{ id, h }], empty when the round has no
// reading (selectWitnesses: insufficient).
export function clockSources(seeds, validatorHeights) {
  var own = (Array.isArray(seeds) ? seeds : []).filter(function(x) { return !!x && typeof x.id === "string" && isHeight(x.h); });
  var w = selectWitnesses({ seedHeights: own.map(function(x) { return x.h; }), validatorHeights: Array.isArray(validatorHeights) ? validatorHeights : null });
  if (w.mode === "insufficient") return [];
  if (own.length) return own.map(function(x) { return { id: x.id, h: x.h }; });
  return [{ id: VALIDATORS_SOURCE, h: w.reference }];
}

// last: each source's last answer. top: the highest height read. topSince: when the count began (the last new height,
// or the round the top was first read). compared: a later round has been set against the top, so "no new height for
// N s" can be said. seen: topSince is a new height DNO saw arrive. lowSince, lowLast: the first and the latest rise of
// a source below the top (below the remembered top, after a start-over) in the current run of such rises, or null.
// gave: the top given up at a start-over { top, since, seen, at }, or null. hold: this round claims nothing.
export function newHeightClock() { return { last: {}, top: null, topSince: null, compared: false, seen: false, lowSince: null, lowLast: null, gave: null, hold: false }; }

// One round: its sources (clockSources) at its observation time in ms. A round without a source returns the state as it is.
export function stepHeightClock(state, sources, at) {
  var s0 = state || newHeightClock(), src = [], ids = {};
  (Array.isArray(sources) ? sources : []).forEach(function(x) { if (x && typeof x.id === "string" && isHeight(x.h) && !ids[x.id]) { ids[x.id] = true; src.push(x); } });
  if (!src.length || typeof at !== "number" || !isFinite(at)) return s0;
  var s = { last: Object.assign({}, s0.last), top: s0.top, topSince: s0.topSince, compared: s0.compared, seen: s0.seen, lowSince: s0.lowSince, lowLast: s0.lowLast,
    gave: s0.gave ? { top: s0.gave.top, since: s0.gave.since, seen: s0.gave.seen, at: s0.gave.at } : null, hold: false };
  var forget = RULE.clockForgetSeconds * 1000;
  var ceiling = s0.gave ? s0.gave.top : s0.top;   // rises below this are the run that a start-over rests on
  var max = null, riser = null, lowRise = false;  // the round's highest height; the highest height a source rose to from its own last answer; a source rose below the ceiling
  src.forEach(function(x) {
    if (max === null || x.h > max) max = x.h;
    var before = s0.last[x.id];
    if (isHeight(before) && x.h > before) {
      if (riser === null || x.h > riser) riser = x.h;
      if (ceiling !== null && x.h < ceiling) lowRise = true;
    }
    s.last[x.id] = x.h;
  });
  if (lowRise) {
    if (s.lowSince === null || at - s.lowLast > forget) s.lowSince = at;   // a pause longer than the forget time starts the run again
    s.lowLast = at;
  }
  var again = function() { s.top = max; s.topSince = at; s.compared = false; s.seen = false; };   // the count starts here; nothing is claimed
  if (s.top === null) { again(); return s; }
  if (s.gave) {
    if (at - s.gave.at > RULE.clockRememberSeconds * 1000 || max > s.gave.top) s.gave = null;
    else if (max === s.gave.top) {            // back on the old top: the old count, and this round claims nothing
      s.top = s.gave.top; s.topSince = s.gave.since; s.seen = s.gave.seen; s.compared = true; s.gave = null; s.hold = true;
      return s;
    }
  }
  if (max > s.top) {
    if (riser === max) {                      // a new height
      s.top = max; s.topSince = at; s.compared = true;
      // After a start-over, while the old top is remembered, DNO does not say it saw a new height arrive: the nodes it
      // follows may be catching up. The count still runs from here (a lower bound), so a stop of those heights shows.
      s.seen = !s.gave;
      if (!s.gave) { s.lowSince = null; s.lowLast = null; }   // the top is producing: what rises below it is catching up
    } else again();
    return s;
  }
  if (max === s.top) { s.compared = true; return s; }
  if (lowRise && at - s.lowSince > forget) {  // start-over: the lower heights are followed, the top is remembered
    if (!s.gave) s.gave = { top: s.top, since: s.topSince, seen: s.seen, at: at };
    again();
    return s;
  }
  s.compared = true;
  return s;
}

// What is published about height movement at observedAt (ms). hadHeight: the latest round had a source.
// cfg: { roundSeconds, stalledSeconds }: "Heights advancing" within two rounds of a new height DNO saw arrive; "no new
// height for N min" from stalledSeconds on. Status changes only at RULE.standstillSeconds (assess).
//   staticSeconds: seconds since the last new height; without one DNO saw arrive, since the round the top was first read
//     (a lower bound). null before any comparison, without a source this round, on hold, or while the host clock is
//     behind the count's own start (a clock set back: nothing is said until it has passed it again).
//   advancedAt: when the last new height arrived (ms), if DNO saw it arrive. since: the moment staticSeconds is counted
//     from (ms), whenever staticSeconds is published: a condition record opens with it. The caller formats both.
//   following: after a start-over, DNO is following heights below one it read in the last RULE.clockRememberSeconds,
//     or a source is back on that height in this round. A chain restarted lower and nodes catching up look the same.
export function heightMovementOf(state, observedAt, hadHeight, cfg) {
  var s = state || newHeightClock(), c = cfg || {};
  var timed = typeof observedAt === "number" && observedAt > 0 && s.topSince !== null && observedAt >= s.topSince;
  var staticSeconds = s.compared && !s.hold && !!hadHeight && timed ? Math.round((observedAt - s.topSince) / 1000) : null;
  return {
    staticSeconds: staticSeconds,
    advancedAt: s.seen && !s.hold && timed ? s.topSince : null,
    since: staticSeconds !== null ? s.topSince : null,
    advancing: staticSeconds !== null && s.seen && staticSeconds <= 2 * (c.roundSeconds || 0),
    stalled: staticSeconds !== null && typeof c.stalledSeconds === "number" && staticSeconds >= c.stalledSeconds,
    following: !!hadHeight && (s.gave !== null || s.hold)
  };
}

const UNKNOWN_TEXT = Object.freeze({
  no_observation: "no public observation has completed yet",
  stale: "the last public observation is older than 300 s",
  too_few_answers: "fewer than 2 public nodes answered",
  too_few_heights: "fewer than 2 public nodes reported their own block height"
});
// Why there is no reading, in words. While no validator was read these are the 1.1 texts. When validators were read
// and formed no reading the text says so: "fewer than 2 public nodes answered" alone would leave them out.
// validatorsWithHeight: how many of the validators read answered as listed with their own height; null when none was
// read. The text says what they did and no more: validators that gave no height are not said to disagree.
function unknownTextOf(reason, seedCount, validatorsWithHeight) {
  if (!reason) return "";
  if (reason === "no_observation" || reason === "stale" || validatorsWithHeight === null) return UNKNOWN_TEXT[reason] || "";
  var seeds = (seedCount === 1 ? "one" : "no") + " public seed reported its own block height";
  if (validatorsWithHeight === 0) return seeds + ", and no validator answered as listed with its own height";
  if (seedCount === 1) return seeds + ", and no validator that answered as listed is within 25 blocks of it";
  if (validatorsWithHeight === 1) return seeds + ", and one validator answered as listed with its own height, where a reading needs two";
  return seeds + ", and no majority of the validators that answered as listed is within 25 blocks of their median";
}
const plural = function(n, one, many) { return n === 1 ? one : many; };
const validatorsWord = function(n) { return n + " " + plural(n, "validator", "validators"); };
const blocksWord = function(n) { return n + " " + plural(n, "block", "blocks"); };
const capital = function(s) { return s.charAt(0).toUpperCase() + s.slice(1); };
// Said in every reading made while DNO follows lower heights after a start-over.
const FOLLOWING_TEXT = "DNO has been following heights below the highest height it read in the last 24 hours";
// status_reason's two phrases about agreement: the 1.1 words while the seeds decide.
function reasonPhrases(mode, n) {
  if (mode === "seed_and_validators") return { aligned: "one public seed and " + validatorsWord(n) + " aligned", reduced: "Agreement reduced between one public seed and the validator closest to it" };
  if (mode === "validators_only") return { aligned: validatorsWord(n) + " aligned, no public seed", reduced: "Agreement reduced among " + validatorsWord(n) + ", no public seed" };
  return { aligned: "public nodes aligned", reduced: "Agreement reduced among public nodes" };
}

// The whole public reading of one round.
// input: {
//   timeReason:   null | "no_observation" | "stale"   (the observation's age; decided by the caller's clock)
//   seedReason:   optional; seedsSufficient(seeds).reason when the caller has it, else derived here by the same rule
//   seedsTotal, seedsAnswered: configured seeds, and those that answered /info
//   seedHeights:  the own heights of the seeds that gave one
//   validators:   null (none read) | { read, heights, listAgreedAt }   (candidates read this round)
//   maxIncidentSeverity: "none" | "info" | "warning" | "critical"; publicIncidentCount: public incidents that feed status
//   movement:     { staticSeconds, advancing, stalled, following, staticSince }   (heightMovementOf(); staticSince: "YYYY-MM-DD HH:MM:SS" UTC, or null)
// }
export function assess(input) {
  var i = input || {};
  var seedHeights = sorted(i.seedHeights);
  var pubTotal = Number.isInteger(i.seedsTotal) ? i.seedsTotal : 0;
  var pubReachable = Number.isInteger(i.seedsAnswered) ? i.seedsAnswered : 0;
  var v = i.validators && typeof i.validators === "object" ? i.validators : null;
  var w = selectWitnesses({ seedHeights: seedHeights, validatorHeights: v ? v.heights : null });
  var move = i.movement || {};
  var staticSeconds = typeof move.staticSeconds === "number" ? move.staticSeconds : null;
  var sev = i.maxIncidentSeverity || "none";
  var incidentCount = Number.isInteger(i.publicIncidentCount) ? i.publicIncidentCount : 0;

  // Data quality: the observation's age first; then two seed heights, or a fallback that formed a reading.
  var reason = i.timeReason || null;
  if (!reason && w.mode === "insufficient") reason = i.seedReason || seedReasonOf(pubReachable, seedHeights.length) || "too_few_heights";
  var sufficient = !reason;
  var unknownText = unknownTextOf(reason, seedHeights.length, v ? sorted(v.heights).length : null);
  var mode = sufficient ? w.mode : "insufficient";
  var n = sufficient && w.validatorsCounted !== null ? w.validatorsCounted : 0;   // validators counted in this reading
  // Beside one seed: validators that gave a height more than the band away from it. They are left out and move
  // nothing; when those within the band are not more than half, the reading says so in confidence and risk.
  var withHeight = mode === "seed_and_validators" ? w.validatorsWithHeight : 0, leftOut = mode === "seed_and_validators" ? withHeight - n : 0;
  var seedOutnumbered = mode === "seed_and_validators" && n * 2 <= withHeight;
  // After a start-over the heights DNO reads are below one it read before, and it cannot tell why: uncertain, and said.
  var following = sufficient && !!move.following;

  var agreement;
  if (!sufficient) {
    // Nothing was compared. total_nodes stays "seeds that reported their own height", as in 1.1.
    agreement = { state: "unknown", aligned_nodes: null, total_nodes: seedHeights.length, median_block: (seedHeights.length === 1 && reason !== "stale") ? seedHeights[0] : null, block_spread: null };
  } else {
    agreement = agreementOf(w.compare, w.reference);   // beside one seed the median is the seed's height; with none, the validators' median
  }

  // Clear: the compared heights are at most 50 blocks apart and a seed's own height is among them. "Signals agree" is
  // said only of strong agreement: beside a moderate or weak one it would contradict the status reason.
  var confidence = "clear", confidenceReason = agreement.state === "strong" ? "Observed public signals agree" : "Compared heights are within 50 blocks of each other";
  if (!sufficient) { confidence = "uncertain"; confidenceReason = "No cross-check: " + unknownText; }
  else if (w.compare[w.compare.length - 1] - w.compare[0] > RULE.confidenceGapBlocks) { confidence = "uncertain"; confidenceReason = "Public nodes report block heights more than 50 blocks apart"; }
  else if (mode === "validators_only") { confidence = "uncertain"; confidenceReason = "No public seed reported its own height: the reading rests on validators alone"; }
  else if (seedOutnumbered) { confidence = "uncertain"; confidenceReason = leftOut + " of " + withHeight + " validators that answered as listed with a height " + plural(leftOut, "is", "are") + " more than 25 blocks from the one public seed"; }
  else if (following) { confidence = "uncertain"; confidenceReason = FOLLOWING_TEXT + ": a chain restarted lower and nodes catching up look the same from here"; }

  // Status. A standstill turns a reading that would be stable into degraded; it never touches another status.
  var status;
  if (!sufficient) status = "unknown";
  else if (sev === "critical" || agreement.state === "weak") status = "unstable";
  else if (sev === "warning" || agreement.state === "moderate") status = "degraded";
  else status = "stable";
  var still = sufficient && staticSeconds !== null && staticSeconds >= RULE.standstillSeconds;   // said in every reading it holds in
  var standstill = still && status === "stable";                                                 // changes only a stable one
  if (standstill) status = "degraded";

  var risk;
  if (status === "unknown") risk = "elevated";
  else if (status === "unstable" || sev === "critical" || agreement.state === "weak") risk = "high";
  else if (status === "degraded" || sev === "warning" || confidence === "uncertain" || agreement.state === "moderate" || (pubTotal > 2 && pubTotal - pubReachable > 1) || mode !== "seeds_only") risk = "elevated";
  else risk = "low";

  // "No new height", not "height unchanged": below the top a height DNO reads can rise without being a new one.
  var staticText = staticSeconds === null ? "" : "no new height for " + Math.floor(staticSeconds / 60) + " min";
  var stalled = !!move.stalled, advancing = !!move.advancing;
  var phrase = reasonPhrases(mode, n), aligned = phrase.aligned;

  var summary;
  if (status === "unknown") summary = "Insufficient data: " + unknownText + ".";
  else if (status === "stable") {
    if (mode === "seeds_only") summary = (pubReachable === pubTotal ? "All " + pubTotal : pubReachable + " of " + pubTotal) + " public seeds answered"
      + (seedHeights.length === pubReachable ? " and their reported heights agree." : "; " + seedHeights.length + " reported their own height, and those heights agree.");
    else if (mode === "seed_and_validators") summary = "One public seed reported its own height, and " + validatorsWord(n) + " that " + plural(n, "answers", "answer") + " as listed " + plural(n, "is", "are") + " within 25 blocks of it."
      + (leftOut > 0 ? " " + leftOut + " " + plural(leftOut, "other is", "others are") + " more than 25 blocks from it." : "");
    else summary = "No public seed reported its own height. " + validatorsWord(n) + " that answer as listed report heights within 25 blocks of each other.";
    if (incidentCount > 0) summary += " " + incidentCount + " info-level incident" + (incidentCount === 1 ? "" : "s") + " active.";
    if (stalled) summary += " " + capital(staticText) + ".";
  } else {
    var offCount = pubTotal - pubReachable, parts = [];
    // "1 of 3 public nodes": the noun follows the total. (Up to 1.1 this read "1 of 3 public node did not answer".)
    if (offCount > 0) parts.push(offCount + " of " + pubTotal + " public node" + (pubTotal === 1 ? "" : "s") + " did not answer");
    if (incidentCount > 0) parts.push(incidentCount + " active incident" + (incidentCount === 1 ? "" : "s"));
    if (still) parts.push(staticText);
    parts.push("agreement " + agreement.state);
    var of = mode === "seed_and_validators" ? "one public seed and " + validatorsWord(n)
      : mode === "validators_only" ? validatorsWord(n) + ", with no public seed" : "the public seeds";
    summary = (status === "degraded" ? "Degraded reading of " : "Unstable reading of ") + of + ": " + parts.join("; ") + ".";
  }

  if (following) summary += " " + FOLLOWING_TEXT + ".";

  var statusReason;
  if (status === "stable") statusReason = advancing ? "Heights advancing; " + aligned : stalled ? capital(aligned) + "; " + staticText : capital(aligned);
  else if (status === "unstable") statusReason = agreement.state === "weak" ? "Significant disagreement among public node heights" : sev === "critical" ? "Critical incidents active" : "Network operability impaired";
  else if (status === "degraded") statusReason = sev === "warning" ? "Warning-level incidents active" : agreement.state === "moderate" ? phrase.reduced : capital(staticText) + "; " + aligned;
  else statusReason = "Insufficient data: " + unknownText;

  // A condition record's text is fixed when the record opens and the record can outlast its cause (a degraded reading
  // may go on for another reason), so the text is anchored at both ends: when the standstill began, and the opening.
  var conditionReason = standstill ? (move.staticSince ? "No new height from " + move.staticSince + " UTC until this record opened" : "No new height for " + Math.floor(RULE.standstillSeconds / 60) + " min or more when this record opened") : statusReason;

  var riskFactors = [];
  if (pubTotal > 2 && pubTotal - pubReachable > 1) riskFactors.push("Only " + pubReachable + " of " + pubTotal + " public nodes answered — limited cross-checking");
  if (mode === "seed_and_validators") riskFactors.push("one public seed reported its own height; " + validatorsWord(n) + " " + plural(n, "is", "are") + " within 25 blocks of it");
  if (leftOut > 0) riskFactors.push(leftOut + " of " + withHeight + " validators that answered as listed with a height " + plural(leftOut, "is", "are") + " more than 25 blocks from the seed");
  if (mode === "validators_only") riskFactors.push("no public seed reported its own height; the reading rests on " + validatorsWord(n));
  if (sev === "warning") riskFactors.push("warning-level incidents active");
  if (sev === "critical") riskFactors.push("critical incidents active");
  if (agreement.state === "moderate") riskFactors.push("agreement is moderate, not strong");
  if (agreement.state === "weak") riskFactors.push("agreement is weak");
  if (still) riskFactors.push(staticText);
  if (following) riskFactors.push("following heights below the highest height read in the last 24 hours");

  var agreementReason;
  if (agreement.state === "unknown") agreementReason = "Not compared: " + unknownText;
  else if (mode === "seed_and_validators") agreementReason = "One public seed and " + (n === 1 ? "1 validator" : "the closest of " + validatorsWord(n)) + " within ±25 blocks of it (spread: " + blocksWord(agreement.block_spread) + ")";
  else agreementReason = agreement.aligned_nodes + " of " + agreement.total_nodes + (mode === "validators_only" ? " validators" : " public nodes") + " with a height within ±25 blocks of the median (spread: " + blocksWord(agreement.block_spread) + ")";

  var witnesses = {
    mode: mode,
    counted: sufficient ? w.counted.length : 0,   // heights the reading rests on; none when there is no reading
    public_seeds: { configured: pubTotal, answered: pubReachable, own_height: seedHeights.length },
    validators: v ? { read: Number.isInteger(v.read) ? v.read : 0, own_height: sorted(v.heights).length, counted: n, list_agreed_at: v.listAgreedAt || null } : null
  };

  return { status: status, risk: risk, data_quality: sufficient ? "sufficient" : "insufficient", data_quality_reason: reason, confidence: confidence,
    confidence_reason: confidenceReason, agreement: agreement, summary: summary, status_reason: statusReason, condition_reason: conditionReason,
    risk_factors: riskFactors, agreement_reason: agreementReason, witnesses: witnesses, standstill: standstill };
}

// Condition records follow status. One round: which records open, which close.
// counters: { obsBad, obsGood, degBad, degGood, unsBad, unsGood } (updated in place).
// reading: { status, data_quality }. active: { visibility, degraded, unstable } (records open now).
// cfg: { open, resolve } consecutive rounds. While visibility is poor, no degraded or unstable record opens: DNO does
// not describe a condition it cannot see.
// -> { open, resolve, actions }: the record names that open and close, and the same as one ordered list
//    [{ record, action }] (visibility, degraded, unstable; a record's open before its close), the order to apply them in.
export function stepConditionRecords(counters, reading, active, cfg) {
  var c = counters, actions = [];
  var obsBad = reading.status === "unknown" || reading.data_quality === "insufficient";
  var degBad = !obsBad && reading.status === "degraded";
  var unsBad = !obsBad && reading.status === "unstable";
  var one = function(record, bad, badKey, goodKey) {
    if (bad) { c[badKey]++; c[goodKey] = 0; } else { c[goodKey]++; c[badKey] = 0; }
    if (!active[record] && c[badKey] >= cfg.open) actions.push({ record: record, action: "open" });
    if (active[record] && c[goodKey] >= cfg.resolve) actions.push({ record: record, action: "resolve" });
  };
  one("visibility", obsBad, "obsBad", "obsGood");
  one("degraded", degBad, "degBad", "degGood");
  one("unstable", unsBad, "unsBad", "unsGood");
  var names = function(action) { return actions.filter(function(a) { return a.action === action; }).map(function(a) { return a.record; }); };
  return { open: names("open"), resolve: names("resolve"), actions: actions };
}
