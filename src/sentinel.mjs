import { readFileSync, writeFileSync, existsSync } from "fs";

const HEALTH_URL = process.env.SENTINEL_HEALTH_URL || "http://127.0.0.1:55225";
// Fleet history is served on the agent's loopback internal listener when INTERNAL_PORT is set (404 on the public port).
const HISTORY_URL = process.env.SENTINEL_HISTORY_URL || (process.env.INTERNAL_PORT ? "http://127.0.0.1:" + process.env.INTERNAL_PORT : HEALTH_URL);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEDUP_FILE = "/tmp/sentinel-dedup.json";
const DEDUP_TTL_MS = 60 * 60 * 1000;
const BLOCK_STALL_CYCLES = 3;
const LAG_THRESHOLD = 10;
const LAG_TREND_CYCLES = 3;
const FLAP_WINDOW = 6;
const FLAP_MIN = 3;
const ONLINE_DROP_THRESHOLD = 2;

function log(msg) { console.log("[" + new Date().toISOString() + "] [SENTINEL] " + msg); }

function loadDedup() {
  try { if (existsSync(DEDUP_FILE)) return JSON.parse(readFileSync(DEDUP_FILE, "utf8")); } catch(e) {}
  return {};
}

function saveDedup(d) { try { writeFileSync(DEDUP_FILE, JSON.stringify(d)); } catch(e) {} }

function shouldAlert(key) {
  var dedup = loadDedup();
  var now = Date.now();
  if (dedup[key] && now - dedup[key] < DEDUP_TTL_MS) return false;
  dedup[key] = now;
  saveDedup(dedup);
  return true;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
  } catch(e) { log("Telegram error: " + e.message); }
}

async function fetchHealth() {
  var r = await fetch(HEALTH_URL + "/health", { signal: AbortSignal.timeout(8000) });
  return r.json();
}

async function fetchHistory() {
  var r = await fetch(HISTORY_URL + "/history", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("history answered HTTP " + r.status + " at " + HISTORY_URL + " (set SENTINEL_HISTORY_URL or INTERNAL_PORT)");
  var d = await r.json();
  return d.data || [];
}

function detectBlockStall(history) {
  var alerts = [];
  if (history.length < BLOCK_STALL_CYCLES) return alerts;
  var recent = history.slice(-BLOCK_STALL_CYCLES);
  var nodeNames = Object.keys(recent[0].nodes || {});
  for (var name of nodeNames) {
    var blocks = recent.map(function(h) { return h.nodes[name] ? h.nodes[name].block : null; }).filter(Boolean);
    if (blocks.length < BLOCK_STALL_CYCLES) continue;
    if (blocks.every(function(b) { return b === blocks[0]; })) {
      var key = "stall_" + name + "_" + blocks[0];
      if (shouldAlert(key)) alerts.push("stall|" + name + "|" + blocks[0]);
    }
  }
  return alerts;
}

function detectPersistentLag(history) {
  var alerts = [];
  if (history.length < LAG_TREND_CYCLES) return alerts;
  var recent = history.slice(-LAG_TREND_CYCLES);
  var nodeNames = Object.keys(recent[0].nodes || {});
  for (var name of nodeNames) {
    var lags = [];
    for (var h of recent) {
      var maxBlock = Math.max.apply(null, Object.values(h.nodes).map(function(n) { return n.block || 0; }));
      var nodeBlock = h.nodes[name] ? h.nodes[name].block : null;
      if (nodeBlock && maxBlock) lags.push(maxBlock - nodeBlock);
    }
    if (lags.length < LAG_TREND_CYCLES) continue;
    if (lags.every(function(l) { return l >= LAG_THRESHOLD; }) && lags[lags.length-1] > lags[0]) {
      var key = "lag_" + name + "_" + Math.round(lags[lags.length-1] / 10) * 10;
      if (shouldAlert(key)) alerts.push("lag|" + name + "|" + lags.join(","));
    }
  }
  return alerts;
}

function detectFlapping(history) {
  var alerts = [];
  if (history.length < FLAP_WINDOW) return alerts;
  var recent = history.slice(-FLAP_WINDOW);
  var nodeNames = Object.keys(recent[0].nodes || {});
  for (var name of nodeNames) {
    var states = recent.map(function(h) { return h.nodes[name] ? h.nodes[name].healthy : null; }).filter(function(s) { return s !== null; });
    var changes = 0;
    for (var i = 1; i < states.length; i++) { if (states[i] !== states[i-1]) changes++; }
    if (changes >= FLAP_MIN) {
      var key = "flap_" + name + "_" + changes;
      if (shouldAlert(key)) alerts.push("flap|" + name + "|" + changes);
    }
  }
  return alerts;
}

function detectOnlineDrop(history) {
  var alerts = [];
  if (history.length < 2) return alerts;
  var prev = history[history.length - 2];
  var curr = history[history.length - 1];
  var drop = (prev.onlineCount || 0) - (curr.onlineCount || 0);
  if (drop >= ONLINE_DROP_THRESHOLD) {
    var key = "drop_" + curr.onlineCount + "_" + curr.block;
    if (shouldAlert(key)) alerts.push("drop|" + prev.onlineCount + "|" + curr.onlineCount);
  }
  return alerts;
}

function detectFleetDivergence(history) {
  var alerts = [];
  if (history.length < 1) return alerts;
  var curr = history[history.length - 1];
  var blocks = Object.values(curr.nodes).map(function(n) { return n.block; }).filter(Boolean);
  if (blocks.length < 3) return alerts;
  var spread = Math.max.apply(null, blocks) - Math.min.apply(null, blocks);
  if (spread > 50) {
    var key = "diverge_" + Math.round(spread / 20) * 20;
    if (shouldAlert(key)) alerts.push("diverge|" + spread);
  }
  return alerts;
}

function formatAlert(raw) {
  var parts = raw.split("|");
  var type = parts[0];
  if (type === "stall") return "🛡️ <b>SENTINEL — Block Stall</b>\nNode <b>" + parts[1] + "</b> stuck at block " + parts[2] + " for " + BLOCK_STALL_CYCLES + "+ cycles (" + (BLOCK_STALL_CYCLES * 20) + "+ min)";
  if (type === "lag") return "🛡️ <b>SENTINEL — Persistent Lag</b>\nNode <b>" + parts[1] + "</b> consistently behind and growing: " + parts[2].split(",").join(" → ") + " blocks behind";
  if (type === "flap") return "🛡️ <b>SENTINEL — Node Flapping</b>\nNode <b>" + parts[1] + "</b> changed health state " + parts[2] + " times in last " + FLAP_WINDOW + " cycles";
  if (type === "drop") return "🛡️ <b>SENTINEL — Online Count Drop</b>\nFleet dropped from <b>" + parts[1] + "</b> to <b>" + parts[2] + "</b> nodes online";
  if (type === "diverge") return "🛡️ <b>SENTINEL — Fleet Divergence</b>\nBlock spread across fleet is <b>" + parts[1] + " blocks</b>. Possible fork or sync issue.";
  return raw;
}

async function runSentinel() {
  log("Cycle starting...");
  try {
    var history = await fetchHistory();
    var health = await fetchHealth();
    log("  History: " + history.length + " pts | Fleet: " + (health.fleet ? health.fleet.healthy : "?") + "/" + (health.fleet ? health.fleet.size : "?") + " healthy | Block: " + (health.fleet ? health.fleet.block : "?"));
    var rawAlerts = [
      ...detectBlockStall(history),
      ...detectPersistentLag(history),
      ...detectFlapping(history),
      ...detectOnlineDrop(history),
      ...detectFleetDivergence(history),
    ];
    if (rawAlerts.length > 0) {
      log("  " + rawAlerts.length + " alert(s)");
      for (var raw of rawAlerts) {
        var msg = formatAlert(raw);
        log("  >> " + raw);
        await sendTelegram(msg);
      }
    } else {
      log("  Clean — no anomalies");
    }
    // The agent's /sentinel reports "ok" only while this stamp is recent.
    var stamp = loadDedup(); stamp._lastCheck = Date.now(); saveDedup(stamp);
  } catch(e) { log("Cycle error: " + e.message); }
}

log("Starting — poll every " + (POLL_INTERVAL_MS/60000) + " min");
log("Health source: " + HEALTH_URL);
await runSentinel();
setInterval(runSentinel, POLL_INTERVAL_MS);
