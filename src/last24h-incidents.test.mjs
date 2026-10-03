// last24h-incidents.test.mjs — LAST24H_INCIDENTS guard: which records the 24-hour critical counts include.
// Runs the real compute24hSummary() from agent.mjs (extracted from the source with its helpers and constants) against
// an in-memory SQLite database built from the shipped table definitions.
// Rule under test: last_24h.active_critical_public_incidents and critical_public_incidents_in_window count critical
// public incidents only, as active_incidents does. Fleet incidents and DNO's own condition records are left out.
// Run: bun src/last24h-incidents.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "LAST24H_INCIDENTS";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const extract = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n}\n", i) + 3); };
const line = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n", i) + 1); };
const code = [
  line("var CHAIN_BUCKET_MIN_24H = "), line("var CHAIN_STATIC_RUN_MIN_24H = "), line("var CHAIN_ADVANCE_PCT_24H = "), line("var COVERAGE_GATE_24H = "),
  line("var FLEET_NODES_24H = "), line("const PUBLIC_VISIBILITY_MARKER = "), line("const PUBLIC_DEGRADED_MARKER = "), line("const PUBLIC_UNSTABLE_MARKER = "),
  line("const MARKER_NODES = "), line("const INCIDENT_RECONCILIATION_START_AT = "),
  extract("function isPublicConditionMarker("), extract("function expectedCycles24h("), line("function isFleetName("),
  extract("function incidentScope("), extract("function isFleetIncident_24h("), extract("function computeChainMovement_24h("),
  extract("function computeLongestNonStable_24h("), extract("function compute24hSummary("),
].join("\n");
const table = (name) => { const m = SRC.match(new RegExp("CREATE TABLE IF NOT EXISTS " + name + " \\(([\\s\\S]*?)\\)`")); if (!m) throw new Error("no table " + name); return "CREATE TABLE " + name + " (" + m[1] + ")"; };

const db = new Database(":memory:");
db.run(table("incidents"));
db.run(table("public_node_history"));
const logs = [];
const run = new Function("sharedDb", "log", "MONITOR_INTERVAL_MS", "FLEET_NODE_NAMES", "OWN_HEIGHT_SINCE", "process",
  code + "\nreturn compute24hSummary;")(db, (m) => logs.push(m), 20000, ["n1", "n2", "n3"], 0, { env: {} });

// A full day of stable rounds, every 20 s, with the median advancing.
const now = Date.now(), DAY = 86400000;
const ins = db.prepare("INSERT INTO public_node_history (ts, status, risk, confidence, data_quality, agreement_state, median_block, block_spread, nodes_total, nodes_reachable, node_states) VALUES (?, 'stable', 'low', 'clear', 'sufficient', 'strong', ?, 0, 3, 3, '[]')");
for (let k = 0; k < 4320; k++) ins.run(now - DAY + 10000 + k * 20000, 1000 + k);
const iso = (ms) => new Date(ms).toISOString();
const inc = db.prepare("INSERT INTO incidents (id, status, severity, started_at, resolved_at, affected_nodes, description) VALUES (?, ?, ?, ?, ?, ?, ?)");
const H = 3600000;
inc.run("INC-901", "active", "critical", iso(now - 2 * H), null, JSON.stringify(["n1", "n2"]), "2 node(s) unhealthy: n1, n2");
inc.run("INC-902", "active", "critical", iso(now - 2 * H), null, JSON.stringify(["CHAIN"]), "Fleet reference chain issue detected");
inc.run("INC-903", "active", "critical", iso(now - 1 * H), null, JSON.stringify(["PUBLIC_NETWORK_UNSTABLE"]), "Public network condition observed: Significant disagreement among public node heights");
inc.run("INC-904", "resolved", "critical", iso(now - 5 * H), iso(now - 4 * H), JSON.stringify(["PUBLIC_NETWORK_UNSTABLE"]), "Public network condition observed: Critical incidents active");
inc.run("INC-905", "active", "warning", iso(now - 1 * H), null, JSON.stringify(["PUBLIC_NETWORK_VISIBILITY"]), "Insufficient public visibility: fewer than 2 public nodes answered.");
inc.run("INC-906", "active", "critical", iso(now - 3 * H), null, JSON.stringify(["kyne-node2"]), "Public seed condition");
inc.run("INC-907", "resolved", "critical", iso(now - 6 * H), iso(now - 5 * H), JSON.stringify(["kyne-node3"]), "Public seed condition");
inc.run("INC-908", "resolved", "critical", iso(now - 3 * DAY), iso(now - 2 * DAY), JSON.stringify(["kyne-node3"]), "Public seed condition, resolved before the window");
inc.run("INC-909", "active", "warning", iso(now - 1 * H), null, JSON.stringify(["kyne-node3b"]), "Public seed condition, warning");

console.log("\n[" + TAG + "] the 24-hour critical counts follow the incident / condition split");
const s = run();
check("L1 the summary is computed over a full day", s && s.sufficient === true && s.coverage_pct >= 99, JSON.stringify(s && { sufficient: s.sufficient, coverage: s.coverage_pct }));
check("L2 active now: the one critical public incident; no fleet incident, no condition record", s.active_critical_public_incidents === 1, s.active_critical_public_incidents);
check("L3 in the window: that one and one resolved inside the window; none resolved before it", s.critical_public_incidents_in_window === 2, s.critical_public_incidents_in_window);
db.run("DELETE FROM incidents WHERE id IN ('INC-906', 'INC-907')");
const s2 = run();
check("L4 with only condition records and fleet incidents open, both counts are 0", s2.active_critical_public_incidents === 0 && s2.critical_public_incidents_in_window === 0, JSON.stringify([s2.active_critical_public_incidents, s2.critical_public_incidents_in_window]));
check("L5 no malformed-row warning for well-formed rows", !logs.some((m) => /malformed/.test(m)), logs.join(" | "));

console.log("\n[" + TAG + "] chain movement is published only when own-height rows cover the window");
{
  // The same store, read by an agent whose own-height rows begin inside the window (a deploy two hours ago, or a
  // rollback and a new deploy): every row counts toward coverage, but the heights before the rule changed are another
  // rule's. A figure from the last two hours next to "coverage 24/24h" would be read as the day's.
  const at = (ownSince) => new Function("sharedDb", "log", "MONITOR_INTERVAL_MS", "FLEET_NODE_NAMES", "OWN_HEIGHT_SINCE", "process",
    code + "\nreturn compute24hSummary;")(db, (m) => logs.push(m), 20000, ["n1", "n2", "n3"], ownSince, { env: {} })();
  const whole = at(0), twoHours = at(now - 2 * H), justInside = at(now - DAY + 60000), before = at(now - DAY - 60000);
  check("L6 every row under the rule: the figure for the day", whole.chain_movement.state === "normal" && whole.chain_movement.blocks_advanced > 4000, JSON.stringify(whole.chain_movement));
  check("L7 the rule's rows began two hours ago: coverage is still the day's, and chain movement is unknown with the reason, not two hours' blocks",
    twoHours.sufficient === true && twoHours.coverage_pct >= 99 && JSON.stringify(twoHours.chain_movement) === JSON.stringify({ state: "unknown", reason: "own_height_record_shorter_than_window", blocks_advanced: null }), JSON.stringify(twoHours.chain_movement));
  check("L8 the same one minute into the window", justInside.chain_movement.state === "unknown" && justInside.chain_movement.blocks_advanced === null);
  check("L9 once the rule's rows begin before the window, the figure is published again", before.chain_movement.state === "normal" && before.chain_movement.blocks_advanced === whole.chain_movement.blocks_advanced, JSON.stringify(before.chain_movement));
  check("L10 the other parts of the summary do not change", ["coverage_pct", "typical_set_size", "longest_non_stable_minutes", "active_critical_public_incidents"].every((k) => twoHours[k] === whole[k]));
}

console.log("\n[" + TAG + "] a dated note beside a stored record (the record itself is never edited)");
{
  const a = SRC.indexOf("var INCIDENT_NOTES = ["), b = SRC.indexOf("\n}\n", SRC.indexOf("function incidentNote(id, startedAt) {")) + 3;
  const note = new Function(SRC.slice(a, b) + "\nreturn { note: incidentNote, all: INCIDENT_NOTES };")();
  const n = note.note("INC-1349", "2026-10-01T20:07:58.199Z");
  check("N1 the visibility record of 1 October has a note, dated, and it says the cause was in DNO", n && n.added === "2026-10-03" && /^The cause was in DNO, not in the seeds\./.test(n.text) && /says nothing about the seeds or the network/.test(n.text), JSON.stringify(n));
  check("N2 the note is keyed by id and start time: a record another store numbered the same, or any other record, has none", note.note("INC-1349", "2026-10-01T20:07:58.198Z") === null && note.note("INC-1349", null) === null && note.note("INC-1350", "2026-10-01T20:07:58.199Z") === null && note.note(undefined, undefined) === null);
  const BANNED = /\b(approved|certified|trusted|recommended|safe|best|scores?|ranking|ranked|network truth|canonical truth|sanctions-clean|compliant|ready)\b/i;
  check("N3 no banned word, no host, no key in a note", note.all.every((x) => !BANNED.test(x.text) && !/\d+\.\d+\.\d+\.\d+|0x[0-9a-f]{8}|https?:/i.test(x.text) && /^\d{4}-\d\d-\d\d$/.test(x.added)));
  const route = SRC.slice(SRC.indexOf('reqPath === "/incidents" || reqPath.indexOf("/incidents/") === 0'), SRC.indexOf('reqPath === "/federate"'));
  check("N4 /incidents adds it as a field of its own beside the stored description, and only where there is one", route.includes("var incNote = incidentNote(r.id, r.started_at);\n          if (incNote) incRow.note = incNote;") && route.includes("description: r.description,"));
  check("N5 /timeline shows it under the record, escaped", SRC.includes("return note ? '<div class=\"tl-meta tl-note\">Note added ' + escapeHtmlTL(note.added) + ': ' + escapeHtmlTL(note.text) + '</div>' : '';"));
  check("N6 nothing writes a note into the store", !/UPDATE incidents SET description/.test(SRC));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
