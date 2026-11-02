// fleet-view.test.mjs — FLEET_VIEW guard: the private fleet page's display rules (src/fleet-view.mjs).
// Every rule of SPEC-DNO-fleet-view v0.1 §4 is a case here, and every "never" has a negative case: a fixnet node is never
// compared with a testnet height; a missing input is never shown as "no issue"; a missing baseline never gives a 0; an
// old machine sample never shows its last value; a stale source greys only its own lamps.
// Run: bun src/fleet-view.test.mjs   (executable harness, not `bun test`)

import { FLEET_VIEW_RULE, readFleetViewConfig, exporterUrl, parseNodeMetrics, nodeState, machineState, validatorFacts, buildFleetView, renderFleetPage } from "./fleet-view.mjs";

const TAG = "FLEET_VIEW";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const NOW = Date.UTC(2026, 10, 2, 9, 9, 0);
const CYCLE = NOW - 3 * 60000;
const BASE = { height: 62814, observedAt: CYCLE - 20000 };
const cfg = function(name, chain, extra) { return Object.assign({ name: name, chain: chain, exporter: 29900, validator: false, note: null }, extra || {}); };
const probe = function(extra) { return Object.assign({ name: "fleet-n5", ok: true, block: 62814, blockFrom: "self", identityMatch: true, peers: 19, version: "0.9.9" }, extra || {}); };

// ---- config ---------------------------------------------------------------------------------------------------------
{
  const c = readFleetViewConfig({ n1: { chain: "fixnet", exporter: 29901 }, n5: { chain: "testnet", exporter: 29905, validator: true }, n3: { chain: "down", exporter: 29903, note: "configured note" }, x: { chain: "mainnet", exporter: "29902" } }, ["n1", "n5", "n3", "x", "missing"]);
  check("C1 fixnet kept", c[0].chain === "fixnet" && c[0].exporter === 29901);
  check("C2 validator flag", c[1].validator === true && c[1].chain === "testnet");
  check("C3 note kept", c[2].note === "configured note");
  check("C4 unknown chain and string port rejected", c[3].chain === "unknown" && c[3].exporter === null);
  check("C5 node missing from config still listed, unknown", c[4].chain === "unknown" && c[4].exporter === null && c[4].validator === false);
  check("C6 absent FLEET_VIEW serves", readFleetViewConfig(undefined, ["n1"])[0].chain === "unknown");
  check("C7 exporter URL is loopback /metrics only", exporterUrl(29905) === "http://127.0.0.1:29905/metrics");
  check("C8 bad ports give no URL", [0, 70000, 1.5, "29905", null].every(function(p) { return exporterUrl(p) === null; }));
}

// ---- metrics --------------------------------------------------------------------------------------------------------
const METRICS = [
  "# HELP node_load1 1m load average.", "# TYPE node_load1 gauge", "node_load1 0.62",
  'node_filesystem_avail_bytes{device="/dev/nvme0n1p2",fstype="ext4",mountpoint="/"} 4.18e+11',
  'node_filesystem_size_bytes{device="/dev/nvme0n1p2",fstype="ext4",mountpoint="/"} 1.0e+12',
  'node_filesystem_avail_bytes{device="/dev/nvme0n1p1",fstype="vfat",mountpoint="/boot/efi"} 5e+08',
  "node_memory_MemAvailable_bytes 6.1e+09", "node_memory_MemTotal_bytes 1.6e+10",
  'node_cpu_seconds_total{cpu="0",mode="idle"} 1', 'node_cpu_seconds_total{cpu="0",mode="user"} 1',
  'node_cpu_seconds_total{cpu="1",mode="idle"} 1', 'node_cpu_seconds_total{cpu="9",mode="steal"} 1', 'node_cpu_seconds_total{cpu="2",mode="idle"} 1', 'node_cpu_seconds_total{cpu="3",mode="idle"} 1',
].join("\n");
{
  const m = parseNodeMetrics(METRICS);
  check("M1 load", m.load1 === 0.62);
  check("M2 root mount only", m.rootAvail === 4.18e11 && m.rootSize === 1e12);
  check("M3 memory", m.memAvail === 6.1e9 && m.memTotal === 1.6e10);
  check("M4 cpus = distinct idle cpu labels", m.cpus === 4);
  const e = parseNodeMetrics("node_load1 NaN\nfoo 1\n");
  check("M5 absent facts are null, not 0", e.load1 === null && e.rootAvail === null && e.memAvail === null && e.cpus === null);
  check("M6 non-string", parseNodeMetrics(undefined).load1 === null);
}

// ---- nodes ----------------------------------------------------------------------------------------------------------
{
  const t = cfg("n5", "testnet"), f = cfg("n1", "fixnet"), d = cfg("n3", "down", { note: "configured note for a node that is down" }), u = cfg("x", "unknown");
  check("N1 no probe → incomplete", nodeState(t, undefined, BASE, CYCLE).code === "incomplete");
  check("N2 ok:false → no answer", nodeState(f, probe({ ok: false }), BASE, CYCLE).code === "no_answer");
  check("N3 down + no answer → note, neutral", (function(s) { return s.code === "down" && s.tone === "neutral" && s.text === "configured note for a node that is down"; })(nodeState(d, probe({ ok: false }), BASE, CYCLE)));
  check("N4 identity mismatch → bad, any chain", nodeState(f, probe({ identityMatch: false }), BASE, CYCLE).tone === "bad" && nodeState(t, probe({ identityMatch: false }), BASE, CYCLE).code === "identity_mismatch");
  const fx = nodeState(f, probe({ block: 0 }), BASE, CYCLE);
  check("N5 fixnet → not compared, no diff (NEVER compared)", fx.code === "not_compared" && fx.diff === undefined && fx.tone === "neutral");
  const fxFar = nodeState(f, probe({ block: 5 }), { height: 999999, observedAt: CYCLE }, CYCLE);
  check("N6 fixnet far below testnet baseline is still not 'behind'", fxFar.code === "not_compared" && fxFar.diff === undefined);
  check("N7 testnet, height from a peer → incomplete", nodeState(t, probe({ blockFrom: "peer" }), BASE, CYCLE).code === "incomplete");
  check("N8 testnet, no height → incomplete", nodeState(t, probe({ block: null }), BASE, CYCLE).code === "incomplete");
  const noBase = nodeState(t, probe(), null, CYCLE);
  check("N9 no baseline → comparison unavailable, no diff (NEVER 0)", noBase.code === "comparison_unavailable" && noBase.diff === undefined);
  check("N10 baseline older than 300 s at cycle → unavailable", nodeState(t, probe(), { height: 62814, observedAt: CYCLE - 300001 }, CYCLE).code === "comparison_unavailable");
  check("N11 baseline exactly 300 s → compared", nodeState(t, probe(), { height: 62814, observedAt: CYCLE - 300000 }, CYCLE).code === "no_issue");
  const behind = nodeState(t, probe({ block: 62713 }), BASE, CYCLE);
  check("N12 101 behind → behind, warn", behind.code === "behind" && behind.tone === "warn" && behind.diff === -101 && behind.text === "behind by 101 blocks");
  const edge = nodeState(t, probe({ block: 62714 }), BASE, CYCLE);
  check("N13 exactly 100 behind → no issue, diff shown", edge.code === "no_issue" && edge.diff === -100);
  const ahead = nodeState(t, probe({ block: 62820 }), BASE, CYCLE);
  check("N14 ahead → no issue, +diff", ahead.code === "no_issue" && ahead.diff === 6);
  check("N15 unknown chain → not compared", nodeState(u, probe(), BASE, CYCLE).code === "chain_unknown" && nodeState(u, probe(), BASE, CYCLE).diff === undefined);
  check("N16 baseline height not integer → unavailable", nodeState(t, probe(), { height: "62814", observedAt: CYCLE }, CYCLE).code === "comparison_unavailable");
}

// ---- machines -------------------------------------------------------------------------------------------------------
{
  const c = cfg("n1", "fixnet", { exporter: 29901 }), none = cfg("n1", "fixnet", { exporter: null });
  const fresh = { at: NOW - 30000, ok: true, metrics: parseNodeMetrics(METRICS) };
  const s = machineState(c, fresh, NOW);
  check("H1 fresh → reporting with values", s.code === "reporting" && Math.round(s.disk.pct) === 42 && s.load.cpus === 4);
  check("H2 not configured", machineState(none, fresh, NOW).code === "not_configured");
  check("H3 no sample yet", machineState(c, undefined, NOW).code === "no_reading");
  const old = machineState(c, { at: NOW - FLEET_VIEW_RULE.machineStaleMs - 1, ok: true, metrics: fresh.metrics }, NOW);
  check("H4 sample older than 5 min → no reading, NO values", old.code === "stale" && old.disk === undefined && old.mem === undefined);
  check("H5 exporter failed", machineState(c, { at: NOW, ok: false }, NOW).code === "no_reading");
  check("H6 all series missing", machineState(c, { at: NOW, ok: true, metrics: parseNodeMetrics("x 1") }, NOW).code === "no_reading");
  const low = parseNodeMetrics(METRICS.replace("4.18e+11", "1.0e+11"));
  check("H7 disk ≤ 10% → notice (warn)", machineState(c, { at: NOW, ok: true, metrics: low }, NOW).code === "disk_notice" && machineState(c, { at: NOW, ok: true, metrics: low }, NOW).tone === "warn");
}

// ---- validator ------------------------------------------------------------------------------------------------------
const ID5 = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const K5 = ID5.slice(2);
const round = function(extra) {
  return Object.assign({ roundAt: NOW - 30000, list: { agreed: true, rows: [{ key: K5, status: "2" }, { key: "ab", status: "2" }] },
    witnessFacts: { rows: [{ key: K5, confirmed: true, rounds: 60 }] }, everyRound: { window: { minutes: 60, counted_rounds: 60, complete: true } } }, extra || {});
};
{
  const v = validatorFacts(round(), ID5, NOW);
  check("V1 listed ACTIVE, confirmed, rounds", v.listed === true && v.status === "ACTIVE" && v.confirmed === true && v.rounds === 60 && v.countedRounds === 60 && v.stale === false);
  check("V2 key matching ignores 0x and case", validatorFacts(round(), "0X" + K5.toUpperCase(), NOW).listed === true);
  check("V3 no witness facts → confirmed unavailable (null), not 'no'", validatorFacts(round({ witnessFacts: null }), ID5, NOW).confirmed === null);
  check("V4 listed but absent from witness rows → no", validatorFacts(round({ witnessFacts: { rows: [] } }), ID5, NOW).confirmed === false);
  check("V5 list not agreed → listed unknown", (function(x) { return x.listAgreed === false && x.listed === null; })(validatorFacts(round({ list: { agreed: false } }), ID5, NOW)));
  check("V6 not on list", validatorFacts(round({ list: { agreed: true, rows: [] } }), ID5, NOW).listed === false);
  check("V7 old round → stale", validatorFacts(round({ roundAt: NOW - FLEET_VIEW_RULE.validatorStaleMs - 1 }), ID5, NOW).stale === true);
  check("V8 no round → all unknown", (function(x) { return x.listed === null && x.confirmed === null && x.stale === true; })(validatorFacts(null, ID5, NOW)));
  // The list carries status codes (validator-watch: "2" ACTIVE, "3" UNSTAKING), as read live on n3 on 2026-11-02.
  check("V9 code 2 → ACTIVE", validatorFacts(round(), ID5, NOW).status === "ACTIVE" && validatorFacts(round(), ID5, NOW).statusCode === "2");
  check("V10 code 3 → UNSTAKING, other codes → other", validatorFacts(round({ list: { agreed: true, rows: [{ key: K5, status: "3" }] } }), ID5, NOW).status === "UNSTAKING" && validatorFacts(round({ list: { agreed: true, rows: [{ key: K5, status: "9" }] } }), ID5, NOW).status === "other");
  check("V11 window completeness carried", validatorFacts(round(), ID5, NOW).windowComplete === true && validatorFacts(round({ everyRound: { window: { minutes: 60, counted_rounds: 1, complete: false } } }), ID5, NOW).windowComplete === false);
}

// ---- whole view and freshness ---------------------------------------------------------------------------------------
const CONFIG = readFleetViewConfig({
  n1: { chain: "fixnet", exporter: 29901 }, n3: { chain: "down", exporter: 29903, note: "configured note for a node that is down" },
  n5: { chain: "testnet", exporter: 29905, validator: true }, n7: { chain: "fixnet", exporter: 29910 },
}, ["n1", "n3", "n5", "n7"]);
const PROBES = [probe({ name: "fleet-n1", block: 0 }), probe({ name: "fleet-n3", ok: false }), probe(), probe({ name: "fleet-n7", ok: false })];
const SAMPLES = { n1: { at: NOW - 20000, ok: true, metrics: parseNodeMetrics(METRICS) }, n3: { at: NOW - 20000, ok: true, metrics: parseNodeMetrics(METRICS) }, n5: { at: NOW - 20000, ok: true, metrics: parseNodeMetrics(METRICS) }, n7: { at: NOW - 20000, ok: false } };
const INPUT = { config: CONFIG, identities: { n5: ID5 }, probes: PROBES, cycleAt: CYCLE, cycleIntervalMs: 20000, baseline: BASE, samples: SAMPLES, round: round(), wallet: { balance: 1284.5, lowMark: 500 }, agentStartedAt: NOW - 67 * 3600000 };
{
  const v = buildFleetView(INPUT, NOW);
  const by = function(n) { return v.nodes.find(function(x) { return x.name === n; }); };
  check("W1 states per node", by("n1").state.code === "not_compared" && by("n3").state.code === "down" && by("n5").state.code === "no_issue" && by("n7").state.code === "no_answer");
  check("W2 probe names with fleet- prefix match", by("n5").peers === 19);
  check("W3 machines reporting count", v.machinesReporting === 3 && v.machinesConfigured === 4);
  check("W4 attention names n7 (no answer) and n7 machine is not warn", v.attention.some(function(a) { return a.indexOf("n7") === 0; }) && !v.attention.some(function(a) { return a.indexOf("n3") === 0; }));
  check("W5 validator present and fresh", v.validator && v.validator.name === "n5" && v.validator.stale === false);
  check("W6 JSON-safe", JSON.parse(JSON.stringify(v)).nodes.length === 4);
  // A stale fleet cycle greys the node rows only: machines and the validator keep their own state.
  const sv = buildFleetView(Object.assign({}, INPUT, { cycleAt: NOW - FLEET_VIEW_RULE.cycleStaleMinMs - 1 }), NOW);
  check("W7 stale cycle → every node row stale, and no per-node guesses in the attention line", sv.nodes.every(function(n) { return n.state.code === "stale"; }) && sv.cycle.stale === true && !sv.attention.some(function(a) { return /^n\d/.test(a); }));
  check("W8 stale cycle does NOT grey machines", sv.machines.find(function(m) { return m.name === "n1"; }).state.code === "reporting");
  check("W9 stale cycle does NOT grey the validator", sv.validator.stale === false && sv.validator.confirmed === true);
  check("W10 attention names the stale source", sv.attention.indexOf("fleet cycle is stale") >= 0);
  const nv = buildFleetView(Object.assign({}, INPUT, { round: round({ roundAt: NOW - 600000 }) }), NOW);
  check("W11 stale validator does NOT grey nodes", nv.nodes.find(function(n) { return n.name === "n5"; }).state.code === "no_issue" && nv.attention.indexOf("validator reading is stale") >= 0);
  const nb = buildFleetView(Object.assign({}, INPUT, { baseline: null }), NOW);
  check("W12 no baseline → n5 comparison unavailable, never 0", nb.nodes.find(function(n) { return n.name === "n5"; }).state.code === "comparison_unavailable");
  // The fleet cycle runs every MONITOR_INTERVAL_MS (20 s by default): stale after 2 intervals, but never before 5 min.
  const quick = buildFleetView(Object.assign({}, INPUT, { cycleAt: NOW - 60000 }), NOW);
  check("W15 a 20 s cycle 60 s old is NOT stale (5-min floor)", quick.cycle.stale === false && quick.cycle.staleAfterMs === FLEET_VIEW_RULE.cycleStaleMinMs);
  const slow = buildFleetView(Object.assign({}, INPUT, { cycleIntervalMs: 1200000, cycleAt: NOW - 30 * 60000 }), NOW);
  check("W16 a 20-min cycle stays fresh up to twice its interval", slow.cycle.stale === false && slow.cycle.staleAfterMs === 2400000);
  const empty = buildFleetView({}, NOW);
  check("W13 empty inputs serve", empty.nodes.length === 0 && empty.cycle.stale === true && empty.validator === null);
  const nob = buildFleetView(Object.assign({}, INPUT, { cycleAt: null, probes: [] }), NOW);
  check("W14 no fleet cycle since start → 'not observed yet', one attention entry, not called stale", nob.nodes.every(function(n) { return n.state.code === "not_observed"; }) && nob.attention.indexOf("no fleet cycle yet since the agent started") >= 0 && nob.attention.indexOf("fleet cycle is stale") < 0);
}

// ---- HTML -----------------------------------------------------------------------------------------------------------
{
  const html = renderFleetPage(buildFleetView(INPUT, NOW), { head: '<link rel="stylesheet" href="/assets/site-x.css">', markPath: "/assets/m.jpg" }, NOW);
  check("R1 noindex meta", html.indexOf('<meta name="robots" content="noindex, nofollow, noarchive">') >= 0);
  check("R2 no canonical, no share tags", !/rel="canonical"|property="og:|name="twitter:/.test(html));
  check("R3 PRIVATE band and chip", html.indexOf("PRIVATE · fleet") >= 0 && html.indexOf('class="pv-chip">PRIVATE<') >= 0);
  check("R4 public links are absolute", html.indexOf('href="https://demos-oracle.com/"') >= 0 && !/href="\/(sources|methodology|reference|docs|criteria|timeline)"/.test(html));
  check("R5 no script on the page", !/<script/i.test(html));
  check("R6 fixnet row shows no difference", /<span class="nm">n1<\/span>[\s\S]*?To seeds&#39; median|<span class="nm">n1<\/span>/.test(html) && html.indexOf("answering · not compared") >= 0);
  check("R7 escapes", renderFleetPage(buildFleetView(Object.assign({}, INPUT, { config: readFleetViewConfig({ "<b>": { chain: "fixnet" } }, ["<b>"]) }), NOW), {}, NOW).indexOf("<b>&lt;b&gt;") === -1);
  check("R8 words name the real comparison rule (no 'disagree')", html.indexOf("fewer than two seeds") >= 0 && html.indexOf("disagree") === -1);
  const never = renderFleetPage(buildFleetView(Object.assign({}, INPUT, { cycleAt: null, probes: [] }), NOW), {}, NOW);
  check("R10 never observed: the summary says not observed, never '0 of N answering' or 'stale'", never.indexOf("Nodes: not observed yet") >= 0 && !/\d+ of \d+ answering/.test(never) && never.indexOf("<b>stale</b>") < 0 && never.indexOf("none since the agent started") >= 0);
  const old = renderFleetPage(buildFleetView(Object.assign({}, INPUT, { cycleAt: NOW - 3 * FLEET_VIEW_RULE.cycleStaleMinMs }), NOW), {}, NOW);
  check("R11 stale cycle: the summary says stale with the cycle's time, never '0 of N answering'", old.indexOf("Nodes: stale · last fleet cycle") >= 0 && !/\d+ of \d+ answering/.test(old));
  const vHtml = renderFleetPage(buildFleetView(INPUT, NOW), {}, NOW);
  check("R12 ACTIVE shown as the word with an ok lamp, never the raw code", /data-tone="ok"><\/span>ACTIVE</.test(vHtml) && !/<\/span>2<\/span>/.test(vHtml));
  const fresh = renderFleetPage(buildFleetView(Object.assign({}, INPUT, { round: round({ witnessFacts: { rows: [{ key: K5, confirmed: false, rounds: 0 }] }, everyRound: { window: { minutes: 60, counted_rounds: 1, complete: false } } }) }), NOW), {}, NOW);
  check("R13 just after a restart: 'not confirmed this round' (neutral) and 'window still filling' (grey), no warn lamp in the validator section", (function() { var sec = fresh.slice(fresh.indexOf('id="validator"'), fresh.indexOf('id="machines"')); return sec.indexOf("not confirmed this round") >= 0 && sec.indexOf("window still filling") >= 0 && sec.indexOf('data-tone="warn"') < 0; })());
  const banned = /\b(score|ranking|certified|approved|trusted|SLA|uptime)\b/i;
  check("R9 no banned or retired words", !banned.test(html), (html.match(banned) || [])[0]);
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
