// status-rule.test.mjs — STATUS_RULE guard: how one round's readings become the public reading (src/status-rule.mjs).
// The module is pure, so every case here is a plain call: no server, no clock, no store.
// Run: bun src/status-rule.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RULE, MODES, agreementOf, upperMedian, seedReasonOf, selectWitnesses, clockHeight, newHeightClock, stepHeightClock, heightMovementOf, assess, stepConditionRecords } from "./status-rule.mjs";

const TAG = "STATUS_RULE";
const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + "  want " + JSON.stringify(want));

const H = 431000;
// movement: seconds without a new height (null: nothing compared yet).
const mv = (s) => ({ staticSeconds: s, advancing: s !== null && s <= 40, stalled: s !== null && s >= 300, staticSince: s === null ? null : "2026-10-02 11:47" });
// One round: seeds = [answered count, own heights]; validators = heights read (or null: none read).
function round(answered, seedHeights, validatorHeights, extra) {
  return assess(Object.assign({ timeReason: null, seedsTotal: 3, seedsAnswered: answered, seedHeights: seedHeights,
    validators: validatorHeights ? { read: validatorHeights.length, heights: validatorHeights.filter((x) => x !== null), listAgreedAt: "2026-10-02T08:07:00.000Z" } : null,
    maxIncidentSeverity: "none", publicIncidentCount: 0, movement: mv(0) }, extra || {}));
}

console.log("\n[" + TAG + "] agreement among compared heights (the 1.1 function)");
{
  eq("G1 two equal heights: strong, 2 of 2, spread 0", agreementOf([H, H]), { state: "strong", aligned_nodes: 2, total_nodes: 2, median_block: H, block_spread: 0, max_block: H, min_block: H });
  check("G2 the median is the upper of the two middle heights", upperMedian([10, 20]) === 20 && upperMedian([10, 20, 30]) === 20 && upperMedian([10, 20, 30, 40]) === 30 && agreementOf([H, H + 7]).median_block === H + 7);
  check("G3 spread 20 is strong, 21 is moderate (both heights still within 25 blocks of the median)", agreementOf([H, H + 20]).state === "strong" && agreementOf([H, H + 21]).state === "moderate" && agreementOf([H, H + 21]).aligned_nodes === 2);
  check("G4 two heights 25 apart are both aligned; 26 apart, one is: 1 of 2 is weak", agreementOf([H, H + 25]).aligned_nodes === 2 && agreementOf([H, H + 26]).aligned_nodes === 1 && agreementOf([H, H + 26]).state === "weak");
  check("G5 three heights, one 300 behind: 2 of 3 aligned is moderate", agreementOf([H - 300, H, H]).state === "moderate" && agreementOf([H - 300, H, H]).aligned_nodes === 2);
  check("G6 five heights: 3 aligned is moderate, 2 is weak (the 60 % share, rounded up)", agreementOf([H - 300, H - 200, H, H, H]).state === "moderate" && agreementOf([H - 300, H - 200, H - 100, H, H]).state === "weak");
  check("G7 no height: nothing compared", agreementOf([]).state === "unknown" && agreementOf([]).total_nodes === 0 && upperMedian([]) === null);
  check("G8 what is not a height is not counted: a string, a negative, a fraction, null", agreementOf([H, "431000", -1, 1.5, null, H]).total_nodes === 2);
  check("G9 the thresholds the methodology states", RULE.bandBlocks === 25 && RULE.strongSpreadBlocks === 20 && RULE.moderateShare === 0.6 && RULE.confidenceGapBlocks === 50 && RULE.standstillSeconds === 1800 && RULE.witnessMax === 8 && RULE.candidateMaxAgeMs === 86400000);
  eq("G11 with a reference the others are measured from it, and it is the published median", agreementOf([H - 25, H, H + 25], H - 25), { state: "moderate", aligned_nodes: 2, total_nodes: 3, median_block: H - 25, block_spread: 50, max_block: H + 25, min_block: H - 25 });
  check("G10 the seed-level reason: fewer than two answered, then fewer than two own heights", seedReasonOf(1, 1) === "too_few_answers" && seedReasonOf(0, 0) === "too_few_answers" && seedReasonOf(2, 1) === "too_few_heights" && seedReasonOf(3, 0) === "too_few_heights" && seedReasonOf(2, 2) === null);
}

console.log("\n[" + TAG + "] which witnesses count");
{
  const sel = (s, v) => selectWitnesses({ seedHeights: s, validatorHeights: v });
  const two = sel([H, H], [H + 1000, H - 1000, H]);
  check("W1 two seed heights: the seeds decide, and validators are not looked at, whatever they say", two.mode === "seeds_only" && JSON.stringify(two.counted) === JSON.stringify([H, H]) && two.validatorsCounted === null && two.validatorsWithHeight === null
    && JSON.stringify(sel([H, H], null)) === JSON.stringify(two), JSON.stringify(two));
  check("W2 three seed heights, one far behind: still the seeds alone", sel([H - 300, H, H], [H]).mode === "seeds_only" && sel([H - 300, H, H], [H]).counted.length === 3);
  const one = sel([H], [H, H - 1, H - 300]);
  check("W3 one seed: validators within 25 blocks of it are counted with it, the far one is left out", one.mode === "seed_and_validators" && JSON.stringify(one.counted) === JSON.stringify([H - 1, H, H]) && one.validatorsCounted === 2 && one.validatorsWithHeight === 3, JSON.stringify(one));
  check("W4 the seed is compared with the validator closest to it, and the published median is the seed's own height", JSON.stringify(one.compare) === JSON.stringify([H, H]) && one.reference === H
    && JSON.stringify(sel([H], [H + 9, H - 3]).compare) === JSON.stringify([H - 3, H]) && sel([H], [H + 9, H - 3]).reference === H);
  check("W5 of two validators equally close, the lower is compared (the one that claims less)", JSON.stringify(sel([H], [H + 4, H - 4]).compare) === JSON.stringify([H - 4, H]));
  check("W6 the band's edge beside a seed: 25 blocks away counts, 26 does not", sel([H], [H + 25]).mode === "seed_and_validators" && sel([H], [H - 25]).mode === "seed_and_validators" && sel([H], [H + 26]).mode === "insufficient" && sel([H], [H - 26]).mode === "insufficient");
  check("W7 one seed and no validator within the band: no reading, and the far validator changes nothing", sel([H], [H + 400]).mode === "insufficient" && JSON.stringify(sel([H], [H + 400]).counted) === JSON.stringify([H]) && sel([H], [H + 400]).validatorsCounted === 0);
  check("W8 one seed, validators not read (no candidate) or none answered: no reading", sel([H], null).mode === "insufficient" && sel([H], null).validatorsCounted === null && sel([H], []).mode === "insufficient");
  const far = sel([H], [H + 22, H - 24, H + 1]);
  check("W9 a validator at the band's edge cannot worsen a confirmed reading: the closest one is compared", JSON.stringify(far.compare) === JSON.stringify([H, H + 1]) && far.validatorsCounted === 3 && agreementOf(far.compare).state === "strong");
  const v3 = sel([], [H, H, H - 1]);
  check("W10 no seed: validators within 25 blocks of their upper median are counted", v3.mode === "validators_only" && v3.counted.length === 3 && v3.validatorsCounted === 3 && v3.reference === H && JSON.stringify(v3.compare) === JSON.stringify(v3.counted));
  check("W11 no seed: a reading needs two counted validators", sel([], [H]).mode === "insufficient" && sel([], [H, H]).mode === "validators_only" && sel([], [H, H + 1000]).mode === "insufficient" && sel([], []).mode === "insufficient" && sel([], null).mode === "insufficient");
  check("W12 no seed: the counted must be more than half of those that gave a height (2 of 4 is not, 3 of 4 is, 2 of 3 is)",
    sel([], [H - 900, H - 900, H, H]).mode === "insufficient" && sel([], [H - 900, H, H, H]).mode === "validators_only" && sel([], [H - 900, H, H, H]).validatorsCounted === 3 && sel([], [H - 900, H, H]).mode === "validators_only");
  check("W13 no seed: the band's edge around the upper median", sel([], [H - 25, H]).mode === "validators_only" && sel([], [H - 26, H]).mode === "insufficient");
  const colluding = sel([], [H, H + 5000, H + 5000]);
  check("W14 the stated limit: with no seed, two validators that agree outnumber one (the methodology says so)", colluding.mode === "validators_only" && colluding.counted[0] === H + 5000 && colluding.validatorsCounted === 2);
  const many = [19, 24, 26, 32, 34, 36, 49, 66, 67, 69, 69, 71, 73].map((x) => H + x), wm = sel([], many);
  check("W16 one median for validators alone: counted and agreement are both taken around the upper median of every height read (13 heights whose counted 12 would read weak around their own median)",
    wm.mode === "validators_only" && wm.reference === H + 49 && wm.validatorsCounted === 12 && agreementOf(wm.compare).state === "weak" && agreementOf(wm.compare, wm.reference).state === "moderate" && agreementOf(wm.compare, wm.reference).aligned_nodes === 12, JSON.stringify(wm));
  check("W15 the four modes, by name", JSON.stringify(MODES) === JSON.stringify(["seeds_only", "seed_and_validators", "validators_only", "insufficient"]));
}

console.log("\n[" + TAG + "] two seeds decide: the 1.1 reading, word for word");
{
  const a = round(2, [H, H], null);
  check("S1 two seeds aligned and advancing: stable, low, clear, sufficient", a.status === "stable" && a.risk === "low" && a.confidence === "clear" && a.data_quality === "sufficient" && a.data_quality_reason === null && a.witnesses.mode === "seeds_only");
  check("S2 its words", a.summary === "2 of 3 public seeds answered and their reported heights agree." && a.status_reason === "Heights advancing; public nodes aligned" && a.confidence_reason === "Observed public signals agree"
    && a.agreement_reason === "2 of 2 public nodes with a height within ±25 blocks of the median (spread: 0 blocks)" && a.risk_factors.length === 0, JSON.stringify([a.summary, a.status_reason, a.agreement_reason]));
  const all = round(3, [H, H, H + 1], null, { movement: mv(120) });
  check("S3 all three answered, neither advancing nor static for 5 min", all.summary === "All 3 public seeds answered and their reported heights agree." && all.status_reason === "Public nodes aligned", all.summary + " | " + all.status_reason);
  const st = round(2, [H, H], null, { movement: mv(720) });
  check("S4 a height static for 12 min, under the standstill limit: still stable, and said", st.status === "stable" && st.status_reason === "Public nodes aligned; height unchanged for 12 min" && st.summary === "2 of 3 public seeds answered and their reported heights agree. Height unchanged for 12 min.", st.status_reason + " | " + st.summary);
  const mod = round(3, [H - 300, H, H], null);
  check("S5 moderate agreement: degraded, elevated", mod.status === "degraded" && mod.risk === "elevated" && mod.status_reason === "Agreement reduced among public nodes" && mod.summary === "Degraded reading of the public seeds: agreement moderate."
    && JSON.stringify(mod.risk_factors) === JSON.stringify(["agreement is moderate, not strong"]), mod.summary + " | " + JSON.stringify(mod.risk_factors));
  const weak = round(2, [H - 30, H], null);
  check("S6 two seeds 30 blocks apart: weak, unstable, high (the 2 Oct 14:45 record's shape; validators do not arbitrate between two seeds)", weak.status === "unstable" && weak.risk === "high" && weak.status_reason === "Significant disagreement among public node heights"
    && weak.summary === "Unstable reading of the public seeds: 1 of 3 public nodes did not answer; agreement weak." && round(2, [H - 30, H], [H, H, H]).status === "unstable", weak.summary);
  const gap = round(3, [H - 60, H, H], null);
  check("S7 heights more than 50 blocks apart: confidence uncertain", gap.confidence === "uncertain" && gap.confidence_reason === "Public nodes report block heights more than 50 blocks apart" && round(2, [H - 20, H], null).confidence === "clear");
  const one = round(1, [H], null);
  check("S8 one seed answered and no validator read: unknown, elevated, uncertain, too_few_answers", one.status === "unknown" && one.risk === "elevated" && one.confidence === "uncertain" && one.data_quality === "insufficient" && one.data_quality_reason === "too_few_answers"
    && one.status_reason === "Insufficient data: fewer than 2 public nodes answered" && one.summary === "Insufficient data: fewer than 2 public nodes answered." && one.confidence_reason === "No cross-check: fewer than 2 public nodes answered"
    && one.agreement_reason === "Not compared: fewer than 2 public nodes answered" && JSON.stringify(one.risk_factors) === JSON.stringify(["Only 1 of 3 public nodes answered — limited cross-checking"]), JSON.stringify(one));
  eq("S9 nothing was compared: the one height is shown, aligned and spread are null", one.agreement, { state: "unknown", aligned_nodes: null, total_nodes: 1, median_block: H, block_spread: null });
  const heights = round(2, [H], null);
  check("S10 two answered, one gave its own height: too_few_heights", heights.data_quality_reason === "too_few_heights" && heights.status_reason === "Insufficient data: fewer than 2 public nodes reported their own block height" && heights.risk_factors.length === 0);
  const stale = round(2, [H, H], null, { timeReason: "stale" });
  check("S11 a stale observation is no reading, whatever it held: unknown, and no height shown", stale.status === "unknown" && stale.data_quality_reason === "stale" && stale.status_reason === "Insufficient data: the last public observation is older than 300 s"
    && stale.agreement.median_block === null && stale.agreement.total_nodes === 2 && stale.witnesses.mode === "insufficient" && round(1, [H], null, { timeReason: "stale" }).agreement.median_block === null);
  const none = assess({ timeReason: "no_observation", seedsTotal: 3, seedsAnswered: 0, seedHeights: [], validators: null, maxIncidentSeverity: "none", publicIncidentCount: 0, movement: mv(null) });
  check("S12 before the first observation", none.status === "unknown" && none.data_quality_reason === "no_observation" && none.status_reason === "Insufficient data: no public observation has completed yet");
  const warn = round(2, [H, H], null, { maxIncidentSeverity: "warning", publicIncidentCount: 1 });
  const crit = round(2, [H, H], null, { maxIncidentSeverity: "critical", publicIncidentCount: 2 });
  check("S13 a warning-level public incident: degraded; a critical one: unstable", warn.status === "degraded" && warn.status_reason === "Warning-level incidents active" && warn.summary === "Degraded reading of the public seeds: 1 of 3 public nodes did not answer; 1 active incident; agreement strong."
    && crit.status === "unstable" && crit.risk === "high" && crit.status_reason === "Critical incidents active" && JSON.stringify(crit.risk_factors) === JSON.stringify(["critical incidents active"]), warn.summary + " | " + crit.status_reason);
  const info = round(3, [H, H, H], null, { maxIncidentSeverity: "info", publicIncidentCount: 1 });
  check("S14 an info-level incident does not change status and is said", info.status === "stable" && info.summary === "All 3 public seeds answered and their reported heights agree. 1 info-level incident active.");
  check("S15 the seed-level reason the caller passes is used as given", round(2, [H], null, { seedReason: "too_few_heights" }).data_quality_reason === "too_few_heights");
  check("S16 a reading holds no list of heights or nodes: the clock is stepped by the caller (clockHeight, stepHeightClock)", !("clock_heights" in a) && Object.keys(a).sort().join() === "agreement,agreement_reason,condition_reason,confidence,confidence_reason,data_quality,data_quality_reason,risk,risk_factors,standstill,status,status_reason,summary,witnesses");
  check("S17 the summary's noun follows the total: 1 of 3 public nodes, 2 of 3 public nodes; 1 of 1 public node", round(2, [H - 30, H], null).summary === "Unstable reading of the public seeds: 1 of 3 public nodes did not answer; agreement weak."
    && round(1, [H], [H + 22]).summary.includes(": 2 of 3 public nodes did not answer; ") && round(0, [], [H - 24, H, H], { seedsTotal: 1 }).summary === "Degraded reading of 3 validators, with no public seed: 1 of 1 public node did not answer; agreement moderate."
    && !round(3, [H - 30, H, H], null).summary.includes("did not answer"));
}

console.log("\n[" + TAG + "] one seed, and validators within 25 blocks of it");
{
  const a = round(1, [H], [H, H - 1, H - 300]);
  check("F1 one seed and two validators within the band: a reading, stable, clear", a.status === "stable" && a.data_quality === "sufficient" && a.data_quality_reason === null && a.confidence === "clear" && a.witnesses.mode === "seed_and_validators");
  check("F2 risk is elevated, and the factor names the cause (also when only one seed did not answer, where two seed heights would read low)", a.risk === "elevated" && round(2, [H], [H]).risk === "elevated" && round(2, [H, H], null).risk === "low" && a.risk_factors.includes("one public seed reported its own height; 2 validators are within 25 blocks of it") && round(1, [H], [H]).risk_factors.includes("one public seed reported its own height; 1 validator is within 25 blocks of it")
    && !JSON.stringify(a.risk_factors).includes("confirm"));
  check("F3 its words", a.summary === "One public seed reported its own height, and 2 validators that answer as listed are within 25 blocks of it. 1 other is more than 25 blocks from it." && a.status_reason === "Heights advancing; one public seed and 2 validators aligned"
    && a.agreement_reason === "One public seed and the closest of 2 validators within ±25 blocks of it (spread: 0 blocks)" && round(1, [H], [H + 2]).summary === "One public seed reported its own height, and 1 validator that answers as listed is within 25 blocks of it.", a.summary + " | " + a.status_reason + " | " + a.agreement_reason);
  const out = round(1, [H], [H + 1, H + 400, H - 900, H + 5000]), tie = round(1, [H], [H, H + 400]), most = round(1, [H], [H, H + 1, H + 400]);
  check("F15 the validators within 25 blocks are not more than half of those that gave a height: the status still follows the seed, and confidence is uncertain, with the count",
    out.status === "stable" && out.agreement.state === "strong" && out.agreement.median_block === H && out.confidence === "uncertain"
    && out.confidence_reason === "3 of 4 validators that answered as listed are more than 25 blocks from the one public seed" && out.risk === "elevated"
    && out.risk_factors.includes("3 of 4 validators that answered as listed are more than 25 blocks from the seed")
    && out.summary === "One public seed reported its own height, and 1 validator that answers as listed is within 25 blocks of it. 3 others are more than 25 blocks from it.", JSON.stringify([out.confidence_reason, out.risk_factors, out.summary]));
  check("F16 exactly half is not more than half: uncertain; two of three within the band: clear, and the one left out is still said", tie.confidence === "uncertain" && tie.confidence_reason === "1 of 2 validators that answered as listed is more than 25 blocks from the one public seed"
    && most.confidence === "clear" && most.confidence_reason === "Observed public signals agree" && most.risk_factors.includes("1 of 3 validators that answered as listed is more than 25 blocks from the seed")
    && most.summary.endsWith("1 other is more than 25 blocks from it."), JSON.stringify([tie.confidence_reason, most.risk_factors]));
  check("F18 the agreement reason: 'the closest of N validators', and plainly '1 validator' when there is one", round(1, [H], [H + 2]).agreement_reason === "One public seed and 1 validator within ±25 blocks of it (spread: 2 blocks)"
    && round(1, [H], [H + 2, H - 9]).agreement_reason === "One public seed and the closest of 2 validators within ±25 blocks of it (spread: 2 blocks)");
  check("F17 a validator that gave no height is not counted as being far; with every validator within the band nothing is added", round(1, [H], [H, null, null]).confidence === "clear" && round(1, [H], [H, null, null]).risk_factors.length === 2
    && round(1, [H], [H, H + 3]).summary === "One public seed reported its own height, and 2 validators that answer as listed are within 25 blocks of it." && round(0, [], [H, H, H + 400]).confidence_reason === "No public seed reported its own height: the reading rests on validators alone");
  eq("F4 what is published: the seed's height as the median, the seed and its closest validator as the two compared", round(1, [H], [H + 3, H - 9, H - 300]).agreement, { state: "strong", aligned_nodes: 2, total_nodes: 2, median_block: H, block_spread: 3, max_block: H + 3, min_block: H });
  eq("F5 the witnesses object: counts only", a.witnesses, { mode: "seed_and_validators", counted: 3, public_seeds: { configured: 3, answered: 1, own_height: 1 }, validators: { read: 3, own_height: 3, counted: 2, list_agreed_at: "2026-10-02T08:07:00.000Z" } });
  const far = round(1, [H], [H + 400, H - 900]);
  check("F6 no validator within the band: unknown with the seed-level reason code, as before 1.2; the far validators moved nothing", far.status === "unknown" && far.data_quality_reason === "too_few_answers" && far.agreement.median_block === H && far.agreement.state === "unknown"
    && far.witnesses.mode === "insufficient" && far.witnesses.counted === 0 && far.witnesses.validators.counted === 0 && far.witnesses.validators.own_height === 2 && far.data_quality_reason === round(1, [H], null).data_quality_reason);
  const edge = round(1, [H], [H + 22]);
  check("F7 the only confirmation is 22 blocks away: moderate, so degraded where there was no reading at all", edge.status === "degraded" && edge.agreement.state === "moderate" && edge.status_reason === "Agreement reduced between one public seed and the validator closest to it"
    && edge.summary === "Degraded reading of one public seed and 1 validator: 2 of 3 public nodes did not answer; agreement moderate.", edge.summary);
  check("F8 a second validator at the edge cannot make a confirmed reading worse", round(1, [H], [H, H + 22, H - 24]).status === "stable" && round(1, [H], [H, H + 22, H - 24]).agreement.block_spread === 0);
  check("F9 a validator cannot make the reading unstable or weak, wherever it sits", [H + 25, H - 25, H + 26, H + 5000, 0].every((x) => { const r = round(1, [H], [x]); return r.status !== "unstable" && r.agreement.state !== "weak" && r.risk !== "high"; }));
  check("F10 a validator's height never becomes the published median or the seed's row", [H + 25, H - 25, H + 9].every((x) => round(1, [H], [x]).agreement.median_block === H));
  check("F11 two answered and one gave its own height: the fallback applies to it too", round(2, [H], [H]).witnesses.mode === "seed_and_validators" && round(2, [H], [H]).data_quality_reason === null && round(2, [H], [H]).witnesses.public_seeds.answered === 2);
  check("F12 the far validators are told in the words when there is no reading: the 1.1 sentence alone would leave them out", far.status_reason === "Insufficient data: one public seed reported its own block height, and no validator that answered as listed is within 25 blocks of it"
    && far.confidence_reason === "No cross-check: one public seed reported its own block height, and no validator that answered as listed is within 25 blocks of it" && far.agreement_reason.indexOf("Not compared: one public seed") === 0
    && round(1, [H], null).status_reason === "Insufficient data: fewer than 2 public nodes answered");
  check("F12b validators that gave no height are not said to be far from the seed", round(1, [H], [null]).status_reason === "Insufficient data: one public seed reported its own block height, and no validator answered as listed with its own height"
    && round(1, [H], [null, null, null]).summary === "Insufficient data: one public seed reported its own block height, and no validator answered as listed with its own height."
    && round(1, [H], []).status_reason === round(1, [H], [null]).status_reason && round(1, [H], [null, H + 400]).status_reason === far.status_reason);
  check("F13 a validator that gave no height is read and not counted", round(1, [H], [null, H]).witnesses.validators.read === 2 && round(1, [H], [null, H]).witnesses.validators.own_height === 1 && round(1, [H], [null]).status === "unknown");
  check("F14 a stale observation is no reading in the fallback either", round(1, [H], [H, H], { timeReason: "stale" }).status === "unknown" && round(1, [H], [H, H], { timeReason: "stale" }).witnesses.validators.counted === 0);
}

console.log("\n[" + TAG + "] no seed: validators alone");
{
  const a = round(0, [], [H, H, H - 1]);
  check("V1 three validators that agree: a reading, stable, and confidence uncertain", a.status === "stable" && a.data_quality === "sufficient" && a.confidence === "uncertain" && a.risk === "elevated" && a.witnesses.mode === "validators_only"
    && a.confidence_reason === "No public seed reported its own height: the reading rests on validators alone");
  check("V2 its words", a.summary === "No public seed reported its own height. 3 validators that answer as listed report heights within 25 blocks of each other." && a.status_reason === "Heights advancing; 3 validators aligned, no public seed"
    && a.agreement_reason === "3 of 3 validators with a height within ±25 blocks of the median (spread: 1 blocks)" && a.risk_factors.includes("no public seed reported its own height; the reading rests on 3 validators"), a.summary + " | " + a.status_reason);
  eq("V3 the witnesses object", a.witnesses, { mode: "validators_only", counted: 3, public_seeds: { configured: 3, answered: 0, own_height: 0 }, validators: { read: 3, own_height: 3, counted: 3, list_agreed_at: "2026-10-02T08:07:00.000Z" } });
  check("V4 one validator, or two that differ: unknown, as before", round(0, [], [H]).status === "unknown" && round(0, [], [H, H + 1000]).status === "unknown" && round(0, [], [H]).data_quality_reason === "too_few_answers" && round(0, [], [H]).agreement.median_block === null);
  check("V5 a split is no reading", round(0, [], [H - 900, H - 900, H, H]).status === "unknown");
  check("V6 validators alone never read unstable: a far minority is left out, and no majority is no reading", [[H, H, H + 5000], [H, H + 5000], [H - 60, H, H, H + 60]].every((v) => { const r = round(0, [], v); return r.status !== "unstable" && r.agreement.state !== "weak"; }));
  check("V7 the counted validators within the band but more than 20 apart: moderate, degraded", round(0, [], [H - 24, H, H]).status === "degraded" && round(0, [], [H - 24, H, H]).status_reason === "Agreement reduced among 3 validators, no public seed");
  const split = round(0, [], [H - 900, H - 900, H, H]);
  check("V8 no reading from validators alone is said in the words", split.status_reason === "Insufficient data: no public seed reported its own block height, and no majority of the validators that answered as listed is within 25 blocks of their median"
    && round(0, [], [H, H + 1000]).status_reason === split.status_reason && round(0, [], [H - 60, H, H + 60]).status_reason === split.status_reason
    && round(0, [], null).status_reason === "Insufficient data: fewer than 2 public nodes answered" && split.witnesses.counted === 0);
  check("V8b validators that gave no height are not said to disagree; one that did is said to be one", round(0, [], []).status_reason === "Insufficient data: no public seed reported its own block height, and no validator answered as listed with its own height"
    && round(0, [], [null, null, null, null]).status_reason === round(0, [], []).status_reason
    && round(0, [], [H]).status_reason === "Insufficient data: no public seed reported its own block height, and one validator answered as listed with its own height, where a reading needs two"
    && round(0, [], [null, H, null]).confidence_reason === "No cross-check: no public seed reported its own block height, and one validator answered as listed with its own height, where a reading needs two"
    && round(0, [], [H]).agreement_reason === "Not compared: no public seed reported its own block height, and one validator answered as listed with its own height, where a reading needs two");
  eq("V10 the published agreement is taken around the validators' median", round(0, [], [H - 900, H - 24, H, H + 3]).agreement, { state: "moderate", aligned_nodes: 3, total_nodes: 3, median_block: H, block_spread: 27, max_block: H + 3, min_block: H - 24 });
  check("V11 thirteen validators, twelve counted: moderate, never weak or unstable", (() => { const r = round(0, [], [19, 24, 26, 32, 34, 36, 49, 66, 67, 69, 69, 71, 73].map((x) => H + x)); return r.status === "degraded" && r.agreement.state === "moderate" && r.agreement.aligned_nodes === 12 && r.agreement.median_block === H + 49; })());
  check("V9 a seed that answered without its own height is counted as answered, and validators still give the reading", round(1, [], [H, H]).witnesses.mode === "validators_only" && round(1, [], [H, H]).witnesses.public_seeds.answered === 1 && round(1, [], [H]).data_quality_reason === "too_few_answers" && round(2, [], [H]).data_quality_reason === "too_few_heights");
}

console.log("\n[" + TAG + "] the height clock: a fold over the median each round publishes (the sequences are in height-movement.test.mjs)");
{
  const T0 = 1_800_000_000_000, S = 1000, cfg = { roundSeconds: 20, stalledSeconds: 300 };
  const run = (steps) => steps.reduce((s, [v, at]) => stepHeightClock(s, v, T0 + at * S), newHeightClock());
  check("C1 two seed heights: their upper median; validators do not change it", clockHeight([H, H - 2], null) === H && clockHeight([H, H - 2], [H + 9, H + 9, H + 9]) === H);
  check("C2 beside one seed the clock follows the seed's own height: no validator moves it", clockHeight([H], [H + 20, H + 20, H - 25]) === H && clockHeight([H], [H + 5000]) === H && clockHeight([H], null) === H);
  check("C3 no seed height: the validators' median when they form a reading; one validator of three cannot move it", clockHeight([], [H, H, H + 1]) === H && clockHeight([], [H, H, H + 24]) === H && clockHeight([], [H, H + 1, H + 5000]) === H + 1);
  check("C4 no seed height and no reading from the validators: no height, and the clock is not moved", clockHeight([], [H, H + 900]) === null && clockHeight([], [H]) === null && clockHeight([], null) === null
    && JSON.stringify(stepHeightClock(run([[H, 0], [H + 1, 20]]), null, T0 + 40 * S)) === JSON.stringify(run([[H, 0], [H + 1, 20]])));
  const s = run([[H, 0], [H + 1, 20], [H + 1, 40]]);
  check("C5 above the highest median: a new height; equal: read again; the state says when it was first and last read", s.top === H + 1 && s.topSince === T0 + 20 * S && s.topSeenAt === T0 + 40 * S && s.compared && s.advanceKnown && s.below === null);
  const low = stepHeightClock(s, H - 3, T0 + 60 * S);
  check("C6 below it: no new height; the lowest median since is kept", low.top === H + 1 && low.topSince === T0 + 20 * S && low.topSeenAt === T0 + 40 * S && low.below === H - 3 && stepHeightClock(low, H - 1, T0 + 80 * S).below === H - 3 && stepHeightClock(low, H - 9, T0 + 80 * S).below === H - 9);
  check("C7 the top is given up only when it has not been read for more than 600 s and the median below it has risen", stepHeightClock(low, H - 2, T0 + 640 * S).top === H + 1 && stepHeightClock(low, H - 2, T0 + 641 * S).top === H - 2
    && stepHeightClock(low, H - 3, T0 + 9000 * S).top === H + 1 && stepHeightClock(low, H - 4, T0 + 9000 * S).top === H + 1);
  const over = stepHeightClock(low, H - 2, T0 + 641 * S);
  check("C8 starting over claims nothing: no comparison yet, no new height seen arriving", over.compared === false && over.advanceKnown === false && over.topSince === T0 + 641 * S && heightMovementOf(over, T0 + 641 * S, true, cfg).staticSeconds === null);
  const held = stepHeightClock(s, H - 3, T0 + 2000 * S);
  check("C9 the first median below the top after it went unread for more than 600 s: nothing is published in that round", held.hold === true && heightMovementOf(held, T0 + 2000 * S, true, cfg).staticSeconds === null && heightMovementOf(held, T0 + 2000 * S, true, cfg).advancedAt === null
    && stepHeightClock(held, H - 3, T0 + 2020 * S).hold === false && heightMovementOf(stepHeightClock(held, H - 3, T0 + 2020 * S), T0 + 2020 * S, true, cfg).staticSeconds === 2000);
  const m = heightMovementOf(s, T0 + 40 * S, true, cfg);
  check("C10 what is published: seconds since the new height, when it arrived, 'advancing' within two rounds while the median stands on it", m.staticSeconds === 20 && m.advancedAt === T0 + 20 * S && m.since === T0 + 20 * S && m.advancing === true && m.stalled === false
    && heightMovementOf(s, T0 + 61 * S, true, cfg).advancing === false && heightMovementOf(low, T0 + 60 * S, true, cfg).advancing === false && heightMovementOf(s, T0 + 320 * S, true, cfg).stalled === true);
  check("C11 nothing is published without a height in the latest round, or before any comparison", heightMovementOf(s, T0 + 40 * S, false, cfg).staticSeconds === null && heightMovementOf(run([[H, 0]]), T0, true, cfg).staticSeconds === null && heightMovementOf(null, T0, true, cfg).staticSeconds === null);
}

console.log("\n[" + TAG + "] standstill: a reading that would be stable reads degraded after 30 minutes without a new height");
{
  const before = round(2, [H, H], null, { movement: mv(1799) }), at = round(2, [H, H], null, { movement: mv(1800) }), long = round(2, [H, H], null, { movement: mv(9000) });
  check("T1 1,799 s: stable; 1,800 s: degraded", before.status === "stable" && before.standstill === false && at.status === "degraded" && at.standstill === true && at.risk === "elevated");
  check("T2 its words", at.status_reason === "Height unchanged for 30 min; public nodes aligned" && at.summary === "Degraded reading of the public seeds: 1 of 3 public nodes did not answer; height unchanged for 30 min; agreement strong."
    && JSON.stringify(at.risk_factors) === JSON.stringify(["no new height for 30 min"]) && at.agreement.state === "strong" && at.confidence === "clear", at.summary + " | " + JSON.stringify(at.risk_factors));
  check("T3 the record's text says when the standstill began and that it lasted until the record opened: it stays true however long the record is open, and whatever keeps it open", at.condition_reason === "No new height from 2026-10-02 11:47 UTC until this record opened" && long.condition_reason === at.condition_reason && long.status_reason === "Height unchanged for 150 min; public nodes aligned");
  check("T4 when the start is not known the record says the limit, not a duration", round(2, [H, H], null, { movement: { staticSeconds: 4000, advancing: false, stalled: true, staticSince: null } }).condition_reason === "No new height for 30 min or more when this record opened");
  check("T5 nothing compared yet (after a start): no standstill", round(2, [H, H], null, { movement: mv(null) }).status === "stable");
  check("T6 unknown stays unknown, however long the one height has stood", round(1, [H], null, { movement: mv(9000) }).status === "unknown" && round(1, [H], null, { movement: mv(9000) }).standstill === false);
  const u = round(2, [H - 30, H], null, { movement: mv(9000) }), m = round(3, [H - 300, H, H], null, { movement: mv(9000) });
  check("T7 it never touches another status: unstable stays unstable with its own reason, degraded keeps its reason", u.status === "unstable" && u.status_reason === "Significant disagreement among public node heights" && u.standstill === false
    && m.status === "degraded" && m.status_reason === "Agreement reduced among public nodes" && m.standstill === false && m.condition_reason === m.status_reason);
  check("T8 it applies in the fallback modes too", round(1, [H], [H], { movement: mv(1800) }).status === "degraded" && round(1, [H], [H], { movement: mv(1800) }).status_reason === "Height unchanged for 30 min; one public seed and 1 validator aligned"
    && round(0, [], [H, H], { movement: mv(1800) }).status === "degraded" && round(0, [], [H, H], { movement: mv(1800) }).status_reason === "Height unchanged for 30 min; 2 validators aligned, no public seed");
  check("T9 outside a standstill the record's text is the status reason", before.condition_reason === before.status_reason);
}

console.log("\n[" + TAG + "] condition records follow status: open after 3 rounds, close after 9");
{
  const cfg = { open: 3, resolve: 9 };
  const run = (statuses, start) => {
    const c = { obsBad: 0, obsGood: 0, degBad: 0, degGood: 0, unsBad: 0, unsGood: 0 }, active = Object.assign({ visibility: false, degraded: false, unstable: false }, start || {}), log = [];
    statuses.forEach((s, k) => {
      const r = stepConditionRecords(c, { status: s, data_quality: s === "unknown" ? "insufficient" : "sufficient" }, active, cfg);
      r.open.forEach((m) => { active[m] = true; log.push("open " + m + " @" + (k + 1)); });
      r.resolve.forEach((m) => { active[m] = false; log.push("close " + m + " @" + (k + 1)); });
    });
    return log;
  };
  const rep = (s, n) => Array.from({ length: n }, () => s);
  eq("R1 unknown for 3 rounds opens a visibility record; 9 rounds with a reading close it", run([...rep("unknown", 3), ...rep("stable", 9)]), ["open visibility @3", "close visibility @12"]);
  eq("R2 two rounds are not enough, and a good round in between starts the count again", run(["unknown", "unknown", "stable", "unknown", "unknown", "stable"]), []);
  eq("R3 eight good rounds do not close it; one bad round in between starts the count again", run([...rep("unknown", 3), ...rep("stable", 8), "unknown", ...rep("stable", 8), "stable"]), ["open visibility @3", "close visibility @21"]);
  eq("R4 degraded opens the degraded record, and it closes after 9 rounds without that condition", run([...rep("degraded", 3), ...rep("stable", 9)]), ["open degraded @3", "close degraded @12"]);
  eq("R5 unstable opens the unstable record", run([...rep("unstable", 3), ...rep("stable", 9)]), ["open unstable @3", "close unstable @12"]);
  eq("R6 while visibility is poor no degraded or unstable record opens: DNO does not describe what it cannot see", run([...rep("unknown", 5)]), ["open visibility @3"]);
  eq("R7 a reading that is insufficient is poor visibility whatever its status word", (() => { const c = { obsBad: 0, obsGood: 0, degBad: 0, degGood: 0, unsBad: 0, unsGood: 0 }; let out = []; for (let k = 0; k < 3; k++) out = stepConditionRecords(c, { status: "degraded", data_quality: "insufficient" }, { visibility: false, degraded: false, unstable: false }, cfg).open; return out; })(), ["visibility"]);
  eq("R8 an open degraded record closes while the reading is unknown (9 rounds without the condition)", run([...rep("degraded", 3), ...rep("unknown", 9)]), ["open degraded @3", "open visibility @6", "close degraded @12"]);
  eq("R9 degraded then unstable: both records, each with its own count", run([...rep("degraded", 3), ...rep("unstable", 3), ...rep("stable", 9)]), ["open degraded @3", "open unstable @6", "close degraded @12", "close unstable @15"]);
  eq("R11 one round's actions in order: visibility, then degraded, then unstable", (() => { const c = { obsBad: 0, obsGood: 8, degBad: 2, degGood: 0, unsBad: 0, unsGood: 8 };
    return stepConditionRecords(c, { status: "degraded", data_quality: "sufficient" }, { visibility: true, degraded: false, unstable: true }, cfg).actions.map((a) => a.record + ":" + a.action); })(), ["visibility:resolve", "degraded:open", "unstable:resolve"]);
  eq("R10 the limits are the caller's: 2 and 4", (() => { const c = { obsBad: 0, obsGood: 0, degBad: 0, degGood: 0, unsBad: 0, unsGood: 0 }, a = { visibility: false, degraded: false, unstable: false }, log = [];
    ["unknown", "unknown", "stable", "stable", "stable", "stable"].forEach((s, k) => { const r = stepConditionRecords(c, { status: s, data_quality: s === "unknown" ? "insufficient" : "sufficient" }, a, { open: 2, resolve: 4 }); r.open.forEach((m) => { a[m] = true; log.push("open@" + (k + 1)); }); r.resolve.forEach((m) => { a[m] = false; log.push("close@" + (k + 1)); }); }); return log; })(), ["open@2", "close@6"]);
}

console.log("\n[" + TAG + "] words");
{
  const BANNED = /\b(approved|certified|trusted|recommended|safe|best|scores?|scoring|ranking|ranked|network truth|canonical truth|sanctions-clean|compliant|ready)\b/i;
  const LOOSE = /\b(live|synced|producing|running|reachable|healthy|offline|down)\b/i;
  const cases = [round(2, [H, H], null), round(3, [H - 300, H, H], null), round(2, [H - 30, H], null), round(1, [H], null), round(2, [H], null), round(2, [H, H], null, { timeReason: "stale" }),
    round(1, [H], [H, H - 1]), round(1, [H], [H + 22]), round(1, [H], [H + 400]), round(0, [], [H, H, H]), round(0, [], [H - 24, H, H]), round(0, [], [H]), round(0, [], [H - 900, H - 900, H, H]),
    round(2, [H, H], null, { movement: mv(1800) }), round(1, [H], [H], { movement: mv(4000) }), round(0, [], [H, H], { movement: mv(4000) }),
    round(2, [H, H], null, { maxIncidentSeverity: "warning", publicIncidentCount: 1 }), round(2, [H, H], null, { maxIncidentSeverity: "critical", publicIncidentCount: 1 })];
  const text = (r) => [r.summary, r.status_reason, r.condition_reason, r.confidence_reason, r.agreement_reason].concat(r.risk_factors).join(" | ");
  check("X1 no banned word in any reading's words", cases.every((r) => !BANNED.test(text(r))), cases.map(text).filter((t) => BANNED.test(t)).join(" || "));
  check("X2 none says live, synced, producing, running, reachable, healthy, offline or down", cases.every((r) => !LOOSE.test(text(r))), cases.map(text).filter((t) => LOOSE.test(t)).join(" || "));
  check("X3 every reading names one of the four modes, and status, risk, confidence and data quality are in the contract's sets", cases.every((r) => MODES.includes(r.witnesses.mode) && ["stable", "degraded", "unstable", "unknown"].includes(r.status) && ["low", "elevated", "high"].includes(r.risk)
    && ["clear", "uncertain"].includes(r.confidence) && ["sufficient", "insufficient"].includes(r.data_quality) && [null, "no_observation", "stale", "too_few_answers", "too_few_heights"].includes(r.data_quality_reason) && ["strong", "moderate", "weak", "unknown"].includes(r.agreement.state)));
  check("X4 unknown and insufficient go together, both ways", cases.every((r) => (r.status === "unknown") === (r.data_quality === "insufficient") && (r.status === "unknown") === (r.witnesses.mode === "insufficient")));
  check("X5 the witnesses object holds counts and a time only: no height, no key, no address", cases.every((r) => { const s = JSON.stringify(r.witnesses); return !/0x|http|\d{5,}(?!-)/.test(s.replace(/"list_agreed_at":"[^"]*"/, "")); }));
  const SRC = readFileSync(join(__dir, "status-rule.mjs"), "utf8");
  check("X6 the module is pure: no import, no clock, no I/O", !/^\s*import\s/m.test(SRC) && !/Date\.now|new Date|process\.|fetch\(|readFileSync|console\./.test(SRC));
}

console.log("\n[" + TAG + "] the agent takes its reading from this module");
{
  const AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8");
  const body = (start) => { const i = AGENT.indexOf(start); return i < 0 ? "" : AGENT.slice(i, AGENT.indexOf("\n}\n", i) + 3); };
  const ccs = body("function computeCanonicalState() {"), inc = body("function evaluatePublicIncidents() {"), hist = body("function recordPublicNodeHistory() {");
  check("M1 computeCanonicalState calls assess() with the seeds' heights, the round's witness reads, the incidents and the height movement", /var reading = assess\(\{ timeReason: timeReason, seedReason: timeReason \? null : dataQualityReason, seedsTotal: pubTotal, seedsAnswered: pubReachable,\n    seedHeights: heights, validators: witnessInput\(\), maxIncidentSeverity: max_incident_severity, publicIncidentCount: publicIncidentCount,\n    movement: \{ staticSeconds: hm\.staticSeconds, advancing: hm\.advancing, stalled: hm\.stalled, staticSince: staticSince \} \}\);/.test(ccs));
  check("M2 and decides nothing itself: no status, risk, confidence or agreement word is assigned there", !/(status|risk|confidence|agState|state) = "(stable|degraded|unstable|unknown|low|elevated|high|clear|uncertain|strong|moderate|weak)"/.test(ccs) && !/<= 25|<= 20|> 50|\* 0\.6/.test(ccs));
  check("M3 what it returns is the reading's: status, risk, data quality and its reason, confidence, agreement, the reason strings, the witnesses", ["status: reading.status", "risk: reading.risk", "data_quality: reading.data_quality", "data_quality_reason: reading.data_quality_reason", "confidence: reading.confidence",
    "confidence_reason: reading.confidence_reason", "summary: reading.summary", "status_reason: reading.status_reason", "risk_factors: reading.risk_factors", "agreement_reason: reading.agreement_reason", "witnesses: reading.witnesses",
    "height_standstill_after_seconds: RULE.standstillSeconds", "condition_reason: reading.condition_reason"].every((t) => ccs.includes(t)) && ccs.includes("var agreement = reading.agreement;"));
  check("M4 the condition records take their opens and closes from stepConditionRecords, with the agent's two limits, and open with the reading's condition_reason",
    inc.includes("var step = stepConditionRecords(c, canonical, open, { open: PUBLIC_INCIDENT_OPEN_CYCLES, resolve: PUBLIC_INCIDENT_RESOLVE_CYCLES });") && inc.includes("var reason = canonical.condition_reason ? String(canonical.condition_reason) : \"\";")
    && !/c\.(obs|deg|uns)(Bad|Good)\+\+/.test(inc) && AGENT.includes('const PUBLIC_INCIDENT_OPEN_CYCLES = parseInt(process.env.PUBLIC_INCIDENT_OPEN_CYCLES || "3", 10);') && AGENT.includes('const PUBLIC_INCIDENT_RESOLVE_CYCLES = parseInt(process.env.PUBLIC_INCIDENT_RESOLVE_CYCLES || "9", 10);'));
  check("M5 a stored round keeps how many seeds gave their own height, in every mode", hist.includes("canonical.seed_heights,") && !hist.includes("canonical.agreement.total_nodes,"));
  check("M6 the standstill limit has no switch: it is the module's number", !/STANDSTILL|standstillSeconds\s*=/.test(AGENT) && !/process\.env/.test(readFileSync(join(__dir, "status-rule.mjs"), "utf8")));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
