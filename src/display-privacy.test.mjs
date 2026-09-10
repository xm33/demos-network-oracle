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
import { toPublicSignals, PUBLIC_SIGNAL_TYPES, NON_PUBLIC_SIGNAL_TYPES } from "./signal-projection.mjs";

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

  check("A3 /health carries no reference key (fleet projection removed)",
        !Object.prototype.hasOwnProperty.call(health, "reference"),
        "reference key present");

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
check("B5 no reference producer key in source",
      !/reference:\s*\{/.test(SRC),
      "reference producer re-introduced");

{
  const refRes = await fetch(BASE + "/reference");
  const refBody = await refRes.text();
  check("R-A /reference has no XM33 host-alias join",
        !/XM33\s*[-–]\s*[nm][0-9]/i.test(refBody) && !/XM33\s*-\s*[A-Za-z]/.test(refBody),
        "XM33 operator-fleet join present on /reference");
  check("R-A /reference has no workers-debug copy",
        !/workers-debug/i.test(refBody),
        "workers-debug still on /reference");
}
check("B6 no hw-fleet-count fleet-size element in source",
      !/hw-fleet-count/.test(SRC),
      "dashboard fleet-count element re-introduced");

check("P0-TW public discovered_validators message has no fleet token",
      /crawl-visible this cycle/.test(SRC) && !/non-fleet validator\(s\) discovered/.test(SRC),
      "old non-fleet discovered message still in agent.mjs");
check("P0-TW dashboard h2 is cycle heading not Discovered Validators",
      /<h2[^>]*>Crawl-visible this cycle<\/h2>/.test(SRC) && !/>Discovered Validators<\/h2>/.test(SRC),
      "old Discovered Validators h2 still present");

{
  const hRes = await fetch(BASE + "/health");
  const hBody = await hRes.text();
  const h = JSON.parse(hBody);
  const ids = []
    .concat((h.publicNodes || []).map(n => n.identity))
    .concat(((h.validator_growth || {}).validators || []).map(v => v.identity))
    .filter(Boolean);
  const HEX66 = /^0x[0-9a-fA-F]{64}$/;
  const TRUNC = /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/;
  check("R-H /health has no trust_tier", !("trust_tier" in h) && !(h.publicNodes || []).some(n => "trust_tier" in n), "trust_tier present on /health");
  check("R-H /health has no instance_role", !("instance_role" in h), "instance_role present on /health");
  check("R-H /health identities not hex-66", ids.every(id => !HEX66.test(id)), "full key on /health");
  check("R-H /health identities truncId-shaped (non-short)", ids.filter(id => id.length >= 12).every(id => TRUNC.test(id)), "identity not truncId shape");
}

// ---- C: signal projection (executed, per gate 6 extraction) ----
{
  // C1: sets disjoint and complete against the actual emitted signal types
  const pub = [...PUBLIC_SIGNAL_TYPES], nonpub = [...NON_PUBLIC_SIGNAL_TYPES];
  const inter = pub.filter(t => NON_PUBLIC_SIGNAL_TYPES.has(t));
  check("C1a PUBLIC and NON_PUBLIC disjoint", inter.length === 0, inter.join(","));
  const union = new Set([...pub, ...nonpub]);
  // scrape actual emitted signal types: signals.push({ type: "..." }) and .unshift
  const emitted = new Set();
  const re = /signals\.(?:push|unshift)\(\{\s*type:\s*"([a-z_]+)"/g;
  let m; while ((m = re.exec(SRC)) !== null) emitted.add(m[1]);
  check("C1b emitted type count == 13", emitted.size === 13, "emitted=" + emitted.size);
  check("C1c union covers every emitted type (completeness)",
        [...emitted].every(t => union.has(t)),
        [...emitted].filter(t => !union.has(t)).join(","));
  check("C1d no set member is unemitted (no phantom types)",
        [...union].every(t => emitted.has(t)),
        [...union].filter(t => !emitted.has(t)).join(","));

  // C2: projection keeps only public types, order preserved, drops all non-public
  const fixture = [...union].map(t => ({ type: t, severity: "info", nodes: ["n1"], value: 1, message: "msg " + t }));
  const projected = toPublicSignals(fixture);
  const outTypes = projected.map(s => s.type);
  check("C2a projection output contains only public types",
        outTypes.every(t => PUBLIC_SIGNAL_TYPES.has(t)), outTypes.join(","));
  check("C2b projection drops all non-public types",
        outTypes.every(t => !NON_PUBLIC_SIGNAL_TYPES.has(t)), outTypes.join(","));
  check("C2c projection keeps exactly the 3 public types", outTypes.length === 3, "n=" + outTypes.length);

  // C3: fail-closed on malformed entries (dropped, not passed through)
  const malformed = [
    { type: "public_node_offline", severity: "info", nodes: "not-an-array", value: 1, message: "x" },
    { type: "public_node_offline", severity: "info", nodes: [1,2], value: 1, message: "x" },
    { type: "public_node_offline", severity: "info", nodes: ["n1"], value: 1, message: 42 },
    { type: "public_node_offline", severity: 7, nodes: ["n1"], value: 1, message: "x" },
    null,
    { type: "public_node_offline" },
  ];
  const mres = toPublicSignals(malformed);
  check("C3 malformed entries all dropped (fail closed)", mres.length === 0, "survived=" + mres.length);

  // C4: never-spread — extra fields (e.g. identity/connection) do not survive
  const leaky = [{ type: "public_node_offline", severity: "info", nodes: ["n1"], value: 1, message: "ok",
                   identity: "0x" + "a".repeat(64), connection: "10.0.0.1:55225", operator: "secret" }];
  const lres = toPublicSignals(leaky);
  check("C4a leaky public signal still projected", lres.length === 1, "n=" + lres.length);
  const keys = lres.length ? Object.keys(lres[0]).sort().join(",") : "";
  check("C4b output has exactly the 5 allowed fields (no identity/connection/operator)",
        keys === "message,nodes,severity,type,value", "keys=" + keys);
}

console.log(`\n${DISPLAY_PRIVACY}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
