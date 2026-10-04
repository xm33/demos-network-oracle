// status-rule.test.mjs — STATUS_RULE guard: how one round's readings become the public reading (src/status-rule.mjs).
// The module is pure, so every case here is a plain call: no server, no clock, no store.
// Run: bun src/status-rule.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RULE, MODES, VALIDATORS_SOURCE, agreementOf, upperMedian, seedReasonOf, selectWitnesses, clockSources, stepValidators, clockRound, newHeightClock, stepHeightClock, heightMovementOf, assess, stepConditionRecords } from "./status-rule.mjs";

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
const mv = (s) => ({ staticSeconds: s, advancing: s !== null && s <= 40, stalled: s !== null && s >= 300, staticSince: s === null ? null : "2026-10-02 11:47:20" });
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
  check("S4 a height static for 12 min, under the standstill limit: still stable, and said", st.status === "stable" && st.status_reason === "Public nodes aligned; no new height for 12 min" && st.summary === "2 of 3 public seeds answered and their reported heights agree. No new height for 12 min.", st.status_reason + " | " + st.summary);
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
  const warnWeak = round(2, [H - 30, H], null, { maxIncidentSeverity: "warning", publicIncidentCount: 1 }), warnMod = round(3, [H - 30, H, H], null, { maxIncidentSeverity: "warning", publicIncidentCount: 3 });
  check("S13b weak agreement is unstable also beside a warning-level incident (the stronger word wins), and a warning beside moderate agreement is degraded for the incident; several incidents are 'incidents'",
    warnWeak.status === "unstable" && warnWeak.status_reason === "Significant disagreement among public node heights" && warnMod.status === "degraded" && warnMod.status_reason === "Warning-level incidents active"
    && warnMod.summary === "Degraded reading of the public seeds: 3 active incidents; agreement moderate." && crit.summary.includes("; 2 active incidents; "), JSON.stringify([warnWeak.status, warnWeak.status_reason, warnMod.summary, crit.summary]));
  const info = round(3, [H, H, H], null, { maxIncidentSeverity: "info", publicIncidentCount: 1 });
  check("S14 an info-level incident does not change status and is said", info.status === "stable" && info.summary === "All 3 public seeds answered and their reported heights agree. 1 info-level incident active."
    && round(3, [H, H, H], null, { maxIncidentSeverity: "info", publicIncidentCount: 2 }).summary === "All 3 public seeds answered and their reported heights agree. 2 info-level incidents active.");
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
    && out.confidence_reason === "3 of 4 validators that answered as listed with a height are more than 25 blocks from the one public seed" && out.risk === "elevated"
    && out.risk_factors.includes("3 of 4 validators that answered as listed with a height are more than 25 blocks from the seed")
    && out.summary === "One public seed reported its own height, and 1 validator that answers as listed is within 25 blocks of it. 3 others are more than 25 blocks from it.", JSON.stringify([out.confidence_reason, out.risk_factors, out.summary]));
  check("F16 exactly half is not more than half: uncertain; two of three within the band: clear, and the one left out is still said", tie.confidence === "uncertain" && tie.confidence_reason === "1 of 2 validators that answered as listed with a height is more than 25 blocks from the one public seed"
    && most.confidence === "clear" && most.confidence_reason === "Observed public signals agree" && most.risk_factors.includes("1 of 3 validators that answered as listed with a height is more than 25 blocks from the seed")
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
    && a.agreement_reason === "3 of 3 validators with a height within ±25 blocks of the median (spread: 1 block)" && a.risk_factors.includes("no public seed reported its own height; the reading rests on 3 validators"), a.summary + " | " + a.status_reason);
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

console.log("\n[" + TAG + "] the height clock: what each source shows about itself (the sequences are in height-movement.test.mjs)");
{
  const T0 = 1_800_000_000_000, S = 1000, cfg = { roundSeconds: 20, stalledSeconds: 300 };
  const src = (o) => Object.entries(o).map(([id, h]) => ({ id, h }));
  const run = (steps, from) => steps.reduce((s, [o, at]) => stepHeightClock(s, src(o), T0 + at * S), from || newHeightClock());
  const ids = (list) => list.map((x) => x.id + ":" + x.h).join(" ");
  check("C1 two seed heights: each seed is a source, by its name; validators are not", ids(clockSources([{ id: "a", h: H }, { id: "b", h: H - 2 }], null)) === `a:${H} b:${H - 2}`
    && ids(clockSources([{ id: "a", h: H }, { id: "b", h: H - 2 }], [H + 9, H + 9, H + 9])) === `a:${H} b:${H - 2}`);
  check("C2 beside one seed the only source is the seed: no validator moves the clock", ids(clockSources([{ id: "a", h: H }], [H + 20, H + 20, H - 25])) === `a:${H}`);
  check("C3 no seed height and a reading from validators alone: their median is one source, with the step it is given; a step that is not known is 'first', which claims nothing",
    ids(clockSources([], [H, H, H + 1], "rose")) === `${VALIDATORS_SOURCE}:${H}` && ids(clockSources([], [H, H, H + 24], "same")) === `${VALIDATORS_SOURCE}:${H}` && ids(clockSources([], [H, H + 1], "rose")) === `${VALIDATORS_SOURCE}:${H + 1}`
    && clockSources([], [H, H, H + 1], "rose")[0].step === "rose" && clockSources([], [H, H, H + 1], "same")[0].step === "same" && clockSources([], [H, H, H + 1])[0].step === "first" && clockSources([], [H, H, H + 1], "up")[0].step === "first"
    && clockSources([], [H, H, H + 1], "constructor")[0].step === "first");
  check("C4 a seed that gave its own height is a source in every round, with or without a reading: its heights are kept. Validators that form no reading are no source; nothing read is none",
    ids(clockSources([{ id: "a", h: H }], [H + 5000])) === `a:${H}` && ids(clockSources([{ id: "a", h: H }], null)) === `a:${H}` && clockSources([{ id: "a", h: H }], [H + 5000])[0].step === undefined
    && clockSources([], [H, H + 900], "rose").length === 0 && clockSources([], [H], "rose").length === 0 && clockSources([], null).length === 0 && clockSources(null, null).length === 0);
  check("C4b and a round without a source leaves the clock as it is", (() => { const s = run([[{ a: H }, 0], [{ a: H + 1 }, 20]]); return stepHeightClock(s, [], T0 + 40 * S) === s && stepHeightClock(s, null, T0 + 40 * S) === s && stepHeightClock(s, src({ a: H + 2 }), NaN) === s; })());
  check("C4c what is not a height, or has no name, is not a source's answer", stepHeightClock(newHeightClock(), [{ id: "a", h: "431000" }, { id: "b", h: -1 }, { id: "c", h: 1.5 }, { id: 7, h: H }, null], T0).top === null);
  const s = run([[{ a: H, b: H - 2 }, 0], [{ a: H + 1, b: H - 2 }, 20], [{ a: H + 1, b: H - 1 }, 40]]);
  check("C5 a source above its own last answer, highest of its round and above the top: a new height. A source rising below the top is none", s.top === H + 1 && s.topSince === T0 + 20 * S && s.seen === true && s.compared === true && s.last.a === H + 1 && s.last.b === H - 1);
  const first = run([[{ b: H + 3, c: H + 5 }, 60]], s);   // b rose, to less than the round's highest; c is heard for the first time
  check("C6 a height above the top from a source that did not rise to it: the top moves, the count starts again, nothing is claimed", first.top === H + 5 && first.topSince === T0 + 60 * S && first.seen === false && first.compared === false
    && heightMovementOf(first, T0 + 60 * S, true, cfg).staticSeconds === null && heightMovementOf(first, T0 + 60 * S, true, cfg).advancedAt === null);
  check("C6b a source heard for the first time above the top is the same: it shows nothing about a rise", (() => { const x = run([[{ c: H + 9 }, 60]], s); return x.top === H + 9 && x.seen === false && x.compared === false; })());
  const low = run([[{ b: H - 1 }, 60]], s);
  check("C7 below the top: no new height, and the count runs on", low.top === H + 1 && low.topSince === T0 + 20 * S && heightMovementOf(low, T0 + 60 * S, true, cfg).staticSeconds === 40 && low.gave === null);
  // From here: a at the top H + 1 since second 20, b standing 9 below it; no source has risen below the top.
  const q = run([[{ a: H, b: H - 8 }, 0], [{ a: H + 1, b: H - 8 }, 20], [{ a: H + 1, b: H - 8 }, 40]]);
  check("C8 no start-over without a rise in this round, however long the top has not been read", (() => { const x = run([[{ b: H - 7 }, 80], [{ b: H - 7 }, 400], [{ b: H - 7 }, 9000]], q); return x.top === H + 1 && x.gave === null && x.lowSince === T0 + 80 * S && x.lowLast === T0 + 80 * S; })());
  check("C8b nor until a source has been rising below the top for more than 600 s", run([[{ b: H - 7 }, 80], [{ b: H - 6 }, 400], [{ b: H - 5 }, 680]], q).gave === null && run([[{ b: H - 7 }, 80], [{ b: H - 6 }, 400], [{ b: H - 5 }, 681]], q).gave !== null);
  const lower = run([[{ b: H - 7 }, 80], [{ b: H - 6 }, 400], [{ b: H - 5 }, 700]], q);
  check("C9 rising below the top for more than 600 s, with no pause longer than that, and nothing at the top in this round: start-over", lower.top === H - 5 && lower.topSince === T0 + 700 * S && lower.compared === false && lower.seen === false
    && lower.gave && lower.gave.top === H + 1 && lower.gave.since === T0 + 20 * S && lower.gave.seen === true && lower.gave.at === T0 + 700 * S && heightMovementOf(lower, T0 + 700 * S, true, cfg).staticSeconds === null);
  check("C9b a pause longer than 600 s starts the run of rises again", (() => { const x = run([[{ b: H - 7 }, 80], [{ b: H - 6 }, 681]], q); return x.gave === null && x.lowSince === T0 + 681 * S && run([[{ b: H - 5 }, 1000], [{ b: H - 4 }, 1281]], x).gave === null && run([[{ b: H - 5 }, 1000], [{ b: H - 4 }, 1282]], x).gave !== null; })());
  check("C9c a source at the top in that round keeps the clock there", run([[{ b: H - 7 }, 80], [{ b: H - 6 }, 400], [{ a: H + 1, b: H - 5 }, 700]], q).gave === null);
  check("C9d a source that only goes back and forth between two heights rises once in a run: no start-over, however long it goes on, and the count runs on from the top", (() => {
    let x = q; for (let k = 0; k < 400; k++) x = run([[{ b: k % 2 ? H - 6 : H - 7 }, 80 + k * 20]], x);
    return x.gave === null && x.top === H + 1 && x.topSince === T0 + 20 * S && heightMovementOf(x, T0 + 8060 * S, true, cfg).staticSeconds === 8040; })());
  check("C9e the run keeps each source's highest answer: a step back and up again to a height it gave in the run is no rise, a step above it is; a pause longer than 600 s forgets the run", (() => {
    const a1 = run([[{ b: H - 7 }, 80], [{ b: H - 6 }, 100], [{ b: H - 7 }, 120], [{ b: H - 6 }, 140]], q);
    const a2 = run([[{ b: H - 5 }, 160]], a1), a3 = run([[{ b: H - 7 }, 180], [{ b: H - 6 }, 800]], a2);
    return a1.lowSince === T0 + 80 * S && a1.lowLast === T0 + 100 * S && a1.runHi.b === H - 6 && a2.lowLast === T0 + 160 * S && a2.runHi.b === H - 5
      && a3.lowSince === T0 + 800 * S && a3.lowLast === T0 + 800 * S && a3.runHi.b === H - 6 && a3.gave === null; })());
  check("C9f a new height at the top ends the run and its memory", (() => { const x = run([[{ b: H - 7 }, 80], [{ a: H + 2, b: H - 6 }, 100]], q); return x.lowSince === null && x.lowLast === null && Object.keys(x.runHi).length === 0 && x.top === H + 2; })());
  const followed = run([[{ b: H - 4 }, 720], [{ b: H - 4 }, 740]], lower);
  check("C10 while the old top is remembered the count runs from each rise of the followed heights, and no arrival is claimed", followed.top === H - 4 && followed.topSince === T0 + 720 * S && followed.seen === false && followed.compared === true
    && heightMovementOf(followed, T0 + 740 * S, true, cfg).staticSeconds === 20 && heightMovementOf(followed, T0 + 740 * S, true, cfg).advancedAt === null && heightMovementOf(followed, T0 + 740 * S, true, cfg).advancing === false);
  const back = run([[{ b: H + 1 }, 760]], followed);
  check("C11 a source exactly on the old top: the old count is restored, and that round claims nothing", back.top === H + 1 && back.topSince === T0 + 20 * S && back.seen === true && back.gave === null && back.hold === true
    && heightMovementOf(back, T0 + 760 * S, true, cfg).staticSeconds === null && heightMovementOf(run([[{ b: H + 1 }, 780]], back), T0 + 780 * S, true, cfg).staticSeconds === 760);
  const above = run([[{ b: H + 2 }, 760]], followed);
  check("C12 a source above the old top: an ordinary new height, seen arriving", above.top === H + 2 && above.topSince === T0 + 760 * S && above.seen === true && above.gave === null && above.hold === false && above.lowSince === null);
  check("C13 the old top is remembered for 24 h; after that the followed heights are the clock", run([[{ b: H - 4 }, 720 + 86400], [{ b: H + 1 }, 740 + 86400]], lower).gave === null && run([[{ b: H - 4 }, 720 + 86400], [{ b: H + 1 }, 740 + 86400]], lower).seen === true
    && run([[{ b: H - 4 }, 600 + 86400], [{ b: H + 1 }, 700 + 86400]], lower).hold === true);
  const m = heightMovementOf(s, T0 + 40 * S, true, cfg);
  check("C14 what is published: seconds since the new height, when it arrived, 'advancing' within two rounds of it", m.staticSeconds === 20 && m.advancedAt === T0 + 20 * S && m.since === T0 + 20 * S && m.advancing === true && m.stalled === false
    && heightMovementOf(s, T0 + 60 * S, true, cfg).advancing === true && heightMovementOf(s, T0 + 61 * S, true, cfg).advancing === false && heightMovementOf(s, T0 + 320 * S, true, cfg).stalled === true && heightMovementOf(s, T0 + 319 * S, true, cfg).stalled === false);
  check("C15 nothing is published without a reading in the latest round (not the count, not the time of the last new height, not that DNO follows lower heights), or before any comparison", heightMovementOf(s, T0 + 40 * S, false, cfg).staticSeconds === null && heightMovementOf(s, T0 + 40 * S, false, cfg).since === null
    && heightMovementOf(s, T0 + 40 * S, true, cfg).advancedAt === T0 + 20 * S && heightMovementOf(s, T0 + 40 * S, false, cfg).advancedAt === null && heightMovementOf(s, T0 + 40 * S, false, cfg).advancing === false
    && heightMovementOf(Object.assign({}, s, { gave: { top: 9, since: 0, seen: false, at: 0 } }), T0 + 40 * S, true, cfg).following === true && heightMovementOf(Object.assign({}, s, { gave: { top: 9, since: 0, seen: false, at: 0 } }), T0 + 40 * S, false, cfg).following === false
    && heightMovementOf(run([[{ a: H }, 0]]), T0, true, cfg).staticSeconds === null && heightMovementOf(newHeightClock(), T0, true, cfg).staticSeconds === null && heightMovementOf(null, T0, true, cfg).advancedAt === null);
  check("C16 a host clock set back behind the count's start: nothing is said until it has passed it again, and never a negative time", heightMovementOf(s, T0 + 19 * S, true, cfg).staticSeconds === null && heightMovementOf(s, T0 + 19 * S, true, cfg).advancedAt === null
    && heightMovementOf(s, T0 + 19 * S, true, cfg).advancing === false && heightMovementOf(s, T0 + 20 * S, true, cfg).staticSeconds === 0);
  check("C17 the numbers the methodology states", RULE.clockForgetSeconds === 600 && RULE.clockRememberSeconds === 86400 && RULE.standstillSeconds === 1800);
}

console.log("\n[" + TAG + "] with no seed: what the validators show about themselves, each against its own last answer");
{
  const T0 = 1_800_000_000_000, S = 1000, cfg = { roundSeconds: 20, stalledSeconds: 300 };
  const K = (n) => n.toString(16).padStart(2, "0").repeat(32), A = K(0xa1), B = K(0xa2), C = K(0xa3), D = K(0xa4);
  const ent = (o) => Object.entries(o).map(([key, h]) => ({ key, h }));
  const last = (o, at) => Object.fromEntries(Object.entries(o).map(([k, h]) => [k, { h, at: at === undefined ? T0 : at }]));
  const sv = (was, now, ref, at) => stepValidators(was, ent(now), ref, at === undefined ? T0 + 20 * S : at);
  check("K1 more than half of the counted above their own last answers: rose. Two of three, three of four, and both of two", sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H + 1, [B]: H + 1, [C]: H }, H + 1).step === "rose"
    && sv(last({ [A]: H, [B]: H, [C]: H, [D]: H }), { [A]: H + 1, [B]: H + 1, [C]: H + 1, [D]: H }, H + 1).step === "rose" && sv(last({ [A]: H, [B]: H }), { [A]: H + 1, [B]: H + 2 }, H + 2).step === "rose");
  check("K2 exactly half is not more than half: one of two, two of four. One validator alone never moves the clock", sv(last({ [A]: H, [B]: H }), { [A]: H, [B]: H + 1 }, H + 1).step === "same"
    && sv(last({ [A]: H, [B]: H, [C]: H, [D]: H }), { [A]: H + 1, [B]: H + 1, [C]: H, [D]: H }, H + 1).step === "same" && sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H, [B]: H, [C]: H + 20 }, H).step === "same");
  check("K3 who answers is not a height: the same validators on the same heights, some silent, are 'same' whatever their median is now", sv(last({ [A]: H, [B]: H, [C]: H + 3 }), { [A]: H, [C]: H + 3 }, H + 3).step === "same"
    && sv(last({ [A]: H, [B]: H, [C]: H + 3 }), { [A]: H, [B]: H }, H).step === "same" && sv(last({ [A]: H, [B]: H, [C]: H + 3 }), { [B]: H, [C]: H + 3 }, H + 3).step === "same");
  check("K4 a step back, or back up to a height short of nothing new, is no rise: a validator below its last answer does not count as risen", sv(last({ [A]: H + 1, [B]: H + 1, [C]: H + 1 }), { [A]: H, [B]: H, [C]: H }, H).step === "same"
    && sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H, [B]: H, [C]: H }, H).step === "same");
  check("K5 not more than half risen, and more than half risen or heard for the first time: first. Something may be new, and DNO did not see it arrive", sv({}, { [A]: H, [B]: H, [C]: H }, H).step === "first" && sv(last({ [A]: H }), { [A]: H + 1, [B]: H + 1, [C]: H + 1 }, H + 1).step === "first"
    && sv(last({ [A]: H, [B]: H }), { [A]: H + 1, [B]: H + 1, [C]: H + 1, [D]: H + 1 }, H + 1).step === "first" && sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H + 1, [B]: H, [C]: H, [D]: H }, H).step === "same"
    && sv(last({ [A]: H, [B]: H }), { [A]: H, [B]: H, [C]: H, [D]: H }, H).step === "same" && sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H + 1, [B]: H + 1, [C]: H, [D]: H }, H + 1).step === "first");
  check("K6 only the validators within 25 blocks of the reading's median are counted: a riser outside it does not make a majority, and one outside it does not dilute one", sv(last({ [A]: H, [B]: H, [C]: H - 900 }), { [A]: H + 1, [B]: H, [C]: H - 800 }, H + 1).step === "same"
    && sv(last({ [A]: H, [B]: H, [C]: H - 900, [D]: H - 900 }), { [A]: H + 1, [B]: H + 1, [C]: H - 900, [D]: H - 900 }, H + 1).step === "rose" && sv(last({ [A]: H, [B]: H }), { [A]: H + 27, [B]: H + 1 }, H + 1).step === "rose"
    && sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H + 27, [B]: H + 1, [C]: H }, H + 1).step === "same" && sv(last({ [A]: H, [B]: H, [C]: H }), { [A]: H + 26, [B]: H + 1, [C]: H }, H + 1).step === "rose");
  check("K7 without a reading from validators alone there is no step, and the last answers are still kept (beside a seed, or with no reading)", (() => { const r = sv(last({ [A]: H }), { [A]: H + 4, [B]: H + 5 }, null);
    return r.step === null && r.next[A].h === H + 4 && r.next[B].h === H + 5 && r.next[A].at === T0 + 20 * S; })());
  check("K8 the last answers after a round: those who answered are renewed with the round's time, a silent one keeps its own, and one not renewed for 24 h is dropped", (() => {
    const r = sv(last({ [A]: H, [B]: H, [C]: H }, T0), { [A]: H + 1 }, H + 1, T0 + 86400 * S), late = sv(last({ [A]: H, [B]: H }, T0), { [A]: H + 1 }, H + 1, T0 + 86401 * S);
    return r.next[A].h === H + 1 && r.next[A].at === T0 + 86400 * S && r.next[B].h === H && r.next[B].at === T0 && Object.keys(r.next).length === 3 && Object.keys(late.next).join() === A && late.step === "first"; })());
  check("K9 what is not a key or a height is not an answer; a key given twice counts once; the input is not changed", (() => {
    const was = last({ [A]: H }), frozen = JSON.stringify(was);
    const r = stepValidators(was, [{ key: A, h: H + 1 }, { key: A, h: H + 9 }, { key: "0x" + B, h: H + 1 }, { key: B, h: "5" }, { key: C, h: -1 }, null, { key: 7, h: H }, { key: D, h: H + 1.5 }], H + 1, T0 + 20 * S);
    return r.step === "rose" && Object.keys(r.next).join() === A && r.next[A].h === H + 1 && JSON.stringify(was) === frozen && stepValidators(null, null, H, T0).step === "same" && Object.keys(stepValidators({ ["x".repeat(8)]: { h: 1, at: T0 }, [A]: { h: "1", at: T0 }, [B]: { h: 1, at: "t" } }, [], null, T0).next).length === 0; })());

  // One round, as the agent, the replay's tests and the searches take it.
  const seeds = (o) => Object.entries(o).map(([id, h]) => ({ id, h }));
  const two = clockRound({}, seeds({ a: H, b: H - 1, c: null }), null, T0);
  check("R1 two seed heights: the seeds are the sources, the round has a reading, the row keeps nothing of validators", two.reading === true && two.row === null && two.sources.map((x) => x.id + ":" + x.h).join() === `a:${H},b:${H - 1}` && Object.keys(two.validators).length === 0);
  const beside = clockRound(last({ [A]: H }), seeds({ a: H }), ent({ [A]: H + 3, [B]: H + 3 }), T0 + 20 * S);
  check("R2 one seed and validators within 25 blocks: the seed alone is the source; the validators' answers are kept for later, no step is made of them, and the highest of those counted is handed on and kept in the row",
    beside.reading === true && JSON.stringify(beside.row) === JSON.stringify({ max: H + 3 }) && beside.counted === H + 3 && beside.sources.length === 1 && beside.sources[0].id === "a" && beside.sources[0].step === undefined
    && beside.validators[A].h === H + 3 && beside.validators[B].h === H + 3 && clockRound({}, seeds({ a: H }), ent({ [A]: H + 3, [B]: H + 300 }), T0).counted === H + 3 && two.counted === null);
  const far = clockRound({}, seeds({ a: H }), ent({ [A]: H + 300 }), T0 + 20 * S), lone = clockRound({}, seeds({ a: H }), null, T0 + 20 * S);
  const none = clockRound(last({ [A]: H }), seeds({ a: null }), ent({ [A]: H + 1, [B]: H + 900 }), T0 + 20 * S), blank = clockRound(last({ [A]: H }), [], null, T0 + 20 * S);
  check("R3 one seed and no reading (validators far from it, or none read): the seed is still a source, and the round is marked as having no reading", far.reading === false && far.sources.length === 1 && far.sources[0].h === H && far.validators[A].h === H + 300
    && lone.reading === false && lone.sources.length === 1 && lone.row === null);
  const only = clockRound(last({ [A]: H, [B]: H, [C]: H }), seeds({ a: null, b: null }), ent({ [A]: H + 1, [B]: H + 1, [C]: H }), T0 + 20 * S);
  check("R4 no seed and a reading from validators alone: one source at their median with its step, and the row keeps both, and the highest counted height, for the replay", only.reading === true && JSON.stringify(only.row) === JSON.stringify({ h: H + 1, step: "rose", max: H + 1 }) && only.counted === H + 1
    && clockRound({}, [], ent({ [A]: H, [B]: H + 2, [C]: H + 2, [D]: H + 900 }), T0).counted === H + 2 && far.counted === null && none.counted === null
    && JSON.stringify(only.sources) === JSON.stringify([{ id: VALIDATORS_SOURCE, h: H + 1, step: "rose" }]) && only.validators[C].at === T0 + 20 * S);
  check("R5 no seed and no reading: no source, no row; the validators read are still kept, and with none read the last answers are handed back as they were", none.reading === false && none.sources.length === 0 && none.row === null && none.validators[A].h === H + 1
    && blank.sources.length === 0 && blank.reading === false && blank.validators[A].h === H && clockRound(null, null, null, T0).sources.length === 0);

  // The fold with the validators' step.
  const vs = (h, step) => [{ id: VALIDATORS_SOURCE, h, step }], fold = (steps, from) => steps.reduce((s, [src, at]) => stepHeightClock(s, src, T0 + at * S), from || newHeightClock());
  const base = fold([[seeds({ a: H, b: H }), 0], [seeds({ a: H, b: H }), 20]]);
  const same = fold([[vs(H + 3, "same"), 40]], base);
  check("Q1 validators that showed nothing new, with a median above the top: nothing moves. The count runs on, and no new height is said", same.top === H && same.topSince === T0 && same.seen === false && same.compared === true
    && heightMovementOf(same, T0 + 40 * S, true, cfg).staticSeconds === 40 && heightMovementOf(fold([[vs(H + 3, "same"), 2000]], base), T0 + 2000 * S, true, cfg).staticSeconds === 2000);
  const first = fold([[vs(H + 3, "first"), 40]], base);
  check("Q2 validators heard for the first time above the top: the top moves there, the count starts again, nothing is claimed", first.top === H + 3 && first.topSince === T0 + 40 * S && first.seen === false && first.compared === false
    && heightMovementOf(first, T0 + 40 * S, true, cfg).staticSeconds === null && fold([[vs(H, "first"), 40]], base).topSince === T0 && fold([[vs(H - 4, "first"), 40]], base).top === H);
  const rose = fold([[vs(H + 1, "rose"), 40]], base);
  check("Q3 validators that rose, to a median above the top: a new height, seen arriving", rose.top === H + 1 && rose.topSince === T0 + 40 * S && rose.seen === true && heightMovementOf(rose, T0 + 40 * S, true, cfg).advancing === true
    && heightMovementOf(rose, T0 + 40 * S, true, cfg).advancedAt === T0 + 40 * S);
  check("Q4 validators that rose to the top itself, or below it, show no new height; below it is a rise of a run, and ten minutes of such rises are a start-over", fold([[vs(H, "rose"), 40]], base).topSince === T0
    && fold([[vs(H - 9, "rose"), 40]], base).lowSince === T0 + 40 * S && fold([[vs(H - 9, "rose"), 40], [vs(H - 8, "rose"), 400], [vs(H - 7, "rose"), 700]], base).gave.top === H
    && fold([[vs(H - 9, "rose"), 40], [vs(H - 9, "rose"), 400], [vs(H - 9, "rose"), 700]], base).gave === null && fold([[vs(H - 9, "same"), 40], [vs(H - 8, "same"), 400], [vs(H - 7, "first"), 700]], base).lowSince === null);
  const gone = fold([[seeds({ a: H - 500, b: H - 500 }), 40], [seeds({ a: H - 499, b: H - 499 }), 60], [seeds({ a: H - 498, b: H - 498 }), 400], [seeds({ a: H - 498, b: H - 498 }), 680], [seeds({ a: H - 497, b: H - 497 }), 700]], base);
  check("Q5 after a start-over: validators standing on the old top restore the old count, whatever their step; above it they end the following, and 'same' still moves nothing", gone.gave !== null && fold([[vs(H, "same"), 720]], gone).hold === true && fold([[vs(H, "same"), 720]], gone).topSince === T0
    && fold([[vs(H + 2, "same"), 720]], gone).gave === null && fold([[vs(H + 2, "same"), 720]], gone).top === H - 497 && fold([[vs(H + 2, "same"), 720]], gone).topSince === T0 + 700 * S
    && fold([[vs(H - 400, "same"), 720]], gone).gave.top === H && fold([[vs(H - 400, "same"), 720]], gone).top === H - 497, JSON.stringify(gone));
  const fc = (steps, from) => steps.reduce((s, [src, at, counted]) => stepHeightClock(s, src, T0 + at * S, counted), from || newHeightClock());
  const led = fc([[seeds({ a: H }), 0, H + 2], [seeds({ a: H }), 20, H + 2]]);
  check("H1 beside a seed the highest counted validator height is read, not counted: the top is the seed's. A seed's step up to a height a validator had shown is followed, and it is no new height: the count runs from when that height was first read, and no arrival is claimed", led.top === H && led.read === H + 2 && led.readSince === T0
    && (() => { const x = fc([[seeds({ a: H + 1 }), 40, H + 2]], led); return x.top === H + 1 && x.topSince === T0 && x.seen === false && x.compared === true && heightMovementOf(x, T0 + 40 * S, true, cfg).advancing === false && heightMovementOf(x, T0 + 40 * S, true, cfg).staticSeconds === 40
      && heightMovementOf(x, T0 + 40 * S, true, cfg).advancedAt === null; })()
    && fc([[seeds({ a: H + 2 }), 40, H + 2]], led).seen === false && fc([[seeds({ a: H + 2 }), 40, H + 2]], led).topSince === T0);
  check("H1b the same for a seed heard for the first time at such a height: the count does not start again", (() => { const x = fc([[seeds({ a: H, b: H + 2 }), 40, null]], led); return x.top === H + 2 && x.topSince === T0 && x.compared === true && x.seen === false; })()
    && (() => { const x = fc([[seeds({ a: H, b: H + 3 }), 40, null]], led); return x.top === H + 3 && x.topSince === T0 + 40 * S && x.compared === false && x.readSince === T0 + 40 * S; })());
  check("H1c a validator cannot make the count younger: while the seed stands, a higher counted height read later changes neither the top nor the count", (() => { const x = fc([[seeds({ a: H }), 40, H + 9], [seeds({ a: H }), 60, H + 12]], led); return x.top === H && x.topSince === T0 && x.read === H + 12 && x.readSince === T0 + 60 * S
      && heightMovementOf(x, T0 + 60 * S, true, cfg).staticSeconds === 60; })());
  check("H2 a step above everything read is an arrival, also when a validator shows the same height in that same round: what was read before this round is what counts", fc([[seeds({ a: H + 3 }), 40, H + 3]], led).seen === true && fc([[seeds({ a: H + 3 }), 40, H + 9]], led).seen === true
    && fc([[seeds({ a: H + 3 }), 40, H + 9]], led).read === H + 9 && fc([[seeds({ a: H + 3 }), 40, null]], led).read === H + 3);
  check("H3 with no seed the same holds for the validators' median: a rise to a height one counted validator had shown is followed and is no new height; above it, a new height seen arriving", fc([[vs(H + 2, "rose"), 40, H + 2]], led).seen === false && fc([[vs(H + 2, "rose"), 40, H + 2]], led).top === H + 2
    && fc([[vs(H + 2, "rose"), 40, H + 2]], led).topSince === T0 && fc([[vs(H + 3, "rose"), 40, H + 4]], led).seen === true && fc([[vs(H + 3, "rose"), 40, H + 4]], led).topSince === T0 + 40 * S);
  check("H4 what is not a height is not read; a counted height below the round's sources changes nothing", fc([[seeds({ a: H }), 0, "x"], [seeds({ a: H }), 20, -4]]).read === H && fc([[seeds({ a: H }), 0, H - 9]]).read === H && newHeightClock().read === null);
  const g0 = fc([[seeds({ a: H, b: H }), 0, null], [seeds({ a: H }), 20, H + 5]]);
  const gUp = fc([[seeds({ a: H - 500 }), 40, null], [seeds({ a: H - 499 }), 60, null], [seeds({ a: H - 498 }), 400, null], [seeds({ a: H - 497 }), 700, H - 490]], g0);
  check("H5 a start-over sets aside what was read on the heights given up and keeps it with them; a source back on the old top brings it back", gUp.gave.top === H && gUp.gave.read === H + 5 && gUp.gave.readSince === T0 + 20 * S && gUp.read === H - 490 && gUp.readSince === T0 + 700 * S
    && fc([[seeds({ a: H }), 720, null]], gUp).read === H + 5 && fc([[seeds({ a: H }), 720, null]], gUp).readSince === T0 + 20 * S && fc([[seeds({ a: H }), 720, null]], gUp).hold === true && fc([[seeds({ a: H + 1 }), 720, null]], gUp).gave === null);
  check("H5b a source back above the old top ends the following, and is set against everything read before the start-over: up to a height a counted validator had shown then, no new height, and the count runs from that first reading; above it, a new height seen arriving", (() => {
    const mid = fc([[seeds({ a: H + 3 }), 720, null]], gUp), up = fc([[seeds({ a: H + 6 }), 720, null]], gUp), at5 = fc([[seeds({ a: H + 5 }), 720, null]], gUp);
    return mid.gave === null && mid.top === H + 3 && mid.topSince === T0 + 20 * S && mid.seen === false && mid.compared === true && mid.read === H + 5 && mid.readSince === T0 + 20 * S && heightMovementOf(mid, T0 + 720 * S, true, cfg).staticSeconds === 700
      && heightMovementOf(mid, T0 + 720 * S, true, cfg).advancedAt === null && heightMovementOf(mid, T0 + 720 * S, true, cfg).following === false
      && at5.top === H + 5 && at5.seen === false && at5.topSince === T0 + 20 * S
      && up.gave === null && up.top === H + 6 && up.topSince === T0 + 720 * S && up.seen === true && up.read === H + 6 && up.readSince === T0 + 720 * S; })(), JSON.stringify(fc([[seeds({ a: H + 3 }), 720, null]], gUp)));
  check("H5c a height read before the start-over and read again since is as old as its first reading: when the returning round itself reads it (a counted validator beside the seed), and when a counted validator showed it while lower heights were followed. The seed that then reaches it does not restart the count", (() => {
    const back = fc([[seeds({ a: H + 3 }), 720, H + 5]], gUp), then = fc([[seeds({ a: H + 5 }), 740, H + 5]], back);
    const low = fc([[seeds({ a: H - 496 }), 710, H + 5]], gUp), lowBack = fc([[seeds({ a: H + 3 }), 720, null]], low), lowThen = fc([[seeds({ a: H + 5 }), 740, null]], lowBack);
    return back.gave === null && back.read === H + 5 && back.readSince === T0 + 20 * S && back.top === H + 3 && back.topSince === T0 + 20 * S && back.seen === false
      && then.top === H + 5 && then.topSince === T0 + 20 * S && then.seen === false && heightMovementOf(then, T0 + 1820 * S, true, cfg).staticSeconds === 1800
      && low.gave !== null && low.read === H + 5 && low.readSince === T0 + 710 * S
      && lowBack.gave === null && lowBack.read === H + 5 && lowBack.readSince === T0 + 20 * S && lowBack.top === H + 3 && lowBack.topSince === T0 + 20 * S
      && lowThen.top === H + 5 && lowThen.topSince === T0 + 20 * S && lowThen.seen === false; })(),
    JSON.stringify([fc([[seeds({ a: H + 3 }), 720, H + 5]], gUp).readSince - T0, fc([[seeds({ a: H + 3 }), 720, null]], fc([[seeds({ a: H - 496 }), 710, H + 5]], gUp)).readSince - T0]));
  const top0 = fc([[seeds({ a: H, b: H }), 0, null]]);
  const below = (counted) => fc([[seeds({ b: H - 20 }), 20, counted], [seeds({ b: H - 19 }), 40, counted], [seeds({ b: H - 18 }), 400, counted], [seeds({ b: H - 17 }), 700, counted]], top0);
  check("H6 a counted validator at or above the top in this round keeps the top: a seed rising below it for more than ten minutes makes no start-over, and the count runs on. With the validator below the top, or none read, it does", below(H).gave === null && below(H).top === H
    && below(H).topSince === T0 && below(H).compared === true && below(H + 3).gave === null && below(H + 3).top === H && below(H + 3).read === H + 3 && below(H - 1).gave !== null && below(H - 1).gave.top === H && below(H - 1).top === H - 17 && below(null).gave !== null
    && heightMovementOf(below(H), T0 + 1800 * S, true, cfg).staticSeconds === 1800 && heightMovementOf(below(H), T0 + 1800 * S, true, cfg).following === false, JSON.stringify(below(H)));
  // The top rising under a height DNO read: validators far above the one seed that answers were counted once (they
  // agree among themselves), then the seeds answer again and rise, round after round, far below that height.
  const far0 = fc([[seeds({ a: H }), 0, null], [seeds({ a: H + 1 }), 20, null], [seeds({ a: H + 2 }), 40, H + 500]]);
  const climb = (from, to, counted) => { const steps = []; for (let t = from, k = 0; t <= to; t += 20, k++) steps.push([seeds({ a: H + 3 + k }), t, typeof counted === "function" ? counted(t) : counted]); return steps; };
  const under = fc(climb(60, 660, null), far0), given = fc([[seeds({ a: H + 40 }), 680, null]], under), after = fc([[seeds({ a: H + 41 }), 700, null]], given);
  check("H7 a seed that rises under a height DNO read is followed, and the count runs from when that height was first read: no height it reaches is new", far0.read === H + 500 && far0.readSince === T0 + 40 * S && far0.top === H + 2 && far0.seen === true
    && under.gave === null && under.top === H + 33 && under.topSince === T0 + 40 * S && under.seen === false && heightMovementOf(under, T0 + 660 * S, true, cfg).staticSeconds === 620 && heightMovementOf(under, T0 + 660 * S, true, cfg).following === false, JSON.stringify(under));
  check("H7b after more than ten minutes of such rises, with nothing read at that height in this round, the height is given up and remembered: DNO follows the lower heights, says so, claims nothing in that round, and then counts from each rise without claiming an arrival", given.gave !== null && given.gave.top === H + 500 && given.gave.since === T0 + 40 * S && given.gave.seen === false && given.gave.read === H + 500
    && given.top === H + 40 && given.topSince === T0 + 680 * S && given.compared === false && given.read === H + 40 && given.readSince === T0 + 680 * S
    && heightMovementOf(given, T0 + 680 * S, true, cfg).staticSeconds === null && heightMovementOf(given, T0 + 680 * S, true, cfg).following === true
    && after.top === H + 41 && after.topSince === T0 + 700 * S && after.seen === false && heightMovementOf(after, T0 + 700 * S, true, cfg).staticSeconds === 0 && heightMovementOf(after, T0 + 700 * S, true, cfg).advancing === false
    && heightMovementOf(after, T0 + 700 * S, true, cfg).advancedAt === null && heightMovementOf(fc([[seeds({ a: H + 41 }), 2600, null]], after), T0 + 2600 * S, true, cfg).staticSeconds === 1900, JSON.stringify(given));
  check("H7c it is not given up while it is read: with the validators counted at that height in the round, or the seed itself reaching it, the count runs on from its first reading", (() => {
    const read = fc([[seeds({ a: H + 40 }), 680, H + 500]], under), reach = fc([[seeds({ a: H + 500 }), 680, null]], under), above = fc([[seeds({ a: H + 501 }), 680, null]], under);
    return read.gave === null && read.top === H + 40 && read.topSince === T0 + 40 * S && heightMovementOf(read, T0 + 680 * S, true, cfg).staticSeconds === 640
      && reach.gave === null && reach.top === H + 500 && reach.topSince === T0 + 40 * S && reach.seen === false
      && above.gave === null && above.top === H + 501 && above.topSince === T0 + 680 * S && above.seen === true; })());
  check("H7d ten minutes: at 600 s of such rises it is kept, at more it is given up; a pause of more than ten minutes between two rises starts the run again; a seed that goes back and forth under it rises once", (() => {
    const short = fc(climb(60, 100, null), far0), again = fc([[seeds({ a: H + 9 }), 1300, null]], short);                 // a pause of 1,200 s: the run starts again at 1,300
    const at600 = fc([[seeds({ a: H + 10 }), 1900, null]], again), over = fc([[seeds({ a: H + 11 }), 1920, null]], at600);   // a pause of 600 s keeps the run: 600 s old, then 620
    const paused = fc([[seeds({ a: H + 10 }), 1901, null]], again), p599 = fc([[seeds({ a: H + 11 }), 2500, null]], paused), p601 = fc([[seeds({ a: H + 12 }), 2502, null]], p599);   // a pause of 601 s: the run starts again at 1,901
    let x = fc([[seeds({ a: H + 4 }), 60, null]], far0); for (let t = 80; t <= 2000; t += 20) x = fc([[seeds({ a: t % 40 === 0 ? H + 3 : H + 4 }), t, null]], x);
    return fc([[seeds({ a: H + 40 }), 660, null]], fc(climb(60, 640, null), far0)).gave === null && again.gave === null && again.lowSince === T0 + 1300 * S && at600.gave === null && over.gave !== null
      && paused.gave === null && paused.lowSince === T0 + 1901 * S && p599.gave === null && p601.gave !== null && p601.gave.top === H + 500
      && x.gave === null && x.top === H + 4 && x.topSince === T0 + 40 * S; })());
  check("H7e the height given up is remembered like a top: a seed back exactly on it restores its count, from when it was first read, and that round says nothing; a seed above it is an ordinary new height", (() => {
    const back = fc([[seeds({ a: H + 500 }), 720, null]], after), up = fc([[seeds({ a: H + 501 }), 720, null]], after);
    return back.gave === null && back.hold === true && back.top === H + 500 && back.topSince === T0 + 40 * S && back.seen === false && back.read === H + 500 && back.readSince === T0 + 40 * S && heightMovementOf(back, T0 + 720 * S, true, cfg).staticSeconds === null
      && heightMovementOf(fc([[seeds({ a: H + 500 }), 740, null]], back), T0 + 740 * S, true, cfg).staticSeconds === 700
      && up.gave === null && up.top === H + 501 && up.seen === true && up.topSince === T0 + 720 * S; })());
  check("H7f while lower heights are already followed, a height read above them (validators that stand elsewhere) is given up at the next rise under it that reads nothing there, and the first height remembered stays the one remembered; read again in that round, it is kept", (() => {
    const x1 = fc([[seeds({ a: H + 42 }), 720, H + 200]], after), x2 = fc([[seeds({ a: H + 43 }), 740, null]], x1), x3 = fc([[seeds({ a: H + 44 }), 760, null]], x2), kept = fc([[seeds({ a: H + 43 }), 740, H + 200]], x1);
    return x1.gave.top === H + 500 && x1.read === H + 200 && x1.readSince === T0 + 720 * S && x1.top === H + 42 && x1.topSince === T0 + 720 * S
      && x2.gave.top === H + 500 && x2.top === H + 43 && x2.topSince === T0 + 740 * S && x2.compared === false && x2.read === H + 43 && heightMovementOf(x2, T0 + 740 * S, true, cfg).staticSeconds === null
      && x3.top === H + 44 && x3.topSince === T0 + 760 * S && x3.seen === false && heightMovementOf(x3, T0 + 760 * S, true, cfg).staticSeconds === 0
      && kept.gave.top === H + 500 && kept.top === H + 43 && kept.topSince === T0 + 720 * S && kept.read === H + 200 && heightMovementOf(kept, T0 + 740 * S, true, cfg).staticSeconds === 20; })());
  check("H7h while lower heights are followed, a height that counted validators show at or above the remembered one is kept with it when it is given up in turn: back on the old top, a seed that then reaches that height shows nothing new, and the count runs from its first reading", (() => {
    const shown = fc([[seeds({ a: H - 496 }), 720, H + 9]], gUp), dropped = fc([[seeds({ a: H - 495 }), 740, null]], shown), back = fc([[seeds({ a: H }), 760, null]], dropped), reach = fc([[seeds({ a: H + 9 }), 780, null]], back);
    return shown.gave.top === H && shown.read === H + 9 && shown.readSince === T0 + 720 * S && shown.top === H - 496
      && dropped.gave.top === H && dropped.gave.read === H + 9 && dropped.gave.readSince === T0 + 720 * S && dropped.read === H - 495 && dropped.compared === false
      && back.hold === true && back.top === H && back.topSince === T0 && back.read === H + 9 && back.readSince === T0 + 720 * S
      && reach.top === H + 9 && reach.seen === false && reach.topSince === T0 + 720 * S && heightMovementOf(reach, T0 + 780 * S, true, cfg).advancedAt === null
      && fc([[seeds({ a: H + 10 }), 780, null]], back).seen === true; })(), JSON.stringify(fc([[seeds({ a: H - 495 }), 740, null]], fc([[seeds({ a: H - 496 }), 720, H + 9]], gUp)).gave));
  check("H7g the reading says it for as long as it lasts: confidence uncertain, risk elevated, and the sentence", (() => {
    const mvg = heightMovementOf(after, T0 + 700 * S, true, cfg), r = round(2, [H + 41, H + 41], null, { movement: { staticSeconds: mvg.staticSeconds, advancing: mvg.advancing, stalled: mvg.stalled, following: mvg.following, staticSince: null } });
    return r.status === "stable" && r.confidence === "uncertain" && r.risk === "elevated" && r.summary.endsWith(" DNO has been following heights below a height it read earlier.") && r.risk_factors.includes("following heights below a height read earlier"); })());
  check("Q6 on a clock that has read nothing, any step only starts the count", ["rose", "first", "same"].every((st) => { const x = fold([[vs(H, st), 0]]); return x.top === H && x.seen === false && x.compared === false; }));
  const vo = assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 0, seedHeights: [], validators: { read: 3, heights: [H, H, H + 300], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0, movement: {} });
  check("Q7 the agreement sentence of a reading from validators alone counts those within the band among those that gave a height, not among themselves", vo.agreement_reason === "2 of 3 validators with a height within ±25 blocks of the median (spread: 0 blocks)"
    && vo.witnesses.validators.own_height === 3 && vo.witnesses.validators.counted === 2 && round(0, [], [H, H + 1, H + 2]).agreement_reason === "3 of 3 validators with a height within ±25 blocks of the median (spread: 2 blocks)", vo.agreement_reason);
}

console.log("\n[" + TAG + "] standstill: a reading that would be stable reads degraded after 30 minutes without a new height");
{
  const before = round(2, [H, H], null, { movement: mv(1799) }), at = round(2, [H, H], null, { movement: mv(1800) }), long = round(2, [H, H], null, { movement: mv(9000) });
  check("T1 1,799 s: stable; 1,800 s: degraded", before.status === "stable" && before.standstill === false && at.status === "degraded" && at.standstill === true && at.risk === "elevated");
  check("T2 its words", at.status_reason === "No new height for 30 min; public nodes aligned" && at.summary === "Degraded reading of the public seeds: 1 of 3 public nodes did not answer; no new height for 30 min; agreement strong."
    && JSON.stringify(at.risk_factors) === JSON.stringify(["no new height for 30 min"]) && at.agreement.state === "strong" && at.confidence === "clear", at.summary + " | " + JSON.stringify(at.risk_factors));
  check("T3 the record's text says when the standstill began and that it lasted until the record opened: it stays true however long the record is open, and whatever keeps it open", at.condition_reason === "No new height from 2026-10-02 11:47:20 UTC until this record opened" && long.condition_reason === at.condition_reason && long.status_reason === "No new height for 150 min; public nodes aligned");
  check("T4 when the start is not known the record says the limit, not a duration", round(2, [H, H], null, { movement: { staticSeconds: 4000, advancing: false, stalled: true, staticSince: null } }).condition_reason === "No new height for 30 min or more when this record opened");
  check("T5 nothing compared yet (after a start): no standstill", round(2, [H, H], null, { movement: mv(null) }).status === "stable");
  check("T6 unknown stays unknown, however long the one height has stood", round(1, [H], null, { movement: mv(9000) }).status === "unknown" && round(1, [H], null, { movement: mv(9000) }).standstill === false);
  const u = round(2, [H - 30, H], null, { movement: mv(9000) }), m = round(3, [H - 300, H, H], null, { movement: mv(9000) });
  check("T7 it never touches another status: unstable stays unstable with its own reason, degraded keeps its reason", u.status === "unstable" && u.status_reason === "Significant disagreement among public node heights" && u.standstill === false
    && m.status === "degraded" && m.status_reason === "Agreement reduced among public nodes" && m.standstill === false && m.condition_reason === m.status_reason);
  check("T7b but it is said in every reading it holds in: the summary and the risk factors of a degraded or unstable reading name it", m.summary === "Degraded reading of the public seeds: no new height for 150 min; agreement moderate."
    && m.risk_factors.includes("no new height for 150 min") && u.summary === "Unstable reading of the public seeds: 1 of 3 public nodes did not answer; no new height for 150 min; agreement weak." && u.risk_factors.includes("no new height for 150 min")
    && !round(3, [H - 300, H, H], null, { movement: mv(1799) }).summary.includes("no new height") && !round(1, [H], null, { movement: mv(9000) }).summary.includes("no new height"), m.summary + " | " + u.summary);
  check("T8 it applies in the fallback modes too", round(1, [H], [H], { movement: mv(1800) }).status === "degraded" && round(1, [H], [H], { movement: mv(1800) }).status_reason === "No new height for 30 min; one public seed and 1 validator aligned"
    && round(0, [], [H, H], { movement: mv(1800) }).status === "degraded" && round(0, [], [H, H], { movement: mv(1800) }).status_reason === "No new height for 30 min; 2 validators aligned, no public seed");
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

console.log("\n[" + TAG + "] fields of one reading do not contradict each other");
{
  const mod = round(2, [H, H + 22]), weak = round(2, [H, H + 26]), far = round(2, [H, H + 51]), ok = round(2, [H, H + 1]);
  check("Y1 'signals agree' is said only of strong agreement", ok.confidence === "clear" && ok.confidence_reason === "Observed public signals agree"
    && mod.status === "degraded" && mod.confidence === "clear" && mod.confidence_reason === "Compared heights are within 50 blocks of each other"
    && weak.status === "unstable" && weak.confidence === "clear" && weak.confidence_reason === "Compared heights are within 50 blocks of each other" && far.confidence_reason === "Public nodes report block heights more than 50 blocks apart",
    JSON.stringify([mod.confidence_reason, weak.confidence_reason]));
  const at50 = round(2, [H, H + 50]), at51 = round(2, [H, H + 51]);
  check("Y1b the limit is more than 50 blocks: exactly 50 apart is still clear, 51 is uncertain", at50.confidence === "clear" && at50.confidence_reason === "Compared heights are within 50 blocks of each other"
    && at51.confidence === "uncertain" && at51.confidence_reason === "Public nodes report block heights more than 50 blocks apart", JSON.stringify([at50.confidence_reason, at51.confidence_reason]));
  check("Y1c when a new height arrived within two rounds and the count has also passed the 5 minutes (a round longer than 150 s), 'Heights advancing' is what is said",
    round(2, [H, H], null, { movement: { staticSeconds: 400, advancing: true, stalled: true, staticSince: null } }).status_reason === "Heights advancing; public nodes aligned");
  check("Y2 a high risk from weak agreement names it", weak.risk === "high" && weak.risk_factors.includes("agreement is weak") && !mod.risk_factors.includes("agreement is weak") && mod.risk_factors.includes("agreement is moderate, not strong")
    && !ok.risk_factors.includes("agreement is weak"), JSON.stringify(weak.risk_factors));
  const partial = round(3, [H, H]), all = round(3, [H, H, H]), two = round(2, [H, H]);
  check("Y3 the summary does not say the heights of all agree when not all gave one", partial.summary === "All 3 public seeds answered; 2 reported their own height, and those heights agree."
    && all.summary === "All 3 public seeds answered and their reported heights agree." && two.summary === "2 of 3 public seeds answered and their reported heights agree.", partial.summary);
  check("Y4 one block is one block", round(2, [H, H + 1]).agreement_reason === "2 of 2 public nodes with a height within ±25 blocks of the median (spread: 1 block)" && round(2, [H, H + 2]).agreement_reason.endsWith("(spread: 2 blocks)")
    && round(1, [H], [H + 1]).agreement_reason === "One public seed and 1 validator within ±25 blocks of it (spread: 1 block)");
  // Over a grid of readings: the words agree with the values beside them.
  let bad = null, n = 0;
  const pick = [H - 300, H - 51, H - 26, H - 25, H - 21, H - 1, H, H + 1, H + 20, H + 25, H + 26];
  for (const a of pick) for (const b of pick) for (const v of [null, [], [H], [H, H + 400], [H + 1, H + 1, H - 26]]) for (const sec of [null, 0, 400, 1800, 9000]) for (const k of [0, 1, 2]) {
    const seeds = k === 0 ? [] : k === 1 ? [a] : [a, b];
    const r = round(seeds.length, seeds, v, { movement: mv(sec) }); n++;
    const text = [r.summary, r.status_reason, r.confidence_reason, r.agreement_reason].join(" | ");
    const why = r.confidence_reason === "Observed public signals agree" && r.agreement.state !== "strong" ? "signals agree beside " + r.agreement.state
      : r.risk === "high" && r.risk_factors.length === 0 ? "high risk without a factor"
      : / 1 blocks\b|\b1 validators\b|\b1 others\b/.test(text) ? "a plural of one"
      : /height unchanged|has not moved/i.test(text + r.risk_factors.join(" ")) ? "an old standstill phrase"
      : r.status === "unknown" && /no new height/i.test(text) ? "a standstill said without a reading"
      : sec !== null && sec >= 1800 && r.status !== "unknown" && !r.risk_factors.some((f) => f.startsWith("no new height for ")) ? "a standstill of 30 min not in the risk factors"
      : r.status === "stable" && sec !== null && sec >= 1800 ? "stable in a standstill" : null;
    if (why && !bad) bad = { why, seeds, v, sec, text, risk_factors: r.risk_factors };
  }
  check("Y5 " + n + " readings: no 'signals agree' beside reduced agreement, no high risk without a factor, no plural of one, no standstill unsaid", !bad && n > 3000, JSON.stringify(bad));
}

console.log("\n[" + TAG + "] after a start-over the reading says that DNO follows lower heights");
{
  const FOLLOW = "DNO has been following heights below a height it read earlier", FACTOR = "following heights below a height read earlier";
  const fl = (on, sec) => ({ movement: { staticSeconds: sec === undefined ? 0 : sec, advancing: false, stalled: false, following: on, staticSince: null } });
  const r = round(3, [H, H, H], null, fl(true)), plain = round(3, [H, H, H], null, fl(false));
  check("L1 a reading of the seeds made while DNO follows lower heights: stable, confidence uncertain with the reason, risk elevated with the factor, and the summary says it",
    r.status === "stable" && r.status_reason === "Public nodes aligned" && r.confidence === "uncertain" && r.confidence_reason === FOLLOW + ": a chain restarted lower and nodes catching up look the same from here"
    && r.risk === "elevated" && r.risk_factors.join("|") === FACTOR && r.summary === "All 3 public seeds answered and their reported heights agree. " + FOLLOW + ".", JSON.stringify([r.confidence_reason, r.risk, r.risk_factors, r.summary]));
  check("L2 without it the same heights read clear and low, and none of those words is said", plain.confidence === "clear" && plain.risk === "low" && !/following/i.test(JSON.stringify(plain)), JSON.stringify(plain.risk_factors));
  const none = round(1, [H], null, fl(true));
  check("L3 without a reading nothing is said of it: unknown keeps its own words", none.status === "unknown" && none.confidence_reason === "No cross-check: fewer than 2 public nodes answered" && !/following/i.test(JSON.stringify(none)), JSON.stringify([none.confidence_reason, none.summary]));
  const far = round(2, [H, H + 60], null, fl(true)), alone = round(0, [], [H, H, H], fl(true)), deg = round(2, [H, H + 22], null, fl(true)), still = round(2, [H, H], null, fl(true, 2400));
  check("L4 another cause of uncertainty keeps its own reason, and the factor and the summary still say this one; a degraded reading and a standstill say it too",
    far.confidence_reason === "Public nodes report block heights more than 50 blocks apart" && far.risk_factors.includes(FACTOR) && far.summary.endsWith(" " + FOLLOW + ".")
    && alone.confidence_reason === "No public seed reported its own height: the reading rests on validators alone" && alone.risk_factors.includes(FACTOR)
    && deg.status === "degraded" && deg.confidence === "uncertain" && deg.confidence_reason.startsWith(FOLLOW) && deg.summary === "Degraded reading of the public seeds: 1 of 3 public nodes did not answer; agreement moderate. " + FOLLOW + "."
    && still.status === "degraded" && still.risk_factors.join("|") === "no new height for 40 min|" + FACTOR, JSON.stringify([far.summary, alone.risk_factors, deg.summary, still.risk_factors]));
  const BANNED = /\b(approved|certified|trusted|recommended|safe|best|scores?|ranking|ranked|network truth|canonical truth|sanctions-clean|compliant|ready)\b/i;
  check("L5 no banned word in these words", !BANNED.test(r.confidence_reason + r.summary + r.risk_factors.join(" ")));
}

console.log("\n[" + TAG + "] the agent takes its reading from this module");
{
  const AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8");
  const body = (start) => { const i = AGENT.indexOf(start); return i < 0 ? "" : AGENT.slice(i, AGENT.indexOf("\n}\n", i) + 3); };
  const ccs = body("function computeCanonicalState() {"), inc = body("function evaluatePublicIncidents() {"), hist = body("function recordPublicNodeHistory() {");
  check("M1 computeCanonicalState calls assess() with the seeds' heights, the round's witness reads, the incidents and the height movement", /var reading = assess\(\{ timeReason: timeReason, seedReason: timeReason \? null : dataQualityReason, seedsTotal: pubTotal, seedsAnswered: pubReachable,\n    seedHeights: heights, validators: witnessInput\(\), maxIncidentSeverity: max_incident_severity, publicIncidentCount: publicIncidentCount,\n    movement: \{ staticSeconds: hm\.staticSeconds, advancing: hm\.advancing, stalled: hm\.stalled, following: hm\.following, staticSince: staticSince \} \}\);/.test(ccs));
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
