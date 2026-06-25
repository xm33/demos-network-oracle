// c3-chain-mismatch-honesty.test.mjs — CHAIN_MISMATCH_HONESTY guard.
// Invariant: submission pipeline must NOT mark a node "ready" when its block is
// far AHEAD of the network head (different chain). "ready" requires block to MATCH
// head (objective-anchor), not satisfy one-sided behind<=0. computeStage is nested
// in the /community handler (not exportable) -> static ordering guard + endpoint check.
// Run: bun run src/c3-chain-mismatch-honesty.test.mjs [baseUrl]  (NOT `bun test`)
// Breach: remove the chain_mismatch branch -> B1+B2 FAIL; revert -> green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const BASE = process.argv[2] || "http://localhost:55225";
const GUARD = "CHAIN_MISMATCH_HONESTY";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}

console.log(`\n${GUARD} guard  (base: ${BASE})\n`);

try {
  const community = await (await fetch(BASE + "/community")).text();
  const m = community.match(/sum-val[^>]*>(\d+)<\/div><div class="sum-label">Ready<\/div>/);
  const readyCount = m ? parseInt(m[1], 10) : null;
  const hasChainMismatch = /chain[ _]mismatch/i.test(community);
  check("A1 /community renders submission stages",
        community.includes("sum-label") || community.includes("Reference surface"));
  check("A2 chain_mismatch rendered when far-ahead nodes present (or none)",
        hasChainMismatch || readyCount === null || !community.includes("probed_ok"),
        "foreign-chain nodes present but chain_mismatch not rendered");
  check("A3 Ready is a computed count card (pipeline ran)",
        readyCount !== null, "Ready summary card not found");
} catch (e) {
  check("A endpoint layer reachable", false, e.message);
}

check("B1 computeStage has a chain_mismatch branch for far-ahead blocks",
      /behind\s*<\s*-\s*AHEAD_TOLERANCE\s*\)\s*return\s*"chain_mismatch"/.test(SRC),
      "no behind < -AHEAD_TOLERANCE -> chain_mismatch branch");

const idxMismatch = SRC.search(/return\s*"chain_mismatch"/);
const idxReady = SRC.search(/if\s*\(behind\s*<=\s*0\)\s*return\s*"ready"/);
check("B2 chain_mismatch is checked BEFORE the ready branch",
      idxMismatch !== -1 && idxReady !== -1 && idxMismatch < idxReady,
      `mismatch@${idxMismatch} ready@${idxReady}`);

check("B3 netHead<=0 returns a non-ready stage (no anchor -> cannot assess)",
      /netHead\s*<=\s*0\s*\)\s*return\s*"reachable"/.test(SRC),
      "missing netHead<=0 -> reachable guard");

check("B4 display behind does not clamp ahead-of-head to 0",
      !/Math\.max\(0,\s*netHead\s*-\s*r\.probe_block\)/.test(SRC),
      "Math.max(0, ...) still clamps negative to 0");

check("B5 chain_mismatch in stageColors (amber, not green)",
      /chain_mismatch:"#d97706"/.test(SRC));
check("B6 chain_mismatch in counts and stageInfo reasons",
      /chain_mismatch:0/.test(SRC) && /chain_mismatch:\s*\["Node reports a block far ahead/.test(SRC));

console.log(`\n${GUARD}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
