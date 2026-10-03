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
// One seed height h: a validator within the band of h confirms it; one further away is left out. With at least one
//   confirmation there is a reading (seed_and_validators). Agreement compares the seed with the validator closest to
//   it, and the published median is the seed's own height: a validator can confirm the seed, and it can neither
//   contradict it nor pull the reading towards a number of its own.
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
    // The closest confirmation; of two equally close, the lower (the one that claims less).
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

// The readings the standstill clock follows; each is { id, h }. While a seed gives its own height the clock follows
// the seeds alone, so a validator can neither start it nor stop it. With no seed height it follows the validators
// counted in the reading, and nothing when they form none.
export function clockReadings(seedReadings, validatorReadings) {
  var ok = function(r) { return !!r && isHeight(r.h); };
  var seeds = (Array.isArray(seedReadings) ? seedReadings : []).filter(ok);
  if (seeds.length || !Array.isArray(validatorReadings)) return seeds;
  var vals = validatorReadings.filter(ok);
  var w = selectWitnesses({ seedHeights: [], validatorHeights: vals.map(function(r) { return r.h; }) });
  if (w.mode !== "validators_only") return [];
  return vals.filter(function(r) { return w.counted.indexOf(r.h) !== -1; });
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
const capital = function(s) { return s.charAt(0).toUpperCase() + s.slice(1); };
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
//   movement:     { staticSeconds, advancing, stalled, staticSince }   (heightMovement(); staticSince: "YYYY-MM-DD HH:MM" UTC, or null)
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

  var agreement;
  if (!sufficient) {
    // Nothing was compared. total_nodes stays "seeds that reported their own height", as in 1.1.
    agreement = { state: "unknown", aligned_nodes: null, total_nodes: seedHeights.length, median_block: (seedHeights.length === 1 && reason !== "stale") ? seedHeights[0] : null, block_spread: null };
  } else {
    agreement = agreementOf(w.compare, w.reference);   // beside one seed the median is the seed's height; with none, the validators' median
  }

  var confidence = "clear", confidenceReason = "Observed public signals agree";
  if (!sufficient) { confidence = "uncertain"; confidenceReason = "No cross-check: " + unknownText; }
  else if (w.compare[w.compare.length - 1] - w.compare[0] > RULE.confidenceGapBlocks) { confidence = "uncertain"; confidenceReason = "Public nodes report block heights more than 50 blocks apart"; }
  else if (mode === "validators_only") { confidence = "uncertain"; confidenceReason = "No public seed reported its own height: the reading rests on validators alone"; }

  // Status. A standstill turns a reading that would be stable into degraded; it never touches another status.
  var status;
  if (!sufficient) status = "unknown";
  else if (sev === "critical" || agreement.state === "weak") status = "unstable";
  else if (sev === "warning" || agreement.state === "moderate") status = "degraded";
  else status = "stable";
  var standstill = status === "stable" && staticSeconds !== null && staticSeconds >= RULE.standstillSeconds;
  if (standstill) status = "degraded";

  var risk;
  if (status === "unknown") risk = "elevated";
  else if (status === "unstable" || sev === "critical" || agreement.state === "weak") risk = "high";
  else if (status === "degraded" || sev === "warning" || confidence === "uncertain" || agreement.state === "moderate" || (pubTotal > 2 && pubTotal - pubReachable > 1) || mode !== "seeds_only") risk = "elevated";
  else risk = "low";

  var staticText = staticSeconds === null ? "" : "height unchanged for " + Math.floor(staticSeconds / 60) + " min";
  var stalled = !!move.stalled, advancing = !!move.advancing;
  var phrase = reasonPhrases(mode, n), aligned = phrase.aligned;

  var summary;
  if (status === "unknown") summary = "Insufficient data: " + unknownText + ".";
  else if (status === "stable") {
    if (mode === "seeds_only") summary = (pubReachable === pubTotal ? "All " + pubTotal : pubReachable + " of " + pubTotal) + " public seeds answered and their reported heights agree.";
    else if (mode === "seed_and_validators") summary = "One public seed reported its own height, and " + validatorsWord(n) + " that " + plural(n, "answers", "answer") + " as listed " + plural(n, "is", "are") + " within 25 blocks of it.";
    else summary = "No public seed reported its own height. " + validatorsWord(n) + " that answer as listed report heights within 25 blocks of each other.";
    if (incidentCount > 0) summary += " " + incidentCount + " info-level incident" + (incidentCount === 1 ? "" : "s") + " active.";
    if (stalled) summary += " " + capital(staticText) + ".";
  } else {
    var offCount = pubTotal - pubReachable, parts = [];
    // "1 of 3 public nodes": the noun follows the total. (Up to 1.1 this read "1 of 3 public node did not answer".)
    if (offCount > 0) parts.push(offCount + " of " + pubTotal + " public node" + (pubTotal === 1 ? "" : "s") + " did not answer");
    if (incidentCount > 0) parts.push(incidentCount + " active incident" + (incidentCount === 1 ? "" : "s"));
    if (standstill) parts.push(staticText);
    parts.push("agreement " + agreement.state);
    var of = mode === "seed_and_validators" ? "one public seed and " + validatorsWord(n)
      : mode === "validators_only" ? validatorsWord(n) + ", with no public seed" : "the public seeds";
    summary = (status === "degraded" ? "Degraded reading of " : "Unstable reading of ") + of + ": " + parts.join("; ") + ".";
  }

  var statusReason;
  if (status === "stable") statusReason = advancing ? "Heights advancing; " + aligned : stalled ? capital(aligned) + "; " + staticText : capital(aligned);
  else if (status === "unstable") statusReason = agreement.state === "weak" ? "Significant disagreement among public node heights" : sev === "critical" ? "Critical incidents active" : "Network operability impaired";
  else if (status === "degraded") statusReason = sev === "warning" ? "Warning-level incidents active" : agreement.state === "moderate" ? phrase.reduced : capital(staticText) + "; " + aligned;
  else statusReason = "Insufficient data: " + unknownText;

  // A condition record's text is fixed when the record opens, so it must stay true while the record is open:
  // a standstill is told by when it began, not by how long it has lasted.
  var conditionReason = standstill ? (move.staticSince ? "No new height since " + move.staticSince + " UTC" : "No new height for " + Math.floor(RULE.standstillSeconds / 60) + " min or more") : statusReason;

  var riskFactors = [];
  if (pubTotal > 2 && pubTotal - pubReachable > 1) riskFactors.push("Only " + pubReachable + " of " + pubTotal + " public nodes answered — limited cross-checking");
  if (mode === "seed_and_validators") riskFactors.push("one public seed reported its own height; " + validatorsWord(n) + " " + plural(n, "confirms", "confirm") + " it");
  if (mode === "validators_only") riskFactors.push("no public seed reported its own height; the reading rests on " + validatorsWord(n));
  if (sev === "warning") riskFactors.push("warning-level incidents active");
  if (sev === "critical") riskFactors.push("critical incidents active");
  if (agreement.state === "moderate") riskFactors.push("agreement is moderate, not strong");
  if (standstill) riskFactors.push("no new height for " + Math.floor(staticSeconds / 60) + " min");

  var agreementReason;
  if (agreement.state === "unknown") agreementReason = "Not compared: " + unknownText;
  else if (mode === "seed_and_validators") agreementReason = "One public seed and the closest of " + validatorsWord(n) + " within ±25 blocks of it (spread: " + agreement.block_spread + " blocks)";
  else agreementReason = agreement.aligned_nodes + " of " + agreement.total_nodes + (mode === "validators_only" ? " validators" : " public nodes") + " with a height within ±25 blocks of the median (spread: " + agreement.block_spread + " blocks)";

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
