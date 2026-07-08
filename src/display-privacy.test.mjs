// display-privacy.test.mjs — DISPLAY_PRIVACY guard.
// Invariant: no public surface exposes raw transport (connection / IP:port) or a
// full public key (64-hex identity) as a node identifier. Identity may appear
// truncated or as an assigned/fleet name; transport never appears.
//   Node identity != connection endpoint.
// Privacy asserts on EVERY served representation of a dataset — HTML, JSON, and any future
// format — not only the renderer sanitized at the time. (Scope widened after the 2026-07
// /fixnet/health incident: a JSON endpoint leaked fleet topology the HTML renderer had
// already sanitized.)
// Run:  bun run src/display-privacy.test.mjs [baseUrl]   (NOT `bun test`)
// Breach ritual: restore `display = row.connection` -> B1 FAILS; revert -> green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const BASE = process.argv[2] || "http://localhost:55225";
const DISPLAY_PRIVACY = "DISPLAY_PRIVACY";

const RE_IPV4     = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const RE_HOSTPORT = /:\d{4,5}\b/;
const RE_FULL_ID  = /^0x[0-9a-fA-F]{64}$/;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
function isLeak(v) {
  if (typeof v !== "string") return false;
  return RE_IPV4.test(v) || RE_HOSTPORT.test(v) || RE_FULL_ID.test(v);
}
async function getJson(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

console.log(`\n${DISPLAY_PRIVACY} guard  (base: ${BASE})\n`);

try {
  const health = await getJson("/health");
  const vals = ((health.validator_growth || {}).validators) || [];
  const disc = vals.filter(v => !v.monitored);
  const dispLeaks = disc.filter(v => isLeak(v.display)).map(v => v.display);
  check("A1 homepage Discovered: no host:port / full-id in display",
        dispLeaks.length === 0, dispLeaks.slice(0, 5).join(", "));

  const peers = await getJson("/peers");
  check("A2a /peers scope = public_sanitized",
        peers.scope === "public_sanitized", "scope=" + peers.scope);
  const pd = peers.discovered || {};
  const entries = Object.entries(pd);
  const hasConn = entries.some(([, v]) => v && Object.prototype.hasOwnProperty.call(v, "connection"));
  check("A2b /peers entries carry no `connection` key", !hasConn);
  const keyLeaks = Object.keys(pd).filter(isLeak);
  check("A2c /peers map keys not full-id / host:port", keyLeaks.length === 0, keyLeaks.slice(0,5).join(", "));
  const valLeaks = [];
  for (const [, v] of entries) for (const vv of Object.values(v || {})) if (isLeak(vv)) valLeaks.push(String(vv));
  check("A2d /peers values no host:port / full-id", valLeaks.length === 0, valLeaks.slice(0,5).join(", "));
  check("A2e /peers privacy flags false-exposure",
        peers.privacy && peers.privacy.connection_exposed === false && peers.privacy.full_identity_exposed === false,
        JSON.stringify(peers.privacy));
} catch (e) {
  check("A endpoint layer reachable", false, e.message);
}

check("B1 display does not use row.connection",
      !/var\s+display\s*=\s*\(?\s*row\.connection/.test(SRC),
      "row.connection re-introduced");
check("B2 no raw `discovered: discoveredPeers` in any response",
      !/discovered:\s*discoveredPeers\b/.test(SRC),
      "raw discoveredPeers stringified");
check("B3 toPublicPeer boundary present",
      /function\s+toPublicPeer\s*\(/.test(SRC) && /toPublicPeer\s*\(/.test(SRC));
check("B4 resolveNodeDisplay resolver present and used",
      /function\s+resolveNodeDisplay\s*\(/.test(SRC) && /resolveNodeDisplay\s*\(\s*\{/.test(SRC));

console.log(`\n${DISPLAY_PRIVACY}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
