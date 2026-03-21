#!/usr/bin/env node
/**
 * apply-marketplace-patch.js
 *
 * Applies 5 patches to agent.mjs for marketplace integration.
 * Run from the project root:
 *   node apply-marketplace-patch.js
 *
 * Creates agent.mjs.v5.backup before modifying.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";

const FILE = "src/agent.mjs";

if (!existsSync(FILE)) {
  console.error("ERROR: " + FILE + " not found. Run from project root.");
  process.exit(1);
}

// Backup
const BACKUP = FILE + ".v5.backup";
if (!existsSync(BACKUP)) {
  copyFileSync(FILE, BACKUP);
  console.log("✅ Backup created: " + BACKUP);
} else {
  console.log("⚠️  Backup already exists: " + BACKUP + " (not overwriting)");
}

let code = readFileSync(FILE, "utf8");
let patchCount = 0;

// ========================================================================
// PATCH 1: Import marketplace module (after SDK import)
// ========================================================================

const IMPORT_ANCHOR = 'import { Demos } from "@kynesyslabs/demosdk/websdk";';
const IMPORT_PATCH = `import { Demos } from "@kynesyslabs/demosdk/websdk";

// === v6.0: Marketplace ===
import { initMarketplace, pollAndProcessQueries, getMarketplaceStats, getRecentQueries, shutdownMarketplace } from "./marketplace.mjs";`;

if (code.indexOf("initMarketplace") !== -1) {
  console.log("⏭️  Patch 1 (import): already applied, skipping");
} else if (code.indexOf(IMPORT_ANCHOR) === -1) {
  console.error("❌ Patch 1: anchor not found: " + IMPORT_ANCHOR);
  process.exit(1);
} else {
  code = code.replace(IMPORT_ANCHOR, IMPORT_PATCH);
  patchCount++;
  console.log("✅ Patch 1: marketplace import added");
}

// ========================================================================
// PATCH 2: Initialize marketplace (after registerAgentProfile in main())
// ========================================================================

const INIT_ANCHOR = "registerAgentProfile();";
const INIT_PATCH = `registerAgentProfile();

  // === v6.0: Marketplace init ===
  try {
    var mktAddress = demos.getAddress();
    initMarketplace({
      demos: demos,
      address: mktAddress,
      getFleetData: function() { return latestHealthData; },
      getHistory: function() { return history; },
      getRepScores: calculateReputationScores,
      detectTrends: detectTrends,
      publish: publish,
      dahrAttest: dahrAttest,
      sendTelegram: sendTelegram,
      log: log,
      dataDir: LOG_DIR,
    });
  } catch (mktErr) {
    log("[marketplace] init failed (non-fatal): " + (mktErr.message || mktErr));
  }`;

if (code.indexOf("initMarketplace(") !== -1) {
  console.log("⏭️  Patch 2 (init): already applied, skipping");
} else if (code.indexOf(INIT_ANCHOR) === -1) {
  console.error("❌ Patch 2: anchor not found: " + INIT_ANCHOR);
  process.exit(1);
} else {
  // Replace first occurrence only (there should only be one)
  code = code.replace(INIT_ANCHOR, INIT_PATCH);
  patchCount++;
  console.log("✅ Patch 2: marketplace init added in main()");
}

// ========================================================================
// PATCH 3: Poll marketplace each cycle (before daily summary)
// ========================================================================

const POLL_ANCHOR = "// --- Daily summary (includes reputation leaderboard) ---";
const POLL_PATCH = `// === v6.0: Marketplace poll ===
      try {
        var mktResult = await pollAndProcessQueries();
        if (mktResult.queriesFound > 0 || mktResult.queriesProcessed > 0) {
          log("[marketplace] cycle: found=" + mktResult.queriesFound + " processed=" + mktResult.queriesProcessed + " errors=" + mktResult.errors.length);
        }
      } catch (mktErr) {
        log("[marketplace] poll error (non-fatal): " + (mktErr.message || mktErr));
      }

      // --- Daily summary (includes reputation leaderboard) ---`;

if (code.indexOf("pollAndProcessQueries()") !== -1) {
  console.log("⏭️  Patch 3 (poll): already applied, skipping");
} else if (code.indexOf(POLL_ANCHOR) === -1) {
  console.error("❌ Patch 3: anchor not found. Looking for: " + POLL_ANCHOR);
  process.exit(1);
} else {
  code = code.replace(POLL_ANCHOR, POLL_PATCH);
  patchCount++;
  console.log("✅ Patch 3: marketplace poll added in cycle loop");
}

// ========================================================================
// PATCH 4: HTTP routes (before 404 fallback)
// ========================================================================

// Strategy: replace the entire } else { 404 } block with marketplace routes + updated 404.
const OLD_404_BLOCK = `    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found. Try /health, /reputation, /peers, /history, or /federate" }));
    }`;

const NEW_404_BLOCK = `    } else if (req.url === "/marketplace" || req.url === "/marketplace/") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getMarketplaceStats(), null, 2));
    } else if (req.url === "/marketplace/queries" || req.url.indexOf("/marketplace/queries?") === 0) {
      var mqLimit = 20;
      var mqIdx = req.url.indexOf("limit=");
      if (mqIdx !== -1) { mqLimit = parseInt(req.url.substring(mqIdx + 6), 10) || 20; }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getRecentQueries(mqLimit), null, 2));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found. Try /health, /reputation, /peers, /history, /federate, /marketplace" }));
    }`;

if (code.indexOf("getMarketplaceStats") !== -1) {
  console.log("⏭️  Patch 4 (routes): already applied, skipping");
} else if (code.indexOf(OLD_404_BLOCK) === -1) {
  console.error("❌ Patch 4: 404 block not found. Expected:\n" + OLD_404_BLOCK);
  process.exit(1);
} else {
  code = code.replace(OLD_404_BLOCK, NEW_404_BLOCK);
  patchCount++;
  console.log("✅ Patch 4: /marketplace and /marketplace/queries routes added");
}

// ========================================================================
// PATCH 5: Graceful shutdown
// ========================================================================

if (code.indexOf("shutdownMarketplace") !== -1 && code.indexOf("SIGTERM") !== -1) {
  console.log("⏭️  Patch 5 (shutdown): already applied, skipping");
} else if (code.indexOf("SIGTERM") !== -1) {
  // Shutdown handler exists — add marketplace shutdown to it
  console.log("⚠️  Patch 5: existing SIGTERM handler found — add shutdownMarketplace() manually");
} else {
  // No shutdown handler — add one at the end of the file
  code += `

// === v6.0: Graceful shutdown ===
process.on("SIGTERM", function() {
  log("[agent] SIGTERM — shutting down");
  shutdownMarketplace();
  process.exit(0);
});
process.on("SIGINT", function() {
  log("[agent] SIGINT — shutting down");
  shutdownMarketplace();
  process.exit(0);
});
`;
  patchCount++;
  console.log("✅ Patch 5: shutdown handlers added");
}

// ========================================================================
// Write result
// ========================================================================

writeFileSync(FILE, code);
console.log("\n🎉 Done — " + patchCount + " patch(es) applied to " + FILE);
console.log("   Backup at: " + BACKUP);
console.log("\nNext steps:");
console.log("  sudo systemctl restart node-health-agent");
console.log("  sudo journalctl -u node-health-agent --no-pager -n 30 | grep marketplace");
console.log("  curl -s http://127.0.0.1:55225/marketplace | python3 -m json.tool");
