import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync, statSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import { Database } from "bun:sqlite"; // FIX BUG 3: shared DB handle
try { readFileSync(".env","utf8").split("\n").forEach(function(line) { var m = line.match(/^([^#=]+)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim(); }); } catch(e) {}
import { Demos } from "@kynesyslabs/demosdk/websdk";

// === v6.0: Marketplace ===
import { initMarketplace, pollAndProcessQueries, getMarketplaceStats, getRecentQueries, shutdownMarketplace } from "./marketplace.mjs";
import { initConsensus, pollAndProcessConsensus, getConsensusState } from "./consensus.mjs";

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
const FALLBACK_RPCS = [RPC_URL, "http://193.77.44.160:53550", "http://193.77.50.180:53550"];
const INTERVAL_MS = parseInt(process.env.PUBLISH_INTERVAL_MS || "1200000");
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || "20000"); // 1 min monitoring, independent of publish interval
const PROMETHEUS_URL = "http://127.0.0.1:19096";
const LOCAL_INFO_URL = "http://127.0.0.1:53550/info";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Public endpoints for cross-validation
const PUBLIC_RPCS = [
  { name: "n1", url: "http://193.77.44.160:53550/info" },
  { name: "n5", url: "http://193.77.50.180:53550/info" },
];
const EXPLORER_STATUS_URL = "https://scan.demos.network/status";
const PUBLIC_PROBE_TIMEOUT_MS = 10000;

// Daily summary: every 72 cycles = 24h at 20min intervals
const DAILY_SUMMARY_CYCLES = 72;

// HTTP health endpoint
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8080");

// Agent profile
let AGENT_WALLET = "0xbdb3e8189a62dce62229bf3badbf01e5bdb3fbeb22f6f59f4c7c2edafe802a45"; // will be updated after wallet connect
const INSTANCE_ROLE = process.env.INSTANCE_ROLE || "primary";
const PRIMARY_ORACLE_URL = process.env.PRIMARY_ORACLE_URL || "";
let primaryLastSeen = 0; // timestamp of last successful primary health fetch
let primarySilentCycles = 0;

async function checkPrimaryOracle() {
  if (!PRIMARY_ORACLE_URL) return { silent: false, diverged: false };
  try {
    var r = await fetch(PRIMARY_ORACLE_URL + "/health", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var d = await r.json();
    primaryLastSeen = Date.now();
    primarySilentCycles = 0;
    var primaryBlock = d.fleet ? d.fleet.block : null;
    var primaryHealthy = d.fleet ? d.fleet.healthy : 0;
    return { silent: false, diverged: false, block: primaryBlock, healthy: primaryHealthy };
  } catch(e) {
    primarySilentCycles++;
    log("  [validator] Primary oracle unreachable (" + primarySilentCycles + " cycles): " + e.message);
    return { silent: primarySilentCycles >= 1, diverged: false };
  }
}
const AGENT_NAME = "Demos Network Oracle";
const AGENT_DESCRIPTION = "Public network intelligence oracle for the Demos ecosystem. Monitors public validators, tracks network agreement, and publishes DAHR-attested health data on-chain via SuperColony every 20 minutes. Public API at demos-oracle.com/health";
const SUPERCOLONY_API = "https://www.supercolony.ai";

// Historical data file (JSON-based, lightweight)
const HISTORY_FILE = join(LOG_DIR, "history.json");
const MAX_HISTORY_CYCLES = 432; // 6 days at 20min intervals

var DOCS_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Demos Network Oracle — API</title>' +
'<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f172a;color:#cbd5e1;padding:2rem;max-width:860px;margin:0 auto;line-height:1.5}' +
'h1{color:#22d3ee;margin-bottom:4px;font-size:1.6rem}.sub{color:#64748b;margin-bottom:1.5rem;font-size:.9rem}' +
'h2{color:#38bdf8;margin:1.2rem 0 .4rem;font-size:1rem;border-bottom:1px solid #1e293b;padding-bottom:4px}' +
'.e{background:#1e293b;border-left:3px solid #22d3ee;padding:8px 12px;margin:5px 0;border-radius:0 4px 4px 0;font-size:.9rem}' +
'.e b{color:#f59e0b}.e span{color:#94a3b8;display:block;font-size:.82rem;margin-top:2px}' +
'code{background:#0f172a;padding:1px 5px;border-radius:3px;font-size:.85rem}' +
'footer{margin-top:1.5rem;padding-top:.8rem;border-top:1px solid #1e293b;color:#475569;font-size:.8rem}</style></head><body>' +
'<h1>Demos Network Oracle</h1>' +
'<p class="sub">Public network intelligence for the Demos ecosystem. Monitors public validators, tracks network agreement, and publishes attested health data on-chain via SuperColony.<br>' +
'Oracle wallet: <code>' + AGENT_WALLET + '</code> &middot; v6.9 &middot; <a href="/dashboard" style="color:#22d3ee">Dashboard</a></p>' +
'<h2>Network</h2>' +
'<div class="e"><b>GET /health</b><span>Full network snapshot — canonical truth model, agreement, signals, public nodes, reference layer</span></div>' +
'<div class="e"><b>GET /organism</b><span>Compact public truth feed — 12 canonical fields, zero fleet data, optimized for agents</span></div>' +
'<div class="e"><b>GET /signals</b><span>Current network signals grouped by severity (critical / warning / info)</span></div>' +
'<div class="e"><b>GET /incidents</b><span>Incident log with scope filtering — public (default), fleet, or all</span></div>' +
'<h2>Validators</h2>' +
'<div class="e"><b>GET /peers</b><span>Discovered validators — identity, connection, block, first seen</span></div>' +
'<div class="e"><b>GET /reputation</b><span>Per-node reputation scores (0-100) over 24h window</span></div>' +
'<div class="e"><b>GET /sentinel</b><span>Anomaly detector status — alerts, detectors, last 24h summary</span></div>' +
'<div class="e"><b>GET /sources</b><span>Where the Oracle derives its view — source layers, resolution model, attestation</span></div>' +
'<div class="e"><b>GET /agent</b><span>Agent integration guide \u2014 consumption patterns, examples, polling guidance</span></div>' +
'<div class="e"><b>GET /methodology</b><span>How the Oracle works \u2014 truth model, data sources, limitations</span></div>' +
'<h2>History</h2>' +
'<div class="e"><b>GET /history</b><span>Last 72 health cycles as JSON</span></div>' +
'<div class="e"><b>GET /history/export?format=csv&amp;from=TS&amp;to=TS</b><span>Export history as CSV. Optional from/to filters (Unix ms)</span></div>' +
'<h2>Integration</h2>' +
'<div class="e"><b>GET /federate</b><span>Prometheus metrics endpoint for scraping</span></div>' +
'<div class="e"><b>GET /federate/config</b><span>Prometheus scrape_config snippet</span></div>' +
'<div class="e"><b>GET /badge</b><span>SVG status badge showing canonical network status (STABLE/DEGRADED/UNSTABLE)</span></div>' +
'<div class="e"><b>GET /version</b><span>Running agent version vs latest GitHub commit</span></div>' +
'<footer>All endpoints return JSON unless noted. Monitoring interval: 20s. Publishing interval: 20 min. API version: 1.0. Oracle is strictly watch-only — observe, interpret, summarize risk.</footer></body></html>';

// FIX BUG 6: Write budget constants (SuperColony rate limits)
const DAILY_PUBLISH_LIMIT = 15;
const HOURLY_PUBLISH_LIMIT = 5;
let publishTimestamps = []; // rolling window of publish times

var HOMEPAGE_HTML = "";
try { HOMEPAGE_HTML = readFileSync("homepage.html", "utf8"); } catch(e) { HOMEPAGE_HTML = "<html><body><h1>Homepage not found</h1></body></html>"; }
var SOURCES_HTML = "";
try { SOURCES_HTML = readFileSync("sources.html", "utf8"); } catch(e) { SOURCES_HTML = "<html><body><h1>Sources page not found</h1></body></html>"; }
var SUBMIT_HTML = "";
try { SUBMIT_HTML = readFileSync("submit.html", "utf8"); } catch(e) { SUBMIT_HTML = "<html><body><h1>Submit page not found</h1></body></html>"; }
var AGENT_GUIDE_HTML = "";
try { AGENT_GUIDE_HTML = readFileSync("agent-guide.html", "utf8"); } catch(e) { AGENT_GUIDE_HTML = "<html><body><h1>Agent guide not found</h1></body></html>"; }
var METHODOLOGY_HTML = "";
try { METHODOLOGY_HTML = readFileSync("methodology.html", "utf8"); } catch(e) { METHODOLOGY_HTML = "<html><body><h1>Methodology page not found</h1></body></html>"; }

if (!MNEMONIC) {
  logError("DEMOS_MNEMONIC is required. Set it in .env");
  process.exit(1);
}

const EXPECTED_FLEET = {
  n1: { side: "A", port: 53550, host: "193.77.44.160",  identity: "0x8f3abd366c7b846c1ee940f35d2d7ef7774dfe636e6284a32bf2c5a3e1b3ba05" },
  n2: { side: "B", port: 54550, host: "193.77.44.160",  identity: "0xbfda23d32dee055bda23f1e74a25abb7e33478da1b2013768e135cc2ed924f37" },
  n3: { side: "A", port: 53550, host: "193.77.169.106", identity: "0x4ba486bc92263f2cb15608ed369eafbd576097e79194f0895c1e01d232aa4b52" },
  n4: { side: "B", port: 54550, host: "193.77.50.180",  identity: "0x848ae0759c5eba1974ec942b8e1fb4962e1b256ff89e93bdb6ad12ea58ad76a9" },
  n5: { side: "A", port: 53550, host: "193.77.50.180",  identity: "0x95cbd7147cf09dc46d91cd6ae8f2912ae0f597fac9c61d0b0c347a46374af80f" },
  n6: { side: "B", port: 54550, host: "193.77.169.106", identity: "0x3ab3365e67583a89968082475816cf2f16f8f9a3b936a38513493d0c6b69f768" },
  m1: { side: "A", port: 53550, host: "82.192.52.254",  identity: "0x56b46be173e20f540401d079811e5b524903a197ae5d07824d0e70a22ee6e591" },
};

const NODE_NAMES = Object.keys(EXPECTED_FLEET);
const FLEET_SIZE = NODE_NAMES.length;

// Node registry — separated by source type and trust tier
// source_type: "public" | "community" | "discovered"
// trust_tier: "verified" | "community_submitted" | "auto_discovered"

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
  // Community nodes — manually approved by XM33
  "community-node1": {
    url: "http://107.131.170.202:53552",
    identity: "0x283ab24d052cfd8aa82b66780b6d88723e577697d718bada19dfcafcd64524ea",
    source_type: "community",
    trust_tier: "community_submitted",
    operator: "Community",
    joined_at: "2026-04-15"
  },
  "community-node2": {
    url: "http://65.7.20.194:53552",
    identity: "0x036a053dd8b06aeef6b4a3cf2e0181c69947997fad0ab82e7beb9324448ec43d",
    source_type: "community",
    trust_tier: "community_submitted",
    operator: "Community",
    joined_at: "2026-04-15"
  },
};
var PUBLIC_NODE_IDENTITIES = {};
for (var _pn in PUBLIC_NODES) { PUBLIC_NODE_IDENTITIES[PUBLIC_NODES[_pn].identity] = _pn; }


// Fleet fixnet registry — 7 XM33 fleet nodes + Kynesys anchor
// Separate from PUBLIC_NODES (different network)
const FIXNET_NODES = {
  "kynesys-anchor": {
    url: "http://node3.demos.sh:60001",
    host: "node3.demos.sh",
    identity: "0x412bee5548b43bc0a23429c06946c1eb990d900f6c0ed5c3ad001481e7f7a8ef",
    source_type: "anchor",
    trust_tier: "verified",
    operator: "Kynesys",
    joined_at: "2026-04-22"
  },
  "fleet-n1": {
    url: "http://193.77.44.160:53550",
    host: "193.77.44.160",
    identity: "0x8f3abd366c7b846c1ee940f35d2d7ef7774dfe636e6284a32bf2c5a3e1b3ba05",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n2": {
    url: "http://193.77.44.160:54550",
    host: "193.77.44.160",
    identity: "0xbfda23d32dee055bda23f1e74a25abb7e33478da1b2013768e135cc2ed924f37",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n3": {
    url: "http://193.77.169.106:53550",
    host: "193.77.169.106",
    identity: "0x4ba486bc92263f2cb15608ed369eafbd576097e79194f0895c1e01d232aa4b52",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n4": {
    url: "http://193.77.50.180:54550",
    host: "193.77.50.180",
    identity: "0x848ae0759c5eba1974ec942b8e1fb4962e1b256ff89e93bdb6ad12ea58ad76a9",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n5": {
    url: "http://193.77.50.180:53550",
    host: "193.77.50.180",
    identity: "0x95cbd7147cf09dc46d91cd6ae8f2912ae0f597fac9c61d0b0c347a46374af80f",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n6": {
    url: "http://193.77.169.106:54550",
    host: "193.77.169.106",
    identity: "0x3ab3365e67583a89968082475816cf2f16f8f9a3b936a38513493d0c6b69f768",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-m1": {
    url: "http://82.192.52.254:53550",
    host: "82.192.52.254",
    identity: "0x56b46be173e20f540401d079811e5b524903a197ae5d07824d0e70a22ee6e591",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  }
};

var FIXNET_NODE_IDENTITIES = {};
for (var _fn in FIXNET_NODES) { FIXNET_NODE_IDENTITIES[FIXNET_NODES[_fn].identity] = _fn; }

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

var FLEET_NODE_NAMES = ["n1","n2","n3","n4","n5","n6","m1","m3","n9"];
function getPublicActiveIncidentIds() {
  return Object.values(activeIncidents).filter(function(i) {
    // Exclude fleet chain incidents from public count
    if (i.description && (i.description.indexOf("Fleet reference") === 0 || i.description === "Chain-level issue detected")) return false;
    // Exclude fleet node incidents
    if (i.affectedNodes && i.affectedNodes.every(function(n) { return FLEET_NODE_NAMES.includes(n); })) return false;
    return true;
  }).map(function(i) { return i.id; });
}

function determineSeverity(offlineCount, chainIssues, lagCount) {
  if (offlineCount >= 3 || chainIssues > 0) return "critical";
  if (offlineCount >= 1 || lagCount >= 3) return "warning";
  return "info";
}

function getRecommendation(data) {
  // Recommendation is based on PUBLIC network state only — not fleet health
  var publicActiveIncs = getPublicActiveIncidentIds();
  var pubNodes = latestPublicNodes || [];
  var pubOnline = pubNodes.filter(function(n) { return n.ok; }).length;
  var pubTotal = pubNodes.length;

  if (pubTotal === 0) {
    return { recommendation: "INSUFFICIENT_DATA", safe_to_propose: false, confidence: "low", reason: "No public node data available" };
  }
  if (publicActiveIncs.length === 0 && pubOnline >= Math.ceil(pubTotal * 0.5)) {
    return { recommendation: "SAFE", safe_to_propose: true, confidence: "high", reason: "Network stable, no issues detected" };
  }
  if (publicActiveIncs.length > 0 || pubOnline < pubTotal) {
    return { recommendation: "CAUTION", safe_to_propose: true, confidence: "medium", reason: "Network stable, minor observations present" };
  }
  return { recommendation: "UNSAFE", safe_to_propose: false, confidence: "high", reason: "Significant public network issues detected" };
}

// Load incident counter from DB on startup
function getValidatorGrowth() {
  var result = {
    today: 0, week: 0, month: 0, total: 0,
    online: 0, synced: 0,
    monitored: Object.keys(PUBLIC_NODES).length,
    monitored_online: 0, monitored_at_head: 0,
    discovered: 0, discovered_online: 0,
    network_head: 0,
    validators: []
  };
  var pubOnline = (latestPublicNodes || []).filter(function(n) { return n.ok && n.block; });
  if (pubOnline.length > 0) result.network_head = Math.max.apply(null, pubOnline.map(function(n) { return n.block; }));
  if (!sharedDb) return result;
  try {
    var now = Date.now();
    var dayAgo = now - 86400000;
    var weekAgo = now - 604800000;
    var monthAgo = now - 2592000000; // 30 days
    // v7.4: counts from validator_discoveries EXCLUDING monitored identities (clean discovered count)
    // Filter in JS — simpler than parameterized NOT IN, and the row count is small
    var allRows = sharedDb.query("SELECT identity, first_seen FROM validator_discoveries").all();
    var discRows = allRows.filter(function(r) {
      if (PUBLIC_NODE_IDENTITIES[r.identity]) return false;
      if (FIXNET_NODE_IDENTITIES[r.identity]) return false;
      return true;
    });
    result.total = discRows.length;
    result.today = discRows.filter(function(r){ return r.first_seen > dayAgo }).length;
    result.week = discRows.filter(function(r){ return r.first_seen > weekAgo }).length;
    result.month = discRows.filter(function(r){ return r.first_seen > monthAgo }).length;
    result.discovered = discRows.length;

    var syncedCount = 0;
    var validators = [];

    // v7.4 Pass 1: Emit ALL monitored nodes (from PUBLIC_NODES), regardless of DB state.
    // Ensures kyne-node3b etc. always appear even if they never got peer-crawled.
    var pubIdToName = {};
    for (var pn in PUBLIC_NODES) { pubIdToName[PUBLIC_NODES[pn].identity] = pn; }
    var monitoredFirstSeen = {};
    try {
      var monRows = sharedDb.query("SELECT identity, first_seen FROM validator_discoveries").all();
      for (var mri = 0; mri < monRows.length; mri++) { monitoredFirstSeen[monRows[mri].identity] = monRows[mri].first_seen; }
    } catch(ee){}
    for (var pnName in PUBLIC_NODES) {
      var pnDef = PUBLIC_NODES[pnName];
      var pnLive = (latestPublicNodes || []).find(function(n){ return n.name === pnName; });
      var block = pnLive && pnLive.block ? pnLive.block : null;
      var online = pnLive ? !!pnLive.ok : false;
      var lag = (block && result.network_head > 0) ? result.network_head - block : null;
      var syncPct = (block && result.network_head > 0) ? Math.round((block / result.network_head) * 1000) / 10 : 0;
      var fs = monitoredFirstSeen[pnDef.identity] || now;
      validators.push({
        display: pnName,
        identity: pnDef.identity,
        block: block,
        lag: lag,
        sync_pct: syncPct,
        online: online,
        monitored: true,
        first_seen_hours_ago: Math.round((now - fs) / 3600000)
      });
      if (online) { result.online++; result.monitored_online++; }
      if (online && lag !== null && lag < 100) { syncedCount++; result.monitored_at_head++; }
    }

    // v7.4 Pass 2: Iterate DB for DISCOVERED-only rows (exclude monitored identities)
    var dbRows = sharedDb.query("SELECT identity, first_seen, connection FROM validator_discoveries ORDER BY first_seen").all();
    for (var vi = 0; vi < dbRows.length; vi++) {
      var row = dbRows[vi];
      var identity = row.identity;
      if (FIXNET_NODE_IDENTITIES[identity]) continue;
      if (PUBLIC_NODE_IDENTITIES[identity]) continue; // skip monitored (already pushed in Pass 1)
      var display = (row.connection || "unknown").replace("http://", "");
      var block = null, online = false;
      if (discoveredPeers[identity]) {
        block = discoveredPeers[identity].block || null;
        online = discoveredPeers[identity].online || false;
      }
      var lag = (block && result.network_head > 0) ? result.network_head - block : null;
      var syncPct = (block && result.network_head > 0) ? Math.round((block / result.network_head) * 1000) / 10 : 0;
      validators.push({
        display: display,
        identity: identity,
        block: block,
        lag: lag,
        sync_pct: syncPct,
        online: online,
        monitored: false,
        first_seen_hours_ago: Math.round((now - row.first_seen) / 3600000)
      });
      if (online) { result.online++; result.discovered_online++; }
      if (online && lag !== null && lag < 100) syncedCount++;
    }
    // M6: Historical reliability from public_node_history
    var histStats = {};
    try {
      var cutoff = now - 7 * 86400000;
      var histRows = sharedDb.query("SELECT node_states FROM public_node_history WHERE ts > ? ORDER BY ts DESC").all(cutoff);
      if (histRows.length > 10) {
        for (var hi = 0; hi < histRows.length; hi++) {
          var hnodes = JSON.parse(histRows[hi].node_states);
          for (var ni = 0; ni < hnodes.length; ni++) {
            var nd = hnodes[ni];
            if (!histStats[nd.name]) histStats[nd.name] = { total: 0, online: 0, latencySum: 0, latencyCount: 0 };
            var hst = histStats[nd.name];
            hst.total++;
            if (nd.ok) {
              hst.online++;
              if (nd.latency && nd.latency > 0) { hst.latencySum += nd.latency; hst.latencyCount++; }
            }
          }
        }
      }
    } catch(hErr) { log("  [m6] History error: " + hErr.message); }
    for (var vj = 0; vj < validators.length; vj++) {
      var vName = validators[vj].display;
      var vhs = histStats[vName];
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
  } catch(e) { return result; }
}

function generateNetworkAgreement(fleetData, publicNodes) {
  // Network agreement is calculated from PUBLIC nodes only.
  // Fleet nodes run on a separate testnet chain and are NOT included here.
  // Fleet data is used separately for oracle confidence scoring only.
  var allBlocks = [];

  if (publicNodes) {
    publicNodes.forEach(function(n) {
      if (n.block && n.ok) allBlocks.push({ name: n.name, block: n.block, source: n.source_type || "public" });
    });
  }

  if (allBlocks.length === 0) return { status: "unknown", block_spread: 0, median_block: null, max_block: null, aligned_nodes: 0, outlier_nodes: [], total_nodes: 0, agreement_ratio: 0 };

  var blocks = allBlocks.map(function(n) { return n.block; }).sort(function(a,b) { return a-b; });
  var maxBlock = blocks[blocks.length - 1];
  var minBlock = blocks[0];
  var medianBlock = blocks[Math.floor(blocks.length / 2)];
  var blockSpread = maxBlock - minBlock;

  // Nodes within 10 blocks of median are "aligned"
  var ALIGNMENT_THRESHOLD = 10;
  var aligned = allBlocks.filter(function(n) { return Math.abs(n.block - medianBlock) <= ALIGNMENT_THRESHOLD; });
  var outliers = allBlocks.filter(function(n) { return Math.abs(n.block - medianBlock) > ALIGNMENT_THRESHOLD; });
  var agreementRatio = Math.round((aligned.length / allBlocks.length) * 100);

  var status = "unknown";
  if (agreementRatio >= 90) status = "strong";
  else if (agreementRatio >= 70) status = "moderate";
  else if (agreementRatio >= 50) status = "weak";
  else status = "diverged";

  return {
    status: status,
    block_spread: blockSpread,
    median_block: medianBlock,
    max_block: maxBlock,
    min_block: minBlock,
    aligned_nodes: aligned.length,
    outlier_nodes: outliers.map(function(n) { return { name: n.name, block: n.block, lag: maxBlock - n.block }; }),
    total_nodes: allBlocks.length,
    agreement_ratio: agreementRatio
  };
}

function generateDecision(data, stalenessSeconds, signals) {
  if (!data || !data.nodeReports) {
    return { status: "uncertain", trend: "unknown", confidence: 0.0, risk_level: "high", reason: "No fleet data available", affected_components: ["data"], valid_until: new Date(Date.now() + 60000).toISOString(), last_updated: new Date().toISOString() };
  }

  // Use PUBLIC nodes for decision — not fleet
  var pubNodes = latestPublicNodes || [];
  var total = pubNodes.length || 1;
  var healthy = pubNodes.filter(function(n) { return n.ok; }).length;
  var offline = pubNodes.filter(function(n) { return !n.ok; }).length;
  var blocks = pubNodes.map(function(n) { return n.block; }).filter(Boolean);
  var blockSpread = blocks.length > 1 ? Math.max.apply(null, blocks) - Math.min.apply(null, blocks) : 0;
  var PUBLIC_SIGNAL_TYPES = ["public_node_offline","public_network_block","discovered_validators"];
  var criticalSignals = signals.filter ? signals.filter(function(s) { return s.severity === "critical" && PUBLIC_SIGNAL_TYPES.indexOf(s.type) !== -1; }) : [];
  var warningSignals = signals.filter ? signals.filter(function(s) { return s.severity === "warning" && PUBLIC_SIGNAL_TYPES.indexOf(s.type) !== -1; }) : [];
  var chainStall = false;

  // Confidence: start at 1.0, subtract penalties
  var confidence = 1.0;
  if (stalenessSeconds > 300) confidence -= 0.3;
  else if (stalenessSeconds > 60) confidence -= 0.1;
  confidence -= (offline / total) * 0.4;
  confidence -= criticalSignals.length * 0.15;
  confidence -= warningSignals.length * 0.05;
  if (blockSpread > 50) confidence -= 0.1;
  confidence = Math.max(0.0, Math.min(1.0, Math.round(confidence * 100) / 100));

  // Status
  var status, risk_level, reason, affected = [];
  if (chainStall) {
    status = "unstable"; risk_level = "high";
    reason = "Chain-level issue detected — no block progression";
    affected = ["network", "chain"];
  } else if (stalenessSeconds > 300) {
    status = "uncertain"; risk_level = "medium";
    reason = "Data is stale (" + Math.round(stalenessSeconds / 60) + " min) — observations may not reflect current state";
    affected = ["data"];
  } else if (offline >= Math.ceil(total * 0.5)) {
    status = "unstable"; risk_level = "high";
    reason = offline + "/" + total + " nodes offline — majority unreachable";
    affected = ["network", "nodes"];
  } else if (offline > 1 || criticalSignals.length > 0) {
    status = "degraded"; risk_level = "medium";
    reason = offline + " node(s) offline, " + criticalSignals.length + " critical signal(s)";
    affected = ["nodes"];
  } else if (offline === 1 || warningSignals.length > 0 || blockSpread > 10) {
    status = "stable"; risk_level = "low";
    reason = "Network stable, " + (offline === 1 ? "1 node offline" : warningSignals.length + " warning(s)");
    affected = ["nodes"];
  } else if (healthy === total) {
    status = "stable"; risk_level = "low";
    reason = "Network stable — reference nodes synced, zero active incidents";
    affected = [];
  } else {
    status = "recovering"; risk_level = "medium";
    reason = healthy + "/" + total + " nodes healthy";
    affected = ["nodes"];
  }

  // Valid for 2x the monitor interval (2 min)
  var validUntil = new Date(Date.now() + 120000).toISOString();

  return {
    status: status,
    risk_level: risk_level,
    confidence: confidence,
    reason: reason,
    affected_components: affected,
    valid_until: validUntil,
    last_updated: new Date().toISOString()
  };
}

function generateScores(data, stalenessSeconds, signals) {
  if (!data || !data.nodeReports) return { network_health: 0, stability: 0, partition_risk: 100, data_confidence: 0 };

  // Use PUBLIC nodes for scores — not fleet
  var pubNodes = latestPublicNodes || [];
  var total = pubNodes.length || 1;
  var healthy = pubNodes.filter(function(n) { return n.ok; }).length;
  var offline = pubNodes.filter(function(n) { return !n.ok; }).length;
  var blocks = pubNodes.map(function(n) { return n.block; }).filter(Boolean);
  var blockSpread = blocks.length > 1 ? Math.max.apply(null, blocks) - Math.min.apply(null, blocks) : 0;
  var sideImbalance = 0;
  var PUBLIC_SIGS = ["public_node_offline","public_network_block"];
  var criticalCount = signals.filter ? signals.filter(function(s) { return s.severity === "critical" && PUBLIC_SIGS.indexOf(s.type) !== -1; }).length : 0;

  var network_health = Math.round((healthy / total) * 100);
  var stability = Math.max(0, Math.round(100 - (blockSpread / 10) - (criticalCount * 15) - (offline * 10)));
  var partition_risk = Math.min(100, Math.round((blockSpread > 100 ? 50 : blockSpread > 10 ? 20 : 0) + (offline > 0 ? offline * 10 : 0)));
  var data_confidence = Math.max(0, Math.round(100 - (stalenessSeconds > 300 ? 40 : stalenessSeconds > 60 ? 10 : 0) - (criticalCount * 10)));

  return {
    network_health: network_health,
    stability: Math.min(100, stability),
    partition_risk: partition_risk,
    data_confidence: data_confidence
  };
}

// === Layer 2: Canonical truth model ===
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
 *
 * - Risk captures reduced redundancy even when status is stable.
 *
 * - Confidence reflects data quality, not network health.
 *
 * - Incidents represent active problems only, not historical events.
 */
function computeCanonicalState() {
  var publicNodes = latestPublicNodes || [];
  var stalenessSeconds = lastCycleAt ? Math.round((Date.now() - lastCycleAt) / 1000) : 0;
  var pubOnline = publicNodes.filter(function(n) { return n.ok; });
  var pubTotal = publicNodes.length;
  var pubReachable = pubOnline.length;

  var data_quality = "sufficient";
  if (pubReachable < 2) data_quality = "insufficient";
  if (stalenessSeconds > 300) data_quality = "insufficient";

  var agreement;
  if (pubReachable < 2) {
    agreement = { state: "unknown", aligned_nodes: pubReachable, total_nodes: pubTotal, median_block: null, block_spread: 0 };
  } else {
    var blocks = pubOnline.map(function(n) { return n.block; }).filter(Boolean).sort(function(a, b) { return a - b; });
    if (blocks.length < 2) {
      agreement = { state: "unknown", aligned_nodes: blocks.length, total_nodes: pubTotal, median_block: blocks[0] || null, block_spread: 0 };
    } else {
      var medianBlock = blocks[Math.floor(blocks.length / 2)];
      var blockSpread = blocks[blocks.length - 1] - blocks[0];
      var alignedCount = 0;
      for (var ai = 0; ai < blocks.length; ai++) { if (Math.abs(blocks[ai] - medianBlock) <= 25) alignedCount++; }
      var agState;
      if (alignedCount === blocks.length && blockSpread <= 20) agState = "strong";
      else if (alignedCount >= Math.ceil(blocks.length * 0.6)) agState = "moderate";
      else agState = "weak";
      agreement = { state: agState, aligned_nodes: alignedCount, total_nodes: blocks.length, median_block: medianBlock, block_spread: blockSpread, max_block: blocks[blocks.length - 1], min_block: blocks[0] };
    }
  }

  var confidence = "clear";
  var confidenceReason = "Observed public signals agree";
  if (data_quality === "insufficient") {
    confidence = "uncertain";
    confidenceReason = "Insufficient reachable public nodes to cross-check";
  } else if (pubReachable === 1) {
    confidenceReason = "Single reachable public node — no cross-check performed";
  } else if (pubReachable >= 2) {
    var pubBlocks = pubOnline.map(function(n) { return n.block; }).filter(Boolean);
    if (pubBlocks.length >= 2 && Math.max.apply(null, pubBlocks) - Math.min.apply(null, pubBlocks) > 50) {
      confidence = "uncertain";
      confidenceReason = "Reachable public nodes report widely different block heights";
    }
  }

  var publicActiveIncs = Object.values(activeIncidents).filter(function(inc) {
    if (inc.description && (inc.description.indexOf("Fleet reference") === 0 || inc.description === "Chain-level issue detected")) return false;
    if (inc.affectedNodes && inc.affectedNodes.every(function(n) { return FLEET_NODE_NAMES.includes(n); })) return false;
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

  // Status = network operability (NOT observer coverage)
  // Do not degrade status only because some monitored nodes are offline
  var status;
  if (data_quality === "insufficient") status = "unknown";
  else if (max_incident_severity === "critical" || agreement.state === "weak") status = "unstable";
  else if (pubReachable === 1 || max_incident_severity === "warning" || agreement.state === "moderate") status = "degraded";
  else status = "stable";

  // Risk = resilience / safety margin
  // Includes reduced node redundancy even when status is stable
  var risk;
  if (status === "unknown") risk = "elevated";
  else if (status === "unstable" || max_incident_severity === "critical" || agreement.state === "weak") risk = "high";
  else if (status === "degraded" || max_incident_severity === "warning" || confidence === "uncertain" || agreement.state === "moderate" || (pubTotal > 2 && pubTotal - pubReachable > 1)) risk = "elevated";
  else risk = "low";

  // M4: Trend computation from public node history
  var trend = "unknown";
  if (data_quality === "sufficient" && sharedDb) {
    try {
      var histRows = sharedDb.query("SELECT nodes_reachable, nodes_total, agreement_state, block_spread FROM public_node_history ORDER BY ts DESC LIMIT 15 OFFSET 1").all();
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
        // Signal 1: nodes reachable
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

  var summary;
  if (status === "unknown") summary = "Insufficient data — fewer than 2 public nodes reachable";
  else if (status === "stable" && publicIncidentCount === 0) {
    if (pubReachable === pubTotal) summary = "Network operable. All " + pubTotal + " public nodes reachable and aligned.";
    else if (pubReachable === 2) summary = "Network operable. 2 of " + pubTotal + " public nodes reachable; both aligned.";
    else summary = "Network operable. " + pubReachable + " of " + pubTotal + " public nodes reachable; all reachable nodes aligned.";
  }
  else if (status === "degraded") {
    var offCount = pubTotal - pubReachable;
    if (offCount > 0) {
      summary = "Network partially operable. " + offCount + " of " + pubTotal + " public node" + (offCount === 1 ? "" : "s") + " unreachable; agreement " + agreement.state + ".";
    } else {
      summary = "Network partially operable. " + publicIncidentCount + " active incident" + (publicIncidentCount === 1 ? "" : "s") + "; agreement " + agreement.state + ".";
    }
  } else if (status === "unstable") {
    summary = "Network operability impaired. " + publicIncidentCount + " active incident" + (publicIncidentCount === 1 ? "" : "s") + "; agreement " + agreement.state + ".";
  } else {
    summary = "Network state unknown. " + pubReachable + " of " + pubTotal + " public nodes reachable.";
  }

  var statusReason = "";
  if (status === "stable") statusReason = "Blocks advancing; reachable nodes aligned";
  else if (status === "unstable") statusReason = agreement.state === "weak" ? "Significant disagreement among reachable nodes" : max_incident_severity === "critical" ? "Critical incidents active" : "Network operability impaired";
  else if (status === "degraded") statusReason = pubReachable === 1 ? "A public node is advancing; broader visibility is limited" : max_incident_severity === "warning" ? "Warning-level incidents active" : "Agreement reduced among reachable nodes";
  else statusReason = "Insufficient data to assess network state";
  var riskFactors = [];
  if (pubTotal > 2 && pubTotal - pubReachable > 1) riskFactors.push("Only " + pubReachable + " of " + pubTotal + " public nodes reachable — limited cross-checking");
  if (max_incident_severity === "warning") riskFactors.push("warning-level incidents active");
  if (max_incident_severity === "critical") riskFactors.push("critical incidents active");
  if (agreement.state === "moderate") riskFactors.push("agreement is moderate, not strong");
  var agreementReason = "";
  if (agreement.state === "unknown") agreementReason = "Fewer than 2 reachable nodes";
  else agreementReason = agreement.aligned_nodes + " of " + agreement.total_nodes + " reachable nodes within ±25 blocks of median (spread: " + agreement.block_spread + " blocks)";
  return { status: status, trend: trend, risk: risk, data_quality: data_quality, confidence: confidence, confidence_reason: confidenceReason, agreement: agreement, active_incidents: publicIncidentCount, max_incident_severity: max_incident_severity, summary: summary, status_reason: statusReason, risk_factors: riskFactors, agreement_reason: agreementReason, staleness_seconds: stalenessSeconds, last_updated: new Date().toISOString(), api_version: "1.0" };
}

// M3: Record public node observation snapshot
function recordPublicNodeHistory() {
  if (!sharedDb) return;
  try {
    var canonical = computeCanonicalState();
    var nodes = (latestPublicNodes || []).map(function(n) {
      return { name: n.name, identity: n.identity || null, ok: n.ok || false, block: n.block || null, latency: n.latencyMs || null };
    });
    sharedDb.run(
      "INSERT INTO public_node_history (ts, status, risk, confidence, data_quality, agreement_state, median_block, block_spread, nodes_total, nodes_reachable, node_states) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        Date.now(),
        canonical.status,
        canonical.risk,
        canonical.confidence,
        canonical.data_quality,
        canonical.agreement.state,
        canonical.agreement.median_block,
        canonical.agreement.block_spread,
        canonical.agreement.total_nodes,
        nodes.filter(function(n) { return n.ok; }).length,
        JSON.stringify(nodes)
      ]
    );
    var cutoff = Date.now() - 7 * 86400000;
    sharedDb.run("DELETE FROM public_node_history WHERE ts < ?", [cutoff]);
  } catch(e) { log("  [history] Public node history write error: " + e.message); }
}

function generateSignals(data, stalenessSeconds) {
  var signals = [];
  if (!data || !data.nodeReports) {
    signals.push({ type: "no_data", severity: "warning", nodes: [], value: null, message: "No fleet data available yet" });
    return signals;
  }
  var nodes = data.nodeReports;
  var total = nodes.length;
  var onlineNodes = nodes.filter(function(n) { return n.online; });
  var offlineNodes = nodes.filter(function(n) { return !n.online; });
  var lagNodes = nodes.filter(function(n) { return n.issues && n.issues.some(function(i) { return i.indexOf("BLOCK_LAG") !== -1; }); });
  var mismatchNodes = nodes.filter(function(n) { return !n.identityMatch; });
  var notReadyNodes = nodes.filter(function(n) { return n.online && !n.ready; });
  var notSyncedNodes = nodes.filter(function(n) { return !n.syncOk; });
  var maxBlock = Math.max.apply(null, nodes.map(function(n) { return n.blockHeight || 0; }));
  var minBlock = Math.min.apply(null, nodes.filter(function(n) { return n.blockHeight; }).map(function(n) { return n.blockHeight; }));

  // Offline nodes
  if (offlineNodes.length > 0) {
    var sev = offlineNodes.length >= 3 ? "critical" : offlineNodes.length >= 2 ? "warning" : "info";
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
    signals.push({ type: "identity_mismatch", severity: "critical", nodes: mismatchNodes.map(function(n) { return n.name; }), value: mismatchNodes.length, message: mismatchNodes.map(function(n) { return n.name; }).join(", ") + " identity mismatch — possible hijack" });
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
      var pubBlocks = pubOnline.map(function(n) { return n.block; }).filter(Boolean);
      var pubBlock = pubBlocks.length > 0 ? Math.max.apply(null, pubBlocks) : null;
      if (pubBlock) signals.push({ type: "public_network_block", severity: "info", nodes: pubOnline.map(function(n) { return n.name; }), value: pubBlock, message: "Public network at block " + pubBlock + " (" + pubOnline.length + " nodes online)" });
    }
  }

  // Discovered non-fleet validators
  var discovered = Object.values(discoveredPeers || {});
  if (discovered.length > 0) {
    var onlineDiscovered = discovered.filter(function(p) { return p.online; });
    signals.push({ type: "discovered_validators", severity: "info", nodes: discovered.map(function(p) { return p.identity.substring(0,12)+"..."; }), value: discovered.length, message: discovered.length + " non-fleet validator(s) discovered (" + onlineDiscovered.length + " online)" });
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
for (var _r of PUBLIC_RPCS) publicRpcStats[_r.name] = { reachable: 0, total: 0, totalLatency: 0 };
let dailyAlertCount = 0;
let dailyRecoveryCount = 0;
let dailyBlockStart = null;
let dailySummaryCounter = 0;

// FIX BUG 7: Track when last cycle ran
let lastCycleAt = 0;

function expectedConnStr(name) {
  var n = EXPECTED_FLEET[name];
  return "http://" + n.host + ":" + n.port;
}

var IDENTITY_TO_NAME = {};
for (var _name in EXPECTED_FLEET) {
  IDENTITY_TO_NAME[EXPECTED_FLEET[_name].identity] = _name;
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
      nodeReports: [{ name: "n3", status: "UNHEALTHY", issues: ["LOCAL_INFO_UNREACHABLE"] }],
      chain: { block: null, onlineCount: 0, readyCount: 0, syncedCount: 0, tps: null },
      problems: [{ name: "n3", issues: ["LOCAL_INFO_UNREACHABLE"] }],
    };
  }

  var info = localInfoResult.data;
  log("  n3 /info OK (" + localInfoResult.latencyMs + "ms) version " + info.version + " " + info.version_name);
  nodeVersions.n3 = { version: info.version || null, versionName: info.version_name || null };

  var n3IdentityOk = info.identity === EXPECTED_FLEET.n3.identity;

  var peerByConn = {};
  for (var j = 0; j < (info.peerlist || []).length; j++) {
    var peer = info.peerlist[j];
    if (peer.connection && peer.connection.string) peerByConn[peer.connection.string] = peer;
  }

  var problems = [];
  var nodeReports = [];
  var blockHeights = {};

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

    if (name === "n3") {
      identityMatch = n3IdentityOk;
      online = true;
      ready = true;
      var firstPeer = info.peerlist && info.peerlist[0];
      blockHeight = firstPeer && firstPeer.sync ? firstPeer.sync.block : null;
      syncOk = true;
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

  var offline = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "OFFLINE" || i === "NOT_IN_PEERLIST"; }); });
  var notSynced = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "NOT_SYNCED"; }); });
  var blockLag = data.problems.filter(function(p) { return p.issues.some(function(i) { return i.indexOf("BLOCK_LAG") === 0; }); });
  var notReady = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "NOT_READY"; }); });
  var idMismatch = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "IDENTITY_MISMATCH"; }); });
  var chainIssues = data.problems.filter(function(p) { return p.name === "CHAIN"; });
  var expDown = data.problems.filter(function(p) { return p.issues.some(function(i) { return i === "EXPORTER_DOWN"; }); });

  var parts = [];
  if (offline.length > 0) parts.push("OFFLINE: " + offline.map(function(p) { return p.name; }).join(","));
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
      var result = await demos.store(payload);
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
      await demos.connect(fallbackList[fi]);
      var fbResult = await demos.store(payload);
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
      try { await demos.connect(activeRpcUrl); } catch(re) {}
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

  try {
    if (!demos.web2 || typeof demos.web2.createDahr !== "function") {
      if (dahrAvailable === null) {
        log("  DAHR: demos.web2.createDahr not available in this SDK version. Skipping attestations.");
        dahrAvailable = false;
      }
      return null;
    }

    var dahr = await demos.web2.createDahr();
    var result = await dahr.startProxy({ url: url, method: method || "GET" });

    // The SDK returns: { result: 200, response: { data: { valid, reference_block, transaction }, signature: {...}, rpc_public_key: {...} } }
    var resp = result.response || {};
    var respData = resp.data || {};
    var sig = resp.signature || {};
    var refBlock = respData.reference_block || null;

    if (dahrAvailable === null) {
      log("  DAHR: attestation available and working. ref_block=" + refBlock);
      dahrAvailable = true;
    }

    return {
      url: url,
      referenceBlock: refBlock,
      valid: respData.valid || null,
      signature: sig.data || null,
      signatureType: sig.type || null,
      rpcPublicKey: resp.rpc_public_key ? resp.rpc_public_key.data : null,
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
  for (var i = 0; i < PUBLIC_RPCS.length; i++) {
    var rpc = PUBLIC_RPCS[i];
    publicRpcStats[rpc.name].total++;
    try {
      var start = Date.now();
      var res = await fetch(rpc.url, { signal: AbortSignal.timeout(PUBLIC_PROBE_TIMEOUT_MS) });
      var latencyMs = Date.now() - start;
      if (res.ok) {
        var data = await res.json();
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
  var results = [];
  for (var name in PUBLIC_NODES) {
    var node = PUBLIC_NODES[name];
    try {
      var start = Date.now();
      var res = await fetch(node.url + "/info", { signal: AbortSignal.timeout(5000) });
      var latencyMs = Date.now() - start;
      if (res.ok) {
        var data = await res.json();
        var block = null;
        if (data.peerlist && data.peerlist[0] && data.peerlist[0].sync) {
          block = data.peerlist[0].sync.block;
        }
        var identityMatch = data.identity === node.identity;
        results.push({ name: name, identity: node.identity, ok: true, latencyMs: latencyMs, block: block, version: data.version || "?", peers: data.peerlist ? data.peerlist.length : 0, identityMatch: identityMatch, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" });
        log("  PublicNode " + name + ": OK " + latencyMs + "ms block=" + (block||"?") + " peers=" + (data.peerlist?data.peerlist.length:0));
      } else {
        results.push({ name: name, identity: node.identity, ok: false, error: "HTTP " + res.status, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" });
        log("  PublicNode " + name + ": FAIL HTTP " + res.status);
      }
    } catch(err) {
      results.push({ name: name, identity: node.identity, ok: false, error: err.name === "TimeoutError" ? "Timeout" : err.message, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" });
      log("  PublicNode " + name + ": FAIL " + err.message);
    }
  }
  return results;
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
            block = selfEntry.sync.block;
          } else if (data.peerlist[0] && data.peerlist[0].sync) {
            // Fallback: first peer (anchor convention)
            block = data.peerlist[0].sync.block;
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
          version: data.version || "?",
          peers: data.peerlist ? data.peerlist.length : 0,
          identityMatch: identityMatch,
          source_type: node.source_type,
          trust_tier: node.trust_tier,
          operator: node.operator
        });
        // v7.2: crawl anchor's peerlist for new fixnet validators
        if (node.source_type === "anchor") {
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
        error: err.name === "TimeoutError" ? "Timeout" : err.message,
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
// Inserts/upserts into fixnet_validator_discoveries table.
function discoverFixnetValidators(anchorInfoData) {
  if (!anchorInfoData || !anchorInfoData.peerlist || !sharedDb) return 0;
  var added = 0;
  var now = Date.now();
  for (var i = 0; i < anchorInfoData.peerlist.length; i++) {
    var peer = anchorInfoData.peerlist[i];
    var identity = peer && peer.identity;
    if (!identity) continue;

    // Skip known identities (monitored fixnet, monitored testnet, or known fleet)
    if (FIXNET_NODE_IDENTITIES[identity]) continue;
    if (PUBLIC_NODE_IDENTITIES[identity]) continue;
    if (IDENTITY_TO_NAME && IDENTITY_TO_NAME[identity]) continue;

    var connection = peer.connection && peer.connection.string ? peer.connection.string : null;
    var block = peer.sync && peer.sync.block ? peer.sync.block : null;
    var online = peer.status && peer.status.online ? 1 : 0;

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

  // Which ones are due for a probe?
  var due = rows.filter(function(r) {
    if (!r.connection) return false;
    if (!r.last_probed_at) return true; // never probed
    return (now - r.last_probed_at) >= PROBE_INTERVAL_MS;
  });

  // Probe all due nodes in parallel with a bounded timeout (5s per probe)
  var probePromises = due.map(function(r) {
    return (async function() {
      var probedAt = Date.now();
      var connUrl = r.connection.replace(/\/$/, "");
      try {
        var resp = await fetch(connUrl + "/info", { signal: AbortSignal.timeout(5000) });
        var latencyMs = Date.now() - probedAt;
        if (resp.ok) {
          var data = await resp.json();
          var selfBlock = null;
          if (data.peerlist && Array.isArray(data.peerlist)) {
            var self = data.peerlist.find(function(p) { return p.identity === r.identity; });
            if (self && self.sync) selfBlock = self.sync.block;
          }
          sharedDb.run(
            "UPDATE fixnet_validator_discoveries SET online = 1, last_block = COALESCE(?, last_block), last_probed_at = ?, last_latency_ms = ? WHERE identity = ?",
            [selfBlock, probedAt, latencyMs, r.identity]
          );
          return { ok: true, identity: r.identity, block: selfBlock, latencyMs: latencyMs };
        } else {
          sharedDb.run(
            "UPDATE fixnet_validator_discoveries SET online = 0, last_probed_at = ?, last_latency_ms = NULL WHERE identity = ?",
            [probedAt, r.identity]
          );
          return { ok: false, identity: r.identity, error: "HTTP " + resp.status };
        }
      } catch (e) {
        sharedDb.run(
          "UPDATE fixnet_validator_discoveries SET online = 0, last_probed_at = ?, last_latency_ms = NULL WHERE identity = ?",
          [probedAt, r.identity]
        );
        return { ok: false, identity: r.identity, error: e.message || String(e) };
      }
    })();
  });

  if (probePromises.length > 0) {
    await Promise.all(probePromises);
    log("  [fixnet-discovery] probed " + probePromises.length + " discovered node(s)");
  }

  // Return fresh data (including just-updated rows) for use in UI/API payload
  try {
    var fresh = sharedDb.query(
      "SELECT identity, connection, first_seen, last_seen, online, last_block, last_probed_at, last_latency_ms FROM fixnet_validator_discoveries ORDER BY last_seen DESC"
    ).all();
    return (fresh || []).map(function(r) {
      return {
        identity: r.identity,
        connection: r.connection,
        online: r.online === 1 || r.online === true,
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
  for (var rpc of PUBLIC_RPCS) {
    var rs = publicRpcStats[rpc.name];
    var rpcPct = rs.total > 0 ? Math.round((rs.reachable / rs.total) * 100) : 0;
    var avgLatency = rs.reachable > 0 ? Math.round(rs.totalLatency / rs.reachable) : 0;
    rpcParts.push(rpc.name + ":" + rpcPct + "% avg " + avgLatency + "ms");
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
  for (var rpc of PUBLIC_RPCS) publicRpcStats[rpc.name] = { reachable: 0, total: 0, totalLatency: 0 };
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

// --- Reputation scoring (0-100 per node) ---
function calculateReputationScores() {
  var scores = {};
  for (var name of NODE_NAMES) {
    scores[name] = calculateNodeReputation(name);
  }
  return scores;
}

function calculateNodeReputation(name) {
  if (history.length === 0) return 50; // neutral if no history

  // Look at last 72 cycles (24h) or whatever we have
  var window = history.slice(-72);
  var total = window.length;
  var healthyCycles = 0;
  var syncedCycles = 0;
  var lagSum = 0;
  var lagCount = 0;

  for (var i = 0; i < window.length; i++) {
    var nodeData = window[i].nodes[name];
    if (!nodeData) continue;

    if (nodeData.healthy) healthyCycles++;

    // Check if node was synced (no NOT_SYNCED or BLOCK_LAG issues)
    var hadSyncIssue = (nodeData.issues || []).some(function(iss) {
      return iss === "NOT_SYNCED" || iss.indexOf("BLOCK_LAG") === 0;
    });
    if (!hadSyncIssue) syncedCycles++;

    // Block lag relative to max block that cycle
    if (nodeData.block != null && window[i].block != null) {
      var lag = window[i].block - nodeData.block;
      lagSum += lag;
      lagCount++;
    }
  }

  var uptimeScore = total > 0 ? (healthyCycles / total) * 40 : 20; // 0-40 points
  var syncScore = total > 0 ? (syncedCycles / total) * 30 : 15; // 0-30 points
  var avgLag = lagCount > 0 ? lagSum / lagCount : 0;
  var lagScore = Math.max(0, 30 - avgLag * 10); // 0-30 points, loses 10 per avg block lag

  return Math.round(uptimeScore + syncScore + lagScore);
}

function composeLeaderboard(scores) {
  var sorted = Object.entries(scores).sort(function(a, b) { return b[1] - a[1]; });
  var parts = sorted.map(function(entry) { return entry[0] + ":" + entry[1]; });
  var text = "Node Reputation Leaderboard (24h): " + parts.join(" ") + ". Based on uptime, sync, and block lag.";
  if (text.length > 280) text = text.substring(0, 277) + "...";
  return { cat: "OBSERVATION", text: text, confidence: 85 };
}

// --- Predictive alerts (detect degradation trends) ---
function detectTrends() {
  if (history.length < 12) return []; // need at least 4 hours of data

  var alerts = [];
  var recent = history.slice(-6); // last 2 hours
  var earlier = history.slice(-18, -6); // 2-6 hours ago
  if (earlier.length < 6) return [];

  for (var name of NODE_NAMES) {
    var recentHealthy = 0, recentTotal = 0;
    var earlierHealthy = 0, earlierTotal = 0;

    for (var i = 0; i < recent.length; i++) {
      if (recent[i].nodes[name]) {
        recentTotal++;
        if (recent[i].nodes[name].healthy) recentHealthy++;
      }
    }
    for (var j = 0; j < earlier.length; j++) {
      if (earlier[j].nodes[name]) {
        earlierTotal++;
        if (earlier[j].nodes[name].healthy) earlierHealthy++;
      }
    }

    var recentPct = recentTotal > 0 ? recentHealthy / recentTotal : 1;
    var earlierPct = earlierTotal > 0 ? earlierHealthy / earlierTotal : 1;

    // If health dropped significantly
    if (earlierPct > 0.8 && recentPct < 0.6) {
      var dropPct = Math.round((earlierPct - recentPct) * 100);
      alerts.push(name + " health degraded " + dropPct + "% in last 2h");
    }
  }

  return alerts;
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
let discoveredPeers = {}; // { identity: { firstSeen, lastSeen, connection, ... } }
let nodeVersions = {}; // { "n3": { version: "0.9.8", versionName: "Oxlong Michael" }, ... }

function discoverValidators(infoData) {
  if (!infoData || !infoData.peerlist) return [];
  var newPeers = [];

  for (var i = 0; i < infoData.peerlist.length; i++) {
    var peer = infoData.peerlist[i];
    var identity = peer.identity;
    if (!identity) continue;

    // Check if this is a known fleet or public node
    if (IDENTITY_TO_NAME[identity]) continue;
    if (PUBLIC_NODE_IDENTITIES[identity]) continue;
    if (FIXNET_NODE_IDENTITIES[identity]) continue;

    // Unknown peer — track it
    if (!discoveredPeers[identity]) {
      discoveredPeers[identity] = {
        identity: identity,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        connection: peer.connection ? peer.connection.string : "unknown",
        online: peer.status ? peer.status.online : false,
        block: peer.sync ? peer.sync.block : null,
      };
      newPeers.push(identity.substring(0, 16) + "...");
      log("  Discovery: new peer " + identity.substring(0, 16) + "... via " + (peer.connection ? peer.connection.string : "?"));
      // Persist to DB
      if (sharedDb) { try { sharedDb.run("INSERT OR IGNORE INTO validator_discoveries (identity, first_seen, last_seen, connection) VALUES (?, ?, ?, ?)", [identity, Date.now(), Date.now(), peer.connection ? peer.connection.string : "unknown"]); } catch(e) {} }
      // Persist to DB
      if (sharedDb) { try { sharedDb.run("INSERT OR IGNORE INTO validator_discoveries (identity, first_seen, last_seen, connection) VALUES (?, ?, ?, ?)", [identity, Date.now(), Date.now(), peer.connection ? peer.connection.string : "unknown"]); } catch(e) {} }
    } else {
      discoveredPeers[identity].lastSeen = Date.now();
      discoveredPeers[identity].online = peer.status ? peer.status.online : false;
      discoveredPeers[identity].block = peer.sync ? peer.sync.block : null;
      if (sharedDb) { try { sharedDb.run("UPDATE validator_discoveries SET last_seen=?, online=? WHERE identity=?", [Date.now(), peer.status ? (peer.status.online ? 1 : 0) : 0, identity]); } catch(e) {} }
    }
  }

  return newPeers;
}

// --- HTTP Health Endpoint ---
let latestHealthData = null; // updated each cycle
let latestPublicNodes = []; // updated each cycle
let latestVersionData = { running: "6.8", latestCommit: null, latestMessage: null, latestDate: null, nodeVersion: null, checkedAt: null };
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
  try {
    var lr = await fetch("http://127.0.0.1:53550/info", { signal: AbortSignal.timeout(3000) });
    var ld = await lr.json();
    latestVersionData.nodeVersion = ld.version || null;
    latestVersionData.nodeVersionName = ld.version_name || null;
  } catch(e) {}
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
    nRep.push(`demos_node_reputation_score{${l}} ${node.reputationScore||0}`);
    nUptime.push(`demos_node_uptime_percent{${l}} ${node.uptimePercent||0}`);
    nSync.push(`demos_node_synced{${l}} ${node.synced?1:0}`);
    nExp.push(`demos_node_exporter_up{${l}} ${node.exporterUp?1:0}`);
  }
  metric('demos_node_up', 'Node online/offline', 'gauge', nUp);
  metric('demos_node_block_height', 'Node block height', 'gauge', nBlock);
  metric('demos_node_reputation_score', 'Node reputation 0-100', 'gauge', nRep);
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

  // FIX BUG 7: Helper to compute staleness for any endpoint
  function getStaleness() {
    if (!lastCycleAt) return { lastCycleAt: null, stalenessSeconds: null };
    return { lastCycleAt: lastCycleAt, stalenessSeconds: Math.round((Date.now() - lastCycleAt) / 1000) };
  }

  var server = createServer(function(req, res) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/health") {
      var staleness = getStaleness(); // FIX BUG 7
      var canonical = computeCanonicalState();
      var healthSignals = generateSignals(latestHealthData, staleness.stalenessSeconds);
      var healthDecision = generateDecision(latestHealthData, staleness.stalenessSeconds, healthSignals);
      var healthScores = generateScores(latestHealthData, staleness.stalenessSeconds, healthSignals);
      var healthRec = getRecommendation(latestHealthData);
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
        status_reason: canonical.status_reason,
        risk_factors: canonical.risk_factors,
        confidence_reason: canonical.confidence_reason,
        agreement_reason: canonical.agreement_reason,
        // === Derived ===
        reason: healthDecision.reason,
        publicNodes: latestPublicNodes || [],
        signals: healthSignals,
        signals: healthSignals,
        signals_grouped: groupSignals(healthSignals),
        network_agreement: generateNetworkAgreement(latestHealthData, latestPublicNodes),
        validator_growth: getValidatorGrowth(),
        discoveredPeers: Object.keys(discoveredPeers).length,
        reference: {
          fleet_size: FLEET_SIZE,
          fleet_healthy: latestHealthData ? latestHealthData.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length : 0,
          fleet_nodes: latestHealthData ? latestHealthData.nodeReports || [] : [],
          fleet_incidents: Object.values(activeIncidents).filter(function(i) {
            if (i.description && (i.description.indexOf("Fleet reference") === 0 || i.description === "Chain-level issue detected")) return true;
            if (i.affectedNodes && i.affectedNodes.every(function(n) { return FLEET_NODE_NAMES.includes(n); })) return true;
            return false;
          }).map(function(i) { return { id: i.id, severity: i.severity, description: i.description, startedAt: i.startedAt }; }),
          node_versions: nodeVersions,
          reputation_scores: history.length > 0 ? calculateReputationScores() : null,
          uptime: uptimeStats,
        },
        legacy: {
          recommendation: healthRec,
          decision: healthDecision,
          scores: healthScores,
        },
      };
      res.writeHead(200);
      res.end(JSON.stringify(payload, null, 2));
    } else if (req.url === "/reputation") {
      var scores = calculateReputationScores();
      var staleness = getStaleness(); // FIX BUG 7
      res.writeHead(200);
      res.end(JSON.stringify({ scores: scores, historyLength: history.length, window: "24h", lastCycleAt: staleness.lastCycleAt, stalenessSeconds: staleness.stalenessSeconds }, null, 2));
    } else if (req.url === "/peers") {
      var staleness = getStaleness(); // FIX BUG 7
      res.writeHead(200);
      res.end(JSON.stringify({ known: FLEET_SIZE, discovered: discoveredPeers, lastCycleAt: staleness.lastCycleAt, stalenessSeconds: staleness.stalenessSeconds }, null, 2));
    } else if (req.url === "/history") {
      // Return last 24h of data points
      var last24h = history.slice(-72);
      var staleness = getStaleness(); // FIX BUG 7
      res.writeHead(200);
      res.end(JSON.stringify({ points: last24h.length, data: last24h, lastCycleAt: staleness.lastCycleAt, stalenessSeconds: staleness.stalenessSeconds }, null, 2));
    } else if (req.url.indexOf("/incidents") === 0) {
      var incParams = new URLSearchParams(req.url.split("?")[1] || "");
      var incStatus = incParams.get("status") || null;
      var incScope = incParams.get("scope") || "public";
      var incLimit = parseInt(incParams.get("limit") || "50", 10);
      try {
        var incQuery = "SELECT * FROM incidents";
        var incArgs = [];
        if (incStatus) { incQuery += " WHERE status = ?"; incArgs.push(incStatus); }
        incQuery += " ORDER BY rowid DESC LIMIT ?";
        incArgs.push(incLimit);
        var incRows = sharedDb.prepare(incQuery).all(...incArgs);
        var incResults = incRows.map(function(r) {
          var nodes = JSON.parse(r.affected_nodes || "[]");
          var isFleet = (r.description && (r.description.indexOf("Fleet reference") === 0 || r.description === "Chain-level issue detected")) || (nodes.length > 0 && nodes.every(function(n) { return FLEET_NODE_NAMES.includes(n); }));
          return {
            id: r.id, status: r.status, severity: r.severity, scope: isFleet ? "fleet" : "public",
            startedAt: r.started_at, resolvedAt: r.resolved_at,
            durationSeconds: r.duration_seconds,
            affectedNodes: nodes,
            description: r.description,
            detectedBlock: r.detected_block, resolvedBlock: r.resolved_block,
            alerts: JSON.parse(r.alerts || "[]")
          };
        });
        if (incScope === "public") incResults = incResults.filter(function(i) { return i.scope === "public"; });
        else if (incScope === "fleet") incResults = incResults.filter(function(i) { return i.scope === "fleet"; });
        var activeCount = incScope === "public" ? getPublicActiveIncidentIds().length : incScope === "fleet" ? Object.keys(activeIncidents).length - getPublicActiveIncidentIds().length : Object.keys(activeIncidents).length;
        res.writeHead(200);
        res.end(JSON.stringify({ scope: incScope, total: incResults.length, active: activeCount, incidents: incResults }, null, 2));
      } catch(incErr) {
        res.writeHead(200);
        res.end(JSON.stringify({ scope: incScope || "public", total: 0, active: 0, incidents: [], error: incErr.message }, null, 2));
      }
    } else if (req.url === "/federate" || req.url === "/metrics") {
      var fleetData = {
        // nodes: removed from public API — fleet data is in reference layer only
        nodesOnline: latestHealthData && latestHealthData.nodeReports ? latestHealthData.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length : 0,
        blockHeight: latestHealthData && latestHealthData.chain ? latestHealthData.chain.block : 0,
        tps: latestHealthData && latestHealthData.chain ? latestHealthData.chain.tps : 0,
        mempoolSize: latestHealthData && latestHealthData.chain ? latestHealthData.chain.mempoolSize || 0 : 0,
        secondsSinceLastBlock: latestHealthData && latestHealthData.chain ? latestHealthData.chain.secondsSinceLastBlock || 0 : 0,
        discoveredPeersCount: Object.keys(discoveredPeers).length,
        publicRPCs: publicRpcStats ? Object.entries(publicRpcStats).map(function(e) { return { url: e[0], available: e[1].reachable > 0, latencyMs: e[1].avgLatency || 0 }; }) : [],
        dahrAttestations: dahrAvailable ? 2 : 0,
        activeAlerts: Object.keys(problemHistory).filter(function(k) { return problemHistory[k] && problemHistory[k].count >= 2; }).length,
        totalAlerts: dailyAlertCount || 0,
        version: "6.4",
        wallet: AGENT_WALLET,
        cycleCount: cycleCount
      };
      var prometheusText = generatePrometheusMetrics(fleetData);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(prometheusText);
    } else if (req.url === "/federate/config") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        instructions: "Add to your prometheus.yml scrape_configs:",
        scrape_config: { job_name: "demos-network-oracle", scrape_interval: "60s", metrics_path: "/federate",
          static_configs: [{ targets: ["193.77.169.106:55225"], labels: { network: "demos-testnet", agent: "fleet-oracle" } }] }
      }, null, 2));
    } else if (req.url === "/consensus" || req.url === "/consensus/") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getConsensusState(), null, 2));
    } else if (req.url === "/marketplace" || req.url === "/marketplace/") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getMarketplaceStats(), null, 2));
    } else if (req.url === "/marketplace/queries" || req.url.indexOf("/marketplace/queries?") === 0) {
      var mqLimit = 20;
      var mqIdx = req.url.indexOf("limit=");
      if (mqIdx !== -1) { mqLimit = parseInt(req.url.substring(mqIdx + 6), 10) || 20; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getRecentQueries(mqLimit), null, 2));
    } else if (req.url === "/self") {
      var selfBudget = canPublish();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        agent: "Demos Network Oracle",
        version: "6.9",
        api_version: "1.0",
        status: computeCanonicalState().status,
        uptimeSeconds: Math.round(process.uptime()),
        lastCycleAt: lastCycleAt || null,
        lastPublishAt: lastPublishAt,
        cycleCount: cycleCount,
        writeBudget: { hourly: selfBudget.hourly, maxHourly: HOURLY_PUBLISH_LIMIT, daily: selfBudget.daily, maxDaily: DAILY_PUBLISH_LIMIT, ok: selfBudget.ok },
        wallet: AGENT_WALLET,
        activeRpc: activeRpcUrl,
        demBalance: lastKnownBalance,
        agent_ready: true,
        primary_endpoint: "/organism",
        endpoints: ["/organism", "/agent", "/sources", "/health", "/dashboard", "/methodology", "/incidents", "/peers", "/reputation", "/sentinel", "/history", "/history/export", "/federate", "/federate/config", "/badge", "/version", "/docs", "/self"]
      }, null, 2));
    } else if (req.url === "/organism") {
      // M5: Cache header for agent consumption
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
        api_version: canonical.api_version
      };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(organism, null, 2));
    } else if (req.url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(latestVersionData, null, 2));
    } else if (req.url === "/docs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(DOCS_HTML);
    } else if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(HOMEPAGE_HTML);
    } else if (req.url === "/home") {
      res.writeHead(301, { "Location": "/" });
      res.end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(HOMEPAGE_HTML);
    } else if (req.url === "/sources") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(SOURCES_HTML);
    } else if (req.url === "/submit" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUBMIT_HTML);
    } else if (req.url === "/submit" && req.method === "POST") {
      var body = "";
      req.on("data", function(chunk) { body += chunk; });
      req.on("end", async function() {
        try {
          var params = new URLSearchParams(body);
          var host = (params.get("host") || "").trim();
          var port = parseInt(params.get("port") || "53550", 10);
          var operator = (params.get("operator") || "").trim();
          var blocked = ["localhost","127.0.0.1","0.0.0.0","10.","192.168.","172.16.","172.17.","172.18.","172.19.","172.20.","172.21.","172.22.","172.23.","172.24.","172.25.","172.26.","172.27.","172.28.","172.29.","172.30.","172.31."];
          var isBlocked = blocked.some(function(b){ return host.indexOf(b) === 0; });
          if (isBlocked) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"private or local addresses not allowed"})); return; }
          if (!host || !operator) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"host and operator required"})); return; }
          if (!sharedDb) { res.writeHead(500, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"database not available"})); return; }
          // Check existing — allow retry if probed_failed
          var existing = sharedDb.query("SELECT id, status FROM submissions WHERE host=? AND port=? ORDER BY id DESC LIMIT 1").get(host, port);
          var subId = null;
          if (existing) {
            if (existing.status === "probed_failed") {
              sharedDb.run("UPDATE submissions SET operator=?, status='pending' WHERE id=?", operator, existing.id);
              subId = existing.id;
              log("[m10] Retry submission id=" + subId + " " + host + ":" + port);
            } else {
              res.writeHead(409, {"Content-Type":"application/json"});
              res.end(JSON.stringify({error:"already submitted", existing_status: existing.status}));
              return;
            }
          }
          if (!subId) {
            sharedDb.run("INSERT INTO submissions (host, port, operator, submitted_at) VALUES (?, ?, ?, ?)", host, port, operator, Date.now());
            var row = sharedDb.query("SELECT id FROM submissions WHERE host=? AND port=? ORDER BY id DESC LIMIT 1").get(host, port);
            subId = row ? row.id : null;
          }
          // Synchronous probe
          var probeResult = {status: "probed_failed", error: "unknown"};
          try {
            var probeRes = await fetch("http://" + host + ":" + port + "/info", { signal: AbortSignal.timeout(5000) });
            if (probeRes.ok) {
              var probeData = await probeRes.json();
              var block = probeData.peerlist && probeData.peerlist[0] && probeData.peerlist[0].sync ? probeData.peerlist[0].sync.block : null;
              var identity = probeData.identity || null;
              var subUrl = "http://" + host + ":" + port;
              var dupUrl = Object.values(PUBLIC_NODES).some(function(n){ return n.url === subUrl; });
              var dupIdentity = identity && Object.values(PUBLIC_NODES).some(function(n){ return n.identity === identity; });
              if (dupUrl || dupIdentity) {
                if (subId) sharedDb.run("UPDATE submissions SET probe_ok=1, probe_block=?, probe_identity=?, status='duplicate', probe_error=NULL WHERE id=?", block, identity, subId);
                log("[m10] Duplicate: " + host + ":" + port);
                probeResult = {status: "duplicate", block: block, message: "This node is already monitored by the Oracle."};
              } else {
                if (subId) sharedDb.run("UPDATE submissions SET probe_ok=1, probe_block=?, probe_identity=?, status='probed_ok', probe_error=NULL WHERE id=?", block, identity, subId);
                log("[m10] Probe OK: " + host + ":" + port + " block=" + block);
                probeResult = {status: "probed_ok", block: block};
              }
            } else {
              var httpErr = "http_" + probeRes.status;
              if (subId) sharedDb.run("UPDATE submissions SET probe_ok=0, status='probed_failed', probe_error=? WHERE id=?", httpErr, subId);
              log("[m10] Probe FAIL: " + host + ":" + port + " HTTP " + probeRes.status);
              probeResult = {status: "probed_failed", error: httpErr};
            }
          } catch(probeErr) {
            var probeReason = "unknown"; var pmsg = (probeErr.message || "").toLowerCase();
            if (pmsg.indexOf("timeout") !== -1) probeReason = "timeout";
            else if (pmsg.indexOf("refused") !== -1 || pmsg.indexOf("unable to connect") !== -1) probeReason = "connection_refused";
            else if (pmsg.indexOf("dns") !== -1 || pmsg.indexOf("resolve") !== -1) probeReason = "dns_error";
            else if (pmsg.indexOf("fetch") !== -1) probeReason = "fetch_failed";
            if (subId) sharedDb.run("UPDATE submissions SET probe_ok=0, status='probed_failed', probe_error=? WHERE id=?", probeReason, subId);
            log("[m10] Probe FAIL: " + host + ":" + port + " reason=" + probeReason);
            probeResult = {status: "probed_failed", error: probeReason};
          }
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ok: true, probe: probeResult}));
        } catch(err) { res.writeHead(500, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:err.message})); }
      });
    } else if (req.url === "/submissions" || req.url.indexOf("/submissions?") === 0) {
      var subUrl = new URL(req.url, "http://d"); var subTk = subUrl.searchParams.get("token");
      if (subTk !== DNO_ADMIN_TOKEN) { res.writeHead(403, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"unauthorized"})); return; }
      if (!sharedDb) { res.writeHead(200); res.end("[]"); return; }
      var rows = sharedDb.query("SELECT * FROM submissions ORDER BY submitted_at DESC").all();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(rows, null, 2));
    } else if (req.url && req.url.indexOf("/approve?") === 0) {
      var appUrl = new URL(req.url, "http://d"); var appTk = appUrl.searchParams.get("token");
      if (appTk !== DNO_ADMIN_TOKEN) { res.writeHead(403, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"unauthorized"})); return; }
      var approveId = parseInt(appUrl.searchParams.get("id"), 10);
      if (!sharedDb || !approveId) { res.writeHead(400); res.end(JSON.stringify({error:"invalid id"})); return; }
      var sub = sharedDb.query("SELECT * FROM submissions WHERE id=?").get(approveId);
      if (!sub) { res.writeHead(404); res.end(JSON.stringify({error:"not found"})); return; }
      if (sub.status === "approved") { res.writeHead(200); res.end(JSON.stringify({ok:true, message:"already approved"})); return; }
      // Check duplicate identity
      if (sub.probe_identity) {
        var existingIdentity = Object.values(PUBLIC_NODES).some(function(n){ return n.identity === sub.probe_identity; });
        if (existingIdentity) { res.writeHead(409, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"node with this identity already monitored"})); return; }
      }
      // Check duplicate URL
      var existingUrl = Object.values(PUBLIC_NODES).some(function(n){ return n.url === "http://" + sub.host + ":" + sub.port; });
      if (existingUrl) { res.writeHead(409, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"node at this address already monitored"})); return; }
      var nodeName = "community-node-" + approveId;
      PUBLIC_NODES[nodeName] = { url: "http://" + sub.host + ":" + sub.port, identity: sub.probe_identity || "unknown", source_type: "community", trust_tier: "community_submitted", operator: sub.operator, joined_at: new Date().toISOString().split("T")[0] };
      sharedDb.run("UPDATE submissions SET status='approved', reviewed_at=? WHERE id=?", Date.now(), approveId);
      log("[m7] Approved: " + nodeName + " = " + sub.host + ":" + sub.port + " (" + sub.operator + ")");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ok:true, node_name: nodeName, message:"Node approved and added to monitoring"}));
    } else if (req.url === "/submissions/summary" || req.url.indexOf("/submissions/summary?") === 0) {
      var sumUrl = new URL(req.url, "http://d"); var sumTk = sumUrl.searchParams.get("token");
      if (sumTk !== DNO_ADMIN_TOKEN) { res.writeHead(403, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"unauthorized"})); return; }
      if (!sharedDb) { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({total:0})); return; }
      try {
        var totals = sharedDb.query("SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='probed_ok' THEN 1 ELSE 0 END) AS probed_ok, SUM(CASE WHEN status='probed_failed' THEN 1 ELSE 0 END) AS probed_failed, SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved FROM submissions").get() || {};
        var topPorts = sharedDb.query("SELECT port, COUNT(*) AS count FROM submissions GROUP BY port ORDER BY count DESC LIMIT 10").all();
        var recent = sharedDb.query("SELECT id, host, port, operator, status, probe_ok, probe_block, probe_error, submitted_at FROM submissions ORDER BY submitted_at DESC LIMIT 10").all();
        var failReasons = sharedDb.query("SELECT probe_error, COUNT(*) AS count FROM submissions WHERE status='probed_failed' AND probe_error IS NOT NULL GROUP BY probe_error ORDER BY count DESC LIMIT 10").all();
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({total:totals.total||0, pending:totals.pending||0, probed_ok:totals.probed_ok||0, probed_failed:totals.probed_failed||0, approved:totals.approved||0, top_ports:topPorts, failure_reasons:failReasons, recent:recent}, null, 2));
      } catch(err) { res.writeHead(500, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:err.message})); }
    } else if (req.url === "/fixnet/health") {
      var fxNodes = latestFixnetNodes || [];
      var fxOnline = fxNodes.filter(function(n) { return n.ok; });
      var fxAnchor = fxNodes.find(function(n) { return n.source_type === "anchor"; });
      var fxFleet = fxNodes.filter(function(n) { return n.source_type === "fleet"; });
      var fxNetworkHead = fxAnchor && fxAnchor.block ? fxAnchor.block : 0;
      var fxFleetHead = 0;
      for (var fxi = 0; fxi < fxFleet.length; fxi++) {
        if (fxFleet[fxi].block && fxFleet[fxi].block > fxFleetHead) fxFleetHead = fxFleet[fxi].block;
      }
      var fxAtHead = fxOnline.filter(function(n) {
        return n.block && fxNetworkHead > 0 && (fxNetworkHead - n.block) <= 100;
      }).length;
      // v7.2: include discovered fixnet nodes
      var fxDisc = latestDiscoveredFixnet || [];
      var fxDiscOnline = fxDisc.filter(function(d) { return d.online; });
      var fxPayload = {
        network: "fixnet",
        observed_at: new Date().toISOString(),
        anchor: fxAnchor ? {
          url: fxAnchor.url,
          host: fxAnchor.host,
          identity: fxAnchor.identity,
          status: fxAnchor.ok ? "online" : "offline",
          block: fxAnchor.block,
          latency_ms: fxAnchor.latencyMs,
          error: fxAnchor.error || null
        } : null,
        fleet: {
          count: fxFleet.length,
          online: fxFleet.filter(function(n) { return n.ok; }).length,
          at_head: fxAtHead,
          nodes: fxFleet.map(function(n) {
            return {
              name: n.name,
              host: n.host,
              identity: n.identity,
              status: n.ok ? "online" : "offline",
              block: n.block,
              latency_ms: n.latencyMs,
              behind: (n.block && fxNetworkHead > 0) ? Math.max(0, fxNetworkHead - n.block) : null,
              sync_pct: (n.block && fxNetworkHead > 0) ? Math.round((n.block / fxNetworkHead) * 1000) / 10 : null,
              error: n.error || null
            };
          })
        },
        discovered: {
          count: fxDisc.length,
          online: fxDiscOnline.length,
          nodes: fxDisc.map(function(d) {
            return {
              identity: d.identity,
              identity_short: d.identity ? (d.identity.substring(0, 6) + "…" + d.identity.substring(d.identity.length - 4)) : null,
              connection: d.connection,
              status: d.online ? "online" : "offline",
              block: d.block,
              behind: (d.block && fxNetworkHead > 0) ? Math.max(0, fxNetworkHead - d.block) : null,
              sync_pct: (d.block && fxNetworkHead > 0) ? Math.round((d.block / fxNetworkHead) * 1000) / 10 : null,
              first_seen: d.first_seen ? new Date(d.first_seen).toISOString() : null,
              last_seen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
              last_probed_at: d.last_probed_at ? new Date(d.last_probed_at).toISOString() : null
            };
          })
        },
        summary: {
          fleet_head: fxFleetHead,
          network_head: fxNetworkHead,
          fleet_lag: fxNetworkHead > fxFleetHead ? fxNetworkHead - fxFleetHead : 0,
          status: (fxNodes.length > 0 && fxOnline.length === fxNodes.length) ? "stable" : (fxOnline.length > 0 ? "degraded" : "offline")
        }
      };
      res.writeHead(200);
      res.end(JSON.stringify(fxPayload, null, 2));
    } else if (req.url === "/community") {
      if (!sharedDb) { res.writeHead(200, {"Content-Type":"text/html"}); res.end("<h1>No data</h1>"); return; }
      var rows = sharedDb.query("SELECT id, host, port, operator, status, probe_ok, probe_block, probe_error, probe_identity, submitted_at FROM submissions WHERE status != 'probed_failed' ORDER BY id DESC LIMIT 50").all();
      // Get network head from latest public node data
      var netHead = 0;
      try { var pn = latestPublicNodes || []; for (var pi=0;pi<pn.length;pi++) { if (pn[pi].block && pn[pi].block > netHead) netHead = pn[pi].block; } } catch(e){}
      function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
      function computeStage(r, netHead) {
        if (r.status === "approved") return "approved";
        if (r.status === "duplicate") return "duplicate";
        if (!r.probe_ok) {
          if (r.probe_error) return "unreachable";
          return "submitted";
        }
        if (!r.probe_block) return "reachable";
        var behind = netHead > 0 ? netHead - r.probe_block : 0;
        if (behind <= 0) return "ready";
        if (behind <= 100) return "near_head";
        return "syncing";
      }
      function stageInfo(stage, r) {
        var reasons = {
          submitted: ["Submission received, probe pending or not yet attempted.", "The Oracle will probe your node automatically."],
          unreachable: ["Oracle cannot reach this node. Error: " + (r.probe_error||"unknown").replace(/_/g," ") + ".", "Check that your node is running, the port is open, and the firewall allows inbound connections."],
          reachable: ["Node responds but no block data received.", "Verify your node is fully initialized and syncing."],
          syncing: ["Node is reachable and syncing, but still behind the network head.", "Wait until the node syncs closer to the network head. Approval happens after sync."],
          near_head: ["Node is close to the network head.", "Continue syncing. This node may soon be eligible for manual review."],
          ready: ["Node is synced and ready for approval.", "Pending manual review by the Oracle operator."],
          approved: ["Node has been approved and is now monitored.", "Your node appears in the main Oracle homepage."],
          duplicate: ["This node is already monitored by the Oracle.", "No further action needed."]
        };
        var info = reasons[stage] || ["Unknown state.", "Contact the operator."];
        return { reason: info[0], next_step: info[1] };
      }
      // Build page
      var counts = {submitted:0,unreachable:0,reachable:0,syncing:0,near_head:0,ready:0,approved:0,duplicate:0};
      var enriched = rows.map(function(r) {
        var stage = computeStage(r, netHead);
        counts[stage] = (counts[stage]||0) + 1;
        var info = stageInfo(stage, r);
        var behind = (r.probe_block && netHead > 0) ? Math.max(0, netHead - r.probe_block) : null;
        var history = [];
        if (r.host && sharedDb) {
          try {
            history = sharedDb.query("SELECT id, host, port, status, probe_error, submitted_at FROM submissions WHERE host = ? AND id != ? ORDER BY id DESC LIMIT 10").all(r.host, r.id);
          } catch(e) { history = []; }
        }
        return { id:r.id, host:r.host, port:r.port, operator:r.operator, stage:stage, block:r.probe_block, behind:behind, error:r.probe_error, submitted_at:r.submitted_at, reason:info.reason, next_step:info.next_step, history:history };
      });
      var stageColors = { submitted:"#98a2b3", unreachable:"#EF4444", reachable:"#98a2b3", syncing:"#d97706", near_head:"#22c55e", ready:"#2dd4a0", approved:"#2dd4a0", duplicate:"#d97706" };
      var stageBg = { submitted:"rgba(152,162,179,0.08)", unreachable:"rgba(239,68,68,0.08)", reachable:"rgba(152,162,179,0.08)", syncing:"rgba(217,119,6,0.08)", near_head:"rgba(34,197,94,0.08)", ready:"rgba(45,212,160,0.08)", approved:"rgba(45,212,160,0.06)", duplicate:"rgba(217,119,6,0.08)" };
      var h = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DNO — Community Nodes</title><meta name="viewport" content="width=device-width,initial-scale=1">';
      h += '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Code+Pro:wght@400;500;600&display=swap" rel="stylesheet">';
      h += '<style>';
      h += ':root{--bg:#0a0a0a;--surface:#101010;--border:#1a1a1a;--text-primary:#f5f5f5;--text-secondary:#98a2b3;--improving:#2dd4a0;--mono:"Source Code Pro",monospace;--sans:"Inter",system-ui,sans-serif}';
      h += '*{margin:0;padding:0;box-sizing:border-box}body{font-family:var(--sans);background:var(--bg);color:var(--text-primary);-webkit-font-smoothing:antialiased;line-height:1.7}';
      h += 'main{max-width:1100px;margin:0 auto;padding:28px 24px 80px}';
      h += '.noncanonical-banner{margin:0 0 28px;padding:14px 18px;background:#0f0f0f;border:1px solid #1f1f1f;border-left:3px solid #4a4a4a;color:#c9d1d9;font-size:13px;line-height:1.6;border-radius:4px}';
      h += '.noncanonical-banner strong{color:#e8ece8;font-weight:600;margin-right:6px}';
      h += 'h1{font-family:var(--mono);font-size:24px;font-weight:600;letter-spacing:-0.03em;margin:0 0 4px}';
      h += '.sub{color:var(--text-secondary);margin-bottom:28px;font-size:13px}';
      h += '.summary{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}';
      h += '.sum-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;text-align:center;min-width:96px}';
      h += '.sum-val{font-size:22px;font-weight:600;font-family:var(--mono)}';
      h += '.sum-label{font-size:10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.3px;margin-top:2px;white-space:nowrap}';
      h += 'table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}';
      h += 'th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-secondary);font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}';
      h += 'td{padding:8px 10px;border-bottom:1px solid #151515;font-family:var(--mono);font-size:12px}';
      h += 'tr:hover{background:#0d0d0d}';
      h += '.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:500;border:1px solid var(--border)}';
      h += '.detail{display:none;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:6px 0 10px;font-size:12px;color:var(--text-secondary);line-height:1.6}';
      h += '.detail b{color:var(--text-primary);font-weight:500}';
      h += '.toggle{cursor:pointer;color:var(--text-secondary);font-size:11px;text-decoration:underline}';
      h += '.toggle:hover{color:var(--text-primary)}';
      h += 'a{color:#c9d1d9;text-decoration:none}a:hover{text-decoration:underline}';
      h += '.doc-nav{position:sticky;top:0;z-index:20;backdrop-filter:blur(10px);background:rgba(16,16,16,0.92);border-bottom:1px solid var(--border);height:52px;display:flex;align-items:center}';
      h += '.doc-nav-inner{max-width:980px;width:100%;margin:0 auto;padding:0 28px;display:flex;align-items:center;gap:12px}';
      h += '.doc-nav-left{order:1}';
      h += '.doc-nav-right{order:2;margin-left:auto}';
      h += '.doc-nav-inner > .nav-live{order:3}';
      h += '.doc-nav-left,.doc-nav-right{display:flex;align-items:center;gap:18px}';
      h += '.doc-nav-brand{color:var(--brand,#2B36D9);text-decoration:none;font-family:var(--mono);font-size:13px;letter-spacing:2.6px;font-weight:700;display:inline-flex;align-items:center;gap:8px;text-transform:uppercase}';
      h += '.doc-nav-brand:hover{text-decoration:none;opacity:0.9}';
      h += '.doc-logo{width:22px;height:22px;color:var(--text-primary)}';
      h += '.doc-nav-link{color:var(--text-secondary);text-decoration:none;font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:0.7px;text-transform:uppercase;transition:color 0.2s}';
      h += '.doc-nav-link:hover{color:var(--text-primary);text-decoration:none}';
      h += '.doc-nav-link[aria-current="page"]{opacity:0.5}';
      h += '.doc-nav-link[aria-current="page"]:hover{opacity:0.8;text-decoration:none}';
      h += '.nav-live{font-size:10px;font-family:var(--mono);padding:4px 9px;border:1px solid rgba(34,197,94,0.16);border-radius:999px;color:var(--text-secondary);display:inline-flex;align-items:center;gap:5px;letter-spacing:0.45px}';
      h += '.nav-live-dot{width:5px;height:5px;border-radius:50%;background:#22c55e;opacity:0.8}';
      h += '@media(max-width:640px){.doc-nav{height:auto;min-height:56px;padding:10px 0}.doc-nav-inner{padding:0 16px;flex-wrap:wrap;gap:8px;row-gap:10px}.doc-nav-left{flex:0 0 auto;order:1}.doc-nav-inner > .nav-live{flex:0 0 auto;order:2;margin-left:auto;font-size:9px;padding:3px 7px;letter-spacing:0.3px}.doc-nav-right{flex:1 1 100%;order:3;gap:10px;flex-wrap:wrap;justify-content:flex-start}.doc-nav-link{font-size:10px;flex:0 0 auto;white-space:nowrap}.xm33-sep{display:none}.xm33-block{display:block}.xm33-dot{display:inline}}';
      h += '.oracle-hero-submit{font-size:10px;font-family:var(--mono);padding:3px 9px;border:1px solid rgba(255,255,255,0.15);border-radius:999px;color:rgba(255,255,255,0.7);text-decoration:none;letter-spacing:0.04em;transition:all 0.2s}';
      h += '.oracle-hero-submit:hover{color:var(--improving);border-color:rgba(45,212,160,0.3)}';
      h += 'footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--border);color:var(--text-secondary);font-size:11px;opacity:0.5;text-align:center}.xm33-dot{display:none}';
      h += '.table-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}';
      h += '@media(max-width:720px){main{padding:20px 16px 64px}.summary{gap:8px}.sum-card{flex:1;min-width:88px;padding:10px 10px}.sum-label{font-size:9px;letter-spacing:0.2px}table{font-size:11px}td,th{padding:6px 8px}}';
      h += '</style></head><body>';
      // Nav
      h += '<nav class="doc-nav"><div class="doc-nav-inner"><div class="doc-nav-left">';
      h += '<a href="/" class="doc-nav-brand"><svg class="doc-logo" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="20" r="3" fill="currentColor"/><circle cx="20" cy="70" r="3" fill="currentColor"/><circle cx="80" cy="70" r="3" fill="currentColor"/><circle cx="50" cy="50" r="4" fill="currentColor"/></svg>ORACLE</a>';
      h += '</div><div class="doc-nav-right">';
      h += '<a href="/methodology" class="doc-nav-link">Methodology</a>';
      h += '<a href="/agent" class="doc-nav-link">Agent</a>';
      h += '<a href="/sources" class="doc-nav-link">Sources</a>';
      h += '<a href="/community" class="doc-nav-link" aria-current="page">Community</a>';
      h += '</div>';
      h += '<span class="nav-live"><span class="nav-live-dot"></span>ORACLE LIVE</span>';
      h += '</div></nav>';
      h += '<main>';
      h += '<div class="noncanonical-banner"><strong>Reference surface.</strong>Community node submissions, discovered validators, and fleet diagnostics shown on this page are not canonical network truth until approved. Inclusion does not imply endorsement.</div>';
      h += '<h1>Community Node Onboarding</h1>';

      // --- Fleet Fixnet section (v7.2) ---
      var fx = latestFixnetNodes || [];
      var fxDiscovered = latestDiscoveredFixnet || []; // populated by Change 8; empty until then
      if (fx.length > 0) {
        var fxAnchorN = fx.find(function(n){return n.source_type==="anchor"});
        var fxFleetN = fx.filter(function(n){return n.source_type==="fleet"});
        var fxNetHead = fxAnchorN && fxAnchorN.block ? fxAnchorN.block : 0;
        // v7.3: counts span ALL visible table rows (monitored fx + discovered)
        var fxTotalN = fx.length + fxDiscovered.length;
        var fxMonitoredOnlineN = fx.filter(function(n){return n.ok}).length;
        var fxDiscoveredOnlineN = fxDiscovered.filter(function(n){return n.online}).length;
        var fxOnlineN = fxMonitoredOnlineN + fxDiscoveredOnlineN;
        var fxMonitoredAtHeadN = fx.filter(function(n){return n.ok && n.block && fxNetHead>0 && (fxNetHead - n.block) <= 100}).length;
        var fxDiscoveredAtHeadN = fxDiscovered.filter(function(n){return n.online && n.block && fxNetHead>0 && (fxNetHead - n.block) <= 100}).length;
        var fxAtHeadN = fxMonitoredAtHeadN + fxDiscoveredAtHeadN;
        // "Nodes syncing" stats — across all rows (anchor + fleet + discovered)
        var fxAllSyncingRows = [].concat(fxFleetN, fxDiscovered.map(function(d){return {ok:d.online, block:d.block}}));
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

        h += '<section style="margin:28px 0 36px">';
        h += '<h2 style="font-family:var(--mono);font-size:18px;font-weight:600;letter-spacing:-0.02em;margin:0 0 4px">Fleet Fixnet</h2>';
        h += '<div style="font-size:11px;color:var(--text-secondary);font-family:var(--mono);margin:0 0 14px">';
        h += '<a href="/fixnet/health" style="color:var(--improving);text-decoration:none">JSON</a>';
        if (fxAgoStr) h += ' &nbsp;&middot;&nbsp; Updated ' + fxAgoStr;
        h += '</div>';
        h += '<div class="summary" style="margin-bottom:16px">';
        h += '<div class="sum-card"><div class="sum-val">' + fxTotalN + '</div><div class="sum-label">Nodes</div></div>';
        h += '<div class="sum-card"><div class="sum-val" style="color:' + (fxOnlineN===fxTotalN?"#2dd4a0":"#d97706") + '">' + fxOnlineN + '</div><div class="sum-label">Reachable</div></div>';
        h += '<div class="sum-card"><div class="sum-val" style="color:' + (fxAtHeadN>0?"#2dd4a0":"#98a2b3") + '">' + fxAtHeadN + '</div><div class="sum-label">At Head</div></div>';
        h += '<div class="sum-card"><div class="sum-val">' + (fxNetHead?fxNetHead.toLocaleString():"\u2014") + '</div><div class="sum-label">Network Head</div></div>';
        if (fxDiscovered.length > 0) {
          h += '<div class="sum-card"><div class="sum-val" style="color:#a78bfa">' + fxDiscovered.length + '</div><div class="sum-label">Discovered</div></div>';
        }
        h += '</div>';

        // Helper: truncate identity (0x8f3a…ba05)
        function truncId(id) {
          if (!id || id.length < 12) return id || "\u2014";
          return id.substring(0, 6) + "\u2026" + id.substring(id.length - 4);
        }

        h += '<div class="table-scroll"><table><thead><tr>';
        h += '<th>Validator</th><th>Source</th><th>Status</th><th>Block</th><th>Sync</th><th>Latency</th>';
        h += '</tr></thead><tbody>';

        // Build ordered rows: Anchor, then Fleet (status then block desc), then Discovered (status then block desc)
        var fxFleetSorted = fxFleetN.slice().sort(function(a,b){
          if (a.ok !== b.ok) return a.ok ? -1 : 1;
          return (b.block||0) - (a.block||0);
        });
        var fxDiscSorted = fxDiscovered.slice().sort(function(a,b){
          if (a.online !== b.online) return a.online ? -1 : 1;
          return (b.block||0) - (a.block||0);
        });

        var fxRows = [];
        if (fxAnchorN) fxRows.push({kind:"anchor", data:fxAnchorN});
        for (var fli=0; fli<fxFleetSorted.length; fli++) fxRows.push({kind:"fleet", data:fxFleetSorted[fli]});
        for (var dli=0; dli<fxDiscSorted.length; dli++) fxRows.push({kind:"discovered", data:fxDiscSorted[dli]});

        for (var fxi=0; fxi<fxRows.length; fxi++) {
          var rowKind = fxRows[fxi].kind;
          var fn = fxRows[fxi].data;
          var isAnchor = rowKind === "anchor";
          var isFleet = rowKind === "fleet";
          var isDisc = rowKind === "discovered";

          var srcColor = isAnchor ? "#2B36D9" : (isFleet ? "#98a2b3" : "#a78bfa");
          var srcLabel = isAnchor ? "Kynesys" : (isFleet ? "XM33" : "Discovered");

          // Status resolution: monitored uses .ok, discovered uses .online
          var isOnline = isDisc ? !!fn.online : !!fn.ok;
          var statusColor = isOnline ? "#22c55e" : "#EF4444";
          var statusText = isOnline ? "online" : "offline";



          // Block
          var block = fn.block || fn.last_block || null;
          var syncPct = (block && fxNetHead > 0) ? Math.round((block / fxNetHead) * 1000) / 10 : null;
          var syncColor = syncPct === null ? "#98a2b3" : (syncPct >= 95 ? "#2dd4a0" : (syncPct >= 80 ? "#d97706" : "#EF4444")); var syncOpacity = (syncPct !== null && syncPct >= 95 && syncPct < 100) ? ";opacity:0.55" : "";

          // Latency (only meaningful for monitored; discovered has no current-cycle latency)
          // v7.3: show latency for discovered too (populated by probeDiscoveredFixnetNodes)
          var latencyStr = (fn.latencyMs != null) ? (fn.latencyMs + "ms") : "\u2014";

          // Validator cell: name + sub-line identity.
          var nameLabel = isDisc ? ("discovered-" + (fn.identity ? fn.identity.substring(fn.identity.length-4) : "????")) : fn.name;
          var identity = fn.identity || "";

          h += '<tr>';
          // Validator (with identity sub-line)
          h += '<td><div>' + esc(nameLabel) + '</div>';
          h += '<div style="font-family:var(--mono);color:var(--text-secondary);font-size:10px;margin-top:2px;opacity:0.7">' + esc(truncId(identity)) + '</div></td>';
          // Source
          h += '<td><span class="pill" style="color:'+srcColor+';border-color:'+srcColor+'44">' + srcLabel + '</span></td>';
          // Status
          h += '<td><span style="color:'+statusColor+'">\u25cf</span> ' + statusText + '</td>';
          // Block
          h += '<td>' + (block ? block.toLocaleString() : "\u2014") + '</td>';
          // Sync
          h += '<td' + (syncPct !== null ? ' style="color:'+syncColor+syncOpacity+'"' : '') + '>' + (syncPct !== null ? syncPct + "%" : "\u2014") + '</td>';
          // Latency
          h += '<td>' + latencyStr + '</td>';
          h += '</tr>';
        }
        h += '</tbody></table></div>';

        // v7.3: "Nodes syncing" — across ALL rows (anchor + fleet + discovered)
        if (fxAllSyncingN > 0) {
          var medianLagStr = fxAllMedianLag > 1000 ? (Math.round(fxAllMedianLag/1000).toLocaleString() + 'k') : fxAllMedianLag.toLocaleString();
          h += '<p class="sub" style="margin-top:10px;font-size:11px">';
          h += 'Nodes syncing \u2014 ' + fxAllAtHeadN + ' of ' + fxAllSyncingRows.length + ' at head, ';
          h += fxAllSyncingN + ' catching up (median lag: ' + medianLagStr + ' blocks).';
          h += '</p>';
        }
        h += '</section><hr style="border:none;border-top:1px solid var(--border);margin:24px 0">';
      }
      // --- end Fleet Fixnet section ---

      h += '<p class="sub">Community validator nodes during onboarding and approval.</p>';
      // Summary
      h += '<div class="summary">';
      var sumItems = [["Submitted",rows.length,"#f5f5f5"],["Unreachable",counts.unreachable||0,"#EF4444"],["Syncing",counts.syncing||0,"#d97706"],["Near Head",counts.near_head||0,"#22c55e"],["Ready",counts.ready||0,"#2dd4a0"],["Approved",counts.approved||0,"#2dd4a0"]];
      for (var si=0; si<sumItems.length; si++) {
        h += '<div class="sum-card"><div class="sum-val" style="color:'+sumItems[si][2]+'">'+sumItems[si][1]+'</div><div class="sum-label">'+sumItems[si][0]+'</div></div>';
      }
      h += '</div>';
      // Network head info
      if (netHead > 0) h += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px;font-family:var(--mono)">Network head: ' + netHead.toLocaleString() + '</div>';
      // Table
      h += '<div class="table-scroll"><table><thead><tr><th>Node</th><th>Operator</th><th>Stage</th><th>Block</th><th>Behind</th><th>Details</th></tr></thead><tbody>';
      if (enriched.length === 0) {
        h += '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);padding:20px">No community submissions yet. <a href="/submit">Submit your node</a></td></tr>';
      }
      for (var ri=0; ri<enriched.length; ri++) {
        var r = enriched[ri];
        var sc = stageColors[r.stage] || "#98a2b3";
        var sb = stageBg[r.stage] || "transparent";
        h += '<tr>';
        h += '<td>' + esc(r.host) + ':' + r.port + '</td>';
        h += '<td>' + esc(r.operator||"—") + '</td>';
        h += '<td><span class="pill" style="color:'+sc+';background:'+sb+';border-color:'+sc+'44">' + esc(r.stage.replace(/_/g," ")) + '</span></td>';
        h += '<td>' + (r.block ? r.block.toLocaleString() : "—") + '</td>';
        h += '<td>' + (r.behind != null ? r.behind.toLocaleString() : "—") + '</td>';
        h += '<td><span class="toggle" onclick="var d=document.getElementById(\'detail-'+r.id+'\');d.style.display=d.style.display===\'block\'?\'none\':\'block\'">details</span></td>';
        h += '</tr>';
        h += '<tr><td colspan="6" style="padding:0"><div class="detail" id="detail-' + r.id + '">';
        h += '<b>Reason:</b> ' + esc(r.reason) + '<br>';
        h += '<b>Next step:</b> ' + esc(r.next_step) + '<br>';
        if (r.error) h += '<b>Probe error:</b> ' + esc(r.error.replace(/_/g," ")) + '<br>';
        h += '<b>Submission ID:</b> ' + r.id + '<br>';
        h += '<b>Check status:</b> <a href="/submission/status?host=' + encodeURIComponent(r.host) + '&port=' + r.port + '">/submission/status</a>';
        if (r.history && r.history.length > 0) {
          h += '<br><br><b>Previous submissions for this host:</b><br>';
          for (var hi = 0; hi < r.history.length; hi++) {
            var hr = r.history[hi];
            var hColor = hr.status === "probed_ok" || hr.status === "approved" ? "#2dd4a0" : hr.status === "duplicate" ? "#d97706" : "#EF4444";
            var hTime = hr.submitted_at ? new Date(hr.submitted_at).toISOString().replace("T"," ").slice(0,16) + " UTC" : "\u2014";
            h += '<span style="color:var(--text-secondary)">#' + hr.id + '</span> \u00b7 ' + esc(hr.host) + ':' + hr.port + ' \u00b7 <span style="color:' + hColor + '">' + esc(String(hr.status || "unknown").replace(/_/g," ")) + '</span>';
            if (hr.probe_error) h += ' <span style="color:var(--text-secondary)">(' + esc(hr.probe_error.replace(/_/g," ")) + ')</span>';
            h += ' <span style="color:var(--text-secondary)">\u00b7 ' + esc(hTime) + '</span>';
            h += '<br>';
          }
        }
        h += '</div></td></tr>';
      }
      h += '</tbody></table></div>';
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
      // Discovered Validators - reference section (peer-crawled, not yet monitored)
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
      // v7.3: OPEN: NODE SUBMISSION CTA pill above Discovered Validators
      h += '<div style="margin-top:32px;margin-bottom:8px"><a href="/submit" class="oracle-hero-submit">OPEN: NODE SUBMISSION</a></div>';
      h += '<div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border)">';
      h += '<h2 style="font-family:var(--mono);font-size:16px;font-weight:600;letter-spacing:-0.02em;margin:0 0 4px">Discovered Validators</h2>';
      h += '<p class="sub" style="margin-bottom:18px">Validators the Oracle has seen via peer crawling but has not yet formally added to monitoring. Shown here for transparency; added to the monitored set manually once they reach the network head. Not community-submitted.</p>';
      if (discoveredList.length === 0) {
        h += '<p style="color:var(--text-secondary);font-size:12px;font-family:var(--mono);opacity:0.6;padding:12px 0">No discovered validators at this time.</p>';
      } else {
        h += '<div class="table-scroll"><table style="opacity:0.8"><thead><tr><th>Address</th><th>Status</th><th>Block</th><th>Sync</th></tr></thead><tbody>';
        for (var dvi = 0; dvi < discoveredList.length; dvi++) {
          var dv = discoveredList[dvi];
          var dvOnline = dv.online === true;
          var dvStatusColor = dvOnline ? "#d97706" : "#98a2b3";
          var dvStatusBg = dvOnline ? "rgba(217,119,6,0.08)" : "rgba(152,162,179,0.08)";
          var dvStatusText = dvOnline ? "syncing" : "offline";
          var dvSyncPct = dv.sync_pct != null ? dv.sync_pct : 0;
          var dvSyncColor = dvSyncPct >= 99.9 ? "#2dd4a0" : dvSyncPct >= 50 ? "#d97706" : "#EF4444";
          h += '<tr>';
          h += '<td>' + esc(dv.display || "\u2014") + '</td>';
          h += '<td><span class="pill" style="color:' + dvStatusColor + ';background:' + dvStatusBg + ';border-color:' + dvStatusColor + '44">' + dvStatusText + '</span></td>';
          h += '<td>' + (dv.block ? dv.block.toLocaleString() : "\u2014") + '</td>';
          h += '<td style="color:' + dvSyncColor + '">' + dvSyncPct + '%</td>';
          h += '</tr>';
        }
        h += '</tbody></table></div>';
      }
      h += '</div>';

      h += '<footer>Demos Network Oracle &middot; API v1.0 &middot; <a href="/methodology">Methodology</a> &middot; <a href="https://github.com/xm33/demos-network-oracle">GitHub</a> <span class="xm33-sep"> &middot; </span><span class="xm33-block"><span class="xm33-dot">&middot; </span>Built by XM33<span class="xm33-dot"> &middot;</span></span></footer>';
      h += '</main></body></html>';
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      res.end(h);
    } else if (req.url && req.url.indexOf("/submission/status") === 0) {
      var stUrl = new URL(req.url, "http://d");
      var stHost = (stUrl.searchParams.get("host") || "").trim();
      var stPort = parseInt(stUrl.searchParams.get("port") || "0", 10);
      if (!stHost || !stPort) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:"error", message:"host and port required"})); return; }
      if (!sharedDb) { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:"not_found"})); return; }
      var stRow = sharedDb.query("SELECT status, probe_block, probe_error FROM submissions WHERE host=? AND port=? ORDER BY id DESC LIMIT 1").get(stHost, stPort);
      if (!stRow) { res.writeHead(200, {"Content-Type":"application/json","Cache-Control":"public, max-age=10"}); res.end(JSON.stringify({status:"not_found", host:stHost, port:stPort})); return; }
      var stResp = {status: stRow.status, host: stHost, port: stPort};
      if (stRow.probe_block) stResp.block = stRow.probe_block;
      if (stRow.probe_error) stResp.error = stRow.probe_error;
      if (stRow.status === "approved") {
        var nm = Object.keys(PUBLIC_NODES).find(function(k){ return PUBLIC_NODES[k].url === "http://" + stHost + ":" + stPort; });
        if (nm) stResp.node_name = nm;
      }
      res.writeHead(200, {"Content-Type":"application/json","Cache-Control":"public, max-age=10"});
      res.end(JSON.stringify(stResp));
    } else if (req.url && req.url.indexOf("/admin/submissions") === 0) {
      function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
      var adUrl = new URL(req.url, "http://d"); var adTk = adUrl.searchParams.get("token");
      if (adTk !== DNO_ADMIN_TOKEN) { res.writeHead(403, {"Content-Type":"text/plain"}); res.end("403 Forbidden"); return; }
      if (!sharedDb) { res.writeHead(200, {"Content-Type":"text/html"}); res.end("<h1>No database</h1>"); return; }
      var totals = sharedDb.query("SELECT COUNT(*) AS total, SUM(CASE WHEN status='probed_ok' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status='probed_failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status='duplicate' THEN 1 ELSE 0 END) AS dup, SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved FROM submissions").get() || {};
      var failures = sharedDb.query("SELECT probe_error, COUNT(*) AS count FROM submissions WHERE status='probed_failed' AND probe_error IS NOT NULL GROUP BY probe_error ORDER BY count DESC").all();
      var rows = sharedDb.query("SELECT id, host, port, operator, status, probe_block, probe_error, submitted_at FROM submissions ORDER BY id DESC LIMIT 50").all();
      var tk = encodeURIComponent(adTk);
      var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DNO Admin</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>';
      html += '*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Source Code Pro",monospace;background:#0a0a0a;color:#f5f5f5;padding:24px;max-width:1100px;margin:0 auto}';
      html += 'h1{font-size:20px;margin-bottom:4px}';
      html += '.sub{color:#98a2b3;font-size:12px;margin-bottom:24px}';
      html += '.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}';
      html += '.card{flex:1;min-width:120px;background:#101010;border:1px solid #1a1a1a;border-radius:10px;padding:14px}';
      html += '.card-val{font-size:28px;font-weight:600;margin-bottom:2px}';
      html += '.card-label{font-size:11px;color:#98a2b3;text-transform:uppercase;letter-spacing:0.5px}';
      html += '.pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px}';
      html += '.pill{font-size:11px;padding:3px 8px;border-radius:999px;background:#101010;border:1px solid #1a1a1a;color:#98a2b3}';
      html += 'table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px}';
      html += 'th{text-align:left;padding:8px 10px;border-bottom:1px solid #1a1a1a;color:#98a2b3;font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}';
      html += 'td{padding:8px 10px;border-bottom:1px solid #1a1a1a}';
      html += 'tr:hover{background:#101010}';
      html += '.s-ok{color:#2dd4a0}.s-fail{color:#EF4444}.s-dup{color:#d97706}.s-approved{color:#2dd4a0;opacity:0.7}.s-pending{color:#98a2b3}';
      html += '.btn{display:inline-block;padding:4px 10px;font-size:11px;background:#2dd4a0;color:#000;border-radius:6px;text-decoration:none;font-weight:600}';
      html += '.btn:hover{opacity:0.85}';
      html += '.muted{color:#98a2b3;font-size:11px}';
      html += '@media(max-width:640px){.cards{flex-direction:column}table{font-size:11px}td,th{padding:6px}}';
      html += '</style></head><body>';
      html += '<h1>Submission Review</h1>';
      html += '<div class="sub">Community node submissions, probe outcomes, and approval actions.</div>';
      // Summary cards
      html += '<div class="cards">';
      html += '<div class="card"><div class="card-val">'+(totals.total||0)+'</div><div class="card-label">Total</div></div>';
      html += '<div class="card"><div class="card-val s-ok">'+(totals.pending||0)+'</div><div class="card-label">Pending Review</div></div>';
      html += '<div class="card"><div class="card-val s-fail">'+(totals.failed||0)+'</div><div class="card-label">Failed</div></div>';
      html += '<div class="card"><div class="card-val s-dup">'+(totals.dup||0)+'</div><div class="card-label">Duplicate</div></div>';
      html += '<div class="card"><div class="card-val s-approved">'+(totals.approved||0)+'</div><div class="card-label">Approved</div></div>';
      html += '</div>';
      // Failure reasons
      if (failures.length > 0) {
        html += '<div class="pills">';
        for (var fi = 0; fi < failures.length; fi++) { html += '<span class="pill">' + esc(failures[fi].probe_error||"unknown") + ': ' + failures[fi].count + '</span>'; }
        html += '</div>';
      }
      // Table
      html += '<table><thead><tr><th>ID</th><th>Host</th><th>Port</th><th>Operator</th><th>Status</th><th>Block</th><th>Error</th><th>Action</th></tr></thead><tbody>';
      for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri];
        var sc = r.status === "probed_ok" ? "s-ok" : r.status === "probed_failed" ? "s-fail" : r.status === "duplicate" ? "s-dup" : r.status === "approved" ? "s-approved" : "s-pending";
        var action = "";
        if (r.status === "probed_ok") action = '<a class="btn" href="/approve?id=' + r.id + '&token=' + tk + '">Approve</a>';
        else if (r.status === "approved") action = '<span class="muted">Approved</span>';
        else if (r.status === "duplicate") action = '<span class="muted">Already monitored</span>';
        else if (r.status === "probed_failed") action = '<span class="muted">Failed</span>';
        else action = '<span class="muted">In progress</span>';
        html += '<tr><td>' + r.id + '</td><td>' + esc(r.host) + '</td><td>' + r.port + '</td><td>' + esc(r.operator||"-") + '</td><td class="' + sc + '">' + esc(r.status) + '</td><td>' + (r.probe_block||"-") + '</td><td>' + esc(r.probe_error||"-") + '</td><td>' + action + '</td></tr>';
      }
      html += '</tbody></table>';
      html += '<div style="margin-top:24px;color:#98a2b3;font-size:11px;opacity:0.5">DNO Admin &middot; Token-protected &middot; Not public</div>';
      html += '</body></html>';
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      res.end(html);
    } else if (req.url === "/agent") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(AGENT_GUIDE_HTML);
    } else if (req.url === "/methodology") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(METHODOLOGY_HTML);
    } else if (req.url === "/badge") {
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
    } else if (req.url === "/sentinel") {
      var sentinelData = { status: "ok", lastCheck: null, recentAlerts: [], dedupFile: "/tmp/sentinel-dedup.json" };
      try {
        if (existsSync("/tmp/sentinel-dedup.json")) {
          var dedup = JSON.parse(readFileSync("/tmp/sentinel-dedup.json", "utf8"));
          var now = Date.now();
          var recent = Object.entries(dedup)
            .filter(function(e) { return now - e[1] < 24 * 60 * 60 * 1000; })
            .sort(function(a, b) { return b[1] - a[1]; })
            .slice(0, 10)
            .map(function(e) { return { key: e[0], ts: e[1], ago: Math.round((now - e[1]) / 60000) + "min ago" }; });
          sentinelData.recentAlerts = recent;
          sentinelData.lastCheck = dedup._lastCheck || null;
          sentinelData.alertCount24h = recent.length;
        }
      } catch(e) { sentinelData.error = e.message; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(sentinelData, null, 2));
    } else if (req.url === "/dashboard") {
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
      <h2 style="color:#58a6ff;font-size:1.1em;margin-bottom:12px">Reputation scores (24h)</h2>
      <div id="rep-list">Loading...</div>
    </div>
    <div class="sla"><h2>Node SLA — uptime</h2>
      <table><thead><tr><th>Node</th><th>Block</th><th>Uptime</th><th></th></tr></thead>
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
  Confidence anchored by <span id="hw-fleet-count">—</span> reference nodes &nbsp;·&nbsp;
  Updated every 20s &nbsp;·&nbsp;
  Data quality: <span id="hw-quality">—</span> &nbsp;·&nbsp;
  <a href="/methodology" style="color:#58a6ff">Methodology</a>
</div>

<div class="footer" style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap">
  <span>Demos Network Oracle v6.9 &bull; ${INSTANCE_ROLE.toUpperCase()}</span>
  <span style="color:#3fb950;font-weight:600">&#10003; DAHR Attested</span>
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
var FLEET_NODES = ["n1","n2","n3","n4","n5","n6","m1","m3","n9"];
function isFleetIncident(inc) {
  if(inc.description && (inc.description.indexOf("Fleet reference")===0 || inc.description === "Chain-level issue detected")) return true;
  return inc.affectedNodes && inc.affectedNodes.length > 0 && inc.affectedNodes.every(function(n){ return FLEET_NODES.includes(n); });
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
    document.getElementById("rec-reason").textContent=(d.reason||"")+" · Risk: "+(d.risk||"?").toUpperCase()+" · Confidence: "+(d.confidence||"?").toUpperCase();
    var ng=document.getElementById("nodes");ng.innerHTML="";
    if(d.reference&&d.reference.fleet_nodes){d.reference.fleet_nodes.forEach(function(n){
      var cls=n.status==="HEALTHY"?"healthy":"unhealthy";
      ng.innerHTML+='<div class="node '+cls+'"><h3>'+n.name+'</h3><div class="status">'+(n.status==="HEALTHY"?"\u2705":"\u274C")+" "+n.status+'</div><div class="block">Block '+(n.blockHeight||"?")+'</div></div>';
    });}
    var mg=document.getElementById("metrics");mg.innerHTML="";
    // Summary cards — public network focused only
    if(d.agreement){
      var na=d.agreement;
      var agCol=na.state==="strong"?"#3fb950":na.state==="moderate"?"#d29922":"#f85149";
      mg.innerHTML+='<div class="metric"><div class="label">Network Block</div><div class="value">'+(na.max_block||na.median_block||"?")+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Agreement</div><div class="value" style="color:'+agCol+'">'+na.state.toUpperCase()+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Public Nodes</div><div class="value">'+na.aligned_nodes+'/'+na.total_nodes+' online</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Block Spread</div><div class="value" style="color:'+(na.block_spread>100?"#f85149":na.block_spread>10?"#d29922":"#3fb950")+'">'+na.block_spread+'</div></div>';
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
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Aligned</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+na.aligned_nodes+'/'+na.total_nodes+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Median Block</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+(na.median_block||"?")+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Block Spread</div><div style="font-size:1.1em;font-weight:bold;color:'+(na.block_spread>100?"#f85149":na.block_spread>10?"#d29922":"#3fb950")+'">'+na.block_spread+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Agreement %</div><div style="font-size:1.1em;font-weight:bold;color:'+agCol+'">'+(na.total_nodes>0?Math.round(na.aligned_nodes/na.total_nodes*100):0)+'%</div></div>';
      html+='</div>';
      if(na.outlier_nodes&&na.outlier_nodes.length>0){
        html+='<div style="font-size:0.82em;color:#d29922;margin-top:4px">⚠ Outliers: '+na.outlier_nodes.map(function(o){return o.name+' ('+o.block+', lag '+o.lag+')'}).join(', ')+'</div>';
      } else {
        html+='<div style="font-size:0.82em;color:#3fb950;margin-top:4px">✅ All public nodes aligned with network head</div>';
      }
      agBox.innerHTML=html;
    }

    // How we know box
    var hwPublic=document.getElementById("hw-public-count");
    var hwFleet=document.getElementById("hw-fleet-count");
    var hwQuality=document.getElementById("hw-quality");
    if(hwPublic&&d.agreement) hwPublic.textContent=d.agreement.total_nodes;
    if(hwFleet&&d.reference) hwFleet.textContent=d.reference.fleet_size;
    if(hwQuality&&d.data_quality) hwQuality.textContent=d.data_quality.toUpperCase();
    var gb=document.getElementById("growth-status");
    if(gb&&d.validator_growth){
      var vg=d.validator_growth;
      var gh='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
      gh+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Discovered</div><div style="font-size:1.1em;font-weight:bold;color:#58a6ff">'+vg.total+'</div></div>';
      gh+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Online</div><div style="font-size:1.1em;font-weight:bold;color:#3fb950">'+vg.online+'</div></div>';
      gh+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Synced</div><div style="font-size:1.1em;font-weight:bold;color:'+(vg.synced>0?'#3fb950':'#d29922')+'">'+vg.synced+'</div></div>';
      gh+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Monitored</div><div style="font-size:1.1em;font-weight:bold;color:#58a6ff">'+vg.monitored+'</div></div>';
      gh+='</div>';
      gh+='<div style="font-size:0.82em;color:#8b949e;margin-bottom:12px">+'+vg.today+' today \u00b7 +'+vg.week+' this week</div>';
      if(vg.validators&&vg.validators.length>0){
        gh+='<table style="width:100%;border-collapse:collapse;font-size:0.85em"><thead><tr><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Validator</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Block</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Sync</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Status</th><th style="color:#8b949e;text-align:right;padding:4px 8px;border-bottom:1px solid #21262d">Since</th></tr></thead><tbody>';
        vg.validators.forEach(function(v){
          var syncCol=v.sync_pct>=95?'#2dd4a0':v.sync_pct>=80?'#d97706':'#EF4444';
          var statusIcon=v.monitored?'\u2705 monitored':v.sync_pct>=95?'\u2705 ready':v.sync_pct>=80?'\ud83d\udd04 catching up':'\ud83d\udd04 syncing';
          var since=v.first_seen_hours_ago<24?v.first_seen_hours_ago+'h ago':Math.round(v.first_seen_hours_ago/24)+'d ago';
          gh+='<tr><td style="padding:6px 8px;border-bottom:1px solid #21262d"><b>'+v.display+'</b></td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(v.block?v.block.toLocaleString():'?')+'</td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;color:'+syncCol+'">'+v.sync_pct+'%</td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d">'+statusIcon+'</td>';
          gh+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;text-align:right;color:#8b949e">'+since+'</td></tr>';
        });
        gh+='</tbody></table>';
      }
      gb.innerHTML=gh;
    }
    var sb=document.getElementById("sla-body");sb.innerHTML="";
    var up=(d.reference&&d.reference.uptime)||{};
    if(d.reference&&d.reference.fleet_nodes){d.reference.fleet_nodes.forEach(function(n){
      var u=up[n.name]||{healthy:0,total:0};
      var pct=u.total>0?Math.round(u.healthy/u.total*100):null;
      var pctStr=pct!==null?pct+"%":"—";
      var fillCls=pct===null?"":pct>=95?"":pct>=80?" warn":" bad";
      var bar=pct!==null?'<div class="uptime-bar"><div class="uptime-fill'+fillCls+'" style="width:'+pct+'%"></div></div>':'<div class="uptime-bar"></div>';
      sb.innerHTML+='<tr><td><b>'+n.name+'</b></td><td>'+(n.blockHeight||"?")+'</td><td>'+pctStr+'</td><td style="width:120px">'+bar+'</td></tr>';
    });}
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
      html+='<div style="font-size:0.82em;color:#8b949e;padding:8px 0;border-top:1px solid #21262d;margin-top:4px">'+(d.reason||'')+'</div>';
      db.innerHTML=html;
    }
    // Filter signals — only show public/network signals on main page
    // Fleet-internal signals go to reference layer only
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
    var rr=await fetch("/reputation");var rd=await rr.json();
    var rl=document.getElementById("rep-list");
    if(rl&&rd.scores){
      var scores=Object.entries(rd.scores).sort(function(a,b){return b[1]-a[1];});
      var html='<table style="width:100%;border-collapse:collapse;font-size:0.85em"><thead><tr><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Node</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Score</th><th style="color:#8b949e;padding:4px 8px;border-bottom:1px solid #21262d"></th><th style="color:#8b949e;text-align:right;padding:4px 8px;border-bottom:1px solid #21262d">Rank</th></tr></thead><tbody>';
      scores.forEach(function(e,i){
        var name=e[0],score=e[1];
        var col=score>=80?"#3fb950":score>=50?"#d29922":"#f85149";
        var barW=score+"%";
        html+='<tr><td style="padding:6px 8px;border-bottom:1px solid #21262d"><b>'+name+'</b></td>';
        html+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;font-weight:bold;color:'+col+'">'+score+'</td>';
        html+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;width:160px"><div style="background:#21262d;border-radius:4px;height:8px"><div style="height:8px;border-radius:4px;background:'+col+';width:'+barW+'"></div></div></td>';
        html+='<td style="padding:6px 8px;border-bottom:1px solid #21262d;text-align:right;color:#8b949e">#'+(i+1)+'</td></tr>';
      });
      html+='</tbody></table><div style="font-size:0.75em;color:#484f58;margin-top:8px">Window: '+rd.window+' | '+rd.historyLength+' data points</div>';
      rl.innerHTML=html;
    }
  }catch(e){}
  try{
    var sr=await fetch("/sentinel");var sd=await sr.json();
    var sb=document.getElementById("sentinel-status");
    if(sb){
      var alerts=sd.recentAlerts||[];
      var html='<div style="display:flex;gap:16px;margin-bottom:12px">';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center"><div style="color:#8b949e;font-size:0.75em">Alerts 24h</div><div style="font-size:1.4em;font-weight:bold;color:'+(alerts.length===0?"#3fb950":"#f85149")+'">'+(alerts.length)+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center"><div style="color:#8b949e;font-size:0.75em">Poll interval</div><div style="font-size:1.4em;font-weight:bold;color:#c9d1d9">5min</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center"><div style="color:#8b949e;font-size:0.75em">Detectors</div><div style="font-size:1.4em;font-weight:bold;color:#c9d1d9">5</div></div>';
      html+='</div>';
      if(alerts.length===0){
        html+='<div style="color:#3fb950;font-size:0.85em">\u2705 No anomalies detected in last 24h</div>';
      } else {
        html+='<div style="font-size:0.8em;color:#8b949e;margin-bottom:6px">Recent alerts:</div>';
        alerts.slice(0,5).forEach(function(a){
          html+='<div style="font-size:0.82em;padding:4px 0;border-bottom:1px solid #21262d;color:#f85149">\u26a0\ufe0f '+a.key+' <span style="color:#8b949e">('+a.ago+')</span></div>';
        });
      }
      sb.innerHTML=html;
    }
  }catch(e){}
  try{
    var pn=document.getElementById("pub-list");
    if(pn&&d.publicNodes&&d.publicNodes.length>0){
      var pt='<table style="width:100%;border-collapse:collapse;font-size:0.85em"><thead><tr><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Node</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Block</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Latency</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Peers</th><th style="color:#8b949e;text-align:left;padding:4px 8px;border-bottom:1px solid #21262d">Status</th></tr></thead><tbody>';
      d.publicNodes.forEach(function(n){
        pt+='<tr><td style="padding:6px 8px;border-bottom:1px solid #21262d"><b>'+n.name+'</b></td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.block||'?')+'</td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.latencyMs?n.latencyMs+'ms':'?')+'</td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.peers||'?')+'</td><td style="padding:6px 8px;border-bottom:1px solid #21262d">'+(n.ok?'\u2705 online':'\u274c offline')+'</td></tr>';
      });
      pt+='</tbody></table>';
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
    } else if (req.url.indexOf("/history/export") === 0) {} else if (req.url.indexOf("/history/export") === 0) {
      var expFrom = 0, expTo = Infinity;
      var fromIdx = req.url.indexOf("from=");
      var toIdx = req.url.indexOf("to=");
      if (fromIdx !== -1) expFrom = parseInt(req.url.substring(fromIdx + 5), 10) || 0;
      if (toIdx !== -1) expTo = parseInt(req.url.substring(toIdx + 3), 10) || Infinity;
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
  });

  server.listen(HEALTH_PORT, "0.0.0.0", function() {
    log("  Health API listening on port " + HEALTH_PORT);
  });

  server.on("error", function(err) {
    logError("Health server error: " + err.message);
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
      healthEndpoint: "http://193.77.169.106:" + HEALTH_PORT + "/health",
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
    var info = await demos.getAddressInfo(AGENT_WALLET);
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
  var probes = NODE_NAMES.filter(function(n) { return n !== "n3"; }).map(function(name) {
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
  log("  SuperColony Node Health Agent v6.3 — Demos Fleet Oracle");
  log("  Fleet: " + FLEET_SIZE + " nodes across 4 servers");
  log("  Interval: " + (INTERVAL_MS / 1000 / 60) + " minutes");
  log("  Cooldown: " + COOLDOWN_CYCLES + " cycles before alerting");
  log("  DAHR: attestation enabled (auto-detect SDK support)");
  log("  Daily summary: every " + DAILY_SUMMARY_CYCLES + " cycles (" + Math.round(DAILY_SUMMARY_CYCLES * INTERVAL_MS / 1000 / 3600) + "h)");
  log("  Public RPCs: " + PUBLIC_RPCS.map(function(r) { return r.name; }).join(", "));
  log("  Explorer: " + EXPLORER_STATUS_URL);
  log("  Health API: http://0.0.0.0:" + HEALTH_PORT + "/health");
  log("  Primary probe: " + LOCAL_INFO_URL);
  log("  Prometheus: " + PROMETHEUS_URL);
  log("  Demos RPC: " + RPC_URL);
  log("  Telegram: " + (TELEGRAM_BOT_TOKEN ? "ENABLED" : "DISABLED"));
  log("  Features: reputation scoring, predictive alerts, anomaly detection, validator discovery");
  log("  Fixes: shared DB, write budget, staleness, atomic history, log rotation");
  log("===============================================================");

  // Load historical data
  loadHistory();

  // FIX BUG 3: Open shared SQLite handle ONCE for both modules
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
  log("  Public node history table ready");
  try { sharedDb.run("ALTER TABLE submissions ADD COLUMN probe_error TEXT"); } catch(e) {}
    sharedDb.run("CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, port INTEGER, operator TEXT, status TEXT DEFAULT 'pending', probe_ok INTEGER DEFAULT 0, probe_block INTEGER, probe_identity TEXT, submitted_at INTEGER, reviewed_at INTEGER, probe_error TEXT)");
  log("  Submissions table ready");

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
  // M9: Reload approved submissions into PUBLIC_NODES
  try {
    var approved = sharedDb.query("SELECT * FROM submissions WHERE status='approved' ORDER BY id ASC").all();
    var loadedCount = 0, skippedCount = 0;
    for (var ai = 0; ai < approved.length; ai++) {
      var sub = approved[ai];
      var subUrl = "http://" + sub.host + ":" + sub.port;
      var dupUrl = Object.values(PUBLIC_NODES).some(function(n){ return n.url === subUrl; });
      var dupIdentity = sub.probe_identity && Object.values(PUBLIC_NODES).some(function(n){ return n.identity === sub.probe_identity; });
      if (dupUrl || dupIdentity) { skippedCount++; continue; }
      var nodeName = "community-node-" + sub.id;
      PUBLIC_NODES[nodeName] = { url: subUrl, identity: sub.probe_identity || "unknown", source_type: "community", trust_tier: "community_submitted", operator: sub.operator, joined_at: new Date(sub.reviewed_at || sub.submitted_at).toISOString().split("T")[0] };
      loadedCount++;
      log("  Loaded approved node: " + nodeName + " = " + sub.host + ":" + sub.port);
    }
    log("  Approved submissions: " + loadedCount + " loaded, " + skippedCount + " skipped (duplicate)");
  } catch(loadErr) { log("  Failed to load approved submissions: " + loadErr.message); }

  // v6.4: Load incident counter from DB
  loadIncidentCounter();
  log("  Incident counter: " + incidentCounter);

  // Start health API server
  startHealthServer();

  var demos = new Demos();
  await demos.connect(RPC_URL);
  await demos.connectWallet(MNEMONIC);
  AGENT_WALLET = demos.getAddress();
  log("  Agent wallet: " + AGENT_WALLET);
  log("Wallet connected. Agent is live.\n");

  // Register agent profile (fire and forget)
  registerAgentProfile();

  var mktAddress = demos.getAddress();

  // Shared deps object for both modules
  var sharedDeps = {
    demos: demos,
    address: mktAddress,
    db: sharedDb, // FIX BUG 3: shared DB handle
    getFleetData: function() { return latestHealthData; },
    getHistory: function() { return history; },
    getRepScores: calculateReputationScores,
    detectTrends: detectTrends,
    publish: publish,
    dahrAttest: dahrAttest,
    sendTelegram: sendTelegram,
    log: log,
    dataDir: LOG_DIR,
    canPublish: canPublish, // FIX BUG 6: expose budget check
  };

  // === v6.0: Marketplace init ===
  try {
    initMarketplace(sharedDeps);
  } catch (mktErr) {
    log("[marketplace] init failed (non-fatal): " + (mktErr.message || mktErr));
  }

  // === v6.1: Consensus Oracle init ===
  try {
    initConsensus(sharedDeps);
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
          await demos.connect(RPC_URL);
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
      var publicNodeResults = await probePublicNodes();
      latestPublicNodes = publicNodeResults;
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


      // M3: Record public node observation snapshot
      recordPublicNodeHistory();

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

      // --- Validator discovery ---
      if (!data.skip && data.nodeReports) {
        // Crawl n3's own peerlist
        var localInfo = null;
        try {
          var lr = await fetch("http://127.0.0.1:53550/info", { signal: AbortSignal.timeout(5000) });
          localInfo = await lr.json();
          var newFromLocal = discoverValidators(localInfo);
          if (newFromLocal.length > 0) log("  Discovery: " + newFromLocal.length + " new peer(s) from local node");
        } catch(e) { log("  Discovery: local info fetch failed: " + e.message); }

        // Crawl public node peerlists for additional validators
        for (var pnName in PUBLIC_NODES) {
          try {
            var pnr = await fetch(PUBLIC_NODES[pnName].url + "/info", { signal: AbortSignal.timeout(5000) });
            var pnInfo = await pnr.json();
            var newFromPn = discoverValidators(pnInfo);
            if (newFromPn.length > 0) log("  Discovery: " + newFromPn.length + " new peer(s) from " + pnName);
          } catch(e) {}
        }

        var totalDiscovered = Object.keys(discoveredPeers).length;
        if (totalDiscovered > 0) log("  Discovery: " + totalDiscovered + " total non-fleet validators tracked");
      }

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

      // --- Predictive trend alerts ---
      var trendAlerts = detectTrends();
      if (trendAlerts.length > 0) {
        log("  Trend alerts: " + trendAlerts.join(", "));
        var trendPost = {
          cat: "ALERT",
          text: "Predictive Warning: " + trendAlerts.join(". ") + ".",
          confidence: 75,
        };
        await publish(demos, trendPost, cycleAttestations);
        await sendTelegram("⚠️ <b>TREND WARNING</b>\n" + trendPost.text);
      }

      // === v6.0: Marketplace poll ===
      try {
        var mktResult = await pollAndProcessQueries();
        if (mktResult.queriesFound > 0 || mktResult.queriesProcessed > 0) {
          log("[marketplace] cycle: found=" + mktResult.queriesFound + " processed=" + mktResult.queriesProcessed + " errors=" + mktResult.errors.length);
        }
      } catch (mktErr) {
        log("[marketplace] poll error (non-fatal): " + (mktErr.message || mktErr));
      }

      // === v6.1: Consensus Oracle poll ===
      try {
        var conResult = await pollAndProcessConsensus();
        if (conResult.reportsFound > 0 || conResult.consensusPublished) {
          log("[consensus] cycle: reports=" + conResult.reportsFound + " published=" + conResult.consensusPublished);
        }
      } catch (conErr) {
        log("[consensus] poll error (non-fatal): " + (conErr.message || conErr));
      }

      // --- Daily summary (includes reputation leaderboard) ---
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

        // Publish reputation leaderboard
        if (history.length >= 12) {
          var scores = calculateReputationScores();
          var leaderboardPost = composeLeaderboard(scores);
          await publish(demos, leaderboardPost, cycleAttestations);
          await sendTelegram("🏆 <b>LEADERBOARD</b>\n" + leaderboardPost.text);
        }

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

  await cycle();
  setInterval(cycle, MONITOR_INTERVAL_MS);
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
              var hr = await fetch("http://127.0.0.1:55225/health");
              var d = await hr.json();
              var rec = d.recommendation || {};
              var nodes = (d.fleet && d.fleet.nodes) || [];
              var healthy = d.fleet ? d.fleet.healthy : 0;
              var lines = ["<b>Fleet Status</b>"];
              lines.push((rec.recommendation==="SAFE"?"\u2705":"\u26a0\ufe0f") + " <b>" + (rec.recommendation||"?") + "</b>");
              lines.push("Block: " + ((d.fleet&&d.fleet.block)||"?"));
              lines.push("Healthy: " + healthy + "/" + nodes.length);
              lines.push("Cycle: " + (d.cycleCount||0));
              nodes.forEach(function(n){
                lines.push((n.status==="HEALTHY"?"\u2705":"\u274c") + " " + n.name + " block " + (n.blockHeight||"?"));
              });
              reply = lines.join(NL);
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
          } else if (text === "/recommendation" || text === "/rec") {
            try {
              var hr = await fetch("http://127.0.0.1:55225/health");
              var d = await hr.json();
              var rec = d.recommendation || {};
              var lines = ["<b>Recommendation</b>"];
              lines.push((rec.recommendation==="SAFE"?"\u2705":rec.recommendation==="CAUTION"?"\u26a0\ufe0f":"\ud83d\udd34") + " <b>" + (rec.recommendation||"?") + "</b>");
              lines.push("Safe to propose: " + (rec.safe_to_propose?"YES":"NO"));
              lines.push("Confidence: " + (rec.confidence||"?"));
              lines.push("Reason: " + (rec.reason||"?"));
              reply = lines.join(NL);
            } catch(e) { reply = "Error: " + e.message; }
          } else if (text === "/uptime" || text === "/sla") {
            try {
              var hr = await fetch("http://127.0.0.1:55225/health");
              var d = await hr.json();
              var lines = ["<b>Node Uptime</b>"];
              var up = d.uptime || {};
              Object.keys(up).forEach(function(name){
                var u = up[name];
                var pct = u.total > 0 ? Math.round(u.healthy/u.total*100) : null;
                lines.push((pct===100?"\u2705":pct>=80?"\u26a0\ufe0f":"\u274c") + " " + name + ": " + (pct!==null?pct+"%":"--") + " (" + u.healthy + "/" + u.total + ")");
              });
              reply = lines.join(NL);
            } catch(e) { reply = "Error: " + e.message; }
          } else if (text === "/signals") {
            try {
              var hr = await fetch("http://127.0.0.1:55225/health");
              var d = await hr.json();
              var sigs = d.signals || [];
              var lines = ["<b>Network Signals</b>"];
              var sevIcon = {"info": "\u2139\ufe0f", "warning": "\u26a0\ufe0f", "critical": "\ud83d\udd34"};
              sigs.forEach(function(s) {
                var icon = sevIcon[s.severity] || "\u2139\ufe0f";
                lines.push(icon + " <b>" + s.type.replace(/_/g," ").toUpperCase() + "</b>");
                lines.push("  " + s.message);
                if (s.nodes && s.nodes.length > 0) lines.push("  Nodes: " + s.nodes.join(", "));
              });
              reply = lines.join(NL);
            } catch(e) { reply = "Error: " + e.message; }
          } else if (text === "/help" || text === "/start") {
            var lines = ["<b>Demos Fleet Oracle Bot</b>","","/status — full fleet status","/incidents — last 5 incidents","/rec — SAFE/CAUTION/UNSAFE","/uptime — per-node uptime %","/signals — current network signals","/help — this message","","Dashboard: http://193.77.169.106:55225/dashboard"];
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

main().catch(function(err) {
  logError("Fatal error:", err);
  process.exit(1);
});

pollTelegram().catch(function(err) {
  logError("Telegram polling error:", err);
});


// === v6.0: Graceful shutdown ===
process.on("SIGTERM", function() {
  log("[agent] SIGTERM — shutting down");
  shutdownMarketplace();
  // FIX BUG 3: Close shared DB on shutdown
  if (sharedDb) { try { sharedDb.close(); log("[agent] shared DB closed"); } catch(e) {} }
  process.exit(0);
});
process.on("SIGINT", function() {
  log("[agent] SIGINT — shutting down");
  shutdownMarketplace();
  // FIX BUG 3: Close shared DB on shutdown
  if (sharedDb) { try { sharedDb.close(); log("[agent] shared DB closed"); } catch(e) {} }
  process.exit(0);
});
