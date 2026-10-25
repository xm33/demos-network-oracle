// commerce-freshness.test.mjs — what the probe runner's freshness says, run on the runner's own functions.
//
// The runner (src/commerce-probes.mjs) starts its loop when imported, so its freshness functions are taken from its
// source and run here against a registry, a probe history and a clock this test controls. Freshness answers one
// question: has the endpoint answered `healthy` within the authority's update window (its freshness_budget)?
// It is not the age of the authority's data. Run: bun src/commerce-freshness.test.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "commerce-probes.mjs"), "utf8");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const extract = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in commerce-probes.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n}\n", i) + 3); };

// A clock the test moves. The functions read Date.now() and new Date(); both come from this class.
let NOW = Date.parse("2026-10-25T12:00:00.000Z");
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const HOUR = 3600000;
const registry = { authorities: [
  { authority_id: "gleif", name: "GLEIF", path_type: "public_api", freshness_budget: "24h" },
  { authority_id: "ethos", name: "Ethos", path_type: "public_api" },
] };
const PROBE_CONFIG = { gleif: { probe_class: "http_open" }, ethos: { probe_class: "http_open" } };
function runner() {
  const previousResults = new Map();
  const code = [extract("function getAuthorityName("), extract("function getAuthorityPathType("), extract("function getFreshnessBudget("),
    extract("function classifyLatency("), extract("function evaluateFreshness("), extract("function assembleAuthorityResult(")].join("\n");
  return new Function("Date", "registry", "previousResults", "PROBE_CONFIG", code + "\nreturn assembleAuthorityResult;")(FakeDate, registry, previousResults, PROBE_CONFIG);
}
const healthy = { reachability: "healthy", reachability_reason: "HTTP 200", error_class: null, latency_ms: 120 };
const down = { reachability: "unavailable", reachability_reason: "Probe timed out (> 5s)", error_class: "timeout", latency_ms: 5000 };
const unsupported = { reachability: "unsupported", reachability_reason: "API key not configured", error_class: "api_key_missing", latency_ms: null, configured: false };

console.log("\n[COMMERCE_FRESHNESS] freshness = a healthy answer within the authority's update window");
{
  NOW = Date.parse("2026-10-25T12:00:00.000Z");
  const assemble = runner();
  const r1 = assemble("gleif", healthy);
  check("CF-F1 a healthy answer: fresh", r1.freshness === "fresh", JSON.stringify(r1));
  NOW += 23 * HOUR;
  const r2 = assemble("gleif", down);
  check("CF-F2 unavailable for 23 h after a healthy answer, window 24 h: still fresh (the last healthy answer is inside the window)", r2.freshness === "fresh" && r2.last_healthy_at === r1.observed_at, JSON.stringify(r2));
  NOW += 2 * HOUR;
  const r3 = assemble("gleif", down);
  check("CF-F3 unavailable 25 h after the last healthy answer: stale", r3.freshness === "stale", JSON.stringify(r3));
  NOW += HOUR;
  const r4 = assemble("gleif", healthy);
  check("CF-F4 healthy again: fresh again", r4.freshness === "fresh", JSON.stringify(r4));
}
{
  NOW = Date.parse("2026-10-26T12:00:00.000Z");
  const assemble = runner();   // a restarted runner: no history
  const r = assemble("gleif", down);
  check("CF-F5 after a restart, before any healthy answer: unknown (the time of the last healthy answer is kept in memory)", r.freshness === "unknown", JSON.stringify(r));
  const e = assemble("ethos", healthy);
  check("CF-F6 an authority with no update cadence: not_applicable, healthy or not", e.freshness === "not_applicable" && assemble("ethos", down).freshness === "not_applicable");
  const u = assemble("gleif", unsupported);
  check("CF-F7 unsupported (not probed): unknown", u.freshness === "unknown", JSON.stringify(u));
}

console.log("\n[COMMERCE_FRESHNESS] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
