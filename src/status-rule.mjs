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
  clockForgetSeconds: 600,   // a height is given up when nothing has been read at it for longer than this while the highest height read kept rising below it
  clockRememberSeconds: 86400,   // a height given up is remembered this long after the last start-over: no arrival is claimed meanwhile; also the stored rounds replayed at start
  witnessMax: 8,             // validators read in one round, at most (witnesses.mjs)
  candidateMaxAgeMs: 24 * 3600 * 1000   // a validator stays a candidate this long after its last answer as listed at the seeds' height
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
// What DNO has read: the own height of a public seed, in every round, with or without a reading; and the height of a
//   validator DNO counted in a reading (within the band of the one seed, or of the validators' median when they stand
//   alone). A validator that was left out is not a witness: a height only it has shown has not been read.
// What the count stands on (the round's sources, clockRound):
//   - each seed that gave its own height, by its name. Beside a seed no validator moves the count: it can count with
//     the seed, not against it;
//   - with no seed height and a reading from validators alone: the height more than half of the counted validators
//     have reached (their lower median), as one source. One validator ahead of the others moves nothing; a validator
//     that stops answering cannot raise it above what the others show.
// Only a seed is a node: it has a last answer, it can rise, and it can fall back. The validators' height is none of
// these: it changes with which validators answer, so it is taken for what the count stands on and for nothing else.
// The clock keeps each seed's last answer; the highest height the count has stood on and since when (top, topSince);
// and the highest height read, with the time it was first read (read, readSince).
//   The count runs from topSince. It moves up only when the round's highest source is above the top:
//     - above everything read: the count starts in this round;
//     - at a height DNO had read, or below one it had read (a seed stepping up to what a counted validator showed
//       before it): the top moves there, and the count runs from the first reading of the highest height read until
//       then. DNO keeps that one time, not one for every height: when a height between the two was read earlier, the
//       count is younger than that reading. It never runs from before DNO first read the height it stands on, or a
//       higher one.
//   A new height DNO saw arrive: a SEED above its own last answer, at the highest seed height of its round, and above
//     everything read before that round. Nothing else is one: a node heard for the first time, a node back at a
//     height it showed before, a seed catching up, a change in which nodes answered. With validators alone DNO gives
//     the count and takes no arrival from them: a median is not a node.
//   An arrival is no longer claimed (seen is false until the next one) once the highest height read in a round is
//     more than RULE.bandBlocks below the height that arrived, which is the height the count stands on: the seed may
//     have taken that height back, the nodes DNO reads may be on a lower chain, or the seed that showed it may have
//     stopped answering while the others stand far below. One seed that falls back while another still stands within
//     the band of that height ends nothing. The count itself is not moved.
//   At the top, or below it: nothing new.
//   Start-over. When nothing has been read at the highest height DNO holds (read) for more than RULE.clockForgetSeconds
//     while the nodes it does read kept rising below it, a chain on a lower base is producing, the nodes DNO reads are
//     catching up, or that height was one answer far above the others, and DNO cannot tell which. "Kept rising" is a
//     run of rises (low) of the seeds, over rounds in which nothing at the held height was read:
//       - a rise: a round whose highest seed is above its own last answer, and above every answer it has given
//         since the run began. The first rise begins a run;
//       - the run is over when the held height is read again (by a seed, or by a counted validator); when a seed fell
//         back (more than RULE.bandBlocks below its own last answer: it is on another height now); when the round's
//         highest seed stands more than RULE.bandBlocks above the latest rise without having risen (a node that holds
//         a height of its own; within the band it stands with the rising ones, and only makes them wait); and after
//         more than RULE.clockForgetSeconds without a rise. The next rise begins a new run;
//       - a round that rests on validators alone is no round of the run: nothing rises in it, and it ends the run
//         only by reading the held height. With validators alone DNO does not give a height up: that their height
//         went up does not show that a node rose.
//     A rise in a run that began more than RULE.clockForgetSeconds before is the start-over. So a node going back and
//     forth between two heights never gets there; and a node that keeps giving the held height, or a height of its
//     own above the rising ones, holds the count for as long as it is read at least every ten minutes: DNO cannot
//     tell it from the head of a chain that stands still.
//     At the start-over DNO gives the held height up: it follows the lower heights from this round, says so
//     (heightMovementOf: following; assess: confidence uncertain), and claims no arrival while the height given up is
//     remembered: for RULE.clockRememberSeconds after the last time it gave one up. While it follows, the count runs
//     by the same rule over what it reads from that round on.
//     Reading the height given up again, or a higher one (a source, or a counted validator), ends this: what DNO had
//     read counts again, so the count runs from the first reading of the height given up, and a height above it
//     starts the count as any height above everything read does.
// The stored rounds a restart replays go through the same fold, so the live rule and the restart rule are one.

export const VALIDATORS_SOURCE = "validators:majority";

// The middle height, or the lower of the two middle heights when the count is even. It is above a height exactly when
// more than half of the heights are: 2 of 2, 2 of 3, 3 of 4.
export function lowerMedian(heights) { var s = sorted(heights); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; }

// One public round, as the clock takes it: the agent, the replay's tests and the searches all call this.
// seeds: [{ id, h }], one per seed read (h null when it gave no height of its own). validatorHeights: the own heights
// of the validators that answered as listed this round, or null when no validator was read (the list assess() gets).
// -> { sources: for stepHeightClock: each seed that gave its own height; with none and a reading from validators
//      alone, [{ id: VALIDATORS_SOURCE, h: the lower median of the counted validators }]; else none;
//      counted: the highest height among the validators counted in this round's reading, or null;
//      reading: the round has a reading (heightMovementOf publishes only then);
//      row: what the round keeps of its validators for the replay: { max } beside a seed, { h, max } from validators
//      alone; else null }.
export function clockRound(seeds, validatorHeights) {
  var own = (Array.isArray(seeds) ? seeds : []).filter(function(x) { return !!x && typeof x.id === "string" && isHeight(x.h); });
  var heights = Array.isArray(validatorHeights) ? sorted(validatorHeights) : null;
  var w = selectWitnesses({ seedHeights: own.map(function(x) { return x.h; }), validatorHeights: heights });
  var only = w.mode === "validators_only", beside = w.mode === "seed_and_validators";
  var mine = only ? w.counted : beside ? heights.filter(function(h) { return Math.abs(h - w.reference) <= RULE.bandBlocks; }) : [];   // the validators counted
  var counted = mine.length ? mine[mine.length - 1] : null;
  var sources = own.length ? own.map(function(x) { return { id: x.id, h: x.h }; }) : only ? [{ id: VALIDATORS_SOURCE, h: lowerMedian(mine) }] : [];
  return { sources: sources, counted: counted, reading: w.mode !== "insufficient",
    row: only ? { h: sources[0].h, max: counted } : counted !== null ? { max: counted } : null };
}

// last: each seed's last answer. top: the highest height the count has stood on; topSince: since when it counts (ms).
// seen: topSince is a new height DNO saw arrive. read, readSince: the highest height read, and when it was first read.
// low: a run of rises below read, { h, since, last, hi }: the height of its latest rise, when it began, when that
// latest rise was, and each seed's highest answer since it began; null when none is on. gave: the height given up
// at a start-over, { top, since, at }: the height, when it was first read, and when DNO last gave a height up.
export function newHeightClock() { return { last: {}, top: null, topSince: null, seen: false, read: null, readSince: null, low: null, gave: null }; }

const isTime = function(t) { return typeof t === "number" && isFinite(t); };

// One round: its sources (clockRound) at its observation time in ms, and the highest height among the validators
// counted in its reading (clockRound: counted), or null. A round without a source returns the state as it is.
export function stepHeightClock(state, sources, at, counted) {
  var s0 = state || newHeightClock(), src = [], ids = {};
  (Array.isArray(sources) ? sources : []).forEach(function(x) { if (x && typeof x.id === "string" && isHeight(x.h) && !ids[x.id]) { ids[x.id] = true; src.push(x); } });
  if (!src.length || !isTime(at)) return s0;
  var held = isHeight(s0.top) && isTime(s0.topSince) && isHeight(s0.read) && isTime(s0.readSince);
  var s = { last: Object.assign({}, s0.last), top: held ? s0.top : null, topSince: held ? s0.topSince : null, seen: held && s0.seen === true, read: held ? s0.read : null, readSince: held ? s0.readSince : null,
    low: held && s0.low && isHeight(s0.low.h) && isTime(s0.low.since) && isTime(s0.low.last) ? { h: s0.low.h, since: s0.low.since, last: s0.low.last, hi: Object.assign({}, s0.low.hi) } : null,
    gave: held && s0.gave && isHeight(s0.gave.top) && isTime(s0.gave.since) && isTime(s0.gave.at) ? { top: s0.gave.top, since: s0.gave.since, at: s0.gave.at } : null };
  var max = null;                                  // the round's highest source
  src.forEach(function(x) { if (max === null || x.h > max) max = x.h; });
  // Only a seed is a node. risers: the seeds at the round's highest height that are above their own last answers.
  // fell: a seed is more than the band below its own last answer (it is on another height now). seeds: a seed is among
  // the round's sources (false: the round rests on validators alone).
  var risers = [], fell = false, seeds = false;
  src.forEach(function(x) {
    if (x.id === VALIDATORS_SOURCE) return;
    seeds = true;
    var before = s0.last ? s0.last[x.id] : null;
    if (isHeight(before)) {
      if (x.h > before && x.h === max) risers.push(x.id);
      else if (before - x.h > RULE.bandBlocks) fell = true;
    }
    s.last[x.id] = x.h;
  });
  var roundRead = isHeight(counted) && counted > max ? counted : max;   // the highest height read in this round
  if (s.top === null) { s.top = max; s.topSince = at; s.read = roundRead; s.readSince = at; return s; }   // the first round: the count starts here
  if (s.top - roundRead > RULE.bandBlocks) s.seen = false;   // everything read is more than the band below the height that arrived: that arrival is no longer claimed

  var forget = RULE.clockForgetSeconds * 1000;
  var readBefore = s.read, readSinceBefore = s.readSince;
  if (s.gave) {
    if (at - s.gave.at > RULE.clockRememberSeconds * 1000) s.gave = null;      // forgotten
    else if (roundRead >= s.gave.top) {
      // The height given up is read again, or a higher one (by a source, or by a counted validator): what DNO had
      // read counts again, from its first reading. While it followed, everything read was below the height given up,
      // so the height the count stands on is one of those too: it is as old as that first reading.
      readBefore = s.gave.top; readSinceBefore = s.gave.since;
      s.topSince = s.gave.since; s.seen = false;
      s.gave = null;
    }
  }
  if (roundRead > readBefore) { s.read = roundRead; s.readSince = at; } else { s.read = readBefore; s.readSince = readSinceBefore; }

  if (roundRead >= readBefore) s.low = null;                // the highest height DNO holds is read in this round, or passed
  else if (seeds) {                                         // a round that rests on validators alone is no round of the run
    if (s.low && (fell || at - s.low.last > forget)) s.low = null;   // a seed fell back by more than the band, or a pause: the run of rises is over
    // A rise of the run: the round's highest seed is above its own last answer, and above every answer it gave in this run.
    var up = risers.filter(function(id) { return !s.low || !isHeight(s.low.hi[id]) || max > s.low.hi[id]; });
    if (up.length) {
      if (s.low && at - s.low.since > forget) {
        // Start-over: the held height is given up and remembered; the lower heights are followed from this round.
        s.gave = s.gave ? { top: s.gave.top, since: s.gave.since, at: at } : { top: readBefore, since: readSinceBefore, at: at };   // the first height given up stays the one remembered: it is the highest
        s.top = max; s.topSince = at; s.seen = false; s.read = roundRead; s.readSince = at; s.low = null;
        return s;
      }
      if (!s.low) s.low = { h: max, since: at, last: at, hi: {} };   // a run begins
      s.low.h = max; s.low.last = at;
    } else if (!risers.length && s.low && max > s.low.h + RULE.bandBlocks) s.low = null;   // the round's highest seed stands more than the band above the rising ones: the run is over
    if (s.low) src.forEach(function(x) { if (!isHeight(s.low.hi[x.id]) || x.h > s.low.hi[x.id]) s.low.hi[x.id] = x.h; });   // each seed's highest answer of the run
  }

  if (max > s.top) {
    if (max <= readBefore) { s.top = max; s.topSince = readSinceBefore; s.seen = false; }   // a height DNO had read: as old as the first reading of the highest height read
    else { s.top = max; s.topSince = at; s.seen = risers.length > 0 && !s.gave; }           // above everything read: the count starts here; an arrival when a seed rose to it
  }
  return s;
}

// What is published about height movement at observedAt (ms). hadReading: the latest round had a reading and the
// observation is not stale; without one nothing is said (the clock still kept what the seeds showed).
// cfg: { roundSeconds, stalledSeconds }: "Heights advancing" within two rounds of a new height DNO saw arrive; "no new
// height for N min" from stalledSeconds on. Status changes only at RULE.standstillSeconds (assess).
//   staticSeconds: seconds since the count began: the last new height DNO saw arrive or, without one, the time the
//     rule counts from, which is never before the first reading of the height the count stands on, or of a higher
//     one. null without a reading, before the first round, and while the host clock is behind the count's own start
//     (a clock set back: nothing is said until it has passed it).
//   advancedAt: when the last new height arrived (ms), if DNO saw it arrive. since: the moment staticSeconds is counted
//     from (ms), whenever staticSeconds is published: a condition record opens with it. The caller formats both.
//   following: after a start-over, DNO is following heights below one it read earlier (remembered for
//     RULE.clockRememberSeconds after the last start-over). A chain restarted lower, nodes catching up, and one answer
//     far above the others look the same.
export function heightMovementOf(state, observedAt, hadReading, cfg) {
  var s = state || newHeightClock(), c = cfg || {}, on = !!hadReading;
  var timed = isTime(observedAt) && observedAt > 0 && isTime(s.topSince) && observedAt >= s.topSince;
  var staticSeconds = on && timed ? Math.round((observedAt - s.topSince) / 1000) : null;
  var seen = staticSeconds !== null && s.seen === true;
  return {
    staticSeconds: staticSeconds,
    advancedAt: seen ? s.topSince : null,
    since: staticSeconds !== null ? s.topSince : null,
    advancing: seen && staticSeconds <= 2 * (c.roundSeconds || 0),
    stalled: staticSeconds !== null && typeof c.stalledSeconds === "number" && staticSeconds >= c.stalledSeconds,
    following: on && !!s.gave
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
const FOLLOWING_TEXT = "DNO has been following heights below a height it read earlier";
// The causes DNO cannot tell apart: the third is a single answer, which no chain needs to have produced.
const FOLLOWING_WHY = ", and cannot tell why from here: a chain restarted lower, nodes catching up, and one answer far above the others look the same";
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
  else if (following) { confidence = "uncertain"; confidenceReason = FOLLOWING_TEXT + FOLLOWING_WHY; }

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
  // Beside one seed the count is the seed's, and the words say whose: validators counted beside it can show higher
  // heights meanwhile, and those are heights DNO has read.
  var besideSeed = mode === "seed_and_validators";
  var staticText = staticSeconds === null ? "" : (besideSeed ? "the seed has shown no new height for " : "no new height for ") + Math.floor(staticSeconds / 60) + " min";
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
  var noNew = besideSeed ? "No new height at the seed " : "No new height ";
  var conditionReason = standstill ? (move.staticSince ? noNew + "from " + move.staticSince + " UTC until this record opened" : noNew + "for " + Math.floor(RULE.standstillSeconds / 60) + " min or more when this record opened") : statusReason;

  var riskFactors = [];
  if (pubTotal > 2 && pubTotal - pubReachable > 1) riskFactors.push(pubReachable === 0 ? "No public seed answered" : "Only " + pubReachable + " of " + pubTotal + " public nodes answered — limited cross-checking");
  if (mode === "seed_and_validators") riskFactors.push("one public seed reported its own height; " + validatorsWord(n) + " " + plural(n, "is", "are") + " within 25 blocks of it");
  if (leftOut > 0) riskFactors.push(leftOut + " of " + withHeight + " validators that answered as listed with a height " + plural(leftOut, "is", "are") + " more than 25 blocks from the seed");
  if (mode === "validators_only") riskFactors.push("no public seed reported its own height; the reading rests on " + validatorsWord(n));
  if (sev === "warning") riskFactors.push("warning-level incidents active");
  if (sev === "critical") riskFactors.push("critical incidents active");
  if (agreement.state === "moderate") riskFactors.push("agreement is moderate, not strong");
  if (agreement.state === "weak") riskFactors.push("agreement is weak");
  if (still) riskFactors.push(staticText);
  if (following) riskFactors.push("following heights below a height read earlier");

  var agreementReason;
  if (agreement.state === "unknown") agreementReason = "Not compared: " + unknownText;
  else if (mode === "seed_and_validators") agreementReason = "One public seed and " + (n === 1 ? "1 validator" : "the closest of " + validatorsWord(n)) + " within ±25 blocks of it (spread: " + blocksWord(agreement.block_spread) + ")";
  // Validators alone: of those that gave a height, how many are within the band (the spread is theirs).
  else if (mode === "validators_only") agreementReason = n + " of " + w.validatorsWithHeight + " validators with a height within ±25 blocks of the median (spread: " + blocksWord(agreement.block_spread) + ")";
  else agreementReason = agreement.aligned_nodes + " of " + agreement.total_nodes + " public nodes with a height within ±25 blocks of the median (spread: " + blocksWord(agreement.block_spread) + ")";

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
