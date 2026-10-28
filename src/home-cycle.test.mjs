// home-cycle.test.mjs — HOME_CYCLE guard: the first screen says what one observation compared and nothing more: the
// ACTIVE count only while the agreeing seeds list it, what status is made of (the seeds; or, since 1.2, a seed and the
// validators that stand in, or validators alone), and the band's four tiles. A height counts only when a seed gave its own; "align" only for strong agreement; a stale
// observation is said to be stale. No "nodes aligned", no live / synced / producing / running. The page's script
// carries this module verbatim (H-check at the end), so the browser and the agent cannot write different lines.
// Run: bun src/home-cycle.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { leadCount, cycleSeeds, seedsParts, seedsCalm, figureClocks, listSource, fieldReason, readbarText, trendReason, heightLine, tileMedian, tileSeeds, tileOnChain, tileAnswered, tilesBetween } from "./home-cycle.mjs";
import { BANNED_PUBLIC_LANGUAGE } from "./banned-public-language.mjs";

const TAG = "HOME_CYCLE";
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const seeds = (...ok) => ok.map((x) => ({ ok: x }));
const ag = (state, total, aligned, spread) => ({ state, total_nodes: total, aligned_nodes: aligned, median_block: 404414, block_spread: spread });
const eq = (name, got, want) => check(name, got === want, JSON.stringify(got));

console.log("\n[" + TAG + "] the ACTIVE count");
check("C4c leadCount is the count the on-chain tile shows, else null (an agreed list without its seed count is not one; the seeds line names no other)", leadCount({ state: "agreed", active: 35, seeds_agreed: 2 }) === 35
  && leadCount({ state: "agreed", active: 35, seeds_agreed: null }) === null && leadCount({ state: "stale", active: null }) === null && leadCount(null) === null);

console.log("\n[" + TAG + "] the seeds: compared");
const calmR = { publicNodes: seeds(true, true, false), agreement: ag("strong", 2, 2, 0), data_quality_reason: null, staleness_seconds: 3, height_static_seconds: 12, active_incidents: 0 };
eq("C5 the calm reading: the advisor's line exactly", cycleSeeds(calmR, 35), "2 of 3 configured seeds answered. Their heights align. Status is those seeds, not the 35.");
eq("C6 a height that has not moved for 5 min or more is said, in whole minutes",
  cycleSeeds({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("strong", 3, 3, 4), height_static_seconds: 12 * 60 + 5 }, 35),
  "3 of 3 configured seeds answered. Their heights align. No new height for 12 min. Status is those seeds, not the 35.");
eq("C7 three answered, two gave their own height: only those two are said to align",
  cycleSeeds({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("strong", 2, 2, 0) }, 35),
  "3 of 3 configured seeds answered; 2 gave their own height. Those heights align. Status is those seeds, not the 35.");
eq("C8 moderate because two heights are 22 blocks apart (both within 25 of the median): the spread, not 'do not all align'",
  cycleSeeds({ ...calmR, agreement: ag("moderate", 2, 2, 22) }, 35),
  "2 of 3 configured seeds answered. Their heights differ by 22 blocks. Status is those seeds, not the 35.");
eq("C9 three heights, two within 25 blocks of the median: the spread and the count",
  cycleSeeds({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("moderate", 3, 2, 4900), active_incidents: 2 }, 35),
  "3 of 3 configured seeds answered. Their heights differ by up to 4,900 blocks; 2 of 3 are within 25 blocks of the median. 2 active public incidents. Status is those seeds, not the 35.");
eq("C10 weak with two heights: the spread only (the median of two is one of them)",
  cycleSeeds({ ...calmR, agreement: ag("weak", 2, 1, 30), active_incidents: 1 }, null),
  "2 of 3 configured seeds answered. Their heights differ by 30 blocks. 1 active public incident. Status is those seeds.");
eq("C10b one of three within 25 blocks of the median: 'is', not 'are'",
  cycleSeeds({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("weak", 3, 1, 200) }, 35),
  "3 of 3 configured seeds answered. Their heights differ by up to 200 blocks; 1 of 3 is within 25 blocks of the median. Status is those seeds, not the 35.");
eq("C10c no seeds and no own-height count: the heights are the seeds', not a bare 'their'",
  cycleSeeds({ agreement: "strong" }, null), "Seeds: not reported in this reading. The seeds' heights align. Status is those seeds.");
eq("C11 the agreement as a word only (no spread published): the API's word",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: "moderate" }, 35),
  "2 of 3 configured seeds answered. Height agreement is moderate. Status is those seeds, not the 35.");
eq("C12 /organism's fields only (another observation than /health): the own-height count, no answered count",
  cycleSeeds({ agreement: { state: "strong", total_nodes: 2, aligned_nodes: 2, block_spread: 0 }, data_quality_reason: null, height_static_seconds: 0, active_incidents: 0 }, null),
  "2 configured seeds gave their own height. Their heights align. Status is those seeds.");

console.log("\n[" + TAG + "] the seeds: not compared");
eq("C13 one answered: not compared, and the count says why",
  cycleSeeds({ publicNodes: seeds(true, false, false), agreement: ag("unknown", 1, null, null), data_quality_reason: "too_few_answers", height_static_seconds: 0, active_incidents: 1 }, null),
  "1 of 3 configured seeds answered. Heights were not compared. 1 active public incident. Status is unknown.");
eq("C14 two answered, one gave its own height: not compared, and why",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: ag("unknown", 1, null, null), data_quality_reason: "too_few_heights" }, 35),
  "2 of 3 configured seeds answered; 1 gave its own height. Heights were not compared. Status is unknown.");
eq("C14b two answered, none gave its own height",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: ag("unknown", 0, null, null), data_quality_reason: "too_few_heights" }, 35),
  "2 of 3 configured seeds answered; none gave its own height. Heights were not compared. Status is unknown.");
eq("C15 a stale observation says its age, no answered count, and no 'not moved' from the old figures",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: ag("unknown", 2, null, null), data_quality_reason: "stale", staleness_seconds: 7 * 60 + 30, height_static_seconds: 900, active_incidents: 0 }, 35),
  "The last observation of the configured seeds is 7 min old. Heights were not compared. Status is unknown.");
eq("C16 no observation yet", cycleSeeds({ publicNodes: [], agreement: ag("unknown", 0, null, null), data_quality_reason: "no_observation" }, null),
  "No observation of the configured seeds has completed yet. Status is unknown.");
check("C17 /organism's fields only, not compared: fewer than two, said without a count",
  cycleSeeds({ agreement: "unknown", data_quality_reason: "too_few_answers" }, null) === "Fewer than two configured seeds answered. Heights were not compared. Status is unknown."
  && cycleSeeds({ agreement: "unknown", data_quality_reason: "too_few_heights" }, null) === "Fewer than two configured seeds gave their own height. Heights were not compared. Status is unknown."
  && cycleSeeds({ agreement: "weak" }, 35) === "Seeds: not reported in this reading. Height agreement is weak. Status is those seeds, not the 35.");

console.log("\n[" + TAG + "] 1.2: validators that answer as listed stand in for a seed that gave no height");
const wit = (mode, ownH, validators = null, answered) => ({ mode, counted: mode === "seeds_only" ? ownH : mode === "seed_and_validators" ? 1 + validators.counted : mode === "validators_only" ? validators.counted : 0,
  public_seeds: { configured: 3, answered: answered === undefined ? ownH : answered, own_height: ownH }, validators });
const val = (counted, read = 4, own = Math.max(counted, 1)) => ({ read, own_height: own, counted, list_agreed_at: "2026-10-03T08:07:00.000Z" });
const oneSeed = { publicNodes: seeds(true, false, false), agreement: ag("strong", 2, 2, 0), data_quality_reason: null, staleness_seconds: 3, height_static_seconds: 12, active_incidents: 0, witnesses: wit("seed_and_validators", 1, val(2)) };
eq("C24 two seed heights: the 1.1 line, to the letter, with or without the witnesses object", cycleSeeds({ ...calmR, witnesses: wit("seeds_only", 2, null) }, 35), cycleSeeds(calmR, 35));
eq("C25 one seed and two validators within 25 blocks of it", cycleSeeds(oneSeed, null), "1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it. Status is that seed and those validators.");
eq("C26 one validator: singular throughout", cycleSeeds({ ...oneSeed, witnesses: wit("seed_and_validators", 1, val(1)) }, null), "1 of 3 configured seeds answered. 1 validator that answers as listed is within 25 blocks of it. Status is that seed and that validator.");
eq("C27 the closest validator is 22 blocks away (moderate): the distance is said, and 'align' is not",
  cycleSeeds({ ...oneSeed, agreement: ag("moderate", 2, 2, 22), witnesses: wit("seed_and_validators", 1, val(1)) }, null), "1 of 3 configured seeds answered. 1 validator that answers as listed is within 25 blocks of it. The closest is 22 blocks from it. Status is that seed and that validator.");
eq("C27b validators further than 25 blocks from the seed are left out, and said", cycleSeeds({ ...oneSeed, witnesses: wit("seed_and_validators", 1, val(1, 4, 4)) }, null),
  "1 of 3 configured seeds answered. 1 validator that answers as listed is within 25 blocks of it. 3 others are more than 25 blocks from it. Status is that seed and that validator.");
eq("C27c one left out: singular; none left out, or a validator that gave no height: nothing added", cycleSeeds({ ...oneSeed, witnesses: wit("seed_and_validators", 1, val(2, 4, 3)) }, null) + " | " + cycleSeeds({ ...oneSeed, witnesses: wit("seed_and_validators", 1, val(2, 4, 2)) }, null),
  "1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it. 1 other is more than 25 blocks from it. Status is that seed and those validators. | 1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it. Status is that seed and those validators.");
eq("C28 two seeds answered, one gave its own height, and the list is agreed: the ACTIVE count is named as what status is not",
  cycleSeeds({ ...oneSeed, publicNodes: seeds(true, true, false), witnesses: wit("seed_and_validators", 1, val(3), 2) }, 35), "2 of 3 configured seeds answered; 1 gave its own height. 3 validators that answer as listed are within 25 blocks of it. Status is that seed and those validators, not the 35.");
const noSeed = { publicNodes: seeds(false, false, false), agreement: ag("strong", 3, 3, 1), data_quality_reason: null, staleness_seconds: 3, height_static_seconds: 12, active_incidents: 0, witnesses: wit("validators_only", 0, val(3)) };
eq("C29 no seed answered, three validators agree", cycleSeeds(noSeed, null), "0 of 3 configured seeds answered. 3 validators that answer as listed report heights that align. Status is those validators alone.");
eq("C30 the validators are up to 38 blocks apart (moderate)", cycleSeeds({ ...noSeed, agreement: ag("moderate", 3, 3, 38) }, null), "0 of 3 configured seeds answered. 3 validators that answer as listed report heights up to 38 blocks apart. Status is those validators alone.");
eq("C31 a seed answered without its own height, and validators give the reading", cycleSeeds({ ...noSeed, publicNodes: seeds(true, false, false), witnesses: wit("validators_only", 0, val(3), 1) }, null), "1 of 3 configured seeds answered; none gave its own height. 3 validators that answer as listed report heights that align. Status is those validators alone.");
const none1 = { publicNodes: seeds(true, false, false), agreement: ag("unknown", 1, null, null), data_quality_reason: "too_few_answers", height_static_seconds: 0, active_incidents: 0 };
eq("C32 validators were read and none is within 25 blocks of the one seed: no reading, and it says why", cycleSeeds({ ...none1, witnesses: wit("insufficient", 1, val(0)) }, null), "1 of 3 configured seeds answered. No validator that answers as listed is within 25 blocks of it. Status is unknown.");
const none0 = { ...none1, publicNodes: seeds(false, false, false), agreement: ag("unknown", 0, null, null) };
eq("C33 no seed, and the validators read give no majority", cycleSeeds({ ...none0, witnesses: wit("insufficient", 0, val(0, 4, 4)) }, null), "0 of 3 configured seeds answered. The validators that answer as listed give no majority within 25 blocks. Status is unknown.");
eq("C33b no seed, and one validator alone gave a height: it is said to be one, not a disagreement", cycleSeeds({ ...none0, witnesses: wit("insufficient", 0, val(0, 4, 1)) }, null), "0 of 3 configured seeds answered. 1 validator answered as listed with its own height; a reading needs two. Status is unknown.");
eq("C33c no seed, and no validator gave a height: nothing is said about where validators stand", cycleSeeds({ ...none0, witnesses: wit("insufficient", 0, val(0, 4, 0)) }, null), "0 of 3 configured seeds answered. No validator answered as listed with its own height. Status is unknown.");
eq("C33d one seed, and no validator gave a height: they are not said to be far from it", cycleSeeds({ ...none1, witnesses: wit("insufficient", 1, val(0, 4, 0)) }, null), "1 of 3 configured seeds answered. No validator answered as listed with its own height. Status is unknown.");
eq("C34 no validator was read (none kept, or the dials are off): nothing was compared, and the status is unknown", cycleSeeds({ ...none1, witnesses: wit("insufficient", 1, null) }, null), "1 of 3 configured seeds answered. Heights were not compared. Status is unknown.");
eq("C35 a stale observation is stale whatever it held", cycleSeeds({ ...oneSeed, agreement: ag("unknown", 1, null, null), data_quality_reason: "stale", staleness_seconds: 400, witnesses: wit("insufficient", 1, val(0)) }, null), "The last observation of the configured seeds is 6 min old. Heights were not compared. Status is unknown.");
eq("C36 /organism's fields only (no seed rows): the seeds' own count comes from witnesses, not from what agreement compared",
  cycleSeeds({ agreement: "strong", witnesses: wit("seed_and_validators", 1, val(2)) }, null), "1 configured seed gave its own height. 2 validators that answer as listed are within 25 blocks of it. Status is that seed and those validators.");
eq("C37 the same with no seed height", cycleSeeds({ agreement: "strong", witnesses: wit("validators_only", 0, val(2)) }, null), "No configured seed gave its own height. 2 validators that answer as listed report heights that align. Status is those validators alone.");
const still = { ...calmR, height_static_seconds: 1860, height_standstill_after_seconds: 1800 };
eq("C38 31 minutes without a new height: the line says that status no longer reads stable", cycleSeeds(still, 35), "2 of 3 configured seeds answered. Their heights align. No new height for 31 min; from 30 min on, status does not read stable. Status is those seeds, not the 35.");
eq("C38b at the limit itself, 1,800 s, the line already says so: the reading is degraded from that second on", cycleSeeds({ ...still, height_static_seconds: 1800 }, 35), "2 of 3 configured seeds answered. Their heights align. No new height for 30 min; from 30 min on, status does not read stable. Status is those seeds, not the 35.");
check("C39 one second under the limit, or no limit published (API 1.1), or nothing compared: the plain sentence", cycleSeeds({ ...still, height_static_seconds: 1799 }, 35).includes("No new height for 29 min. Status")
  && cycleSeeds({ ...still, height_standstill_after_seconds: undefined }, 35).includes("No new height for 31 min. Status") && cycleSeeds({ ...none1, height_static_seconds: 4000, height_standstill_after_seconds: 1800 }, null).includes("No new height for 66 min. Status"));
eq("C39b beside one seed the count is the seed's, and the line says whose: the validators counted with it can show higher heights meanwhile",
  cycleSeeds({ ...oneSeed, height_static_seconds: 2460, height_standstill_after_seconds: 1800 }, null) + " | " + cycleSeeds({ ...oneSeed, height_static_seconds: 420, height_standstill_after_seconds: 1800 }, null),
  "1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it. The seed has shown no new height for 41 min; from 30 min on, status does not read stable. Status is that seed and those validators."
  + " | 1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it. The seed has shown no new height for 7 min. Status is that seed and those validators.");
check("C39c with validators alone, with two seeds, and with a mode named without its validators the sentence names no seed",
  cycleSeeds({ ...noSeed, height_static_seconds: 2460, height_standstill_after_seconds: 1800 }, null).includes("report heights that align. No new height for 41 min; from 30 min on, status does not read stable. Status is those validators alone.")
  && cycleSeeds({ ...still, witnesses: wit("seeds_only", 2, null) }, 35) === cycleSeeds(still, 35)
  && cycleSeeds({ ...still, witnesses: { mode: "seed_and_validators", validators: { counted: 0 } } }, 35) === cycleSeeds(still, 35)
  && readbarText({ ...oneSeed, height_static_seconds: 420 }) === "1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it. The seed has shown no new height for 7 min.");
eq("C40 the readbar in a reading that rests on validators", readbarText({ ...oneSeed, active_incidents: 1 }), "1 active public incident. 1 of 3 configured seeds answered. 2 validators that answer as listed are within 25 blocks of it.");
check("C41 a mode named without its validators is not taken on its word: the line stays the seeds'", cycleSeeds({ ...calmR, witnesses: { mode: "validators_only", public_seeds: { own_height: 2 }, validators: null } }, 35) === cycleSeeds(calmR, 35)
  && cycleSeeds({ ...calmR, witnesses: { mode: "seed_and_validators", validators: { counted: 0 } } }, 35) === cycleSeeds(calmR, 35));

console.log("\n[" + TAG + "] the readbar, numbers and words");
eq("C18 the readbar: what moves status first, never the status clause",
  readbarText({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("strong", 3, 3, 0), active_incidents: 1, height_static_seconds: 400 }),
  "1 active public incident. 3 of 3 configured seeds answered. Their heights align. No new height for 6 min.");
eq("C18b the calm readbar is the card's first two sentences", readbarText(calmR), "2 of 3 configured seeds answered. Their heights align.");
check("C20 numbers are grouped the same way as on the page (en-US)", cycleSeeds(calmR, 12345).endsWith("not the 12,345."));
const STATES = [
  calmR, { ...calmR, agreement: ag("moderate", 2, 2, 22) }, { ...calmR, publicNodes: seeds(true, true, true), agreement: ag("weak", 3, 1, 9000), active_incidents: 3 },
  { publicNodes: seeds(true, true, true), agreement: ag("strong", 2, 2, 0) }, { publicNodes: seeds(false, false, false), agreement: ag("unknown", 0, null, null), data_quality_reason: "too_few_answers" },
  { agreement: "strong" }, { agreement: "unknown", data_quality_reason: "stale" }, {}, null,
  oneSeed, { ...oneSeed, agreement: ag("moderate", 2, 2, 22) }, noSeed, { ...noSeed, agreement: ag("moderate", 3, 3, 38) }, { ...none1, witnesses: wit("insufficient", 1, val(0)) }, still,
];
const all = STATES.flatMap((r) => [cycleSeeds(r, 35), readbarText(r)]).join(" ");
check("C21 no 'nodes aligned', and no live / synced / producing / running / reachable in any state", !/nodes aligned|\blive\b|\bsynced\b|producing|running|reachable/i.test(all), all.slice(0, 300));
check("C22 no banned word in any state", !BANNED_PUBLIC_LANGUAGE.test(all));
check("C23 'align' is said only for strong agreement", STATES.every((r) => !/\balign\b/.test(cycleSeeds(r, 35)) || seedsParts(r, 35).heights.endsWith("align.") && /strong/.test(JSON.stringify(r && r.agreement))));

// R-08: the trend card carries its reason (the comparison the agent makes), never an empty line under a word.
console.log("\n[" + TAG + "] trend reason (R-08)");
check("T1 improving, stable and worsening carry the same non-empty comparison", ["improving", "stable", "worsening"].every((t) => typeof trendReason(t) === "string" && trendReason(t).length > 20 && trendReason(t) === trendReason("stable")), String(trendReason && trendReason("stable")));
check("T2 the reason names the comparison: previous rounds, seeds answering, agreement, spread", /previous 10/.test(trendReason("stable")) && /15/.test(trendReason("stable")) && /seeds answering/.test(trendReason("stable")) && /agreement/.test(trendReason("stable")) && /spread/.test(trendReason("stable")));
check("T3 unknown and nothing give no reason (the definition says why)", trendReason("unknown") === "" && trendReason(null) === "" && trendReason(undefined) === "");
check("T4 the reason is backward-looking and judgment-free", !BANNED_PUBLIC_LANGUAGE.test(trendReason("stable")) && !/will|predict|forecast|expect/i.test(trendReason("stable")));

// The first screen's band: four tiles beside the status word, each one published figure on its own clock, in the words
// the sections below use for the same field. None is carried over from another read or another state.
console.log("\n[" + TAG + "] the band beside the status word");
const tv = (t) => t.value + (t.unit ? " " + t.unit : "") + " | " + t.line;
const org = { agreement: "strong", agreement_detail: { aligned_nodes: 2, total_nodes: 2, median_block: 53901, block_spread: 0 }, data_quality_reason: null,
  height_static_seconds: 12, height_last_advanced_at: "2026-10-27T13:21:25.000Z", witnesses: { mode: "seeds_only", public_seeds: { configured: 3, answered: 2, own_height: 2 } } };
eq("B1 the median block where heights were compared, with how long since a new height", tv(tileMedian(org)), "53,901 | no new height for 12 s");
eq("B2 one seed's height is not a median: not computed, even when the detail carries it", tileMedian({ ...org, agreement: "unknown", agreement_detail: { median_block: 6675 }, data_quality_reason: "too_few_answers" }).value, "not computed");
eq("B3 the /health shape (agreement an object) and the agent's state read the same", tileMedian({ agreement: { state: "moderate", median_block: 1234567 }, height_static_seconds: 400, witnesses: { mode: "seed_and_validators" } }).value + " | " + tileMedian({ agreement: { state: "moderate", median_block: 1234567 }, height_static_seconds: 400, witnesses: { mode: "seed_and_validators" } }).line, "1,234,567 | the seed has shown no new height for at least 6 min");
check("B4 no document: reading; no agreement field: not reported; a stale reading: no movement line", tileMedian(null).value === "reading" && tileMedian({}).value === "not reported"
  && tileMedian({ ...org, agreement: "unknown", data_quality_reason: "stale", height_static_seconds: 900 }).line === null, JSON.stringify(tileMedian({ ...org, agreement: "unknown", data_quality_reason: "stale" })));
check("B5 the movement line is the Agreement section's, case by case", [
  [{ height_static_seconds: 0, height_last_advanced_at: "2026-10-27T13:21:25.000Z" }, "a new height arrived this cycle"],
  [{ height_static_seconds: 0, risk_factors: ["following heights below a height read earlier"] }, "following lower heights; no arrival is claimed"],
  [{ height_static_seconds: 0 }, "count started this cycle; no arrival seen"],
  [{ height_static_seconds: 400, height_last_advanced_at: "x", witnesses: { mode: "seed_and_validators" } }, "the seed has shown no new height for 6 min"],
  [{ height_static_seconds: 90 }, "no new height seen for at least 90 s"],
  [{ height_static_seconds: 125, height_last_advanced_at: "x" }, "no new height for 2 min"],
  [{ height_static_seconds: null }, "height movement not observed this cycle"],
  [{}, null]].every(([r, want]) => heightLine(r) === want), [0, 90, 125].map((s) => heightLine({ height_static_seconds: s })).join(" | "));
eq("B6 the seeds that gave their own height, of those configured, and how many did not", tv(tileSeeds(org)), "2 of 3 | gave their own height; 1 did not");
eq("B7 one seed: singular, two did not", tv(tileSeeds({ ...org, witnesses: { mode: "seed_and_validators", public_seeds: { configured: 3, answered: 1, own_height: 1 } } })), "1 of 3 | gave its own height; 2 did not");
check("B7b every seed gave its own height: nothing to name; none did: said so (never '0 gave their own height')",
  tv(tileSeeds({ witnesses: { public_seeds: { configured: 3, answered: 3, own_height: 3 } } })) === "3 of 3 | gave their own height"
  && tv(tileSeeds({ witnesses: { public_seeds: { configured: 3, answered: 1, own_height: 0 } } })) === "0 of 3 | none gave its own height"
  && !/answer/.test(tv(tileSeeds({ witnesses: { public_seeds: { configured: 3, answered: 1, own_height: 0 } } }))), tv(tileSeeds({ witnesses: { public_seeds: { configured: 3, answered: 1, own_height: 0 } } })));
check("B8 a stale or unmade observation: unknown; no witnesses (API 1.1): not reported; no document: reading",
  tileSeeds({ ...org, data_quality_reason: "stale" }).value === "unknown" && tileSeeds({ ...org, data_quality_reason: "no_observation" }).value === "unknown"
  && tileSeeds({ agreement: "strong" }).value === "not reported" && tileSeeds(null).value === "reading");
const oc36 = { state: "agreed", active: 36, seeds_agreed: 2, observed_at: "2026-10-27T13:20:04.412Z" };
eq("B9 the ACTIVE count as the agreeing seeds list it, with the list's own clock", tv(tileOnChain({ on_chain_validators: oc36 })), "36 ACTIVE | list read 13:20:04 UTC");
check("B10 no count unless agreed now: a list not agreed or stale carries no 36, even with active in the object",
  ["not_agreed", "stale"].every((s) => { const t = tileOnChain({ on_chain_validators: { ...oc36, state: s } }); return t.value === "unknown" && t.unit === null && !/36/.test(tv(t)); })
  && tileOnChain({ on_chain_validators: { ...oc36, seeds_agreed: null } }).value === "unknown", tv(tileOnChain({ on_chain_validators: { ...oc36, state: "not_agreed" } })));
check("B11 pending: reading; no on_chain_validators: not reported; no document: reading",
  tileOnChain({ on_chain_validators: { state: "pending" } }).value === "reading" && tileOnChain({}).value === "not reported" && tileOnChain(null).value === "reading");
const w6 = { state: "observed", answered_as_listed: 6, round_at: "2026-10-27T13:20:05.118Z" };
eq("B12 the rows that answered DNO as their listed key, with the watch round's own clock", tv(tileAnswered({ validator_watch: w6 })), "6 | checked 13:20:05 UTC");
check("B13 a round that is not observed gives no count, whatever the object still holds",
  ["stale", "read_fault", "no_agreed_list"].every((s) => { const t = tileAnswered({ validator_watch: { ...w6, state: s } }); return t.value === "unknown" && !/\b6\b/.test(t.value); }), tv(tileAnswered({ validator_watch: { ...w6, state: "stale" } })));
check("B14 turned off: not observed; pending: reading; no validator_watch: not reported; observed without the count: not reported",
  tileAnswered({ validator_watch: { state: "disabled" } }).value === "not observed" && tileAnswered({ validator_watch: { state: "pending" } }).value === "reading"
  && tileAnswered({}).value === "not reported" && tileAnswered({ validator_watch: { state: "observed", answered_as_listed: null } }).value === "not reported");
eq("B15 the line under the band names both figures when both are shown", JSON.stringify(tilesBetween(36, 6)), JSON.stringify({ text: "36 and 6 are two observations on their own clocks. Neither shows how many validators are online.", link: "How the 36 split" }));
eq("B16 with either figure missing it names none", JSON.stringify(tilesBetween(null, 6)) + JSON.stringify(tilesBetween(36, null)),
  JSON.stringify({ text: "Neither validator figure shows how many validators are online.", link: "Validators on chain" }) + JSON.stringify({ text: "Neither validator figure shows how many validators are online.", link: "How the 36 split" }));
check("B17 numbers are grouped as on the page", tileOnChain({ on_chain_validators: { ...oc36, active: 1234 } }).value === "1,234" && tileAnswered({ validator_watch: { ...w6, answered_as_listed: 1234 } }).value === "1,234" && tv(tileSeeds({ witnesses: { public_seeds: { configured: 1200, own_height: 1100 } } })).startsWith("1,100 of 1,200 |"));
const band = [org, { ...org, agreement: "unknown" }, { ...org, data_quality_reason: "stale" }, null, {}].flatMap((r) => [tileMedian(r), tileSeeds(r)])
  .concat([oc36, { ...oc36, state: "not_agreed" }, { state: "pending" }].map((x) => tileOnChain({ on_chain_validators: x })))
  .concat([w6, { ...w6, state: "stale" }, { state: "disabled" }].map((x) => tileAnswered({ validator_watch: x }))).map(tv).concat([tilesBetween(36, 6).text, tilesBetween(null, null).text, tilesBetween(36, 6).link]).join(" ");
check("B18 no banned word, no latest / live / synced / producing / running / reachable in any band string", !BANNED_PUBLIC_LANGUAGE.test(band) && !/\blatest\b|\blive\b|\bsynced\b|producing|running|reachable/i.test(band), band.slice(0, 300));

console.log("\n[" + TAG + "] the seeds line: left out only when the band already says it all");
check("B19 the calm reading (every seed that answered gave its own height, aligned, nothing stalled, no incident): left out, with /health's detail or /organism's alone",
  seedsCalm(calmR, 35) && seedsCalm(calmR, null) && seedsCalm({ agreement: { state: "strong", total_nodes: 2, aligned_nodes: 2, block_spread: 0 }, data_quality_reason: null, height_static_seconds: 0, active_incidents: 0 }, null), cycleSeeds(calmR, 35));
check("B20 kept for every state the band does not say: fewer own heights than answers, a spread, validators standing in, a standstill, an incident, stale, no observation, nothing compared",
  [{ ...calmR, publicNodes: seeds(true, true, true) }, { ...calmR, agreement: ag("moderate", 2, 2, 22) }, oneSeed, noSeed, { ...calmR, height_static_seconds: 400 }, { ...calmR, active_incidents: 1 },
   { ...calmR, agreement: ag("unknown", 2, null, null), data_quality_reason: "stale", staleness_seconds: 400 }, { publicNodes: [], agreement: ag("unknown", 0, null, null), data_quality_reason: "no_observation" },
   none1, {}, null].every((r) => !seedsCalm(r, 35)), [{ ...calmR, publicNodes: seeds(true, true, true) }, oneSeed, none1].map((r) => cycleSeeds(r, 35)).join(" | "));
check("B21 left out means said elsewhere: the calm line's facts are the band's (the seeds tile's count, the on-chain count it names)", (() => {
  const t = tileSeeds({ witnesses: { public_seeds: { configured: 3, own_height: 2 } } });
  return seedsCalm(calmR, 35) && tv(t) === "2 of 3 | gave their own height; 1 did not" && cycleSeeds(calmR, 35).startsWith("2 of 3 configured seeds answered.");
})());

console.log("\n[" + TAG + "] Explain this reading: where each figure comes from");
eq("B22 each figure's source clock: the reading's, the list read's, the watch round's", JSON.stringify(figureClocks({ observed_at: "2026-10-27T23:52:00.973Z" }, { on_chain_validators: oc36, validator_watch: w6 })),
  JSON.stringify({ reading: "read 23:52:00 UTC", list: "read 13:20:04 UTC", check: "round 13:20:05 UTC" }));
check("B23 not read yet, not carried, turned off: each said, never a clock from elsewhere",
  JSON.stringify(figureClocks(null, null)) === JSON.stringify({ reading: "not read yet", list: "not read yet", check: "not read yet" })
  && JSON.stringify(figureClocks({}, {})) === JSON.stringify({ reading: "not reported", list: "not reported", check: "not reported" })
  && figureClocks({}, { validator_watch: { state: "disabled" } }).check === "turned off on this server"
  && figureClocks({}, { on_chain_validators: { state: "pending" } }).list === "not read yet"
  && figureClocks({}, { validator_watch: { state: "stale", round_at: "2026-10-27T23:40:00.000Z" } }).check === "round 23:40:00 UTC", JSON.stringify(figureClocks({}, {})));

check("B24 a field's reason in Explain: the reading's own text, else a plain statement that none is published",
  fieldReason("confidence", "Observed public signals agree") === "Observed public signals agree" && fieldReason("risk", "") === "No risk factors are listed in this reading."
  && fieldReason("data_quality", null) === "No reason is published for this value in this reading." && fieldReason("trend", "  ") === "No reason is published for this value in this reading.");
// F-FS-02: Explain's on-chain source line said "the validator list two public seeds returned alike" in every state,
// including a list that was not agreed (23 Oct capture, insufficient). It now says what /health says.
{
  const oc = (state, reason) => ({ on_chain_validators: { state, reason } });
  const cases = [
    [oc("agreed", "2 of 3 public seeds returned the same validator list"), "2 of 3 public seeds returned the same validator list"],
    [oc("agreed", ""), "at least two public seeds returned the same validator list"],
    [oc("not_agreed", "fewer than two public seeds returned a validator list"), "no agreed validator list: fewer than two public seeds returned a validator list"],
    [oc("not_agreed", "the public seeds returned different validator lists"), "no agreed validator list: the public seeds returned different validator lists"],
    [oc("stale", "the last read is older than 300 s"), "no current validator list: the last read is older than 300 s"],
    [oc("pending", "no read has completed yet"), "no validator list yet: no read has completed yet"],
    [oc("not_agreed", null), "no agreed validator list"],
    [oc("some_new_state", "x"), "no agreed validator list: x"],
    [{}, "the validator list"], [null, "the validator list"], [{ on_chain_validators: "agreed" }, "the validator list"]];
  const got = cases.map(([h]) => listSource(h));
  check("B25 the on-chain source line, in the list's own words: its reason when agreed, else 'no … list' with the reason; nothing read, only the noun",
    cases.every(([, want], i) => got[i] === want), JSON.stringify(got));
  const FX = join(ROOT, "tools", "homepage-preview", "fixtures");
  const fixtures = ["capture-20261021T072727Z", "capture-20261023T122827Z", "insufficient", "seed_and_validators", "seeds_only", "validators_only"].map((n) => JSON.parse(readFileSync(join(FX, "health-" + n + ".json"), "utf8")));
  const wrong = fixtures.map((h) => [h.on_chain_validators.state, listSource(h)]).filter(([st, s]) => st === "agreed" ? !/returned the same validator list/.test(s) : !s.startsWith("no agreed validator list: ") || /returned the same|alike/.test(s));
  check("B26 on every fixture, agreement is claimed iff the list was agreed (4 of 6 are not)", wrong.length === 0 && fixtures.filter((h) => h.on_chain_validators.state !== "agreed").length === 4, JSON.stringify(wrong));
}

console.log("\n[" + TAG + "] one source");
const MOD = readFileSync(join(__dir, "home-cycle.mjs"), "utf8").replace(/^export /gm, "");
const HOME = readFileSync(join(ROOT, "homepage.html"), "utf8");
check("H1 homepage.html carries this module verbatim (rebuild the page after editing it)", HOME.includes(MOD), "module text not found in homepage.html");
check("H2 the page calls the shared functions for the card", ["HOME_CYCLE.leadCount(", "HOME_CYCLE.cycleSeeds(", "HOME_CYCLE.readbarText(", "HOME_CYCLE.trendReason("].every((s) => HOME.includes(s)));
check("H3 the agent fills the trend card's reason from the same function (R-08)", readFileSync(join(__dir, "agent.mjs"), "utf8").includes("trend: trendReason(c.trend)"));
check("H4 the page fills the band and the Agreement section's movement line from the shared functions", ["HOME_CYCLE.seedsCalm(", "HOME_CYCLE.figureClocks(", "HOME_CYCLE.listSource(", "HOME_CYCLE.fieldReason(", "HOME_CYCLE.tileMedian(", "HOME_CYCLE.tileSeeds(", "HOME_CYCLE.tileOnChain(", "HOME_CYCLE.tileAnswered(", "HOME_CYCLE.tilesBetween(", "HOME_CYCLE.heightLine("].every((s) => HOME.includes(s)));
{
  const A = readFileSync(join(__dir, "agent.mjs"), "utf8");
  check("H5 the agent fills the band for readers without JavaScript from the same functions", ["tileMedian(", "tileSeeds(", "tileOnChain(", "tileAnswered(", "tilesBetween(", "figureClocks(", "listSource(", "seedsCalm(", "fieldReason("].every((s) => A.includes(s)) && /import \{[^}]*tileMedian[^}]*\} from "\.\/home-cycle\.mjs"/.test(A));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
