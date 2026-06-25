// dahr-attestation-honesty.test.mjs — DAHR_ATTESTATION_HONESTY guard.
// Invariant: attestation claims (metric, badge, /health) are DERIVED from live
// state (latestAttestationState), never hardcoded. Must not claim "attested"
// while attestation is failing. Published-on-chain (true) != DAHR-attested.
// Run:  bun run src/dahr-attestation-honesty.test.mjs [baseUrl]   (NOT `bun test`)
// Breach: re-hardcode `dahrAttestations: 2` -> B1 FAILS; revert -> green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const BASE = process.argv[2] || "http://localhost:55225";
const GUARD = "DAHR_ATTESTATION_HONESTY";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
async function getText(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.text();
}
async function getJson(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

console.log(`\n${GUARD} guard  (base: ${BASE})\n`);

try {
  const health = await getJson("/health");
  const att = health.attestation;
  check("A1 /health exposes attestation {available,last_count,last_ok_at}",
        att && typeof att.available === "boolean" && typeof att.last_count === "number",
        JSON.stringify(att));
  const dash = await getText("/dashboard");
  const greenAttested = dash.includes("&#10003; DAHR Attested");
  if (att && att.available === false) {
    check("A2 unavailable => no green 'DAHR Attested' badge", !greenAttested,
          "green badge rendered while attestation.available=false");
    check("A3 honest 'attestation unavailable' copy present",
          dash.includes("DAHR attestation unavailable"));
  } else if (att && att.available === true) {
    check("A2 available => green 'DAHR Attested' badge present", greenAttested);
  } else {
    check("A2 attestation state present", false, "no attestation.available");
  }
  const fed = await getText("/federate");
  const m = fed.match(/demos_dahr_attestations_total\s+(\d+)/);
  check("A4 /federate metric == /health last_count (real, not fabricated)",
        m && att && parseInt(m[1], 10) === att.last_count,
        m ? ("metric=" + m[1] + " last_count=" + (att && att.last_count)) : "metric not found");
} catch (e) {
  check("A endpoint layer reachable", false, e.message);
}

check("B1 dahrAttestations not a hardcoded literal",
      !/dahrAttestations:\s*(dahrAvailable\s*\?\s*\d|\d)/.test(SRC),
      "fabricated/hardcoded value");
check("B1b dahrAttestations derives from latestAttestationState",
      /dahrAttestations:\s*latestAttestationState\.lastCount/.test(SRC));
const hasGreenLiteral = /&#10003; DAHR Attested/.test(SRC);
const hasConditional = /latestAttestationState\.lastCount\s*>\s*0[\s\S]{0,120}&#10003; DAHR Attested/.test(SRC);
check("B2 'DAHR Attested' badge conditional on latestAttestationState",
      !hasGreenLiteral || hasConditional, "green badge outside live-state conditional");
check("B3 no unconditional 'publishes DAHR-attested health data'",
      !/publishes DAHR-attested health data/.test(SRC));
check("B3b no unconditional 'publishes attested health data on-chain'",
      !/publishes attested health data on-chain/.test(SRC));
check("B4 latestAttestationState source-of-truth present",
      /let latestAttestationState\s*=/.test(SRC));

console.log(`\n${GUARD}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
