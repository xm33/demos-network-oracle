/**
 * SuperColony Fleet Oracle — Multi-Agent Consensus Oracle (v6.1 → v6.2)
 *
 * Drop into src/ alongside agent.mjs and marketplace.mjs.
 * Shares marketplace.db (bun:sqlite) and auth token file.
 *
 * v6.2 fixes: shared DB handle (BUG 3), flag file for announcement (BUG 5),
 *             shared write budget check (BUG 6)
 *
 * Other agents post OBSERVATION or ANALYSIS mentioning Fleet Oracle
 * with protocol: "FLEET_ORACLE_CONSENSUS". This module collects them,
 * weighs by reporter reputation + time decay, and publishes consensus SIGNALs.
 */

// FIX BUG 3: REMOVED — import { Database } from "bun:sqlite";
// DB handle now passed via deps.db from agent.mjs
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Config
// ============================================================================

var CONSENSUS_PROTOCOL = "FLEET_ORACLE_CONSENSUS";
var CONSENSUS_VERSION  = "1.0";
var API_BASE           = "https://www.supercolony.ai";

var MIN_REPORTERS_FOR_CONSENSUS = 3;   // need 3+ distinct reporters to publish
var CONSENSUS_MAX_AGE_MS = 86400000;   // 24h — publish daily if any reports exist
var DEFAULT_WEIGHT = 10;               // weight for unknown reporters (0-100)
var TIME_DECAY_HALF_LIFE_H = 12;      // report loses half its weight every 12h
var DISAGREEMENT_THRESHOLD = 50;       // agreement < 50% triggers ALERT
var LEADERBOARD_CACHE_TTL_MS = 300000; // 5 min

// FIX BUG 5: Flag file name for announcement tracking
var ANNOUNCEMENT_FLAG_FILE = ".consensus-announced";

// ============================================================================
// State
// ============================================================================

var db = null;
var deps = null;
var lastConsensusAt = 0;
var leaderboardCache = null;
var leaderboardCacheTime = 0;
var announcementDone = false;

// Shared auth — reads from marketplace's token file, only does own auth as fallback
var TOKEN_FILE = ".supercolony-marketplace-token.json";
var cachedToken = null;

// ============================================================================
// Schema
// ============================================================================

var SCHEMA = `
CREATE TABLE IF NOT EXISTS consensus_reports (
  tx_hash         TEXT PRIMARY KEY,
  reporter        TEXT NOT NULL,
  report_type     TEXT NOT NULL,
  nodes_reachable INTEGER,
  block_height    INTEGER,
  latency_ms      REAL,
  issues          TEXT,
  raw_data        TEXT,
  reporter_weight REAL DEFAULT 10,
  time_weight     REAL DEFAULT 1.0,
  consumed        INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consensus_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reporters_count INTEGER NOT NULL,
  consensus_data  TEXT NOT NULL,
  agreement_score REAL NOT NULL,
  signal_tx       TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_con_reports_consumed ON consensus_reports(consumed);
CREATE INDEX IF NOT EXISTS idx_con_reports_reporter ON consensus_reports(reporter);
CREATE INDEX IF NOT EXISTS idx_con_history_created ON consensus_history(created_at DESC);
`;

// ============================================================================
// Auth — shares token with marketplace, fallback to own auth
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
  // 1. In-memory cache
  if (cachedToken && Date.now() < cachedToken.expiresAt - 3600000) {
    return { Authorization: "Bearer " + cachedToken.token };
  }

  // 2. Disk cache (usually written by marketplace — shared)
  var diskToken = loadTokenFromDisk();
  if (diskToken) {
    cachedToken = diskToken;
    return { Authorization: "Bearer " + diskToken.token };
  }

  // 3. Fallback: own auth flow (only if marketplace hasn't authed yet)
  deps.log("[consensus-auth] marketplace token not found, authenticating…");
  var demos = deps.demos;
  var address = deps.address;

  var challengeRes = await fetchWithTimeout(
    API_BASE + "/api/auth/challenge?address=" + address, {}, 10000
  );
  if (!challengeRes.ok) throw new Error("Auth challenge failed: " + challengeRes.status);
  var cd = await challengeRes.json();
  var sig = await demos.signMessage(cd.message);
  var verifyRes = await fetchWithTimeout(API_BASE + "/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: address, challenge: cd.challenge,
      signature: sig.data, algorithm: sig.type || "ed25519",
    }),
  }, 10000);
  if (!verifyRes.ok) throw new Error("Auth verify failed: " + verifyRes.status);
  var vd = await verifyRes.json();
  cachedToken = { token: vd.token, expiresAt: vd.expiresAt };
  saveTokenToDisk(vd.token, vd.expiresAt);
  deps.log("[consensus-auth] token acquired — expires " + new Date(vd.expiresAt).toISOString());
  return { Authorization: "Bearer " + cachedToken.token };
}

// ============================================================================
// Public: Init
// ============================================================================

/**
 * Initialize consensus. Call once after marketplace init.
 * Same deps as marketplace, including shared db handle.
 */
export function initConsensus(d) {
  deps = d;

  // FIX BUG 3: Use shared DB handle from agent.mjs
  if (!d.db) throw new Error("Consensus requires shared db handle in deps");
  db = d.db;

  // Schema is idempotent — safe to run on shared handle
  db.exec(SCHEMA);

  // Load last consensus time
  var last = db.prepare(
    "SELECT created_at FROM consensus_history ORDER BY created_at DESC LIMIT 1"
  ).get();
  if (last) lastConsensusAt = last.created_at;

  // FIX BUG 5: Use flag file instead of checking consensus_history count.
  // Previously: announcementDone = (consensus_history count > 0)
  // Problem: 0 consensus ever published → count is always 0 → re-announces every restart
  // Now: flag file persists across restarts once announcement succeeds
  var flagPath = join(d.dataDir || "logs", ANNOUNCEMENT_FLAG_FILE);
  announcementDone = existsSync(flagPath);

  deps.log("[consensus] initialized — last consensus: " +
    (lastConsensusAt ? new Date(lastConsensusAt).toISOString() : "never") +
    " announcement: " + (announcementDone ? "done" : "pending"));
}

// ============================================================================
// Public: Poll + Process
// ============================================================================

/**
 * Poll for new reports and potentially publish consensus.
 * Call once per agent cycle.
 */
export async function pollAndProcessConsensus() {
  if (!db || !deps) throw new Error("Consensus not initialized");
  var result = { reportsFound: 0, consensusPublished: false, announcementPublished: false, error: null };

  try {
    // Publish announcement on first run
    if (!announcementDone) {
      // FIX BUG 6: Check shared write budget before publishing announcement
      if (deps.canPublish && !deps.canPublish().ok) {
        deps.log("[consensus] announcement deferred — write budget exceeded");
      } else {
        await publishAnnouncement();
        // announcementDone is set inside publishAnnouncement on success
        result.announcementPublished = announcementDone;
      }
    }

    // Discover new reports
    var newReports = await discoverReports();
    result.reportsFound = newReports.length;
    if (newReports.length > 0) {
      deps.log("[consensus] found " + newReports.length + " new report(s)");
    }

    // Update time decay weights on all unconsumed reports
    updateTimeWeights();

    // Check if we should publish consensus
    var unconsumed = db.prepare(
      "SELECT COUNT(DISTINCT reporter) as reporters, COUNT(*) as total FROM consensus_reports WHERE consumed = 0"
    ).get();
    var distinctReporters = unconsumed ? unconsumed.reporters : 0;
    var totalPending = unconsumed ? unconsumed.total : 0;
    var timeSinceLast = Date.now() - lastConsensusAt;

    var shouldPublish = false;
    if (distinctReporters >= MIN_REPORTERS_FOR_CONSENSUS) {
      shouldPublish = true;
      deps.log("[consensus] " + distinctReporters + " reporters (" + totalPending + " reports) — publishing");
    } else if (distinctReporters > 0 && timeSinceLast > CONSENSUS_MAX_AGE_MS) {
      shouldPublish = true;
      deps.log("[consensus] 24h elapsed with " + distinctReporters + " reporter(s) — publishing");
    }

    if (shouldPublish) {
      // FIX BUG 6: Check shared write budget before publishing consensus
      if (deps.canPublish && !deps.canPublish().ok) {
        deps.log("[consensus] consensus publish deferred — write budget exceeded");
      } else {
        await publishConsensus();
        result.consensusPublished = true;
      }
    }
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    deps.log("[consensus] error: " + msg);
    result.error = msg;
  }

  return result;
}

// ============================================================================
// Public: /consensus endpoint
// ============================================================================

export function getConsensusState() {
  if (!db) return { error: "Consensus not initialized" };

  var totalReports = db.prepare("SELECT COUNT(*) as cnt FROM consensus_reports").get();
  var unconsumed = db.prepare(
    "SELECT COUNT(*) as cnt, COUNT(DISTINCT reporter) as reporters FROM consensus_reports WHERE consumed = 0"
  ).get();
  var totalConsensus = db.prepare("SELECT COUNT(*) as cnt FROM consensus_history").get();

  // Latest consensus
  var latest = db.prepare(
    "SELECT * FROM consensus_history ORDER BY created_at DESC LIMIT 1"
  ).get();
  var latestData = latest ? safeParse(latest.consensus_data) : null;

  // Known reporters with stats
  var reporters = db.prepare(
    "SELECT reporter, COUNT(*) as reports, AVG(reporter_weight) as avg_weight, " +
    "MAX(created_at) as last_seen FROM consensus_reports GROUP BY reporter ORDER BY reports DESC LIMIT 20"
  ).all();

  return {
    protocol: CONSENSUS_PROTOCOL,
    version: CONSENSUS_VERSION,
    stats: {
      totalReportsReceived: totalReports ? totalReports.cnt : 0,
      pendingReports: unconsumed ? unconsumed.cnt : 0,
      pendingReporters: unconsumed ? unconsumed.reporters : 0,
      totalConsensusPublished: totalConsensus ? totalConsensus.cnt : 0,
      lastConsensusAt: lastConsensusAt || null,
      nextConsensusIn: lastConsensusAt
        ? Math.max(0, CONSENSUS_MAX_AGE_MS - (Date.now() - lastConsensusAt))
        : null,
    },
    latestConsensus: latestData ? {
      data: latestData,
      agreementScore: latest.agreement_score,
      reportersCount: latest.reporters_count,
      publishedAt: latest.created_at,
      signalTx: latest.signal_tx,
    } : null,
    knownReporters: reporters.map(function(r) {
      return {
        address: r.reporter,
        totalReports: r.reports,
        avgWeight: Math.round((r.avg_weight || 0) * 10) / 10,
        lastSeen: r.last_seen,
      };
    }),
    config: {
      minReportersForConsensus: MIN_REPORTERS_FOR_CONSENSUS,
      maxAgeMs: CONSENSUS_MAX_AGE_MS,
      defaultWeight: DEFAULT_WEIGHT,
      timeDecayHalfLifeH: TIME_DECAY_HALF_LIFE_H,
      disagreementThreshold: DISAGREEMENT_THRESHOLD,
    },
    howToParticipate: {
      description: "Submit health observations to contribute to fleet consensus. " +
        "Your report is weighted by your SuperColony reputation score. " +
        "Consensus is published as a SIGNAL when 3+ reporters submit, or every 24h.",
      step1: "Post an OBSERVATION or ANALYSIS mentioning Fleet Oracle",
      step2: "Include protocol: '" + CONSENSUS_PROTOCOL + "' in payload",
      examplePost: {
        v: 1,
        cat: "OBSERVATION",
        text: "Demos fleet health check — 7/7 nodes reachable",
        mentions: [deps ? deps.address : "0x..."],
        payload: {
          protocol: CONSENSUS_PROTOCOL,
          version: CONSENSUS_VERSION,
          reportType: "health_check",
          data: {
            nodesReachable: 7,
            blockHeight: 461092,
            latencyMs: 250,
            issuesDetected: [],
          },
        },
      },
      acceptedCategories: ["OBSERVATION", "ANALYSIS"],
      dataFields: {
        nodesReachable: "Number of Demos nodes you can reach (0-7)",
        blockHeight: "Latest block height you observe",
        latencyMs: "Average RPC response time in milliseconds",
        issuesDetected: "Array of issue strings (e.g. ['n4 timeout', 'high latency'])",
      },
      fee: "Free — no payment required. Consensus participation is open to all agents.",
    },
    oracleAddress: deps ? deps.address : null,
  };
}

// ============================================================================
// Internal: Report Discovery
// ============================================================================

async function discoverReports() {
  var headers;
  try { headers = await getAuthHeaders(); }
  catch (err) {
    deps.log("[consensus] auth failed: " + (err.message || err));
    return [];
  }

  // Search for OBSERVATION and ANALYSIS posts mentioning us
  // Two searches: one for each category (API doesn't support OR on category)
  var allPosts = [];
  var categories = ["OBSERVATION", "ANALYSIS"];
  for (var c = 0; c < categories.length; c++) {
    try {
      var url = API_BASE + "/api/feed/search?mentions=" + deps.address +
        "&category=" + categories[c] + "&limit=15";
      var res = await fetchWithTimeout(url, { headers: headers }, 10000);
      if (res.ok) {
        var body = await res.json();
        var posts = body.posts || [];
        for (var p = 0; p < posts.length; p++) allPosts.push(posts[p]);
      } else if (res.status === 401) {
        cachedToken = null;
      }
    } catch (err) {
      deps.log("[consensus] search " + categories[c] + " failed: " + (err.message || err));
    }
  }

  var newReports = [];

  for (var i = 0; i < allPosts.length; i++) {
    var post = allPosts[i];
    var payload = post.payload || {};
    var innerPayload = payload.payload || payload;

    // Must be consensus protocol
    if (innerPayload.protocol !== CONSENSUS_PROTOCOL) continue;

    // Skip self-reports
    if (post.author === deps.address) continue;

    // Skip duplicates (same post in both category searches)
    var existing = db.prepare("SELECT tx_hash FROM consensus_reports WHERE tx_hash = ?").get(post.txHash);
    if (existing) continue;

    var data = innerPayload.data || {};
    var reportType = innerPayload.reportType || "health_check";

    db.prepare(
      "INSERT INTO consensus_reports (tx_hash, reporter, report_type, nodes_reachable, " +
      "block_height, latency_ms, issues, raw_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      post.txHash,
      post.author,
      reportType,
      data.nodesReachable != null ? data.nodesReachable : null,
      data.blockHeight != null ? data.blockHeight : null,
      data.latencyMs != null ? data.latencyMs : null,
      data.issuesDetected ? JSON.stringify(data.issuesDetected) : null,
      JSON.stringify(data),
      post.timestamp || Date.now()
    );

    newReports.push({ txHash: post.txHash, reporter: post.author, reportType: reportType });
    deps.log("[consensus] report from " + post.author.slice(0, 12) + "… — " +
      "nodes=" + (data.nodesReachable != null ? data.nodesReachable : "?") +
      " block=" + (data.blockHeight != null ? data.blockHeight : "?"));
  }

  // Update reputation weights for new reporters
  if (newReports.length > 0) {
    var addrs = [];
    for (var k = 0; k < newReports.length; k++) {
      if (addrs.indexOf(newReports[k].reporter) === -1) addrs.push(newReports[k].reporter);
    }
    await updateReporterWeights(addrs);
  }

  return newReports;
}

// ============================================================================
// Internal: Weights — Reputation + Time Decay
// ============================================================================

async function updateReporterWeights(reporters) {
  var lb = await fetchLeaderboard();
  if (!lb) return;

  for (var i = 0; i < reporters.length; i++) {
    var addr = reporters[i];
    var entry = null;
    for (var j = 0; j < lb.length; j++) {
      if (lb[j].address === addr) { entry = lb[j]; break; }
    }
    var weight = entry ? (entry.bayesianScore || entry.avgScore || DEFAULT_WEIGHT) : DEFAULT_WEIGHT;
    weight = Math.max(1, Math.min(100, weight));

    db.prepare(
      "UPDATE consensus_reports SET reporter_weight = ? WHERE reporter = ? AND consumed = 0"
    ).run(weight, addr);
  }
}

function updateTimeWeights() {
  // Exponential decay: weight = exp(-age_h * ln(2) / half_life)
  var now = Date.now();
  var decayRate = Math.LN2 / TIME_DECAY_HALF_LIFE_H;

  var reports = db.prepare("SELECT tx_hash, created_at FROM consensus_reports WHERE consumed = 0").all();
  var stmt = db.prepare("UPDATE consensus_reports SET time_weight = ? WHERE tx_hash = ?");

  for (var i = 0; i < reports.length; i++) {
    var ageH = (now - reports[i].created_at) / 3600000;
    var tw = Math.exp(-ageH * decayRate);
    tw = Math.max(0.05, tw); // floor at 5% — very old reports still count a little
    stmt.run(tw, reports[i].tx_hash);
  }
}

async function fetchLeaderboard() {
  if (leaderboardCache && (Date.now() - leaderboardCacheTime) < LEADERBOARD_CACHE_TTL_MS) {
    return leaderboardCache;
  }
  var headers;
  try { headers = await getAuthHeaders(); }
  catch { return leaderboardCache; }
  try {
    var res = await fetchWithTimeout(API_BASE + "/api/scores/agents?limit=50", { headers: headers }, 10000);
    if (!res.ok) return leaderboardCache;
    var data = await res.json();
    leaderboardCache = data.agents || [];
    leaderboardCacheTime = Date.now();
    return leaderboardCache;
  } catch { return leaderboardCache; }
}

// ============================================================================
// Internal: Consensus Computation
// ============================================================================

function computeWeightedConsensus(reports) {
  var weightedNodes = 0, nodesW = 0;
  var weightedBlock = 0, blockW = 0;
  var weightedLatency = 0, latencyW = 0;
  var allIssues = {};
  var totalWeight = 0;

  for (var i = 0; i < reports.length; i++) {
    var r = reports[i];
    // Combined weight = reputation * time_decay
    var w = (r.reporter_weight || DEFAULT_WEIGHT) * (r.time_weight || 1.0);

    if (r.nodes_reachable != null) { weightedNodes += r.nodes_reachable * w; nodesW += w; }
    if (r.block_height != null) { weightedBlock += r.block_height * w; blockW += w; }
    if (r.latency_ms != null) { weightedLatency += r.latency_ms * w; latencyW += w; }

    // Aggregate issues with weighted vote counts
    if (r.issues) {
      var issues;
      try { issues = JSON.parse(r.issues); } catch { issues = []; }
      for (var j = 0; j < issues.length; j++) {
        var issue = issues[j];
        if (!allIssues[issue]) allIssues[issue] = { votes: 0, weight: 0, reporters: [] };
        allIssues[issue].votes++;
        allIssues[issue].weight += w;
        if (allIssues[issue].reporters.indexOf(r.reporter) === -1) {
          allIssues[issue].reporters.push(r.reporter);
        }
      }
    }
    totalWeight += w;
  }

  return {
    nodesReachable: nodesW > 0 ? weightedNodes / nodesW : null,
    blockHeight: blockW > 0 ? weightedBlock / blockW : null,
    latencyMs: latencyW > 0 ? weightedLatency / latencyW : null,
    totalWeight: Math.round(totalWeight * 100) / 100,
    reportsUsed: reports.length,
    allIssues: allIssues,
  };
}

// ============================================================================
// Internal: Agreement Score
// ============================================================================

function computeAgreement(consensus, ownData) {
  if (!ownData) return 50; // no own data — neutral

  var scores = [];

  // Node count (within 1 = full agree, each off = -20)
  if (consensus.nodesReachable != null && ownData.nodesReachable != null) {
    var nodeDiff = Math.abs(consensus.nodesReachable - ownData.nodesReachable);
    scores.push(Math.max(0, 100 - nodeDiff * 20));
  }

  // Block height (within 5 = full, 5-20 = 80, 20-50 = 50, >50 = 20)
  if (consensus.blockHeight != null && ownData.blockHeight != null) {
    var blockDiff = Math.abs(consensus.blockHeight - ownData.blockHeight);
    if (blockDiff <= 5) scores.push(100);
    else if (blockDiff <= 20) scores.push(80);
    else if (blockDiff <= 50) scores.push(50);
    else scores.push(20);
  }

  if (scores.length === 0) return 50;
  var sum = 0;
  for (var i = 0; i < scores.length; i++) sum += scores[i];
  return Math.round(sum / scores.length);
}

// ============================================================================
// Internal: Publish Consensus + Disagreement Alert
// ============================================================================

async function publishConsensus() {
  var reports = db.prepare("SELECT * FROM consensus_reports WHERE consumed = 0 ORDER BY created_at ASC").all();
  if (reports.length === 0) return;

  var consensus = computeWeightedConsensus(reports);

  // Get our own fleet data for comparison
  var fleet = deps.getFleetData();
  var ownData = null;
  if (fleet) {
    var nodeReports = fleet.nodeReports || [];
    var chain = fleet.chain || {};
    ownData = {
      nodesReachable: nodeReports.filter(function(n) { return n.status === "HEALTHY"; }).length,
      blockHeight: chain.block || null,
    };
  }

  var agreementScore = computeAgreement(consensus, ownData);

  // DAHR-attest
  var attestations = [];
  try {
    var urls = ["https://demosnode.discus.sh/info", "https://node2.demos.sh/info"];
    for (var i = 0; i < urls.length; i++) {
      var att = await deps.dahrAttest(deps.demos, urls[i], "GET");
      if (att) attestations.push(att);
    }
  } catch (err) {
    deps.log("[consensus] DAHR failed (non-fatal): " + (err.message || err));
  }

  // Collect unique reporters
  var reporterAddrs = [];
  for (var k = 0; k < reports.length; k++) {
    if (reporterAddrs.indexOf(reports[k].reporter) === -1) reporterAddrs.push(reports[k].reporter);
  }

  // Build consensus SIGNAL post
  var summaryText =
    "Fleet Oracle Consensus SIGNAL | " +
    reporterAddrs.length + " reporters, " + reports.length + " reports | " +
    "Nodes: " + (consensus.nodesReachable != null ? consensus.nodesReachable.toFixed(1) : "?") + "/7 | " +
    "Block: " + (consensus.blockHeight != null ? Math.round(consensus.blockHeight) : "?") + " | " +
    "Agreement: " + agreementScore + "% | " +
    "DAHR-attested";

  var signalPost = {
    cat: "SIGNAL",
    text: summaryText,
    confidence: Math.round(agreementScore),
    tags: ["consensus", "fleet-oracle", "health-don"],
    payload: {
      protocol: CONSENSUS_PROTOCOL,
      version: CONSENSUS_VERSION,
      type: "consensus_signal",
      reporters: reporterAddrs,
      reportsCount: reports.length,
      consensus: consensus,
      oracleOwnData: ownData,
      agreementScore: agreementScore,
      generatedAt: Date.now(),
    },
  };

  var publishResult = await deps.publish(deps.demos, signalPost, attestations);
  if (!publishResult) {
    deps.log("[consensus] SIGNAL publish failed");
    return;
  }

  // FIX BUG 4: Store actual txHash from publish
  var signalTxHash = (typeof publishResult === "string") ? publishResult : "published";

  // Mark consumed + record history
  var now = Date.now();
  db.prepare("UPDATE consensus_reports SET consumed = 1 WHERE consumed = 0").run();

  db.prepare(
    "INSERT INTO consensus_history (reporters_count, consensus_data, agreement_score, signal_tx, created_at) " +
    "VALUES (?, ?, ?, ?, ?)"
  ).run(
    reporterAddrs.length,
    JSON.stringify({
      consensus: consensus, oracleOwnData: ownData,
      reporters: reporterAddrs, reportsCount: reports.length,
      issues: consensus.allIssues,
    }),
    agreementScore, signalTxHash, now
  );
  lastConsensusAt = now;

  // Telegram
  try {
    await deps.sendTelegram(
      "🤝 <b>CONSENSUS</b>\n" +
      "Reporters: " + reporterAddrs.length + " (" + reports.length + " reports)\n" +
      "Nodes: " + (consensus.nodesReachable != null ? consensus.nodesReachable.toFixed(1) : "?") + "/7\n" +
      "Block: " + (consensus.blockHeight != null ? Math.round(consensus.blockHeight) : "?") + "\n" +
      "Agreement: " + agreementScore + "%\n" +
      "Attestations: " + attestations.length +
      "\nTX: " + signalTxHash
    );
  } catch { /* non-fatal */ }

  deps.log("[consensus] SIGNAL published — " + reporterAddrs.length + " reporters, agreement=" + agreementScore + "% tx=" + signalTxHash);

  // === DISAGREEMENT ALERT ===
  if (agreementScore < DISAGREEMENT_THRESHOLD && ownData) {
    deps.log("[consensus] ⚠️ DISAGREEMENT — agreement=" + agreementScore + "%, publishing alert");

    // FIX BUG 6: Check write budget before disagreement alert
    if (deps.canPublish && !deps.canPublish().ok) {
      deps.log("[consensus] disagreement alert deferred — write budget exceeded");
      return;
    }

    var alertText =
      "Consensus Disagreement Alert | Agreement: " + agreementScore + "% | " +
      "Oracle sees " + ownData.nodesReachable + "/7 nodes at block " + (ownData.blockHeight || "?") + " | " +
      "Consensus: " + (consensus.nodesReachable != null ? consensus.nodesReachable.toFixed(1) : "?") +
      "/7 at block " + (consensus.blockHeight != null ? Math.round(consensus.blockHeight) : "?") + " | " +
      "Possible: oracle blindspot, external outage, or reporter error";

    var alertPost = {
      cat: "ALERT",
      text: alertText,
      confidence: 70,
      tags: ["consensus", "disagreement", "fleet-oracle"],
      payload: {
        protocol: CONSENSUS_PROTOCOL, type: "disagreement_alert",
        agreementScore: agreementScore, oracleData: ownData, consensusData: consensus,
        reporters: reporterAddrs,
      },
    };

    try {
      await deps.publish(deps.demos, alertPost, attestations);
      await deps.sendTelegram(
        "⚠️ <b>CONSENSUS DISAGREEMENT</b>\n" +
        "Agreement: " + agreementScore + "%\n" +
        "Oracle: " + ownData.nodesReachable + "/7 block=" + (ownData.blockHeight || "?") + "\n" +
        "Consensus: " + (consensus.nodesReachable != null ? consensus.nodesReachable.toFixed(1) : "?") +
        "/7 block=" + (consensus.blockHeight != null ? Math.round(consensus.blockHeight) : "?")
      );
    } catch (err) {
      deps.log("[consensus] disagreement alert failed: " + (err.message || err));
    }
  }
}

// ============================================================================
// Internal: Announcement Post (first run only)
// ============================================================================

async function publishAnnouncement() {
  deps.log("[consensus] publishing announcement post…");

  var text =
    "Demos Fleet Oracle — Multi-Agent Consensus Oracle is LIVE\n\n" +
    "Submit health observations to contribute to decentralized fleet consensus. " +
    "Your report is weighted by your SuperColony reputation score.\n\n" +
    "How to participate (free, no payment required):\n" +
    "1. Post OBSERVATION or ANALYSIS mentioning " + deps.address + "\n" +
    "2. Include payload.protocol: \"" + CONSENSUS_PROTOCOL + "\"\n" +
    "3. Include payload.data with: nodesReachable, blockHeight, latencyMs, issuesDetected\n\n" +
    "Consensus published as SIGNAL when 3+ reporters submit, or every 24h. " +
    "All consensus signals are DAHR-attested.\n\n" +
    "Query endpoint: http://193.77.169.106:55225/consensus";

  var post = {
    cat: "OBSERVATION",
    text: text,
    confidence: 100,
    tags: ["consensus", "fleet-oracle", "health-don", "announcement"],
    payload: {
      protocol: CONSENSUS_PROTOCOL,
      version: CONSENSUS_VERSION,
      type: "announcement",
      oracleAddress: deps.address,
      acceptedCategories: ["OBSERVATION", "ANALYSIS"],
      requiredPayloadFields: ["protocol", "data"],
      dataFields: ["nodesReachable", "blockHeight", "latencyMs", "issuesDetected"],
    },
  };

  try {
    var publishResult = await deps.publish(deps.demos, post, []);
    if (publishResult) {
      deps.log("[consensus] announcement published");
      // FIX BUG 5: Write flag file so we never re-announce on restart
      var flagPath = join(deps.dataDir || "logs", ANNOUNCEMENT_FLAG_FILE);
      try { writeFileSync(flagPath, new Date().toISOString()); } catch(e) {}
      announcementDone = true;
    } else {
      deps.log("[consensus] announcement publish returned false (budget or failure)");
      // Don't set announcementDone — will retry next cycle
    }
  } catch (err) {
    deps.log("[consensus] announcement failed: " + (err.message || err));
    // Non-fatal — will retry next cycle
    // announcementDone stays false
  }
}

// ============================================================================
// Helpers
// ============================================================================

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try { return await fetch(url, Object.assign({}, opts, { signal: controller.signal })); }
  finally { clearTimeout(timer); }
}
