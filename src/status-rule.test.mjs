// status-rule.test.mjs — STATUS_RULE guard: how one round's readings become the public reading (src/status-rule.mjs).
// The module is pure, so every case here is a plain call: no server, no clock, no store.
// Run: bun src/status-rule.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RULE, MODES, VALIDATORS_SOURCE, agreementOf, upperMedian, lowerMedian, seedReasonOf, selectWitnesses, clockRound, newHeightClock, stepHeightClock, heightMovementOf, assess, stepConditionRecords } from "./status-rule.mjs";

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

console.log("\n[" + TAG + "] the height clock: what a round gives it (clockRound)");
const T0 = 1_800_000_000_000, S = 1000, cfg = { roundSeconds: 20, stalledSeconds: 300 };
const V = VALIDATORS_SOURCE;
const src = (o) => Object.entries(o).map(([id, h]) => ({ id, h }));
// steps: [sources by name, seconds after T0, the highest counted validator height or nothing]
const run = (steps, from) => steps.reduce((s, [o, at, counted]) => stepHeightClock(s, src(o), T0 + at * S, counted === undefined ? null : counted), from || newHeightClock());
const at = (sec) => T0 + sec * S;
const said = (s, sec, had) => heightMovementOf(s, at(sec), had === undefined ? true : had, cfg);
const J = JSON.stringify;
{
  const ids = (list) => list.map((x) => x.id + ":" + x.h).join(" ");
  const seeds = (o) => src(o);
  const two = clockRound(seeds({ a: H, b: H - 2 }), null);
  check("R1 two seed heights: each seed is a source, by its name; the round has a reading; nothing is kept of validators", ids(two.sources) === "a:" + H + " b:" + (H - 2) && two.reading === true && two.counted === null && two.row === null);
  const beside = clockRound(seeds({ a: H }), [H + 20, H - 3, H + 26, H + 400]);
  check("R2 one seed and validators within 25 blocks of it: the seed alone is a source; the highest validator within the band is what was read; the row keeps that height", ids(beside.sources) === "a:" + H && beside.reading === true && beside.counted === H + 20 && J(beside.row) === J({ max: H + 20 }), J(beside));
  check("R2b the band of what was read beside a seed is 25 blocks, to the block: a validator 25 away is read, one 26 away is not", clockRound(seeds({ a: H }), [H + 25]).counted === H + 25 && J(clockRound(seeds({ a: H }), [H + 25]).row) === J({ max: H + 25 })
    && clockRound(seeds({ a: H }), [H - 25, H + 26]).counted === H - 25 && clockRound(seeds({ a: H }), [H + 26]).counted === null && clockRound(seeds({ a: H }), [H + 26]).reading === false && clockRound(seeds({ a: H }), [H - 26]).row === null, J(clockRound(seeds({ a: H }), [H + 25])));
  const far = clockRound(seeds({ a: H }), [H + 400, H + 400, H + 401]);
  check("R3 one seed and no validator within the band: the seed is still a source, the round has no reading, and validators that agree among themselves far from it are not read", ids(far.sources) === "a:" + H && far.reading === false && far.counted === null && far.row === null
    && J(clockRound(seeds({ a: H }), null)) === J({ sources: [{ id: "a", h: H }], counted: null, reading: false, row: null }) && clockRound(seeds({ a: H }), []).reading === false, J(far));
  const alone = clockRound(seeds({ a: null, b: null }), [H + 5, H, H + 1]);
  check("R4 no seed height and a reading from validators alone: one source, at the height more than half of the counted have reached (their lower median); the row keeps it and the highest counted", ids(alone.sources) === V + ":" + (H + 1) && alone.reading === true && alone.counted === H + 5 && J(alone.row) === J({ h: H + 1, max: H + 5 }), J(alone));
  const even = clockRound([], [H + 5, H, H + 5, H]);
  check("R5 an even split: the reading's median is the upper one, the count stands on the lower: two of four at a height are not more than half", ids(even.sources) === V + ":" + H && even.counted === H + 5 && assess({ timeReason: null, seedsTotal: 3, seedsAnswered: 0, seedHeights: [], validators: { read: 4, heights: [H + 5, H, H + 5, H], listAgreedAt: null }, maxIncidentSeverity: "none", publicIncidentCount: 0, movement: {} }).agreement.median_block === H + 5, J(even));
  const out = clockRound([], [H - 100, H + 2, H, H + 1]);
  check("R6 a validator outside the band of the median is not counted: the lower median and the highest are those of the counted", ids(out.sources) === V + ":" + (H + 1) && out.counted === H + 2 && J(out.row) === J({ h: H + 1, max: H + 2 }), J(out));
  check("R7 no seed and no reading (one validator; a split; none read): no source, no row", [[H], [H, H + 900], [H - 900, H - 900, H, H], [], null].every((v) => { const r = clockRound([], v); return r.sources.length === 0 && r.reading === false && r.counted === null && r.row === null; }));
  check("R8 what is not a height, or has no name, is not an answer: a string, a negative, a fraction, null", ids(clockRound([{ id: "a", h: "431000" }, { id: "b", h: -1 }, { id: "c", h: 1.5 }, { h: H }, null, { id: "d", h: H }], null).sources) === "d:" + H
    && J(clockRound([], [H, "431000", -1, 1.5, null, H]).row) === J({ h: H, max: H }) && clockRound(null, null).sources.length === 0 && clockRound(undefined, "x").reading === false);
  check("R9 the lower median: the middle height, or the lower of the two middle ones; it is above a height exactly when more than half of the heights are", lowerMedian([]) === null && lowerMedian([7]) === 7 && lowerMedian([9, 3]) === 3 && lowerMedian([1, 9, 5]) === 5 && lowerMedian([4, 1, 3, 2]) === 2 && lowerMedian([5, 4, 3, 2, 1]) === 3
    && (() => { let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = 0; i < 4000; i++) { const n = 1 + Math.floor(rnd() * 8), xs = Array.from({ length: n }, () => Math.floor(rnd() * 12)), x = Math.floor(rnd() * 12);
        if ((lowerMedian(xs) > x) !== (xs.filter((v) => v > x).length * 2 > n)) return false; }
      return true; })());
  check("R10 a round of validators alone never rests on a height that more than half of the counted stand above", (() => { let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 4000; i++) { const n = 2 + Math.floor(rnd() * 7), xs = Array.from({ length: n }, () => H + Math.floor(rnd() * 40)), r = clockRound([], xs);
      if (!r.reading) continue; const w = selectWitnesses({ seedHeights: [], validatorHeights: xs }).counted;
      if (w.filter((v) => v > r.sources[0].h).length * 2 > w.length || r.counted !== Math.max(...w)) return false; }
    return true; })());
}

console.log("\n[" + TAG + "] the height clock: the count, and the one thing that is a new height");
{
  const first = run([[{ a: H, b: H - 2 }, 0]]);
  check("C1 the first round: the count starts on the highest source; nothing is claimed, and the count is published from here", first.top === H && first.topSince === at(0) && first.seen === false && first.read === H && first.readSince === at(0)
    && J(said(first, 0)) === J({ staticSeconds: 0, advancedAt: null, since: at(0), advancing: false, stalled: false, following: false }), J(first));
  const up = run([[{ a: H, b: H - 2 }, 0], [{ a: H + 1, b: H - 2 }, 20]]);
  check("C2 a seed above its own last answer, highest of its round and above everything read: a new height DNO saw arrive", up.top === H + 1 && up.topSince === at(20) && up.seen === true && up.read === H + 1 && up.readSince === at(20)
    && J(said(up, 20)) === J({ staticSeconds: 0, advancedAt: at(20), since: at(20), advancing: true, stalled: false, following: false }), J(up));
  const catching = run([[{ a: H + 1, b: H - 5 }, 40], [{ a: H + 1, b: H - 3 }, 60], [{ a: H + 1, b: H + 1 }, 80]], up);
  check("C3 a seed that rises below the top, and up to it, is catching up: nothing new, the count runs on", catching.top === H + 1 && catching.topSince === at(20) && catching.seen === true && said(catching, 80).staticSeconds === 60 && said(catching, 80).advancedAt === at(20));
  const flip = run([[{ a: H }, 0], [{ a: H + 1 }, 20], [{ a: H }, 40], [{ a: H + 1 }, 60], [{ a: H }, 80], [{ a: H + 1 }, 100]]);
  check("C4 a node going back and forth between two heights shows a new height once", flip.top === H + 1 && flip.topSince === at(20) && said(flip, 100).staticSeconds === 80);
  const heard = run([[{ a: H }, 0], [{ a: H, b: H + 9 }, 20]]);
  check("C5 a height above everything read from a seed with no earlier answer: the count starts in that round, and no arrival is claimed", heard.top === H + 9 && heard.topSince === at(20) && heard.seen === false
    && J(said(heard, 20)) === J({ staticSeconds: 0, advancedAt: null, since: at(20), advancing: false, stalled: false, following: false }) && said(run([[{ a: H, b: H + 9 }, 40]], heard), 40).staticSeconds === 20);
  const silent = run([[{ a: H, b: H }, 0], [{ a: H }, 20], [{ a: H }, 3600], [{ a: H, b: H + 1 }, 3620]]);
  check("C6 a seed that was silent and comes back higher has an earlier answer: a new height in the round it comes back (when the block was made is not known from here)", silent.top === H + 1 && silent.topSince === at(3620) && silent.seen === true);
  const still = run([[{ a: H, b: H - 1 }, 0], [{ a: H + 1, b: H - 1 }, 20], [{ a: H + 1 }, 400], [{ b: H }, 420], [{ a: H + 1, b: H + 1 }, 1820]]);
  check("C7 at the top, or below it: no new height, and the count runs on", still.top === H + 1 && still.topSince === at(20) && J(said(still, 1820)) === J({ staticSeconds: 1800, advancedAt: at(20), since: at(20), advancing: false, stalled: true, following: false }));
  check("C8 a round without a source leaves the clock as it is; what is not a height or has no name is not a source's answer", (() => { const s = run([[{ a: H }, 0], [{ a: H + 1 }, 20]]);
    return stepHeightClock(s, [], at(40)) === s && stepHeightClock(s, null, at(40)) === s && stepHeightClock(s, src({ a: H + 5 }), "soon") === s && stepHeightClock(s, [{ id: "a", h: "431009" }, { h: H + 9 }, null], at(40)) === s
      && stepHeightClock(s, [{ id: "a", h: H + 2 }, { id: "a", h: H + 9 }], at(40)).top === H + 2; })());
  check("C9 the state handed in is not changed", (() => { const s = run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), before = J(s); run([[{ a: H + 2, b: H }, 40], [{ b: H + 1 }, 700], [{ b: H + 2 }, 1400]], s); return J(s) === before; })());

  // ---- what a counted validator showed is read, and does not move the count
  const besideSeed = run([[{ a: H }, 0, H + 3]]);
  check("H1 beside a seed the highest counted validator height is read, not counted: the count stands on the seed's height", besideSeed.top === H && besideSeed.topSince === at(0) && besideSeed.read === H + 3 && besideSeed.readSince === at(0));
  const stepUp = run([[{ a: H + 2 }, 600, H + 3], [{ a: H + 3 }, 620]], besideSeed);
  check("H2 a seed that steps up to a height a counted validator showed before it shows nothing new: that height is as old as the first reading of the highest height read", stepUp.top === H + 3 && stepUp.topSince === at(0) && stepUp.seen === false
    && J(said(stepUp, 620)) === J({ staticSeconds: 620, advancedAt: null, since: at(0), advancing: false, stalled: true, following: false }), J(stepUp));
  const younger = run([[{ a: H }, 20, H + 3], [{ a: H }, 900, H + 9], [{ a: H }, 1800, H + 9]], besideSeed);
  check("H3 a validator cannot make the count younger: while the seed stands, a higher counted height read later changes neither the top nor its time", younger.top === H && younger.topSince === at(0) && younger.read === H + 9 && younger.readSince === at(900) && said(younger, 1800).staticSeconds === 1800);
  check("H4 and when the seed then steps up below that height, the count runs from when that highest height was first read: no later", (() => { const x = run([[{ a: H + 4 }, 1820]], younger); return x.top === H + 4 && x.topSince === at(900) && x.seen === false; })());
  const above = run([[{ a: H }, 0, H + 3], [{ a: H + 4 }, 20, H + 4]]);
  check("H5 a seed above everything read before this round is an arrival, also when a validator shows the same height in that same round", above.top === H + 4 && above.topSince === at(20) && above.seen === true);
  check("H6 what is not a height is not read; a counted height below the round's sources changes nothing", run([[{ a: H }, 0, "x"], [{ a: H + 1 }, 20, H - 3]]).read === H + 1 && run([[{ a: H }, 0, -1]]).read === H);

  // ---- validators alone
  const vFirst = run([[{ a: H }, 0], [{ [V]: H + 2 }, 20, H + 4]]);
  check("V1 validators alone above everything read: the count starts in that round, on the height more than half of them have reached; no arrival is claimed", vFirst.top === H + 2 && vFirst.topSince === at(20) && vFirst.seen === false && vFirst.read === H + 4
    && J(said(vFirst, 20)) === J({ staticSeconds: 0, advancedAt: null, since: at(20), advancing: false, stalled: false, following: false }));
  const vRise = run([[{ [V]: H + 5 }, 40, H + 5], [{ [V]: H + 6 }, 60, H + 6]], vFirst);
  check("V2 and none when they rise again, round after round: with validators alone DNO gives the count and never says it saw a height arrive", vRise.top === H + 6 && vRise.topSince === at(60) && vRise.seen === false && said(vRise, 60).advancedAt === null && said(vRise, 60).staticSeconds === 0);
  const vLead = run([[{ [V]: H + 2 }, 40, H + 9], [{ [V]: H + 2 }, 1820, H + 20]], vFirst);
  check("V3 one validator ahead of the others moves what was read, not the count: a standstill of the others shows", vLead.top === H + 2 && vLead.topSince === at(20) && vLead.read === H + 20 && said(vLead, 1820).staticSeconds === 1800);
  const vTurns = run([[{ [V]: H }, 0, H + 1], [{ [V]: H + 1 }, 20, H + 2], [{ [V]: H + 2 }, 40, H + 3], [{ [V]: H + 3 }, 60, H + 4]]);
  check("V4 validators that give each height in turns (half of them a round before the other half) are no standstill: the count follows the height the later half reaches", vTurns.top === H + 3 && vTurns.topSince === at(40) && said(vTurns, 60).staticSeconds === 20);
  const handOver = run([[{ a: H }, 0, H + 5], [{ a: H }, 1200, H + 5], [{ [V]: H + 5 }, 1220, H + 5]]);
  check("V5 validators that stand where DNO has read them since a seed's time: their height is as old as its first reading, so a standstill goes on when the seed stops answering", handOver.top === H + 5 && handOver.topSince === at(0) && handOver.seen === false && said(handOver, 1800).staticSeconds === 1800);
  const leftOut = run([[{ a: H }, 0], [{ a: H }, 2820], [{ [V]: H + 300 }, 2840, H + 300]]);
  check("V6 validators DNO did not count before (they stood far from the one seed) are not witnesses of that time: when they stand alone the count starts in that round", leftOut.top === H + 300 && leftOut.topSince === at(2840) && leftOut.seen === false && said(leftOut, 2840).staticSeconds === 0);
  const afterSeed = run([[{ a: H }, 0], [{ a: H + 1 }, 20], [{ [V]: H + 1 }, 40, H + 1]]);
  check("V7 validators standing on the height a seed just brought: the seed's arrival is still the last one DNO saw; when they move above it, there is none", said(afterSeed, 40).advancedAt === at(20) && said(afterSeed, 40).advancing === true
    && said(run([[{ [V]: H + 2 }, 60, H + 2]], afterSeed), 60).advancedAt === null);
  check("V8 a seed back above what validators alone showed is an arrival again; at or below it, none", run([[{ a: H + 3 }, 60]], afterSeed).seen === true && run([[{ a: H + 1 }, 60]], afterSeed).topSince === at(20)
    && (() => { const x = run([[{ [V]: H + 4 }, 60, H + 6], [{ a: H + 5 }, 80]], afterSeed); return x.top === H + 5 && x.seen === false && x.topSince === at(60); })());
}

console.log("\n[" + TAG + "] the height clock: the start-over");
{
  // a holds the top (H + 1, read from second 20); b follows a lower height
  const held = run([[{ a: H, b: H - 900 }, 0], [{ a: H + 1, b: H - 900 }, 20]]);
  const rises = (from, to, h0, start) => { const steps = []; for (let t = from, h = h0; t <= to; t += 20, h++) steps.push([{ b: h }, t]); return run(steps, start || held); };
  check("O1 no start-over while the held height is read: a node rising below it for half an hour changes nothing", (() => { const steps = []; for (let t = 40, h = H - 899; t <= 1840; t += 20, h++) steps.push([{ a: H + 1, b: h }, t]);
    const x = run(steps, held); return x.gave === null && x.top === H + 1 && x.topSince === at(20) && x.low === null; })());
  const r600 = rises(40, 640, H - 899), r620 = rises(40, 660, H - 899);
  check("O2 nothing read at the held height, and the node below keeps rising: the run begins with its first rise, and a rise more than 600 s later is the start-over (at 600 s it is not)", r600.gave === null && r600.top === H + 1 && J(r600.low) === J({ h: H - 899 + 30, since: at(40), last: at(640), hi: { b: H - 899 + 30 } })
    && J(r620.gave) === J({ top: H + 1, since: at(20), at: at(660) }) && r620.top === H - 899 + 31 && r620.topSince === at(660) && r620.seen === false && r620.read === H - 899 + 31 && r620.low === null, J(r600.low) + " " + J(r620.gave));
  check("O2b while a run is on and no height is given up, nothing says that DNO follows lower heights", r600.low !== null && said(r600, 640).following === false && said(r600, 640).staticSeconds === 620);
  check("O3 in the round of the start-over nothing is claimed, and the reading says that DNO follows lower heights", J(said(r620, 660)) === J({ staticSeconds: 0, advancedAt: null, since: at(660), advancing: false, stalled: false, following: true }));
  check("O4 no start-over without a rise in that round, however long the held height has not been read", (() => { const x = run([[{ b: H - 800 }, 40], [{ b: H - 799 }, 60], [{ b: H - 799 }, 5000], [{ b: H - 799 }, 9000]], held); return x.gave === null && x.top === H + 1 && said(x, 9000).staticSeconds === 8980; })());
  check("O5 the held height read again ends the run: ten minutes are counted from the next rise", (() => { const x = run([[{ a: H + 1, b: H - 500 }, 400], [{ b: H - 499 }, 420], [{ b: H - 498 }, 1020]], rises(40, 380, H - 899));
    const y = run([[{ b: H - 497 }, 1040]], x); return x.gave === null && J(x.low) === J({ h: H - 498, since: at(420), last: at(1020), hi: { b: H - 498 } }) && y.gave !== null && y.gave.at === at(1040); })());
  check("O6 so does a counted validator at the held height, or above it", (() => { const x = run([[{ b: H - 500 }, 400, H + 1], [{ b: H - 499 }, 420]], rises(40, 380, H - 899)); return x.gave === null && J(x.low) === J({ h: H - 499, since: at(420), last: at(420), hi: { b: H - 499 } }); })());
  check("O6b one block below the held height is not the held height: a counted validator there, or a source, leaves the run on", (() => { const x = run([[{ b: H - 500 }, 400, H]], rises(40, 380, H - 899)), near = rises(40, 380, H - 20), y = run([[{ b: H - 3, c: H }, 400]], near);
    return x.gave === null && x.low !== null && x.low.since === at(40) && x.read === H + 1 && near.low !== null && y.low !== null && y.low.since === at(40) && y.read === H + 1; })());
  check("O7 a pause of more than 600 s without a rise ends the run (at 600 s it goes on)", (() => { const a = run([[{ b: H - 899 }, 40], [{ b: H - 898 }, 640]], held), b = run([[{ b: H - 899 }, 40], [{ b: H - 898 }, 641]], held);
    return J(a.low) === J({ h: H - 898, since: at(40), last: at(640), hi: { b: H - 898 } }) && J(b.low) === J({ h: H - 898, since: at(641), last: at(641), hi: { b: H - 898 } }) && run([[{ b: H - 897 }, 660]], a).gave !== null && run([[{ b: H - 897 }, 661]], b).gave === null; })(),
    J(run([[{ b: H - 899 }, 40], [{ b: H - 898 }, 640]], held).low));
  const flap = (() => { const steps = []; for (let t = 40, i = 0; t <= 7240; t += 20, i++) steps.push([{ b: H - 800 + (i % 2) }, t]); return run(steps, held); })();
  check("O8 a node going back and forth between two heights never gets there: it goes above its own answers of the run once, and the run dies of the pause", flap.gave === null && flap.top === H + 1 && said(flap, 7240).staticSeconds === 7220);
  check("O9 nor does a three-step cycle, or a node that climbs for nine minutes and falls back to where it began", (() => { const s1 = [], s2 = []; for (let t = 40, i = 0; t <= 7240; t += 20, i++) { s1.push([{ b: H - 800 + (i % 3) }, t]); s2.push([{ b: H - 800 + (i % 27) }, t]); }
    return run(s1, held).gave === null && run(s2, held).gave === null; })());
  check("O10 a node that stands more than 25 blocks above the rising one holds the count: the rising one is catching up to it, and no run begins", (() => { const steps = []; for (let t = 40, h = H - 800; t <= 3640; t += 20, h++) steps.push([{ b: h, c: H - 400 }, t]);
    const x = run(steps, held); return x.gave === null && x.low === null && x.top === H + 1; })());
  check("O11 a node that stands above the rising one, within 25 blocks, makes it wait: no rise is counted while it is the round's highest; reaching its height is a rise, and ten minutes of rises from there are a start-over", (() => { const steps = []; for (let t = 40, h = H - 725; t <= 1160; t += 20, h++) steps.push([{ b: h, c: H - 700 }, t]);
    const wait = run(steps.slice(0, 25), held), tie = run(steps.slice(0, 26), held), x = run(steps.slice(0, -1), held), y = run(steps, held);
    return wait.low === null && wait.top === H + 1 && J(tie.low) === J({ h: H - 700, since: at(540), last: at(540), hi: { b: H - 700, c: H - 700 } }) && x.gave === null && y.gave !== null && y.gave.at === at(1160); })());
  check("O12 a run that is on: the round's highest source standing more than 25 blocks above its latest rise ends it (a node with no earlier answer too); within 25 it only waits; and after 600 s of waiting it is over", (() => { const on = rises(40, 300, H - 899);
    const waits = run([[{ b: H - 885, c: H - 861 }, 320], [{ b: H - 884, c: H - 861 }, 340]], on);
    return run([[{ b: H - 885, c: H - 859 }, 320]], on).low === null && run([[{ c: H - 860 }, 320]], on).low === null && J(waits.low) === J({ h: H - 886, since: at(40), last: at(300), hi: { b: H - 884, c: H - 861 } })
      && run([[{ b: H - 883, c: H - 861 }, 900]], waits).low !== null && run([[{ b: H - 883, c: H - 861 }, 901]], waits).low === null; })());
  check("O15 a source more than 25 blocks below its own last answer is on another height now: the run is over, whichever source it is (a rise in that same round begins a new one); 25 blocks back, the run goes on, and that source rises again only above its own highest answer of the run", (() => { const on = rises(40, 300, H - 899);
    const far = run([[{ b: H - 912 }, 320]], on), other = run([[{ b: H - 885, c: H - 1000 }, 320], [{ b: H - 884, c: H - 1026 }, 340]], on), near = run([[{ b: H - 911 }, 320], [{ b: H - 890 }, 340], [{ b: H - 885 }, 360]], on);
    return far.low === null && J(other.low) === J({ h: H - 884, since: at(340), last: at(340), hi: { b: H - 884, c: H - 1026 } }) && J(near.low) === J({ h: H - 885, since: at(40), last: at(360), hi: { b: H - 885 } }) && J(run([[{ b: H - 911 }, 320], [{ b: H - 890 }, 340]], on).low) === J({ h: H - 886, since: at(40), last: at(300), hi: { b: H - 886 } }); })());
  check("O16 a far-off answer inside a run, below the held height: the seed that gave it is back the next round, which ends the run; the next rise begins a new one, and the start-over comes ten minutes after that", (() => { const on = rises(40, 300, H - 899);
    const off = run([[{ b: H - 400 }, 320]], on), back = run([[{ b: H - 885 }, 340]], off), steps = []; for (let t = 360, h = H - 884; t <= 980; t += 20, h++) steps.push([{ b: h }, t]);
    const x = run(steps.slice(0, -1), back), y = run(steps, back);
    return J(off.low) === J({ h: H - 400, since: at(40), last: at(320), hi: { b: H - 400 } }) && back.low === null && x.gave === null && x.low.since === at(360) && y.gave !== null && y.gave.at === at(980) && y.gave.top === H + 1; })());
  check("O13 a node going back and forth beside one that stands at its upper height (a tie in every other round) rises once in a run: no start-over", (() => { const steps = []; for (let t = 40, i = 0; t <= 7240; t += 20, i++) steps.push([{ b: H - 800 + (i % 2), c: H - 799 }, t]);
    const x = run(steps, held); return x.gave === null && x.top === H + 1 && said(x, 7240).staticSeconds === 7220; })());
  check("O14 two nodes that follow the same heights and answer in turn, one a block behind the other: each rises above its own last answer, and the run goes on to a start-over", (() => { const steps = []; for (let t = 40, i = 0; t <= 700; t += 20, i++) steps.push([i % 2 ? { b: H - 800 + i } : { c: H - 801 + i }, t]);
    return run(steps, run([[{ a: H + 1, b: H - 900, c: H - 900 }, 30]], held)).gave !== null; })());
  // ---- while lower heights are followed
  const followed = run([[{ b: H - 867 }, 680], [{ b: H - 866 }, 700], [{ b: H - 866 }, 1300]], r620);
  check("F1 while DNO follows, the count runs from each rise of the followed heights, and no arrival is claimed", followed.top === H - 866 && followed.topSince === at(700) && followed.seen === false && J(followed.gave) === J({ top: H + 1, since: at(20), at: at(660) })
    && J(said(followed, 1300)) === J({ staticSeconds: 600, advancedAt: null, since: at(700), advancing: false, stalled: true, following: true }));
  const backOn = run([[{ a: H + 1 }, 1320]], followed);
  check("F2 the height given up read again by a source: the following ends, and that height is as old as its first reading", backOn.gave === null && backOn.top === H + 1 && backOn.topSince === at(20) && backOn.seen === false && backOn.read === H + 1 && backOn.readSince === at(20)
    && J(said(backOn, 1320)) === J({ staticSeconds: 1300, advancedAt: null, since: at(20), advancing: false, stalled: true, following: false }), J(backOn));
  const backAbove = run([[{ a: H + 2 }, 1320]], followed);
  check("F3 a seed back above it: an ordinary new height, seen arriving, set against everything read before the start-over", backAbove.gave === null && backAbove.top === H + 2 && backAbove.topSince === at(1320) && backAbove.seen === true && said(backAbove, 1320).following === false);
  check("F4 a counted validator at the height given up ends the following too: a seed still below it is then as old as that height's first reading", (() => { const x = run([[{ b: H - 10 }, 1320, H + 1]], followed); return x.gave === null && x.top === H - 10 && x.topSince === at(20) && x.read === H + 1 && x.readSince === at(20) && said(x, 1320).staticSeconds === 1300; })());
  check("F4b and so is a seed that stands where it stood while DNO followed: the count is not left on the followed heights' last rise", (() => { const x = run([[{ b: H - 866 }, 1320, H + 1]], followed), y = run([[{ b: H - 870 }, 1320, H + 2]], followed);
    return x.gave === null && x.top === H - 866 && x.topSince === at(20) && x.seen === false && said(x, 1320).staticSeconds === 1300 && said(x, 1320).following === false
      && y.gave === null && y.top === H - 866 && y.topSince === at(20) && y.read === H + 2 && y.readSince === at(1320); })());
  check("F4c one block below the height given up does not end the following: not a source there, not a counted validator", (() => { const x = run([[{ a: H }, 1320]], followed), y = run([[{ b: H - 866 }, 1320, H]], followed);
    return x.gave !== null && x.gave.top === H + 1 && said(x, 1320).following === true && x.top === H && x.topSince === at(1320) && x.seen === false && y.gave !== null && y.read === H && said(y, 1320).following === true; })());
  check("F5 validators alone at the height given up end it as well; below it they are followed like any source", (() => { const x = run([[{ [V]: H + 1 }, 1320, H + 1]], followed), y = run([[{ [V]: H - 5 }, 1320, H - 2]], followed);
    return x.gave === null && x.top === H + 1 && x.topSince === at(20) && y.gave !== null && y.top === H - 5 && y.topSince === at(1320) && y.seen === false; })());
  const second = (() => { const steps = [[{ c: H - 300 }, 1320], [{ c: H - 300, b: H - 866 }, 1340]]; for (let t = 1360, h = H - 865; t <= 2000; t += 20, h++) steps.push([{ b: h }, t]); return run(steps, followed); })();
  check("F6 a second start-over while DNO follows: the first height given up stays the one remembered (it is the highest), and the 24 hours run from the last start-over", second.gave !== null && second.gave.top === H + 1 && second.gave.since === at(20) && second.gave.at > at(1960) && second.top < H - 300, J(second.gave) + " top " + second.top);
  check("F6b what is given up and remembered is the highest height read, with its first reading, not the height the count stood on: a counted validator had shown a height above the seed's", (() => {
    const above = run([[{ a: H, b: H - 900 }, 0], [{ a: H }, 20, H + 5]]), x = rises(40, 660, H - 899, above);
    return above.top === H && above.read === H + 5 && J(x.gave) === J({ top: H + 5, since: at(20), at: at(660) }) && x.top === H - 899 + 31; })());
  check("F7 the height given up is remembered for 24 hours after the last start-over: at 86,400 s still, a millisecond later no more", run([[{ b: H - 865 }, 660 + 86400]], followed).gave !== null && stepHeightClock(followed, src({ b: H - 865 }), at(660 + 86400) + 1).gave === null);
  check("F8 once it is forgotten a seed's new height is an arrival again, set against what DNO read on the heights it followed", (() => { const x = stepHeightClock(followed, src({ b: H - 866 }), at(660 + 86400) + 1), y = run([[{ b: H - 865 }, 660 + 86420]], x), z = run([[{ b: H - 866 }, 660 + 86420]], x);
    return x.seen === false && y.seen === true && y.top === H - 865 && z.top === H - 866 && z.topSince === at(700); })());
  check("F9 a validators-only source rising below a held height is a run like a seed's: ten minutes of it are a start-over", (() => { const steps = []; for (let t = 40, h = H - 500; t <= 700; t += 20, h++) steps.push([{ [V]: h }, t, h + 1]); const x = run(steps, held); return x.gave !== null && x.gave.top === H + 1 && x.seen === false; })());
  check("F10 one far-off answer of a seed: it is a new height in that round (the seed rose to it), its step back ends the run, and about ten minutes of rises later DNO follows the lower heights", (() => {
    const hi = run([[{ a: H + 2 }, 40], [{ a: H + 90000 }, 60]], held), o = run([[{ a: H + 3 }, 80]], hi), steps = []; for (let t = 100, h = H + 4; t <= 720; t += 20, h++) steps.push([{ a: h }, t]);
    const x = run(steps, o), y = run(steps.slice(0, -1), o); return hi.top === H + 90000 && hi.seen === true && o.top === H + 90000 && o.low === null && y.gave === null && J(y.low) === J({ h: H + 34, since: at(100), last: at(700), hi: { a: H + 34 } })
      && J(x.gave) === J({ top: H + 90000, since: at(60), at: at(720) }) && x.top === H + 35; })());

  // ---- what is published
  const m = said(run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), 40);
  check("P1 what is published: seconds since the new height, when it arrived, 'advancing' within two rounds of it", m.staticSeconds === 20 && m.advancedAt === at(20) && m.since === at(20) && m.advancing === true && m.stalled === false
    && said(run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), 61).advancing === false && said(run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), 60).advancing === true && said(run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), 320).stalled === true && said(run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), 319).stalled === false);
  check("P1b the seconds are rounded to the nearest second, not cut: 20.6 s after the new height is 21, 20.4 s is 20", (() => { const s = run([[{ a: H }, 0], [{ a: H + 1 }, 20]]);
    return heightMovementOf(s, at(20) + 20600, true, cfg).staticSeconds === 21 && heightMovementOf(s, at(20) + 20400, true, cfg).staticSeconds === 20; })());
  check("P2 nothing is published without a reading in the latest round: not the count, not the time of the last new height, not that DNO follows", J(said(run([[{ a: H }, 0], [{ a: H + 1 }, 20]]), 40, false)) === J({ staticSeconds: null, advancedAt: null, since: null, advancing: false, stalled: false, following: false })
    && J(said(followed, 1300, false)) === J({ staticSeconds: null, advancedAt: null, since: null, advancing: false, stalled: false, following: false }) && J(said(newHeightClock(), 40)) === J({ staticSeconds: null, advancedAt: null, since: null, advancing: false, stalled: false, following: false }));
  check("P3 a host clock set back behind the count's start: nothing is said until it has passed it again, and never a negative time", (() => { const s = run([[{ a: H }, 0], [{ a: H + 1 }, 3600]]);
    return said(s, 3000).staticSeconds === null && said(s, 3000).advancedAt === null && said(s, 3600).staticSeconds === 0 && heightMovementOf(s, 0, true, cfg).staticSeconds === null && heightMovementOf(s, "x", true, cfg).staticSeconds === null; })());
  check("P4 a clock set back does not start anything over, nor forget what was given up", (() => { const x = run([[{ b: H - 865 }, 100]], followed); return x.gave !== null && x.top === H - 865 && x.topSince === at(100) && said(x, 100).staticSeconds === 0; })());
  check("P5 a state that is not one (from a damaged store, or another version) is taken as none: the count starts in this round and nothing is thrown", [null, undefined, 7, "x", {}, { top: "9" }, { top: H, topSince: "x" }, { top: H, topSince: at(0), read: null }, { last: null, top: H, topSince: at(0), read: H, readSince: at(0), low: "x", gave: 3 },
    { last: { a: "x" }, top: H, topSince: at(0), read: H, readSince: at(0), low: { h: 1 }, gave: { top: H } }].every((st) => { const x = stepHeightClock(st, src({ a: H + 1 }), at(20)); return x.top === H + 1 && x.low === null && x.gave === null && typeof heightMovementOf(st, at(20), true, cfg) === "object"; }));
  check("P5b a state that keeps a height the count stood on and not what was read with it is not a state either: the count starts in this round on what this round shows, also below that height", (() => {
    const x = stepHeightClock({ last: {}, top: H + 50, topSince: at(0), seen: true, read: null, readSince: null, low: null, gave: null }, src({ a: H + 1 }), at(20)), y = stepHeightClock({ last: {}, top: H + 50, topSince: at(0), seen: true, read: H + 50, readSince: "x" }, src({ a: H + 1 }), at(20));
    return x.top === H + 1 && x.topSince === at(20) && x.seen === false && x.read === H + 1 && x.readSince === at(20) && y.top === H + 1 && y.topSince === at(20); })());
  check("P6 the numbers the methodology states", RULE.clockForgetSeconds === 600 && RULE.clockRememberSeconds === 86400 && RULE.standstillSeconds === 1800 && RULE.bandBlocks === 25);
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
