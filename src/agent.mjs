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
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || "60000"); // 1 min monitoring, independent of publish interval
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
const AGENT_DESCRIPTION = "Autonomous health & stability oracle for the Demos Network. Monitors 7 nodes across 4 servers every 20 minutes. Publishes DAHR-attested alerts, daily summaries, and reputation scores. Public health API at /health.";
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
'<div class="e"><b>GET /health</b><span>Full network snapshot — decision, scores, network_agreement, signals_grouped, public nodes, incidents</span></div>' +
'<div class="e"><b>GET /organism</b><span>Lightweight machine-readable network state — optimized for agent consumption</span></div>' +
'<div class="e"><b>GET /signals</b><span>Current network signals grouped by severity (critical / warning / info)</span></div>' +
'<div class="e"><b>GET /incidents</b><span>Network incident log with severity, duration, and affected components</span></div>' +
'<h2>Validators</h2>' +
'<div class="e"><b>GET /peers</b><span>Discovered validators — identity, connection, block, first seen</span></div>' +
'<div class="e"><b>GET /reputation</b><span>Per-node reputation scores (0-100) over 24h window</span></div>' +
'<div class="e"><b>GET /sentinel</b><span>Anomaly detector status — alerts, detectors, last 24h summary</span></div>' +
'<h2>History</h2>' +
'<div class="e"><b>GET /history</b><span>Last 72 health cycles as JSON</span></div>' +
'<div class="e"><b>GET /history/export?format=csv&amp;from=TS&amp;to=TS</b><span>Export history as CSV. Optional from/to filters (Unix ms)</span></div>' +
'<h2>Integration</h2>' +
'<div class="e"><b>GET /federate</b><span>Prometheus metrics endpoint for scraping</span></div>' +
'<div class="e"><b>GET /federate/config</b><span>Prometheus scrape_config snippet</span></div>' +
'<div class="e"><b>GET /badge</b><span>SVG network status badge — embeddable in READMEs and dashboards</span></div>' +
'<div class="e"><b>GET /version</b><span>Running agent version vs latest GitHub commit</span></div>' +
'<footer>All endpoints return JSON unless noted. Monitoring interval: 1 min. Publishing interval: 20 min. Oracle is strictly watch-only — observe, interpret, summarize risk.</footer></body></html>';

// FIX BUG 6: Write budget constants (SuperColony rate limits)
const DAILY_PUBLISH_LIMIT = 15;
const HOURLY_PUBLISH_LIMIT = 5;
let publishTimestamps = []; // rolling window of publish times

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
  // Community nodes — manually approved by CypherX33
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
  if (!data || !data.nodeReports) return { recommendation: "INSUFFICIENT_DATA", safe_to_propose: false, confidence: "low", reason: "No fleet data available" };
  var healthy = data.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length;
  var total = data.nodeReports.length;
  var offline = data.nodeReports.filter(function(n) { return n.issues && n.issues.some(function(i) { return i === "OFFLINE"; }); }).length;
  var chainOk = !data.problems || data.problems.filter(function(p) { return p.name === "CHAIN"; }).length === 0;
  var publicActiveIncs = getPublicActiveIncidentIds();
  if (healthy === total && chainOk && publicActiveIncs.length === 0) {
    return { recommendation: "SAFE", safe_to_propose: true, confidence: "high", reason: "Network stable, no issues detected" };
  }
  if (healthy >= Math.ceil(total * 0.7) && offline < 3) {
    return { recommendation: "CAUTION", safe_to_propose: true, confidence: "medium", reason: "Network stable, minor observations present" };
  }
  return { recommendation: "UNSAFE", safe_to_propose: false, confidence: "high", reason: healthy + "/" + total + " healthy, significant issues detected" };
}

// Load incident counter from DB on startup
function getValidatorGrowth() {
  if (!sharedDb) return { today: 0, week: 0, total: 0 };
  try {
    var now = Date.now();
    var dayAgo = now - 86400000;
    var weekAgo = now - 604800000;
    var total = sharedDb.query("SELECT COUNT(*) as c FROM validator_discoveries").get().c;
    var today = sharedDb.query("SELECT COUNT(*) as c FROM validator_discoveries WHERE first_seen > ?").get(dayAgo).c;
    var week = sharedDb.query("SELECT COUNT(*) as c FROM validator_discoveries WHERE first_seen > ?").get(weekAgo).c;
    return { today: today, week: week, total: total };
  } catch(e) { return { today: 0, week: 0, total: 0 }; }
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

  var total = data.nodeReports.length;
  var healthy = data.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length;
  var offline = data.nodeReports.filter(function(n) { return !n.online; }).length;
  var blocks = data.nodeReports.map(function(n) { return n.blockHeight; }).filter(Boolean);
  var blockSpread = blocks.length > 1 ? Math.max.apply(null, blocks) - Math.min.apply(null, blocks) : 0;
  var criticalSignals = signals.filter ? signals.filter(function(s) { return s.severity === "critical"; }) : [];
  var warningSignals = signals.filter ? signals.filter(function(s) { return s.severity === "warning"; }) : [];
  var chainStall = criticalSignals.some(function(s) { return s.type === "chain_stall" || s.type === "block_divergence"; });

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
  } else if (offline > 0 || criticalSignals.length > 0) {
    status = "degraded"; risk_level = "medium";
    reason = offline + " node(s) offline, " + criticalSignals.length + " critical signal(s)";
    affected = ["nodes"];
  } else if (warningSignals.length > 0 || blockSpread > 10) {
    status = "degraded"; risk_level = "low";
    reason = warningSignals.length + " warning signal(s), block spread " + blockSpread;
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

  var total = data.nodeReports.length;
  var healthy = data.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length;
  var offline = data.nodeReports.filter(function(n) { return !n.online; }).length;
  var blocks = data.nodeReports.map(function(n) { return n.blockHeight; }).filter(Boolean);
  var blockSpread = blocks.length > 1 ? Math.max.apply(null, blocks) - Math.min.apply(null, blocks) : 0;
  var sideA = data.nodeReports.filter(function(n) { return n.side === "A" && n.online; }).length;
  var sideB = data.nodeReports.filter(function(n) { return n.side === "B" && n.online; }).length;
  var sideImbalance = Math.abs(sideA - sideB);
  var criticalCount = signals.filter ? signals.filter(function(s) { return s.severity === "critical"; }).length : 0;

  var network_health = Math.round((healthy / total) * 100);
  var stability = Math.max(0, Math.round(100 - (blockSpread / 10) - (criticalCount * 15) - (offline * 10)));
  var partition_risk = Math.min(100, Math.round((sideImbalance / Math.max(sideA, sideB, 1)) * 50 + (blockSpread > 50 ? 30 : 0)));
  var data_confidence = Math.max(0, Math.round(100 - (stalenessSeconds > 300 ? 40 : stalenessSeconds > 60 ? 10 : 0) - (criticalCount * 10)));

  return {
    network_health: network_health,
    stability: Math.min(100, stability),
    partition_risk: partition_risk,
    data_confidence: data_confidence
  };
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
        results.push({ name: name, ok: true, latencyMs: latencyMs, block: block, version: data.version || "?", peers: data.peerlist ? data.peerlist.length : 0, identityMatch: identityMatch, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" });
        log("  PublicNode " + name + ": OK " + latencyMs + "ms block=" + (block||"?") + " peers=" + (data.peerlist?data.peerlist.length:0));
      } else {
        results.push({ name: name, ok: false, error: "HTTP " + res.status, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" });
        log("  PublicNode " + name + ": FAIL HTTP " + res.status);
      }
    } catch(err) {
      results.push({ name: name, ok: false, error: err.name === "TimeoutError" ? "Timeout" : err.message, source_type: node.source_type || "public", trust_tier: node.trust_tier || "verified", operator: node.operator || "Unknown" });
      log("  PublicNode " + name + ": FAIL " + err.message);
    }
  }
  return results;
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

    // Check if this is a known fleet node
    if (IDENTITY_TO_NAME[identity]) continue;

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
    var gr = await fetch("https://api.github.com/repos/xm33/demos-fleet-oracle/commits/master", { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "demos-fleet-oracle" } });
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

    if (req.url === "/health" || req.url === "/") {
      var staleness = getStaleness(); // FIX BUG 7
      var payload = {
        agent: AGENT_NAME,
        description: "Autonomous health oracle for the Demos Network. Monitors 7 validator nodes + public network nodes every 20min. Provides machine-readable signals, incidents, reputation scores, and on-chain attested health reports via SuperColony.",
        wallet: AGENT_WALLET,
        version: "6.8",
        fleet_size: FLEET_SIZE,
        // nodes: removed from public API — fleet data is in reference layer only
        timestamp: new Date().toISOString(),
        cycleCount: cycleCount,
        lastCycleAt: staleness.lastCycleAt, // FIX BUG 7
        stalenessSeconds: staleness.stalenessSeconds, // FIX BUG 7
        fleet: latestHealthData ? {
          size: FLEET_SIZE,
          healthy: latestHealthData.nodeReports ? latestHealthData.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length : 0,
          block: latestHealthData.chain ? latestHealthData.chain.block : null,
          tps: latestHealthData.chain ? latestHealthData.chain.tps : null,
          nodeVersions: nodeVersions,
        } : null,
        recommendation: getRecommendation(latestHealthData),
        publicRpcs: publicRpcStats,
        reputationScores: history.length > 0 ? calculateReputationScores() : null,
        discoveredPeers: Object.keys(discoveredPeers).length,
        uptime: uptimeStats,
        signals: generateSignals(latestHealthData, getStaleness()),
        signals_grouped: groupSignals(generateSignals(latestHealthData, getStaleness())),
        decision: generateDecision(latestHealthData, getStaleness(), generateSignals(latestHealthData, getStaleness())),
        scores: generateScores(latestHealthData, getStaleness(), generateSignals(latestHealthData, getStaleness())),
        network_agreement: generateNetworkAgreement(latestHealthData, latestPublicNodes),
        validator_growth: getValidatorGrowth(),
        activeIncidents: getPublicActiveIncidentIds(),
        publicNodes: latestPublicNodes || [],
        instanceRole: INSTANCE_ROLE,
        dahrEnabled: dahrAvailable === true,
        writeBudget: canPublish(), // FIX BUG 6: expose budget status
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
      var incLimit = parseInt(incParams.get("limit") || "50", 10);
      try {
        var incQuery = "SELECT * FROM incidents";
        var incArgs = [];
        if (incStatus) { incQuery += " WHERE status = ?"; incArgs.push(incStatus); }
        incQuery += " ORDER BY rowid DESC LIMIT ?";
        incArgs.push(incLimit);
        var incRows = sharedDb.prepare(incQuery).all(...incArgs);
        var incResults = incRows.map(function(r) {
          return {
            id: r.id, status: r.status, severity: r.severity,
            startedAt: r.started_at, resolvedAt: r.resolved_at,
            durationSeconds: r.duration_seconds,
            affectedNodes: JSON.parse(r.affected_nodes || "[]"),
            description: r.description,
            detectedBlock: r.detected_block, resolvedBlock: r.resolved_block,
            alerts: JSON.parse(r.alerts || "[]")
          };
        });
        res.writeHead(200);
        res.end(JSON.stringify({ total: incResults.length, active: Object.keys(activeIncidents).length, incidents: incResults }, null, 2));
      } catch(incErr) {
        res.writeHead(200);
        res.end(JSON.stringify({ total: 0, active: 0, incidents: [], error: incErr.message }, null, 2));
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
        scrape_config: { job_name: "demos-fleet-oracle", scrape_interval: "60s", metrics_path: "/federate",
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
        version: "6.8",
        uptimeSeconds: Math.round(process.uptime()),
        lastCycleAt: latestHealthData ? latestHealthData.timestamp : null,
        lastPublishAt: lastPublishAt,
        cycleCount: cycleCount,
        writeBudget: { hourly: selfBudget.hourly, maxHourly: HOURLY_PUBLISH_LIMIT, daily: selfBudget.daily, maxDaily: DAILY_PUBLISH_LIMIT, ok: selfBudget.ok },
        wallet: AGENT_WALLET,
        activeRpc: activeRpcUrl,
        demBalance: lastKnownBalance,
        endpoints: ["/health", "/self", "/docs", "/dashboard", "/reputation", "/peers", "/history", "/history/export", "/federate", "/badge", "/marketplace", "/consensus", "/incidents"]
      }, null, 2));
    } else if (req.url === "/organism") {
      var sigs = generateSignals(latestHealthData, getStaleness());
      var dec = generateDecision(latestHealthData, getStaleness(), sigs);
      var sc = generateScores(latestHealthData, getStaleness(), sigs);
      var criticalSigs = sigs.filter(function(s) { return s.severity === "critical"; });
      var unstableNodes = latestHealthData ? latestHealthData.nodeReports.filter(function(n) { return n.status !== "HEALTHY"; }).map(function(n) { return n.name; }) : [];
      var netAgree = generateNetworkAgreement(latestHealthData, latestPublicNodes);
      var organism = {
        network_status: dec.status,
        trend: "stable",
        network_health: sc.network_health,
        stability: sc.stability,
        risk_level: dec.risk_level,
        confidence: dec.confidence,
        data_quality: sc.data_confidence >= 90 ? "high" : sc.data_confidence >= 60 ? "medium" : "low",
        active_incidents: getPublicActiveIncidentIds().length,
        critical_signals: criticalSigs.length,
        unstable_nodes: unstableNodes,
        fleet_size: FLEET_SIZE,
        fleet_healthy: latestHealthData ? latestHealthData.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length : 0,
        network_agreement: netAgree.status,
        public_nodes_total: netAgree.total_nodes,
        public_nodes_aligned: netAgree.aligned_nodes,
        public_block_spread: netAgree.block_spread,
        valid_until: dec.valid_until,
        last_updated: dec.last_updated
      };
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(organism, null, 2));
    } else if (req.url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(latestVersionData, null, 2));
    } else if (req.url === "/docs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(DOCS_HTML);
    } else if (req.url === "/badge") {
      var bHealthy = latestHealthData && latestHealthData.nodeReports ? latestHealthData.nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length : 0;
      var bColor = bHealthy === FLEET_SIZE ? "#4c1" : bHealthy >= 4 ? "#dfb317" : "#e05d44";
      var bLabel = bHealthy + "/" + FLEET_SIZE;
      var bSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="106" height="20" role="img">' +
        '<rect width="46" height="20" fill="#555" rx="3"/><rect x="46" width="60" height="20" fill="' + bColor + '" rx="3"/>' +
        '<rect x="46" width="4" height="20" fill="' + bColor + '"/>' +
        '<text x="23" y="14" fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11">Fleet</text>' +
        '<text x="76" y="14" fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11">' + bLabel + ' ' + (bHealthy === FLEET_SIZE ? "\u2713" : "\u26a0") + '</text></svg>';
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
  Updated every 1 min &nbsp;·&nbsp;
  Data quality: <span id="hw-quality">—</span> &nbsp;·&nbsp;
  <a href="/docs" style="color:#58a6ff">Methodology</a>
</div>

<div class="footer">Demos Network Oracle v6.9 &bull; ${INSTANCE_ROLE.toUpperCase()} &bull; Auto-refresh 20s &bull; <a href="/health" style="color:#58a6ff">/health</a> &bull; <a href="/organism" style="color:#58a6ff">/organism</a> &bull; <a href="/incidents" style="color:#58a6ff">/incidents</a> &bull; <a href="https://github.com/xm33/demos-fleet-oracle" style="color:#58a6ff">GitHub</a></div>
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
    var pubBlock = (d.network_agreement&&d.network_agreement.max_block) || "?";
    var pubTotal = (d.network_agreement&&d.network_agreement.total_nodes) || "?";
    var pubAligned = (d.network_agreement&&d.network_agreement.aligned_nodes) || "?";
    document.getElementById("updated").textContent="Block "+pubBlock+
      " | "+pubAligned+"/"+pubTotal+" public nodes | Updated "+new Date(d.timestamp).toLocaleTimeString()+
      " | Staleness "+d.stalenessSeconds+"s";
    var rec=d.recommendation||{};
    var re=document.getElementById("rec");
    re.textContent=rec.recommendation||"?";
    re.className="rec "+(rec.recommendation==="SAFE"?"safe":rec.recommendation==="CAUTION"?"caution":rec.recommendation==="UNSAFE"?"unsafe":"unknown");
    document.getElementById("rec-reason").textContent=(rec.safe_to_propose?"Safe to propose":"NOT safe to propose")+" — "+(rec.reason||"")+" (confidence: "+(rec.confidence||"?")+")";
    var ng=document.getElementById("nodes");ng.innerHTML="";
    if(d.fleet&&d.fleet.nodes){d.fleet.nodes.forEach(function(n){
      var cls=n.status==="HEALTHY"?"healthy":"unhealthy";
      ng.innerHTML+='<div class="node '+cls+'"><h3>'+n.name+'</h3><div class="status">'+(n.status==="HEALTHY"?"\u2705":"\u274C")+" "+n.status+'</div><div class="block">Block '+(n.blockHeight||"?")+'</div></div>';
    });}
    var mg=document.getElementById("metrics");mg.innerHTML="";
    // Summary cards — public network focused only
    if(d.network_agreement){
      var na=d.network_agreement;
      var agCol=na.status==="strong"?"#3fb950":na.status==="moderate"?"#d29922":"#f85149";
      mg.innerHTML+='<div class="metric"><div class="label">Network Block</div><div class="value">'+(na.max_block||"?")+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Agreement</div><div class="value" style="color:'+agCol+'">'+na.status.toUpperCase()+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Public Nodes</div><div class="value">'+na.aligned_nodes+'/'+na.total_nodes+' online</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Block Spread</div><div class="value" style="color:'+(na.block_spread>100?"#f85149":na.block_spread>10?"#d29922":"#3fb950")+'">'+na.block_spread+'</div></div>';
    }
    if(d.decision){
      var dec=d.decision;
      var riskCol=dec.risk_level==="low"?"#3fb950":dec.risk_level==="medium"?"#d29922":"#f85149";
      mg.innerHTML+='<div class="metric"><div class="label">Risk Level</div><div class="value" style="color:'+riskCol+'">'+dec.risk_level.toUpperCase()+'</div></div>';
      mg.innerHTML+='<div class="metric"><div class="label">Confidence</div><div class="value">'+(Math.round(dec.confidence*100))+'%</div></div>';
    }
    mg.innerHTML+='<div class="metric"><div class="label">Active Incidents</div><div class="value">'+((d.activeIncidents&&d.activeIncidents.length)||0)+'</div></div>';

    // Network agreement panel
    var agBox=document.getElementById("agreement-status");
    if(agBox&&d.network_agreement){
      var na=d.network_agreement;
      var agCol=na.status==="strong"?"#3fb950":na.status==="moderate"?"#d29922":"#f85149";
      var html='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Agreement</div><div style="font-size:1.1em;font-weight:bold;color:'+agCol+'">'+na.status.toUpperCase()+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Aligned</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+na.aligned_nodes+'/'+na.total_nodes+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Median Block</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+(na.median_block||"?")+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Block Spread</div><div style="font-size:1.1em;font-weight:bold;color:'+(na.block_spread>100?"#f85149":na.block_spread>10?"#d29922":"#3fb950")+'">'+na.block_spread+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:90px"><div style="color:#8b949e;font-size:0.75em">Agreement %</div><div style="font-size:1.1em;font-weight:bold;color:'+agCol+'">'+na.agreement_ratio+'%</div></div>';
      html+='</div>';
      if(na.outlier_nodes&&na.outlier_nodes.length>0){
        html+='<div style="font-size:0.82em;color:#d29922;margin-top:4px">⚠ Outliers: '+na.outlier_nodes.map(function(o){return o.name+' ('+o.block+', lag '+o.lag+')'}).join(', ')+'</div>';
      } else {
        html+='<div style="font-size:0.82em;color:#3fb950;margin-top:4px">✅ All public nodes aligned with network head</div>';
      }
      if(d.validator_growth){
        var vg=d.validator_growth;
        html+='<div style="margin-top:12px;padding-top:10px;border-top:1px solid #21262d;display:flex;gap:16px;flex-wrap:wrap">';
        html+='<span style="font-size:0.8em;color:#8b949e">Validator discovery: </span>';
        html+='<span style="font-size:0.8em;color:#c9d1d9">+'+vg.today+' today</span>';
        html+='<span style="font-size:0.8em;color:#c9d1d9">+'+vg.week+' this week</span>';
        html+='<span style="font-size:0.8em;color:#58a6ff">'+vg.total+' total discovered</span>';
        html+='</div>';
      }
      agBox.innerHTML=html;
    }

    // How we know box
    var hwPublic=document.getElementById("hw-public-count");
    var hwFleet=document.getElementById("hw-fleet-count");
    var hwQuality=document.getElementById("hw-quality");
    if(hwPublic&&d.network_agreement) hwPublic.textContent=d.network_agreement.total_nodes;
    if(hwFleet&&d.fleet) hwFleet.textContent=d.fleet.size;
    if(hwQuality&&d.scores) hwQuality.textContent=d.scores.data_confidence+'%';
    var sb=document.getElementById("sla-body");sb.innerHTML="";
    var up=d.uptime||{};
    if(d.fleet&&d.fleet.nodes){d.fleet.nodes.forEach(function(n){
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
    if(db&&d.decision){
      var dec=d.decision;
      var sc=d.scores||{};
      var statusCol=dec.status==="stable"?"#3fb950":dec.status==="recovering"?"#58a6ff":dec.status==="degraded"?"#d29922":"#f85149";
      var riskCol=dec.risk_level==="low"?"#3fb950":dec.risk_level==="medium"?"#d29922":"#f85149";
      var html='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Status</div><div style="font-size:1.1em;font-weight:bold;color:'+statusCol+'">'+dec.status.toUpperCase()+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Risk</div><div style="font-size:1.1em;font-weight:bold;color:'+riskCol+'">'+dec.risk_level.toUpperCase()+'</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Confidence</div><div style="font-size:1.1em;font-weight:bold;color:#c9d1d9">'+(Math.round(dec.confidence*100))+'%</div></div>';
      html+='<div style="background:#0d1117;border-radius:6px;padding:10px 16px;text-align:center;min-width:80px"><div style="color:#8b949e;font-size:0.75em">Partition Risk</div><div style="font-size:1.1em;font-weight:bold;color:'+(sc.partition_risk>30?"#f85149":sc.partition_risk>10?"#d29922":"#3fb950")+'">'+(sc.partition_risk||0)+'</div></div>';
      html+='</div>';
      html+='<div style="font-size:0.82em;color:#8b949e;padding:8px 0;border-top:1px solid #21262d;margin-top:4px">'+dec.reason+'</div>';
      html+='<div style="font-size:0.75em;color:#484f58;margin-top:6px">Valid until: '+new Date(dec.valid_until).toLocaleTimeString()+'</div>';
      db.innerHTML=html;
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

  // Validator discovery tracking table
  sharedDb.run(`CREATE TABLE IF NOT EXISTS validator_discoveries (
    identity TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    connection TEXT,
    online INTEGER DEFAULT 1
  )`);

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
  // Resolve any stale chain incidents from previous session on startup
  try {
    if (sharedDb) {
      var staleCount = sharedDb.run("UPDATE incidents SET status='resolved', resolved_at=datetime('now') WHERE status='active' AND affected_nodes LIKE '%CHAIN%'").changes;
      if (staleCount > 0) log("  Startup: resolved " + staleCount + " stale chain incident(s) from previous session");
    }
  } catch(e) { log("  Startup cleanup error: " + e.message); }
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
