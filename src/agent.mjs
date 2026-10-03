import { EXPECTED_FLEET, FIXNET_NODES, FLEET_RPC_FALLBACKS, FLEET_CROSS_VALIDATION_RPCS } from "./fleet.config.mjs";

// L1 completeness gate (fail-closed): registry must cover the full expected fleet.
// Throws before any server bind. Error text carries key names only, never values.
{
  const _ef = Object.keys(EXPECTED_FLEET);
  const _fx = Object.keys(FIXNET_NODES);
  for (const _k of _ef) {
    if (!FIXNET_NODES["fleet-" + _k]) throw new Error("FIXNET_NODES incomplete: missing fleet-" + _k);
  }
  if (_fx.length !== _ef.length) throw new Error("FIXNET_NODES count mismatch: " + _fx.length + " vs expected " + _ef.length);
  if (!Array.isArray(FLEET_RPC_FALLBACKS) || FLEET_RPC_FALLBACKS.length < 1) throw new Error("FLEET_RPC_FALLBACKS missing or empty");
  for (const _u of FLEET_RPC_FALLBACKS) { if (typeof _u !== "string" || !/^https?:\/\//.test(_u)) throw new Error("FLEET_RPC_FALLBACKS invalid url"); }
  if (new Set(FLEET_RPC_FALLBACKS).size !== FLEET_RPC_FALLBACKS.length) throw new Error("FLEET_RPC_FALLBACKS duplicate url");
  if (!Array.isArray(FLEET_CROSS_VALIDATION_RPCS) || FLEET_CROSS_VALIDATION_RPCS.length < 1) throw new Error("FLEET_CROSS_VALIDATION_RPCS missing or empty");
  { const _n=new Set(), _u=new Set();
    for (const _r of FLEET_CROSS_VALIDATION_RPCS) {
      if (!_r || typeof _r.name !== "string" || _r.name.length < 1) throw new Error("FLEET_CROSS_VALIDATION_RPCS entry missing name");
      if (typeof _r.url !== "string" || !/^https?:\/\//.test(_r.url)) throw new Error("FLEET_CROSS_VALIDATION_RPCS entry invalid url");
      if (_n.has(_r.name)) throw new Error("FLEET_CROSS_VALIDATION_RPCS duplicate name"); _n.add(_r.name);
      if (_u.has(_r.url)) throw new Error("FLEET_CROSS_VALIDATION_RPCS duplicate url"); _u.add(_r.url);
    } }
}
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync, statSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { createServer } from "http";
import { Database } from "bun:sqlite"; // FIX BUG 3: shared DB handle
try { readFileSync(".env","utf8").split("\n").forEach(function(line) { var m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim(); }); } catch(e) {}
import { Demos } from "@kynesyslabs/demosdk/websdk";

import { initConsensus, pollAndProcessConsensus, getConsensusState } from "./consensus.mjs";
import { PUBLIC_SIGNAL_TYPES, NON_PUBLIC_SIGNAL_TYPES, toPublicSignals } from "./signal-projection.mjs";
import { isValidIdentity, truncIdentity, sanitizeHeight, sanitizeLabel, escHtml, probeErrorCategory, adminTokenMatches, MIN_ADMIN_TOKEN_LENGTH, resolvePublicProbeOrigin, mapWithConcurrency, cappedJson } from "./public-safety.mjs";
import * as FLEET_CONFIG from "./fleet.config.mjs"; // optional keys (e.g. LOCAL_INFO_URL) are read from here without breaking older configs
import { runValidatorRound, createWatchHistory, createFirstAgreedStore, keyOf, publicOnChainValidators, publicValidatorWatch, roundLogLine, validatorsSentence, listedStatus, dialsEnabled } from "./validator-watch.mjs";
import { leadCount, cycleLead, cycleSeeds, cycleDoor } from "./home-cycle.mjs";
import { readSeedInfo, seedsSufficient } from "./seed-read.mjs";
import { RULE, assess, stepConditionRecords, clockReadings } from "./status-rule.mjs";
import { createCandidateStore, readWitnesses, witnessSnapshot } from "./witnesses.mjs";
import { sentinelStatePath } from "./sentinel-state.mjs";

// --- Logging setup ---
var DNO_ADMIN_TOKEN = process.env.DNO_ADMIN_TOKEN || "";
var LOG_DIR = process.env.LOG_DIR || "logs";
try { mkdirSync(LOG_DIR, { recursive: true }); } catch(e) {}
var LOG_FILE = join(LOG_DIR, "agent.log");
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 5000;

// FIX BUG 9: Log rotation constants
var MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
var MAX_LOG_BACKUPS = 3;

// ============================================================================
// Phase B: Last 24h Summary — constants
// ============================================================================

// Fleet identification for incident scope inference (no scope column in schema).
// All 9 fleet members listed: n9 + m3 onboarded 2026-05-05 (see drift register).
// Used to filter incidents into fleet vs public scope.
var FLEET_NODES_24H = new Set(['n1','n2','n3','n4','n5','n6','n7','m1','m3','n9']);

// Chain movement thresholds — env-overridable for live-chain migration tuning.
var CHAIN_BUCKET_MIN_24H = parseInt(process.env.PHASE_B_CHAIN_BUCKET_MIN || '5', 10);
var CHAIN_STATIC_RUN_MIN_24H = parseInt(process.env.PHASE_B_CHAIN_STATIC_RUN_MIN || '5', 10);
var CHAIN_ADVANCE_PCT_24H = parseFloat(process.env.PHASE_B_CHAIN_ADVANCE_PCT || '0.95');

// Coverage gate — hide all numerics below this fraction of expected cycles.
var COVERAGE_GATE_24H = 0.50;
// Public API version. 1.x is additive-only (organism.schema.json x-changelog); 1.1 adds observation-time and
// catalog fields and corrects field meanings documented there.
var API_VERSION = "1.2";

// Expected public observation rounds in 24 h, from the configured cadence (4320 at 20 s).
function expectedCycles24h() { return Math.max(1, Math.round(86400000 / MONITOR_INTERVAL_MS)); }

// Cache for /health and /organism so back-to-back requests share one DB pass.
var last24hCache = { value: null, computedAt: 0 };
var LAST_24H_TTL_MS = 10000;


function log(msg) {
  var ts = new Date().toISOString();
  var line = "[" + ts + "] " + msg;
  process.stdout.write(line + "\n");
  try { appendFileSync(LOG_FILE, line + "\n"); } catch(e) {}
}

function logError(msg) {
  var ts = new Date().toISOString();
  var line = "[" + ts + "] ERROR: " + msg;
  process.stderr.write(line + "\n");
  try { appendFileSync(LOG_FILE, line + "\n"); } catch(e) {}
}

// FIX BUG 9: Log rotation
function rotateLogIfNeeded() {
  try {
    var stats = statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      log("Log file exceeds " + (MAX_LOG_SIZE / 1024 / 1024) + "MB — rotating...");
      for (var i = MAX_LOG_BACKUPS - 1; i >= 0; i--) {
        var from = i === 0 ? LOG_FILE : LOG_FILE + "." + i;
        var to = LOG_FILE + "." + (i + 1);
        try { renameSync(from, to); } catch(e) {}
      }
      // LOG_FILE has been renamed to LOG_FILE.1 — next appendFileSync creates fresh file
    }
  } catch(e) {} // file doesn't exist yet, nothing to rotate
}

async function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

const MNEMONIC = process.env.DEMOS_MNEMONIC;
const RPC_URL = process.env.DEMOS_RPC_URL || "https://demosnode.discus.sh/";
const FALLBACK_RPCS = Object.freeze([RPC_URL, ...FLEET_RPC_FALLBACKS]);
const INTERVAL_MS = parseInt(process.env.PUBLISH_INTERVAL_MS || "1200000");
const AGENT_VERSION = "6.9";  // single source of truth for the Oracle build/release version (NOT api_version, NOT node version)
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || "20000"); // 1 min monitoring, independent of publish interval
const STALE_MULTIPLIER = 3; // public-RPC freshness multiplier
const STALE_BOUND = STALE_MULTIPLIER * MONITOR_INTERVAL_MS; // derived from cycle cadence; passed explicitly to buildPublicMetrics
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://127.0.0.1:9091";
// Local node /info. Set LOCAL_INFO_URL in .env or export it from fleet.config.mjs; the loopback default
// assumes the node listens on this host. No address literal lives in public source.
const LOCAL_INFO_URL = process.env.LOCAL_INFO_URL || FLEET_CONFIG.LOCAL_INFO_URL || "http://127.0.0.1:53550/info";
const LOCAL_NODE_NAME = process.env.LOCAL_NODE_NAME || "n3";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Cross-validation RPC endpoints (fleet-sourced from private config)
function publicValidationRpcName(index) { return "validation-" + (index + 1); }
const CROSS_VALIDATION_RPCS = Object.freeze([...FLEET_CROSS_VALIDATION_RPCS]);
const EXPLORER_STATUS_URL = "https://scan.demos.network/status";
const PUBLIC_PROBE_TIMEOUT_MS = 10000;

// Daily summary: every 72 cycles = 24h at 20min intervals
const DAILY_SUMMARY_CYCLES = 4320;

// HTTP health endpoint
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8080");
// Optional loopback-only listener for fleet routes, fleet incident scopes and sentinel detail (see /history).
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT || "0", 10) || 0;

// Agent profile
let AGENT_WALLET = null; // set after wallet connect; /docs says "not connected" until then
function parseInstanceRole(rawRole) {
  if (rawRole == null || rawRole === "") {
    return { raw: rawRole == null ? null : rawRole, normalized: null, effective: "primary", can_publish: true, warning: "INSTANCE_ROLE absent; defaulting to primary for backward compatibility." };
  }
  var normalized = String(rawRole).trim().toLowerCase();
  if (normalized === "primary")   return { raw: rawRole, normalized: normalized, effective: "primary",   can_publish: true,  warning: null };
  if (normalized === "validator") return { raw: rawRole, normalized: normalized, effective: "validator", can_publish: true,  warning: null };
  return { raw: rawRole, normalized: normalized, effective: "config_error", can_publish: false, warning: "Invalid INSTANCE_ROLE. Expected 'primary' or 'validator'. Publishing disabled." };
}
const INSTANCE_ROLE_CONFIG = parseInstanceRole(process.env.INSTANCE_ROLE);
const INSTANCE_ROLE = INSTANCE_ROLE_CONFIG.effective;
const INSTANCE_ROLE_CAN_PUBLISH = INSTANCE_ROLE_CONFIG.can_publish;
const PRIMARY_ORACLE_URL = process.env.PRIMARY_ORACLE_URL || "";
let primaryLastSeen = 0; // timestamp of last successful primary health fetch
let primarySilentCycles = 0;

async function checkPrimaryOracle() {
  if (!PRIMARY_ORACLE_URL) return { silent: false };
  try {
    var r = await fetch(PRIMARY_ORACLE_URL + "/health", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    await r.json(); // parse to confirm a well-formed JSON body; failover keys on reachability only
    primaryLastSeen = Date.now();
    primarySilentCycles = 0;
    return { silent: false };
  } catch(e) {
    primarySilentCycles++;
    log("  [validator] Primary oracle unreachable (" + primarySilentCycles + " cycles): " + e.message);
    return { silent: primarySilentCycles >= 1 };
  }
}
const AGENT_NAME = "Demos Network Oracle";
const AGENT_DESCRIPTION = "Public network observability for the Demos ecosystem. Monitors public validators and tracks network agreement. On-chain publication of Oracle observations is currently disabled. Public API at demos-oracle.com/health";
const SUPERCOLONY_API = process.env.COLONY_URL || "https://supercolony.ai";
const SUPERCOLONY_ENABLED = process.env.SUPERCOLONY_ENABLED === "1";

// Historical data file (JSON-based, lightweight)
const HISTORY_FILE = join(LOG_DIR, "history.json");
const MAX_HISTORY_CYCLES = 432; // 6 days at 20min intervals
const PUBLIC_NODE_HISTORY_RETENTION_DAYS = Number(process.env.PUBLIC_NODE_HISTORY_RETENTION_DAYS || 365);
const OBSERVATION_HISTORY_RETENTION_DAYS = Number(process.env.OBSERVATION_HISTORY_RETENTION_DAYS || 30);
// Public incident generation (2026-06-11). Two classes, strictly generated:
// observability (DNO cannot sufficiently see the network) vs network-condition.
const PUBLIC_INCIDENT_OPEN_CYCLES = parseInt(process.env.PUBLIC_INCIDENT_OPEN_CYCLES || "3", 10);
const PUBLIC_INCIDENT_RESOLVE_CYCLES = parseInt(process.env.PUBLIC_INCIDENT_RESOLVE_CYCLES || "9", 10);
const PUBLIC_VISIBILITY_MARKER = "PUBLIC_NETWORK_VISIBILITY";
const PUBLIC_DEGRADED_MARKER = "PUBLIC_NETWORK_DEGRADED";
const PUBLIC_UNSTABLE_MARKER = "PUBLIC_NETWORK_UNSTABLE";
const MARKER_NODES = [PUBLIC_VISIBILITY_MARKER, PUBLIC_DEGRADED_MARKER, PUBLIC_UNSTABLE_MARKER];
function isPublicConditionMarker(inc) {
  return Array.isArray(inc.affectedNodes) && inc.affectedNodes.length === 1 && MARKER_NODES.includes(inc.affectedNodes[0]);
}
// Network Observation Timeline release events. Structured data, versioned in git.
// Append one entry per published release; never edit history.
var TIMELINE_RELEASE_EVENTS = [
  { date: "2026-06-10", type: "contract", text: "Public API contract v1.0 published at /organism/schema: 17 required top-level fields, additive-only within api_version 1.x." },
  { date: "2026-06-11", type: "methodology", text: "Methodology v1.0 published: versioned, with changelog. The schema binds; the methodology explains." },
  { date: "2026-10-02", type: "contract", text: "API 1.1 and methodology v1.1 served from this day: a seed counts only with its own block height; data_quality_reason, observed_at, height movement, condition records and agreement_detail are published; the catalog counts an identity once two public peerlists list it." }
];
// A release dated by this server's store: the day the API version that carries it first started here (dno_meta,
// written once by loadApiFirstStart). A release has no entry until that version has run on this store.
var TIMELINE_STORE_DATED_RELEASES = [
  { api: "1.2", type: "contract", text: "API 1.2 and methodology v1.2 served from this day: when fewer than two public seeds give their own height, validators that answer as listed stand in for the missing seed, and /organism says so in witnesses; status reads degraded after 30 minutes without a new height; a seed catching up is no longer counted as a new height." }
];
var apiFirstStarts = {};   // api version -> ms, as kept in the store
// Dated notes on stored records. A record is never edited: where it is shown, the note is added beside it. A note is
// keyed by the record's id and its start time, so it attaches to that one record of this store and to no other record
// that another store numbered the same.
var INCIDENT_NOTES = [
  { id: "INC-1349", startedAt: "2026-10-01T20:07:58.199Z", added: "2026-10-03",
    text: "The cause was in DNO, not in the seeds. After a restart of DNO at about 20:07 UTC its own reads of the public seeds failed inside DNO until it was rolled back; the same reads made outside the agent were answered. This record says nothing about the seeds or the network. The fault was fixed in the release served from 2026-10-02." }
];
function incidentNote(id, startedAt) {
  for (var i = 0; i < INCIDENT_NOTES.length; i++) if (INCIDENT_NOTES[i].id === id && INCIDENT_NOTES[i].startedAt === startedAt) return { added: INCIDENT_NOTES[i].added, text: INCIDENT_NOTES[i].text };
  return null;
}
function loadApiFirstStart(db, nowMs) {
  db.run("CREATE TABLE IF NOT EXISTS dno_meta (key TEXT PRIMARY KEY, value TEXT)");
  var out = {};
  db.query("SELECT key, value FROM dno_meta WHERE key LIKE 'api_first_start:%'").all().forEach(function(r) {
    var t = Number(r.value);
    if (Number.isFinite(t) && t > 0) out[r.key.slice("api_first_start:".length)] = t;
  });
  if (!out[API_VERSION]) {
    db.run("INSERT OR REPLACE INTO dno_meta (key, value) VALUES (?, ?)", ["api_first_start:" + API_VERSION, String(nowMs)]);
    out[API_VERSION] = nowMs;
  }
  return out;
}
var publicIncidentCounters = { obsBad: 0, obsGood: 0, degBad: 0, degGood: 0, unsBad: 0, unsGood: 0 };
var publicBackfillChecked = false;
const CONSENSUS_ENABLED = process.env.CONSENSUS_ENABLED === "1";     // Path 2 (2026-06-10): disabled by default - zero reports ever received
var ORGANISM_SCHEMA = '{"error":"schema file not loaded"}'; // Phase 1 contract
try { ORGANISM_SCHEMA = readFileSync("organism.schema.json", "utf8"); } catch (e) { console.error("[schema] organism.schema.json not loaded: " + e.message); }

// The API index page. Site-kit markers are filled per request (the kit is defined further down).
function docsEntry(path, text) { return '<div><dt><code>' + path + '</code></dt><dd>' + text + '</dd></div>'; }
var DOCS_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>API · Demos Network Oracle</title><!--dno:head-->' +
'<style>.docs-kv dt code{white-space:nowrap}.docs-kv{grid-template-columns:minmax(0,19rem) minmax(0,1fr)}@media(max-width:719px){.docs-kv{grid-template-columns:minmax(0,1fr)}}</style></head><body>' +
'<!--dno:header:docs--><main id="main"><header class="doc-head"><div class="wrap"><div><h1>API</h1>' +
'<p class="doc-lede">Every public endpoint, read-only, JSON unless noted, served with CORS for any origin. DNO reads three public Demos seeds and publishes whether their reported heights agree. When fewer than two give their own height, validators that answer as listed stand in for the missing one.</p>' +
'<div class="doc-intro"><p>Oracle wallet: <code>__AGENT_WALLET__</code> · v' + AGENT_VERSION + ' · API ' + API_VERSION + '. ' + (SUPERCOLONY_ENABLED ? 'On-chain publication of DNO\'s own posts is enabled' : 'On-chain publication of DNO\'s own posts is currently disabled') + '; the public reading is never posted. Observation continues independently, and that says nothing by itself about the Demos network.</p></div>' +
'</div></div></header><div class="wrap doc-grid"><details class="toc" open><summary>On this page</summary><ol>' +
'<li><a href="#reading">The reading</a></li><li><a href="#identities">Peer-listed identities</a></li><li><a href="#pages">Pages</a></li><li><a href="#integration">Integration</a></li><li><a href="#internal">Internal only</a></li></ol></details>' +
'<article class="prose">' +
'<section id="reading"><h2>The reading</h2><dl class="kv docs-kv">' +
docsEntry('GET /organism', 'Default context. The compact public reading: 17 required fields plus the additive 1.1 fields (observed_at, data_quality_reason, height_last_advanced_at, height_static_seconds, active_public_conditions, agreement_detail, last_24h.critical_public_incidents_in_window, last_24h.chain_movement.blocks_advanced) and the additive 1.2 fields (witnesses: what the reading rests on, as counts; height_standstill_after_seconds: after this long without a new height a reading that would be stable is degraded). No fleet data. ETag / 304 between observations.') +
docsEntry('GET /organism/schema', 'The JSON Schema contract: stability policy, enums, changelog.') +
docsEntry('GET /health', 'The same reading with its parts: publicNodes (each seed, with height_source), witnesses, signals, validator_growth (seed counts and peer-listed identities; online and synced are listed in mixed_fields; first_counted has the identities first counted in the last 24 h, 7 days and 30 days, null for a window the count does not cover or that a gap in the count crosses), attestation (DAHR attempted on the cross-check RPCs, not on the seeds whose answers enter status: available, last_count, last_ok_at), on_chain_publication (currently "disabled"), on_chain_validators (the on-chain validators table as the public seeds list it: counts by status and minValidatorStake, each only when at least two seeds return the same answer, and how many ACTIVE keys DNO first counted in the last 24 h, 7 days and 30 days) and validator_watch (what DNO saw when it dialed the address each ACTIVE validator published on chain: counts only, never an address). While two seeds give their own height neither of the last two enters status; when fewer do, validators that answered as listed stand in, and witnesses says so. Neither object is in /organism.') +
docsEntry('GET /incidents', 'Public records. ?status=active|resolved, ?limit=1–500. Condition records carry kind=condition and are counted in active_public_conditions; /organism active_incidents does not count them. A record may carry note, a dated note DNO added later; the stored record is never edited.') +
'</dl></section>' +
'<section id="identities"><h2>Peer-listed identities</h2><dl class="kv docs-kv">' +
docsEntry('GET /catalog', 'Identities listed on the public seeds\' peerlists, kept after two public peerlists have listed them (one peerlist brings at most 50 new identities into that count per crawl): first recorded (first_seen), last listed, and what the peerlists reported in the latest crawl. ?q= filters by the end of a display name or a truncated key; ?listed=now|not by whether the latest crawl listed the row. ETag / 304 between observations. Never dialed.') +
docsEntry('GET /catalog/lookup?key=0x…', 'Exact check of one full key against the catalog and the configured seeds. Returns the sanitized row only, never a key. on_chain says where that key stands on the agreed validators list (ACTIVE, UNSTAKING, other or not_listed), only while two seeds return the same list, read in the last 300 s.') +
docsEntry('GET /peers', 'The latest crawl only: truncated identities with the peer-reported height, online flag, sync status and how many public peerlists listed them. Connections are never exposed.') +
'</dl></section>' +
'<section id="pages"><h2>Pages</h2><dl class="kv docs-kv">' +
docsEntry('GET /methodology', 'How each value is derived, and where the observation stops.') +
docsEntry('GET /about-demos', 'Validators, shards, node health and DAHR, as the Demos docs describe them, and what DNO sees of each.') +
docsEntry('GET /sources', 'What DNO reads, and which of it enters status.') +
docsEntry('GET /agent', 'How software agents consume the API: fields, polling, examples.') +
docsEntry('GET /reference', 'The fixnet probe and the peer-listed identities, in two tables.') +
docsEntry('GET /timeline', 'Public incidents, condition records and release events.') +
'</dl></section>' +
'<section id="integration"><h2>Integration</h2><dl class="kv docs-kv">' +
docsEntry('GET /federate', 'Prometheus text: the oracle version, plus cross-check RPC reachability and probe latency observed from this vantage, under neutral names.') +
docsEntry('GET /badge', 'An SVG of the current status word.') +
docsEntry('GET /version', 'Running agent version and the version most seeds report.') +
docsEntry('GET /sentinel', 'Anomaly detector: alert count for the last 24 h, or unknown when unavailable.') +
'</dl><p>Public observation interval: ' + Math.round(MONITOR_INTERVAL_MS / 1000) + ' s.</p></section>' +
'<section id="internal"><h2>Internal only</h2><p>Fleet views, <code>/dashboard</code>, <code>/history</code> and <code>/history/export</code>, are served on DNO\'s internal listener only (INTERNAL_PORT). The public site answers 404 for them.</p></section>' +
'</article></div></main><!--dno:footer--></body></html>';

// FIX BUG 6: Write budget constants (SuperColony rate limits)
const DAILY_PUBLISH_LIMIT = 15;
const HOURLY_PUBLISH_LIMIT = 5;
let publishTimestamps = []; // rolling window of publish times

var HOMEPAGE_HTML = "";
try { HOMEPAGE_HTML = readFileSync("homepage.html", "utf8"); } catch(e) { HOMEPAGE_HTML = "<html><body><h1>Homepage not found</h1></body></html>"; }
// Server-side fill for readers without JavaScript (and for agents that fetch / as HTML). Each replacement targets
// one exact marker in homepage.html; src/public-api-v11.test.mjs asserts every marker is present exactly once.
var HOME_TONE = {
  status: { stable: "ok", degraded: "warn", unstable: "bad", unknown: "unknown" },
  trend: { improving: "ok", stable: "neutral", worsening: "warn", unknown: "unknown" },
  risk: { low: "ok", elevated: "warn", high: "bad" },
  confidence: { clear: "ok", uncertain: "warn" },
  data_quality: { sufficient: "ok", insufficient: "warn" },
  agreement: { strong: "ok", moderate: "warn", weak: "bad", unknown: "unknown" }
};
var HOME_DQ_REASON = {
  no_observation: "no public observation has completed yet",
  stale: "the last observation is older than 300 s",
  too_few_answers: "fewer than 2 seeds answered",
  too_few_heights: "fewer than 2 seeds reported their own height"
};
var HOME_CARD_LABEL = { trend: "trend", risk: "risk", confidence: "confidence", data_quality: "data quality" };
function homeTone(key, value) { return (HOME_TONE[key] && HOME_TONE[key][value]) || (value ? "neutral" : "unknown"); }
function homeCardMarker(key) {
  return '<div data-card="' + key + '"><p class="k">' + HOME_CARD_LABEL[key] + '</p><p class="v"><span class="ind" data-tone="pending"></span><span class="val">reading</span></p><p class="s" data-src="api"></p>';
}
var HOME_MARKERS = {
  panel: '<div class="panel" id="panel" data-state="pending">',
  status: '<span class="ind" id="status-ind" data-tone="pending"></span><span id="status-value">READING</span>',
  lead: '<p class="cycle-lead" id="cycle-lead" data-src="api">ACTIVE on chain: reading.</p>',
  seeds: '<p class="seeds" id="seeds-line" aria-live="polite">The first request to /organism is in flight.</p>',
  door: '<span id="door-n"></span>',
  insufficient: '<p class="insufficient" id="insufficient" hidden>',
  agreement: '<span class="ind" id="ag-ind" data-tone="pending"></span><span id="ag-state">reading</span>',
  live: '<span id="live-text">connecting</span>',
  validators: '<p class="note" id="vw-line">Validator counts are published on <a href="/health">/health</a> as on_chain_validators and validator_watch.</p>',
  cards: { trend: homeCardMarker("trend"), risk: homeCardMarker("risk"), confidence: homeCardMarker("confidence"), data_quality: homeCardMarker("data_quality") }
};
function renderHomepageNoJs(html) {
  try {
    var c = computeCanonicalState();
    if (!c.observed_at) return html;            // nothing observed yet: the page's own pending state is accurate
    var e = escHtml;
    html = html.replace(HOME_MARKERS.panel, '<div class="panel" id="panel" data-state="live">');
    html = html.replace(HOME_MARKERS.status, '<span class="ind" id="status-ind" data-tone="' + homeTone("status", c.status) + '"></span><span id="status-value">' + e(String(c.status || "unknown").toUpperCase()) + '</span>');
    // The card's three lines (src/home-cycle.mjs, the same file the page's script carries): the ACTIVE count as the
    // agreeing seeds list it, what status is made of in this observation (the seeds, or a seed and the validators
    // standing in), and the peer-listed count. The API's
    // status_reason is not on the card; it stays in /organism.
    var ocV = publicOnChainValidators(latestValidatorRound, Date.now(), validatorPublishConfig());
    html = html.replace(HOME_MARKERS.lead, '<p class="cycle-lead" id="cycle-lead" data-src="api">' + e(cycleLead(ocV)) + '</p>');
    var seedLine = cycleSeeds({ publicNodes: latestPublicNodes || [], agreement: c.agreement, data_quality_reason: c.data_quality_reason,
      staleness_seconds: c.staleness_seconds, height_static_seconds: c.height_static_seconds, active_incidents: c.active_incidents,
      witnesses: c.witnesses, height_standstill_after_seconds: c.height_standstill_after_seconds }, leadCount(ocV));
    html = html.replace(HOME_MARKERS.seeds, '<p class="seeds" id="seeds-line" aria-live="polite">' + e(seedLine) + '</p>');
    var door = null;
    try { door = cycleDoor(getValidatorGrowth().discovered); } catch (ignore) {}
    if (door) html = html.replace(HOME_MARKERS.door, '<span id="door-n">' + e(door) + ' · </span>');
    if (c.data_quality === "insufficient") html = html.replace(HOME_MARKERS.insufficient, '<p class="insufficient" id="insufficient">');
    var subs = {
      trend: "",
      risk: (c.risk_factors || []).join(" · "),
      confidence: c.confidence_reason || "",
      data_quality: c.data_quality_reason ? (HOME_DQ_REASON[c.data_quality_reason] || "") : ""
    };
    for (var key in HOME_MARKERS.cards) {
      var val = c[key] || "unknown";
      html = html.replace(HOME_MARKERS.cards[key], '<div data-card="' + key + '"><p class="k">' + HOME_CARD_LABEL[key] + '</p><p class="v"><span class="ind" data-tone="' + homeTone(key, c[key]) + '"></span><span class="val">' + e(val) + '</span></p><p class="s" data-src="api"' + (subs[key] ? '' : ' hidden') + '>' + e(subs[key]) + '</p>');
    }
    var ag = (c.agreement && c.agreement.state) || "unknown";
    html = html.replace(HOME_MARKERS.agreement, '<span class="ind" id="ag-ind" data-tone="' + homeTone("agreement", ag) + '"></span><span id="ag-state">' + e(ag) + '</span>');
    html = html.replace(HOME_MARKERS.live, '<span id="live-text">as of ' + e(c.observed_at.slice(11, 19)) + ' UTC</span>');
    var vline = validatorsNoJsLine();
    if (vline) html = html.replace(HOME_MARKERS.validators, '<p class="note" id="vw-line">' + e(vline) + '</p>');
    return html;
  } catch (err) {
    return html;
  }
}
// The locked DNO mark (assets/dno-mark.jpg, the owner's file byte-for-byte). The homepage references it at this
// path; it is served only when the file on disk is the locked file.
const MARK_ASSET_SHA256 = "f72aa72bf49ba8eecdc4d8b49218e09343c7107f5ae144e3e11ad0d92cae5c51";
const MARK_ASSET_PATH = "/assets/dno-mark-" + MARK_ASSET_SHA256.slice(0, 8) + ".jpg";
var MARK_ASSET = null;
try {
  var markBytes = readFileSync("assets/dno-mark.jpg");
  if (createHash("sha256").update(markBytes).digest("hex") === MARK_ASSET_SHA256) MARK_ASSET = markBytes;
  else console.error("[homepage] assets/dno-mark.jpg is not the locked mark; it will not be served");
} catch (e) { MARK_ASSET = null; }

// --- Site kit: one stylesheet, one script, one header and one footer for every public page ---------------------
// Static pages carry three markers that are filled once at load: <!--dno:head-->, <!--dno:header:NAME--> and
// <!--dno:footer-->. Server-rendered pages call the same functions. The header places the locked raster
// (MARK_ASSET_PATH) and nothing else: no page draws a mark of its own. Kit files are served under a content hash.
function loadKitAsset(file, base, ext, type) {
  try {
    var bytes = readFileSync(file);
    return { path: "/assets/" + base + "-" + createHash("sha256").update(bytes).digest("hex").slice(0, 8) + ext, bytes: bytes, type: type };
  } catch (e) { return null; }
}
var SITE_CSS = loadKitAsset("assets/site.css", "site", ".css", "text/css; charset=utf-8");
var SITE_JS = loadKitAsset("assets/site.js", "site", ".js", "text/javascript; charset=utf-8");
var SITE_FAVICON = loadKitAsset("assets/dno-favicon.png", "dno-favicon", ".png", "image/png");
var KIT_ASSETS = {};
[SITE_CSS, SITE_JS, SITE_FAVICON].forEach(function(a) { if (a) KIT_ASSETS[a.path] = a; });
// The same links, in the same order, as the homepage header (src/public-api-v11.test.mjs compares them).
var SITE_NAV = [
  ["/methodology", "methodology", "Methodology"],
  ["/about-demos", "about-demos", "About Demos"],
  ["/sources", "sources", "Sources"],
  ["/agent", "agent", "Agent"],
  ["/reference", "reference", "Reference"],
  ["/timeline", "timeline", "Timeline"],
  ["/commerce", "commerce", "Commerce"]
];
function siteNavLinks(active) {
  return SITE_NAV.map(function(n) { return '<a href="' + n[0] + '"' + (n[1] === active ? ' aria-current="page"' : '') + '>' + n[2] + '</a>'; });
}
function siteHead() {
  return '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="color-scheme" content="dark"><meta name="theme-color" content="#000000">'
    + (SITE_FAVICON ? '<link rel="icon" type="image/png" sizes="64x64" href="' + SITE_FAVICON.path + '">' : '')
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">'
    + (SITE_CSS ? '<link rel="stylesheet" href="' + SITE_CSS.path + '">' : '');
}
function siteHeader(active) {
  var links = siteNavLinks(active);
  return '<a class="skip" href="#main">Skip to content</a>'
    + '<header class="site-head"><div class="wrap">'
    + '<a class="brand" href="/" aria-label="Demos Network Oracle, home">'
    + (MARK_ASSET ? '<img class="mark mark--nav" src="' + MARK_ASSET_PATH + '" width="92" height="92" alt="" decoding="async">' : '')
    + '<span class="brand-name"><span class="full">Demos Network Oracle</span><span class="short">DNO</span></span></a>'
    + '<nav class="nav" aria-label="Primary">' + links.join("") + '</nav>'
    + '<a class="live" id="live" href="/#this-cycle" data-state="pending" title="Age of the last completed public observation"><span class="dot"></span><span id="live-text">connecting</span></a>'
    + '<details class="menu"><summary>Menu</summary><ul><li><a href="/">Live reading</a></li>' + links.map(function(l) { return '<li>' + l + '</li>'; }).join("") + '</ul></details>'
    + '</div></header>';
}
function siteFooter(active) {
  return '<footer class="site-foot"><div class="wrap">'
    + '<nav class="foot-nav" aria-label="Site"><a href="/">Live reading</a>' + siteNavLinks(active).join("") + '<a href="/docs"' + (active === "docs" ? ' aria-current="page"' : '') + '>API</a></nav>'
    + '<p class="foot-line"><span>Demos Network Oracle</span><a href="https://github.com/xm33/demos-network-oracle">GitHub</a><a href="https://demos.sh">demos.sh</a></p>'
    + '<p class="fine">DNO informs context; it does not advise, predict, score, certify, or decide action.</p>'
    + '<p class="fine">Built by XM33 · not an official Demos product.</p>'
    + '<p class="fine">DNO does not validate. XM33 runs a validator on the public Demos testnet; DNO reads it like any other, and only if it publishes an address on chain.</p>'
    + '</div></footer>'
    + (SITE_JS ? '<script src="' + SITE_JS.path + '" defer></script>' : '');
}
function applySiteKit(html) {
  var name = (String(html).match(/<!--dno:header:([a-z-]+)-->/) || [])[1] || "";
  return String(html).replace("<!--dno:head-->", siteHead()).replace(/<!--dno:header:[a-z-]+-->/, siteHeader(name)).replace("<!--dno:footer-->", siteFooter(name));
}
var SOURCES_HTML = "";
try { SOURCES_HTML = applySiteKit(readFileSync("sources.html", "utf8")); } catch(e) { SOURCES_HTML = "<html><body><h1>Sources page not found</h1></body></html>"; }

var AGENT_GUIDE_HTML = "";
try { AGENT_GUIDE_HTML = applySiteKit(readFileSync("agent-guide.html", "utf8")); } catch(e) { AGENT_GUIDE_HTML = "<html><body><h1>Agent guide not found</h1></body></html>"; }
var METHODOLOGY_HTML = "";
try { METHODOLOGY_HTML = applySiteKit(readFileSync("methodology.html", "utf8")); } catch(e) { METHODOLOGY_HTML = "<html><body><h1>Methodology page not found</h1></body></html>"; }

var CRITERIA_HTML = "";
try { CRITERIA_HTML = applySiteKit(readFileSync("criteria.html", "utf8")); } catch(e) { CRITERIA_HTML = "<html><body><h1>Criteria page not found</h1></body></html>"; }

var CRITERIA_JSON = "";
try { CRITERIA_JSON = readFileSync("criteria.json", "utf8"); } catch(e) { CRITERIA_JSON = "{\"error\":\"criteria.json not found\"}"; }

var ABOUT_DEMOS_HTML = "";
try { ABOUT_DEMOS_HTML = applySiteKit(readFileSync("about-demos.html", "utf8")); } catch(e) { ABOUT_DEMOS_HTML = "<html><body><h1>About Demos page not found</h1></body></html>"; }

var COMMERCE_HTML = "";
try { COMMERCE_HTML = applySiteKit(readFileSync("commerce.html", "utf8")); } catch(e) { COMMERCE_HTML = "<html><body><h1>Commerce page not found</h1></body></html>"; }

var COMMERCE_METHODOLOGY_HTML = "";
try { COMMERCE_METHODOLOGY_HTML = applySiteKit(readFileSync("commerce-methodology.html", "utf8")); } catch(e) { COMMERCE_METHODOLOGY_HTML = "<html><body><h1>Commerce methodology not found</h1></body></html>"; }

// The old canonical header (a 3-dot SVG copied from commerce.html) is gone: every page uses siteHeader().

// ─── Commerce Sanitization (Layer 2 → public projection) ────
function buildPublicCommerceObservation() {
  try {
    var raw = JSON.parse(readFileSync("data/commerce-last-check.json", "utf8"));
    var auths = (raw.authorities || []).filter(function(a) { return a.configured; }).map(function(a) {
      return {
        authority_id: a.authority_id,
        name: a.name,
        category: (a.path_type || "").toLowerCase(),
        reachability: a.reachability,
        freshness: a.freshness,
        observed_at: a.observed_at
      };
    });
    return {
      layer: "commerce_intelligence",
      network_context: "testnet",
      observation_scope: "public infrastructure reachability",
      generated_at: raw.generated_at,
      commerce_observability_state: raw.overall ? raw.overall.commerce_observability_state : "unknown",
      data_quality: raw.overall ? raw.overall.data_quality : "insufficient",
      confidence: raw.overall ? raw.overall.confidence : "uncertain",
      authorities_observed: raw.overall ? raw.overall.active_probes : 0,
      authorities_healthy: raw.overall ? raw.overall.active_probes_healthy : 0,
      authorities: auths,
      limits: {
        observation_only: true,
        not_certification: true,
        not_legal_advice: true,
        not_transaction_recommendation: true,
        does_not_influence_layer_1: true
      },
      disclaimer: "The Demos Network Oracle observes whether attestation authority endpoints are reachable. This is infrastructure observability, not certification. The Oracle does not verify commerce claims, certify legal compliance, or recommend transactions."
    };
  } catch(e) {
    return {
      layer: "commerce_intelligence",
      network_context: "testnet",
      commerce_observability_state: "unknown",
      data_quality: "insufficient",
      confidence: "uncertain",
      authorities_observed: 0,
      authorities_healthy: 0,
      authorities: [],
      error: "Commerce observation data unavailable",
      disclaimer: "The Demos Network Oracle observes whether attestation authority endpoints are reachable. This is infrastructure observability, not certification."
    };
  }
}

if (!MNEMONIC) {
  // Public observation does not need a wallet. Without one the agent runs as a public observer only.
  logError("DEMOS_MNEMONIC is not set: public observation and the HTTP API run; wallet, fleet cycle and publishing are off.");
}

if (!EXPECTED_FLEET || Object.keys(EXPECTED_FLEET).length === 0) {
  console.error("FATAL: fleet.config.mjs missing or empty — refusing to start to avoid empty-fleet mis-assessment.");
  process.exit(1);
}

const NODE_NAMES = Object.keys(EXPECTED_FLEET);
const FLEET_SIZE = NODE_NAMES.length;

// D43: validate LOCAL_NODE_NAME early. Fail loud if misconfigured.
if (!EXPECTED_FLEET[LOCAL_NODE_NAME]) {
  console.error("[FATAL] Invalid LOCAL_NODE_NAME=" + LOCAL_NODE_NAME + ". Must be one of: " + Object.keys(EXPECTED_FLEET).join(", "));
  process.exit(1);
}

// Node registry — separated by source type and trust tier
// source_type: "public" | "discovered"
// trust_tier: "verified" | "auto_discovered"

const PUBLIC_NODES = {
  // Kynesys public nodes — verified, known operators
  "kyne-node2": {
    url: "http://node2.demos.sh:53550",
    identity: "0xc8bc5866fecf583bc1232f04fa54fd2c5a6f7c15b91c517ac60f468cdc0b8c82",
    source_type: "public",
    trust_tier: "verified",
    operator: "Kynesys",
    joined_at: "2026-04-14"
  },
  "kyne-node3": {
    url: "http://node3.demos.sh:53550",
    identity: "0x24c664d9ef529f798e979357c6a7a01088226eefe05cfdb77fb42841f771e156",
    source_type: "public",
    trust_tier: "verified",
    operator: "Kynesys",
    joined_at: "2026-04-14"
  },
  "kyne-node3b": {
    url: "http://node3.demos.sh:53540",
    identity: "0xcaeab45f01d6482c80b024e0332cbd8b483b47dde6533c330f244002b035ac59",
    source_type: "public",
    trust_tier: "verified",
    operator: "Kynesys",
    joined_at: "2026-04-14"
  },
};
var PUBLIC_NODE_IDENTITIES = {};
for (var _pn in PUBLIC_NODES) { PUBLIC_NODE_IDENTITIES[String(PUBLIC_NODES[_pn].identity).toLowerCase()] = _pn; }





// Discovered-set exclusion predicate — the ONLY definition of "not a discovered row".
// Ruling 2026-09-08: excludes monitored PUBLIC nodes only. Fleet identities are discovered
// rows like any other crawl-observed peer (rendered per R-A as discovered-<last4>).
// Identities are hex; they are compared lower-cased everywhere, so a case variant is not a second identity.
function isExcludedFromDiscovered(identity) { return !!PUBLIC_NODE_IDENTITIES[String(identity).toLowerCase()]; }
// A seed's own height: from its own peerlist entry only. A seed that does not list itself has no height here; the
// first listed peer's height stays on its publicNodes row (height_source "first_peer") and is counted nowhere else.
function ownHeight(n) { return n && n.ok && n.height_source === "self" ? sanitizeHeight(n.block) : null; }
var FIXNET_IDENTITIES = {};
for (var _fx in FIXNET_NODES) { if (FIXNET_NODES[_fx] && FIXNET_NODES[_fx].identity) FIXNET_IDENTITIES[String(FIXNET_NODES[_fx].identity).toLowerCase()] = _fx; }

let latestFixnetNodes = []; // updated each cycle
let latestDiscoveredFixnet = []; // fixnet peers discovered via anchor peerlist crawl
let fixnetObservedAt = null; // ms timestamp of last fixnet poll completion
let fixnetCycleCounter = 0; // increments each cycle; used for rate-limited discovered probes
const BLOCK_LAG_THRESHOLD = 3;
const STALE_SECONDS_THRESHOLD = 120;
const PROBE_TIMEOUT_MS = 5000;
const HEARTBEAT_CYCLES = 18;
const COOLDOWN_CYCLES = 2; // must fail N consecutive cycles before alerting
const REPEAT_ALERT_INTERVAL_MS = 21600000; // 6h — suppress identical alerts
const LOW_BALANCE_THRESHOLD = 500;
const CRITICAL_BALANCE_THRESHOLD = 100;

let previousState = { consecutiveHealthy: 0, lastBlockHeight: null };
// Track per-node consecutive failure counts and which nodes are in "alerted" state
let problemHistory = {}; // { "n1": { count: 2, issues: [...], alerted: true }, ... }
let chainProblemCount = 0; // consecutive cycles with chain-level issues
let chainAlerted = false;
let lastKnownBalance = null;
let balanceAlertLevel = null; // null | "low" | "critical"
let lastAlertSignature = null; // hash of last published alert's problem set
let lastAlertAt = 0; // timestamp of last alert publish
let activeRpcUrl = RPC_URL;
let versionMismatchAlerted = false;

// --- v6.4: Incident tracking ---
let activeIncidents = {};   // { "n4,n6": { id: "INC-001", ... } }
let incidentCounter = 0;    // auto-increment

// --- Incident reconciliation boundary (added 2026-04-24) ---
// Only incidents started at/after this timestamp are rehydrated into activeIncidents
// on startup and evaluated by per-cycle reconciliation. This deliberately excludes
// pre-fixnet-migration incidents and migration-era cohort (INC-245..256 from
// 2026-04-22) which remain as historical DB artifacts pending a separate
// retention/cleanup decision.
const INCIDENT_RECONCILIATION_START_AT = "2026-04-23T12:00:00.000Z";

function getNextIncidentId() {
  incidentCounter++;
  return "INC-" + String(incidentCounter).padStart(3, "0");
}

function openIncident(severity, affectedNodes, description, block) {
  var id = getNextIncidentId();
  var now = new Date().toISOString();
  var inc = {
    id: id,
    status: "active",
    severity: severity,
    startedAt: now,
    resolvedAt: null,
    durationSeconds: null,
    affectedNodes: affectedNodes,
    description: description,
    detectedBlock: block,
    resolvedBlock: null,
    alerts: [{ at: now, type: "OPENED", text: description }]
  };
  var key = affectedNodes.sort().join(",");
  activeIncidents[key] = inc;
  // Persist to SQLite
  try {
    sharedDb.prepare("INSERT INTO incidents (id, status, severity, started_at, affected_nodes, description, detected_block, alerts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, "active", severity, now, JSON.stringify(affectedNodes), description, block || 0, JSON.stringify(inc.alerts));
  } catch(e) { log("  [incidents] DB insert error: " + e.message); }
  log("  [incidents] Opened " + id + " (" + severity + "): " + description);
  return inc;
}

function resolveIncident(key, block) {
  var inc = activeIncidents[key];
  if (!inc) return;
  var now = new Date().toISOString();
  var duration = Math.round((new Date(now).getTime() - new Date(inc.startedAt).getTime()) / 1000);
  inc.status = "resolved";
  inc.resolvedAt = now;
  inc.durationSeconds = duration;
  inc.resolvedBlock = block;
  inc.alerts.push({ at: now, type: "RESOLVED", text: "Resolved after " + duration + "s" });
  // Update SQLite
  try {
    sharedDb.prepare("UPDATE incidents SET status=?, resolved_at=?, duration_seconds=?, resolved_block=?, alerts=? WHERE id=?")
      .run("resolved", now, duration, block || 0, JSON.stringify(inc.alerts), inc.id);
  } catch(e) { log("  [incidents] DB update error: " + e.message); }
  // Sweep orphaned duplicate active rows with same affected_nodes within reconciliation boundary
  // (these are DB rows that pre-dated rehydration and shared the same in-memory key)
  try {
    var affectedJson = JSON.stringify(inc.affectedNodes);
    var dupResult = sharedDb.prepare(
      "UPDATE incidents SET status=?, resolved_at=?, resolved_block=?, duration_seconds=(strftime('%s', ?) - strftime('%s', started_at)) WHERE status=? AND affected_nodes=? AND started_at >= ? AND id != ?"
    ).run("resolved", now, block || 0, now, "active", affectedJson, INCIDENT_RECONCILIATION_START_AT, inc.id);
    if (dupResult.changes > 0) {
      log("  [incidents] Swept " + dupResult.changes + " duplicate active row(s) for " + inc.id + " (affected=" + affectedJson + ")");
    }
  } catch(e) { log("  [incidents] Duplicate sweep error: " + e.message); }
  log("  [incidents] Resolved " + inc.id + " after " + duration + "s");
  delete activeIncidents[key];
}

function getActiveIncidentIds() {
  return Object.values(activeIncidents).map(function(i) { return i.id; });
}

function evaluatePublicIncidents() {
  try {
    var canonical = computeCanonicalState();
    var c = publicIncidentCounters;
    var obsBad = (canonical.status === "unknown" || canonical.data_quality === "insufficient");
    // Visibility record text names the observed cause (no answer, no height, stale) without the word "reachable".
    var visibilityText = "Insufficient public visibility: " + String(canonical.status_reason || "").replace(/^Insufficient data: /, "") + ".";

    // One-time adoption/backfill guard. Flag is only set once sharedDb exists,
    // so a DB-not-ready first cycle retries instead of silently skipping forever.
    if (!publicBackfillChecked && sharedDb) {
      publicBackfillChecked = true;
      if (obsBad && !activeIncidents[PUBLIC_VISIBILITY_MARKER]) {
        var existing = null;
        try { existing = sharedDb.query("SELECT id FROM incidents WHERE status='active' AND affected_nodes=? LIMIT 1").get(JSON.stringify([PUBLIC_VISIBILITY_MARKER])); } catch (e) {}
        if (existing) {
          log("  [public-incidents] Active DB incident " + existing.id + " exists but not in memory; relying on restart rehydration");
        } else {
          var minTs = null;
          try {
            var row = sharedDb.query("SELECT MIN(ts) t FROM public_node_history WHERE status = 'unknown'").get();
            if (row && row.t) {
              var brk = sharedDb.query("SELECT COUNT(*) c FROM public_node_history WHERE status != 'unknown' AND ts >= ?").get(row.t);
              if (brk.c === 0) minTs = new Date(row.t).toISOString();
            }
          } catch (e) {}
          var desc = visibilityText + (minTs ? " Continuous since earliest retained public observation; actual start may be earlier." : "");
          var inc = openIncident("warning", [PUBLIC_VISIBILITY_MARKER], desc, null);
          if (inc && minTs) {
            inc.startedAt = minTs; // in-memory too, so eventual resolve duration is honest
            try { sharedDb.prepare("UPDATE incidents SET started_at=? WHERE id=?").run(minTs, inc.id); } catch (e) {}
            log("  [public-incidents] Backdated " + inc.id + " to " + minTs + " (provable start in retained window)");
          }
        }
      }
    }

    // Condition records follow status: each opens after PUBLIC_INCIDENT_OPEN_CYCLES rounds of its condition and closes
    // after PUBLIC_INCIDENT_RESOLVE_CYCLES rounds without it. While visibility is poor no degraded or unstable record
    // opens: DNO does not claim the network is degraded while admitting it cannot see it (stepConditionRecords).
    // A record's text is fixed when it opens, so it is the reading's condition_reason: a standstill is told by when
    // it began ("No new height since ... UTC"), which stays true while the record is open.
    var reason = canonical.condition_reason ? String(canonical.condition_reason) : "";
    var records = {
      visibility: { marker: PUBLIC_VISIBILITY_MARKER, severity: "warning", text: visibilityText },
      degraded: { marker: PUBLIC_DEGRADED_MARKER, severity: "warning", text: "Public network condition observed: " + (reason || "status=degraded") },
      unstable: { marker: PUBLIC_UNSTABLE_MARKER, severity: "critical", text: "Public network condition observed: " + (reason || "status=unstable") }
    };
    var open = { visibility: !!activeIncidents[PUBLIC_VISIBILITY_MARKER], degraded: !!activeIncidents[PUBLIC_DEGRADED_MARKER], unstable: !!activeIncidents[PUBLIC_UNSTABLE_MARKER] };
    var step = stepConditionRecords(c, canonical, open, { open: PUBLIC_INCIDENT_OPEN_CYCLES, resolve: PUBLIC_INCIDENT_RESOLVE_CYCLES });
    step.actions.forEach(function(a) {
      var r = records[a.record];
      if (a.action === "open") openIncident(r.severity, [r.marker], r.text, null); else resolveIncident(r.marker, null);
    });
  } catch (e) { log("  [public-incidents] eval error: " + e.message); }
}

var FLEET_NODE_NAMES = NODE_NAMES;

// Public display name. Operator aliases are not a public identifier.
// truncId is shared by getValidatorGrowth and the /community route.
// Heights in server-built HTML: only a sanitized integer is ever formatted into a cell.
function heightCell(value) {
  var h = sanitizeHeight(value);
  return h === null ? "\u2014" : h.toLocaleString("en-US");
}
function truncId(id) {
  if (!id || id.length < 12) return id || "\u2014";
  return id.substring(0, 6) + "\u2026" + id.substring(id.length - 4);
}
function resolveNodeDisplay(opts) {
  var identity = (opts && opts.identity) || "";
  // discovered-<last4> only. No operator-name map. No fleet alias.
  return "discovered-" + (identity ? identity.substring(identity.length - 4) : "????");
}
// DISPLAY_PRIVACY: convert a raw discoveredPeers entry to a public-safe shape.
// Drops connection (host:port) and full identity; exposes resolved display + truncated id only.
// Rule: raw peer objects must never be JSON-stringified directly into a public endpoint.
function toPublicPeer(identity, peer) {
  return {
    display: resolveNodeDisplay({ identity: identity }),
    identity_truncated: truncId(identity),
    block: peer ? sanitizeHeight(peer.block) : null,
    online: !!(peer && peer.online),
    sync_status: (peer && peer.syncStatus) || null,
    listed_by: (peer && peer.listedBy) || 0,
    first_seen: (peer && peer.firstSeen) || null
  };
}
// One scope classifier for every surface (/incidents, /organism, last_24h, /timeline): an incident is fleet when
// its description marks a fleet reference/chain issue, or when every affected node is a fleet name: the
// configured fleet, a retired alias from FLEET_NODES_24H, or the fleet "CHAIN" key.
function isFleetName(n) { return FLEET_NODE_NAMES.indexOf(n) !== -1 || FLEET_NODES_24H.has(n) || n === "CHAIN"; }
function incidentScope(description, affectedNodes) {
  if (description && (description.indexOf("Fleet reference") === 0 || description === "Chain-level issue detected")) return "fleet";
  if (Array.isArray(affectedNodes) && affectedNodes.length > 0 && affectedNodes.every(isFleetName)) return "fleet";
  return "public";
}
function getPublicActiveIncidentIds() {
  return Object.values(activeIncidents).filter(function(i) {
    return incidentScope(i.description, i.affectedNodes) === "public";
  }).map(function(i) { return i.id; });
}
// Active public condition records (visibility / degraded / unstable markers). They are public incidents on
// /incidents and /timeline but are excluded from active_incidents, which feeds status.
function countActivePublicConditions() {
  return Object.values(activeIncidents).filter(function(i) {
    return isPublicConditionMarker(i) && incidentScope(i.description, i.affectedNodes) === "public";
  }).length;
}

function determineSeverity(offlineCount, chainIssues, lagCount) {
  if (offlineCount >= 3 || chainIssues > 0) return "critical";
  if (offlineCount >= 1 || lagCount >= 3) return "warning";
  return "info";
}

// Load incident counter from DB on startup
// Seven-day reliability per monitored seed, computed once every few public rounds instead of on every request
// (parsing a week of history per /health request cost ~80 ms on the HTTP path).
var validatorUptimeCache = { byName: {}, computedAt: 0 };
function refreshValidatorUptimeCache(force) {
  var now = Date.now();
  if (!sharedDb || (!force && now - validatorUptimeCache.computedAt < 5 * 60000)) return;
  var histStats = {};
  try {
    var cutoff = now - 7 * 86400000;
    var histRows = sharedDb.query("SELECT node_states FROM public_node_history WHERE ts > ?").all(cutoff);
    if (histRows.length > 10) {
      for (var hi = 0; hi < histRows.length; hi++) {
        var hnodes;
        try { hnodes = JSON.parse(histRows[hi].node_states); } catch (pe) { continue; }
        for (var ni = 0; ni < hnodes.length; ni++) {
          var nd = hnodes[ni];
          if (!nd || !nd.name) continue;
          var hst = histStats[nd.name] || (histStats[nd.name] = { total: 0, online: 0, latencySum: 0, latencyCount: 0 });
          hst.total++;
          if (nd.ok) {
            hst.online++;
            if (nd.latency && nd.latency > 0) { hst.latencySum += nd.latency; hst.latencyCount++; }
          }
        }
      }
    }
  } catch (hErr) { log("  [m6] History error: " + hErr.message); }
  validatorUptimeCache = { byName: histStats, computedAt: now };
}

// New peer-listed identities, on DNO's clock: "+n" is only an identity DNO knows it first listed inside the window.
//   started  when DNO first counted an identity on two public peerlists (catalogCountStarted, kept once it is known).
//   since    started + one hour. That first hour is the starting set: what the peerlists already listed when DNO began
//            to count (the first crawls' intake), never "+n".
//   t        the first-counted time of a row this version inserted. Only its INSERT writes counted_after, so a row
//            without one is an older record's: it is not in the count at all, whenever it is adopted. DNO held it before.
//   after    counted_after: the earliest of the last reads, by this process, of the peerlists that listed the identity
//            before DNO kept it. It was on none of them at that time, so it appeared since. Three cases:
//              - one of those peerlists had not been read before (CATALOG_AFTER_UNKNOWN): its first read after a start.
//                The identity may have been listed there, and waiting for a second peerlist, long before; the waiting
//                set is in memory and a restart empties it. Such a row is part of that start's starting set and is in
//                no window.
//              - within an hour of t: the identity is dated at t.
//              - more than an hour before t (one of those peerlists was not read in between): the identity appeared
//                somewhere in the gap. It counts in a window only when the whole gap is inside it, and a window whose
//                start the gap crosses has no figure.
// A window has a figure only when it begins after since and no gap crosses its start; otherwise it is null, never +0.
// reason names the cause for every window without a figure: a count younger than the window is said once, for the
// smallest such window (it holds for the larger ones); each gap names its window. numbers: the 1.0 fields, which stay
// numbers: the identities known to be first listed inside the window, so they are partial where first_counted has null.
const CATALOG_STARTING_SET_MS = 3600000;
const CATALOG_GAP_MS = 3600000;
const CATALOG_AFTER_UNKNOWN = -1;
const CATALOG_WINDOWS = [["today", 86400000, "24 h"], ["week", 7 * 86400000, "7 days"], ["month", 30 * 86400000, "30 days"]];
const CATALOG_FIRST_COUNTED_NOTE = "Identities DNO first listed inside each window, on DNO's clock, among those it keeps (listed by two public peerlists). In no window: the count's first hour (its starting set), an identity an older DNO record already held, and an identity that a peerlist listed in its first read after DNO started, before DNO kept it (it may have been listed there before). A window is null while the count does not cover it, or when a gap in the count crosses its start. validator_growth.today, week and month are the 1.0 fields: the same counts as numbers, partial where this object has null.";
function catalogFirstCounted(rows, started, now) {
  var out = { today: null, week: null, month: null, since: null, reason: null, note: CATALOG_FIRST_COUNTED_NOTE }, numbers = { today: 0, week: 0, month: 0 };
  if (started === null || started === undefined) { out.reason = "no identity has been counted on two public peerlists yet"; return { first_counted: out, numbers: numbers }; }
  var since = started + CATALOG_STARTING_SET_MS;
  out.since = new Date(since).toISOString();
  // Counted: after the starting set, inserted by this version (it has a read time at all), of known age, and not dated
  // after the present (a row written while the clock ran ahead is in no window until its time has come).
  var counted = rows.filter(function(r) { return r.t > since && r.t <= now && typeof r.after === "number" && r.after !== CATALOG_AFTER_UNKNOWN; });
  var reasons = [], youngSaid = false;
  CATALOG_WINDOWS.forEach(function(w) {
    var start = now - w[1], n = 0, unsure = false;
    counted.forEach(function(r) {
      if (r.t - r.after <= CATALOG_GAP_MS) { if (r.t > start) n++; }
      else if (r.after >= start) n++;
      else if (r.t > start) unsure = true;
    });
    numbers[w[0]] = n;
    if (since > start) { if (!youngSaid) reasons.push(now < since ? "the starting set is still being counted" : "the count of new identities started less than " + w[2] + " ago"); youngSaid = true; return; }
    if (unsure) { reasons.push("a gap in the count crosses the start of the last " + w[2]); return; }
    out[w[0]] = n;
  });
  if (reasons.length) out.reason = reasons.join("; ");
  return { first_counted: out, numbers: numbers };
}
// What the count reads from the store: one { t, after } per published row that isCounted admits. after is the row's
// counted_after: only this version's INSERT writes it, so a row without one (an older record's, adopted) is told apart
// in catalogFirstCounted by that mark. The row's times are not compared: a clock that stepped back can put an older
// record's first_seen after its adoption.
function catalogGrowthInput(db, isCounted) {
  return db.query("SELECT identity, public_listed_since, counted_after FROM validator_discoveries WHERE public_listed_since IS NOT NULL").all()
    .filter(function(r) { return isCounted(r.identity); })
    .map(function(r) { return { t: r.public_listed_since, after: r.counted_after }; });
}
// The count's start. It is a fact about the past, so it is kept (dno_meta, written once) and not read from the rows each
// time: at the row cap the earliest rows can be evicted, and a clock that steps back could put a later row before them;
// either would move a start read from the rows. A store that holds published rows and no start yet (an earlier 1.1
// build) gets their earliest first-counted time. null: nothing has been counted.
function loadCatalogCountStarted(db) {
  db.run("CREATE TABLE IF NOT EXISTS dno_meta (key TEXT PRIMARY KEY, value TEXT)");
  var row = db.query("SELECT value FROM dno_meta WHERE key = 'catalog_count_started'").get();
  var kept = row ? Number(row.value) : NaN;
  if (Number.isFinite(kept) && kept > 0) return kept;
  var first = db.query("SELECT MIN(public_listed_since) AS m FROM validator_discoveries WHERE public_listed_since IS NOT NULL").get();
  if (!first || first.m === null || first.m === undefined) return null;
  db.run("INSERT OR REPLACE INTO dno_meta (key, value) VALUES ('catalog_count_started', ?)", [String(first.m)]);
  return first.m;
}

function getValidatorGrowth() {
  var result = {
    today: 0, week: 0, month: 0, total: 0,
    first_counted: { today: null, week: null, month: null, since: null, reason: "no store is configured on this server", note: CATALOG_FIRST_COUNTED_NOTE },
    online: 0, synced: 0,
    monitored: Object.keys(PUBLIC_NODES).length,
    monitored_online: 0, monitored_at_head: 0,
    discovered: 0, discovered_online: 0,
    network_head: 0,
    public_peerlists_read: catalogLatest.peerlistsRead,
    catalog_crawl_completed_at: catalogLatest.completedAt ? new Date(catalogLatest.completedAt).toISOString() : null,
    // online and synced add configured seeds and catalog rows together (1.0 fields, kept for old clients).
    mixed_fields: { fields: ["online", "synced"], note: "configured seeds and catalog rows added together; kept for 1.x clients. Use monitored_online and monitored_at_head (seeds), discovered and discovered_online (catalog)." },
    validators: []
  };
  var pubHeights = (latestPublicNodes || []).map(ownHeight).filter(function(h) { return h !== null; });
  if (pubHeights.length > 0) result.network_head = Math.max.apply(null, pubHeights);
  if (!sharedDb) return result;
  result.first_counted.reason = "the store could not be read";   // stands only if the read below fails
  try {
    var now = Date.now();
    // v7.4: counts from validator_discoveries EXCLUDING monitored identities (clean discovered count).
    // A published row's first-counted time is public_listed_since (first_seen is the older agent's value on a row it
    // recorded); first_seen below is that public time for published rows.
    var allRows = sharedDb.query("SELECT identity, COALESCE(public_listed_since, first_seen) AS first_seen, last_seen, public_listed_since FROM validator_discoveries ORDER BY 2").all();
    var discRows = allRows.filter(function(r) { return r.public_listed_since != null && !isExcludedFromDiscovered(r.identity) && isValidIdentity(r.identity); });
    result.total = discRows.length;
    // The kept start; if it could not be kept, the earliest first-counted time among the published rows.
    var countStarted = catalogCountStarted !== null ? catalogCountStarted : discRows.reduce(function(m, r) { return m === null || r.public_listed_since < m ? r.public_listed_since : m; }, null);
    var counted = catalogFirstCounted(catalogGrowthInput(sharedDb, function(id) { return !isExcludedFromDiscovered(id) && isValidIdentity(id); }), countStarted, now);
    result.today = counted.numbers.today; result.week = counted.numbers.week; result.month = counted.numbers.month;
    result.first_counted = counted.first_counted;
    result.discovered = discRows.length;

    var firstSeenById = {};
    allRows.forEach(function(r) { firstSeenById[r.identity] = r.first_seen; });
    var syncedCount = 0;
    var validators = [];
    var head = result.network_head;
    function syncPct(block) { return (block !== null && head > 0) ? Math.min(100, Math.round((block / head) * 1000) / 10) : null; }

    // Pass 1: every monitored seed (from PUBLIC_NODES), regardless of DB state.
    for (var pnName in PUBLIC_NODES) {
      var pnDef = PUBLIC_NODES[pnName];
      var pnLive = (latestPublicNodes || []).find(function(n){ return n.name === pnName; });
      var block = ownHeight(pnLive);                                     // null when the seed did not list itself
      var online = pnLive ? !!pnLive.ok : false;
      var lag = (block !== null && head > 0) ? head - block : null;
      var fs = firstSeenById[pnDef.identity] || now;
      validators.push({
        display: pnName,
        identity: pnDef.identity,
        block: block,
        lag: lag,
        sync_pct: syncPct(block),          // null when no height was observed (was 0)
        online: online,
        monitored: true,
        first_seen_hours_ago: Math.round((now - fs) / 3600000)
      });
      if (online) { result.online++; result.monitored_online++; }
      if (online && lag !== null && lag < 100) { syncedCount++; result.monitored_at_head++; }
    }

    // Pass 2: retained catalog rows. Reported fields come from the latest crawl only; an identity not listed
    // this round carries no online flag and no height, just first seen and last listed.
    for (var vi = 0; vi < discRows.length; vi++) {
      var row = discRows[vi];
      var pub = catalogPublicRow(row, now);
      var rb = pub.reported ? pub.reported.height : null;
      var rlag = (rb !== null && head > 0) ? head - rb : null;
      var ron = !!(pub.reported && pub.reported.online);
      validators.push({
        display: pub.display,
        identity: row.identity,
        block: rb,
        lag: rlag,
        sync_pct: syncPct(rb),
        online: ron,
        monitored: false,
        first_seen_hours_ago: Math.round((now - row.first_seen) / 3600000),
        first_seen: pub.first_seen,
        last_listed: pub.last_listed,
        listed_this_cycle: pub.listed_this_cycle,
        listed_by: pub.listed_by,
        reported_sync_status: pub.reported ? pub.reported.sync_status : null
      });
      if (ron) { result.online++; result.discovered_online++; }
      if (ron && rlag !== null && rlag < 100) syncedCount++;
    }

    // M6: seven-day reliability for the monitored seeds (history holds public seeds only).
    refreshValidatorUptimeCache(false);
    for (var vj = 0; vj < validators.length; vj++) {
      var vhs = validators[vj].monitored ? validatorUptimeCache.byName[validators[vj].display] : null;
      if (vhs && vhs.total > 10) {
        validators[vj].uptime_7d = Math.round((vhs.online / vhs.total) * 1000) / 10;
        validators[vj].avg_latency_7d = vhs.latencyCount > 0 ? Math.round(vhs.latencySum / vhs.latencyCount) : null;
      } else {
        validators[vj].uptime_7d = null;
        validators[vj].avg_latency_7d = null;
      }
      validators[vj].sync_reliability_7d = null;
    }
    validators.sort(function(a, b) { if (a.monitored !== b.monitored) return a.monitored ? -1 : 1; return (b.sync_pct || 0) - (a.sync_pct || 0); });
    result.validators = validators;
    result.synced = syncedCount;
    return result;
  } catch(e) { log("  [growth] error: " + e.message); return result; }
}

// Public catalog (GET /catalog): retained identities, sanitized, with what peerlists reported this round.
function getPublicCatalog() {
  var out = { scope: "retained_catalog", crawl: { completed_at: catalogLatest.completedAt ? new Date(catalogLatest.completedAt).toISOString() : null, public_peerlists_read: catalogLatest.peerlistsRead, listed_this_cycle: catalogLatest.listedCount }, notes: [
    "Peer-listed identities from the public seeds. Not dialed. Not the on-chain validators table. Not a census of Demos beta.",
    "An identity is kept after two public peerlists have listed it; first_seen is the first of those listings DNO counted. The count is kept in memory, so a restart starts it again. One peerlist brings at most " + CATALOG_MAX_NEW_PER_PEERLIST + " new identities into the count per crawl.",
    "Reported fields are what the listing peerlists reported in the latest crawl. DNO does not dial these identities."
  ], rows: [] };
  if (!sharedDb) return out;
  try {
    var now = Date.now();
    var rows = sharedDb.query("SELECT identity, public_listed_since AS first_seen, last_seen FROM validator_discoveries WHERE public_listed_since IS NOT NULL").all()
      .filter(function(r) { return !isExcludedFromDiscovered(r.identity) && isValidIdentity(r.identity); });
    out.rows = rows.map(function(r) { return catalogPublicRow(r, now); })
      .sort(function(a, b) { return a.display.localeCompare(b.display) || a.identity_truncated.localeCompare(b.identity_truncated); });
  } catch (e) { log("  [catalog] read error: " + e.message); }
  return out;
}

// Exact-key lookup (GET /catalog/lookup?key=0x...): confirms whether a full key is in the retained catalog or
// is a configured seed, without publishing any full key. Anyone can already read full keys on a peerlist.
function lookupCatalogKey(key) {
  if (!isValidIdentity(key)) return { valid_key: false, in_catalog: false, configured_seed: null, row: null };
  var k = key.toLowerCase();
  for (var name in PUBLIC_NODES) {
    if (String(PUBLIC_NODES[name].identity).toLowerCase() === k) return { valid_key: true, in_catalog: false, configured_seed: name, row: null };
  }
  if (!sharedDb) return { valid_key: true, in_catalog: false, configured_seed: null, row: null };
  try {
    var row = sharedDb.query("SELECT identity, public_listed_since AS first_seen, last_seen FROM validator_discoveries WHERE lower(identity) = ? AND public_listed_since IS NOT NULL").get(k);
    return { valid_key: true, in_catalog: !!row, configured_seed: null, row: row ? catalogPublicRow(row, Date.now()) : null };
  } catch (e) { return { valid_key: true, in_catalog: false, configured_seed: null, row: null, error: "lookup unavailable" }; }
}

// === Layer 2: Canonical assessment model ===
/**
 * Canonical State Model (v1.0)
 *
 * The Oracle separates four independent concepts:
 *
 * - status: current network operability (is the network usable right now?)
 * - risk: current resilience / safety margin (how fragile is the situation?)
 * - confidence: certainty of the assessment (how reliable is the data?)
 * - incidents: active unresolved issues (what is currently broken?)
 *
 * Important distinctions:
 *
 * - Status MUST NOT degrade solely due to reduced observer coverage.
 *   Node loss affects risk, not status, unless operability is impacted.
 *   The rule itself is src/status-rule.mjs (assess); this function gathers its inputs.
 *
 * - Risk captures reduced redundancy even when status is stable.
 *
 * - Confidence reflects data quality, not network health.
 *
 * - Incidents represent active problems only, not historical events.
 */
function computeCanonicalState() {
  var publicNodes = latestPublicNodes || [];
  var nowMs = Date.now();
  var observedAtMs = lastPublicObservedAt || null;
  // Whole seconds since the last completed public observation (since agent start before the first one).
  var stalenessSeconds = Math.max(0, Math.round((nowMs - (observedAtMs || AGENT_STARTED_AT)) / 1000));
  var pubTotal = publicNodes.length;
  var pubOnline = publicNodes.filter(function(n) { return n.ok; });
  var pubReachable = pubOnline.length;                                   // seeds that answered /info
  var heights = pubOnline.map(ownHeight)
    .filter(function(h) { return h !== null; }).sort(function(a, b) { return a - b; });   // seeds that returned their own height

  // Data quality: the observation is at most 300 s old, and it holds a reading: two seeds reported their own height,
  // or validators that answer as listed stood in for a missing seed (status-rule.mjs). The reason code names the
  // observation's age first, then what the seeds gave; it is null whenever there is a reading.
  var dataQualityReason = null;
  if (!observedAtMs) dataQualityReason = "no_observation";
  else if (stalenessSeconds > PUBLIC_STALE_AFTER_SECONDS) dataQualityReason = "stale";
  else dataQualityReason = seedsSufficient(publicNodes).reason;   // too_few_answers, too_few_heights or null (seed-read.mjs; the pre-restart check uses the same rule)
  var timeReason = dataQualityReason === "no_observation" || dataQualityReason === "stale" ? dataQualityReason : null;

  // Public incidents that feed status: public scope, excluding DNO's own condition records (which follow status).
  var publicActiveIncs = Object.values(activeIncidents).filter(function(inc) {
    if (incidentScope(inc.description, inc.affectedNodes) !== "public") return false;
    if (isPublicConditionMarker(inc)) return false;
    return true;
  });
  var publicIncidentCount = publicActiveIncs.length;
  var max_incident_severity = "none";
  for (var mi = 0; mi < publicActiveIncs.length; mi++) {
    var sev = publicActiveIncs[mi].severity;
    if (sev === "critical") { max_incident_severity = "critical"; break; }
    if (sev === "warning") max_incident_severity = "warning";
    else if (sev === "info" && max_incident_severity === "none") max_incident_severity = "info";
  }

  // Height movement as observed: seconds since the last round that showed a new height (updateHeightTracker).
  // Null when the latest observation gave the clock no height (nothing to compare). Its cause is not known from here.
  // Before any comparison (first round after a start) both stay null. Without an observed advance the static
  // duration is counted from the first round that showed the current height: a lower bound. See heightMovement().
  var hm = heightMovement(observedAtMs, heightTracker.maxHeight !== null);

  // The reading: which witnesses count, agreement, confidence, status, risk and every reason string (status-rule.mjs).
  // Status is what the witnesses show of the network, not observer coverage: seeds that do not answer raise risk,
  // and status only when no reading is left. A reading that would be stable reads degraded once no new height has
  // been seen for RULE.standstillSeconds.
  var reading = assess({ timeReason: timeReason, seedReason: timeReason ? null : dataQualityReason, seedsTotal: pubTotal, seedsAnswered: pubReachable,
    seedHeights: heights, validators: witnessInput(), maxIncidentSeverity: max_incident_severity, publicIncidentCount: publicIncidentCount,
    movement: { staticSeconds: hm.staticSeconds, advancing: hm.advancing, stalled: hm.stalled, staticSince: hm.staticSince } });
  var agreement = reading.agreement;

  // M4: Trend — current cycle against the average of up to 15 previous cycles, all inside a bounded window,
  // so a restart or a gap resets trend to unknown instead of comparing against rows from before the gap. Only rows
  // written under the own-height rule (OWN_HEIGHT_SINCE): an older agent's spread and agreement followed another rule.
  var trend = "unknown";
  if (reading.data_quality === "sufficient" && sharedDb) {
    try {
      var trendSince = nowMs - Math.round(24 * MONITOR_INTERVAL_MS);
      var histRows = sharedDb.query("SELECT nodes_reachable, nodes_total, agreement_state, block_spread FROM public_node_history WHERE ts > ? AND ts >= ? ORDER BY ts DESC LIMIT 15 OFFSET 1").all(trendSince, OWN_HEIGHT_SINCE);
      if (histRows.length >= 10) {
        // Map agreement to numeric: strong=3, moderate=2, weak=1, unknown=0
        function agNum(s) { return s === "strong" ? 3 : s === "moderate" ? 2 : s === "weak" ? 1 : 0; }
        var avgReachable = 0, avgAgreement = 0, avgSpread = 0;
        for (var ti = 0; ti < histRows.length; ti++) {
          avgReachable += histRows[ti].nodes_reachable;
          avgAgreement += agNum(histRows[ti].agreement_state);
          avgSpread += (histRows[ti].block_spread || 0);
        }
        avgReachable /= histRows.length;
        avgAgreement /= histRows.length;
        avgSpread /= histRows.length;
        var curAg = agNum(agreement.state);
        var curSpread = agreement.block_spread || 0;
        var improving = 0, worsening = 0;
        // Signal 1: nodes answering
        if (pubReachable > avgReachable + 0.3) improving++;
        else if (pubReachable < avgReachable - 0.3) worsening++;
        // Signal 2: agreement strength
        if (curAg > avgAgreement + 0.3) improving++;
        else if (curAg < avgAgreement - 0.3) worsening++;
        // Signal 3: block spread (lower = better)
        if (curSpread < avgSpread - 5) improving++;
        else if (curSpread > avgSpread + 5) worsening++;
        if (improving >= 2 && worsening === 0) trend = "improving";
        else if (worsening >= 2 && improving === 0) trend = "worsening";
        else trend = "stable";
      }
    } catch(trendErr) { trend = "unknown"; }
  }

  // seed_heights (seeds that gave their own height) and condition_reason (the text a condition record opens with)
  // are for the store and the records; no route publishes them.
  return { status: reading.status, trend: trend, risk: reading.risk, data_quality: reading.data_quality, data_quality_reason: reading.data_quality_reason, confidence: reading.confidence, confidence_reason: reading.confidence_reason, agreement: agreement, active_incidents: publicIncidentCount, active_public_conditions: countActivePublicConditions(), max_incident_severity: max_incident_severity, summary: reading.summary, status_reason: reading.status_reason, risk_factors: reading.risk_factors, agreement_reason: reading.agreement_reason, staleness_seconds: stalenessSeconds, observed_at: observedAtMs ? new Date(observedAtMs).toISOString() : null, height_last_advanced_at: hm.advancedAtIso, height_static_seconds: hm.staticSeconds, last_updated: new Date(observedAtMs || AGENT_STARTED_AT).toISOString(), api_version: API_VERSION,
    witnesses: reading.witnesses, height_standstill_after_seconds: RULE.standstillSeconds, condition_reason: reading.condition_reason, seed_heights: heights.length };
}

// ============================================================================
// Phase B: Last 24h Summary — helpers
// ============================================================================

function escapeHtmlTL(t) { return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderTimelinePage() {
  var events = [];
  try {
    var rows = sharedDb.query("SELECT id,status,severity,started_at,resolved_at,duration_seconds,description,affected_nodes FROM incidents WHERE started_at >= ? ORDER BY started_at DESC LIMIT 5000").all(INCIDENT_RECONCILIATION_START_AT); // LIMIT: pagination can come later if volume grows
    for (var i = 0; i < rows.length; i++) {
      if (isFleetIncident_24h(rows[i])) continue;
      events.push({ d: rows[i].started_at, kind: "incident", r: rows[i] });
    }
  } catch (e) { log("  [timeline] query error: " + e.message); }
  for (var j = 0; j < TIMELINE_RELEASE_EVENTS.length; j++) {
    events.push({ d: TIMELINE_RELEASE_EVENTS[j].date + "T12:00:00.000Z", kind: TIMELINE_RELEASE_EVENTS[j].type, text: TIMELINE_RELEASE_EVENTS[j].text });
  }
  TIMELINE_STORE_DATED_RELEASES.forEach(function(rel) {
    if (apiFirstStarts[rel.api]) events.push({ d: new Date(apiFirstStarts[rel.api]).toISOString(), kind: rel.type, text: rel.text });
  });
  events.sort(function(a,b){ return a.d < b.d ? 1 : -1; });
  var items = "";
  for (var k = 0; k < events.length; k++) {
    var ev = events[k], day = String(ev.d).slice(0,10);
    if (ev.kind === "incident") {
      var r = ev.r, sev = escapeHtmlTL(r.severity || "info");
      var state = r.status === "active" ? "ongoing" : "resolved";
      var dur = "";
      var secs = r.status === "active" ? Math.round((Date.now() - new Date(r.started_at).getTime())/1000) : (r.duration_seconds || 0);
      if (secs >= 86400) dur = Math.floor(secs/86400) + "d " + Math.floor((secs%86400)/3600) + "h";
      else if (secs >= 3600) dur = Math.floor(secs/3600) + "h " + Math.floor((secs%3600)/60) + "m";
      else dur = Math.floor(secs/60) + "m";
      var affectedTL = null; try { affectedTL = JSON.parse(r.affected_nodes); } catch (eTL) { affectedTL = null; }
      var isCond = isPublicConditionMarker({ affectedNodes: affectedTL });
      items += '<div class="tl-item sev-' + sev + '"><div class="tl-date">' + day + '</div><div class="tl-body"><span class="tl-tag">' + (isCond ? "condition record" : sev) + '</span><span class="tl-tag">' + state + (dur ? " · " + dur : "") + '</span><div class="tl-text">Observed: ' + escapeHtmlTL(r.description || r.id) + '</div><div class="tl-meta">' + escapeHtmlTL(r.id) + ' · opened ' + escapeHtmlTL(String(r.started_at).slice(0,16).replace("T"," ")) + ' UTC' + (r.resolved_at ? ' · resolved ' + escapeHtmlTL(String(r.resolved_at).slice(0,16).replace("T"," ")) + ' UTC' : '') + '</div>'
        + (function() { var note = incidentNote(r.id, r.started_at); return note ? '<div class="tl-meta tl-note">Note added ' + escapeHtmlTL(note.added) + ': ' + escapeHtmlTL(note.text) + '</div>' : ''; })()
        + '</div></div>';
    } else {
      items += '<div class="tl-item sev-release"><div class="tl-date">' + day + '</div><div class="tl-body"><span class="tl-tag">' + escapeHtmlTL(ev.kind) + '</span><div class="tl-text">' + escapeHtmlTL(ev.text) + '</div></div></div>';
    }
  }
  if (!items) items = '<div class="tl-item"><div class="tl-body"><div class="tl-text">No public-scope events recorded yet. Public incident generation began 2026-06-11.</div></div></div>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timeline · Demos Network Oracle</title>' + siteHead()
    + '<style>.tl{max-width:52rem}.tl-item{position:relative;display:grid;grid-template-columns:6.5rem minmax(0,1fr);gap:16px;padding:0 0 24px 22px;border-left:1px solid var(--line);margin-left:5px}'
    + '.tl-item::before{content:"";position:absolute;left:-5px;top:6px;width:9px;height:9px;background:var(--metal-0);border:1px solid var(--metal-0)}'
    + '.sev-warning::before{background:var(--elevated-risk);border-color:var(--elevated-risk)}.sev-critical::before{background:var(--degraded);border-color:var(--degraded)}.sev-release::before{background:var(--bg);border-color:var(--metal-1)}'
    + '.tl-date{font:400 .8125rem/1.6 var(--mono);color:var(--mute)}.tl-body{min-width:0}.tl-tag{display:inline-block;font:400 .75rem/1.4 var(--mono);color:var(--mute);border:1px solid var(--line);border-radius:var(--radius);padding:1px 6px;margin:0 6px 6px 0}'
    + '.tl-text{color:var(--ink);line-height:1.5}.tl-meta{font-size:.8125rem;color:var(--mute);margin-top:4px}'
    + '@media(max-width:719px){.tl-item{grid-template-columns:minmax(0,1fr);gap:2px}}</style></head><body>'
    + siteHeader("timeline")
    + '<main id="main"><header class="doc-head"><div class="wrap"><div><h1>Observation timeline</h1>'
    + '<p class="doc-lede">Public-scope incidents and condition records from the Oracle’s own record (since the 2026-04-23 incident reconciliation boundary), with Oracle release events, which are maintained in its code.</p>'
    + '<div class="doc-intro"><p>Public incident generation began 2026-06-11; the first observability incident is backdated to the provable start of its condition within retained observations, and the condition may have started earlier. Observability incidents record limits of the Oracle’s own visibility; they are not network-failure claims. Raw data: <a href="/incidents">/incidents</a>.</p></div>'
    + '</div></div></header><div class="wrap" style="padding-block:40px 72px"><div class="tl">' + items + '</div></div></main>'
    + siteFooter("timeline") + '</body></html>';
}
function isFleetIncident_24h(inc) {
  var affected;
  try {
    affected = typeof inc.affected_nodes === 'string' ? JSON.parse(inc.affected_nodes) : inc.affected_nodes;
  } catch (e) {
    affected = null;
  }
  return incidentScope(inc.description, affected) === "fleet";
}

function computeChainMovement_24h(rows) {
  if (!rows || rows.length === 0) return { state: "unknown", reason: "no_data", blocks_advanced: null };

  var bucketMs = CHAIN_BUCKET_MIN_24H * 60000;
  var minRequiredBuckets = 12;

  var buckets = {};
  for (var i = 0; i < rows.length; i++) {
    var bucketIdx = Math.floor(rows[i].ts / bucketMs);
    if (!buckets[bucketIdx]) buckets[bucketIdx] = [];
    buckets[bucketIdx].push(rows[i]);
  }

  var bucketKeys = Object.keys(buckets).map(Number).sort(function(a, b) { return a - b; });

  if (bucketKeys.length < minRequiredBuckets) {
    return { state: "unknown", reason: "insufficient_buckets", buckets: bucketKeys.length, blocks_advanced: null };
  }

  var advancing = 0, nonAdvancing = 0, currentStaticRun = 0, maxStaticRun = 0;

  // Each bucket is compared with the end of the previous bucket, so a bucket holding a single row (window
  // edges, the bucket in progress, the first row after a gap) is not mistaken for a static height.
  var prevLast = null;
  for (var k = 0; k < bucketKeys.length; k++) {
    var b = buckets[bucketKeys[k]];
    var first = b[0].median_block;
    var last = b[b.length - 1].median_block;
    var base = prevLast !== null ? prevLast : (b.length >= 2 ? first : null);
    prevLast = last;
    if (base === null || last === null) continue;   // nothing to compare against yet

    if (last > base) {
      advancing++;
      if (currentStaticRun > maxStaticRun) maxStaticRun = currentStaticRun;
      currentStaticRun = 0;
    } else {
      nonAdvancing++;
      currentStaticRun++;
    }
  }
  if (currentStaticRun > maxStaticRun) maxStaticRun = currentStaticRun;

  var totalBuckets = advancing + nonAdvancing;
  var pctAdvancing = totalBuckets > 0 ? advancing / totalBuckets : 0;
  var longestStaticMin = maxStaticRun * CHAIN_BUCKET_MIN_24H;
  // Blocks advanced in the window, as observed: newest median minus oldest median, over rounds with a reading (data
  // quality sufficient: two seeds reported their own height, or validators stood in for a missing seed). Null when there is no pair to compare, or when the
  // median went down by more than the ±25 agreement band between two such rounds (a reset, or seeds far apart):
  // one difference would not describe the chain then. No target rate is implied.
  var medians = rows.filter(function(r) { return r.median_block !== null && r.median_block !== undefined && (r.data_quality === undefined || r.data_quality === "sufficient"); });
  var blocksAdvanced = medians.length >= 2 ? medians[medians.length - 1].median_block - medians[0].median_block : null;
  for (var mb = 1; blocksAdvanced !== null && mb < medians.length; mb++) {
    if (medians[mb].median_block < medians[mb - 1].median_block - 25) blocksAdvanced = null;
  }
  if (blocksAdvanced !== null && blocksAdvanced < 0) blocksAdvanced = null;

  if (longestStaticMin >= CHAIN_STATIC_RUN_MIN_24H) {
    return {
      state: "interrupted",
      longest_static_minutes: longestStaticMin,
      pct_advancing: Math.round(pctAdvancing * 100) / 100,
      blocks_advanced: blocksAdvanced
    };
  }
  if (pctAdvancing >= CHAIN_ADVANCE_PCT_24H) {
    return { state: "normal", pct_advancing: Math.round(pctAdvancing * 100) / 100, blocks_advanced: blocksAdvanced };
  }
  return {
    state: "interrupted",
    pct_advancing: Math.round(pctAdvancing * 100) / 100,
    reason: "low_advance_ratio",
    blocks_advanced: blocksAdvanced
  };
}

function computeLongestNonStable_24h(rows) {
  if (!rows || rows.length < 2) return 0;
  var longestMs = 0, runStart = null, runLastTs = null;
  var gapMs = 3 * MONITOR_INTERVAL_MS;   // no observation for three rounds ends a run: a gap is not "non-stable"

  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].status;
    var nonStable = (s === "unstable" || s === "degraded");
    var gapBefore = runLastTs !== null && rows[i].ts - runLastTs > gapMs;

    if (nonStable && !gapBefore) {
      if (runStart === null) runStart = rows[i].ts;
      runLastTs = rows[i].ts;
    } else {
      if (runStart !== null) {
        var runMs = (runLastTs - runStart) + MONITOR_INTERVAL_MS;
        if (runMs > longestMs) longestMs = runMs;
        runStart = null;
        runLastTs = null;
      }
      if (nonStable) { runStart = rows[i].ts; runLastTs = rows[i].ts; }   // a run resumes after a gap
    }
  }
  if (runStart !== null) {
    var openRunMs = (runLastTs - runStart) + MONITOR_INTERVAL_MS;
    if (openRunMs > longestMs) longestMs = openRunMs;
  }
  return Math.floor(longestMs / 60000);
}

function compute24hSummary() {
  if (!sharedDb) return null;

  var now = Date.now();
  var since = now - 86400000;
  var nowIso = new Date(now).toISOString();
  var sinceIso = new Date(since).toISOString();

  try {
    var aggRow = sharedDb.query(
      "SELECT COUNT(*) AS observed_cycles, " +
      "  MAX(nodes_total) AS peak_set_size, " +
      "  (SELECT nodes_total FROM public_node_history " +
      "   WHERE ts > ? GROUP BY nodes_total " +
      "   ORDER BY COUNT(*) DESC, nodes_total DESC LIMIT 1) AS typical_set_size " +
      "FROM public_node_history WHERE ts > ?"
    ).get(since, since);

    var observedCycles = (aggRow && aggRow.observed_cycles) || 0;
    var coverage = observedCycles / expectedCycles24h();

    if (coverage < COVERAGE_GATE_24H) {
      return {
        sufficient: false,
        coverage_pct: Math.round(coverage * 1000) / 10,
        observed_cycles: observedCycles,
        expected_cycles: expectedCycles24h(),
        message: "Insufficient observation in the last 24 hours — building baseline.",
        computed_at: nowIso
      };
    }

    var typical = aggRow.typical_set_size;
    var peak = aggRow.peak_set_size;

    var peakInfo = null;
    if (peak > typical) {
      var peakRow = sharedDb.query(
        "SELECT COUNT(*) AS peak_cycles, " +
        "  AVG(nodes_reachable * 1.0) AS peak_avg_reachable " +
        "FROM public_node_history WHERE ts > ? AND nodes_total = ?"
      ).get(since, peak);

      peakInfo = {
        size: peak,
        cycles: peakRow.peak_cycles,
        avg_reachable: Math.round(peakRow.peak_avg_reachable * 10) / 10,
        pct_of_window: Math.round((peakRow.peak_cycles / observedCycles) * 1000) / 10
      };
    }

    // Chain movement reads only rows written under the own-height rule (ts >= OWN_HEIGHT_SINCE). While those rows
    // begin inside the window, a figure from them would describe the time since they began, not the 24 hours the
    // coverage beside it counts over every row: nothing is published until they cover the window.
    var chainMovement;
    if (OWN_HEIGHT_SINCE > since) chainMovement = { state: "unknown", reason: "own_height_record_shorter_than_window", blocks_advanced: null };
    else {
      var blockRows = sharedDb.query(
        "SELECT ts, median_block, data_quality FROM public_node_history " +
        "WHERE ts > ? AND ts >= ? AND median_block IS NOT NULL ORDER BY ts ASC"
      ).all(since, OWN_HEIGHT_SINCE);
      chainMovement = computeChainMovement_24h(blockRows);
    }

    var statusRows = sharedDb.query(
      "SELECT ts, status FROM public_node_history WHERE ts > ? ORDER BY ts ASC"
    ).all(since);
    var longestNonStableMin = computeLongestNonStable_24h(statusRows);

    var incidentRows = sharedDb.query(
      "SELECT id, severity, status, started_at, resolved_at, affected_nodes, description " +
      "FROM incidents " +
      "WHERE severity = 'critical' AND started_at >= ? AND started_at <= ? " +
      "  AND (status = 'active' OR resolved_at >= ?)"
    ).all(INCIDENT_RECONCILIATION_START_AT, nowIso, sinceIso);

    var activeCriticalPublic = 0, criticalPublicInWindow = 0;
    var malformedIncidents = 0;
    for (var i = 0; i < incidentRows.length; i++) {
      var inc = incidentRows[i];
      try {
        var parsed = JSON.parse(inc.affected_nodes);
        if (!Array.isArray(parsed)) { malformedIncidents++; continue; }
      } catch (e) { malformedIncidents++; continue; }

      // Public incidents only, as in active_incidents: DNO's condition records follow status and are counted in
      // active_public_conditions, so a critical (unstable) record is not a critical public incident here either.
      if (!isFleetIncident_24h(inc) && !isPublicConditionMarker({ affectedNodes: parsed })) {
        criticalPublicInWindow++;                                  // active now, or resolved inside the window
        if (inc.status === "active") activeCriticalPublic++;      // active now
      }
    }
    if (malformedIncidents > 0) {
      log("[24h] " + malformedIncidents + " incident rows had malformed affected_nodes");
    }

    return {
      sufficient: true,
      coverage_pct: Math.round(coverage * 1000) / 10,
      observed_cycles: observedCycles,
      expected_cycles: expectedCycles24h(),
      typical_set_size: typical,
      peak_set: peakInfo,
      chain_movement: chainMovement,
      longest_non_stable_minutes: longestNonStableMin,
      active_critical_public_incidents: activeCriticalPublic,
      critical_public_incidents_in_window: criticalPublicInWindow,
      computed_at: nowIso
    };
  } catch (e) {
    log("[24h] Summary computation error: " + e.message);
    return null;
  }
}

function getLast24h() {
  var now = Date.now();
  if (last24hCache.value && (now - last24hCache.computedAt) < LAST_24H_TTL_MS) {
    return last24hCache.value;
  }
  last24hCache.value = compute24hSummary() || { sufficient: false, message: "Last 24 hours could not be computed.", computed_at: new Date(now).toISOString() };
  last24hCache.computedAt = now;
  return last24hCache.value;
}

// M3: Record public node observation snapshot
function recordPublicNodeHistory() {
  if (!sharedDb) return;
  try {
    var canonical = computeCanonicalState();
    var nodes = (latestPublicNodes || []).map(function(n) {
      return { name: n.name, identity: n.identity || null, ok: n.ok || false, block: ownHeight(n), latency: n.latencyMs || null };
    });
    sharedDb.run(
      "INSERT INTO public_node_history (ts, status, risk, confidence, data_quality, agreement_state, median_block, block_spread, nodes_total, nodes_reachable, node_states, own_height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
      [
        Date.now(),
        canonical.status,
        canonical.risk,
        canonical.confidence,
        canonical.data_quality,
        canonical.agreement.state,
        canonical.agreement.median_block,
        canonical.agreement.block_spread,
        canonical.seed_heights,   // seeds that reported their own height, in every mode: a row that is sufficient with fewer than two was read with validators
        nodes.filter(function(n) { return n.ok; }).length,
        JSON.stringify(nodes)
      ]
    );
    var cutoff = Date.now() - PUBLIC_NODE_HISTORY_RETENTION_DAYS * 86400000;
    sharedDb.run("DELETE FROM public_node_history WHERE ts < ?", [cutoff]);
  } catch(e) { log("  [history] Public node history write error: " + e.message); }
}

// Phase 1: append-only observation history for discovered nodes.
// WRITES ONLY to node_observation_history. Reads discoveredPeers (observation side).
// MUST NEVER touch latestPublicNodes / computeCanonicalState
// (enforced by observation-isolation.test.mjs, L1_OBSERVATION_ISOLATION).
// Mirrors recordPublicNodeHistory's append+prune idiom. Single INSERT per peer —
// do NOT replicate the validator_discoveries double-INSERT at 2491-2493.
var observationHistoryPrunedAt = 0;
function recordObservationHistory() {
  if (!sharedDb) return;
  try {
    var now = Date.now();
    // Listed in the latest crawl only; bounded per round, identities first recorded earliest first.
    var peers = Object.values(discoveredPeers || {}).sort(function(a, b) { return (a.firstSeen || 0) - (b.firstSeen || 0); }).slice(0, OBSERVATION_HISTORY_MAX_PER_ROUND);
    sharedDb.exec("BEGIN");
    for (var i = 0; i < peers.length; i++) {
      var p = peers[i];
      if (!p || !p.identity) continue;
      sharedDb.run(
        "INSERT INTO node_observation_history (ts, identity, online, block) VALUES (?, ?, ?, ?)",
        [now, p.identity, p.online ? 1 : 0, (p.block != null ? p.block : null)]
      );
    }
    sharedDb.exec("COMMIT");
    if (now - observationHistoryPrunedAt > 3600000) {
      observationHistoryPrunedAt = now;
      var cutoff = now - OBSERVATION_HISTORY_RETENTION_DAYS * 86400000;
      sharedDb.run("DELETE FROM node_observation_history WHERE ts < ?", [cutoff]);
    }
  } catch (e) {
    try { sharedDb.exec("ROLLBACK"); } catch (e2) {}
    log("  [obs-history] write error: " + e.message);
  }
}

function generateSignals(data, stalenessSeconds) {
  var signals = [];
  if (!data || !data.nodeReports) {
    signals.push({ type: "no_data", severity: "warning", nodes: [], value: null, message: "No fleet data available yet" });
    return signals;
  }
  var nodes = data.nodeReports;
  var total = nodes.length;
  // Signal filters must respect nodeReports tri-state fields:
  // true = observed-good, false = observed-bad, null/undefined = unknown.
  // Unknown state must never emit a signal. See producer contract ~line 1163.
  var onlineNodes = nodes.filter(function(n) { return n.online; });
  var offlineNodes = nodes.filter(function(n) { return n.online === false; });
  var lagNodes = nodes.filter(function(n) { return n.issues && n.issues.some(function(i) { return i.indexOf("BLOCK_LAG") !== -1; }); });
  var mismatchNodes = nodes.filter(function(n) { return n.identityMatch === false; });
  var notReadyNodes = nodes.filter(function(n) { return n.online === true && n.ready === false; });
  var notSyncedNodes = nodes.filter(function(n) { return n.syncOk === false; });
  var maxBlock = Math.max.apply(null, nodes.map(function(n) { return n.blockHeight || 0; }));
  var minBlock = Math.min.apply(null, nodes.filter(function(n) { return n.blockHeight; }).map(function(n) { return n.blockHeight; }));

  // Offline nodes
  if (offlineNodes.length > 0) {
    var sev = offlineNodes.length >= 3 ? "critical" : offlineNodes.length >= 2 ? "warning" : "info";
    // Fleet uses "offline" (direct SSH/process visibility); public nodes use
    // "unreachable" (vantage-limited inference). Intentional — do not unify.
    signals.push({ type: "node_offline", severity: sev, nodes: offlineNodes.map(function(n) { return n.name; }), value: offlineNodes.length, message: offlineNodes.map(function(n) { return n.name; }).join(", ") + " offline" });
  }

  // Block lag
  if (lagNodes.length > 0) {
    lagNodes.forEach(function(n) {
      var lag = maxBlock - (n.blockHeight || 0);
      var sev = lag > 50 ? "critical" : lag > 10 ? "warning" : "info";
      signals.push({ type: "block_lag", severity: sev, nodes: [n.name], value: lag, message: n.name + " is " + lag + " blocks behind fleet" });
    });
  }

  // Identity mismatch
  if (mismatchNodes.length > 0) {
    signals.push({ type: "identity_mismatch", severity: "critical", nodes: mismatchNodes.map(function(n) { return n.name; }), value: mismatchNodes.length, message: mismatchNodes.map(function(n) { return n.name; }).join(", ") + " identity mismatch — declared identity does not match observed identity" });
  }

  // Not ready
  if (notReadyNodes.length > 0) {
    signals.push({ type: "not_ready", severity: "info", nodes: notReadyNodes.map(function(n) { return n.name; }), value: notReadyNodes.length, message: notReadyNodes.map(function(n) { return n.name; }).join(", ") + " online but not ready" });
  }

  // Not synced
  if (notSyncedNodes.length > 0) {
    var sev = notSyncedNodes.length >= 3 ? "critical" : "warning";
    signals.push({ type: "not_synced", severity: sev, nodes: notSyncedNodes.map(function(n) { return n.name; }), value: notSyncedNodes.length, message: notSyncedNodes.map(function(n) { return n.name; }).join(", ") + " not synced" });
  }

  // Chain stall
  if (stalenessSeconds && stalenessSeconds > 120) {
    var sev = stalenessSeconds > 300 ? "critical" : "warning";
    signals.push({ type: "chain_stall", severity: sev, nodes: [], value: Math.round(stalenessSeconds), message: "No new data for " + Math.round(stalenessSeconds / 60) + " min — possible chain stall" });
  }

  // Low online count
  if (onlineNodes.length < Math.ceil(total * 0.7)) {
    signals.push({ type: "low_online_count", severity: "critical", nodes: offlineNodes.map(function(n) { return n.name; }), value: onlineNodes.length, message: "Only " + onlineNodes.length + "/" + total + " nodes online" });
  }

  // Block spread / divergence
  if (maxBlock && minBlock && (maxBlock - minBlock) > 50) {
    signals.push({ type: "block_divergence", severity: "warning", nodes: [], value: maxBlock - minBlock, message: "Block spread of " + (maxBlock - minBlock) + " across fleet — possible fork" });
  }

  // Public node signals
  if (latestPublicNodes && latestPublicNodes.length > 0) {
    var pubOffline = latestPublicNodes.filter(function(n) { return !n.ok; });
    var pubOnline = latestPublicNodes.filter(function(n) { return n.ok; });
    if (pubOffline.length > 0) {
      signals.push({ type: "public_node_offline", severity: "info", nodes: pubOffline.map(function(n) { return n.name; }), value: pubOffline.length, message: pubOffline.map(function(n) { return n.name; }).join(", ") + " unreachable" });
    }
    if (pubOnline.length > 0) {
      var pubBlocks = pubOnline.map(ownHeight).filter(Boolean);
      var pubBlock = pubBlocks.length > 0 ? Math.max.apply(null, pubBlocks) : null;
      if (pubBlock) signals.push({ type: "public_network_block", severity: "info", nodes: pubOnline.map(function(n) { return n.name; }), value: pubBlock, message: "Public network at block " + pubBlock + " (" + pubOnline.length + " nodes online)" });
    }
  }

  // Crawl-visible this cycle = listed on the public peerlists read this round (type remains discovered_validators)
  var discovered = Object.values(discoveredPeers || {});
  if (discovered.length > 0) {
    var onlineDiscovered = discovered.filter(function(p) { return p.online; });
    signals.push({ type: "discovered_validators", severity: "info", nodes: discovered.map(function(p) { return truncIdentity(p.identity); }), value: discovered.length, message: discovered.length + " crawl-visible this cycle (" + onlineDiscovered.length + " reported online)" });
  }

  // All healthy (fleet only — public node signals don't affect this)
  var fleetSignals = signals.filter(function(s) { return s.type !== "public_node_offline" && s.type !== "public_network_block"; });
  if (fleetSignals.length === 0) {
    signals.unshift({ type: "all_healthy", severity: "info", nodes: [], value: onlineNodes.length, message: "All public nodes healthy, network in sync, no issues detected" });
  }

  return signals;
}

function loadIncidentCounter() {
  try {
    var row = sharedDb.prepare("SELECT id FROM incidents ORDER BY rowid DESC LIMIT 1").get();
    if (row && row.id) {
      var num = parseInt(row.id.replace("INC-", ""), 10);
      if (!isNaN(num)) incidentCounter = num;
    }
  } catch(e) {}
}

// --- Uptime & daily summary tracking ---
let cycleCount = 0;
let lastPublishAt = null;
let uptimeStats = {}; // { "n1": { healthy: 0, total: 0 }, ... }
for (var _n of NODE_NAMES) uptimeStats[_n] = { healthy: 0, total: 0 };
let publicRpcStats = {}; // { "discus": { reachable: 0, total: 0, totalLatency: 0 }, ... }
for (var _r of CROSS_VALIDATION_RPCS) publicRpcStats[_r.name] = { reachable: 0, total: 0, totalLatency: 0 };
let dailyAlertCount = 0;
let dailyRecoveryCount = 0;
let dailyBlockStart = null;
let dailySummaryCounter = 0;

// FIX BUG 7: Track when last cycle ran
let lastCycleAt = 0; // start of the latest fleet cycle (fleet/SDK side only)
// Public observation clock: set when a round of Path A probes completes. staleness_seconds, last_updated,
// observed_at and Last-Modified are measured from here, never from the start of the fleet cycle.
let lastPublicObservedAt = 0;
const AGENT_STARTED_AT = Date.now();
// Height movement, over the readings the clock follows (clockResults: the seeds, or the counted validators when no seed
// gave a height). maxHeight is the highest of them in the latest round (null when there was none); advancedAt is the last round that showed a new height: one above the node's own last answer and above every
// node's last answer within the window. A leading seed that stops answering is not mistaken for a stalled chain, and
// a lagging seed catching up is not mistaken for a new height.
// compared: DNO has compared heights across rounds (or history shows a static run), so height_static_seconds can be
// published; advanceKnown: the last advance was observed (or bounded by history), so height_last_advanced_at can be.
// lastBySeed: each seed's last answer { h, at }.
var heightTracker = { maxHeight: null, advancedAt: null, initialized: false, lastBySeed: {}, compared: false, advanceKnown: false };
const HEIGHT_WINDOW_MS = 10 * 60000;   // a height nobody has reported for this long is forgotten (a chain restarted lower is followed again)
// Public history rows older than this were not written under the own-height rule (1.0 read a seed's first listed peer),
// or are older than a row that was not. Median-based figures (the height clock at start-up, 24 h chain movement) do not
// use them.
var OWN_HEIGHT_SINCE = 0;
// Which rule wrote a row is on the row: this version writes own_height = 1. An older agent's INSERT names its columns
// and leaves it empty, also when it runs again after a rollback, so the start is read from the rows at every start:
// just after the newest row without the mark, or 0 when every row has it. (A stored stamp goes stale across a rollback.)
function ownHeightSince(db) {
  try { db.run("ALTER TABLE public_node_history ADD COLUMN own_height INTEGER"); } catch (e) { /* column exists */ }
  var row = db.query("SELECT ts FROM public_node_history WHERE own_height IS NULL ORDER BY ts DESC LIMIT 1").get();
  return row ? row.ts + 1 : 0;
}

// A public observation older than this many whole seconds is stale: the reading is then unknown (computeCanonicalState),
// and the observation-based ETag changes (observationValidators). One constant, so the two cannot disagree.
const PUBLIC_STALE_AFTER_SECONDS = 300;
// FIX BUG 7: staleness helper — hoisted to module scope (reachable by serializer and bot)
function getStaleness() {
  if (!lastPublicObservedAt) return { lastCycleAt: null, stalenessSeconds: null };
  return { lastCycleAt: lastPublicObservedAt, stalenessSeconds: Math.round((Date.now() - lastPublicObservedAt) / 1000) };
}

function expectedConnStr(name) {
  var n = EXPECTED_FLEET[name];
  return "http://" + n.host + ":" + n.port;
}


// FIX BUG 6: Shared write budget check
function canPublish() {
  var now = Date.now();
  // Prune old timestamps
  publishTimestamps = publishTimestamps.filter(function(t) { return t > now - 86400000; });
  var hourlyCount = publishTimestamps.filter(function(t) { return t > now - 3600000; }).length;
  var dailyCount = publishTimestamps.length;
  return { ok: hourlyCount < HOURLY_PUBLISH_LIMIT && dailyCount < DAILY_PUBLISH_LIMIT, hourly: hourlyCount, daily: dailyCount };
}

async function promQuery(query) {
  try {
    var url = PROMETHEUS_URL + "/api/v1/query?query=" + encodeURIComponent(query);
    var res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    var json = await res.json();
    if (json.status !== "success") return null;
    return json.data.result;
  } catch(e) { return null; }
}

function promToMap(results, labelKey) {
  if (!results) return {};
  var map = {};
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var key = r.metric[labelKey || "node"] || "unknown";
    map[key] = parseFloat(r.value[1]);
  }
  return map;
}

async function fetchInfo(url) {
  try {
    var start = Date.now();
    var res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    var latencyMs = Date.now() - start;
    if (!res.ok) return { ok: false, error: "HTTP " + res.status, latencyMs: latencyMs };
    var data = await res.json();
    return { ok: true, data: data, latencyMs: latencyMs };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "Timeout" : err.message, latencyMs: null };
  }
}

async function perceive() {
  log("Health check cycle starting...");

  var [localInfoResult, secsSinceBlockData, tpsData, mempoolData, fleetUpData] = await Promise.all([
    fetchInfo(LOCAL_INFO_URL),
    promQuery("demos_seconds_since_last_block"),
    promQuery("demos_tps"),
    promQuery("demos_mempool_size"),
    promQuery('up{job="fleet-node-exporter"}'),
  ]);

  var secsSinceBlock = promToMap(secsSinceBlockData);
  var tps = promToMap(tpsData);
  var mempool = promToMap(mempoolData);

  var fleetUp = {};
  if (fleetUpData) {
    for (var i = 0; i < fleetUpData.length; i++) {
      var r = fleetUpData[i];
      if (r.metric.node) fleetUp[r.metric.node] = parseFloat(r.value[1]) === 1;
    }
  }

  if (!localInfoResult.ok) {
    log("  LOCAL /info FAILED: " + localInfoResult.error);
    return {
      skip: false, type: "ALERT",
      nodeReports: [{ name: LOCAL_NODE_NAME, status: "UNHEALTHY", issues: ["LOCAL_INFO_UNREACHABLE"] }],
      chain: { block: null, onlineCount: 0, readyCount: 0, syncedCount: 0, tps: null },
      problems: [{ name: LOCAL_NODE_NAME, issues: ["LOCAL_INFO_UNREACHABLE"] }],
    };
  }

  var info = localInfoResult.data;
  log("  " + LOCAL_NODE_NAME + " /info OK (" + localInfoResult.latencyMs + "ms) version " + info.version + " " + info.version_name);
  nodeVersions[LOCAL_NODE_NAME] = { version: info.version || null, versionName: info.version_name || null };

  var localIdentityOk = info.identity === EXPECTED_FLEET[LOCAL_NODE_NAME].identity;

  var peerByConn = {};
  for (var j = 0; j < (info.peerlist || []).length; j++) {
    var peer = info.peerlist[j];
    if (peer.connection && peer.connection.string) peerByConn[peer.connection.string] = peer;
  }

  var problems = [];
  var nodeReports = [];
  var blockHeights = {};

  // ---------------------------------------------------------------------------
  // TRI-STATE CONTRACT for nodeReports fields (online, ready, syncOk, identityMatch):
  //   true  = compared/observed and confirmed-good
  //   false = compared/observed and confirmed-bad
  //   null  = unknown / could not determine (e.g., NOT_IN_PEERLIST, LOCAL_INFO_UNREACHABLE)
  // INVARIANT: consumers must NEVER alarm on unknown (null). Only confirmed-false may emit a signal.
  // See generateSignals() (~line 940). Bug history: identity_mismatch false-positives, fix 2026-04-28.
  // ---------------------------------------------------------------------------
  for (var ni = 0; ni < NODE_NAMES.length; ni++) {
    var name = NODE_NAMES[ni];
    var expected = EXPECTED_FLEET[name];
    var connStr = expectedConnStr(name);
    var issues = [];
    var blockHeight = null;
    var syncOk = null;
    var online = null;
    var ready = null;
    var identityMatch = null;

    if (name === LOCAL_NODE_NAME) {
      identityMatch = localIdentityOk;
      online = true;
      ready = true;
      var firstPeer = info.peerlist && info.peerlist[0];
      blockHeight = firstPeer && firstPeer.sync ? firstPeer.sync.block : null;
      syncOk = firstPeer && firstPeer.sync ? firstPeer.sync.status : null;
      if (syncOk === false) issues.push("NOT_SYNCED");
      if (!identityMatch) issues.push("IDENTITY_MISMATCH");
    } else {
      var peerData = peerByConn[connStr];
      if (!peerData) {
        peerData = (info.peerlist || []).find(function(p) { return p.identity === expected.identity; });
      }

      if (!peerData) {
        issues.push("NOT_IN_PEERLIST");
        online = false;
      } else {
        identityMatch = peerData.identity === expected.identity;
        if (!identityMatch) issues.push("IDENTITY_MISMATCH");

        online = peerData.status ? peerData.status.online : false;
        if (!online) issues.push("OFFLINE");

        ready = peerData.status ? peerData.status.ready : false;
        if (online && !ready) issues.push("NOT_READY");

        syncOk = peerData.sync ? peerData.sync.status : false;
        blockHeight = peerData.sync ? peerData.sync.block : null;
        if (!syncOk) issues.push("NOT_SYNCED");
      }
    }

    if (blockHeight != null) blockHeights[name] = blockHeight;
    if (fleetUp[name] === false) issues.push("EXPORTER_DOWN");

    var status = issues.length > 0 ? "UNHEALTHY" : "HEALTHY";
    nodeReports.push({ name: name, status: status, issues: issues, blockHeight: blockHeight, online: online, ready: ready, syncOk: syncOk, identityMatch: identityMatch });
    if (issues.length > 0) problems.push({ name: name, issues: issues.slice() });

    var icon = status === "HEALTHY" ? "OK" : "!!";
    var blk = blockHeight != null ? blockHeight : "?";
    var onl = online ? "online" : "OFFLINE";
    var rdy = ready ? "ready" : "!READY";
    var syn = syncOk ? "synced" : "!SYNC";
    var idOk = identityMatch === true ? "id-ok" : identityMatch === false ? "id-FAIL" : "id?";
    var expStr = fleetUp[name] != null ? (fleetUp[name] ? "exp=UP" : "exp=DOWN") : "";
    var issueStr = issues.length > 0 ? " << [" + issues.join(", ") + "]" : "";
    log("  " + icon + " " + name + "(" + expected.side + "): block=" + blk + " " + onl + " " + rdy + " " + syn + " " + idOk + " " + expStr + issueStr);
  }

  var heights = Object.values(blockHeights);
  var highestBlock = heights.length > 0 ? Math.max.apply(null, heights) : null;

  if (highestBlock != null) {
    for (var li = 0; li < NODE_NAMES.length; li++) {
      var lname = NODE_NAMES[li];
      if (blockHeights[lname] != null) {
        var lag = highestBlock - blockHeights[lname];
        if (lag >= BLOCK_LAG_THRESHOLD) {
          var report = nodeReports.find(function(r) { return r.name === lname; });
          var issue = "BLOCK_LAG(" + lag + " behind)";
          report.issues.push(issue);
          report.status = "UNHEALTHY";
          var existing = problems.find(function(p) { return p.name === lname; });
          if (existing) existing.issues.push(issue);
          else problems.push({ name: lname, issues: [issue] });
          log("  !! " + lname + ": " + issue);
        }
      }
    }
  }

  var n3Stale = secsSinceBlock.n3 != null ? secsSinceBlock.n3 : null;
  if (n3Stale != null && n3Stale > STALE_SECONDS_THRESHOLD && n3Stale < 3600) {
    if (cycleCount > 1) problems.push({ name: "CHAIN", issues: ["STALE(" + Math.round(n3Stale) + "s since last block)"] });
    log("  !! CHAIN: stale " + Math.round(n3Stale) + "s since last block");
  }

  if (highestBlock != null && previousState.lastBlockHeight != null) {
    if (highestBlock <= previousState.lastBlockHeight) {
      if (cycleCount > 2) problems.push({ name: "CHAIN", issues: ["BLOCK_STALL(no new blocks since last cycle)"] });
      log("  !! CHAIN: block height unchanged since last cycle");
    }
  }
  if (highestBlock != null) previousState.lastBlockHeight = highestBlock;

  var n3Tps = tps.n3 != null ? tps.n3 : null;
  var n3Mempool = mempool.n3 != null ? mempool.n3 : null;
  var onlineCount = nodeReports.filter(function(r) { return r.online; }).length;
  var readyCount = nodeReports.filter(function(r) { return r.ready; }).length;
  var syncedCount = nodeReports.filter(function(r) { return r.syncOk; }).length;

  log("  Fleet: " + onlineCount + "/" + FLEET_SIZE + " online, " + readyCount + " ready, " + syncedCount + " synced");
  log("  Chain: block=" + (highestBlock != null ? highestBlock : "?") + " stale=" + (n3Stale != null ? n3Stale : "?") + "s tps=" + (n3Tps != null ? n3Tps : "?") + " mempool=" + (n3Mempool != null ? n3Mempool : "?"));
  log("  Problems: " + problems.length);

  if (problems.length === 0) {
    previousState.consecutiveHealthy++;
    log("  All healthy (" + previousState.consecutiveHealthy + " consecutive). Skipping post.");

    if (previousState.consecutiveHealthy >= HEARTBEAT_CYCLES) {
      previousState.consecutiveHealthy = 0;
      return {
        skip: false, type: "HEARTBEAT", nodeReports: nodeReports,
        chain: { block: highestBlock, onlineCount: onlineCount, readyCount: readyCount, syncedCount: syncedCount, tps: n3Tps },
        problems: [], rawPeerlist: info.peerlist || [],
      };
    }
    return { skip: true, reason: "All nodes healthy", nodeReports: nodeReports, chain: { block: highestBlock, onlineCount: onlineCount, readyCount: readyCount, syncedCount: syncedCount, tps: n3Tps }, rawPeerlist: info.peerlist || [] };
  }

  previousState.consecutiveHealthy = 0;
  return {
    skip: false, type: "ALERT", nodeReports: nodeReports,
    chain: { block: highestBlock, onlineCount: onlineCount, readyCount: readyCount, syncedCount: syncedCount, tps: n3Tps },
    problems: problems,
  };
}

function composeAlert(data) {
  if (data.type === "HEARTBEAT") {
    return {
      cat: "OBSERVATION",
      text: "Fleet heartbeat: " + data.chain.onlineCount + "/" + FLEET_SIZE + " online, all synced at block " + (data.chain.block != null ? data.chain.block : "?") + ". TPS " + (data.chain.tps != null ? data.chain.tps : "0") + ".",
      confidence: 95,
    };
  }

  var offline = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "OFFLINE"; }); });
  var unpeered = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "NOT_IN_PEERLIST"; }); });
  var notSynced = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "NOT_SYNCED"; }); });
  var blockLag = data.problems.filter(function(p) { return p.issues.some(function(i) { return i.indexOf("BLOCK_LAG") === 0; }); });
  var notReady = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "NOT_READY"; }); });
  var idMismatch = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "IDENTITY_MISMATCH"; }); });
  var chainIssues = data.problems.filter(function(p) { return p.name === "CHAIN"; });
  var expDown = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "EXPORTER_DOWN"; }); });

  var parts = [];
  if (offline.length > 0) parts.push("OFFLINE: " + offline.map(function(p) { return p.name; }).join(","));
  if (unpeered.length > 0) parts.push("UNPEERED: " + unpeered.map(function(p) { return p.name; }).join(","));
  if (notSynced.length > 0) parts.push("UNSYNC: " + notSynced.map(function(p) { return p.name; }).join(","));
  if (blockLag.length > 0) parts.push("LAG: " + blockLag.map(function(p) { return p.name; }).join(","));
  if (notReady.length > 0) parts.push("!READY: " + notReady.map(function(p) { return p.name; }).join(","));
  if (idMismatch.length > 0) parts.push("ID_MISMATCH: " + idMismatch.map(function(p) { return p.name; }).join(","));
  if (chainIssues.length > 0) parts.push(chainIssues.map(function(p) { return p.issues.join(","); }).join(","));
  if (expDown.length > 0) parts.push("EXP: " + expDown.map(function(p) { return p.name; }).join(","));

  var healthy = data.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length;

  var text = "Fleet Alert [" + healthy + "/" + FLEET_SIZE + " healthy]: " + parts.join(" | ") + ". Block " + (data.chain.block != null ? data.chain.block : "?") + ".";
  if (text.length > 280) text = text.substring(0, 277) + "...";

  var severity = offline.length > 0 || chainIssues.length > 0 ? 95 : 70;
  return { cat: "ALERT", text: text, confidence: severity };
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      var url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
      var res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        log("Telegram notification sent.");
        return;
      }
      var body = await res.text();
      logError("Telegram attempt " + attempt + "/" + MAX_RETRIES + " failed: HTTP " + res.status + " " + body);
    } catch (err) {
      logError("Telegram attempt " + attempt + "/" + MAX_RETRIES + " error: " + err.message);
    }
    if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
  }
  logError("Telegram: all " + MAX_RETRIES + " attempts failed. Giving up.");
}

async function publish(demos, post, attestations) {
  if (!SUPERCOLONY_ENABLED) {
    return false;
  }
  // Role-authority guard: an invalid INSTANCE_ROLE must never publish (prevents silent validator->primary degradation).
  if (!INSTANCE_ROLE_CAN_PUBLISH) {
    logError("Publish BLOCKED by invalid INSTANCE_ROLE raw=" + JSON.stringify(INSTANCE_ROLE_CONFIG.raw) + " normalized=" + JSON.stringify(INSTANCE_ROLE_CONFIG.normalized) + " effective=" + INSTANCE_ROLE_CONFIG.effective + ": " + post.text.substring(0, 80));
    return false;
  }
  // FIX BUG 6: Check shared write budget before publishing
  var budget = canPublish();
  if (!budget.ok) {
    logError("Publish BLOCKED by write budget (hourly=" + budget.hourly + "/" + HOURLY_PUBLISH_LIMIT + " daily=" + budget.daily + "/" + DAILY_PUBLISH_LIMIT + "): " + post.text.substring(0, 80));
    return false;
  }
  if (INSTANCE_ROLE === "validator") {
    var primaryStatus = await checkPrimaryOracle();
    if (!primaryStatus.silent) {
      log("  [validator] Primary oracle active — suppressing publish");
      return false;
    }
    log("  [validator] Primary oracle SILENT for " + primarySilentCycles + " cycles — taking over publishing");
  }

  var postData = {
    cat: post.cat, text: post.text, assets: ["DEM"], confidence: post.confidence,
    tags: ["node-health", "infrastructure", "monitoring"],
    metadata: { agent: "supercolony-node-health", fleet_size: FLEET_SIZE, timestamp: Date.now() },
  };

  // Include DAHR attestations if available
  if (attestations && attestations.length > 0) {
    postData.sourceAttestations = attestations;
    log("  Including " + attestations.length + " DAHR attestation(s) in post.");
  }

  var payload = JSON.stringify({
    protocol: "HIVE", version: "1.0", type: "POST",
    data: postData,
  });

  for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      var result = await withTimeout(demos.store(payload), 20000, "store");
      // FIX BUG 4: Extract and return the actual tx hash
      var txHash = (result && result.hash) ? result.hash : null;
      lastPublishAt = Date.now();
      log("Published " + post.cat + ": " + post.text);
      log("TX: " + (txHash || "confirmed"));

      // FIX BUG 6: Record publish timestamp for budget tracking
      publishTimestamps.push(Date.now());

      // Send Telegram notification for ALERTs, recoveries, and heartbeats
      if (post.cat === "ALERT") {
        await sendTelegram("🚨 <b>FLEET ALERT</b>\n" + post.text);
      } else if (post.cat === "OBSERVATION" && post.text.indexOf("Recovery") === 0) {
        await sendTelegram("✅ <b>RECOVERY</b>\n" + post.text);
      } else if (post.cat === "OBSERVATION" && post.text.indexOf("Fleet heartbeat") === 0) {
        await sendTelegram("💚 <b>HEARTBEAT</b>\n" + post.text);
      }

      // FIX BUG 4: Return the hash string (truthy), or "confirmed" if SDK didn't provide one
      return txHash || "confirmed";
    } catch (err) {
      logError("Publish attempt " + attempt + "/" + MAX_RETRIES + " failed: " + err.message);
      if (attempt < MAX_RETRIES) {
        log("Retrying publish in " + (RETRY_DELAY_MS / 1000) + "s...");
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  // RPC failover: try alternative RPCs before giving up
  var fallbackList = FALLBACK_RPCS.filter(function(u) { return u !== activeRpcUrl; });
  for (var fi = 0; fi < fallbackList.length; fi++) {
    try {
      log("  RPC failover: trying " + fallbackList[fi]);
      await withTimeout(demos.connect(fallbackList[fi]), 20000, "RPC connect");
      var fbResult = await withTimeout(demos.store(payload), 20000, "store");
      var fbHash = (fbResult && fbResult.hash) ? fbResult.hash : null;
      lastPublishAt = Date.now();
      publishTimestamps.push(Date.now());
      activeRpcUrl = fallbackList[fi];
      log("  RPC failover SUCCESS via " + fallbackList[fi] + " TX: " + (fbHash || "confirmed"));
      if (post.cat === "ALERT") await sendTelegram("ð¨ <b>FLEET ALERT</b> (via RPC failover)\n" + post.text);
      else if (post.cat === "OBSERVATION" && post.text.indexOf("Recovery") === 0) await sendTelegram("â <b>RECOVERY</b>\n" + post.text);
      return fbHash || "confirmed";
    } catch (ferr) {
      logError("  RPC failover " + fallbackList[fi] + " failed: " + ferr.message);
      try { await withTimeout(demos.connect(activeRpcUrl), 20000, "RPC connect"); } catch(re) {}
    }
  }

  logError("Publish: all " + MAX_RETRIES + " attempts failed. Post lost: " + post.text);
  // Still try to notify via Telegram that publishing failed
  if (post.cat === "ALERT") {
    await sendTelegram("⚠️ <b>PUBLISH FAILED</b>\nCould not post alert on-chain after " + MAX_RETRIES + " attempts.\n" + post.text);
  }
  return false;
}

// --- DAHR Attestation ---
let dahrAvailable = null; // null = not yet checked, true/false after first attempt

async function dahrAttest(demos, url, method) {
  // Check if DAHR is available on this SDK version
  if (dahrAvailable === false) return null;

  // D40 Option B: standby validators skip DAHR attestation while the primary Oracle is alive.
  // No-op on primary (INSTANCE_ROLE !== "validator"). Standbys take over attestation only on failover.
  if (INSTANCE_ROLE === "validator") {
    var ps = await checkPrimaryOracle();
    if (!ps.silent) return null;
  }

  try {
    if (!demos.web2 || typeof demos.web2.createDahr !== "function") {
      if (dahrAvailable === null) {
        log("  DAHR: demos.web2.createDahr not available in this SDK version. Skipping attestations.");
        dahrAvailable = false;
      }
      return null;
    }

    var dahr = await withTimeout(demos.web2.createDahr(), 20000, "DAHR create");
    var result = await withTimeout(dahr.startProxy({ url: url, method: method || "GET" }), 30000, "DAHR proxy");

    // SDK 4.x returns the proxied response fields plus txHash: { status, responseHash, responseHeadersHash,
    // requestHash?, statusText, headers, txHash }. Without a transaction hash nothing was attested.
    var txHash = result && typeof result.txHash === "string" && result.txHash ? result.txHash : null;
    if (!txHash) {
      log("  DAHR: no transaction hash returned; not counted as an attestation.");
      return null;
    }
    if (dahrAvailable !== true) {
      log("  DAHR: attestation available and working. tx=" + txHash.substring(0, 12) + "...");
      dahrAvailable = true;
    }

    return {
      url: url,
      txHash: txHash,
      responseHash: typeof result.responseHash === "string" ? result.responseHash : null,
      status: Number.isInteger(result.status) ? result.status : null,
      timestamp: Date.now(),
    };
  } catch (err) {
    if (dahrAvailable === null) {
      log("  DAHR: attestation failed (" + err.message + "). Will retry next cycle.");
    } else {
      log("  DAHR: attestation error: " + err.message);
    }
    return null;
  }
}

async function probePublicRPCs(demos) {
  var results = [];
  var attestations = [];
  for (var i = 0; i < CROSS_VALIDATION_RPCS.length; i++) {
    var rpc = CROSS_VALIDATION_RPCS[i];
    publicRpcStats[rpc.name].total++;
    try {
      // Configured URLs, but answers from hosts DNO does not run: one capped read (decoded size), like the seeds'.
      var res = await cappedJson(rpc.url, null, { timeoutMs: PUBLIC_PROBE_TIMEOUT_MS, maxBytes: INFO_BODY_MAX_BYTES });
      var latencyMs = res.headersMs;
      if (res.ok) {
        var data = res.data;
        publicRpcStats[rpc.name].reachable++;
        publicRpcStats[rpc.name].totalLatency += latencyMs;
        var block = null;
        // Try to extract block height from /info response
        if (data.peerlist && data.peerlist[0] && data.peerlist[0].sync) {
          block = data.peerlist[0].sync.block;
        }
        var peerCount = data.peerlist ? data.peerlist.length : 0;
        results.push({ name: rpc.name, ok: true, latencyMs: latencyMs, block: block, peers: peerCount, version: data.version || "?" });
        log("  Public RPC " + rpc.name + ": OK " + latencyMs + "ms block=" + (block || "?") + " peers=" + peerCount);

        // Attempt DAHR attestation for this public RPC
        var att = await dahrAttest(demos, rpc.url, "GET");
        if (att) {
          attestations.push(att);
          log("  DAHR: attested " + rpc.name);
        }
      } else {
        results.push({ name: rpc.name, ok: false, error: "HTTP " + res.status, latencyMs: latencyMs });
        log("  Public RPC " + rpc.name + ": FAIL HTTP " + res.status);
      }
    } catch (err) {
      results.push({ name: rpc.name, ok: false, error: err.name === "TimeoutError" ? "Timeout" : err.message, latencyMs: null });
      log("  Public RPC " + rpc.name + ": FAIL " + (err.name === "TimeoutError" ? "Timeout" : err.message));
    }
  }
  return { results: results, attestations: attestations };
}

async function probePublicNodes() {
  // All seeds are dialed in parallel (5 s timeout each), so one slow seed cannot delay the others.
  var names = Object.keys(PUBLIC_NODES);
  var results = await Promise.all(names.map(async function(name) {
    var node = PUBLIC_NODES[name];
    var base = { name: name, identity: node.identity, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" };
    // readSeedInfo (seed-read.mjs) makes the read and reads the answer: the runtime's fetch (the Demos SDK replaces the
    // global one), the body cap, redirects refused, the request stopped when the read ends; a seed's height is its own
    // peerlist entry. The pre-restart check calls the same function. It never throws.
    var r = await readSeedInfo(node, { timeoutMs: 5000, maxBytes: INFO_BODY_MAX_BYTES });
    if (!r.ok) {
      log("  PublicNode " + name + ": FAIL " + r.error);
      return Object.assign(base, { ok: false, error: r.error });
    }
    // The peerlist counts as the answering node's peerlist for the two-peerlist rule (one node answering two URLs is one).
    catalogIngestPeerlist(r.answeredId || ("seed:" + name), r.peerlist);
    log("  PublicNode " + name + ": OK " + r.latencyMs + "ms block=" + (r.block === null ? "?" : r.block) + " (" + (r.height_source || "none") + ") peers=" + r.peers);
    return Object.assign(base, { ok: true, latencyMs: r.latencyMs, block: r.block, height_source: r.height_source, version: r.version, peers: r.peers, identityMatch: r.identityMatch });
  }));
  return results;
}

// Per round: the highest height a seed reported, and whether the round showed a new height. On the first round with a
// height the clock starts from retained public history, so a restart during a stall does not reset it.
function updateHeightTracker(results, observedAt) {
  var seen = {};
  (results || []).forEach(function(r) { var h = ownHeight(r); if (h !== null) seen[r.name] = h; });
  var names = Object.keys(seen);
  if (!names.length) { heightTracker.maxHeight = null; return; }
  var hs = names.map(function(n) { return seen[n]; }).sort(function(a, b) { return a - b; });
  var maxH = hs[hs.length - 1], medH = hs[Math.floor(hs.length / 2)];
  // A new height: above the node's own last answer, however old, and above the last answer of every node that
  // answered within the window. A node that reports more than before while another already reported that much is
  // catching up: no advance. Nor is a node back at the height it left on, or back at the height the others stand on.
  var last = heightTracker.lastBySeed, recentMax = null;
  for (var k in last) if (observedAt - last[k].at <= HEIGHT_WINDOW_MS && (recentMax === null || last[k].h > recentMax)) recentMax = last[k].h;
  var comparedNow = false, rose = false;
  names.forEach(function(n) {
    var prev = last[n], ref = recentMax;
    if (prev && (ref === null || prev.h > ref)) ref = prev.h;
    if (ref !== null) { comparedNow = true; if (seen[n] > ref) rose = true; }
  });
  heightTracker.maxHeight = maxH;
  names.forEach(function(n) { last[n] = { h: seen[n], at: observedAt }; });
  if (!heightTracker.initialized) {
    // First round with a height after a start: nothing compared yet. Retained history can extend a static run back
    // past a restart: the median has stayed at exactly this round's median since the earliest of the most recent
    // consecutive rows at that median; a lower row before that run bounds when the last advance happened. A higher
    // median (a chain reset, or lagging seeds now in the middle) says nothing about this height, so nothing is claimed
    // until the next round compares.
    heightTracker.initialized = true;
    heightTracker.advancedAt = observedAt;
    if (sharedDb) {
      try {
        var rows = sharedDb.query("SELECT ts, median_block FROM public_node_history WHERE median_block IS NOT NULL AND ts < ? AND ts >= ? ORDER BY ts DESC LIMIT 2000").all(observedAt, OWN_HEIGHT_SINCE);
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].median_block === medH) { heightTracker.advancedAt = rows[i].ts; heightTracker.compared = true; continue; }
          if (rows[i].median_block < medH && heightTracker.compared) heightTracker.advanceKnown = true;
          break;
        }
      } catch (e) {}
    }
    return;
  }
  if (comparedNow) heightTracker.compared = true;
  if (rose) { heightTracker.advancedAt = observedAt; heightTracker.advanceKnown = true; }
}

// Published height movement, derived from heightTracker: seconds without an advance (null before any comparison or
// when this observation returned no height), when the last observed advance happened, and the two status_reason
// phrases ("Heights advancing" within the last two rounds; "height unchanged" past the static threshold). Status
// itself changes only at RULE.standstillSeconds (status-rule.mjs).
function heightMovement(observedAtMs, anyHeight) {
  var t = heightTracker;
  var staticSeconds = t.compared && t.advancedAt && observedAtMs && anyHeight ? Math.max(0, Math.round((observedAtMs - t.advancedAt) / 1000)) : null;
  return {
    staticSeconds: staticSeconds,
    advancedAtIso: t.advanceKnown && t.advancedAt ? new Date(t.advancedAt).toISOString() : null,
    // Since when no new height was seen, to the minute (UTC): the last observed advance, or without one the first
    // round that showed the height now standing. A condition record opens with it.
    staticSince: staticSeconds !== null ? new Date(t.advancedAt).toISOString().slice(0, 16).replace("T", " ") : null,
    advancing: staticSeconds !== null && t.advanceKnown && staticSeconds <= 2 * Math.round(MONITOR_INTERVAL_MS / 1000),
    stalled: staticSeconds !== null && staticSeconds >= CHAIN_STATIC_RUN_MIN_24H * 60
  };
}

// Public observation round: Path A seeds, catalog crawl, public history and public incidents. Runs on its own
// loop, before the wallet connects and independent of the fleet/SDK cycle, so neither can delay it.
async function publicObservationCycle() {
  catalogBeginCrawl();
  var publicNodeResults = await probePublicNodes();
  // Fewer than two seeds gave their own height: the validator candidates are read in this same round, so their
  // heights are as old as the seeds'. The seeds, the witnesses and the observation time change together: one
  // observation, one ETag.
  var roundWitnesses = await readRoundWitnesses(publicNodeResults);
  latestPublicNodes = publicNodeResults;
  latestWitnesses = roundWitnesses;
  lastPublicObservedAt = Date.now();
  catalogFinishCrawl(publicNodeResults, lastPublicObservedAt);
  updateHeightTracker(clockResults(publicNodeResults, roundWitnesses), lastPublicObservedAt);
  recordPublicNodeHistory();
  recordObservationHistory();
  evaluatePublicIncidents();
  refreshValidatorUptimeCache();
}
function startPublicObservationLoop() {
  async function tick() {
    var started = Date.now();
    try { await publicObservationCycle(); }
    catch (err) { logError("[public] observation round failed: " + (err && err.message ? err.message : String(err))); }
    setTimeout(tick, Math.max(1000, MONITOR_INTERVAL_MS - (Date.now() - started)));
  }
  tick();
}

// --- On-chain validators: the read (Path A seeds) and the watch (Path B) ------------------------------------------------
// Each round sends getValidators and getNetworkParameters to the configured seeds, then dials GET /info once at the
// address each ACTIVE validator published on chain, when that address is a public http origin (src/validator-watch.mjs).
// /health publishes counts only. VALIDATOR_WATCH_DIALS=0 keeps the read and stops the dials.
// While two seeds give their own height neither enters status. The watch's counted rounds name the witness candidates
// (readRoundWitnesses below): validators the public round reads when fewer than two seeds gave a height.
function envMs(name, def, min) { var n = parseInt(process.env[name] || "", 10); return Number.isFinite(n) ? Math.max(min, n) : def; }
const VALIDATOR_WATCH_INTERVAL_MS = envMs("VALIDATOR_WATCH_INTERVAL_MS", 60000, 5000);
const VALIDATOR_WATCH_WINDOW_MS = envMs("VALIDATOR_WATCH_WINDOW_MS", 3600000, 60000);
const VALIDATOR_WATCH_DIALS = dialsEnabled(process.env.VALIDATOR_WATCH_DIALS);   // 0, false, off or no stop the dials (validator-watch.mjs)
var VALIDATOR_ORIGIN_RESOLVER = resolvePublicProbeOrigin;
var validatorHistory = createWatchHistory(VALIDATOR_WATCH_WINDOW_MS, VALIDATOR_WATCH_INTERVAL_MS);
// First agreed ACTIVE keys, on the host's UTC clock, in the shared observation database (opened in main()).
var validatorFirstAgreed = null;
// The configured seed keys, to count how many validators that answered as themselves are Path A seeds (an overlap count).
const SEED_KEYS = new Set(Object.keys(PUBLIC_NODES).map(function(n) { return keyOf(PUBLIC_NODES[n].identity); }).filter(Boolean));
var latestValidatorRound = null;
// Validators that can stand in for a seed that gave no height (witnesses.mjs). The candidates come from the watch's
// last counted round and are kept in the store. latestWitnesses is one public round's reads of them, set together with
// latestPublicNodes and the observation time, or null when none were read: two seeds gave their own height, there is
// no candidate, or the dials are off (VALIDATOR_WATCH_DIALS=0 stops these reads too).
var witnessCandidates = null;
let latestWitnesses = null;
async function readRoundWitnesses(publicNodeResults) {
  if (!VALIDATOR_WATCH_DIALS || !witnessCandidates) return null;
  if (publicNodeResults.filter(function(n) { return ownHeight(n) !== null; }).length >= 2) return null;
  var kept = witnessCandidates.load(Date.now());
  if (!kept.candidates.length) return null;
  var snap = witnessSnapshot(await readWitnesses(kept.candidates, { resolveOrigin: VALIDATOR_ORIGIN_RESOLVER, maxBytes: INFO_BODY_MAX_BYTES }), kept.agreedAt);
  log("  Witnesses: " + snap.read + " validator" + (snap.read === 1 ? "" : "s") + " read, " + snap.rows.length + " answered as listed with a height");
  return snap;
}
// The round's witness reads as the status rule takes them (assess in status-rule.mjs), or null.
function witnessInput() {
  var w = latestWitnesses;
  return w ? { read: w.read, heights: w.rows.map(function(r) { return r.height; }), listAgreedAt: w.listAgreedAt ? new Date(w.listAgreedAt).toISOString() : null } : null;
}
// The readings the height clock follows this round (clockReadings in status-rule.mjs), as updateHeightTracker reads
// them: the seeds' while a seed gave its own height, else the validators counted in the reading.
function clockResults(publicNodeResults, witnesses) {
  var seeds = publicNodeResults.map(function(n) { return { id: n.name, h: ownHeight(n) }; });
  var validators = witnesses ? witnesses.rows.map(function(r) { return { id: "validator:" + r.key, h: r.height }; }) : null;
  return clockReadings(seeds, validators).map(function(r) { return { name: r.id, ok: true, block: r.h, height_source: "self" }; });
}
function validatorPublishConfig() {
  return { seedsConfigured: Object.keys(PUBLIC_NODES).length, intervalMs: VALIDATOR_WATCH_INTERVAL_MS, windowMs: VALIDATOR_WATCH_WINDOW_MS, dials: VALIDATOR_WATCH_DIALS };
}
// The seeds' median from the latest public observation, by the rule status uses: the own heights of answering seeds,
// at least two of them, from an observation at most 300 s old (the data-quality bound). null otherwise (heights are then
// not compared).
function seedMedianReference() {
  if (!lastPublicObservedAt || Date.now() - lastPublicObservedAt > 300000) return null;
  var hs = (latestPublicNodes || []).map(ownHeight).filter(function(h) { return h !== null; }).sort(function(a, b) { return a - b; });
  return hs.length >= 2 ? { height: hs[Math.floor(hs.length / 2)], observedAt: lastPublicObservedAt } : null;
}
async function validatorWatchRound() {
  // A seed whose latest /info named another key is not asked: its answers would be another node's (the alias case).
  var seeds = Object.keys(PUBLIC_NODES).map(function(name) {
    var live = (latestPublicNodes || []).find(function(n) { return n.name === name; });
    return { name: name, url: PUBLIC_NODES[name].url, exclude: live && live.ok && live.identityMatch === false ? "its last /info answered with another key" : null };
  });
  latestValidatorRound = await runValidatorRound({ seeds: seeds, resolveOrigin: VALIDATOR_ORIGIN_RESOLVER, reference: seedMedianReference,
    history: validatorHistory, growth: validatorFirstAgreed, seedKeys: SEED_KEYS, dials: VALIDATOR_WATCH_DIALS, intervalMs: VALIDATOR_WATCH_INTERVAL_MS, windowMs: VALIDATOR_WATCH_WINDOW_MS });
  log("  " + roundLogLine(latestValidatorRound));
  // A counted round (an agreed list and a known seed median) renews the witness candidates; any other round leaves them.
  if (latestValidatorRound.witnessCandidates && witnessCandidates && !witnessCandidates.save(latestValidatorRound.witnessCandidates, latestValidatorRound.listAt))
    logError("[validators] the witness candidates could not be written to the store; they are kept in memory");
}
function startValidatorWatchLoop() {
  if (!validatorFirstAgreed) validatorFirstAgreed = createFirstAgreedStore(sharedDb || null);
  async function tick() {
    var started = Date.now();
    try { await validatorWatchRound(); }
    catch (err) { logError("[validators] round failed: " + (err && err.message ? err.message : String(err))); }
    setTimeout(tick, Math.max(1000, VALIDATOR_WATCH_INTERVAL_MS - (Date.now() - started)));
  }
  // The first round waits for the first public observation, which gives the seeds' median.
  setTimeout(tick, Math.min(10000, VALIDATOR_WATCH_INTERVAL_MS));
}
// One sentence for readers without JavaScript. null keeps the page's own text.
function validatorsNoJsLine() {
  var cfg = validatorPublishConfig(), now = Date.now();
  return validatorsSentence(publicOnChainValidators(latestValidatorRound, now, cfg), publicValidatorWatch(latestValidatorRound, now, cfg));
}

// Rejects when an SDK call does not settle in time; the underlying call is left to finish on its own.
function withTimeout(promise, ms, label) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function(_, reject) { timer = setTimeout(function() { reject(new Error((label || "call") + " timed out after " + ms + " ms")); }, ms); })
  ]).finally(function() { clearTimeout(timer); });
}

async function probeFixnetNodes() {
  var results = [];
  for (var name in FIXNET_NODES) {
    var node = FIXNET_NODES[name];
    try {
      var start = Date.now();
      var res = await fetch(node.url + "/info", { signal: AbortSignal.timeout(5000) });
      var latencyMs = Date.now() - start;
      if (res.ok) {
        var data = await res.json();
        // For self-reported block, find this node's own entry in its peerlist
        var block = null;
        if (data.peerlist && Array.isArray(data.peerlist)) {
          var selfEntry = data.peerlist.find(function(p) { return p.identity === node.identity; });
          if (selfEntry && selfEntry.sync) {
            block = sanitizeHeight(selfEntry.sync.block);
          } else if (data.peerlist[0] && data.peerlist[0].sync) {
            // Fallback: first peer (anchor convention)
            block = sanitizeHeight(data.peerlist[0].sync.block);
          }
        }
        var identityMatch = data.identity === node.identity;
        results.push({
          name: name,
          url: node.url,
          host: node.host,
          identity: node.identity,
          ok: true,
          latencyMs: latencyMs,
          block: block,
          version: sanitizeLabel(data.version, 32) || "?",
          peers: data.peerlist ? data.peerlist.length : 0,
          identityMatch: identityMatch,
          source_type: node.source_type,
          trust_tier: node.trust_tier,
          operator: node.operator
        });
        // v7.2: crawl anchor's peerlist for new fixnet validators
        if (node.source_type === "anchor" || node.source_type === "fleet") {
          try {
            var added = discoverFixnetValidators(data);
            if (added > 0) log("  [fixnet-discovery] +" + added + " new peer(s) from anchor");
          } catch (derr) { logError("  [fixnet-discovery] crawl failed: " + derr.message); }
        }
        log("  FixnetNode " + name + ": OK " + latencyMs + "ms block=" + (block || "?") + " peers=" + (data.peerlist ? data.peerlist.length : 0));
      } else {
        results.push({
          name: name, url: node.url, host: node.host, identity: node.identity, ok: false,
          error: "HTTP " + res.status,
          source_type: node.source_type, trust_tier: node.trust_tier, operator: node.operator
        });
        log("  FixnetNode " + name + ": FAIL HTTP " + res.status);
      }
    } catch (err) {
      results.push({
        name: name, url: node.url, host: node.host, identity: node.identity, ok: false,
        error: probeErrorCategory(err),
        source_type: node.source_type, trust_tier: node.trust_tier, operator: node.operator
      });
      log("  FixnetNode " + name + ": FAIL " + err.message);
    }
  }
  return results;
}

// --- v7.2 fixnet auto-discovery ---

// Crawl the anchor's peerlist for unknown fixnet validators.
// Called each cycle from probeFixnetNodes() after successful anchor probe.
// Inserts/upserts into fixnet_validator_discoveries table. An identity the public seeds' peerlists list is not a
// fixnet endpoint and is not kept (publicListedIdentities).
function discoverFixnetValidators(anchorInfoData) {
  if (!anchorInfoData || !anchorInfoData.peerlist || !sharedDb) return 0;
  var publicListed = publicListedIdentities();
  if (!publicListed) return 0;   // no public peerlist read yet: nothing is kept
  var added = 0;
  var now = Date.now();
  for (var i = 0; i < anchorInfoData.peerlist.length; i++) {
    var peer = anchorInfoData.peerlist[i];
    var identity = peer && peer.identity;
    if (!isValidIdentity(identity)) continue;

    // Skip known identities (monitored testnet seeds and the configured fixnet/fleet nodes), and every identity a
    // public peerlist lists
    identity = identity.toLowerCase();
    if (isExcludedFromDiscovered(identity) || FIXNET_IDENTITIES[identity] || publicListed.has(identity)) continue;

    var connection = peer.connection && peer.connection.string ? peer.connection.string : null;
    var block = sanitizeHeight(peer.sync && peer.sync.block);
    var online = peer.status && peer.status.online === true ? 1 : 0;

    try {
      var existing = sharedDb.query("SELECT identity FROM fixnet_validator_discoveries WHERE identity = ?").get(identity);
      if (!existing) {
        sharedDb.run(
          "INSERT INTO fixnet_validator_discoveries (identity, first_seen, last_seen, connection, online, last_block) VALUES (?, ?, ?, ?, ?, ?)",
          [identity, now, now, connection, online, block]
        );
        added++;
        log("  [fixnet-discovery] NEW peer " + identity.substring(0, 16) + "... via " + (connection || "?"));
      } else {
        // Update last_seen and (optionally) block/online from anchor's view
        sharedDb.run(
          "UPDATE fixnet_validator_discoveries SET last_seen = ?, online = ?, last_block = COALESCE(?, last_block), connection = COALESCE(?, connection) WHERE identity = ?",
          [now, online, block, connection, identity]
        );
      }
    } catch (e) {
      logError("  [fixnet-discovery] DB error for " + identity.substring(0, 12) + ": " + e.message);
    }
  }
  return added;
}

// Actively probe discovered fixnet nodes (rate-limited: every 3 cycles).
// Updates last_block, online, last_probed_at.
async function probeDiscoveredFixnetNodes() {
  if (!sharedDb) return [];
  var now = Date.now();
  // Rate limit: ~1 min between probes per node
  var PROBE_INTERVAL_MS = 60 * 1000;

  var rows;
  try {
    rows = sharedDb.query(
      "SELECT identity, connection, first_seen, last_seen, online, last_block, last_probed_at FROM fixnet_validator_discoveries ORDER BY last_seen DESC"
    ).all();
  } catch (e) {
    logError("  [fixnet-discovery] query failed: " + e.message);
    return [];
  }
  if (!rows || rows.length === 0) return [];
  // Rows a public peerlist lists are public-testnet identities: they are removed, not dialed and not shown. Before this
  // process has read a public peerlist it cannot tell, so nothing is dialed or shown yet.
  var publicListed = publicListedIdentities();
  if (!publicListed) return [];
  var removed = 0;
  rows = rows.filter(function(r) {
    if (!publicListed.has(String(r.identity).toLowerCase())) return true;
    try { sharedDb.run("DELETE FROM fixnet_validator_discoveries WHERE identity = ?", [r.identity]); removed++; } catch (e) {}
    return false;
  });
  if (removed > 0) log("  [fixnet-discovery] removed " + removed + " row(s) that the public peerlists list");
  if (rows.length === 0) return [];

  // Which ones are due for a probe?
  var due = rows.filter(function(r) {
    if (!r.connection) return false;
    if (!r.last_probed_at) return true; // never probed
    return (now - r.last_probed_at) >= PROBE_INTERVAL_MS;
  });

  // Probe due nodes with a bounded timeout (5 s per probe), at most 64 per cycle and 8 at a time.
  // A peer-advertised address is dialed only when it is a bare http(s) origin that resolves to public
  // addresses; anything else (loopback, private ranges, metadata addresses, paths) is never fetched.
  var probeJobs = due.slice(0, 64).map(function(r) {
    return (async function() {
      var probedAt = Date.now();
      var connUrl = await resolvePublicProbeOrigin(r.connection);
      if (!connUrl) {
        sharedDb.run("UPDATE fixnet_validator_discoveries SET last_probed_at = ?, probe_ok = NULL, last_latency_ms = NULL WHERE identity = ?", [probedAt, r.identity]);
        return { ok: false, identity: r.identity, error: "not probed: address not public" };
      }
      try {
        var fetchedAt = Date.now();
        var resp = await cappedJson(connUrl + "/info", { redirect: "manual" }, { timeoutMs: 5000, maxBytes: INFO_BODY_MAX_BYTES });
        var latencyMs = fetchedAt - probedAt + resp.headersMs;
        if (resp.ok) {
          var data = resp.data;
          var selfBlock = null;
          if (data.peerlist && Array.isArray(data.peerlist)) {
            var self = data.peerlist.find(function(p) { return p && p.identity === r.identity; });
            if (self && self.sync) selfBlock = sanitizeHeight(self.sync.block);
          }
          sharedDb.run(
            "UPDATE fixnet_validator_discoveries SET probe_ok = 1, last_block = COALESCE(?, last_block), last_probed_at = ?, last_latency_ms = ? WHERE identity = ?",
            [selfBlock, probedAt, latencyMs, r.identity]
          );
          return { ok: true, identity: r.identity, block: selfBlock, latencyMs: latencyMs };
        } else {
          sharedDb.run(
            "UPDATE fixnet_validator_discoveries SET probe_ok = 0, last_probed_at = ?, last_latency_ms = NULL WHERE identity = ?",
            [probedAt, r.identity]
          );
          return { ok: false, identity: r.identity, error: "HTTP " + resp.status };
        }
      } catch (e) {
        sharedDb.run(
          "UPDATE fixnet_validator_discoveries SET probe_ok = 0, last_probed_at = ?, last_latency_ms = NULL WHERE identity = ?",
          [probedAt, r.identity]
        );
        return { ok: false, identity: r.identity, error: probeErrorCategory(e) };
      }
    });
  });

  if (probeJobs.length > 0) {
    var probeResults = await mapWithConcurrency(probeJobs, 8, function(job) { return job(); });
    var skipped = probeResults.filter(function(x) { return x && x.error === "not probed: address not public"; }).length;
    log("  [fixnet-discovery] probed " + (probeJobs.length - skipped) + " discovered node(s)" + (skipped ? ", " + skipped + " skipped (address not public)" : ""));
  }

  // Return fresh data (including just-updated rows) for use in UI/API payload
  try {
    var fresh = sharedDb.query(
      "SELECT identity, connection, first_seen, last_seen, online, probe_ok, last_block, last_probed_at, last_latency_ms FROM fixnet_validator_discoveries ORDER BY last_seen DESC"
    ).all();
    // online = DNO's probe answered; reported_online = the anchor's peerlist flag; probed = false when not dialed.
    return (fresh || []).map(function(r) {
      return {
        identity: r.identity,
        connection: r.connection,
        online: r.probe_ok === 1,
        probed: r.probe_ok === 0 || r.probe_ok === 1,
        reported_online: r.online === 1 || r.online === true,
        block: r.last_block,
        latencyMs: r.last_latency_ms,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        last_probed_at: r.last_probed_at,
        operator: null
      };
    });
  } catch (e) {
    return [];
  }
}

async function checkExplorer() {
  log("  Explorer: disabled (SPA, not scrappable)");
  return { ok: false, block: null };
}

function composeDailySummary(fleetData, publicRpcResults, explorerResult) {
  var healthy = fleetData ? fleetData.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length : 0;
  var block = fleetData ? fleetData.chain.block : null;

  // Calculate uptime percentages
  var uptimeParts = [];
  for (var name of NODE_NAMES) {
    var s = uptimeStats[name];
    var pct = s.total > 0 ? Math.round((s.healthy / s.total) * 100) : 0;
    uptimeParts.push(name + ":" + pct + "%");
  }

  // Public RPC summary
  var rpcParts = [];
  for (var _ci = 0; _ci < CROSS_VALIDATION_RPCS.length; _ci++) {
    var rpc = CROSS_VALIDATION_RPCS[_ci];
    var rs = publicRpcStats[rpc.name];
    var rpcPct = rs.total > 0 ? Math.round((rs.reachable / rs.total) * 100) : 0;
    var avgLatency = rs.reachable > 0 ? Math.round(rs.totalLatency / rs.reachable) : 0;
    rpcParts.push(publicValidationRpcName(_ci) + ":" + rpcPct + "% avg " + avgLatency + "ms");
  }

  var blocksProduced = (block != null && dailyBlockStart != null) ? block - dailyBlockStart : null;

  var text = "Daily Network Summary: Fleet " + healthy + "/" + FLEET_SIZE + " healthy. " +
    "Uptime [" + uptimeParts.join(" ") + "]. " +
    "Block " + (block || "?") +
    (blocksProduced != null ? " (+" + blocksProduced + " in 24h)" : "") + ". " +
    "Public RPCs [" + rpcParts.join(", ") + "]. " +
    "Alerts: " + dailyAlertCount + ", Recoveries: " + dailyRecoveryCount + ".";

  if (text.length > 280) text = text.substring(0, 277) + "...";

  return {
    cat: "OBSERVATION",
    text: text,
    confidence: 90,
  };
}

function resetDailyStats(currentBlock) {
  dailyAlertCount = 0;
  dailyRecoveryCount = 0;
  dailyBlockStart = currentBlock;
  dailySummaryCounter = 0;
  for (var name of NODE_NAMES) uptimeStats[name] = { healthy: 0, total: 0 };
  for (var rpc of CROSS_VALIDATION_RPCS) publicRpcStats[rpc.name] = { reachable: 0, total: 0, totalLatency: 0 };
}

// =================================================================
// PHASE 2: Historical Data, Reputation, Predictions, Health API
// =================================================================

// --- Historical data storage (JSON file) ---
let history = []; // array of { ts, block, nodes: { n1: { healthy, blockHeight, latencyMs }, ... }, tps, mempool, publicRpcs: [...] }

function loadHistory() {
  try {
    var raw = readFileSync(HISTORY_FILE, "utf8");
    history = JSON.parse(raw);
    log("  Loaded " + history.length + " historical records.");
  } catch(e) {
    history = [];
  }
}

function saveHistory() {
  try {
    // Trim to max size
    if (history.length > MAX_HISTORY_CYCLES) {
      history = history.slice(history.length - MAX_HISTORY_CYCLES);
    }
    // FIX BUG 8: Atomic write — write to tmp then rename
    var tmpFile = HISTORY_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(history));
    renameSync(tmpFile, HISTORY_FILE);
  } catch(e) {
    logError("Failed to save history: " + e.message);
  }
}

function recordHistory(data, publicRpcResults) {
  var entry = {
    ts: Date.now(),
    block: data.chain ? data.chain.block : null,
    tps: data.chain ? data.chain.tps : null,
    onlineCount: data.chain ? data.chain.onlineCount : null,
    nodes: {},
    publicRpcs: [],
  };
  if (data.nodeReports) {
    for (var i = 0; i < data.nodeReports.length; i++) {
      var nr = data.nodeReports[i];
      entry.nodes[nr.name] = {
        healthy: nr.status === "HEALTHY",
        block: nr.blockHeight,
        issues: nr.issues || [],
      };
    }
  }
  if (publicRpcResults) {
    for (var j = 0; j < publicRpcResults.length; j++) {
      var pr = publicRpcResults[j];
      entry.publicRpcs.push({ name: pr.name, ok: pr.ok, latencyMs: pr.latencyMs || null, block: pr.block || null });
    }
  }
  history.push(entry);
  saveHistory();
}

// --- Congestion & anomaly detection ---
function detectAnomalies(data) {
  var anomalies = [];
  if (!data.chain) return anomalies;

  // Check for TPS spike (compare to historical avg)
  if (data.chain.tps != null && history.length > 6) {
    var tpsValues = history.slice(-18).map(function(h) { return h.tps; }).filter(function(t) { return t != null; });
    if (tpsValues.length > 3) {
      var avgTps = tpsValues.reduce(function(a, b) { return a + b; }, 0) / tpsValues.length;
      if (avgTps > 0 && data.chain.tps > avgTps * 5) {
        anomalies.push("TPS_SPIKE(" + data.chain.tps + " vs avg " + Math.round(avgTps) + ")");
      }
    }
  }

  // Check for mass peer disconnection (online count dropped significantly)
  if (data.chain.onlineCount != null && history.length > 3) {
    var prevOnline = history.slice(-3).map(function(h) { return h.onlineCount; }).filter(function(o) { return o != null; });
    if (prevOnline.length > 0) {
      var avgOnline = prevOnline.reduce(function(a, b) { return a + b; }, 0) / prevOnline.length;
      if (avgOnline >= 5 && data.chain.onlineCount <= avgOnline - 3) {
        anomalies.push("MASS_DISCONNECT(" + data.chain.onlineCount + "/" + FLEET_SIZE + " online, was " + Math.round(avgOnline) + ")");
      }
    }
  }

  return anomalies;
}

// --- Validator discovery (crawl peer lists for unknown nodes) ---
let discoveredPeers = {}; // identities listed in the latest public crawl: { identity: { firstSeen, lastSeen, connection, online, ready, syncStatus, block, listedBy } }
let nodeVersions = {}; // { "n3": { version: "0.9.8", versionName: "Oxlong Michael" }, ... }

// --- Public catalog crawl ------------------------------------------------------------------------------
// Source: the peerlists of the Path A seeds only, read once per public observation round (no extra requests).
// discoveredPeers holds the identities listed in the latest completed crawl, nothing older: its online, ready,
// sync status and height are what those peerlists reported this round. validator_discoveries keeps every
// identity ever listed (first_seen, last_seen = last listed). DNO never dials catalog identities.
const CATALOG_MAX_ROWS = 2000;            // retained identities
const INFO_BODY_MAX_BYTES = 2 * 1024 * 1024; // /info bodies read from seeds and fixnet peers (a real one is tens of KB)
const CATALOG_EVICT_AFTER_MS = 30 * 86400000; // at the cap, rows not listed for this long make room for new ones
const OBSERVATION_HISTORY_MAX_PER_ROUND = 256; // node_observation_history rows written per round (oldest identities first)
const CATALOG_MAX_NEW_PER_CRAWL = 200;    // a flood of fabricated identities cannot grow the catalog quickly
// A new identity is retained only once two distinct public peerlists have listed it (in the same crawl or across
// crawls), so one poisoned peerlist cannot fill the catalog. Until then it waits here, in memory only: never
// published, never dialed. The set is bounded; the least recently listed entry is dropped first.
const CATALOG_MIN_PEERLISTS = 2;
const CATALOG_PENDING_MAX = 4000;
// Per-peerlist budget: in one crawl, one public peerlist brings at most this many identities DNO has never seen into
// the count. The rest are not counted that crawl (a later crawl counts them), so one peerlist listing thousands of
// new keys can neither churn the waiting set nor, with a second peerlist, add more than this many rows per crawl.
// Identities already waiting or kept, and rows recorded before 1.1, use no budget. A rate, not a total: the row cap
// and the 30-day eviction bound the total.
const CATALOG_MAX_NEW_PER_PEERLIST = 50;
var catalogPending = new Map();           // identity -> { sources: [peerlists], firstAt, after } (after: see catalogFirstCounted)
var catalogCrawl = null;                  // crawl in progress
var catalogCountStarted = null;           // when DNO first counted an identity on two public peerlists (loadCatalogCountStarted)
// source -> the last completed crawl of this process that read its peerlist within its budget. Empty at a start: the
// first read of a peerlist cannot date what it lists (see catalogFirstCounted). Emptied again when waiting identities
// are dropped at the cap: DNO has forgotten them as a restart would. Bounded: a seed that names a new identity for
// itself at every read cannot grow it.
const CATALOG_SOURCES_MAX = 64;
var catalogSourceReadAt = new Map();
var catalogLatest = { completedAt: null, peerlistsRead: 0, listedCount: 0 };
// Every identity the latest public crawl listed (kept or not), and whether this process has read a public peerlist yet.
var latestPublicListed = new Set();
var publicPeerlistRead = false;
// The identities the public seeds' peerlists list: in the latest crawl, waiting for a second peerlist, or retained in
// the catalog. They are public-testnet identities. The fixnet probe neither keeps nor dials one, whatever peerlist of
// the operator's own nodes shows it: a node of the operator's that is on the public testnet has the public peerlist.
// null until this process has read a public peerlist: before that DNO cannot tell them apart, and the fixnet probe
// keeps and dials nothing.
function publicListedIdentities() {
  if (!publicPeerlistRead) return null;
  var set = new Set(latestPublicListed);
  catalogPending.forEach(function(v, k) { set.add(String(k).toLowerCase()); });
  if (sharedDb) {
    try { sharedDb.query("SELECT identity FROM validator_discoveries WHERE public_listed_since IS NOT NULL").all().forEach(function(r) { set.add(String(r.identity).toLowerCase()); }); } catch (e) {}
  }
  return set;
}

function catalogBeginCrawl() {
  catalogCrawl = { peerlistsRead: 0, listed: {}, sources: {} };
}

function catalogIngestPeerlist(sourceName, peerlist) {
  if (!catalogCrawl || !Array.isArray(peerlist)) return;
  catalogCrawl.peerlistsRead++;
  catalogCrawl.sources[sourceName] = true;
  for (var i = 0; i < peerlist.length; i++) {
    var peer = peerlist[i];
    var identity = peer && peer.identity;
    if (!isValidIdentity(identity)) continue;
    identity = identity.toLowerCase();
    if (isExcludedFromDiscovered(identity)) continue;
    var rep = {
      online: !!(peer.status && peer.status.online === true),
      ready: peer.status && typeof peer.status.ready === "boolean" ? peer.status.ready : null,
      syncStatus: sanitizeLabel(peer.sync && peer.sync.status, 24),
      block: sanitizeHeight(peer.sync && peer.sync.block),
      connection: peer.connection && typeof peer.connection.string === "string" ? peer.connection.string.slice(0, 200) : null
    };
    var cur = catalogCrawl.listed[identity];
    if (!cur) { catalogCrawl.listed[identity] = { sources: [sourceName], rep: rep }; continue; }
    if (cur.sources.indexOf(sourceName) === -1) cur.sources.push(sourceName);
    // Several peerlists can describe the same identity: height and sync status come from the report with the
    // highest height; the online flag is set when any listing peerlist reports it online. (The peerlist's
    // readiness flag is stored but not published: what it means has not been confirmed on a real /info.)
    var anyOnline = cur.rep.online || rep.online;
    if (rep.block !== null && (cur.rep.block === null || rep.block > cur.rep.block)) cur.rep = rep;
    cur.rep.online = anyOnline;
  }
}

function catalogFinishCrawl(results, observedAt) {
  var crawl = catalogCrawl;
  catalogCrawl = null;
  if (!crawl) return;
  var ids = Object.keys(crawl.listed);
  latestPublicListed = new Set(ids);
  if (crawl.peerlistsRead > 0) publicPeerlistRead = true;
  // known: every stored row. A row is public once public_listed_since is set, and that is its first-counted time (a
  // row this version inserts gets the same time in first_seen). Rows an older agent recorded (public_listed_since
  // NULL) go through the two-peerlist rule like new identities.
  var known = {};
  if (sharedDb) {
    try { sharedDb.query("SELECT identity, public_listed_since FROM validator_discoveries").all().forEach(function(r) { var pub = r.public_listed_since !== null && r.public_listed_since !== undefined; known[r.identity] = { firstSeen: pub ? r.public_listed_since : null, isPublic: pub }; }); } catch (e) {}
  }
  var retained = Object.keys(known).length, added = 0, promotedLegacy = 0, skipped = 0, evicted = 0, newlyPending = 0, pendingDropped = 0;
  var budgetUsed = {}, budgetHit = {}, budgetSkipped = 0;   // per-peerlist introductions of never-seen identities
  var next = {};
  // Two-peerlist rule: merge this crawl's sources with what earlier crawls recorded. An identity two distinct public
  // peerlists have listed leaves the waiting set for good (it goes back only if its write fails).
  var promote = {};                        // identity -> { firstAt, sources }
  if (sharedDb) {
    ids.forEach(function(x) {
      if (known[x] && known[x].isPublic) { catalogPending.delete(x); return; }
      var pend = catalogPending.get(x), isNew = !pend;
      var srcs = crawl.listed[x].sources;
      if (!pend && !known[x]) {                                // never seen: counts only for peerlists with budget left
        srcs = srcs.filter(function(src) { if ((budgetUsed[src] || 0) < CATALOG_MAX_NEW_PER_PEERLIST) return true; budgetHit[src] = true; return false; });
        if (!srcs.length) { budgetSkipped++; return; }
        srcs.forEach(function(src) { budgetUsed[src] = (budgetUsed[src] || 0) + 1; });
      }
      if (pend) catalogPending.delete(x);
      else pend = { sources: [], firstAt: observedAt, after: Infinity };
      // after: the earliest of the last reads, by this process, of every peerlist that lists it before it is kept (it was
      // on none of them then). A peerlist not read before counts as CATALOG_AFTER_UNKNOWN, which is below every read
      // time: once one of them is unknown, the earliest stays unknown.
      srcs.forEach(function(src) {
        if (pend.sources.indexOf(src) !== -1) return;
        pend.sources.push(src);
        var at = catalogSourceReadAt.get(src);
        pend.after = Math.min(pend.after, at === undefined ? CATALOG_AFTER_UNKNOWN : at);
      });
      if (pend.sources.length >= CATALOG_MIN_PEERLISTS) { promote[x] = pend; return; }
      if (isNew) newlyPending++;
      catalogPending.set(x, pend);           // re-inserted: most recently listed last
    });
    while (catalogPending.size > CATALOG_PENDING_MAX) { catalogPending.delete(catalogPending.keys().next().value); pendingDropped++; }
  }
  var inserted = [], madePublic = [], deferred = [];
  if (sharedDb) {
    try {
      sharedDb.exec("BEGIN");
      // At the cap, rows no public peerlist has listed for 30 days make room (oldest first); nothing else is removed.
      var wanted = Math.min(CATALOG_MAX_NEW_PER_CRAWL, Object.keys(promote).filter(function(x) { return !known[x]; }).length);
      var over = retained + wanted - CATALOG_MAX_ROWS;
      if (over > 0) {
        var stale = sharedDb.query("SELECT identity FROM validator_discoveries WHERE last_seen < ? ORDER BY last_seen ASC LIMIT ?").all(observedAt - CATALOG_EVICT_AFTER_MS, over + ids.length)
          .filter(function(row) { return !crawl.listed[row.identity]; }).slice(0, over);   // never one listed in this crawl
        stale.forEach(function(row) { sharedDb.run("DELETE FROM validator_discoveries WHERE identity = ?", [row.identity]); delete known[row.identity]; evicted++; });
        retained -= evicted;
      }
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i], entry = crawl.listed[id], r = entry.rep, k = known[id];
        if (!k || !k.isPublic) {
          var pr = promote[id];
          if (!pr) {                                             // listed by one public peerlist so far: waiting
            if (k) sharedDb.run("UPDATE validator_discoveries SET last_seen = ? WHERE identity = ?", [observedAt, id]);
            continue;
          }
          if (!k) {
            if (added >= CATALOG_MAX_NEW_PER_CRAWL || retained + added >= CATALOG_MAX_ROWS) { skipped++; deferred.push(id); continue; }
            sharedDb.run("INSERT OR IGNORE INTO validator_discoveries (identity, first_seen, last_seen, connection, online, public_listed_since, counted_after) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [id, pr.firstAt, observedAt, r.connection || "unknown", r.online ? 1 : 0, pr.firstAt, Number.isFinite(pr.after) ? pr.after : CATALOG_AFTER_UNKNOWN]);
            known[id] = { firstSeen: pr.firstAt, isPublic: true }; inserted.push(id); added++;
          } else {
            // A 1.0 row: public from now, first counted when a public peerlist first listed it. That time goes in
            // public_listed_since only. first_seen stays what the older agent recorded: an older agent reads it again
            // after a rollback, and rewriting it would show every adopted row as new there.
            sharedDb.run("UPDATE validator_discoveries SET public_listed_since = ? WHERE identity = ?", [pr.firstAt, id]);
            k.isPublic = true; k.firstSeen = pr.firstAt; madePublic.push(id); promotedLegacy++;
          }
        }
        sharedDb.run("UPDATE validator_discoveries SET last_seen = ?, online = ?, last_block = ?, last_ready = ?, last_sync_status = ?, last_listed_by = ?, connection = COALESCE(?, connection) WHERE identity = ?",
          [observedAt, r.online ? 1 : 0, r.block, r.ready === null ? null : (r.ready ? 1 : 0), r.syncStatus, entry.sources.length, r.connection, id]);
      }
      sharedDb.exec("COMMIT");
      if (catalogCountStarted === null && (added > 0 || promotedLegacy > 0)) { try { catalogCountStarted = loadCatalogCountStarted(sharedDb); } catch (eStart) { logError("  [catalog] the count's start was not kept: " + eStart.message); } }
    } catch (e) {
      try { sharedDb.exec("ROLLBACK"); } catch (e2) {}
      inserted.forEach(function(x) { delete known[x]; });                    // not stored: not published either
      madePublic.forEach(function(x) { if (known[x]) known[x].isPublic = false; });
      deferred = Object.keys(promote);                                        // all of them wait for the next crawl
      added = 0; promotedLegacy = 0; evicted = 0; skipped = 0;
      logError("  [catalog] write failed: " + e.message);
    }
    // Promotions that could not be stored (cap reached, or a failed write) wait again with their sources.
    deferred.forEach(function(x) { if (promote[x] && !(known[x] && known[x].isPublic)) catalogPending.set(x, promote[x]); });
    while (catalogPending.size > CATALOG_PENDING_MAX) { catalogPending.delete(catalogPending.keys().next().value); pendingDropped++; }
  }
  for (var j = 0; j < ids.length; j++) {
    var cid = ids[j];
    if (!known[cid] || !known[cid].isPublic) continue;   // waiting, or over the cap: not published
    var e = crawl.listed[cid];
    next[cid] = { identity: cid, firstSeen: known[cid].firstSeen, lastSeen: observedAt, connection: e.rep.connection, online: e.rep.online, ready: e.rep.ready, syncStatus: e.rep.syncStatus, block: e.rep.block, listedBy: e.sources.length };
  }
  discoveredPeers = next;
  catalogLatest = { completedAt: observedAt, peerlistsRead: crawl.peerlistsRead, listedCount: Object.keys(next).length };
  // This crawl read these peerlists. One that went over its budget was not counted to its end: the identities left for
  // a later crawl must not look newly listed then, so its read time stays where it was. And when waiting identities
  // were dropped, no peerlist counts as read: a dropped one that is still listed must not look newly listed next time.
  if (pendingDropped > 0) catalogSourceReadAt.clear();
  else Object.keys(crawl.sources).forEach(function(src) { if (budgetHit[src]) return; catalogSourceReadAt.delete(src); catalogSourceReadAt.set(src, observedAt); });
  while (catalogSourceReadAt.size > CATALOG_SOURCES_MAX) catalogSourceReadAt.delete(catalogSourceReadAt.keys().next().value);
  if (added > 0) log("  [catalog] +" + added + " new identit" + (added === 1 ? "y" : "ies") + " listed by at least " + CATALOG_MIN_PEERLISTS + " public peerlists");
  if (promotedLegacy > 0) log("  [catalog] " + promotedLegacy + " row" + (promotedLegacy === 1 ? "" : "s") + " recorded before 1.1 now listed by " + CATALOG_MIN_PEERLISTS + " public peerlists: public from now");
  if (newlyPending > 0) log("  [catalog] " + newlyPending + " identit" + (newlyPending === 1 ? "y" : "ies") + " listed by one public peerlist only: not retained until a second lists " + (newlyPending === 1 ? "it" : "them") + " (" + catalogPending.size + " waiting)");
  if (pendingDropped > 0) logError("  [catalog] " + pendingDropped + " waiting identit" + (pendingDropped === 1 ? "y" : "ies") + " dropped: the pending set is full (" + CATALOG_PENDING_MAX + ")");
  if (evicted > 0) log("  [catalog] " + evicted + " identit" + (evicted === 1 ? "y" : "ies") + " not listed for 30 days removed at the cap");
  if (skipped > 0) logError("  [catalog] " + skipped + " new identities not retained this crawl (per-crawl or total cap reached); they wait for the next");
  var hitCount = Object.keys(budgetHit).length;
  if (hitCount > 0) logError("  [catalog] " + hitCount + " public peerlist" + (hitCount === 1 ? "" : "s") + " listed more than " + CATALOG_MAX_NEW_PER_PEERLIST + " new identities this crawl; " + budgetSkipped + " identit" + (budgetSkipped === 1 ? "y was" : "ies were") + " not counted (a later crawl counts them)");
}

// The highest own height among the configured seeds in the latest public observation; null when none gave one.
function highestSeedHeight() {
  var hs = (latestPublicNodes || []).map(ownHeight).filter(function(h) { return h !== null; });
  return hs.length ? Math.max.apply(null, hs) : null;
}
// Public catalog row (no connection string, no full identity). Reported fields only when listed this round.
function catalogPublicRow(dbRow, nowMs) {
  var live = discoveredPeers[dbRow.identity] || null;
  var networkHead = highestSeedHeight();
  var block = live ? live.block : null;
  return {
    display: resolveNodeDisplay({ identity: dbRow.identity }),
    identity_truncated: truncIdentity(dbRow.identity),
    first_seen: dbRow.first_seen ? new Date(dbRow.first_seen).toISOString() : null,
    last_listed: dbRow.last_seen ? new Date(dbRow.last_seen).toISOString() : null,
    listed_this_cycle: !!live,
    listed_by: live ? live.listedBy : 0,
    reported: live ? {
      online: live.online,
      sync_status: live.syncStatus,
      height: block,
      height_vs_highest_seed: (block !== null && networkHead !== null) ? block - networkHead : null
    } : null
  };
}

// --- HTTP Health Endpoint ---
let latestHealthData = null; // updated each cycle
let latestPublicNodes = []; // updated each cycle
let latestVersionData = { running: AGENT_VERSION, latestCommit: null, latestMessage: null, latestDate: null, nodeVersion: null, checkedAt: null };
let latestAttestationState = { available: false, lastCount: 0, lastOkAt: null, lastAttemptAt: null }; // honest DAHR attestation state; drives metric + /health (never hardcoded)
let latestPublicRpcObservations = null; // null = no public-RPC observation yet; sanitized snapshot refreshed after each completed public-RPC probe; stale snapshots are not served
let signalAlertDedup = {}; // { "signal_type_nodes": timestamp }
let signalFirstSeen = {}; // { "signal_type": timestamp } — tracks when each signal type first appeared
let signalPrevValue = {}; // { "signal_type": value } — tracks previous value for trend

function groupSignals(signals) {
  var now = Date.now();
  var grouped = { critical: [], warning: [], info: [] };
  for (var sig of signals) {
    var key = sig.type + "_" + (sig.nodes || []).join(",");
    // Track first seen
    if (!signalFirstSeen[key]) signalFirstSeen[key] = now;
    var firstSeen = new Date(signalFirstSeen[key]).toISOString();
    var durationMin = Math.round((now - signalFirstSeen[key]) / 60000);
    // Track trend
    var prevVal = signalPrevValue[key];
    var trend = "stable";
    if (sig.value !== null && sig.value !== undefined && prevVal !== undefined) {
      if (sig.type === "partition_risk" || sig.type === "block_lag" || sig.type === "block_divergence") {
        trend = sig.value > prevVal ? "degrading" : sig.value < prevVal ? "improving" : "stable";
      }
    }
    signalPrevValue[key] = sig.value;
    var enriched = {
      type: sig.type,
      severity: sig.severity,
      affected_nodes: sig.nodes || [],
      value: sig.value,
      message: sig.message,
      first_seen: firstSeen,
      duration_min: durationMin,
      trend: trend
    };
    var bucket = sig.severity === "critical" ? "critical" : sig.severity === "warning" ? "warning" : "info";
    grouped[bucket].push(enriched);
  }
  // Clear first_seen for signals that are no longer active
  var activeKeys = new Set(signals.map(function(s) { return s.type + "_" + (s.nodes || []).join(","); }));
  for (var k in signalFirstSeen) {
    if (!activeKeys.has(k)) delete signalFirstSeen[k];
  }
  return grouped;
}

async function checkLatestVersion() {
  try {
    var gr = await fetch("https://api.github.com/repos/xm33/demos-network-oracle/commits/master", { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "demos-network-oracle" } });
    var gd = await gr.json();
    latestVersionData.latestCommit = gd.sha ? gd.sha.substring(0, 7) : null;
    latestVersionData.latestMessage = gd.commit ? gd.commit.message.split("\n")[0] : null;
    latestVersionData.latestDate = gd.commit ? gd.commit.author.date : null;
    latestVersionData.checkedAt = new Date().toISOString();
    log("  Version check: latest GitHub commit is " + latestVersionData.latestCommit + " — " + latestVersionData.latestMessage);
  } catch(e) { log("  Version check failed: " + e.message); }
  // Node software version as the answering public seeds report it (most common value); fleet nodes are not read here.
  var seedVersions = {};
  (latestPublicNodes || []).forEach(function(n) { if (n && n.ok && n.version && n.version !== "?") seedVersions[n.version] = (seedVersions[n.version] || 0) + 1; });
  var topVersion = Object.keys(seedVersions).sort(function(a, b) { return seedVersions[b] - seedVersions[a]; })[0] || null;
  latestVersionData.nodeVersion = topVersion;
  latestVersionData.nodeVersionName = null;
}

function startHealthServer() {

// ---- v5.0: Federated Prometheus Metrics ----
function generatePrometheusMetrics(fleetData) {
  const lines = [];
  const metric = (name, help, type, values) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    values.forEach(v => lines.push(v));
    lines.push('');
  };

  metric('demos_fleet_nodes_total', 'Total monitored nodes', 'gauge',
    [`demos_fleet_nodes_total ${fleetData.nodes?.length || 7}`]);
  metric('demos_fleet_nodes_online', 'Nodes currently online', 'gauge',
    [`demos_fleet_nodes_online ${fleetData.nodesOnline || 0}`]);
  metric('demos_fleet_block_height', 'Highest block height', 'gauge',
    [`demos_fleet_block_height ${fleetData.blockHeight || 0}`]);
  metric('demos_fleet_tps', 'Transactions per second', 'gauge',
    [`demos_fleet_tps ${fleetData.tps || 0}`]);
  metric('demos_fleet_mempool_size', 'Mempool tx count', 'gauge',
    [`demos_fleet_mempool_size ${fleetData.mempoolSize || 0}`]);
  metric('demos_fleet_seconds_since_last_block', 'Seconds since last block', 'gauge',
    [`demos_fleet_seconds_since_last_block ${fleetData.secondsSinceLastBlock || 0}`]);
  metric('demos_fleet_discovered_peers', 'Discovered non-fleet validators', 'gauge',
    [`demos_fleet_discovered_peers ${fleetData.discoveredPeersCount || 0}`]);

  const nUp=[], nBlock=[], nRep=[], nUptime=[], nSync=[], nExp=[];
  for (const node of (fleetData.nodes || [])) {
    const l = `node="${node.name||node.id}",host="${node.host||'unknown'}",side="${node.side||'unknown'}"`;
    nUp.push(`demos_node_up{${l}} ${node.online?1:0}`);
    nBlock.push(`demos_node_block_height{${l}} ${node.blockHeight||0}`);
    nUptime.push(`demos_node_uptime_percent{${l}} ${node.uptimePercent||0}`);
    nSync.push(`demos_node_synced{${l}} ${node.synced?1:0}`);
    nExp.push(`demos_node_exporter_up{${l}} ${node.exporterUp?1:0}`);
  }
  metric('demos_node_up', 'Node online/offline', 'gauge', nUp);
  metric('demos_node_block_height', 'Node block height', 'gauge', nBlock);
  metric('demos_node_uptime_percent', 'Node uptime pct', 'gauge', nUptime);
  metric('demos_node_synced', 'Node sync status', 'gauge', nSync);
  metric('demos_node_exporter_up', 'Exporter reachable', 'gauge', nExp);

  if (fleetData.publicRPCs) {
    const rUp=[], rLat=[];
    for (const rpc of fleetData.publicRPCs) {
      const l = `url="${rpc.url}"`;
      rUp.push(`demos_public_rpc_up{${l}} ${rpc.available?1:0}`);
      rLat.push(`demos_public_rpc_latency_ms{${l}} ${rpc.latencyMs||0}`);
    }
    metric('demos_public_rpc_up', 'Public RPC availability', 'gauge', rUp);
    metric('demos_public_rpc_latency_ms', 'Public RPC latency ms', 'gauge', rLat);
  }

  metric('demos_dahr_attestations_total', 'DAHR attestations this cycle', 'gauge',
    [`demos_dahr_attestations_total ${fleetData.dahrAttestations||0}`]);
  metric('demos_alerts_active', 'Active alerts', 'gauge',
    [`demos_alerts_active ${fleetData.activeAlerts||0}`]);
  metric('demos_alerts_total', 'Total alerts since summary', 'counter',
    [`demos_alerts_total ${fleetData.totalAlerts||0}`]);
  metric('demos_oracle_info', 'Agent metadata', 'gauge',
    [`demos_oracle_info{version="${fleetData.version||'6.2'}",wallet="${fleetData.wallet||''}"} 1`]);
  metric('demos_oracle_cycle_count', 'Cycles since startup', 'counter',
    [`demos_oracle_cycle_count ${fleetData.cycleCount||0}`]);

  return lines.join('\n') + '\n';
}
// ---- end v5.0: Federated Prometheus Metrics ----

// ---- Public metrics contract (default-deny allowlist) ----
// Pure function of (snapshot, now, staleBound) + module constant AGENT_VERSION.
// Reads no mutable operational containers. Emits HELP/TYPE only for families it emits.
function promLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function buildPublicMetrics(snapshot, now, staleBound) {
  var lines = [];

  // dno_oracle_info — always served; static implementation metadata, no observation claim.
  lines.push('# HELP dno_oracle_info Oracle implementation metadata.');
  lines.push('# TYPE dno_oracle_info gauge');
  lines.push('dno_oracle_info{version="' + promLabelValue(AGENT_VERSION) + '"} 1');
  lines.push('');

  // --- Public-RPC families: three-state freshness (positive-fresh, strict bound) ---
  // Serveable ONLY when ALL hold: snapshot is an object with an entries array;
  // now, observedAt, staleBound strictly finite; staleBound > 0;
  // 0 <= now - observedAt < staleBound (strict upper bound).
  var fresh = !!(
    snapshot && typeof snapshot === 'object' &&
    Array.isArray(snapshot.entries) &&
    Number.isFinite(now) &&
    Number.isFinite(snapshot.observedAt) &&
    Number.isFinite(staleBound) && staleBound > 0
  );
  if (fresh) {
    var age = now - snapshot.observedAt;
    if (!(age >= 0 && age < staleBound)) { fresh = false; }
  }

  // Snapshot-level duplicate-alias scan: considers ONLY format-valid public aliases
  // (a collision between servable identities makes the snapshot ambiguous). Runs over
  // the full array BEFORE any emission; ignores up/latency validity. Invalid-format
  // aliases can never serve, so their collisions stay entry-local (skipped below).
  var validForEmission = null;
  if (fresh) {
    var seen = new Set();
    var dup = false;
    for (var i = 0; i < snapshot.entries.length; i++) {
      var e = snapshot.entries[i];
      if (e && typeof e === 'object' &&
          typeof e.rpc === 'string' && /^validation-\d+$/.test(e.rpc)) {
        if (seen.has(e.rpc)) { dup = true; break; }
        seen.add(e.rpc);
      }
    }
    if (!dup) { validForEmission = snapshot.entries; }
  }

  if (validForEmission) {
    var upLines = [];
    var latLines = [];
    for (var j = 0; j < validForEmission.length; j++) {
      var en = validForEmission[j];
      if (!en || typeof en !== 'object') { continue; }
      if (typeof en.rpc !== 'string' || !/^validation-\d+$/.test(en.rpc)) { continue; }
      if (en.up !== true && en.up !== false) { continue; }
      upLines.push(
        'dno_public_rpc_up{rpc="' + en.rpc + '"} ' + (en.up ? '1' : '0')
      );
      if (
        en.up === true &&
        typeof en.latencyMs === 'number' &&
        Number.isFinite(en.latencyMs) &&
        en.latencyMs >= 0
      ) {
        latLines.push(
          'dno_public_rpc_latency_ms{rpc="' + en.rpc + '"} ' + en.latencyMs
        );
      }
    }
    // Conditional family presence: HELP/TYPE emitted ONLY when the family has >= 1 sample.
    if (upLines.length > 0) {
      lines.push('# HELP dno_public_rpc_up Public RPC reachability as observed from this DNO vantage (1=observed reachable, 0=observed unreachable).');
      lines.push('# TYPE dno_public_rpc_up gauge');
      for (var u = 0; u < upLines.length; u++) { lines.push(upLines[u]); }
      lines.push('');
    }
    if (latLines.length > 0) {
      lines.push('# HELP dno_public_rpc_latency_ms Measured public RPC probe latency (ms) for successful probes in this observation.');
      lines.push('# TYPE dno_public_rpc_latency_ms gauge');
      for (var l = 0; l < latLines.length; l++) { lines.push(latLines[l]); }
      lines.push('');
    }
  }

  return lines.join('\n');
}
// ---- end public metrics contract ----


  // Observation-based validators: a new public round or fleet cycle changes the ETag. A client that sends the
  // previous ETag gets 304 until DNO has observed something new (staleness can then be computed locally from
  // observed_at). When the last observation turns stale the reading itself changes, to unknown, so the ETag changes
  // once then too: a client revalidating a body that said "stable" must not be told 304. The test is the body's own
  // (computeCanonicalState: more than PUBLIC_STALE_AFTER_SECONDS whole seconds). Each route calls this once, before
  // it builds its body, and sends that result with the 200: time only moves forward, so the stale ETag is only ever
  // sent with a stale body.
  // Last-Modified is the observation time.
  function observationValidators(route) {
    var staleS = getStaleness().stalenessSeconds;
    var stale = staleS !== null && staleS > PUBLIC_STALE_AFTER_SECONDS;
    var tag = 'W/"' + route + "-" + (lastPublicObservedAt || 0) + "-" + cycleCount + (stale ? "-stale" : "") + (route === "health" && latestValidatorRound ? "-v" + latestValidatorRound.roundAt : "") + '"';
    return { etag: tag, lastModified: lastPublicObservedAt ? new Date(lastPublicObservedAt).toUTCString() : null };
  }
  function notModified(req, res, v, headers) {
    var inm = req.headers["if-none-match"];
    if (inm && inm.split(/\s*,\s*/).indexOf(v.etag) !== -1) {
      var h = { "ETag": v.etag, "Cache-Control": headers["Cache-Control"] || "public, max-age=5", "Access-Control-Allow-Origin": "*" };
      if (v.lastModified) h["Last-Modified"] = v.lastModified;
      res.writeHead(304, h); res.end(); return true;
    }
    return false;
  }
  // Fleet-only routes (/history and everything under it, /dashboard): served on the loopback internal listener only.
  // The public listener answers 404 for them whether or not INTERNAL_PORT is set.
  function isFleetRoute(p) { return p === "/history" || p.indexOf("/history/") === 0 || p === "/dashboard" || p.indexOf("/dashboard/") === 0; }

  function handleRequest(req, res, internal) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");

    // F-3: route on pathname so query strings do not 404 exact-match routes.
    // Origin-form targets get a fixed origin prefix, so paths such as "//" parse instead of throwing.
    var reqUrl;
    try { reqUrl = new URL(String(req.url || "/").charAt(0) === "/" ? "http://d" + req.url : String(req.url)); }
    catch (urlErr) { res.writeHead(400); res.end(JSON.stringify({ error: "Bad request." })); return; }
    var reqPath = reqUrl.pathname;
    var reqQuery = reqUrl.searchParams;
    if (!internal && isFleetRoute(reqPath)) {
      res.writeHead(404); res.end(JSON.stringify({ error: "Not found. Try /docs for API documentation." })); return;
    }

    if (reqPath === "/health") {
      var healthV = observationValidators("health");   // once, before the body: the same validators answer the 304 and go with the 200
      if (notModified(req, res, healthV, {})) return;
      var staleness = getStaleness(); // FIX BUG 7
      var canonical = computeCanonicalState();
      var healthSignals = generateSignals(latestHealthData, staleness.stalenessSeconds);
      var publicSignals = toPublicSignals(healthSignals); // public-surface projection (privacy control)
      var payload = {
        status: canonical.status,
        trend: canonical.trend,
        risk: canonical.risk,
        data_quality: canonical.data_quality,
        confidence: canonical.confidence,
        agreement: canonical.agreement,
        active_incidents: canonical.active_incidents,
        max_incident_severity: canonical.max_incident_severity,
        staleness_seconds: canonical.staleness_seconds,
        last_updated: canonical.last_updated,
        api_version: canonical.api_version,
        last_24h: getLast24h(),
        status_reason: canonical.status_reason,
        risk_factors: canonical.risk_factors,
        confidence_reason: canonical.confidence_reason,
        agreement_reason: canonical.agreement_reason,
        data_quality_reason: canonical.data_quality_reason,
        observed_at: canonical.observed_at,
        height_last_advanced_at: canonical.height_last_advanced_at,
        height_static_seconds: canonical.height_static_seconds,
        active_public_conditions: canonical.active_public_conditions,
        witnesses: canonical.witnesses,
        height_standstill_after_seconds: canonical.height_standstill_after_seconds,
        // === Derived ===
        publicNodes: (latestPublicNodes || []).map(function(n) {
          var o = {};
          for (var k in n) {
            if (k === "trust_tier") continue;
            o[k] = n[k];
          }
          if (o.identity) o.identity = truncId(o.identity);
          return o;
        }),
        signals: publicSignals,
        signals_grouped: groupSignals(publicSignals),
        validator_growth: (function() {
          var vg = getValidatorGrowth();
          var out = {};
          for (var k in vg) out[k] = vg[k];
          out.validators = (vg.validators || []).map(function(v) {
            var o = {};
            for (var vk in v) o[vk] = v[vk];
            if (o.identity) o.identity = truncId(o.identity);
            return o;
          });
          return out;
        })(),
        discoveredPeers: Object.keys(discoveredPeers).length,
        attestation: { available: latestAttestationState.available, last_count: latestAttestationState.lastCount, last_ok_at: latestAttestationState.lastOkAt },
        on_chain_publication: SUPERCOLONY_ENABLED ? "unavailable" : "disabled",
        on_chain_validators: publicOnChainValidators(latestValidatorRound, Date.now(), validatorPublishConfig()),
        validator_watch: publicValidatorWatch(latestValidatorRound, Date.now(), validatorPublishConfig()),
      };
      var healthHdrs = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*" };
      healthHdrs["ETag"] = healthV.etag;
      if (healthV.lastModified) healthHdrs["Last-Modified"] = healthV.lastModified;
      res.writeHead(200, healthHdrs);
      res.end(JSON.stringify(payload, null, 2));
    } else if (reqPath === "/peers") {
      var staleness = getStaleness(); // FIX BUG 7
      var peerHdrs = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*" };
      if (staleness.lastCycleAt) peerHdrs["Last-Modified"] = new Date(staleness.lastCycleAt).toUTCString();
      res.writeHead(200, peerHdrs);
      var publicDiscovered = {};
      for (var _pid in discoveredPeers) { publicDiscovered[truncId(_pid)] = toPublicPeer(_pid, discoveredPeers[_pid]); }
      res.end(JSON.stringify({ scope: "public_sanitized", listed: "latest public crawl", crawl: { completed_at: catalogLatest.completedAt ? new Date(catalogLatest.completedAt).toISOString() : null, public_peerlists_read: catalogLatest.peerlistsRead }, discovered: publicDiscovered, lastCycleAt: staleness.lastCycleAt, stalenessSeconds: staleness.stalenessSeconds, privacy: { connection_exposed: false, full_identity_exposed: false } }, null, 2));
    } else if (reqPath === "/catalog") {
      // Retained catalog, sanitized. Optional ?q= filters by the end of the display name or by the published
      // characters of a truncated key (0xabcd…1234); ?listed=now|not by whether the latest crawl listed the row.
      // Full keys are never returned. ETag / 304 between observations, like /organism.
      var listedParam = reqQuery.get("listed");
      if (listedParam !== null && listedParam !== "now" && listedParam !== "not") { res.writeHead(400); res.end(JSON.stringify({ error: "listed must be now or not" })); return; }
      var catV = observationValidators("catalog");
      var catHdrs = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*", "ETag": catV.etag };
      if (catV.lastModified) catHdrs["Last-Modified"] = catV.lastModified;
      if (notModified(req, res, catV, catHdrs)) return;
      var cat = getPublicCatalog();
      if (listedParam) { cat.rows = cat.rows.filter(function(r) { return listedParam === "now" ? r.listed_this_cycle : !r.listed_this_cycle; }); cat.listed = listedParam; }
      var q = (reqQuery.get("q") || "").trim().toLowerCase().replace(/^discovered-/, "");
      if (q) {
        if (q.length > 80 || !/^[0-9a-fx.\u2026]+$/.test(q)) { res.writeHead(400); res.end(JSON.stringify({ error: "q accepts hex characters, 0x, or a truncated key" })); return; }
        var tm = q.match(/^(0x[0-9a-f]*)(?:\u2026|\.{2,3})([0-9a-f]*)$/);
        cat.rows = cat.rows.filter(function(r) {
          var pre = r.identity_truncated.slice(0, 6).toLowerCase(), suf = r.identity_truncated.slice(-4).toLowerCase();
          if (tm) return (tm[1].length <= 2 || pre.indexOf(tm[1]) === 0 || tm[1].indexOf(pre) === 0) && (!tm[2] || suf.slice(-tm[2].length) === tm[2].slice(-4));
          if (q.indexOf("0x") === 0) return q.length <= 2 || pre.indexOf(q) === 0 || q.indexOf(pre) === 0;
          return suf.indexOf(q) !== -1;
        });
        cat.query = q;
      }
      res.writeHead(200, catHdrs);
      res.end(JSON.stringify(cat, null, 2));
    } else if (reqPath === "/catalog/lookup") {
      // Exact check of a full key against retained identities; answers yes/no and the sanitized row only. For a valid key
      // it also says where that key stands on the agreed validators list (on_chain): that key only, never another.
      var lkKey = (reqQuery.get("key") || "").trim();
      var lk = lookupCatalogKey(lkKey);
      lk.on_chain = lk.valid_key ? listedStatus(latestValidatorRound, lkKey, Date.now(), validatorPublishConfig()) : null;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(lk, null, 2));
    } else if (reqPath === "/history") {
      // Return last 24h of data points
      var last24h = history.slice(-72);
      var staleness = getStaleness(); // FIX BUG 7
      res.writeHead(200);
      res.end(JSON.stringify({ points: last24h.length, data: last24h, lastCycleAt: staleness.lastCycleAt, stalenessSeconds: staleness.stalenessSeconds }, null, 2));
    } else if (reqPath === "/incidents" || reqPath.indexOf("/incidents/") === 0) {
      // Parameters are validated; scope and status are applied before the limit. The public listener serves
      // scope=public only (fleet incidents name fleet nodes); fleet and all are available on the internal listener.
      var incStatus = reqQuery.get("status");
      var incScope = reqQuery.get("scope") || "public";
      var incLimitRaw = reqQuery.get("limit");
      var incLimit = incLimitRaw === null ? 50 : Number(incLimitRaw);
      var incBad = null;
      if (incStatus !== null && incStatus !== "active" && incStatus !== "resolved") incBad = "status must be active or resolved";
      else if (["public", "fleet", "all"].indexOf(incScope) === -1) incBad = "scope must be public";
      else if (incScope !== "public" && !internal) incBad = "only scope=public is served on the public API";
      else if (!Number.isInteger(incLimit) || incLimit < 1 || incLimit > 500) incBad = "limit must be an integer from 1 to 500";
      if (incBad) { res.writeHead(400); res.end(JSON.stringify({ error: incBad })); return; }
      try {
        var incQuery = "SELECT * FROM incidents WHERE 1 = 1";
        var incArgs = [];
        if (incStatus) { incQuery += " AND status = ?"; incArgs.push(incStatus); }
        // Public scope follows the 2026-04-23 reconciliation boundary, like /timeline and last_24h.
        if (incScope === "public") { incQuery += " AND started_at >= ?"; incArgs.push(INCIDENT_RECONCILIATION_START_AT); }
        incQuery += " ORDER BY rowid DESC";   // scope is decided per row below, so no LIMIT before it
        var incRows = sharedDb.prepare(incQuery).all(...incArgs);
        var incResults = [];
        for (var ii = 0; ii < incRows.length; ii++) {
          var r = incRows[ii];
          var nodes;
          try { nodes = JSON.parse(r.affected_nodes || "[]"); } catch (pe) { nodes = []; }
          var rowScope = incidentScope(r.description, nodes);
          if (incScope !== "all" && rowScope !== incScope) continue;
          var alerts;
          try { alerts = JSON.parse(r.alerts || "[]"); } catch (ae) { alerts = []; }
          var incRow = {
            id: r.id, status: r.status, severity: r.severity, scope: rowScope,
            kind: isPublicConditionMarker({ affectedNodes: nodes }) ? "condition" : "incident",
            startedAt: r.started_at, resolvedAt: r.resolved_at,
            durationSeconds: r.duration_seconds,
            affectedNodes: nodes,
            description: r.description,
            detectedBlock: r.detected_block, resolvedBlock: r.resolved_block,
            alerts: alerts
          };
          // A dated note DNO added later, when there is one (additive in 1.2). The stored record is as it was written.
          var incNote = incidentNote(r.id, r.started_at);
          if (incNote) incRow.note = incNote;
          incResults.push(incRow);
        }
        var matched = incResults.length;
        incResults = incResults.slice(0, incLimit);
        var activeCount = incScope === "public" ? getPublicActiveIncidentIds().length : incScope === "fleet" ? Object.keys(activeIncidents).length - getPublicActiveIncidentIds().length : Object.keys(activeIncidents).length;
        res.writeHead(200);
        res.end(JSON.stringify({ scope: incScope, total: matched, returned: incResults.length, active: activeCount, active_public_conditions: countActivePublicConditions(), incidents: incResults }, null, 2));
      } catch(incErr) {
        logError("[incidents] query failed: " + incErr.message);
        res.writeHead(500);
        res.end(JSON.stringify({ scope: incScope, total: 0, active: 0, incidents: [], error: "incidents unavailable" }, null, 2));
      }
    } else if (reqPath === "/federate" || reqPath === "/metrics") {
      var publicMetricsText = buildPublicMetrics(latestPublicRpcObservations, Date.now(), STALE_BOUND);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(publicMetricsText);
    } else if (reqPath === "/consensus" || reqPath === "/consensus/") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getConsensusState(), null, 2));
    } else if (reqPath === "/organism/schema") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
      res.end(ORGANISM_SCHEMA);
    } else if (reqPath === "/organism") {
      // M5: Cache header for agent consumption
      var orgV = observationValidators("organism");   // once, before the body: the same validators answer the 304 and go with the 200
      if (notModified(req, res, orgV, {})) return;
      var canonical = computeCanonicalState();
      var organism = {
        status: canonical.status,
        trend: canonical.trend,
        risk: canonical.risk,
        data_quality: canonical.data_quality,
        confidence: canonical.confidence,
        agreement: canonical.agreement.state,
        active_incidents: canonical.active_incidents,
        max_incident_severity: canonical.max_incident_severity,
        summary: canonical.summary,
        status_reason: canonical.status_reason,
        risk_factors: canonical.risk_factors,
        confidence_reason: canonical.confidence_reason,
        agreement_reason: canonical.agreement_reason,
        staleness_seconds: canonical.staleness_seconds,
        last_updated: canonical.last_updated,
        api_version: canonical.api_version,
        last_24h: getLast24h(),
        // additive in 1.1
        data_quality_reason: canonical.data_quality_reason,
        observed_at: canonical.observed_at,
        height_last_advanced_at: canonical.height_last_advanced_at,
        height_static_seconds: canonical.height_static_seconds,
        active_public_conditions: canonical.active_public_conditions,
        agreement_detail: { aligned_nodes: canonical.agreement.aligned_nodes, total_nodes: canonical.agreement.total_nodes, median_block: canonical.agreement.median_block, block_spread: canonical.agreement.block_spread },
        // additive in 1.2: what the reading rests on (counts and one time; never a key, an address or a height), and
        // the standstill limit status uses
        witnesses: canonical.witnesses,
        height_standstill_after_seconds: canonical.height_standstill_after_seconds
      };
      var orgHdrs = { "Content-Type": "application/json", "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*", "ETag": orgV.etag };
      if (orgV.lastModified) orgHdrs["Last-Modified"] = orgV.lastModified;
      res.writeHead(200, orgHdrs);
      res.end(JSON.stringify(organism, null, 2));
    } else if (reqPath === "/version") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(latestVersionData, null, 2));
    } else if (reqPath === "/docs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(applySiteKit(DOCS_HTML).replace("__AGENT_WALLET__", AGENT_WALLET ? escHtml(truncIdentity(AGENT_WALLET)) : "not connected"));
    } else if (KIT_ASSETS[reqPath]) {
      var kitAsset = KIT_ASSETS[reqPath];
      res.writeHead(200, { "Content-Type": kitAsset.type, "Content-Length": kitAsset.bytes.length, "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
      res.end(kitAsset.bytes);
    } else if (reqPath === MARK_ASSET_PATH) {
      if (!MARK_ASSET) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": MARK_ASSET.length, "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
      res.end(MARK_ASSET);
    } else if (reqPath === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*", "Link": "</organism>; rel=\"alternate\"; type=\"application/json\", </organism/schema>; rel=\"describedby\"" });
      res.end(renderHomepageNoJs(HOMEPAGE_HTML));
    } else if (reqPath === "/home") {
      res.writeHead(301, { "Location": "/" });
      res.end();
    } else if (reqPath === "/sources") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(SOURCES_HTML);
    } else if (reqPath === "/reference") {
      if (!sharedDb) { res.writeHead(200, {"Content-Type":"text/html"}); res.end("<h1>No data</h1>"); return; }
      function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
      var h = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reference · Demos Network Oracle</title>' + siteHead();
      h += '<style>.ref-body{padding-block:32px 72px}.ref-sec + .ref-sec{margin-top:48px;padding-top:32px;border-top:1px solid var(--line)}'
        + '.ref-sec h2{font-size:1.375rem;font-weight:500;color:var(--metal-2);margin-bottom:8px}.ref-note{color:var(--metal-1);max-width:46rem;margin-bottom:6px}'
        + '.ref-meta{font:400 .8125rem/1.5 var(--mono);color:var(--mute);margin:8px 0 14px}.ref-tbl td{font-family:var(--mono);font-size:.875rem}'
        + '.ref-tbl .nm{font-family:var(--sans);color:var(--ink)}.ref-tbl .id{display:block;color:var(--mute);font-size:.75rem;margin-top:2px}'
        + '.lampt{display:inline-flex;align-items:baseline;gap:8px;white-space:nowrap}.ref-empty{color:var(--mute);padding:12px 0}</style></head><body>';
      h += siteHeader("reference");
      h += '<main id="main"><header class="doc-head"><div class="wrap"><div><h1>Reference</h1>'
        + '<p class="doc-lede">Two tables. Neither enters status, risk or agreement. Neither is a validator list, a stake list or an official-node list.</p></div></div></header>'
        + '<div class="wrap ref-body">';

      // --- Fleet Fixnet section (v7.2) ---
      var fx = latestFixnetNodes || [];
      var fxDiscovered = latestDiscoveredFixnet || []; // populated by Change 8; empty until then
      if (fx.length > 0) {
        var fxAnchorN = fx.find(function(n){return n.source_type==="anchor"});
        var fxFleetN = fx.filter(function(n){return n.source_type==="fleet"});
        var fxNetHead = fxAnchorN && fxAnchorN.block ? fxAnchorN.block : 0;
        // R-A 2026-08-25 P0: public counts = anchor + discovered only (operator fleet excluded)
        var fxMonitoredPublic = fxAnchorN ? [fxAnchorN] : [];
        var fxTotalN = fxMonitoredPublic.length + fxDiscovered.length;
        var fxMonitoredOnlineN = fxMonitoredPublic.filter(function(n){return n.ok}).length;
        var fxDiscoveredOnlineN = fxDiscovered.filter(function(n){return n.online}).length;
        var fxOnlineN = fxMonitoredOnlineN + fxDiscoveredOnlineN;
        var fxMonitoredAtHeadN = fxMonitoredPublic.filter(function(n){return n.ok && n.block && fxNetHead>0 && (fxNetHead - n.block) <= 100}).length;
        var fxDiscoveredAtHeadN = fxDiscovered.filter(function(n){return n.online && n.block && fxNetHead>0 && (fxNetHead - n.block) <= 100}).length;
        var fxAtHeadN = fxMonitoredAtHeadN + fxDiscoveredAtHeadN;
        // "Nodes syncing" stats — anchor + discovered (operator fleet excluded)
        var fxAllSyncingRows = fxDiscovered.map(function(d){return {ok:d.online, block:d.block}});
        if (fxAnchorN) fxAllSyncingRows.unshift(fxAnchorN);
        var fxAllAtHeadN = fxAllSyncingRows.filter(function(n){return n.ok && n.block && fxNetHead>0 && (fxNetHead - n.block) <= 100}).length;
        var fxAllSyncingN = fxAllSyncingRows.length - fxAllAtHeadN;
        var fxAllLags = fxAllSyncingRows.filter(function(n){return n.block && fxNetHead>0 && (fxNetHead - n.block) > 100}).map(function(n){return fxNetHead - n.block}).sort(function(a,b){return a-b});
        var fxAllMedianLag = fxAllLags.length ? fxAllLags[Math.floor(fxAllLags.length/2)] : 0;
        // Updated-ago for section subtitle
        var fxAgoStr = "";
        if (fixnetObservedAt) {
          var agoSec = Math.max(0, Math.round((Date.now() - fixnetObservedAt) / 1000));
          fxAgoStr = agoSec < 60 ? (agoSec + "s ago") : (Math.round(agoSec/60) + "m ago");
        }

        h += '<section class="ref-sec" id="fixnet">';
        h += '<h2>Fixnet probe</h2>';
        h += '<p class="ref-note">DNO dials these fixnet endpoints when the advertised address is a public http origin. reachable here means that probe answered; not probed means DNO did not dial the row. Heights are the latest reported by a peerlist DNO reads (its operator\'s fixnet nodes\', or an anchor\'s when one is configured) or by the DNO probe, whichever came last. This is not the public testnet catalog: an identity the public seeds\' peerlists list is not kept in this table and is not dialed for it.</p>';
        h += '<p class="ref-meta">' + (fxAgoStr ? 'Updated ' + fxAgoStr : '') + '</p>';
        var fxNotProbedN = fxDiscovered.filter(function(n){return n.probed === false}).length;
        h += '<p class="ref-meta">' + fxTotalN + ' hosts in this table · ' + fxOnlineN + ' answered the fixnet probe' + (fxNotProbedN ? ' · ' + fxNotProbedN + ' not probed' : '') + ' · not a count of the public testnet, not network size</p>';


        h += '<div class="tbl-wrap"><table class="tbl stack ref-tbl"><thead><tr>';
        h += '<th>Name</th><th>Source</th><th>Probe</th><th class="num">Block</th><th class="num">Height vs anchor</th><th class="num">Latency</th>';
        h += '</tr></thead><tbody>';

        // Build ordered rows: Anchor, then Fleet (status then block desc), then Discovered (status then block desc)
        var fxFleetSorted = fxFleetN.slice().sort(function(a,b){
          if (a.ok !== b.ok) return a.ok ? -1 : 1;
          return (b.block||0) - (a.block||0);
        });
        var fxDiscSorted = fxDiscovered.slice().sort(function(a,b){
          var ra = a.online ? 0 : a.probed === false ? 2 : 1, rb = b.online ? 0 : b.probed === false ? 2 : 1;  // reachable, unreachable, not probed
          if (ra !== rb) return ra - rb;
          return (b.block||0) - (a.block||0);
        });

        var fxRows = [];
        if (fxAnchorN) fxRows.push({kind:"anchor", data:fxAnchorN});
        // R-A 2026-08-25 P0: operator fleet rows stay off the public /reference table
        for (var dli=0; dli<fxDiscSorted.length; dli++) fxRows.push({kind:"discovered", data:fxDiscSorted[dli]});

        for (var fxi=0; fxi<fxRows.length; fxi++) {
          var rowKind = fxRows[fxi].kind;
          var fn = fxRows[fxi].data;
          var isAnchor = rowKind === "anchor";
          var isFleet = rowKind === "fleet";
          var isDisc = rowKind === "discovered";

          // Trust tier: Kynesys anchor = trust origin, everything else = observed/discovered.
          // Operator names (if any) move to the Validator column, not the Source column.
          var srcLabel = isAnchor ? "Kynesys" : "Discovered";

          // Status resolution: monitored uses .ok, discovered uses .online
          var isOnline = isDisc ? !!fn.online : !!fn.ok;
          var statusTone = isOnline ? "ok" : "neutral";   // reachable, or unreachable (neutral: reachability from this vantage, not liveness)
          var statusText = isOnline ? "reachable" : "unreachable";
          if (isDisc && fn.probed === false) { statusTone = "unknown"; statusText = "not probed"; }



          // Block
          var block = fn.block || fn.last_block || null;
          var vsAnchor = (block && fxNetHead > 0) ? block - fxNetHead : null;   // blocks against the anchor's height, as reported

          // Latency (only meaningful for monitored; discovered has no current-cycle latency)
          // v7.3: show latency for discovered too (populated by probeDiscoveredFixnetNodes)
          var latencyStr = (fn.latencyMs != null) ? (fn.latencyMs + "ms") : "\u2014";

          // Validator cell: public observation names only (no operator-fleet join).
          //  - Anchor: "Kynesys Anchor"
          // Discovered rows: discovered-<last4>. Operator names do not feed this table.
          var nameLabel;
          if (isAnchor) {
            nameLabel = "Kynesys Anchor";
          } else {
            nameLabel = "discovered-" + (fn.identity ? fn.identity.substring(fn.identity.length-4) : "????");
          }
          var identity = fn.identity || "";

          h += '<tr>';
          // Validator (with identity sub-line)
          h += '<td data-label="Name"><span class="nm">' + esc(nameLabel) + '</span><span class="id">' + esc(truncId(identity)) + '</span></td>';
          h += '<td data-label="Source"><span class="tag" style="margin:0">' + srcLabel + '</span></td>';
          h += '<td data-label="Probe"><span class="lampt"><span class="ind" data-tone="' + statusTone + '"></span>' + statusText + '</span></td>';
          h += '<td data-label="Block" class="num">' + heightCell(block) + '</td>';
          h += '<td data-label="Height vs anchor" class="num">' + (vsAnchor === null ? "not reported" : (vsAnchor === 0 ? "same" : (vsAnchor > 0 ? "+" : "") + vsAnchor)) + '</td>';
          h += '<td data-label="Latency" class="num">' + latencyStr + '</td>';
          h += '</tr>';
        }
        h += '</tbody></table></div>';

        // v7.3: "Nodes syncing" — across ALL rows (anchor + fleet + discovered)
        h += '<p class="ref-meta">Advertised heights on this fixnet probe, relative to the fixnet anchor this cycle. Not a public-testnet census.</p>';
        h += '</section>';
      }
      // --- end Fleet Fixnet section ---

      // Fleet diagnostics — read from cached health data
      var fleetReports = {};
      try {
        if (latestHealthData && latestHealthData.nodeReports) {
          for (var nri = 0; nri < latestHealthData.nodeReports.length; nri++) {
            var nr = latestHealthData.nodeReports[nri];
            fleetReports[nr.name] = nr;
          }
        }
      } catch(e) {}
      // Catalog minus monitored (validator_discoveries). Not the cycle set.
      // Call getValidatorGrowth() directly - same source /health uses.
      // latestHealthData does NOT contain validator_growth; that field is
      // built fresh at request time by the /health handler.
      var discoveredList = [];
      try {
        var vgrow = getValidatorGrowth();
        if (vgrow && Array.isArray(vgrow.validators)) {
          discoveredList = vgrow.validators.filter(function(v){ return !v.monitored; });
        }
      } catch(e) { discoveredList = []; }
      h += '<section class="ref-sec" id="peer-listed">';
      h += '<h2>Peer-listed identities</h2>';
      h += '<p class="ref-note">Peer-listed identities from the public seeds. Not dialed. Not the on-chain validators table. Not a census of Demos beta. Kept after two public peerlists have listed them; what is shown is what those peerlists reported, not a probe.</p>';
      if (discoveredList.length === 0) {
        h += '<p class="ref-empty">None in this set.</p>';
      } else {
        h += '<div class="tbl-wrap"><table class="tbl stack ref-tbl"><thead><tr><th>Identity</th><th>peer-reported</th><th class="num">Height</th><th class="num">vs highest seed</th></tr></thead><tbody>';
        for (var dvi = 0; dvi < discoveredList.length; dvi++) {
          var dv = discoveredList[dvi];
          var dvListed = dv.listed_this_cycle !== false;
          var dvStatusText = !dvListed ? "not listed in the latest crawl" : dv.online === true ? "online flag set" : "online flag not set";
          h += '<tr>';
          h += '<td data-label="Identity">' + esc(truncId(dv.identity)) + '</td>';
          h += '<td data-label="peer-reported">' + dvStatusText + '</td>';
          h += '<td data-label="Height" class="num">' + heightCell(dv.block) + '</td>';
          h += '<td data-label="vs highest seed" class="num">' + (typeof dv.lag === "number" ? (dv.lag === 0 ? "same" : (dv.lag > 0 ? "−" + dv.lag : "+" + (-dv.lag))) : "not reported") + '</td>';
          h += '</tr>';
        }
        h += '</tbody></table></div>';
      }

      h += '</section></div></main>' + siteFooter("reference") + '</body></html>';
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      res.end(h);
    } else if (reqPath === "/agent") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(AGENT_GUIDE_HTML);
    } else if (reqPath === "/timeline") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(renderTimelinePage());
    } else if (reqPath === "/about-demos") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(ABOUT_DEMOS_HTML);
    } else if (reqPath === "/methodology") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(METHODOLOGY_HTML);
    } else if (reqPath === "/criteria") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(CRITERIA_HTML);
    } else if (reqPath === "/criteria.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(CRITERIA_JSON);
    } else if (reqPath === "/commerce") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(COMMERCE_HTML);
    } else if (reqPath === "/commerce/observations") {
      var pubObs = buildPublicCommerceObservation();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30" });
      res.end(JSON.stringify(pubObs, null, 2));
    } else if (reqPath === "/commerce/methodology") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(COMMERCE_METHODOLOGY_HTML);
    } else if (reqPath === "/private/commerce/status" || reqPath.indexOf("/private/commerce/status/") === 0) {
      res.removeHeader("Access-Control-Allow-Origin");
      var pcTk = req.headers["x-dno-admin-token"];
      if (!adminTokenMatches(Array.isArray(pcTk) ? pcTk[0] : pcTk, DNO_ADMIN_TOKEN)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      try {
        var rawCommerce = readFileSync("data/commerce-last-check.json", "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(rawCommerce);
      } catch(e) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"commerce-last-check.json not available","detail":"' + (e.message || 'unknown') + '"}');
      }
    } else if (reqPath === "/badge") {
      var bCanonical = computeCanonicalState();
      var bStatus = bCanonical.status;
      var bColor = bStatus === "stable" ? "#4c1" : bStatus === "degraded" ? "#dfb317" : bStatus === "unstable" ? "#e05d44" : "#999";
      var bIcon = bStatus === "stable" ? "\u2713" : bStatus === "unknown" ? "?" : "\u26a0";
      var bLabel = bStatus.toUpperCase();
      var bWidth = bLabel.length * 8 + 20;
      var bSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (46 + bWidth) + '" height="20" role="img">' +
        '<rect width="46" height="20" fill="#555" rx="3"/><rect x="46" width="' + bWidth + '" height="20" fill="' + bColor + '" rx="3"/>' +
        '<rect x="46" width="4" height="20" fill="' + bColor + '"/>' +
        '<text x="23" y="14" fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11">Oracle</text>' +
        '<text x="' + (46 + bWidth/2) + '" y="14" fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11">' + bLabel + ' ' + bIcon + '</text></svg>';
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
      res.end(bSvg);
    } else if (reqPath === "/sentinel") {
      // Counts only on the public listener: alert keys name fleet nodes. Unknown when the sentinel file is unreadable.
      // The file is in the log directory (sentinel-state.mjs): this service's /tmp is private, the sentinel's is not.
      var sentinelData = { status: "unknown", last_check: null, alerts_24h: null };
      try {
        var dedup = JSON.parse(readFileSync(sentinelStatePath(LOG_DIR), "utf8"));
        var sNow = Date.now();
        var recentKeys = Object.keys(dedup).filter(function(k) { return k.charAt(0) !== "_" && typeof dedup[k] === "number" && sNow - dedup[k] < 86400000; });
        // "ok" only when the sentinel completed a check in the last 15 minutes (it polls every 5); otherwise unknown.
        var lastCheck = typeof dedup._lastCheck === "number" ? dedup._lastCheck : null;
        var fresh = lastCheck !== null && sNow - lastCheck < 15 * 60000;
        sentinelData = { status: fresh ? "ok" : "unknown", last_check: lastCheck !== null ? new Date(lastCheck).toISOString() : null, alerts_24h: fresh ? recentKeys.length : null };
        if (internal) sentinelData.recent_alert_keys = recentKeys;
      } catch (se) { /* file missing or unreadable: status stays unknown */ }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(sentinelData, null, 2));
    } else if (reqPath === "/dashboard") {
      var dashHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Demos Fleet Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px}
h1{color:#58a6ff;margin-bottom:4px;font-size:1.4em}
.sub{color:#8b949e;font-size:0.85em;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.node{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;text-align:center}
.node.healthy{border-color:#238636}.node.unhealthy{border-color:#da3633}.node.unknown{border-color:#8b949e}
.node h3{font-size:1.1em;margin-bottom:6px}.node .status{font-size:0.8em;margin-bottom:4px}
.node .block{color:#8b949e;font-size:0.75em}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
.metric{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.metric .label{color:#8b949e;font-size:0.8em}.metric .value{font-size:1.4em;font-weight:bold;margin-top:4px}
.safe{color:#3fb950}.caution{color:#d29922}.unsafe{color:#f85149}.unknown{color:#8b949e}
.sla{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px}
.sla h2{color:#58a6ff;font-size:1.1em;margin-bottom:12px}
.sla table{width:100%;border-collapse:collapse;font-size:0.85em}
.sla th{color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d}
.sla td{padding:6px 8px;border-bottom:1px solid #21262d}
.sla tr:last-child td{border-bottom:none}
.uptime-bar{background:#21262d;border-radius:4px;height:8px;width:100%;margin-top:4px}
.uptime-fill{height:8px;border-radius:4px;background:#238636}
.uptime-fill.warn{background:#d29922}.uptime-fill.bad{background:#da3633}
.chart-box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px}
.chart-box h2{color:#58a6ff;font-size:1.1em;margin-bottom:12px}
.incidents{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px}
.incidents h2{color:#58a6ff;font-size:1.1em;margin-bottom:12px}
.inc{padding:8px 0;border-bottom:1px solid #21262d;font-size:0.85em}
.inc:last-child{border-bottom:none}
.inc .id{color:#58a6ff;font-weight:bold}.inc .sev{padding:2px 6px;border-radius:4px;font-size:0.75em}
.sev.critical{background:#da3633;color:#fff}.sev.warning{background:#d29922;color:#fff}.sev.info{background:#388bfd;color:#fff}
.footer{color:#484f58;font-size:0.75em;text-align:center;margin-top:20px}
.rec-box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px;text-align:center}
.rec-box .rec{font-size:1.6em;font-weight:bold;margin-bottom:4px}
.rec-box .reason{color:#8b949e;font-size:0.85em}
</style></head><body>
<div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
  <h1 style="margin:0">Demos Network Oracle</h1>
  <span style="font-size:0.75em;color:#484f58" id="updated">Loading...</span>
</div>
<div class="rec-box"><div class="rec" id="rec">—</div><div class="reason" id="rec-reason">—</div></div>

<!-- SECTION 1: Summary cards — public network focused -->
<div class="metrics" id="metrics"></div>

<!-- SECTION 2: Network Agreement Panel -->
<div id="agreement-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
  <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">📡 Network Agreement</h2>
  <div id="agreement-status">Loading...</div>
</div>

<!-- SECTION 2a: Last 24 Hours -->
<div id="last-24h-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
  <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">📊 Last 24 Hours</h2>
  <div id="last-24h-content">Loading...</div>
</div>

<!-- SECTION 2b: Network Growth -->
<div id="growth-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
  <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">\ud83d\udcc8 Network Growth</h2>
  <div id="growth-status">Loading...</div>
</div>

<!-- SECTION 3: Public network nodes -->
<div class="public-nodes" id="pub-nodes" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
  <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">Public network nodes</h2>
  <div id="pub-list">Loading...</div>
</div>

<!-- SECTION 4: Network Intelligence -->
<div id="decision-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
  <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">🧠 Network Intelligence</h2>
  <div id="decision-status">Loading...</div>
</div>

<!-- SECTION 5: Network signals — network-level only -->
<div id="signals-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
  <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">Network signals</h2>
  <div id="signals-list">Loading...</div>
</div>

<!-- SECTION 6: Incidents -->
<div class="incidents"><h2>Recent Incidents</h2><div id="inc-list">Loading...</div></div>

<!-- SECTION 7: Reference layer — fleet nodes (secondary, collapsed) -->
<details style="margin-bottom:24px">
  <summary style="cursor:pointer;color:#484f58;font-size:0.9em;font-weight:500;padding:10px 0;user-select:none">
    🔧 Reference Layer — Fleet nodes (${FLEET_SIZE} nodes)
  </summary>
  <div style="margin-top:12px">
    <div class="grid" id="nodes"></div>
    <div id="sentinel-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px;margin-top:12px">
      <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">🛡️ Sentinel v1</h2>
      <div id="sentinel-status">Loading...</div>
    </div>
    <div id="rep-box" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px">
<!-- reputation panel removed: Path 2, 2026-06-10 -->
    </div>
    <div class="sla"><h2>Node SLA — uptime</h2>
      <table><thead><tr><th>Identity</th><th>Block</th><th>Uptime</th><th></th></tr></thead>
      <tbody id="sla-body"></tbody></table>
    </div>
    <div class="chart-box"><h2>Block height (last 24h)</h2><canvas id="blk-chart" style="width:100%;height:120px;display:block"></canvas></div>
    <div class="incidents" style="margin-top:16px"><h2>Fleet Incidents</h2><div id="fleet-inc-list">Loading...</div></div>
  </div>
</details>

<!-- SECTION 8: How we know -->
<div style="background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px 16px;margin-bottom:24px;font-size:0.82em;color:#8b949e">
  <span style="color:#58a6ff;font-weight:600">How we know</span> &nbsp;·&nbsp;
  Public network observed via <span id="hw-public-count">—</span> public nodes &nbsp;·&nbsp;
  Updated every 20s &nbsp;·&nbsp;
  Data quality: <span id="hw-quality">—</span> &nbsp;·&nbsp;
  <a href="/methodology" style="color:#58a6ff">Methodology</a>
</div>

<div class="footer" style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap">
  <span>Demos Network Oracle v${AGENT_VERSION}</span>
  <span class="dno-tagline">DNO informs context; it does not advise, predict, score, certify, or decide action.</span>
  ${latestAttestationState.lastCount > 0
    ? '<span style="color:#c8c8c8;font-weight:600">DAHR on cross-check RPCs: ' + latestAttestationState.lastCount + '</span>'
    : '<span style="color:#8b949e;font-weight:600" title="DAHR attestation currently unavailable">DAHR attestation unavailable</span>'}
  <span style="display:flex;align-items:center;gap:5px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:3px 8px;font-size:0.78em">powered by <img src="https://framerusercontent.com/assets/IyyrITqCg67NykDbX6dibaTrhfA.svg" height="14" style="vertical-align:middle;filter:brightness(10)"></span>
  <span style="color:#444">|</span>
  <a href="/docs" style="color:#58a6ff">Docs</a>
  <a href="https://github.com/xm33/demos-network-oracle" style="color:#58a6ff">GitHub</a>
</div>
<script>
function drawChart(hist){
  var canvas=document.getElementById("blk-chart");
  if(!canvas||!hist||hist.length<2)return;
  var dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr;canvas.height=120*dpr;
  var ctx=canvas.getContext("2d");ctx.scale(dpr,dpr);
  var pts=hist.slice(-72);
  var blocks=pts.map(function(p){return p.block||0}).filter(Boolean);
  if(!blocks.length)return;
  var minB=Math.min.apply(null,blocks),maxB=Math.max.apply(null,blocks),range=maxB-minB||1;
  var W=canvas.offsetWidth,H=120,PAD=28;
  ctx.clearRect(0,0,W,H);
  ctx.strokeStyle="#238636";ctx.lineWidth=2;ctx.beginPath();
  var first=true;
  pts.forEach(function(p,i){
    if(!p.block)return;
    var x=PAD+(i/(pts.length-1))*(W-PAD*2);
    var y=(H-PAD)-((p.block-minB)/range)*(H-PAD*2);
    first?(ctx.moveTo(x,y),first=false):ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.fillStyle="#8b949e";ctx.font="11px sans-serif";
  ctx.fillText(maxB.toLocaleString(),4,14);
  ctx.fillText(minB.toLocaleString(),4,H-4);
  var t0=pts[0]&&new Date(pts[0].ts),t1=pts[pts.length-1]&&new Date(pts[pts.length-1].ts);
  if(t0)ctx.fillText(t0.toLocaleTimeString(),PAD,H-2);
  if(t1){ctx.textAlign="right";ctx.fillText(t1.toLocaleTimeString(),W-4,H-2);}
}
// Incidents arrive already scoped by the server (/incidents serves public scope on the public listener).
function isFleetIncident(inc) { return inc && inc.scope === "fleet"; }
function escD(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function render24hSummary(s) {
  if (!s) return '<div style="color:#8b949e;font-size:0.85em">Summary unavailable.</div>';

  if (!s.sufficient) {
    return '<div style="color:#8b949e;font-size:0.9em;font-style:italic">' +
      (s.message || "Insufficient observation in the last 24 hours.") + '</div>';
  }

  var coverageLine = (s.coverage_pct >= 99.0)
    ? 'coverage 24/24h'
    : 'coverage ' + s.coverage_pct + '% of window';

  var rows = [];

  var nodesLine = s.peak_set
    ? 'typically ' + s.typical_set_size + ', peak ' + s.peak_set.size
    : String(s.typical_set_size);
  rows.push(['Public nodes observed', nodesLine, '#c9d1d9']);

  if (s.peak_set) {
    var peakLine = s.peak_set.size + ' nodes observed; ' +
                   s.peak_set.avg_reachable.toFixed(1) +
                   ' answered on average across ' +
                   s.peak_set.cycles + ' cycles';
    rows.push(['Peak observation window', peakLine, '#c9d1d9']);
  }

  var cmCol = s.chain_movement.state === 'normal' ? '#3fb950'
            : s.chain_movement.state === 'interrupted' ? '#d29922'
            : '#8b949e';
  rows.push(['Chain movement', s.chain_movement.state, cmCol]);

  var nsLine = s.longest_non_stable_minutes > 0
    ? s.longest_non_stable_minutes + 'm'
    : 'none observed';
  rows.push(['Longest non-stable interval', nsLine, '#c9d1d9']);

  var incCol = s.active_critical_public_incidents > 0 ? '#f85149' : '#3fb950';
  rows.push(['Active critical public incidents', String(s.active_critical_public_incidents), incCol]);

  var html = '<div style="display:flex;justify-content:flex-end;font-size:0.75em;color:#8b949e;margin-bottom:8px">' +
             coverageLine + '</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:0.9em">';
  rows.forEach(function(r) {
    html += '<tr>' +
      '<td style="padding:6px 0;color:#8b949e;width:45%">' + r[0] + '</td>' +
      '<td style="padding:6px 0;color:' + r[2] + ';font-weight:500">' + r[1] + '</td>' +
      '</tr>';
  });
  html += '</table>';
  return html;
}
async function refresh(){
  try{
    var r=await fetch("/health");var d=await r.json();
    var pubBlock = (d.agreement&&(d.agreement.max_block||d.agreement.median_block)) || "?";
    var pubTotal = (d.agreement&&d.agreement.total_nodes) || "?";
    var pubAligned = (d.agreement&&d.agreement.aligned_nodes) || "?";
    document.getElementById("updated").textContent="Block "+pubBlock+
      " | "+pubAligned+"/"+pubTotal+" public nodes | Updated "+new Date(d.last_updated).toLocaleTimeString()+
      " | Staleness "+(d.staleness_seconds||0)+"s";
    var re=document.getElementById("rec");
    re.textContent=(d.status||"unknown").toUpperCase();
    re.className="rec "+(d.status==="stable"?"safe":d.status==="degraded"?"caution":d.status==="unstable"?"unsafe":"unknown");
    document.getElementById("rec-reason").textContent=(d.status_reason||"")+" · Risk: "+(d.risk||"?").toUpperCase()+" · Confidence: "+(d.confidence||"?").toUpperCase();
    var mg=document.getElementById("metrics");mg.innerHTML="";
    // Summary cards — public network focused only
    if(d.agreement){
      var na=d.agreement;
      var agCol=na.state==="strong"?"#3fb950":na.state==="moderate"?"#d29922":"#f85149";
      mg.innerHTML+='<div class="metric"><div class="label">Network Block</div><div class="value">'+(na.max_block||na.median_block||"?")+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Agreement</div><div class="value" style="color:'+agCol+'">'+na.state.toUpperCase()+'</div></div>';
      var compared=typeof na.aligned_nodes==="number"&&typeof na.block_spread==="number";
      mg.innerHTML+='<div class="metric"><div class="label">Public Nodes</div><div class="value">'+(compared?na.aligned_nodes+'/'+na.total_nodes+' aligned':'not computed')+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Block Spread</div><div class="value" style="color:'+(!compared?"#8b949e":na.block_spread>100?"#f85149":na.block_spread>10?"#d29922":"#3fb950")+'">'+(compared?na.block_spread:'not computed')+'</div></div>';
    }
    var riskCol=d.risk==="low"?"#3fb950":d.risk==="elevated"?"#d29922":"#f85149";
    mg.innerHTML+='<div class="metric"><div class="label">Risk</div><div class="value" style="color:'+riskCol+'">'+d.risk.toUpperCase()+'</div></div>';
    var confCol=d.confidence==="clear"?"#3fb950":"#d29922";
    mg.innerHTML+='<div class="metric"><div class="label">Confidence</div><div class="value" style="color:'+confCol+'">'+d.confidence.toUpperCase()+'</div></div>';
    mg.innerHTML+='<div class="metric"><div class="label">Active Incidents</div><div class="value">'+d.active_incidents+'</div></div>';

    // Network agreement panel
    var agBox=document.getElementById("agreement-status");
    if(agBox&&d.agreement){
      var na=d.agreement;
      var agCol=na.state==="strong"?"#3fb950":na.state==="moderate"?"#d29922":"#f85149";
      var html='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Agreement</div><div style="font-size:1.1em;font-weight:bold;color:'+agCol+'">'+na.state.toUpperCase()+'</div></div>';
      var cmp=typeof na.aligned_nodes==="number"&&typeof na.block_spread==="number";
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Aligned</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+(cmp?na.aligned_nodes+'/'+na.total_nodes:'not computed')+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Median Block</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+(na.median_block||"?")+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Block Spread</div><div style="font-size:1.1em;font-weight:bold;color:'+(!cmp?"#8b949e":na.block_spread>100?"#f85149":na.block_spread>10?"#d29922":"#3fb950")+'">'+(cmp?na.block_spread:'not computed')+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Agreement %</div><div style="font-size:1.1em;font-weight:bold;color:'+(cmp?agCol:"#8b949e")+'">'+(cmp&&na.total_nodes>0?Math.round(na.aligned_nodes/na.total_nodes*100)+'%':'not computed')+'</div></div>';
      html+='</div>';
      // The API's own reason string; no aligned/outlier claim of the dashboard's own.
      html+='<div style="font-size:0.82em;color:#8b949e;margin-top:4px">'+escD(d.agreement_reason||"")+'</div>';
      agBox.innerHTML=html;
    }

    // Last 24 Hours panel
    var l24Box = document.getElementById("last-24h-content");
    if (l24Box && d.last_24h) {
      l24Box.innerHTML = render24hSummary(d.last_24h);
    }

    // How we know box
    var hwPublic=document.getElementById("hw-public-count");
    var hwQuality=document.getElementById("hw-quality");
    if(hwPublic&&d.agreement) hwPublic.textContent=d.agreement.total_nodes;
    if(hwQuality&&d.data_quality) hwQuality.textContent=d.data_quality.toUpperCase();
    var gb=document.getElementById("growth-status");
    if(gb&&d.validator_growth){
      var vg=d.validator_growth;
      var gh='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
      // Catalog and probed seeds are separate populations; their counts are never added or mixed.
      function card(label,val){return '<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">'+label+'</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+escD(val)+'</div></div>';}
      gh+=card('seen',vg.discovered)+card('seeds answered',vg.monitored_online)+card('at head',vg.monitored_at_head)+card('configured seeds',vg.monitored);
      gh+='</div>';
      gh+='<div style="font-size:0.82em;color:#8b949e;margin-bottom:8px">Peer-listed identities from the public seeds. Not dialed. Not the on-chain validators table. Not a census of Demos beta.</div>';
      // New identities: a window the count does not cover is "not reported", with the reason, never +0.
      var fc=vg.first_counted;
      var gl=[['today','today'],['week','this week'],['month','this month']].map(function(w){var n=fc?fc[w[0]]:vg[w[0]];return typeof n==='number'?'+'+n+' '+w[1]:w[1]+': not reported';}).join(' \u00b7 ')+(fc&&fc.reason?' ('+fc.reason+')':'');
      gh+='<div style="font-size:0.82em;color:#8b949e;margin-bottom:12px">'+escD(gl)+'</div>';
      if(vg.validators&&vg.validators.length>0){
        gh+='<table style="width:100%;border-collapse:collapse;font-size:0.85em"><thead><tr><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Validator</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Block</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Sync</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Status</th><th style="color:#8b949e;text-align:right;padding:4px 8px;border-bottom:1px solid #21262d">Since</th></tr></thead><tbody>';
        vg.validators.forEach(function(v){
          // No grades: seeds show what DNO dialed; catalog rows show what a peerlist reported this cycle.
          var statusText=v.monitored?(v.online?'probed seed \u00b7 answered':'probed seed \u00b7 no answer'):(v.listed_this_cycle?(v.online?'reported online':'not reported'):'not listed this cycle');
          var since=v.first_seen_hours_ago<24?v.first_seen_hours_ago+'h ago':Math.round(v.first_seen_hours_ago/24)+'d ago';
          gh+='<tr><td style="padding:6px 8px;border-bottom:1px solid #21262d"><b>'+escD(v.display)+'</b></td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(typeof v.block==='number'?v.block.toLocaleString():'not observed')+'</td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;color:#8b949e">'+(v.monitored&&typeof v.sync_pct==='number'?v.sync_pct+'%':'\u2014')+'</td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d">'+statusText+'</td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;text-align:right;color:#8b949e">'+since+'</td></tr>';
        });
        gh+='</tbody></table>';
      }
      gb.innerHTML=gh;
    }
  }catch(e){document.getElementById("updated").textContent="Error: "+e.message;}
  try{
    var hr=await fetch("/history");var hd=await hr.json();
    drawChart(Array.isArray(hd)?hd:(hd.history||[]));
  }catch(e){}
  try{
    var db=document.getElementById("decision-status");
    if(db&&d.status){
      var statusCol=d.status==="stable"?"#3fb950":d.status==="degraded"?"#d29922":d.status==="unstable"?"#f85149":"#8b949e";
      var riskCol=d.risk==="low"?"#3fb950":d.risk==="elevated"?"#d29922":"#f85149";
      var html='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Status</div><div style="font-size:1.1em;font-weight:bold;color:'+statusCol+'">'+d.status.toUpperCase()+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Risk</div><div style="font-size:1.1em;font-weight:bold;color:'+riskCol+'">'+d.risk.toUpperCase()+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Confidence</div><div style="font-size:1.1em;font-weight:bold;color:'+(d.confidence==="clear"?"#3fb950":"#d29922")+'">'+d.confidence.toUpperCase()+'</div></div>';
      var dqCol=d.data_quality==="sufficient"?"#3fb950":"#d29922";
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Data Quality</div><div style="font-size:1.1em;font-weight:bold;color:'+dqCol+'">'+d.data_quality.toUpperCase()+'</div></div>';
      html+='</div>';
      html+='<div style="font-size:0.82em;color:#8b949e;padding:8px 0;border-top:1px solid #21262d;margin-top:4px">'+(d.status_reason||'')+'</div>';
      db.innerHTML=html;
    }
    // NON-AUTHORITATIVE display filter. The server-side projection in
    // signal-projection.mjs (toPublicSignals, applied at the /health serializer) is
    // the load-bearing privacy control — /health emits only public types. This
    // client filter is redundant defense-in-depth; do NOT delete the server
    // projection believing this covers it (it runs post-network, browser-side only).
    var FLEET_SIGNAL_TYPES = ["node_offline","block_lag","not_synced","not_ready","identity_mismatch","low_online_count","block_divergence","chain_stall"];
    if(d.signals) d.signals = d.signals.filter(function(s){ return FLEET_SIGNAL_TYPES.indexOf(s.type) === -1; });
    if(d.signals_grouped) {
      ["critical","warning","info"].forEach(function(sev){
        if(d.signals_grouped[sev]) d.signals_grouped[sev] = d.signals_grouped[sev].filter(function(s){ return FLEET_SIGNAL_TYPES.indexOf(s.type) === -1; });
      });
    }
    var sl=document.getElementById("signals-list");
    if(sl&&d.signals&&d.signals.length>0){
      var sevColor={"info":"#58a6ff","warning":"#d29922","critical":"#f85149"};
      var sevIcon={"info":"\u2139\ufe0f","warning":"\u26a0\ufe0f","critical":"\ud83d\udd34"};
      var html="";
      d.signals.forEach(function(s){
        var col=sevColor[s.severity]||"#8b949e";
        var icon=sevIcon[s.severity]||"\u2139\ufe0f";
        html+='<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #21262d">';
        html+='<span style="font-size:14px;margin-top:1px">'+icon+'</span>';
        html+='<div style="flex:1">';
        html+='<span style="font-size:0.78em;font-weight:500;color:'+col+';text-transform:uppercase;letter-spacing:0.05em">'+s.type.replace(/_/g," ")+'</span>';
        if(s.nodes&&s.nodes.length>0) html+=' <span style="font-size:0.75em;color:#8b949e">['+s.nodes.join(", ")+']</span>';
        html+='<div style="font-size:0.82em;color:#c9d1d9;margin-top:2px">'+s.message+'</div>';
        html+='</div>';
        if(s.value!==null&&s.value!==undefined&&s.type!=="all_healthy"&&s.type!=="public_network_block"){
          html+='<span style="font-size:1.1em;font-weight:bold;color:'+col+'">'+s.value+'</span>';
        }
        html+='</div>';
      });
      sl.innerHTML=html;
    } else if(sl) { sl.innerHTML='<span style="color:#8b949e;font-size:0.85em">No signals yet</span>'; }
  }catch(e){}
  try{
    var sr=await fetch("/sentinel");var sd=await sr.json();
    var sb=document.getElementById("sentinel-status");
    if(sb){
      // /sentinel on the public listener: { status, last_check, alerts_24h } (counts only), or status "unknown".
      var known=sd&&sd.status==="ok"&&typeof sd.alerts_24h==="number";
      var n24=known?sd.alerts_24h:null;
      var html='<div style="display:flex;gap:16px;margin-bottom:12px">';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center"><div style="color:#8b949e;font-size:0.75em">Alerts 24h</div><div style="font-size:1.4em;font-weight:bold;color:'+(!known?"#8b949e":n24===0?"#3fb950":"#f85149")+'">'+(known?n24:"unknown")+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center"><div style="color:#8b949e;font-size:0.75em">Poll interval</div><div style="font-size:1.4em;font-weight:bold;color:#c9d1d9">5min</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center"><div style="color:#8b949e;font-size:0.75em">Detectors</div><div style="font-size:1.4em;font-weight:bold;color:#c9d1d9">5</div></div>';
      html+='</div>';
      if(!known){
        html+='<div style="color:#8b949e;font-size:0.85em">Sentinel state unknown: its record could not be read.</div>';
      } else if(n24===0){
        html+='<div style="color:#3fb950;font-size:0.85em">\u2705 No anomalies detected in last 24h</div>';
      } else {
        html+='<div style="font-size:0.82em;color:#8b949e">'+n24+' alert key'+(n24===1?'':'s')+' in the last 24 h. Details are on the internal listener.</div>';
      }
      sb.innerHTML=html;
    }
  }catch(e){}
  try{
    var pn=document.getElementById("pub-list");
    if(pn&&d.publicNodes&&d.publicNodes.length>0){
      var pt='<table style="width:100%;border-collapse:collapse;font-size:0.85em"><thead><tr><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Node</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Block</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Latency</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Peers</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Reachability</th></tr></thead><tbody>';
      d.publicNodes.forEach(function(n){
        pt+='<tr><td style="padding:6px 8px;border-bottom:1px solid #21262d"><b>'+n.name+'</b></td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.block||'?')+'</td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.latencyMs?n.latencyMs+'ms':'?')+'</td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.peers||'?')+'</td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.ok?'\u2705 reachable':'\u26aa unreachable')+'</td></tr>';
      });
      pt+='</tbody></table>';pt+='<div style="font-size:0.75em;color:#484f58;margin-top:8px">Reachability is from the Oracle\u2019s vantage point. \u201cUnreachable\u201d means the Oracle could not reach the node \u2014 not proof the node is down.</div>';
      pn.innerHTML=pt;
    } else if(pn) { pn.innerHTML='<span style="color:#8b949e">No public nodes data yet</span>'; }
  }catch(e){}
  try{
    var ir=await fetch("/incidents?limit=10");var id=await ir.json();
    var publicIncs = id.incidents ? id.incidents.filter(function(i){ return !isFleetIncident(i); }) : [];
    var fleetIncs = id.incidents ? id.incidents.filter(function(i){ return isFleetIncident(i); }) : [];
    var il=document.getElementById("inc-list");
    if(!publicIncs||publicIncs.length===0){il.innerHTML='<div style="color:#8b949e;font-size:0.85em">No network incidents recorded</div>';}
    else {
      il.innerHTML="";
      var MAX_INC=5;var incShown=0;
      publicIncs.forEach(function(inc){
        if(incShown>=MAX_INC)return;
        il.innerHTML+='<div class="inc"><span class="id">'+inc.id+'</span> <span class="sev '+inc.severity+'">'+inc.severity.toUpperCase()+'</span> '+inc.description+' <span style="color:#8b949e">'+( inc.status==="active"?"\u23F3 active":"\u2705 resolved in "+(inc.duration_seconds||"?")+"s")+'</span></div>';
        incShown++;
      });
      if(publicIncs.length>MAX_INC){il.innerHTML+='<div style="margin-top:8px;font-size:0.82em"><a href="/incidents" style="color:#58a6ff">View all '+publicIncs.length+' network incidents \u2192</a></div>';}
    }
    var fil=document.getElementById("fleet-inc-list");
    if(fil){
      if(!fleetIncs||fleetIncs.length===0){fil.innerHTML='<div style="color:#8b949e;font-size:0.85em">No fleet incidents recorded</div>';}
      else {
        fil.innerHTML="";
        var fincShown=0;
        fleetIncs.forEach(function(inc){
          if(fincShown>=5)return;
          fil.innerHTML+='<div class="inc"><span class="id">'+inc.id+'</span> <span class="sev '+inc.severity+'">'+inc.severity.toUpperCase()+'</span> '+inc.description+' <span style="color:#8b949e">'+( inc.status==="active"?"\u23F3 active":"\u2705 resolved in "+(inc.duration_seconds||"?")+"s")+'</span></div>';
          fincShown++;
        });
        if(fleetIncs.length>5){fil.innerHTML+='<div style="margin-top:8px;font-size:0.82em"><a href="/incidents" style="color:#58a6ff">View all \u2192</a></div>';}
      }
    }
  }catch(e){document.getElementById("updated").textContent="Error: "+e.message;}
}
refresh();setInterval(refresh,20000);
</script></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(dashHtml);
    } else if (reqPath === "/history/export" || reqPath.indexOf("/history/export/") === 0) {
      var expFrom = 0, expTo = Infinity;
      if (reqQuery.get("from")) expFrom = parseInt(reqQuery.get("from"), 10) || 0;
      if (reqQuery.get("to")) expTo = parseInt(reqQuery.get("to"), 10) || Infinity;
      var expData = history.filter(function(h) { return h.ts >= expFrom && h.ts <= expTo; });
      var csvLines = ["timestamp,block,tps,online_count"];
      for (var ei = 0; ei < NODE_NAMES.length; ei++) csvLines[0] += "," + NODE_NAMES[ei] + "_healthy," + NODE_NAMES[ei] + "_block";
      for (var ej = 0; ej < expData.length; ej++) {
        var eh = expData[ej];
        var row = [eh.ts, eh.block || "", eh.tps || "", eh.onlineCount || ""];
        for (var ek = 0; ek < NODE_NAMES.length; ek++) {
          var en = eh.nodes && eh.nodes[NODE_NAMES[ek]];
          row.push(en ? (en.healthy ? 1 : 0) : "");
          row.push(en && en.block != null ? en.block : "");
        }
        csvLines.push(row.join(","));
      }
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=fleet-history.csv", "Access-Control-Allow-Origin": "*" });
      res.end(csvLines.join("\n"));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found. Try /docs for API documentation." }));
    }
  }

  // A route that throws must not take the process down: answer 500 and keep serving.
  function safeHandle(internal) {
    return function(req, res) {
      try { handleRequest(req, res, internal); }
      catch (err) {
        logError("[http] " + String(req.method) + " " + String(req.url || "").slice(0, 120) + " failed: " + (err && err.message ? err.message : String(err)));
        try {
          if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal error." })); }
          else if (!res.writableEnded) res.end();
        } catch (e2) {}
      }
    };
  }
  var server = createServer(safeHandle(false));
  // The internal listener must never take the public port: with INTERNAL_PORT equal to HEALTH_PORT the internal
  // handler could answer public requests. Refuse that configuration instead of failing open.
  if (INTERNAL_PORT && INTERNAL_PORT === HEALTH_PORT) {
    logError("  INTERNAL_PORT equals HEALTH_PORT (" + HEALTH_PORT + "): the internal listener is not started. Fleet routes are not served.");
  } else if (INTERNAL_PORT) {
    var internalServer = createServer(safeHandle(true));
    internalServer.listen(INTERNAL_PORT, "127.0.0.1", function() { log("  Internal API (fleet routes) listening on 127.0.0.1:" + INTERNAL_PORT); });
    internalServer.on("error", function(err) { logError("Internal server error: " + err.message); });
  } else {
    log("  Fleet routes (/history, /history/*, /dashboard) are not served: they exist only on the internal listener. Set INTERNAL_PORT to enable it.");
  }

  server.listen(HEALTH_PORT, "127.0.0.1", function() {
    log("  Health API listening on port " + HEALTH_PORT);
  });

  server.on("error", function(err) {
    logError("Health server error: " + err.message);
    // Without the public listener this process must not keep serving on another handler: exit and let the
    // supervisor restart it.
    if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) process.exit(1);
  });
}

// --- Agent profile registration ---
async function registerAgentProfile() {
  try {
    var profilePayload = {
      address: AGENT_WALLET,
      name: AGENT_NAME,
      description: AGENT_DESCRIPTION,
      tags: ["infrastructure", "monitoring", "health-oracle", "node-health", "demos-network"],
      healthEndpoint: "https://demos-oracle.com/health",
    };
    var res = await fetch(SUPERCOLONY_API + "/api/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profilePayload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      var data = await res.json();
      log("  Agent profile registered: " + AGENT_NAME);
    } else {
      var body = await res.text();
      log("  Agent registration response: HTTP " + res.status + " " + body.substring(0, 200));
    }
  } catch (err) {
    log("  Agent registration skipped: " + err.message);
  }
}

// FIX BUG 3: Shared DB handle — declared here, opened in main()
let sharedDb = null;

async function checkBalance(demos) {
  try {
    var info = await withTimeout(demos.getAddressInfo(AGENT_WALLET), 10000, "getAddressInfo");
    if (!info || info.response === "Method not implemented: getAddressInfo") {
      log("  Balance check: getAddressInfo not implemented on this node version — skipping");
      return;
    }
    var bal = Number(info.balance);
    lastKnownBalance = bal;

    if (bal <= CRITICAL_BALANCE_THRESHOLD && balanceAlertLevel !== "critical") {
      balanceAlertLevel = "critical";
      log("  Balance CRITICAL: " + bal + " DEM");
      await sendTelegram("🔴 <b>BALANCE CRITICAL</b>\nWallet has " + bal + " DEM remaining. Agent will stop publishing soon. Fund immediately.");
    } else if (bal <= LOW_BALANCE_THRESHOLD && bal > CRITICAL_BALANCE_THRESHOLD && balanceAlertLevel !== "low" && balanceAlertLevel !== "critical") {
      balanceAlertLevel = "low";
      log("  Balance LOW: " + bal + " DEM");
      await sendTelegram("🟡 <b>BALANCE LOW</b>\nWallet has " + bal + " DEM remaining (threshold: " + LOW_BALANCE_THRESHOLD + "). Consider funding.");
    } else if (bal > LOW_BALANCE_THRESHOLD && balanceAlertLevel !== null) {
      log("  Balance recovered: " + bal + " DEM");
      balanceAlertLevel = null;
    } else {
      log("  Balance: " + bal + " DEM");
    }
  } catch (err) {
    log("  Balance check failed: " + err.message);
  }
}

async function probeFleetVersions() {
  log("  Probing fleet node versions...");
  var probes = NODE_NAMES.filter(function(n) { return n !== LOCAL_NODE_NAME; }).map(function(name) {
    var url = expectedConnStr(name) + "/info";
    return fetchInfo(url).then(function(result) {
      if (result.ok && result.data) {
        nodeVersions[name] = { version: result.data.version || null, versionName: result.data.version_name || null };
        log("    " + name + ": v" + (result.data.version || "?") + " " + (result.data.version_name || ""));
      }
    }).catch(function() {});
  });
  await Promise.all(probes);

  var versions = {};
  for (var vn in nodeVersions) {
    var v = nodeVersions[vn].version;
    if (v) { if (!versions[v]) versions[v] = []; versions[v].push(vn); }
  }
  var versionKeys = Object.keys(versions);
  if (versionKeys.length > 1 && !versionMismatchAlerted) {
    var mismatchStr = versionKeys.map(function(vk) { return vk + ": " + versions[vk].join(","); }).join(" | ");
    log("  VERSION MISMATCH: " + mismatchStr);
    await sendTelegram("\u26a0\ufe0f <b>VERSION MISMATCH</b>\n" + mismatchStr);
    versionMismatchAlerted = true;
  } else if (versionKeys.length <= 1 && versionMismatchAlerted) {
    versionMismatchAlerted = false;
    log("  Version mismatch resolved — all nodes on same version");
  }
}

async function main() {
  log("===============================================================");
  log("  Demos Network Oracle Agent v" + AGENT_VERSION);
  log("  Fleet: " + FLEET_SIZE + " nodes across 4 servers");
  log("  Interval: " + (INTERVAL_MS / 1000 / 60) + " minutes");
  log("  Cooldown: " + COOLDOWN_CYCLES + " cycles before alerting");
  log("  DAHR: attestation enabled (auto-detect SDK support)");
  log("  Daily summary: every " + DAILY_SUMMARY_CYCLES + " cycles (" + Math.round(DAILY_SUMMARY_CYCLES * INTERVAL_MS / 1000 / 3600) + "h)");
  log("  Public RPCs: " + CROSS_VALIDATION_RPCS.map(function(r, i) { return publicValidationRpcName(i); }).join(", "));
  log("  Explorer: " + EXPLORER_STATUS_URL);
  log("  Health API: http://127.0.0.1:" + HEALTH_PORT + "/health");
  log("  Primary probe: " + LOCAL_INFO_URL);
  log("  Prometheus: " + PROMETHEUS_URL);
  log("  Demos RPC: " + RPC_URL);
  log("  Telegram: " + (TELEGRAM_BOT_TOKEN ? "ENABLED" : "DISABLED"));
  log("  Features: anomaly detection, validator discovery, honest-uncertainty assessment");
  if (DNO_ADMIN_TOKEN && DNO_ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH) log("  Admin routes: DISABLED (DNO_ADMIN_TOKEN shorter than " + MIN_ADMIN_TOKEN_LENGTH + " characters)");
  else log("  Admin routes: " + (DNO_ADMIN_TOKEN ? "token set (send it in the X-DNO-Admin-Token header)" : "DISABLED (DNO_ADMIN_TOKEN not set)"));
  log("  Fixes: shared DB, write budget, staleness, atomic history, log rotation");
  log("===============================================================");

  // Load historical data
  loadHistory();

  // FIX BUG 3: Open shared SQLite handle ONCE for both modules.
  // NOTE: "marketplace.db" is a historical filename. This is the shared PRIMARY
  // datastore (incidents, public_node_history, consensus, daily_stats,
  // + gated Phase-3 observation schema). Filename kept to avoid a live-DB migration.
  var dbPath = join(LOG_DIR, "marketplace.db");
  sharedDb = new Database(dbPath);
  sharedDb.exec("PRAGMA journal_mode = WAL;");
  sharedDb.exec("PRAGMA busy_timeout = 5000;");
  sharedDb.exec(`CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    severity TEXT NOT NULL DEFAULT 'warning',
    started_at TEXT NOT NULL,
    resolved_at TEXT,
    duration_seconds INTEGER,
    affected_nodes TEXT NOT NULL,
    description TEXT NOT NULL,
    detected_block INTEGER,
    resolved_block INTEGER,
    alerts TEXT NOT NULL DEFAULT '[]'
  )`);
  log("  Shared SQLite: " + dbPath + " (incidents table ready)");

  // --- Rehydrate activeIncidents from DB (bug fix: previously started empty on every restart) ---
  try {
    var rehydrateRows = sharedDb.prepare(
      "SELECT id, status, severity, started_at, resolved_at, duration_seconds, affected_nodes, description, detected_block, resolved_block, alerts FROM incidents WHERE status='active' AND started_at >= ?"
    ).all(INCIDENT_RECONCILIATION_START_AT);
    var rehydrated = 0;
    for (var rr of rehydrateRows) {
      try {
        var affectedNodes = JSON.parse(rr.affected_nodes);
        var key = affectedNodes.slice().sort().join(",");
        activeIncidents[key] = {
          id: rr.id,
          status: rr.status,
          severity: rr.severity,
          startedAt: rr.started_at,
          resolvedAt: rr.resolved_at,
          durationSeconds: rr.duration_seconds,
          affectedNodes: affectedNodes,
          description: rr.description,
          detectedBlock: rr.detected_block,
          resolvedBlock: rr.resolved_block,
          alerts: JSON.parse(rr.alerts || "[]")
        };
        rehydrated++;
      } catch(rerr) {
        log("  [incident-rehydrate] skipping " + rr.id + ": parse error " + rerr.message);
      }
    }
    log("  [incident-rehydrate] Rehydrated " + rehydrated + " active incidents from DB (boundary: " + INCIDENT_RECONCILIATION_START_AT + ")");
  } catch(e) {
    log("  [incident-rehydrate] ERROR: " + e.message);
  }

  // Validator discovery tracking table
  sharedDb.run(`CREATE TABLE IF NOT EXISTS validator_discoveries (
    identity TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    connection TEXT,
    online INTEGER DEFAULT 1
  )`);

  // Fixnet validator discovery table (separate from testnet's validator_discoveries)
  sharedDb.run(`CREATE TABLE IF NOT EXISTS fixnet_validator_discoveries (
    identity TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    connection TEXT,
    online INTEGER DEFAULT 0,
    last_block INTEGER,
    last_probed_at INTEGER,
    last_latency_ms INTEGER
  )`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_fxd_last_seen ON fixnet_validator_discoveries(last_seen)`);
  // v7.3: idempotent migration for databases created before last_latency_ms existed
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN last_latency_ms INTEGER"); } catch(e) { /* column exists */ }
  // DNO's own probe result, kept apart from the anchor-reported online flag: 1 answered, 0 failed, NULL not probed.
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN probe_ok INTEGER"); } catch(e) { /* column exists */ }

  // Stage 3a: idempotent schema additions for per-peer stability tracking
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN observed_cycles INTEGER DEFAULT 0"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN stable_cycles INTEGER DEFAULT 0"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN current_stable_streak INTEGER DEFAULT 0"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN first_stable_at INTEGER"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN last_stable_at INTEGER"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN last_flap_at INTEGER"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN head_miss_count INTEGER DEFAULT 0"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN probe_fail_count INTEGER DEFAULT 0"); } catch(e) { /* column exists */ }
  try { sharedDb.run("ALTER TABLE fixnet_validator_discoveries ADD COLUMN unevaluated_cycles INTEGER DEFAULT 0"); } catch(e) { /* column exists */ }

  // v7.2: startup cleanup — remove fixnet discoveries not seen in last 7 days
  try {
    var cutoff7d = Date.now() - (7 * 24 * 60 * 60 * 1000);
    var delResult = sharedDb.run("DELETE FROM fixnet_validator_discoveries WHERE last_seen < ?", [cutoff7d]);
    if (delResult && delResult.changes > 0) {
      log("[startup] removed " + delResult.changes + " stale fixnet discovery row(s) older than 7 days");
    }
  } catch (cleanupErr) {
    logError("[startup] fixnet discovery cleanup failed (non-fatal): " + cleanupErr.message);
  }

  // M3: Public node history — per-cycle observation snapshots
  sharedDb.run(`CREATE TABLE IF NOT EXISTS public_node_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL,
    risk TEXT NOT NULL,
    confidence TEXT NOT NULL,
    data_quality TEXT NOT NULL,
    agreement_state TEXT NOT NULL,
    median_block INTEGER,
    block_spread INTEGER,
    nodes_total INTEGER NOT NULL,
    nodes_reachable INTEGER NOT NULL,
    node_states TEXT NOT NULL
  )`);
  sharedDb.run("CREATE INDEX IF NOT EXISTS idx_pnh_ts ON public_node_history(ts)");
  log("  Public node history table ready");
  try {
    OWN_HEIGHT_SINCE = ownHeightSince(sharedDb);
    log(OWN_HEIGHT_SINCE ? "  Public history: rows before " + new Date(OWN_HEIGHT_SINCE).toISOString() + " were not written under the own-height rule; median-based figures do not use them"
      : "  Public history: every stored row was written under the own-height rule");
  }
  catch (eOhs) { OWN_HEIGHT_SINCE = Date.now(); logError("  [history] own-height mark not readable (" + eOhs.message + "): no stored row is used for median-based figures"); }

  // node_metadata — identity-keyed registry (architecture memo Evolution B, Stage 1)
  // Populated once by scripts/populate-node-metadata.js; no runtime code reads from this yet.
  sharedDb.run(`CREATE TABLE IF NOT EXISTS node_metadata (
    identity_hash         TEXT PRIMARY KEY,
    canonical_name        TEXT,
    operator_claim        TEXT,
    operator_verification TEXT,
    seed_node             INTEGER DEFAULT 0,
    source_chain          TEXT NOT NULL CHECK (source_chain IN ('testnet', 'fixnet', 'devnet', 'mainnet')),
    current_url           TEXT,
    previous_urls         TEXT,
    tags                  TEXT,
    notes                 TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  )`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_node_metadata_chain ON node_metadata(source_chain)`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_node_metadata_seed ON node_metadata(seed_node)`);
  log("  Node metadata table ready");

  // ── Under-Observation Surface — additive, watch-only isolated (L1_OBSERVATION_ISOLATION).
  //    Neither table may EVER be read by computeCanonicalState() or
  //    anything feeding latestPublicNodes.
  //    Observation evidence only — never an admission input. Enforced by observation-isolation.test.mjs.
  sharedDb.run(`CREATE TABLE IF NOT EXISTS node_observations (
    node_id                  TEXT PRIMARY KEY,
    observation_started_at   INTEGER NOT NULL,
    compliant_seconds        INTEGER NOT NULL DEFAULT 0,
    required_seconds         INTEGER NOT NULL DEFAULT 432000,
    reset_count_window       INTEGER NOT NULL DEFAULT 0,
    sync_distance_current    INTEGER,
    sync_distance_max        INTEGER,
    uptime_percent           REAL,
    response_rate_percent    REAL,
    major_disconnect_count   INTEGER NOT NULL DEFAULT 0,
    sync_quality_pass        INTEGER,
    uptime_pass              INTEGER NOT NULL DEFAULT 0,
    response_rate_pass       INTEGER NOT NULL DEFAULT 0,
    stability_pass           INTEGER NOT NULL DEFAULT 0,
    data_consistency_pass    INTEGER,
    meets_published_criteria INTEGER NOT NULL DEFAULT 0,
    criteria_version         TEXT NOT NULL DEFAULT 'v1',
    last_evaluated_at        INTEGER NOT NULL
  )`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_node_observations_compliant ON node_observations (compliant_seconds, meets_published_criteria)`);
  sharedDb.run(`CREATE TABLE IF NOT EXISTS observation_reset_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id             TEXT NOT NULL,
    event_at            INTEGER NOT NULL,
    reason_code         TEXT NOT NULL,
    observed_value      TEXT,
    threshold_value     TEXT,
    human_readable      TEXT NOT NULL,
    criteria_version    TEXT NOT NULL DEFAULT 'v1'
  )`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_reset_events_node_time ON observation_reset_events (node_id, event_at)`);
  sharedDb.run(`CREATE TABLE IF NOT EXISTS node_observation_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    identity    TEXT NOT NULL,
    online      INTEGER NOT NULL,
    block       INTEGER
  )`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_node_obs_history_id_ts ON node_observation_history (identity, ts)`);
  sharedDb.run(`CREATE INDEX IF NOT EXISTS idx_node_obs_history_ts ON node_observation_history (ts)`);
  // v4 catalog columns: what the listing peerlists reported the last time the identity was listed.
  // public_listed_since: the first public (Path A) crawl that listed the row. Rows recorded before 1.1 have none
  // until a public peerlist lists them again (1.0 also read DNO's own node's peerlist), and are not published until then.
  // counted_after: the earliest of the last reads of the peerlists that listed the row before DNO kept it, or -1 when
  // one of them had not been read before (see catalogFirstCounted). Written only by this version's INSERT: empty on
  // rows an older agent wrote and on rows adopted from them.
  ["last_block INTEGER", "last_ready INTEGER", "last_sync_status TEXT", "last_listed_by INTEGER", "public_listed_since INTEGER", "counted_after INTEGER"].forEach(function(col) {
    try { sharedDb.run("ALTER TABLE validator_discoveries ADD COLUMN " + col); } catch (e) { /* column exists */ }
  });
  try { catalogCountStarted = loadCatalogCountStarted(sharedDb); }
  catch (eStart) { logError("  [catalog] the start of the count of new identities is not readable: " + eStart.message); }
  log("  Observation tables ready");

  // v6.4: Load incident counter from DB
  loadIncidentCounter();
  log("  Incident counter: " + incidentCounter);

  // Start health API server
  startHealthServer();

  // The witness candidates kept by the last counted validator round, before the first public round: a restart while
  // seeds are not answering then still has a reading, and opens no visibility record of its own making.
  witnessCandidates = createCandidateStore(sharedDb);
  log("  Witness candidates kept: " + witnessCandidates.load(Date.now()).candidates.length);
  try { apiFirstStarts = loadApiFirstStart(sharedDb, Date.now()); }
  catch (eApi) { logError("  [timeline] the first start of API " + API_VERSION + " was not kept: " + eApi.message); }

  // Public observation starts now, before and independent of the wallet.
  startPublicObservationLoop();
  startValidatorWatchLoop();
  if (!MNEMONIC) { log("  Wallet: not configured. Running as a public observer only."); return; }

  var demos = new Demos();
  // The wallet is needed for balance checks, DAHR and publishing only. A failed or stalled connection is
  // retried every 60 s; it never stops the process or the public observation loop.
  for (var walletAttempt = 1; ; walletAttempt++) {
    try {
      await withTimeout(demos.connect(RPC_URL), 20000, "RPC connect");
      await withTimeout(demos.connectWallet(MNEMONIC), 20000, "wallet connect");
      break;
    } catch (walletErr) {
      logError("[wallet] connect attempt " + walletAttempt + " failed: " + walletErr.message + ". Public observation continues; retrying in 60 s.");
      await sleep(60000);
    }
  }
  AGENT_WALLET = demos.getAddress();
  log("  Agent wallet: " + AGENT_WALLET);
  log("Wallet connected. Agent is live.\n");
  log("[role] INSTANCE_ROLE raw=" + JSON.stringify(INSTANCE_ROLE_CONFIG.raw) + " normalized=" + JSON.stringify(INSTANCE_ROLE_CONFIG.normalized) + " effective=" + INSTANCE_ROLE_CONFIG.effective + " can_publish=" + INSTANCE_ROLE_CONFIG.can_publish);
  if (INSTANCE_ROLE_CONFIG.warning) log("[role] " + INSTANCE_ROLE_CONFIG.warning);
  if (!INSTANCE_ROLE_CAN_PUBLISH) {
    logError("[role] INSTANCE_ROLE invalid — publishing disabled until corrected.");
    try { await sendTelegram("\u26a0\ufe0f <b>DNO ROLE CONFIG ERROR</b>\nRaw INSTANCE_ROLE: <code>" + String(INSTANCE_ROLE_CONFIG.raw) + "</code>\nEffective: <code>" + INSTANCE_ROLE_CONFIG.effective + "</code>\nPublishing: disabled\n\nDNO is running but will not publish until INSTANCE_ROLE is corrected."); } catch(e) {}
  }

  // Register agent profile (fire and forget)
  if (SUPERCOLONY_ENABLED) registerAgentProfile();

  var mktAddress = demos.getAddress();

  // Shared deps object for both modules
  var sharedDeps = {
    demos: demos,
    address: mktAddress,
    db: sharedDb, // FIX BUG 3: shared DB handle
    getFleetData: function() { return latestHealthData; },
    publish: publish,
    dahrAttest: dahrAttest,
    sendTelegram: sendTelegram,
    log: log,
    dataDir: LOG_DIR,
    canPublish: canPublish, // FIX BUG 6: expose budget check
  };

  // === v6.1: Consensus Oracle init ===
  try {
    if (CONSENSUS_ENABLED) initConsensus(sharedDeps); else log("[consensus] disabled (Path 2, 2026-06-10)");
  } catch (conErr) {
    log("[consensus] init failed (non-fatal): " + (conErr.message || conErr));
  }

  async function cycle() {
    try {
      cycleCount++;
      dailySummaryCounter++;

      // FIX BUG 7: Record cycle timestamp
      lastCycleAt = Date.now();

      // FIX BUG 9: Rotate log if needed at start of each cycle
      rotateLogIfNeeded();

      // Reconnect to primary RPC if on fallback
      if (activeRpcUrl !== RPC_URL) {
        try {
          await withTimeout(demos.connect(RPC_URL), 20000, "RPC connect");
          activeRpcUrl = RPC_URL;
          log("  Reconnected to primary RPC: " + RPC_URL);
        } catch(rpcErr) {
          log("  Primary RPC still down, staying on: " + activeRpcUrl);
        }
      }

      // Fleet version probe (every 18 cycles ~ 6h)
      if (cycleCount % 18 === 0) {
        await probeFleetVersions();
      }

      // DEM balance monitoring
      await checkBalance(demos);

      var data = await perceive();

      // --- Update uptime stats regardless of skip ---
      if (data.nodeReports) {
        for (var ui = 0; ui < data.nodeReports.length; ui++) {
          var nr = data.nodeReports[ui];
          if (uptimeStats[nr.name]) {
            uptimeStats[nr.name].total++;
            if (nr.status === "HEALTHY") uptimeStats[nr.name].healthy++;
          }
        }
      }

      // Track starting block for daily summary
      if (dailyBlockStart === null && data.chain && data.chain.block != null) {
        dailyBlockStart = data.chain.block;
      }

      // --- Probe public RPCs (every cycle for stats) ---
      var publicRpcProbe = await probePublicRPCs(demos);
      var publicRpcResults = publicRpcProbe.results;
      var cycleAttestations = publicRpcProbe.attestations;
      latestAttestationState = {
        available: dahrAvailable === true,
        lastCount: cycleAttestations.length,
        lastOkAt: cycleAttestations.length > 0 ? Date.now() : latestAttestationState.lastOkAt,
        lastAttemptAt: Date.now()
      };
      // --- Sanitized public-RPC observation snapshot ---
      // Declassification boundary: reduce probe results to {rpc-alias, up, latencyMs} only.
      // No urls, raw names, block, peers, versions, errors, or raw objects cross into public state.
      latestPublicRpcObservations = {
        observedAt: Date.now(),
        entries: publicRpcProbe.results.map(function(r, index) {
          return {
            rpc: publicValidationRpcName(index),
            up: r.ok,
            latencyMs: (r.ok === true && Number.isFinite(r.latencyMs)) ? r.latencyMs : null
          };
        })
      };
      // --- Probe fleet fixnet (additive, independent of testnet polling) ---
      try {
        latestFixnetNodes = await probeFixnetNodes();
        fixnetObservedAt = Date.now();
        fixnetCycleCounter++;
        // v7.2: probe discovered fixnet nodes (rate-limited inside function)
        try {
          latestDiscoveredFixnet = await probeDiscoveredFixnetNodes();
        } catch (discErr) {
          log("  [fixnet-discovery] probe batch failed (non-fatal): " + discErr.message);
        }
      } catch (fixnetErr) {
        log("  [fixnet] probe batch failed (non-fatal): " + fixnetErr.message);
      }


      // M3: public history, observation history and public incidents are written by the public loop.

      // --- Check explorer (every cycle, lightweight) ---
      var explorerResult = await checkExplorer();

      // --- Public RPC cross-validation: flag if public block is way ahead/behind private ---
      if (data.chain && data.chain.block != null) {
        for (var pri = 0; pri < publicRpcResults.length; pri++) {
          var pr = publicRpcResults[pri];
          if (pr.ok && pr.block != null) {
            var drift = Math.abs(pr.block - data.chain.block);
            if (drift > 10) {
              log("  Cross-check: " + pr.name + " block=" + pr.block + " vs fleet block=" + data.chain.block + " (drift=" + drift + ")");
            }
          }
        }
      }

      // --- FIX: Mark nodes UNHEALTHY if far behind public RPCs ---
      var publicHighest = 0;
      for (var phi = 0; phi < publicRpcResults.length; phi++) {
        if (publicRpcResults[phi].ok && publicRpcResults[phi].block && publicRpcResults[phi].block > publicHighest) {
          publicHighest = publicRpcResults[phi].block;
        }
      }
      if (publicHighest > 0 && data.nodeReports && !data.skip) {
        for (var dri = 0; dri < data.nodeReports.length; dri++) {
          var dnr = data.nodeReports[dri];
          if (dnr.blockHeight != null && publicHighest - dnr.blockHeight > 100) {
            var driftIssue = "PUBLIC_DRIFT(" + (publicHighest - dnr.blockHeight) + " behind)";
            dnr.issues.push(driftIssue);
            dnr.status = "UNHEALTHY";
            var driftExisting = data.problems.find(function(p) { return p.name === dnr.name; });
            if (driftExisting) driftExisting.issues.push(driftIssue);
            else data.problems.push({ name: dnr.name, issues: [driftIssue] });
            log("  !! " + dnr.name + ": " + driftIssue);
          }
        }
      }

      // --- Record historical data ---
      if (!data.skip) {
        recordHistory(data, publicRpcResults);
      }

      // --- Update latest health data for HTTP endpoint ---
      if (true) { // v5.0: always update for /federate endpoint
        latestHealthData = data;
      }

      // --- Signal-based Telegram alerts ---
      try {
        var currentSignals = generateSignals(data, 0);
        var alertableSignals = currentSignals.filter(function(s) { return s.severity === "warning" || s.severity === "critical"; });
        var now = Date.now();
        for (var sig of alertableSignals) {
          var sigKey = "signal_" + sig.type + "_" + (sig.nodes || []).join(",");
          if (!signalAlertDedup[sigKey] || now - signalAlertDedup[sigKey] > 6 * 60 * 60 * 1000) {
            var sevIcon = sig.severity === "critical" ? "\ud83d\udd34" : "\u26a0\ufe0f";
            var msg = sevIcon + " <b>SIGNAL " + sig.severity.toUpperCase() + "</b>\n";
            msg += "<b>" + sig.type.replace(/_/g, " ").toUpperCase() + "</b>\n";
            msg += sig.message;
            if (sig.nodes && sig.nodes.length > 0) msg += "\nAffected: " + sig.nodes.join(", ");
            await sendTelegram(msg);
            signalAlertDedup[sigKey] = now;
            log("  Signal alert sent: " + sig.type + " (" + sig.severity + ")");
          }
        }
      } catch(e) { log("  Signal alert error: " + e.message); }

      // --- Validator discovery: the public catalog is crawled in the public observation loop (Path A only) ---

      // --- Anomaly detection ---
      if (!data.skip) {
        var anomalies = detectAnomalies(data);
        if (anomalies.length > 0) {
          log("  Anomalies detected: " + anomalies.join(", "));
          // Add anomalies as chain-level problems
          for (var ai = 0; ai < anomalies.length; ai++) {
            data.problems.push({ name: "CHAIN", issues: [anomalies[ai]] });
          }
        }
      }

      // === v6.1: Consensus Oracle poll ===
      try {
        var conResult = CONSENSUS_ENABLED ? await pollAndProcessConsensus() : { reportsFound: 0, consensusPublished: false };
        if (conResult.reportsFound > 0 || conResult.consensusPublished) {
          log("[consensus] cycle: reports=" + conResult.reportsFound + " published=" + conResult.consensusPublished);
        }
      } catch (conErr) {
        log("[consensus] poll error (non-fatal): " + (conErr.message || conErr));
      }

      // --- Daily summary ---
      if (dailySummaryCounter >= DAILY_SUMMARY_CYCLES) {
        log("  Generating daily summary...");
        var summaryPost = composeDailySummary(data.skip ? null : data, publicRpcResults, explorerResult);
        // Use current fleet data if available, otherwise compose with what we have
        if (data.skip) {
          // Re-fetch a quick snapshot for the summary
          summaryPost = composeDailySummary({
            nodeReports: NODE_NAMES.map(function(n) { return { name: n, status: "HEALTHY" }; }),
            chain: { block: previousState.lastBlockHeight, onlineCount: FLEET_SIZE, readyCount: FLEET_SIZE, syncedCount: FLEET_SIZE, tps: null },
            problems: [],
          }, publicRpcResults, explorerResult);
        }
        await publish(demos, summaryPost, cycleAttestations);
        await sendTelegram("📊 <b>DAILY SUMMARY</b>\n" + summaryPost.text);

        resetDailyStats(data.chain ? data.chain.block : null);
      }

      if (data.skip) {
        // All healthy — check for recoveries
        var recoveries = [];
        for (var rn in problemHistory) {
          if (problemHistory[rn].alerted) {
            recoveries.push(rn);
          }
        }
        // Also check chain recovery
        if (chainAlerted) {
          recoveries.push("CHAIN");
          chainAlerted = false;
          chainProblemCount = 0;
        }
        // Reset all tracking
        problemHistory = {};
        chainProblemCount = 0;
        lastAlertSignature = null;
        lastAlertAt = 0;

        if (recoveries.length > 0) {
          dailyRecoveryCount++;
          // v6.4: Resolve matching incidents
          for (var rKey in activeIncidents) {
            var rNodes = rKey.split(",");
            var allRecovered = rNodes.every(function(rn) { return recoveries.indexOf(rn) !== -1 || rn === "CHAIN"; });
            if (allRecovered) {
              resolveIncident(rKey, data.chain ? data.chain.block : null);
            }
          }
          var recPost = {
            cat: "OBSERVATION",
            text: "Recovery: " + recoveries.join(", ") + " back to healthy. Fleet " + FLEET_SIZE + "/" + FLEET_SIZE + " operational.",
            confidence: 85,
          };
          log("  Recovery detected for: " + recoveries.join(", "));
          await publish(demos, recPost);
        }
        return;
      }

      // --- Cooldown logic: filter problems through persistence tracking ---
      var currentNodeProblems = {}; // nodes with issues this cycle
      var currentChainProblem = false;

      for (var pi = 0; pi < data.problems.length; pi++) {
        var prob = data.problems[pi];
        if (prob.name === "CHAIN") {
          currentChainProblem = true;
        } else {
          currentNodeProblems[prob.name] = prob;
        }
      }

      // Update chain problem tracking
      if (currentChainProblem) {
        chainProblemCount++;
        log("  Cooldown: CHAIN issue count = " + chainProblemCount + "/" + COOLDOWN_CYCLES);
      } else {
        if (chainAlerted) {
          log("  Cooldown: CHAIN recovered");
        }
        chainProblemCount = 0;
        chainAlerted = false;
      }

      // Update per-node tracking
      for (var nn in currentNodeProblems) {
        if (!problemHistory[nn]) {
          problemHistory[nn] = { count: 0, issues: [], alerted: false };
        }
        problemHistory[nn].count++;
        problemHistory[nn].issues = currentNodeProblems[nn].issues;
        log("  Cooldown: " + nn + " issue count = " + problemHistory[nn].count + "/" + COOLDOWN_CYCLES);
      }

      // Check for node recoveries (was tracked + alerted, now absent from problems)
      var recoveries = [];
      for (var hn in problemHistory) {
        if (!currentNodeProblems[hn]) {
          if (problemHistory[hn].alerted) {
            recoveries.push(hn);
          }
          delete problemHistory[hn];
        }
      }
      if (chainAlerted && !currentChainProblem) {
        recoveries.push("CHAIN");
      }

      // Post recovery if any previously-alerted items recovered
      if (recoveries.length > 0) {
        dailyRecoveryCount++;
        // v6.4: Resolve matching incidents
        for (var rKey2 in activeIncidents) {
          var rNodes2 = rKey2.split(",");
          var allRecovered2 = rNodes2.every(function(rn) { return recoveries.indexOf(rn) !== -1 || rn === "CHAIN"; });
          if (allRecovered2) {
            resolveIncident(rKey2, data.chain ? data.chain.block : null);
          }
        }
        var healthy = data.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length;
        var recPost = {
          cat: "OBSERVATION",
          text: "Recovery: " + recoveries.join(", ") + " back to healthy. Fleet " + healthy + "/" + FLEET_SIZE + " operational. Block " + (data.chain.block != null ? data.chain.block : "?") + ".",
          confidence: 85,
        };
        log("  Recovery detected for: " + recoveries.join(", "));
        await publish(demos, recPost);
      }

      // Filter problems: only include those past cooldown threshold
      var confirmedProblems = [];
      for (var cn in problemHistory) {
        if (problemHistory[cn].count >= COOLDOWN_CYCLES) {
          confirmedProblems.push({ name: cn, issues: problemHistory[cn].issues });
          problemHistory[cn].alerted = true;
        }
      }
      if (chainProblemCount >= COOLDOWN_CYCLES) {
        var chainProbs = data.problems.filter(function(p) { return p.name === "CHAIN"; });
        for (var ci = 0; ci < chainProbs.length; ci++) confirmedProblems.push(chainProbs[ci]);
        chainAlerted = true;
      }

      if (confirmedProblems.length === 0) {
        log("  Cooldown: all problems below threshold — suppressing alert.");
        return;
      }

      // Replace data.problems with only confirmed ones, then compose and publish
      data.problems = confirmedProblems;

      // --- Per-cycle incident reconciliation (bug fix: state-driven resolve, not only transition-triggered) ---
      // For each active incident, check if its condition is still true in this cycle.
      // If not, resolve it. Conservative: missing data = KEEP ACTIVE.
      try {
        var reconcileBlock = data.chain ? data.chain.block : null;
        var chainStillProblem = confirmedProblems.some(function(p) { return p.name === "CHAIN"; });
        var chainCheckable = !!(data && data.chain);
        var nodeReportsAvail = !!(data && data.nodeReports && data.nodeReports.length > 0);
        var nodeStatusMap = {};
        if (nodeReportsAvail) {
          for (var nri = 0; nri < data.nodeReports.length; nri++) {
            var nrpt = data.nodeReports[nri];
            if (nrpt && nrpt.name) nodeStatusMap[nrpt.name] = nrpt.status;
          }
        }
        var confirmedNamesSet = {};
        for (var cpi = 0; cpi < confirmedProblems.length; cpi++) {
          var cpn = confirmedProblems[cpi];
          if (cpn && cpn.name) confirmedNamesSet[cpn.name] = true;
        }
        var reconcileKeys = Object.keys(activeIncidents);
        for (var rki = 0; rki < reconcileKeys.length; rki++) {
          var recKey = reconcileKeys[rki];
          var recInc = activeIncidents[recKey];
          if (!recInc || !recInc.affectedNodes) continue;
          var affected = recInc.affectedNodes;
          var isChain = affected.indexOf("CHAIN") !== -1;
          if (isChain) {
            if (!chainCheckable) {
              log("[incident-reconcile] skipping " + recInc.id + " reason=\"data.chain missing this cycle\"");
              continue;
            }
            if (chainStillProblem) {
              log("[incident-reconcile] skipping " + recInc.id + " reason=\"CHAIN still in confirmedProblems\"");
              continue;
            }
            log("[incident-reconcile] resolving " + recInc.id + " type=CHAIN key=" + recKey + " reason=\"no confirmed CHAIN problem in current cycle\" block=" + reconcileBlock);
            resolveIncident(recKey, reconcileBlock);
          } else {
            if (!nodeReportsAvail) {
              log("[incident-reconcile] skipping " + recInc.id + " reason=\"data.nodeReports missing/empty\"");
              continue;
            }
            var allHealthy = true;
            var anyMissing = false;
            var anyInConfirmed = false;
            for (var ani = 0; ani < affected.length; ani++) {
              var aNode = affected[ani];
              if (!(aNode in nodeStatusMap)) { anyMissing = true; break; }
              if (nodeStatusMap[aNode] !== "HEALTHY") { allHealthy = false; break; }
              if (confirmedNamesSet[aNode]) { anyInConfirmed = true; break; }
            }
            if (anyMissing) {
              log("[incident-reconcile] skipping " + recInc.id + " reason=\"node absent from nodeReports: " + affected.join(",") + "\"");
              continue;
            }
            if (!allHealthy) {
              log("[incident-reconcile] skipping " + recInc.id + " reason=\"not all nodes HEALTHY: " + affected.join(",") + "\"");
              continue;
            }
            if (anyInConfirmed) {
              log("[incident-reconcile] skipping " + recInc.id + " reason=\"node still in confirmedProblems: " + affected.join(",") + "\"");
              continue;
            }
            log("[incident-reconcile] resolving " + recInc.id + " type=node key=" + recKey + " reason=\"all nodes HEALTHY and absent from confirmedProblems\" block=" + reconcileBlock);
            resolveIncident(recKey, reconcileBlock);
          }
        }
      } catch(recErr) {
        log("[incident-reconcile] ERROR: " + recErr.message);
      }

      // Alert deduplication: don't repeat identical alerts
      var alertSig = confirmedProblems.map(function(p) { return p.name + ":" + p.issues.sort().join(","); }).sort().join("|");
      var now = Date.now();
      if (alertSig === lastAlertSignature && (now - lastAlertAt) < REPEAT_ALERT_INTERVAL_MS) {
        log("  Dedup: identical alert suppressed (last sent " + Math.round((now - lastAlertAt) / 60000) + "m ago). Next repeat in " + Math.round((REPEAT_ALERT_INTERVAL_MS - (now - lastAlertAt)) / 60000) + "m.");
        return;
      }

      dailyAlertCount++;

      // v6.4: Open or update incident
      var offlineNodes = confirmedProblems.filter(function(p) { return p.name !== "CHAIN"; }).map(function(p) { return p.name; });
      var chainIssueCount = confirmedProblems.filter(function(p) { return p.name === "CHAIN"; }).length;
      if (offlineNodes.length > 0 || chainIssueCount > 0) {
        var incKey = offlineNodes.sort().join(",") || "CHAIN";
        if (!activeIncidents[incKey]) {
          var incSeverity = determineSeverity(offlineNodes.length, chainIssueCount, 0);
          var incDesc = offlineNodes.length > 0
            ? offlineNodes.length + " node(s) unhealthy: " + offlineNodes.join(", ")
            : "Fleet reference chain issue detected";
          openIncident(incSeverity, offlineNodes.length > 0 ? offlineNodes : ["CHAIN"], incDesc, data.chain ? data.chain.block : null);
        }
      }

      var post = composeAlert(data);
      var pubResult = await publish(demos, post, cycleAttestations);
      if (pubResult) {
        lastAlertSignature = alertSig;
        lastAlertAt = now;
      }
    } catch (err) {
      logError("Cycle error: " + err.message);
      if (err.stack) logError(err.stack);
    }
  }

  // One fleet cycle at a time. The next starts MONITOR_INTERVAL_MS after the previous one began, or as soon as
  // it ends if it overran. A cycle still running after FLEET_CYCLE_MAX_MS is logged and no longer waited for.
  var FLEET_CYCLE_MAX_MS = Math.max(120000, 6 * MONITOR_INTERVAL_MS);
  async function fleetLoop() {
    var started = Date.now(), finished = false;
    var run = cycle().then(function() { finished = true; }, function() { finished = true; });
    await Promise.race([run, sleep(FLEET_CYCLE_MAX_MS)]);
    if (!finished) logError("[fleet] cycle still running after " + Math.round(FLEET_CYCLE_MAX_MS / 1000) + " s; starting the next one");
    setTimeout(fleetLoop, Math.max(1000, MONITOR_INTERVAL_MS - (Date.now() - started)));
  }
  await fleetLoop();
  log("\nMonitoring every " + (MONITOR_INTERVAL_MS / 1000 / 60) + " min, publishing every " + (INTERVAL_MS / 1000 / 60) + " min. Agent running...\n");
  // (Removed 2026-04-24: old stale-CHAIN startup SQL replaced by rehydrate+reconcile pattern)
  await checkLatestVersion();
  setInterval(checkLatestVersion, 10 * 60 * 1000);
}

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  var offset = 0;
  var NL = "\n";
  log("Telegram bot polling started...");
  while (true) {
    try {
      var r = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/getUpdates?timeout=10&offset=" + offset);
      var data = await r.json();
      if (data.ok && data.result && data.result.length > 0) {
        for (var update of data.result) {
          offset = update.update_id + 1;
          var msg = update.message || update.edited_message;
          if (!msg || !msg.text) continue;
          var chatId = String(msg.chat.id);
          var text = msg.text.trim().toLowerCase().split("@")[0];
          var reply = "";
          if (text === "/status") {
            try {
              if (latestHealthData === null) { reply = "Status unavailable — no completed crawl is loaded."; }
              else {
              var canonical = computeCanonicalState();
              var nodes = latestHealthData.nodeReports || [];
              var healthy = nodes.filter(function(n){ return n.status==="HEALTHY"; }).length;
              var lines = ["<b>Fleet Status</b>"];
              lines.push("Status: <b>" + String(canonical.status||"unknown").toUpperCase() + "</b>");
              lines.push("Healthy: " + healthy + "/" + FLEET_SIZE);
              nodes.forEach(function(n){
                lines.push((n.status==="HEALTHY"?"\u2705":"\u274c") + " " + n.name + " block " + (n.blockHeight||"?"));
              });
              reply = lines.join(NL);
              }
            } catch(e) { reply = "Error fetching status: " + e.message; }
          } else if (text === "/incidents") {
            try {
              var incs = sharedDb.prepare("SELECT * FROM incidents ORDER BY started_at DESC LIMIT 5").all();
              if (!incs || incs.length === 0) { reply = "\u2705 No incidents recorded."; }
              else {
                var lines = ["<b>Recent Incidents</b>"];
                incs.forEach(function(inc){
                  lines.push((inc.status==="active"?"\ud83d\udd34":"\u2705") + " [" + inc.severity.toUpperCase() + "] " + inc.description);
                  lines.push("  Started: " + new Date(inc.started_at).toLocaleString());
                  if (inc.status==="resolved") lines.push("  Duration: " + Math.round(inc.duration_seconds/60) + "min");
                });
                reply = lines.join(NL);
              }
            } catch(e) { reply = "Error: " + e.message; }
          } else if (text === "/uptime" || text === "/sla") {
            try {
              if (latestHealthData === null) { reply = "Uptime unavailable — no completed crawl is loaded."; }
              else {
              var lines = ["<b>Node Uptime</b>"];
              var up = uptimeStats || {};
              Object.keys(up).forEach(function(name){
                var u = up[name];
                var pct = u.total > 0 ? Math.round(u.healthy/u.total*100) : null;
                lines.push((pct===100?"\u2705":pct>=80?"\u26a0\ufe0f":"\u274c") + " " + name + ": " + (pct!==null?pct+"%":"--") + " (" + u.healthy + "/" + u.total + ")");
              });
              reply = lines.join(NL);
              }
            } catch(e) { reply = "Error: " + e.message; }
          } else if (text === "/signals") {
            try {
              if (latestHealthData === null) { reply = "Signals unavailable — no completed crawl is loaded."; }
              else {
              var st = getStaleness();
              var sigs = generateSignals(latestHealthData, st.stalenessSeconds);
              var stForBot = (Number.isFinite(st.stalenessSeconds) && st.stalenessSeconds >= 0) ? st.stalenessSeconds : null;
              var lines = ["<b>Network Signals</b>"];
              lines.push(stForBot === null ? "Staleness: unavailable" : ("Staleness: " + stForBot + "s"));
              var sevIcon = {"info": "\u2139\ufe0f", "warning": "\u26a0\ufe0f", "critical": "\ud83d\udd34"};
              sigs.forEach(function(s) {
                var icon = sevIcon[s.severity] || "\u2139\ufe0f";
                lines.push(icon + " <b>" + s.type.replace(/_/g," ").toUpperCase() + "</b>");
                lines.push("  " + s.message);
                if (s.nodes && s.nodes.length > 0) lines.push("  Nodes: " + s.nodes.join(", "));
              });
              reply = lines.join(NL);
              }
            } catch(e) { reply = "Error: " + e.message; }
          } else if (text === "/help" || text === "/start") {
            var lines = ["<b>Demos Fleet Oracle Bot</b>","","/status — full fleet status","/incidents — last 5 incidents","/uptime — per-node uptime %","/signals — current network signals","/help — this message"];
            reply = lines.join(NL);
          }
          if (reply && chatId === TELEGRAM_CHAT_ID) {
            await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: "HTML" }),
            });
          }
        }
      }
    } catch(e) { logError("Telegram poll error: " + e.message); }
    await sleep(3000);
  }
}

// A stray exception or rejection is logged; the observation loop and the HTTP server keep running.
process.on("unhandledRejection", function(reason) {
  logError("[process] unhandled rejection: " + (reason && reason.message ? reason.message : String(reason)));
});
process.on("uncaughtException", function(err) {
  logError("[process] uncaught exception: " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err)));
});

main().catch(function(err) {
  logError("Fatal error: " + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});

pollTelegram().catch(function(err) {
  logError("Telegram polling error:", err);
});


// === v6.0: Graceful shutdown ===
process.on("SIGTERM", function() {
  log("[agent] SIGTERM — shutting down");
  // FIX BUG 3: Close shared DB on shutdown
  if (sharedDb) { try { sharedDb.close(); log("[agent] shared DB closed"); } catch(e) {} }
  process.exit(0);
});
process.on("SIGINT", function() {
  log("[agent] SIGINT — shutting down");
  // FIX BUG 3: Close shared DB on shutdown
  if (sharedDb) { try { sharedDb.close(); log("[agent] shared DB closed"); } catch(e) {} }
  process.exit(0);
});
