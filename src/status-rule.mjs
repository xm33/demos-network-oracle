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
  clockRememberSeconds: 86400,   // a top given up is remembered this long: a source back on it restores the old count; also the stored rounds replayed at start, and how long a validator's last answer is kept
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
// What feeds the clock (clockSources):
//   - each public seed that gave its own height, by its name, in every round, with or without a reading. A round
//     without a reading publishes nothing about heights (heightMovementOf) and still keeps what each seed showed: a
//     later round with a reading must not take a height DNO has read for a new one;
//   - validators, only in a round whose reading rests on validators alone, as one source at their median. A median is
//     not a node: it moves when another validator answers. So that source's step is what the validators show about
//     themselves, each against its own last answer (stepValidators; kept by key whenever a validator is read, beside
//     a seed too):
//       rose:  more than half of the counted validators are above their own last answers;
//       first: not that, and more than half of them are above their own last answers or heard for the first time:
//              something may be new, and DNO did not see it arrive;
//       same:  neither. Such a round shows nothing new, wherever its median stands.
//     Beside a seed no validator feeds the clock: it can count with the seed, not against it.
//
// The clock keeps each source's last answer, the highest height it has counted (the top), and the highest height DNO
// has read from a seed or from a validator counted in a reading, with the time it was first read (read, readSince).
//   A new height: a source that rose (a seed above its own last answer; the validators with "rose"), that is the
//     highest of its round and above the top. Nothing else is one. A change in which nodes answered never is: a node
//     heard for the first time, or back at a height it showed before, shows nothing new about itself. So a seed that
//     catches up, a seed that misses a round, a validator that stops answering and a validator that alternates between
//     two heights produce none.
//     DNO says it saw the height arrive only when it is also above read. A source at a height between the top and
//     read (a seed stepping up to a height a counted validator showed before it) is followed, and that height is not
//     new: the count runs from when read was first read, and no arrival is claimed. A validator cannot make the count
//     younger than the seed's own heights make it; it can make a height the seed reaches later older: as old as the
//     round in which a counted validator first showed it (within the band beside the seed; any distance when the seed
//     was too far from validators that agreed among themselves, clockRound).
//   A height above the top and above read from a source heard for the first time: the top moves there, the count
//     starts again and the round claims nothing (DNO did not see it arrive).
//   Validators with "same": nothing new was read. The count runs on, whatever their median.
//   The top again: read again. Below the top: no new height.
//   Start-over: when sources have been rising below the highest height DNO holds (read) for more than
//     RULE.clockForgetSeconds (a rise that long ago, one in this round, and no pause between rises longer than that;
//     the rises of different sources are one run) and this round has nothing at the height the count stands on,
//     either a chain on a lower base is producing or the nodes DNO reads are catching up; DNO cannot tell which. It
//     follows the lower heights, claims nothing in that round, and remembers the old height for
//     RULE.clockRememberSeconds. Two shapes of it:
//       - the sources of this round are below the top, and nothing read in this round (no source, no counted
//         validator) is at or above the top: the top is given up;
//       - the top itself has been rising under a height DNO read (validators showed it, and are not read or not
//         counted now), and nothing read in this round is at or above that height: that height is given up. Without
//         this, seeds on a producing chain below validators that stand elsewhere would read as a standstill: every
//         height they reach was "read before".
//     A rise counts for this only when it is above that source's highest answer since the run of rises began: a node
//     going back and forth between two heights rises once.
//     While the old top is remembered the count runs from each rise of the followed heights, as a lower bound, and no
//     arrival is claimed: "Heights advancing" is not said and no time of a last new height is given. A source exactly
//     on the old top within that time was catching up, or the old top still stands: the old count is restored and
//     that round claims nothing. A source above it is an ordinary new height.
//     A node that gives the old top in every round holds the count there: DNO cannot tell it from the head of a chain
//     that stands still.
//     While DNO follows the lower heights, and in the round a source is back on the old top, the reading says that it
//     does (heightMovementOf: following; assess: confidence uncertain).
// The stored rounds a restart replays go through the same fold, so the live rule and the restart rule are one.

export const VALIDATORS_SOURCE = "validators:median";
const VALIDATOR_STEPS = Object.freeze({ rose: true, first: true, same: true });
const VALIDATOR_KEY_RE = /^[0-9a-f]{1,128}$/;

// What the validators read in one round show about themselves. last: { key: { h, at } }, each validator's last answer
// and when it gave it. entries: [{ key, h }], every validator that answered as listed with its own height this round.
// reference: the median of a reading that rests on validators alone (selectWitnesses), or null in any other round.
// -> { step, next }. step: "rose", "first" or "same" among the validators within the band of reference (see above), or
// null without a reference. next: the last answers after this round; one not renewed for RULE.clockRememberSeconds is
// dropped.
export function stepValidators(last, entries, reference, at) {
  var before = last && typeof last === "object" ? last : {}, next = {}, timed = typeof at === "number" && isFinite(at);
  Object.keys(before).forEach(function(k) {
    var e = before[k];
    if (VALIDATOR_KEY_RE.test(k) && e && isHeight(e.h) && typeof e.at === "number" && isFinite(e.at) && (!timed || at - e.at <= RULE.clockRememberSeconds * 1000)) next[k] = { h: e.h, at: e.at };
  });
  var seen = {}, counted = 0, rose = 0, first = 0;
  (Array.isArray(entries) ? entries : []).forEach(function(x) {
    if (!x || typeof x.key !== "string" || !VALIDATOR_KEY_RE.test(x.key) || !isHeight(x.h) || seen[x.key]) return;
    seen[x.key] = true;
    var was = next[x.key];
    if (isHeight(reference) && Math.abs(x.h - reference) <= RULE.bandBlocks) {
      counted++;
      if (!was) first++; else if (x.h > was.h) rose++;
    }
    if (timed) next[x.key] = { h: x.h, at: at };
  });
  return { step: !isHeight(reference) ? null : rose * 2 > counted ? "rose" : (rose + first) * 2 > counted ? "first" : "same", next: next };
}

// The sources of one round. seeds: [{ id, h }], the own height of each seed that gave one, by name: sources in every
// round. validatorHeights: the own heights of the validator candidates read this round, or null. validatorStep: their
// step (stepValidators). -> [{ id, h }] for seeds; with no seed height and a reading from validators alone,
// [{ id: VALIDATORS_SOURCE, h: their median, step }]; else none.
export function clockSources(seeds, validatorHeights, validatorStep) {
  var own = (Array.isArray(seeds) ? seeds : []).filter(function(x) { return !!x && typeof x.id === "string" && isHeight(x.h); });
  if (own.length) return own.map(function(x) { return { id: x.id, h: x.h }; });
  var w = selectWitnesses({ seedHeights: [], validatorHeights: Array.isArray(validatorHeights) ? validatorHeights : null });
  if (w.mode !== "validators_only") return [];
  return [{ id: VALIDATORS_SOURCE, h: w.reference, step: VALIDATOR_STEPS[validatorStep] === true ? validatorStep : "first" }];   // a step that is not known claims nothing
}

// One public round, as the clock takes it: the agent, the replay's tests and the searches all call this.
// validatorLast: { key: { h, at } } (stepValidators). seeds: [{ id, h }], one per seed read (h null when it gave no
// height of its own). entries: [{ key, h }], every validator that answered as listed with its own height, or null when
// no validator was read. -> { sources: for stepHeightClock; counted: the highest height among the validators counted
// in this round, or null; validators: the last answers after this round; reading: the round has a reading
// (heightMovementOf publishes only then); row: what the round keeps of its validators for the replay: { max } beside a
// seed, { h, step, max } from validators alone; else null }.
// The validators counted: those of the reading (within the band of the one seed, or of their own median); and, when
// one seed is too far from them for a reading, those that would be a reading by themselves. Their heights are heights
// DNO has read: a seed that reaches them later shows nothing new.
export function clockRound(validatorLast, seeds, entries, at) {
  var own = (Array.isArray(seeds) ? seeds : []).filter(function(x) { return !!x && typeof x.id === "string" && isHeight(x.h); });
  var read = Array.isArray(entries);
  var heights = read ? entries.map(function(e) { return e ? e.h : null; }).filter(isHeight) : null;
  var w = selectWitnesses({ seedHeights: own.map(function(x) { return x.h; }), validatorHeights: heights });
  var only = w.mode === "validators_only", beside = w.mode === "seed_and_validators";
  var v = read ? stepValidators(validatorLast, entries, only ? w.reference : null, at) : { step: null, next: validatorLast && typeof validatorLast === "object" ? validatorLast : {} };
  // Beside a seed that no validator is near, the validators alone: do they agree among themselves?
  var apart = !only && !beside && read && own.length === 1 ? selectWitnesses({ seedHeights: [], validatorHeights: heights }) : null;
  var ref = only || beside ? w.reference : apart && apart.mode === "validators_only" ? apart.reference : null;
  var counted = ref === null ? null : heights.filter(function(h) { return Math.abs(h - ref) <= RULE.bandBlocks; }).reduce(function(m, h) { return m === null || h > m ? h : m; }, null);
  return { sources: clockSources(own, heights, v.step), counted: counted, validators: v.next, reading: w.mode !== "insufficient",
    row: only ? { h: w.reference, step: v.step, max: counted } : counted !== null ? { max: counted } : null };
}

// last: each source's last answer. top: the highest height counted. topSince: when the count began (the last new
// height, or the round the top was first read). compared: a later round has been set against the top, so "no new height
// for N s" can be said. seen: topSince is a new height DNO saw arrive. read, readSince: the highest height read from a
// seed or a counted validator, and when it was first read. lowSince, lowLast: the first and the latest counted rise of a source below the top (below the
// remembered top, after a start-over) in the current run of such rises, or null; runHi: each source's highest answer in
// that run. gave: what was given up at a start-over { top, since, seen, at, read, readSince }, or null. hold: this round
// claims nothing.
export function newHeightClock() { return { last: {}, top: null, topSince: null, compared: false, seen: false, read: null, readSince: null, lowSince: null, lowLast: null, runHi: {}, gave: null, hold: false }; }

// One round: its sources (clockSources) at its observation time in ms, and the highest height among the validators
// counted in its reading (clockRound: counted), or null. A round without a source returns the state as it is.
export function stepHeightClock(state, sources, at, counted) {
  var s0 = state || newHeightClock(), src = [], ids = {};
  (Array.isArray(sources) ? sources : []).forEach(function(x) { if (x && typeof x.id === "string" && isHeight(x.h) && !ids[x.id]) { ids[x.id] = true; src.push(x); } });
  if (!src.length || typeof at !== "number" || !isFinite(at)) return s0;
  var s = { last: Object.assign({}, s0.last), top: s0.top, topSince: s0.topSince, compared: s0.compared, seen: s0.seen, read: isHeight(s0.read) ? s0.read : null, readSince: isHeight(s0.read) ? s0.readSince : null, lowSince: s0.lowSince, lowLast: s0.lowLast,
    runHi: Object.assign({}, s0.runHi), gave: s0.gave ? { top: s0.gave.top, since: s0.gave.since, seen: s0.gave.seen, at: s0.gave.at, read: s0.gave.read, readSince: s0.gave.readSince } : null, hold: false };
  var forget = RULE.clockForgetSeconds * 1000;
  var ceiling = s0.gave ? s0.gave.top : isHeight(s0.read) ? s0.read : s0.top;   // rises below this are the run that a start-over rests on: the highest height DNO holds
  var max = null, riser = null, low = [], same = false;   // the round's highest height; the highest height a source rose to; the sources that rose below the ceiling; validators that showed nothing new
  src.forEach(function(x) {
    if (max === null || x.h > max) max = x.h;
    var before = s0.last[x.id];
    var rose = typeof x.step === "string" ? x.step === "rose" : isHeight(before) && x.h > before;
    if (x.step === "same") same = true;
    if (rose) {
      if (riser === null || x.h > riser) riser = x.h;
      if (ceiling !== null && x.h < ceiling) low.push(x);
    }
    s.last[x.id] = x.h;
  });
  var lowRise = false;
  if (low.length) {
    if (s.lowSince === null || at - s.lowLast > forget) { s.lowSince = at; s.runHi = {}; }   // a pause longer than the forget time starts the run again
    low.forEach(function(x) {
      if (isHeight(s.runHi[x.id]) && x.h <= s.runHi[x.id]) return;   // back at a height it gave in this run: not a rise of the run
      s.runHi[x.id] = x.h; lowRise = true;
    });
    if (lowRise) s.lowLast = at;
  }
  // What this round read: its sources, and the validators counted in its reading. Whether that is new is decided
  // against what had been read before this round.
  var readBefore = s.read, readSinceBefore = s.readSince, roundRead = isHeight(counted) && counted > max ? counted : max;
  if (readBefore === null || roundRead > readBefore) { s.read = roundRead; s.readSince = at; }
  var again = function() { s.top = max; s.topSince = at; s.compared = false; s.seen = false; };   // the count starts here; nothing is claimed
  // A start-over: the height given up is remembered with its count and with what DNO had read up to it; the lower
  // heights are followed from this round. While lower heights are already followed, the height first given up stays
  // the one remembered, and a height read since then above everything read with it is kept with it: it was read on
  // the heights given up.
  var giveUp = function(height, since, seen) {
    if (!s.gave) s.gave = { top: height, since: since, seen: seen, at: at, read: readBefore, readSince: readSinceBefore };
    else if (isHeight(readBefore) && (!isHeight(s.gave.read) || readBefore > s.gave.read)) { s.gave.read = readBefore; s.gave.readSince = readSinceBefore; }   // (what was read with a height is never below it, so a height above that is above the remembered one too)
    again();
    s.read = roundRead; s.readSince = at;      // what was read on the heights given up says nothing about the ones followed
  };
  if (s.top === null) { again(); return s; }
  if (s.gave) {
    if (at - s.gave.at > RULE.clockRememberSeconds * 1000) s.gave = null;   // forgotten, with what was read on those heights
    else if (max >= s.gave.top) {
      // Back on the heights given up, or above them: what DNO read on them counts again, from when it was first read.
      // A height read again since then (in this round, or by a counted validator while lower heights were followed)
      // is as old as its first reading, before the start-over.
      if (isHeight(s.gave.read) && (readBefore === null || s.gave.read >= readBefore)) {
        readBefore = s.gave.read; readSinceBefore = s.gave.readSince;
        if (s.gave.read >= s.read) { s.read = s.gave.read; s.readSince = s.gave.readSince; }
      }
      if (max === s.gave.top) {               // on the old top: the old count, and this round claims nothing
        s.top = s.gave.top; s.topSince = s.gave.since; s.seen = s.gave.seen; s.compared = true; s.hold = true;
        s.gave = null;
        return s;
      }
      s.gave = null;                          // above it: an ordinary round, set against everything read before
    }
  }
  if (max > s.top) {
    if (same) s.compared = true;               // validators that showed these heights before: nothing new was read
    else if (readBefore !== null && max <= readBefore) {
      if (lowRise && at - s.lowSince > forget && roundRead < readBefore) {
        // The top has been rising under a height DNO read for longer than the forget time, and nothing read in this
        // round is at that height: the start-over, seen from below. That height is given up and remembered.
        giveUp(readBefore, readSinceBefore, false);
      } else {
        // A height DNO had read, from a seed or a counted validator, before this source reached it: the source is
        // followed, and the height is as old as its first reading. No arrival is claimed.
        s.top = max; s.topSince = readSinceBefore; s.compared = true; s.seen = false;
      }
    } else if (riser === max) {                // a new height
      s.top = max; s.topSince = at; s.compared = true;
      // After a start-over, while the old top is remembered, DNO does not say it saw a new height arrive: the nodes it
      // follows may be catching up. The count still runs from here (a lower bound), so a stop of those heights shows.
      s.seen = !s.gave;
      if (!s.gave) { s.lowSince = null; s.lowLast = null; s.runHi = {}; }   // the top is producing: what rises below it is catching up
    } else again();
    return s;
  }
  if (max === s.top || roundRead >= s.top) { s.compared = true; return s; }   // the top is read in this round, by a source or by a counted validator
  if (lowRise && at - s.lowSince > forget) {  // start-over: the lower heights are followed, the top is remembered
    giveUp(s.top, s.topSince, s.seen);
    return s;
  }
  s.compared = true;
  return s;
}

// What is published about height movement at observedAt (ms). hadReading: the latest round had a reading; without one
// nothing is said (the clock still kept what the seeds showed).
// cfg: { roundSeconds, stalledSeconds }: "Heights advancing" within two rounds of a new height DNO saw arrive; "no new
// height for N min" from stalledSeconds on. Status changes only at RULE.standstillSeconds (assess).
//   staticSeconds: seconds since the last new height; without one DNO saw arrive, since the round the top was first read
//     (a lower bound). null before any comparison, without a reading this round, on hold, or while the host clock is
//     behind the count's own start (a clock set back: nothing is said until it has passed it again).
//   advancedAt: when the last new height arrived (ms), if DNO saw it arrive. since: the moment staticSeconds is counted
//     from (ms), whenever staticSeconds is published: a condition record opens with it. The caller formats both.
//   following: after a start-over, DNO is following heights below one it read earlier (remembered for
//     RULE.clockRememberSeconds), or a source is back on that height in this round. A chain restarted lower and nodes
//     catching up look the same.
export function heightMovementOf(state, observedAt, hadReading, cfg) {
  var s = state || newHeightClock(), c = cfg || {}, on = !!hadReading;
  var timed = typeof observedAt === "number" && observedAt > 0 && s.topSince !== null && observedAt >= s.topSince;
  var staticSeconds = s.compared && !s.hold && on && timed ? Math.round((observedAt - s.topSince) / 1000) : null;
  return {
    staticSeconds: staticSeconds,
    advancedAt: s.seen && !s.hold && on && timed ? s.topSince : null,
    since: staticSeconds !== null ? s.topSince : null,
    advancing: staticSeconds !== null && s.seen && staticSeconds <= 2 * (c.roundSeconds || 0),
    stalled: staticSeconds !== null && typeof c.stalledSeconds === "number" && staticSeconds >= c.stalledSeconds,
    following: on && (s.gave !== null || s.hold)
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
