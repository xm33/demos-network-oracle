#!/usr/bin/env node
/**
 * apply-consensus-patch.js
 * Run from project root: node apply-consensus-patch.js
 *
 * Patches agent.mjs to integrate consensus.mjs (5 patches).
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";

var FILE = "src/agent.mjs";
if (!existsSync(FILE)) { console.error("ERROR: " + FILE + " not found"); process.exit(1); }

var BACKUP = FILE + ".v6.0.backup";
if (!existsSync(BACKUP)) {
  copyFileSync(FILE, BACKUP);
  console.log("✅ Backup: " + BACKUP);
} else {
  console.log("⚠️  Backup exists: " + BACKUP);
}

var code = readFileSync(FILE, "utf8");
var n = 0;
var errors = [];

// === PATCH 1: Import (after marketplace import) ===
if (code.indexOf("initConsensus") !== -1) {
  console.log("⏭️  P1 (import): exists");
} else {
  var a1 = 'from "./marketplace.mjs";';
  if (code.indexOf(a1) === -1) { errors.push("P1: anchor missing: " + a1); }
  else {
    code = code.replace(a1,
      a1 + '\nimport { initConsensus, pollAndProcessConsensus, getConsensusState } from "./consensus.mjs";');
    n++; console.log("✅ P1: import");
  }
}

// === PATCH 2: Init (after marketplace init catch) ===
if (code.indexOf("initConsensus({") !== -1) {
  console.log("⏭️  P2 (init): exists");
} else {
  // Anchor: the closing of marketplace init's catch block
  var a2 = '    log("[marketplace] init failed (non-fatal): " + (mktErr.message || mktErr));\n  }';
  if (code.indexOf(a2) === -1) {
    // Try without leading spaces (in case of tab differences)
    a2 = 'log("[marketplace] init failed (non-fatal): " + (mktErr.message || mktErr));';
    if (code.indexOf(a2) === -1) { errors.push("P2: marketplace init catch anchor not found"); }
    else {
      // Find the closing brace after this log line
      var idx = code.indexOf(a2) + a2.length;
      var afterLog = code.indexOf("}", idx);
      if (afterLog === -1) { errors.push("P2: no closing brace after marketplace catch"); }
      else {
        code = code.slice(0, afterLog + 1) + `

  // === v6.1: Consensus Oracle init ===
  try {
    initConsensus({
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
  } catch (conErr) {
    log("[consensus] init failed (non-fatal): " + (conErr.message || conErr));
  }` + code.slice(afterLog + 1);
        n++; console.log("✅ P2: init (fallback anchor)");
      }
    }
  } else {
    code = code.replace(a2, a2 + `

  // === v6.1: Consensus Oracle init ===
  try {
    initConsensus({
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
  } catch (conErr) {
    log("[consensus] init failed (non-fatal): " + (conErr.message || conErr));
  }`);
    n++; console.log("✅ P2: init");
  }
}

// === PATCH 3: Poll (after marketplace poll catch) ===
if (code.indexOf("pollAndProcessConsensus") !== -1) {
  console.log("⏭️  P3 (poll): exists");
} else {
  var a3 = 'log("[marketplace] poll error (non-fatal): " + (mktErr.message || mktErr));';
  if (code.indexOf(a3) === -1) { errors.push("P3: marketplace poll catch anchor not found"); }
  else {
    // Find the closing brace of that catch block
    var idx3 = code.indexOf(a3) + a3.length;
    var closeBrace3 = code.indexOf("}", idx3);
    if (closeBrace3 === -1) { errors.push("P3: no closing brace after marketplace poll catch"); }
    else {
      code = code.slice(0, closeBrace3 + 1) + `

      // === v6.1: Consensus Oracle poll ===
      try {
        var conResult = await pollAndProcessConsensus();
        if (conResult.reportsFound > 0 || conResult.consensusPublished) {
          log("[consensus] cycle: reports=" + conResult.reportsFound + " published=" + conResult.consensusPublished);
        }
      } catch (conErr) {
        log("[consensus] poll error (non-fatal): " + (conErr.message || conErr));
      }` + code.slice(closeBrace3 + 1);
      n++; console.log("✅ P3: poll");
    }
  }
}

// === PATCH 4: HTTP route (before marketplace route) ===
if (code.indexOf("getConsensusState") !== -1) {
  console.log("⏭️  P4 (route): exists");
} else {
  var a4 = '    } else if (req.url === "/marketplace" || req.url === "/marketplace/") {';
  if (code.indexOf(a4) === -1) { errors.push("P4: marketplace route anchor not found"); }
  else {
    code = code.replace(a4,
      '    } else if (req.url === "/consensus" || req.url === "/consensus/") {\n' +
      '      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });\n' +
      '      res.end(JSON.stringify(getConsensusState(), null, 2));\n' +
      a4);
    n++; console.log("✅ P4: /consensus route");
  }
}

// === PATCH 5: Update 404 ===
var old404 = "/federate, /marketplace, /consensus";
if (code.indexOf(old404) !== -1) {
  console.log("⏭️  P5 (404): exists");
} else {
  var old = "/federate, /marketplace";
  if (code.indexOf(old) !== -1) {
    code = code.replace(old, old + ", /consensus");
    n++; console.log("✅ P5: 404 updated");
  } else {
    console.log("⏭️  P5: pattern already changed or not found");
  }
}

// === Report ===
if (errors.length > 0) {
  console.error("\n❌ ERRORS:");
  for (var i = 0; i < errors.length; i++) console.error("  " + errors[i]);
  console.error("\nNo changes written. Fix anchors manually.");
  process.exit(1);
}

writeFileSync(FILE, code);
console.log("\n🎉 " + n + " patch(es) applied to " + FILE);
console.log("\nVerify:");
console.log("  grep -n consensus src/agent.mjs | head -15");
console.log("\nDeploy:");
console.log("  sudo systemctl restart node-health-agent");
console.log("  sleep 10");
console.log("  sudo journalctl -u node-health-agent --no-pager -n 40 | grep -i consensus");
console.log("  curl -s http://127.0.0.1:55225/consensus | python3 -m json.tool");
