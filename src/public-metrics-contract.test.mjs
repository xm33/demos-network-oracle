// public-metrics-contract.test.mjs — PUBLIC_METRICS_CONTRACT guard.
//
// Default-deny public metrics contract for /federate and /metrics.
// Executes the EXACT production serializer bytes (isolation-loaded from the
// contract block in src/agent.mjs) against constructed inputs — it does not
// import agent.mjs, start the service, or copy the implementation.
//
// Layer 1 (static): contract block exists exactly once; the public route calls
// buildPublicMetrics(latestPublicRpcObservations, Date.now(), STALE_BOUND);
// legacy serializer has zero runtime callers; STALE_MULTIPLIER pinned to 3;
// contract block references none of the enumerated operational containers and
// names only admitted metric families.
// Layer 2 (behavioral): injections a–q + hardening vectors, each asserting on
// the returned Prometheus text via an EXACT positive structural allowlist.
//
// Run:  bun src/public-metrics-contract.test.mjs   (NOT `bun test` — execute-the-
//       script harness; `bun test` reports 0/0 false-green.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "PUBLIC_METRICS_CONTRACT";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
function count(hay, needle) { return hay.split(needle).length - 1; }
function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

// ============================================================================
// EXTRACTION + ANTI-FALSE-GREEN GUARDS
// ============================================================================
console.log(`\n[${TAG}] extraction guards`);

const START = "// ---- Public metrics contract (default-deny allowlist) ----";
const END   = "// ---- end public metrics contract ----";
const startCount = count(SRC, START), endCount = count(SRC, END);
check("X1 start marker exactly once", startCount === 1, "count=" + startCount);
check("X2 end marker exactly once",   endCount === 1,   "count=" + endCount);
const sIdx = SRC.indexOf(START), eIdx = SRC.indexOf(END);
check("X3 start precedes end", sIdx !== -1 && eIdx !== -1 && sIdx < eIdx);
const contractBlock = (sIdx !== -1 && eIdx > sIdx) ? SRC.slice(sIdx, eIdx + END.length) : "";
check("X4 block contains exactly one promLabelValue declaration",
      count(contractBlock, "function promLabelValue(") === 1);
check("X5 block contains exactly one buildPublicMetrics declaration",
      count(contractBlock, "function buildPublicMetrics(") === 1);

// ---- Layer 1: static architectural invariants ------------------------------
console.log(`\n[${TAG}] static invariants`);
// S1 is scoped to the unique route-shaped handler source line rather than a file-wide
// serializer reference. Source-text analysis, not a liveness proof: the line-anchored
// regex rejects ordinary '//'-commented copies (a comment cannot begin with '}').
const ROUTE_RE = /^\s*\}\s*else if\s*\(req\.url === "\/federate"\s*\|\|\s*req\.url === "\/metrics"\)\s*\{\s*$/gm;
const routeMatches = [...SRC.matchAll(ROUTE_RE)];
check("S1a public route-shaped handler line present exactly once",
      routeMatches.length === 1, "matches=" + routeMatches.length);
let routeBlock = "";
if (routeMatches.length === 1) {
  // brace-balance forward from the handler-opening '{' at the END of the matched line.
  const lineEnd = routeMatches[0].index + routeMatches[0][0].length;
  let i = SRC.lastIndexOf("{", lineEnd), depth = 0, started = false;
  for (; i < SRC.length && i !== -1; i++) {
    const ch = SRC[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; }
    routeBlock += ch;
    if (started && depth === 0) break;
  }
}
check("S1 route handler calls buildPublicMetrics(latestPublicRpcObservations, Date.now(), STALE_BOUND)",
      /buildPublicMetrics\(latestPublicRpcObservations,\s*Date\.now\(\),\s*STALE_BOUND\)/.test(routeBlock),
      "not found in bounded route block");
const legacyRefs = SRC.match(/\bgeneratePrometheusMetrics\s*\(/g) || [];
check("S2 legacy serializer: declaration only, zero runtime callers",
      legacyRefs.length === 1 && /function\s+generatePrometheusMetrics\s*\(\s*fleetData\s*\)/.test(SRC),
      "refs=" + legacyRefs.length);
check("S3 route no longer constructs fleetData wallet field", !/wallet:\s*AGENT_WALLET/.test(SRC));
check("S4 contract block has no prohibited label names",
      !/\b(wallet|url|host|side|node)=/.test(contractBlock) && !/\bwallet\b/.test(contractBlock));
check("S5 STALE_BOUND derived from STALE_MULTIPLIER * MONITOR_INTERVAL_MS",
      /const STALE_BOUND\s*=\s*STALE_MULTIPLIER\s*\*\s*MONITOR_INTERVAL_MS/.test(SRC));
check("S6 STALE_MULTIPLIER pinned to 3 (D5)", /const STALE_MULTIPLIER\s*=\s*3\s*;/.test(SRC));
// reject known operational-container dependencies from the contract block
const FORBIDDEN_IN_BLOCK = ["fleetData","latestHealthData","publicRpcStats","discoveredPeers",
  "latestAttestationState","latestPublicRpcObservations","latestPublicNodes","latestFixnetNodes",
  "problemHistory","dailyAlertCount","cycleCount","STALE_BOUND","MONITOR_INTERVAL_MS",
  "CROSS_VALIDATION_RPCS","AGENT_WALLET","RPC_URL"];
const purityHits = FORBIDDEN_IN_BLOCK.filter(t => new RegExp("\\b" + t + "\\b").test(contractBlock));
check("S7 contract block references none of the enumerated operational containers",
      purityHits.length === 0, "found: " + purityHits.join(","));
// only admitted metric-family names anywhere in the block source
const ADMITTED_FAMILIES = new Set(["dno_oracle_info","dno_public_rpc_up","dno_public_rpc_latency_ms"]);
const metricNames = new Set(contractBlock.match(/\b(?:dno|demos)_[a-z0-9_]+\b/g) || []);
const nonAdmitted = [...metricNames].filter(n => !ADMITTED_FAMILIES.has(n));
check("S8 contract block names only admitted metric families",
      metricNames.size > 0 && nonAdmitted.length === 0, "non-admitted: " + nonAdmitted.join(","));

// ============================================================================
// ISOLATION LOAD
// ============================================================================
function loadContract(version) {
  const loader = new Function("AGENT_VERSION",
    contractBlock + "\nreturn { buildPublicMetrics, promLabelValue };");
  return loader(version);
}
const TEST_VERSION = "test-version";
let bpm = null, plv = null;
try {
  const loaded = loadContract(TEST_VERSION);
  bpm = loaded.buildPublicMetrics; plv = loaded.promLabelValue;
  check("X6 isolation load returns callable buildPublicMetrics", typeof bpm === "function");
  check("X7 isolation load returns callable promLabelValue",     typeof plv === "function");
} catch (e) {
  check("X6 isolation load returns callable buildPublicMetrics", false, e.message);
  check("X7 isolation load returns callable promLabelValue",     false, e.message);
}

// ---- Output helpers ---------------------------------------------------------
const ALLOWED = Object.create(null);
ALLOWED.dno_oracle_info           = ["version"];
ALLOWED.dno_public_rpc_up         = ["rpc"];
ALLOWED.dno_public_rpc_latency_ms = ["rpc"];
const ALIAS_RE = /^validation-\d+$/;
const PROHIBITED_FAMILY_RE = /^(demos_fleet_|demos_node_|demos_alerts_|demos_dahr_)|^(demos_oracle_cycle_count|demos_public_rpc_up|demos_public_rpc_latency_ms|demos_oracle_info)\b/;
const RE_IPV4PORT = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\b/;
const RE_WALLET   = /0x[0-9a-fA-F]{40,}/;

function parseSample(line) {
  const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)$/.exec(line);
  if (!m) return null;
  const labels = Object.create(null);
  if (m[3]) for (const kv of m[3].split(",")) {
    const km = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)="(.*)"\s*$/.exec(kv);
    if (!km) return null;
    if (hasOwn(labels, km[1])) return null;
    labels[km[1]] = km[2];
  }
  return { family: m[1], labels, value: m[4] };
}
function sampleLines(body) { return body.split("\n").filter(l => l.length && !l.startsWith("#")); }
function familySamples(body, fam) { return sampleLines(body).map(parseSample).filter(s => s && s.family === fam); }
function headerCount(body, kind, fam) { return count(body, `# ${kind} ${fam} `); }

// EXACT positive structural allowlist — run against EVERY vector body.
function structurallyValid(body, label, expectedVersion = TEST_VERSION) {
  const problems = [];
  if (typeof body !== "string") { check(`struct[${label}] positive allowlist holds`, false, "non-string body"); return; }
  if (!body.endsWith("\n") || body.endsWith("\n\n")) problems.push("body must end with exactly one newline");
  for (const line of body.split("\n")) {
    if (!line.length) continue;
    if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) {
      const fam = line.split(" ")[2];
      if (!hasOwn(ALLOWED, fam)) problems.push("header for non-admitted family " + fam);
      if (PROHIBITED_FAMILY_RE.test(fam)) problems.push("prohibited family header " + fam);
      continue;
    }
    if (line.startsWith("#")) { problems.push("unexpected comment line"); continue; }
    const s = parseSample(line);
    if (!s) { problems.push("unparseable sample: " + line); continue; }
    if (!hasOwn(ALLOWED, s.family)) { problems.push("non-admitted family " + s.family); continue; }
    if (PROHIBITED_FAMILY_RE.test(s.family)) problems.push("prohibited family " + s.family);
    const want = ALLOWED[s.family].slice().sort().join(","), got = Object.keys(s.labels).sort().join(",");
    if (want !== got) problems.push(s.family + " label set " + JSON.stringify(got) + " != " + JSON.stringify(want));
    if (s.family === "dno_oracle_info") {
      if (s.value !== "1") problems.push("oracle_info value " + s.value);
      if (s.labels.version !== expectedVersion) problems.push("oracle_info version " + JSON.stringify(s.labels.version));
    } else {
      if (!ALIAS_RE.test(s.labels.rpc || "")) problems.push(s.family + " bad alias " + JSON.stringify(s.labels.rpc));
      if (s.family === "dno_public_rpc_up" && s.value !== "0" && s.value !== "1") problems.push("up value " + s.value);
      if (s.family === "dno_public_rpc_latency_ms") {
        const n = Number(s.value);
        if (!Number.isFinite(n) || n < 0 || !/^\d+(\.\d+)?$/.test(s.value)) problems.push("latency value " + s.value);
      }
    }
    if (/undefined|null|NaN|Infinity/.test(line)) problems.push("fallback-shaped token: " + line);
  }
  if (RE_IPV4PORT.test(body)) problems.push("IPv4:port shape in body");
  if (RE_WALLET.test(body))   problems.push("wallet-address shape in body");
  const oiN = familySamples(body, "dno_oracle_info").length;
  if (oiN !== 1) problems.push("oracle_info sample count " + oiN);
  if (headerCount(body, "HELP", "dno_oracle_info") !== 1 || headerCount(body, "TYPE", "dno_oracle_info") !== 1)
    problems.push("oracle_info HELP/TYPE count != 1");
  for (const fam of ["dno_public_rpc_up", "dno_public_rpc_latency_ms"]) {
    const samples = familySamples(body, fam);
    const n = samples.length, h = headerCount(body, "HELP", fam), t = headerCount(body, "TYPE", fam);
    const aliases = samples.map(s => s.labels.rpc);
    if (new Set(aliases).size !== aliases.length) problems.push(fam + " has duplicate rpc aliases");
    if (n > 0 && !(h === 1 && t === 1)) problems.push(fam + " has samples but HELP/TYPE counts " + h + "/" + t);
    if (n === 0 && !(h === 0 && t === 0)) problems.push(fam + " has no samples but HELP/TYPE counts " + h + "/" + t);
  }
  check(`struct[${label}] positive allowlist holds`, problems.length === 0, problems.slice(0, 4).join("; "));
}
function rpcFamiliesAbsent(body) {
  return familySamples(body, "dno_public_rpc_up").length === 0 &&
         familySamples(body, "dno_public_rpc_latency_ms").length === 0 &&
         headerCount(body, "HELP", "dno_public_rpc_up") === 0 && headerCount(body, "TYPE", "dno_public_rpc_up") === 0 &&
         headerCount(body, "HELP", "dno_public_rpc_latency_ms") === 0 && headerCount(body, "TYPE", "dno_public_rpc_latency_ms") === 0;
}
function oracleOnly(body, label) { check(`${label} RPC families entirely absent (samples+headers)`, rpcFamiliesAbsent(body)); }
function upOf(body, alias)  { const s = familySamples(body, "dno_public_rpc_up").find(x => x.labels.rpc === alias); return s ? s.value : null; }
function latOf(body, alias) { const s = familySamples(body, "dno_public_rpc_latency_ms").find(x => x.labels.rpc === alias); return s ? s.value : null; }
function latencyFamilyAbsent(body) {
  return familySamples(body, "dno_public_rpc_latency_ms").length === 0 &&
         headerCount(body, "HELP", "dno_public_rpc_latency_ms") === 0 && headerCount(body, "TYPE", "dno_public_rpc_latency_ms") === 0;
}
function rpcAliases(body, fam) { return familySamples(body, fam).map(s => s.labels.rpc).sort(); }
function exactAliases(body, label, expectedUp, expectedLatency) {
  const gotUp = rpcAliases(body, "dno_public_rpc_up");
  const gotLat = rpcAliases(body, "dno_public_rpc_latency_ms");
  const wantUp = expectedUp.slice().sort(), wantLat = expectedLatency.slice().sort();
  check(`${label} exact emitted RPC aliases`,
        JSON.stringify(gotUp) === JSON.stringify(wantUp) && JSON.stringify(gotLat) === JSON.stringify(wantLat),
        `up=${JSON.stringify(gotUp)} lat=${JSON.stringify(gotLat)}`);
}
function run(snapshot, now, bound) { return bpm(snapshot, now, bound); }

const NOW = 10000, BOUND = 300;
const fresh = (entries, observedAt = NOW - 1) => ({ observedAt, entries });
const V1 = "validation-1", V2 = "validation-2", V3 = "validation-3";

if (typeof bpm === "function") {
  console.log(`\n[${TAG}] behavioral vectors (a–q)`);
  let body;

  body = run(null, NOW, BOUND); structurallyValid(body, "a"); exactAliases(body, "(a)", [], []);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 5 }], NOW - (BOUND + 1)), NOW, BOUND);
  structurallyValid(body, "b"); exactAliases(body, "(b)", [], []);

  body = run(fresh([{ rpc: V1, up: false, latencyMs: null }]), NOW, BOUND); structurallyValid(body, "c");
  check("(c) failed entry → up=0", upOf(body, V1) === "0");
  check("(c) failed entry → no latency sample", latOf(body, V1) === null);
  check("(c) sole failed entry → latency family absent incl. HELP/TYPE", latencyFamilyAbsent(body));
  exactAliases(body, "(c)", [V1], []);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 0 }]), NOW, BOUND); structurallyValid(body, "d");
  check("(d) up=1", upOf(body, V1) === "1");
  check("(d) measured 0 ms latency served as 0", latOf(body, V1) === "0");
  exactAliases(body, "(d)", [V1], [V1]);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 12 }, { rpc: V2, up: false, latencyMs: null }]), NOW, BOUND);
  structurallyValid(body, "e");
  check("(e) up for both aliases", upOf(body, V1) === "1" && upOf(body, V2) === "0");
  check("(e) latency only for success", latOf(body, V1) === "12" && latOf(body, V2) === null);
  check("(e) latency family present", headerCount(body, "HELP", "dno_public_rpc_latency_ms") === 1);
  exactAliases(body, "(e)", [V1, V2], [V1]);

  body = run(fresh([{ rpc: V1, up: true }, { rpc: "", up: true, latencyMs: 3 }]), NOW, BOUND);
  structurallyValid(body, "f");
  check("(f) missing latency → up=1, latency not synthesized", upOf(body, V1) === "1" && latOf(body, V1) === null);
  check("(f) empty-alias entry omitted", !/rpc=""/.test(body));
  check("(f) no 'undefined' token anywhere", !body.includes("undefined"));
  exactAliases(body, "(f)", [V1], []);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }], NOW - (BOUND - 1)), NOW, BOUND); structurallyValid(body, "g");
  check("(g) age=BOUND-1 → fresh, up served", upOf(body, V1) === "1");
  exactAliases(body, "(g)", [V1], [V1]);
  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }], NOW - BOUND), NOW, BOUND); structurallyValid(body, "h");
  check("(h) age=BOUND → RPC families absent (strict bound)", rpcFamiliesAbsent(body));
  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }], NOW - (BOUND + 1)), NOW, BOUND); structurallyValid(body, "i");
  check("(i) age=BOUND+1 → RPC families absent", rpcFamiliesAbsent(body));

  body = run({ entries: [{ rpc: V1, up: true, latencyMs: 1 }] }, NOW, BOUND); structurallyValid(body, "j1"); exactAliases(body, "(j1)", [], []);
  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }], NaN), NOW, BOUND);   structurallyValid(body, "j2"); exactAliases(body, "(j2)", [], []);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }], NOW + 1), NOW, BOUND); structurallyValid(body, "k"); exactAliases(body, "(k)", [], []);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }, { rpc: V1, up: false, latencyMs: null }]), NOW, BOUND);
  structurallyValid(body, "l"); exactAliases(body, "(l)", [], []);

  body = run(fresh([{ rpc: V1, up: true, latencyMs: 1 }, { rpc: V2, up: "yes", latencyMs: 1 }, { rpc: V3, up: false, latencyMs: null }]), NOW, BOUND);
  structurallyValid(body, "m");
  check("(m) malformed-up entry omitted", upOf(body, V2) === null);
  check("(m) valid siblings still served", upOf(body, V1) === "1" && upOf(body, V3) === "0");
  exactAliases(body, "(m)", [V1, V3], [V1]);

  for (const [tag, bad] of [["-1", -1], ["NaN", NaN], ["Infinity", Infinity]]) {
    body = run(fresh([{ rpc: V1, up: true, latencyMs: bad }]), NOW, BOUND); structurallyValid(body, "n:" + tag);
    check(`(n) latency=${tag} → up=1 retained`, upOf(body, V1) === "1");
    check(`(n) latency=${tag} → latency absent`, latOf(body, V1) === null && latencyFamilyAbsent(body));
    exactAliases(body, "(n:" + tag + ")", [V1], []);
  }

  body = run({ observedAt: NOW - 1, entries: {} }, NOW, BOUND); structurallyValid(body, "o1"); exactAliases(body, "(o1)", [], []);
  body = run("bad", NOW, BOUND);                                structurallyValid(body, "o2"); exactAliases(body, "(o2)", [], []);

  body = run(fresh([{ rpc: V1, up: false, latencyMs: null }, { rpc: V2, up: false, latencyMs: null }]), NOW, BOUND);
  structurallyValid(body, "p");
  check("(p) up=0 for every alias", upOf(body, V1) === "0" && upOf(body, V2) === "0");
  check("(p) up family HELP+TYPE present exactly once", headerCount(body, "HELP", "dno_public_rpc_up") === 1 && headerCount(body, "TYPE", "dno_public_rpc_up") === 1);
  check("(p) latency family entirely absent incl. HELP/TYPE", latencyFamilyAbsent(body));
  exactAliases(body, "(p)", [V1, V2], []);

  body = run(fresh([{ rpc: V1, up: "x", latencyMs: 1 }, { rpc: V2, up: 1, latencyMs: 1 }]), NOW, BOUND);
  structurallyValid(body, "q"); exactAliases(body, "(q)", [], []);

  // ---- Hardening vectors --------------------------------------------------------
  console.log(`\n[${TAG}] hardening vectors`);
  body = run(fresh([{ rpc: "bogus", up: true, latencyMs: 1 }, { rpc: "bogus", up: true, latencyMs: 1 }, { rpc: V1, up: true, latencyMs: 2 }]), NOW, BOUND);
  structurallyValid(body, "H1");
  check("H1 duplicate INVALID aliases skipped, no snapshot rejection", upOf(body, V1) === "1" && latOf(body, V1) === "2");
  check("H1 invalid aliases never serialized", !body.includes("bogus"));
  exactAliases(body, "H1", [V1], [V1]);

  // H2 — version escaping, behavioral, routed through the full validator
  const nasty = 'v"1\\2\n3';
  try {
    const nl = loadContract(nasty);
    const escaped = nl.buildPublicMetrics(null, NOW, BOUND);
    const expectedEscaped = nl.promLabelValue(nasty);
    structurallyValid(escaped, "H2", expectedEscaped);
    exactAliases(escaped, "H2", [], []);
    const oiLine = escaped.split("\n").find(l => l.startsWith("dno_oracle_info{"));
    check("H2 nasty version emits a single-line oracle_info sample", !!oiLine);
    check("H2 quote/backslash/newline Prometheus-escaped exactly", !!oiLine && oiLine.includes('version="v\\"1\\\\2\\n3"'));
  } catch (e) { check("H2 nasty-version load/serialize", false, e.message); }

  // H3 — malformed now / staleBound (§1b clauses) → oracle_info only
  const goodSnap = fresh([{ rpc: V1, up: true, latencyMs: 1 }]);
  for (const [tag, n, b] of [["now=NaN", NaN, BOUND], ["now=Infinity", Infinity, BOUND],
                              ["bound=NaN", NOW, NaN], ["bound=Infinity", NOW, Infinity],
                              ["bound=0", NOW, 0], ["bound=-1", NOW, -1]]) {
    body = run(goodSnap, n, b); structurallyValid(body, "H3:" + tag); oracleOnly(body, `H3 ${tag}:`);
  }
}

console.log(`\n[${TAG}] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("  ✗ PUBLIC METRICS CONTRACT ASSERTION FAILED — do not deploy.");
  process.exit(1);
}
console.log("  ✓ public metrics surface conforms to the default-deny contract.");
process.exit(0);
