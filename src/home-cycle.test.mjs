// home-cycle.test.mjs — HOME_CYCLE guard: the This cycle card's three lines say what one observation compared and
// nothing more: the ACTIVE count as the agreeing seeds list it (or why not), the seeds status is made of, and the
// peer-listed count. A height counts only when a seed gave its own; "align" only for strong agreement; a stale
// observation is said to be stale. No "nodes aligned", no live / synced / producing / running. The page's script
// carries this module verbatim (H-check at the end), so the browser and the agent cannot write different lines.
// Run: bun src/home-cycle.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { leadCount, cycleLead, cycleSeeds, seedsParts, readbarText, cycleDoor } from "./home-cycle.mjs";

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

console.log("\n[" + TAG + "] the lead");
eq("C1 agreed: the count, as the agreeing seeds list it", cycleLead({ state: "agreed", active: 35, seeds_agreed: 2 }), "35 ACTIVE on chain as two public seeds list them.");
eq("C2 three seeds agree: three", cycleLead({ state: "agreed", active: 36, seeds_agreed: 3 }), "36 ACTIVE on chain as three public seeds list them.");
check("C3 not agreed or stale: not reported, with the list's reason",
  cycleLead({ state: "not_agreed", active: null, reason: "the public seeds returned different validator lists" }) === "ACTIVE on chain: not reported this cycle (the public seeds returned different validator lists)."
  && cycleLead({ state: "stale", reason: "the last read is older than 300 s" }) === "ACTIVE on chain: not reported this cycle (the last read is older than 300 s).");
check("C4 no read yet: reading", cycleLead({ state: "pending" }) === "ACTIVE on chain: reading." && cycleLead(null) === "ACTIVE on chain: reading.");
eq("C4b an agreed list without its seed count is not printed as one", cycleLead({ state: "agreed", active: 35, seeds_agreed: null, reason: null }), "ACTIVE on chain: not reported this cycle.");
check("C4c leadCount is the count the lead prints, else null (line 2 names no other)", leadCount({ state: "agreed", active: 35, seeds_agreed: 2 }) === 35
  && leadCount({ state: "agreed", active: 35, seeds_agreed: null }) === null && leadCount({ state: "stale", active: null }) === null && leadCount(null) === null);

console.log("\n[" + TAG + "] the seeds: compared");
const calmR = { publicNodes: seeds(true, true, false), agreement: ag("strong", 2, 2, 0), data_quality_reason: null, staleness_seconds: 3, height_static_seconds: 12, active_incidents: 0 };
eq("C5 the calm reading: the advisor's line exactly", cycleSeeds(calmR, 35), "2 of 3 configured seeds answered. Their heights align. Status is those seeds, not the 35.");
eq("C6 a height that has not moved for 5 min or more is said, in whole minutes",
  cycleSeeds({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("strong", 3, 3, 4), height_static_seconds: 12 * 60 + 5 }, 35),
  "3 of 3 configured seeds answered. Their heights align. The height has not moved for 12 min. Status is those seeds, not the 35.");
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
  "1 of 3 configured seeds answered. Heights were not compared. 1 active public incident. Status is those seeds.");
eq("C14 two answered, one gave its own height: not compared, and why",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: ag("unknown", 1, null, null), data_quality_reason: "too_few_heights" }, 35),
  "2 of 3 configured seeds answered; 1 gave its own height. Heights were not compared. Status is those seeds, not the 35.");
eq("C14b two answered, none gave its own height",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: ag("unknown", 0, null, null), data_quality_reason: "too_few_heights" }, 35),
  "2 of 3 configured seeds answered; none gave its own height. Heights were not compared. Status is those seeds, not the 35.");
eq("C15 a stale observation says its age, no answered count, and no 'not moved' from the old figures",
  cycleSeeds({ publicNodes: seeds(true, true, false), agreement: ag("unknown", 2, null, null), data_quality_reason: "stale", staleness_seconds: 7 * 60 + 30, height_static_seconds: 900, active_incidents: 0 }, 35),
  "The last observation of the configured seeds is 7 min old. Heights were not compared. Status is those seeds, not the 35.");
eq("C16 no observation yet", cycleSeeds({ publicNodes: [], agreement: ag("unknown", 0, null, null), data_quality_reason: "no_observation" }, null),
  "No observation of the configured seeds has completed yet. Status is those seeds.");
check("C17 /organism's fields only, not compared: fewer than two, said without a count",
  cycleSeeds({ agreement: "unknown", data_quality_reason: "too_few_answers" }, null) === "Fewer than two configured seeds answered. Heights were not compared. Status is those seeds."
  && cycleSeeds({ agreement: "unknown", data_quality_reason: "too_few_heights" }, null) === "Fewer than two configured seeds gave their own height. Heights were not compared. Status is those seeds."
  && cycleSeeds({ agreement: "weak" }, 35) === "Seeds: not reported in this reading. Height agreement is weak. Status is those seeds, not the 35.");

console.log("\n[" + TAG + "] the readbar, the door, numbers and words");
eq("C18 the readbar: what moves status first, never the status clause",
  readbarText({ ...calmR, publicNodes: seeds(true, true, true), agreement: ag("strong", 3, 3, 0), active_incidents: 1, height_static_seconds: 400 }),
  "1 active public incident. 3 of 3 configured seeds answered. Their heights align. The height has not moved for 6 min.");
eq("C18b the calm readbar is the card's first two sentences", readbarText(calmR), "2 of 3 configured seeds answered. Their heights align.");
check("C19 the peer-listed count, or nothing when it is not known", cycleDoor(46) === "46 peer-listed" && cycleDoor(null) === null && cycleDoor(undefined) === null);
check("C20 numbers are grouped the same way as on the page (en-US)", cycleLead({ state: "agreed", active: 1234, seeds_agreed: 2 }) === "1,234 ACTIVE on chain as two public seeds list them."
  && cycleDoor(1500) === "1,500 peer-listed" && cycleSeeds(calmR, 12345).endsWith("not the 12,345."));
const STATES = [
  calmR, { ...calmR, agreement: ag("moderate", 2, 2, 22) }, { ...calmR, publicNodes: seeds(true, true, true), agreement: ag("weak", 3, 1, 9000), active_incidents: 3 },
  { publicNodes: seeds(true, true, true), agreement: ag("strong", 2, 2, 0) }, { publicNodes: seeds(false, false, false), agreement: ag("unknown", 0, null, null), data_quality_reason: "too_few_answers" },
  { agreement: "strong" }, { agreement: "unknown", data_quality_reason: "stale" }, {}, null,
];
const all = STATES.flatMap((r) => [cycleSeeds(r, 35), readbarText(r)]).concat([cycleLead({ state: "agreed", active: 35, seeds_agreed: 2 }), cycleLead({ state: "stale", reason: "x" }), cycleDoor(46)]).join(" ");
check("C21 no 'nodes aligned', and no live / synced / producing / running / reachable in any state", !/nodes aligned|\blive\b|\bsynced\b|producing|running|reachable/i.test(all), all.slice(0, 300));
check("C22 no banned word in any state", !/\b(approved|certified|trusted|recommended|safe|best|scores?|ranking|network truth|canonical truth|sanctions-clean|compliant|ready)\b/i.test(all));
check("C23 'align' is said only for strong agreement", STATES.every((r) => !/\balign\b/.test(cycleSeeds(r, 35)) || seedsParts(r, 35).heights.endsWith("align.") && /strong/.test(JSON.stringify(r && r.agreement))));

console.log("\n[" + TAG + "] one source");
const MOD = readFileSync(join(__dir, "home-cycle.mjs"), "utf8").replace(/^export /gm, "");
const HOME = readFileSync(join(ROOT, "homepage.html"), "utf8");
check("H1 homepage.html carries this module verbatim (rebuild the page after editing it)", HOME.includes(MOD), "module text not found in homepage.html");
check("H2 the page calls the shared functions for the card", ["HOME_CYCLE.leadCount(", "HOME_CYCLE.cycleLead(", "HOME_CYCLE.cycleSeeds(", "HOME_CYCLE.readbarText(", "HOME_CYCLE.cycleDoor("].every((s) => HOME.includes(s)));

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
