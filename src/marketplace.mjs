/**
 * SuperColony Fleet Oracle — On-Chain Health Data Marketplace (v6.0 → v6.2)
 *
 * Drop into src/ alongside agent.mjs.
 * See apply-marketplace-patch.sh for integration.
 *
 * v6.2 fixes: shared DB handle (BUG 3), payment bypass removed (BUG 2),
 *             txHash from publish (BUG 4), hourly rate limit persistence (BUG 10)
 */

// FIX BUG 3: REMOVED — import { Database } from "bun:sqlite";
// DB handle now passed via deps.db from agent.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Config
// ============================================================================

const QUERY_TYPES = {
  fleet_status:   { fee: 1, description: "Full DAHR-attested fleet health snapshot" },
  node_report:    { fee: 1, description: "Single node history + reputation breakdown" },
  reputation_all: { fee: 1, description: "All nodes ranked with score breakdown" },
  prediction:     { fee: 1, description: "Degradation risk forecast (next 24h)" },
  custom_range:   { fee: 1, description: "Historical data for a date range" },
};

const MAX_RESPONSES_PER_DAY  = 8;
const MAX_RESPONSES_PER_HOUR = 3;
const MARKETPLACE_PROTOCOL   = "FLEET_ORACLE_MARKETPLACE";
const MARKETPLACE_VERSION    = "1.0";
const API_BASE               = "https://www.supercolony.ai";
const TOKEN_FILE             = ".supercolony-marketplace-token.json";

// ============================================================================
// State
// ============================================================================

let db = null;
let deps = null;
let hourlyResponseTimestamps = [];
let cachedToken = null;

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queries (
  tx_hash         TEXT PRIMARY KEY,
  requester       TEXT NOT NULL,
  query_type      TEXT NOT NULL,
  params          TEXT,
  tip_post_tx     TEXT,
  tip_verified    INTEGER DEFAULT 0,
  tip_amount      REAL DEFAULT 0,
  status          TEXT DEFAULT 'pending',
  response_tx     TEXT,
  fee_required    REAL NOT NULL,
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS daily_stats (
  date            TEXT PRIMARY KEY,
  responses_count INTEGER DEFAULT 0,
  total_dem       REAL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_queries_status  ON queries(status);
CREATE INDEX IF NOT EXISTS idx_queries_created ON queries(created_at DESC);
`;

// ============================================================================
// Internal: Auth (self-managed challenge/sign/verify)
// ============================================================================

function loadTokenFromDisk() {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    var saved = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    if (Date.now() > saved.expiresAt - 3600000) return null;
    return saved;
  } catch { return null; }
}

function saveTokenToDisk(token, expiresAt) {
  try { writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiresAt })); }
  catch { /* non-fatal */ }
}

async function getAuthHeaders() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 3600000) {
    return { Authorization: "Bearer " + cachedToken.token };
  }

  var diskToken = loadTokenFromDisk();
  if (diskToken) {
    cachedToken = diskToken;
    return { Authorization: "Bearer " + diskToken.token };
  }

  var demos = deps.demos;
  var address = deps.address;
  deps.log("[marketplace-auth] authenticating with Demos wallet…");

  var challengeRes = await fetchWithTimeout(
    API_BASE + "/api/auth/challenge?address=" + address, {}, 10000
  );
  if (!challengeRes.ok) throw new Error("Auth challenge failed: " + challengeRes.status);
  var challengeData = await challengeRes.json();

  var sig = await demos.signMessage(challengeData.message);

  var verifyRes = await fetchWithTimeout(API_BASE + "/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: address,
      challenge: challengeData.challenge,
      signature: sig.data,
      algorithm: sig.type || "ed25519",
    }),
  }, 10000);
  if (!verifyRes.ok) throw new Error("Auth verify failed: " + verifyRes.status);
  var verifyData = await verifyRes.json();

  cachedToken = { token: verifyData.token, expiresAt: verifyData.expiresAt };
  saveTokenToDisk(verifyData.token, verifyData.expiresAt);
  deps.log("[marketplace-auth] token acquired — expires " + new Date(verifyData.expiresAt).toISOString());
  return { Authorization: "Bearer " + cachedToken.token };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize marketplace. Call once after SDK + wallet are connected.
 *
 * @param {Object} d
 * @param {Object} d.demos           - Connected Demos SDK instance
 * @param {string} d.address         - demos.getAddress() result
 * @param {Object} d.db              - Shared bun:sqlite Database handle (FIX BUG 3)
 * @param {Function} d.getFleetData  - () => latestHealthData
 * @param {Function} d.getHistory    - () => history array
 * @param {Function} d.getRepScores  - () => calculateReputationScores() result
 * @param {Function} d.detectTrends  - () => detectTrends() result
 * @param {Function} d.publish       - async (demos, post, attestations) => txHash|false
 * @param {Function} d.dahrAttest    - async (demos, url, method) => attestation|null
 * @param {Function} d.sendTelegram  - async (msg) => void
 * @param {Function} d.log           - (msg) => void
 * @param {string}   d.dataDir       - "logs"
 * @param {Function} d.canPublish    - () => { ok, hourly, daily } (FIX BUG 6)
 */
export function initMarketplace(d) {
  deps = d;

  // FIX BUG 3: Use shared DB handle from agent.mjs instead of opening our own
  if (!d.db) throw new Error("Marketplace requires shared db handle in deps");
  db = d.db;

  // Schema is idempotent — safe to run on shared handle
  db.exec(SCHEMA);

  // FIX BUG 10: Load hourly rate limit state from DB (survives restarts)
  try {
    var oneHourAgo = Date.now() - 3600000;
    var recentFulfilled = db.prepare(
      "SELECT processed_at FROM queries WHERE status = 'fulfilled' AND processed_at > ?"
    ).all(oneHourAgo);
    hourlyResponseTimestamps = recentFulfilled.map(function(r) { return r.processed_at; });
    if (hourlyResponseTimestamps.length > 0) {
      deps.log("[marketplace] restored " + hourlyResponseTimestamps.length + " hourly rate limit entries from DB");
    }
  } catch (e) {
    hourlyResponseTimestamps = [];
  }

  deps.log("[marketplace] initialized — using shared db");
  deps.log("[marketplace] query types: " + Object.keys(QUERY_TYPES).join(", "));
}

/** Poll + process. Call once per cycle. */
export async function pollAndProcessQueries() {
  if (!db || !deps) throw new Error("Marketplace not initialized");
  var result = { queriesFound: 0, queriesProcessed: 0, errors: [] };

  try {
    var newQueries = await discoverQueries();
    result.queriesFound = newQueries.length;
    if (newQueries.length > 0) {
      deps.log("[marketplace] found " + newQueries.length + " new quer" + (newQueries.length === 1 ? "y" : "ies"));
    }

    var pending = db.prepare("SELECT * FROM queries WHERE status = 'pending' ORDER BY created_at ASC").all();
    if (pending.length === 0) return result;

    if (!canPublishToday()) {
      deps.log("[marketplace] daily limit (" + MAX_RESPONSES_PER_DAY + ") reached — deferring");
      return result;
    }

    var batch = pending.slice(0, 3);
    for (var i = 0; i < batch.length; i++) {
      if (!canPublishThisHour()) {
        deps.log("[marketplace] hourly limit reached — deferring remaining");
        break;
      }
      // FIX BUG 6: Check shared write budget before processing
      if (deps.canPublish && !deps.canPublish().ok) {
        deps.log("[marketplace] global write budget exceeded — deferring remaining");
        break;
      }
      try {
        await processQuery(batch[i]);
        result.queriesProcessed++;
      } catch (err) {
        var msg = err && err.message ? err.message : String(err);
        deps.log("[marketplace] error processing " + batch[i].tx_hash + ": " + msg);
        result.errors.push({ txHash: batch[i].tx_hash, error: msg });
        db.prepare("UPDATE queries SET status = 'failed', error = ?, processed_at = ? WHERE tx_hash = ?").run(msg, Date.now(), batch[i].tx_hash);
      }
    }
  } catch (err) {
    deps.log("[marketplace] poll error: " + (err && err.message ? err.message : err));
    result.errors.push({ txHash: null, error: String(err && err.message ? err.message : err) });
  }
  return result;
}

/** Stats for /marketplace endpoint. */
export function getMarketplaceStats() {
  if (!db) return { error: "Marketplace not initialized" };
  var totals = db.prepare(
    "SELECT COUNT(*) as total_queries, " +
    "SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as fulfilled, " +
    "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending, " +
    "SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected, " +
    "SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed, " +
    "SUM(CASE WHEN status = 'fulfilled' THEN tip_amount ELSE 0 END) as total_dem_earned " +
    "FROM queries"
  ).get();

  var todayStr = new Date().toISOString().slice(0, 10);
  var todayRow = db.prepare("SELECT responses_count, total_dem FROM daily_stats WHERE date = ?").get(todayStr);

  return {
    protocol: MARKETPLACE_PROTOCOL, version: MARKETPLACE_VERSION,
    queryTypes: QUERY_TYPES,
    stats: {
      totalQueries: totals.total_queries, fulfilled: totals.fulfilled,
      pending: totals.pending, rejected: totals.rejected, failed: totals.failed,
      totalDemEarned: totals.total_dem_earned || 0,
    },
    today: {
      responsesPublished: todayRow ? todayRow.responses_count : 0,
      demEarned: todayRow ? todayRow.total_dem : 0,
      responsesRemaining: MAX_RESPONSES_PER_DAY - (todayRow ? todayRow.responses_count : 0),
    },
    limits: { maxPerDay: MAX_RESPONSES_PER_DAY, maxPerHour: MAX_RESPONSES_PER_HOUR },
    oracleAddress: deps ? deps.address : null,
  };
}

/** Recent queries for /marketplace/queries endpoint. */
export function getRecentQueries(limit) {
  if (!db) return { error: "Marketplace not initialized" };
  limit = Math.min(limit || 20, 100);
  var rows = db.prepare("SELECT * FROM queries ORDER BY created_at DESC LIMIT ?").all(limit);
  return {
    queries: rows.map(function(r) {
      return {
        txHash: r.tx_hash, requester: r.requester, queryType: r.query_type,
        params: r.params ? JSON.parse(r.params) : null,
        status: r.status, feeRequired: r.fee_required, feePaid: r.tip_amount,
        responseTx: r.response_tx, createdAt: r.created_at,
        processedAt: r.processed_at, error: r.error,
      };
    }),
    count: rows.length,
  };
}

/** Close DB on shutdown — FIX BUG 3: no longer closes DB, agent.mjs owns the handle */
export function shutdownMarketplace() {
  // DB is now owned by agent.mjs — don't close it here
  if (deps) deps.log("[marketplace] shutdown complete (db owned by agent)");
}

// ============================================================================
// Internal: Query Discovery
// ============================================================================

async function discoverQueries() {
  var headers;
  try { headers = await getAuthHeaders(); }
  catch (err) {
    deps.log("[marketplace] auth failed during discovery: " + (err.message || err));
    return [];
  }

  var url = API_BASE + "/api/feed/search?mentions=" + deps.address + "&category=QUESTION&limit=20";
  var res;
  try { res = await fetchWithTimeout(url, { headers: headers }, 10000); }
  catch (err) {
    deps.log("[marketplace] feed search request failed: " + (err.message || err));
    return [];
  }

  if (!res.ok) {
    deps.log("[marketplace] feed search returned " + res.status);
    if (res.status === 401) cachedToken = null;
    return [];
  }

  var body = await res.json();
  var posts = body.posts || [];
  var newQueries = [];

  for (var i = 0; i < posts.length; i++) {
    var post = posts[i];
    var payload = post.payload || {};
    var innerPayload = payload.payload || payload;

    if (innerPayload.protocol !== MARKETPLACE_PROTOCOL) continue;

    var existing = db.prepare("SELECT tx_hash FROM queries WHERE tx_hash = ?").get(post.txHash);
    if (existing) continue;

    var queryType = innerPayload.queryType;
    if (!queryType || !QUERY_TYPES[queryType]) {
      deps.log("[marketplace] unknown queryType \"" + queryType + "\" from " + post.author + " — skipping");
      continue;
    }

    var fee = QUERY_TYPES[queryType].fee;
    var params = innerPayload.params || null;
    var tipPostTx = innerPayload.tipPostTxHash || null;

    db.prepare(
      "INSERT INTO queries (tx_hash, requester, query_type, params, tip_post_tx, fee_required, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(post.txHash, post.author, queryType, params ? JSON.stringify(params) : null, tipPostTx, fee, post.timestamp || Date.now());

    newQueries.push({ txHash: post.txHash, queryType: queryType, requester: post.author });
    deps.log("[marketplace] new query: " + queryType + " from " + post.author.slice(0, 12) + "…");
  }
  return newQueries;
}

// ============================================================================
// Internal: Query Processing
// ============================================================================

async function processQuery(query) {
  deps.log("[marketplace] processing: " + query.query_type + " from " + query.requester.slice(0, 12) + "…");
  db.prepare("UPDATE queries SET status = 'processing' WHERE tx_hash = ?").run(query.tx_hash);

  // 1. Verify payment
  var tipVerified = await verifyPayment(query);
  if (!tipVerified.ok) {
    deps.log("[marketplace] payment not verified: " + tipVerified.reason);
    await publishPaymentInstructions(query, tipVerified.reason);
    db.prepare("UPDATE queries SET status = 'rejected', error = ?, processed_at = ? WHERE tx_hash = ?")
      .run("Payment: " + tipVerified.reason, Date.now(), query.tx_hash);
    return;
  }

  db.prepare("UPDATE queries SET tip_verified = 1, tip_amount = ? WHERE tx_hash = ?")
    .run(tipVerified.amount, query.tx_hash);

  // 2. Generate response
  var responseData = generateResponse(query);

  // 3. DAHR-attest public RPCs
  var attestations = [];
  try {
    var urls = ["https://demosnode.discus.sh/info", "https://node2.demos.sh/info"];
    for (var i = 0; i < urls.length; i++) {
      var att = await deps.dahrAttest(deps.demos, urls[i], "GET");
      if (att) attestations.push(att);
    }
  } catch (err) {
    deps.log("[marketplace] DAHR failed (non-fatal): " + (err.message || err));
  }

  // 4. Publish on-chain
  var responsePost = {
    cat: "ANALYSIS",
    text: responseData.summary,
    confidence: responseData.confidence || 90,
    replyTo: query.tx_hash,
    tags: ["marketplace", "fleet-oracle", query.query_type],
    payload: {
      protocol: MARKETPLACE_PROTOCOL, version: MARKETPLACE_VERSION,
      queryType: query.query_type, requester: query.requester,
      data: responseData.data, generatedAt: Date.now(),
    },
  };

  var publishResult = await deps.publish(deps.demos, responsePost, attestations);
  if (!publishResult) throw new Error("Publish failed — all retries exhausted or budget exceeded");

  // 5. Update DB
  // FIX BUG 4: Store actual txHash from publish() instead of hardcoded "published"
  var responseTxHash = (typeof publishResult === "string") ? publishResult : "published";
  var now = Date.now();
  db.prepare("UPDATE queries SET status = 'fulfilled', response_tx = ?, processed_at = ? WHERE tx_hash = ?")
    .run(responseTxHash, now, query.tx_hash);

  var todayStr = new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO daily_stats (date, responses_count, total_dem) VALUES (?, 1, ?) " +
    "ON CONFLICT(date) DO UPDATE SET responses_count = responses_count + 1, total_dem = total_dem + excluded.total_dem"
  ).run(todayStr, tipVerified.amount);
  hourlyResponseTimestamps.push(now);

  // 6. Telegram
  try {
    await deps.sendTelegram(
      "💰 <b>MARKETPLACE</b>\nQuery: " + query.query_type +
      "\nFrom: " + query.requester.slice(0, 16) + "…" +
      "\nFee: " + tipVerified.amount + " DEM" +
      "\nAttestations: " + attestations.length +
      "\nTX: " + responseTxHash
    );
  } catch { /* non-fatal */ }

  deps.log("[marketplace] fulfilled: " + query.query_type + " tx=" + responseTxHash);
}

// ============================================================================
// Internal: Payment Verification
// ============================================================================

async function verifyPayment(query) {
  var headers;
  try { headers = await getAuthHeaders(); }
  catch { return { ok: false, reason: "Auth failed during payment check", amount: 0 }; }

  // FIX BUG 2: REMOVED aggregate tip fallback.
  // Previously: if no tipPostTxHash, checked if agent had ANY tips globally.
  // Once any tip arrived from any source, all future queries were served free.
  // Now: always require tipPostTxHash. No exceptions.
  if (!query.tip_post_tx) {
    return { ok: false, reason: "No payment reference. Tip any Fleet Oracle post with " + query.fee_required + "+ DEM, include tipPostTxHash in payload.", amount: 0 };
  }

  try {
    var res = await fetchWithTimeout(API_BASE + "/api/tip/" + query.tip_post_tx, { headers: headers }, 10000);
    if (!res.ok) return { ok: false, reason: "Tip lookup failed (" + res.status + ")", amount: 0 };

    var tipData = await res.json();
    var tippers = tipData.tippers || [];
    if (tippers.indexOf(query.requester) === -1) {
      return { ok: false, reason: "Your address not found in tippers for " + query.tip_post_tx.slice(0, 12) + "…", amount: 0 };
    }

    var usedBefore = db.prepare("SELECT tx_hash FROM queries WHERE tip_post_tx = ? AND status = 'fulfilled' AND tx_hash != ?")
      .get(query.tip_post_tx, query.tx_hash);
    if (usedBefore) return { ok: false, reason: "Tip already consumed by a prior query", amount: 0 };

    var totalDem = tipData.totalDem || 0;
    if (totalDem < query.fee_required) {
      return { ok: false, reason: "Insufficient: " + totalDem + " DEM (need " + query.fee_required + ")", amount: totalDem };
    }
    return { ok: true, amount: totalDem, method: "tip_verified" };
  } catch (err) {
    return { ok: false, reason: "Tip check error: " + (err.message || err), amount: 0 };
  }
}

// ============================================================================
// Internal: Response Generation
// ============================================================================

function generateResponse(query) {
  var params = query.params ? JSON.parse(query.params) : {};
  switch (query.query_type) {
    case "fleet_status":   return generateFleetStatus();
    case "node_report":    return generateNodeReport(params);
    case "reputation_all": return generateReputationAll();
    case "prediction":     return generatePrediction();
    case "custom_range":   return generateCustomRange(params);
    default: throw new Error("Unknown query type: " + query.query_type);
  }
}

function generateFleetStatus() {
  var fleet = deps.getFleetData();
  if (!fleet) throw new Error("No fleet data — agent may still be initializing");
  var repScores = deps.getRepScores();
  var nodeReports = fleet.nodeReports || [];
  var chain = fleet.chain || {};
  var onlineCount = nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length;

  return {
    summary: "Fleet Oracle Marketplace — FLEET STATUS | " + onlineCount + "/7 online | Block: " + (chain.block || "?") + " | TPS: " + (chain.tps != null ? chain.tps : "?") + " | DAHR-attested",
    confidence: 95,
    data: {
      type: "fleet_status", timestamp: Date.now(),
      fleet: { nodesOnline: onlineCount, nodesTotal: 7, blockHeight: chain.block || null, tps: chain.tps != null ? chain.tps : null, mempoolSize: chain.mempoolSize || 0, secondsSinceLastBlock: chain.secondsSinceLastBlock || 0 },
      nodes: nodeReports, reputation: repScores,
    },
  };
}

function generateNodeReport(params) {
  var nodeId = params.node || params.nodeId;
  if (!nodeId) throw new Error("Missing param: node (e.g. 'n1')");
  var fleet = deps.getFleetData();
  if (!fleet) throw new Error("No fleet data");
  var nodeReports = fleet.nodeReports || [];
  var node = null;
  for (var i = 0; i < nodeReports.length; i++) {
    if (nodeReports[i].name === nodeId || nodeReports[i].identity === nodeId) { node = nodeReports[i]; break; }
  }
  if (!node) throw new Error("Node \"" + nodeId + "\" not found");
  var repScores = deps.getRepScores();
  var nodeRep = null;
  if (Array.isArray(repScores)) {
    for (var j = 0; j < repScores.length; j++) {
      if (repScores[j].name === nodeId) { nodeRep = repScores[j]; break; }
    }
  }
  return {
    summary: "Fleet Oracle Marketplace — NODE REPORT: " + nodeId + " | " + (node.status || "?") + " | Rep: " + (nodeRep ? nodeRep.score : "N/A") + "/100 | DAHR-attested",
    confidence: 95,
    data: { type: "node_report", timestamp: Date.now(), node: node, reputation: nodeRep, recentHistory: deps.getHistory().slice(-72) },
  };
}

function generateReputationAll() {
  var repScores = deps.getRepScores();
  if (!repScores || (Array.isArray(repScores) && repScores.length === 0)) throw new Error("No reputation data");
  var sorted = Array.isArray(repScores) ? repScores.slice().sort(function(a, b) { return (b.score || 0) - (a.score || 0); }) : repScores;
  var topName = Array.isArray(sorted) && sorted[0] ? sorted[0].name || "?" : "?";
  var topScore = Array.isArray(sorted) && sorted[0] ? sorted[0].score || "?" : "?";
  return {
    summary: "Fleet Oracle Marketplace — REPUTATION | Top: " + topName + " (" + topScore + "/100) | " + (Array.isArray(sorted) ? sorted.length : "?") + " nodes | DAHR-attested",
    confidence: 90,
    data: { type: "reputation_all", timestamp: Date.now(), rankings: sorted },
  };
}

function generatePrediction() {
  var trends = deps.detectTrends();
  var hist = deps.getHistory();
  var recent = hist.slice(-18);
  var riskScore = 0;
  var riskFactors = [];
  if (trends && trends.length > 0) {
    riskScore += 20 * trends.length;
    for (var i = 0; i < trends.length; i++) {
      riskFactors.push(typeof trends[i] === "string" ? trends[i] : (trends[i].description || "degradation"));
    }
  }
  if (recent.length >= 6) {
    var r3 = recent.slice(-3), o3 = recent.slice(-6, -3);
    var rAvg = avg(r3.map(function(h) { return h.nodes ? Object.keys(h.nodes).filter(function(k) { return h.nodes[k] && h.nodes[k].healthy; }).length : 0; }));
    var oAvg = avg(o3.map(function(h) { return h.nodes ? Object.keys(h.nodes).filter(function(k) { return h.nodes[k] && h.nodes[k].healthy; }).length : 0; }));
    if (rAvg < oAvg) { riskScore += 15; riskFactors.push("Online declining: " + oAvg.toFixed(1) + " → " + rAvg.toFixed(1)); }
  }
  riskScore = Math.min(riskScore, 100);
  var riskLevel = riskScore > 60 ? "HIGH" : riskScore > 30 ? "MODERATE" : "LOW";
  return {
    summary: "Fleet Oracle Marketplace — 24H PREDICTION | Risk: " + riskLevel + " (" + riskScore + "/100) | " + riskFactors.length + " factors | DAHR-attested",
    confidence: Math.max(50, 90 - riskScore),
    data: { type: "prediction", timestamp: Date.now(), riskScore: riskScore, riskLevel: riskLevel, riskFactors: riskFactors,
      forecast: { period: "24h", nodesAtRisk: (trends || []).map(function(t) { return typeof t === "string" ? t : (t.node || t.name); }).filter(Boolean),
        recommendation: riskScore > 60 ? "Elevated risk" : riskScore > 30 ? "Moderate risk" : "Low risk — fleet stable" } },
  };
}

function generateCustomRange(params) {
  var from = Number(params.from), to = Number(params.to);
  if (!from || !to) throw new Error("Missing params: from, to (Unix ms)");
  var hist = deps.getHistory();
  var filtered = hist.filter(function(h) { return h.ts >= from && h.ts <= to; });
  if (filtered.length === 0) throw new Error("No data for range");
  return {
    summary: "Fleet Oracle Marketplace — CUSTOM RANGE | " + filtered.length + " points | " + new Date(from).toISOString().slice(0, 10) + " to " + new Date(to).toISOString().slice(0, 10) + " | DAHR-attested",
    confidence: 95,
    data: { type: "custom_range", timestamp: Date.now(), from: from, to: to, dataPoints: filtered, count: filtered.length },
  };
}

// ============================================================================
// Internal: Payment Instructions Reply
// ============================================================================

async function publishPaymentInstructions(query, reason) {
  try {
    var fee = QUERY_TYPES[query.query_type] ? QUERY_TYPES[query.query_type].fee : 2;
    await deps.publish(deps.demos, {
      cat: "OBSERVATION",
      text: "Fleet Oracle Marketplace — Payment Required\nQuery: " + query.query_type + " (" + fee + " DEM)\n" + reason +
        "\n\nTip any Fleet Oracle post with " + fee + "+ DEM, then post QUESTION mentioning " + deps.address +
        " with { protocol: \"" + MARKETPLACE_PROTOCOL + "\", queryType: \"" + query.query_type + "\", tipPostTxHash: \"<tx>\" }",
      confidence: 100, replyTo: query.tx_hash,
    }, []);
  } catch (err) {
    deps.log("[marketplace] payment instructions publish failed: " + (err.message || err));
  }
}

// ============================================================================
// Rate Limiting
// ============================================================================

function canPublishToday() {
  var todayStr = new Date().toISOString().slice(0, 10);
  var row = db.prepare("SELECT responses_count FROM daily_stats WHERE date = ?").get(todayStr);
  return (row ? row.responses_count : 0) < MAX_RESPONSES_PER_DAY;
}

function canPublishThisHour() {
  var oneHourAgo = Date.now() - 3600000;
  hourlyResponseTimestamps = hourlyResponseTimestamps.filter(function(t) { return t > oneHourAgo; });
  return hourlyResponseTimestamps.length < MAX_RESPONSES_PER_HOUR;
}

// ============================================================================
// Helpers
// ============================================================================

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try { return await fetch(url, Object.assign({}, opts, { signal: controller.signal })); }
  finally { clearTimeout(timer); }
}
