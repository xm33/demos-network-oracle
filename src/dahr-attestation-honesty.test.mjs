// dahr-attestation-honesty.test.mjs — DAHR_ATTESTATION_HONESTY guard.
// Invariant: attestation claims (badge, /health) are DERIVED from live state
// (latestAttestationState), never hardcoded; DAHR is excluded from the v1
// public metric surface. Must not claim "attested" while attestation is failing.
// Published-on-chain (true) != DAHR-attested.
// DAHR is attempted on the cross-check RPCs only, never on the seeds whose answers enter status; the badge says so.
// The old internal /dashboard (which carried the DAHR badge) is removed: 404 on both listeners. The internal /fleet page
// makes no attestation claim at all.
// Run:  bun run src/dahr-attestation-honesty.test.mjs [baseUrl] [internalBaseUrl]   (NOT `bun test`)
// Breach: re-hardcode `dahrAttestations: 2` -> B1 FAILS; revert -> green.
// Recency: attestation.available is true only with a success within 15 monitor cycles (dahr-recency.mjs), evaluated
// when /health is served, and its bit is in the /health ETag. Breach: publish the latched dahrAvailable again -> B5
// FAILS; drop the bit from the ETag -> B5b FAILS; serve available:true with an old last_ok_at -> A5 FAILS.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dahrWindowMs } from "./dahr-recency.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const BASE = process.argv[2] || "http://localhost:55225";
const INTERNAL = process.argv[3] || process.env.DNO_INTERNAL_BASE || null;
const GUARD = "DAHR_ATTESTATION_HONESTY";
const WINDOW_MS = dahrWindowMs(parseInt(process.env.MONITOR_INTERVAL_MS || "20000"));
const SKEW_MS = 60000; // allowance for clock skew between the agent and this checker

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
async function getText(path, base) {
  const r = await fetch((base || BASE) + path);
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
  check("A1b attestation keeps exactly {available,last_count,last_ok_at}, in that order",
        att && JSON.stringify(Object.keys(att)) === JSON.stringify(["available", "last_count", "last_ok_at"]),
        att && JSON.stringify(Object.keys(att)));
  check("A5 available:true only with a recent last_ok_at (within 15 cycles + 60 s skew)",
        !att || att.available !== true ||
        (typeof att.last_ok_at === "number" && Date.now() - att.last_ok_at <= WINDOW_MS + SKEW_MS),
        att && ("last_ok_at age " + (typeof att.last_ok_at === "number" ? Math.round((Date.now() - att.last_ok_at) / 1000) + " s" : String(att.last_ok_at)) + ", window " + WINDOW_MS / 1000 + " s"));
  check("A6 last_ok_at null -> available false",
        !att || att.last_ok_at !== null || att.available === false, JSON.stringify(att));
  const pub = await fetch(BASE + "/dashboard");
  check("A2 /dashboard is not on the public listener", pub.status === 404, "HTTP " + pub.status);
  if (INTERNAL) {
    const gone = await fetch(INTERNAL + "/dashboard");
    check("A3 the old /dashboard (the badge's only place) is removed: 404 on the internal listener too", gone.status === 404, "HTTP " + gone.status);
    const fleet = await getText("/fleet", INTERNAL);
    check("A3b the internal /fleet page makes no attestation claim", !/DAHR|attest/i.test(fleet));
  } else {
    console.log("  skip A3 (no internal base given)");
  }
  const fed = await getText("/federate");
  check("A4 /federate exposes no DAHR attestation metric (excluded from v1 public contract)",
        !/demos_dahr_attestations_total/.test(fed),
        "demos_dahr_attestations_total present in /federate body");
} catch (e) {
  check("A endpoint layer reachable", false, e.message);
}

check("B1 dahrAttestations not a hardcoded literal",
      !/dahrAttestations:\s*(dahrAvailable\s*\?\s*\d|\d)/.test(SRC),
      "fabricated/hardcoded value");
const _cStartMarker = "// ---- Public metrics contract (default-deny allowlist) ----";
const _cEndMarker = "// ---- end public metrics contract ----";
const _cStartCount = SRC.split(_cStartMarker).length - 1;
const _cEndCount = SRC.split(_cEndMarker).length - 1;
const _cStart = SRC.indexOf(_cStartMarker);
const _cEnd = SRC.indexOf(_cEndMarker);
const _contractBlk =
  (_cStartCount === 1 && _cEndCount === 1 && _cStart !== -1 && _cEnd > _cStart)
    ? SRC.slice(_cStart, _cEnd + _cEndMarker.length)
    : "";

check("B1b public metrics excludes the retired DAHR attestation surface (v1 exclusion)",
      _contractBlk.length > 0 &&
      !/\bdemos_dahr_attestations_total\b/.test(_contractBlk) &&
      !/\bdahrAttestations\s*:/.test(SRC),
      "DAHR metric family in contract block or retired dahrAttestations field restored");
check("B2 no 'DAHR Attested' claim anywhere, and no DAHR badge left in any page source (the internal /dashboard that carried it is removed)",
      !/DAHR Attested/.test(SRC) && !/DAHR on cross-check RPCs: |DAHR attestation unavailable/.test(SRC),
      "attested claim or a leftover badge");
check("B3 no unconditional 'publishes DAHR-attested health data'",
      !/publishes DAHR-attested health data/.test(SRC));
check("B3b no unconditional 'publishes attested health data on-chain'",
      !/publishes attested health data on-chain/.test(SRC));
check("B4 latestAttestationState source-of-truth present",
      /let latestAttestationState\s*=/.test(SRC));
const _healthAtt = (SRC.match(/attestation:\s*\{\s*available:[^\n]*/g) || []);
check("B5 /health available is derived from last_ok_at per request, not from the latched dahrAvailable",
      _healthAtt.length === 1 &&
      /available:\s*healthAttAvailable\s*,/.test(_healthAtt[0]) &&
      /var healthAttAvailable\s*=\s*attestationAvailable\(latestAttestationState\.lastOkAt,\s*Date\.now\(\),\s*DAHR_AVAILABLE_WINDOW_MS\)/.test(SRC) &&
      !/dahrAvailable/.test(_healthAtt[0]) &&
      !/latestAttestationState\s*=\s*\{[^}]*\bavailable\s*:/.test(SRC),
      _healthAtt.join(" | ") || "no /health attestation line");
check("B5b the /health ETag carries the per-request available bit (a 304 cannot keep an expired true)",
      /var healthV = observationValidators\("health"\);[^\n]*\n\s*healthV\.etag = etagWithAttestation\(healthV\.etag, healthAttAvailable\);/.test(SRC) &&
      SRC.indexOf("var healthAttAvailable") < SRC.indexOf('var healthV = observationValidators("health")'));
check("B6 last_ok_at advances only on a success",
      /lastOkAt:\s*cycleAttestations\.length\s*>\s*0\s*\?\s*Date\.now\(\)\s*:\s*latestAttestationState\.lastOkAt/.test(SRC));
check("B7 the window is 15 monitor cycles, imported, not a literal",
      /const DAHR_AVAILABLE_WINDOW_MS\s*=\s*dahrWindowMs\(MONITOR_INTERVAL_MS\)/.test(SRC));

console.log(`\n${GUARD}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
