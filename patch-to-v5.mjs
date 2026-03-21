#!/usr/bin/env node
// ============================================================
// DEMOS FLEET ORACLE — v5.0 AUTO-PATCHER
// ============================================================
// This script reads your agent.mjs, patches in all 3 features,
// and writes the updated file. Your original is backed up first.
//
// Run with:  node patch-to-v5.mjs
// Or:        bun patch-to-v5.mjs
// ============================================================

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';

const AGENT_PATH = 'src/agent.mjs';
const BACKUP_PATH = 'src/agent.mjs.v4.backup';

// ---- Safety checks ----
if (!existsSync(AGENT_PATH)) {
  console.error(`❌ Cannot find ${AGENT_PATH} — run this from /home/deploy/supercolony-node-health-agent/`);
  process.exit(1);
}

// ---- Backup ----
if (!existsSync(BACKUP_PATH)) {
  copyFileSync(AGENT_PATH, BACKUP_PATH);
  console.log(`✅ Backup created: ${BACKUP_PATH}`);
} else {
  console.log(`ℹ️  Backup already exists: ${BACKUP_PATH} (skipping)`);
}

let code = readFileSync(AGENT_PATH, 'utf-8');
const originalLength = code.length;
let patchCount = 0;

// ============================================================
// FEATURE 1: Replace fetchExplorerStatus()
// ============================================================

const NEW_FETCH_EXPLORER = `async function fetchExplorerStatus() {
  const EXPLORER_URLS = [
    'https://scan.demos.network/api/v2/stats',
    'https://scan.demos.network/api?module=block&action=eth_block_number',
    'https://scan.demos.network/api/v1/blocks?limit=1'
  ];

  for (const url of EXPLORER_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);
      if (!resp.ok) continue;
      const data = await resp.json();

      if (data.total_blocks) {
        return {
          source: 'explorer-api-v2',
          blockHeight: parseInt(data.total_blocks),
          avgBlockTime: data.average_block_time ? parseFloat(data.average_block_time) / 1000 : null,
          totalTx: data.total_transactions ? parseInt(data.total_transactions) : null
        };
      }
      if (data.result && data.result.startsWith('0x')) {
        return { source: 'explorer-eth-api', blockHeight: parseInt(data.result, 16) };
      }
      if (data.items?.[0]?.height || data.data?.[0]?.height) {
        const block = data.items?.[0] || data.data?.[0];
        return { source: 'explorer-rest-api', blockHeight: parseInt(block.height || block.number) };
      }
    } catch (e) {
      continue;
    }
  }

  try {
    const resp = await fetch('https://scan.demos.network/status', {
      headers: { 'Accept': 'text/html' }
    });
    const html = await resp.text();
    const patterns = [
      /data-block-number="(\\d+)"/,
      /block[_-]?height["\\s:=]+(\\d+)/i,
      /latest[_-]?block["\\s:=]+(\\d+)/i,
      /"block_number"\\s*:\\s*(\\d+)/,
      />(\\d{4,})<\\/(?:span|div|td)/
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return { source: 'explorer-html-parsed', blockHeight: parseInt(match[1]) };
      }
    }
  } catch (e) {}

  return { source: 'explorer', blockHeight: null, error: 'all-methods-failed' };
}`;

// Find the existing function — match from "async function fetchExplorerStatus"
// to the next function definition or a double newline + function/const/let/var
const explorerRegex = /(async\s+)?function\s+fetchExplorerStatus\s*\([^)]*\)\s*\{/;
const explorerMatch = code.match(explorerRegex);

if (explorerMatch) {
  const startIdx = explorerMatch.index;
  // Find the matching closing brace by counting braces
  let braceCount = 0;
  let endIdx = startIdx;
  let foundOpen = false;
  for (let i = startIdx; i < code.length; i++) {
    if (code[i] === '{') { braceCount++; foundOpen = true; }
    if (code[i] === '}') { braceCount--; }
    if (foundOpen && braceCount === 0) {
      endIdx = i + 1;
      break;
    }
  }
  const oldFunc = code.substring(startIdx, endIdx);
  code = code.substring(0, startIdx) + NEW_FETCH_EXPLORER + code.substring(endIdx);
  console.log(`✅ Feature 1: Replaced fetchExplorerStatus() (was ${oldFunc.length} chars, now ${NEW_FETCH_EXPLORER.length} chars)`);
  patchCount++;
} else {
  console.log(`⚠️  Feature 1: Could not find fetchExplorerStatus() — skipping (you may need to add it manually)`);
}


// ============================================================
// FEATURE 2: Add registerAgentProfile() + startup call
// ============================================================

const REGISTER_FUNC = `
// ---- v5.0: Agent Profile Registration ----
async function registerAgentProfile(demos, walletAddress) {
  const API_BASE = 'https://www.supercolony.ai/api';
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log(\`[PROFILE] Registration attempt \${attempt}/\${MAX_RETRIES}...\`);

      const challengeResp = await fetch(
        \`\${API_BASE}/auth/challenge?address=\${walletAddress}\`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!challengeResp.ok) {
        const body = await challengeResp.text();
        log(\`[PROFILE] Challenge request failed: \${challengeResp.status} — \${body}\`);
        if (challengeResp.status === 404) {
          const altPaths = [
            \`/auth/challenge?address=\${walletAddress}\`,
            \`/v1/auth/challenge?address=\${walletAddress}\`,
            \`/agent/auth/challenge?address=\${walletAddress}\`
          ];
          let found = false;
          for (const path of altPaths) {
            try {
              const altResp = await fetch(\`\${API_BASE}\${path}\`);
              if (altResp.ok) { log(\`[PROFILE] Found working auth endpoint: \${path}\`); found = true; break; }
            } catch (_) {}
          }
          if (!found) { log('[PROFILE] No working auth endpoint found — skipping'); return { success: false, reason: 'no-auth-endpoint' }; }
        }
        continue;
      }

      const challengeData = await challengeResp.json();
      const challenge = challengeData.challenge || challengeData.message || challengeData.nonce;
      if (!challenge) { log(\`[PROFILE] No challenge in response: \${JSON.stringify(challengeData)}\`); continue; }
      log(\`[PROFILE] Got challenge: \${challenge.substring(0, 32)}...\`);

      let signature;
      try {
        if (demos.wallet?.sign) signature = await demos.wallet.sign(challenge);
        else if (demos.sign) signature = await demos.sign(challenge);
        else if (demos.wallet?.signMessage) signature = await demos.wallet.signMessage(challenge);
        else if (demos.crypto?.sign) signature = await demos.crypto.sign(challenge);
        else {
          log('[PROFILE] No direct sign method found — listing available methods...');
          const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(demos)).filter(m => typeof demos[m] === 'function');
          log(\`[PROFILE] SDK methods: \${methods.join(', ')}\`);
          if (demos.wallet) {
            const wm = Object.getOwnPropertyNames(Object.getPrototypeOf(demos.wallet)).filter(m => typeof demos.wallet[m] === 'function');
            log(\`[PROFILE] Wallet methods: \${wm.join(', ')}\`);
          }
          return { success: false, reason: 'no-sign-method', sdkMethods: methods };
        }
      } catch (signErr) { log(\`[PROFILE] Signing failed: \${signErr.message}\`); continue; }

      log('[PROFILE] Challenge signed successfully');

      const verifyResp = await fetch(\`\${API_BASE}/auth/verify\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress, signature, challenge })
      });
      if (!verifyResp.ok) { const body = await verifyResp.text(); log(\`[PROFILE] Verification failed: \${verifyResp.status} — \${body}\`); continue; }

      const authData = await verifyResp.json();
      const token = authData.token || authData.session || authData.jwt || authData.accessToken;
      log('[PROFILE] Auth successful, got token');

      const profilePayload = {
        address: walletAddress,
        name: 'Demos Fleet Oracle',
        version: '5.0',
        description: 'Autonomous health and stability monitoring agent for the Demos network. Monitors 7 nodes across 4 servers with DAHR attestation, reputation scoring, predictive alerts, and a public JSON API.',
        type: 'oracle',
        capabilities: ['fleet-monitoring','dahr-attestation','reputation-scoring','predictive-alerts','public-api','validator-discovery','congestion-detection','federated-metrics'],
        endpoints: {
          health: 'http://193.77.169.106:55225/health',
          reputation: 'http://193.77.169.106:55225/reputation',
          peers: 'http://193.77.169.106:55225/peers',
          history: 'http://193.77.169.106:55225/history',
          federate: 'http://193.77.169.106:55225/federate'
        },
        metadata: { monitoredNodes: 7, cycleInterval: '20min', attestation: 'DAHR-ed25519', network: 'demos-testnet' }
      };

      const registerResp = await fetch(\`\${API_BASE}/agents/register\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
        body: JSON.stringify(profilePayload)
      });

      if (registerResp.ok) {
        const result = await registerResp.json();
        log('[PROFILE] ✅ Agent profile registered successfully!');
        log(\`[PROFILE] Profile URL: https://www.supercolony.ai/agent/\${walletAddress}\`);
        await sendTelegram(\`✅ Agent profile registered on SuperColony!\\nProfile: https://www.supercolony.ai/agent/\${walletAddress}\`);
        return { success: true, data: result };
      } else {
        const body = await registerResp.text();
        log(\`[PROFILE] Registration POST failed: \${registerResp.status} — \${body}\`);
      }
    } catch (err) {
      log(\`[PROFILE] Attempt \${attempt} error: \${err.message}\`);
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 5000));
    }
  }
  log(\`[PROFILE] ⚠️ Registration failed after \${MAX_RETRIES} attempts — will retry next restart\`);
  return { success: false, reason: 'max-retries-exhausted' };
}
// ---- end v5.0: Agent Profile Registration ----`;

// Check if already patched
if (code.includes('registerAgentProfile')) {
  console.log(`ℹ️  Feature 2: registerAgentProfile() already exists — skipping`);
} else {
  // Insert before main() function
  const mainRegex = /(async\s+)?function\s+main\s*\(/;
  const mainMatch = code.match(mainRegex);
  if (mainMatch) {
    code = code.substring(0, mainMatch.index) + REGISTER_FUNC + '\n\n' + code.substring(mainMatch.index);
    console.log(`✅ Feature 2a: Inserted registerAgentProfile() before main()`);
    patchCount++;
  } else {
    // Try alternative: look for the last function before the bottom
    // Insert before the last 200 lines as a safe fallback
    const lines = code.split('\n');
    const insertLine = Math.max(0, lines.length - 200);
    lines.splice(insertLine, 0, REGISTER_FUNC);
    code = lines.join('\n');
    console.log(`✅ Feature 2a: Inserted registerAgentProfile() at line ~${insertLine} (main() not found by pattern)`);
    patchCount++;
  }

  // Now add the startup call inside main()
  // Look for SDK initialization patterns
  const sdkPatterns = [
    /demos\s*=\s*new\s+Demos\([^)]*\)/,
    /await\s+demos\.connect\(/,
    /await\s+demos\.init\(/,
    /demos\.store\s*=/,         // might be near here
    /log\s*\(\s*['"`].*(?:SDK|demos|connected|initialized).*['"`]\s*\)/i
  ];

  let callInserted = false;
  for (const pattern of sdkPatterns) {
    const match = code.match(pattern);
    if (match) {
      // Find the end of this statement (next semicolon or newline)
      let insertPos = match.index + match[0].length;
      // Skip to end of line
      while (insertPos < code.length && code[insertPos] !== '\n') insertPos++;
      insertPos++; // past the newline

      const callCode = `
  // v5.0: Register agent profile on SuperColony (non-blocking)
  const WALLET_ADDRESS = '0xbdb3e8189a62dce62229bf3badbf01e5bdb3fbeb22f6f59f4c7c2edafe802a45';
  registerAgentProfile(demos, WALLET_ADDRESS).catch(err => {
    log(\`[PROFILE] Registration error (non-fatal): \${err.message}\`);
  });
`;
      code = code.substring(0, insertPos) + callCode + code.substring(insertPos);
      console.log(`✅ Feature 2b: Added registerAgentProfile() call after SDK init (matched: "${match[0].substring(0, 50)}...")`);
      callInserted = true;
      patchCount++;
      break;
    }
  }

  if (!callInserted) {
    console.log(`⚠️  Feature 2b: Could not find SDK init — you need to manually add the call.`);
    console.log(`    Find where "new Demos(...)" or "demos.connect()" happens in main() and add after it:`);
    console.log(`    registerAgentProfile(demos, '0xbdb3e8189a62dce62229bf3badbf01e5bdb3fbeb22f6f59f4c7c2edafe802a45').catch(err => log(err.message));`);
  }
}


// ============================================================
// FEATURE 3: Federated Metrics endpoint
// ============================================================

const PROMETHEUS_FUNC = `
// ---- v5.0: Federated Prometheus Metrics ----
function generatePrometheusMetrics(fleetData) {
  const lines = [];
  const metric = (name, help, type, values) => {
    lines.push(\`# HELP \${name} \${help}\`);
    lines.push(\`# TYPE \${name} \${type}\`);
    values.forEach(v => lines.push(v));
    lines.push('');
  };

  metric('demos_fleet_nodes_total', 'Total monitored nodes', 'gauge',
    [\`demos_fleet_nodes_total \${fleetData.nodes?.length || 7}\`]);
  metric('demos_fleet_nodes_online', 'Nodes currently online', 'gauge',
    [\`demos_fleet_nodes_online \${fleetData.nodesOnline || 0}\`]);
  metric('demos_fleet_block_height', 'Highest block height', 'gauge',
    [\`demos_fleet_block_height \${fleetData.blockHeight || 0}\`]);
  metric('demos_fleet_tps', 'Transactions per second', 'gauge',
    [\`demos_fleet_tps \${fleetData.tps || 0}\`]);
  metric('demos_fleet_mempool_size', 'Mempool tx count', 'gauge',
    [\`demos_fleet_mempool_size \${fleetData.mempoolSize || 0}\`]);
  metric('demos_fleet_seconds_since_last_block', 'Seconds since last block', 'gauge',
    [\`demos_fleet_seconds_since_last_block \${fleetData.secondsSinceLastBlock || 0}\`]);
  metric('demos_fleet_discovered_peers', 'Discovered non-fleet validators', 'gauge',
    [\`demos_fleet_discovered_peers \${fleetData.discoveredPeersCount || 0}\`]);

  const nUp=[], nBlock=[], nRep=[], nUptime=[], nSync=[], nExp=[];
  for (const node of (fleetData.nodes || [])) {
    const l = \`node="\${node.name||node.id}",host="\${node.host||'unknown'}",side="\${node.side||'unknown'}"\`;
    nUp.push(\`demos_node_up{\${l}} \${node.online?1:0}\`);
    nBlock.push(\`demos_node_block_height{\${l}} \${node.blockHeight||0}\`);
    nRep.push(\`demos_node_reputation_score{\${l}} \${node.reputationScore||0}\`);
    nUptime.push(\`demos_node_uptime_percent{\${l}} \${node.uptimePercent||0}\`);
    nSync.push(\`demos_node_synced{\${l}} \${node.synced?1:0}\`);
    nExp.push(\`demos_node_exporter_up{\${l}} \${node.exporterUp?1:0}\`);
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
      const l = \`url="\${rpc.url}"\`;
      rUp.push(\`demos_public_rpc_up{\${l}} \${rpc.available?1:0}\`);
      rLat.push(\`demos_public_rpc_latency_ms{\${l}} \${rpc.latencyMs||0}\`);
    }
    metric('demos_public_rpc_up', 'Public RPC availability', 'gauge', rUp);
    metric('demos_public_rpc_latency_ms', 'Public RPC latency ms', 'gauge', rLat);
  }

  metric('demos_dahr_attestations_total', 'DAHR attestations this cycle', 'gauge',
    [\`demos_dahr_attestations_total \${fleetData.dahrAttestations||0}\`]);
  metric('demos_alerts_active', 'Active alerts', 'gauge',
    [\`demos_alerts_active \${fleetData.activeAlerts||0}\`]);
  metric('demos_alerts_total', 'Total alerts since summary', 'counter',
    [\`demos_alerts_total \${fleetData.totalAlerts||0}\`]);
  metric('demos_oracle_info', 'Agent metadata', 'gauge',
    [\`demos_oracle_info{version="\${fleetData.version||'5.0'}",wallet="\${fleetData.wallet||''}"} 1\`]);
  metric('demos_oracle_cycle_count', 'Cycles since startup', 'counter',
    [\`demos_oracle_cycle_count \${fleetData.cycleCount||0}\`]);

  return lines.join('\\n') + '\\n';
}
// ---- end v5.0: Federated Prometheus Metrics ----`;

const ROUTE_CODE = `
    // v5.0: Federated Prometheus metrics
    } else if (pathname === '/federate' || pathname === '/metrics') {
      const fleetData = getFleetStatus();
      const prometheusText = generatePrometheusMetrics(fleetData);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(prometheusText);
    } else if (pathname === '/federate/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        instructions: 'Add to your prometheus.yml scrape_configs:',
        scrape_config: { job_name: 'demos-fleet-oracle', scrape_interval: '60s', metrics_path: '/federate',
          static_configs: [{ targets: ['193.77.169.106:55225'], labels: { network: 'demos-testnet', agent: 'fleet-oracle' } }] }
      }, null, 2));`;

if (code.includes('generatePrometheusMetrics')) {
  console.log(`ℹ️  Feature 3: generatePrometheusMetrics() already exists — skipping`);
} else {
  // Insert the function before the HTTP server
  const serverPatterns = [
    /createServer\s*\(/,
    /http\.createServer/,
    /Bun\.serve\s*\(/,
    /\.listen\s*\(\s*(?:HEALTH_PORT|55225|port)/
  ];

  let funcInserted = false;
  for (const pattern of serverPatterns) {
    const match = code.match(pattern);
    if (match) {
      // Go back to the start of this line
      let lineStart = match.index;
      while (lineStart > 0 && code[lineStart - 1] !== '\n') lineStart--;
      code = code.substring(0, lineStart) + PROMETHEUS_FUNC + '\n\n' + code.substring(lineStart);
      console.log(`✅ Feature 3a: Inserted generatePrometheusMetrics() before HTTP server`);
      funcInserted = true;
      patchCount++;
      break;
    }
  }

  if (!funcInserted) {
    // Fallback: insert before the last function
    const lastFuncMatch = [...code.matchAll(/(async\s+)?function\s+\w+\s*\(/g)];
    if (lastFuncMatch.length > 0) {
      const lastFunc = lastFuncMatch[lastFuncMatch.length - 1];
      let lineStart = lastFunc.index;
      while (lineStart > 0 && code[lineStart - 1] !== '\n') lineStart--;
      code = code.substring(0, lineStart) + PROMETHEUS_FUNC + '\n\n' + code.substring(lineStart);
      console.log(`✅ Feature 3a: Inserted generatePrometheusMetrics() before last function`);
      funcInserted = true;
      patchCount++;
    }
  }

  // Now inject the routes into the HTTP handler
  // Look for the /history route (it's the last existing one)
  const historyRoutePatterns = [
    /(['"`]\/history['"`])/,
    /pathname\s*===\s*['"`]\/history['"`]/
  ];

  let routeInserted = false;
  for (const pattern of historyRoutePatterns) {
    const match = code.match(pattern);
    if (match) {
      // Find the closing brace of this route's handler block
      // We need to find the "} else" or just "}" that ends the /history handler
      let searchFrom = match.index + match[0].length;
      let braceCount = 0;
      let foundOpen = false;
      let endPos = searchFrom;

      for (let i = searchFrom; i < code.length; i++) {
        if (code[i] === '{') { braceCount++; foundOpen = true; }
        if (code[i] === '}') {
          braceCount--;
          if (foundOpen && braceCount === 0) {
            endPos = i + 1;
            break;
          }
        }
      }

      // Check what comes after: "else", "else if", or end of chain
      const afterBlock = code.substring(endPos, endPos + 20).trim();

      if (afterBlock.startsWith('else')) {
        // Insert before the existing else
        code = code.substring(0, endPos) + '\n' + ROUTE_CODE + '\n' + code.substring(endPos);
      } else {
        // This is the end of the chain — add our routes
        code = code.substring(0, endPos) + '\n' + ROUTE_CODE + '\n    }' + code.substring(endPos);
      }

      console.log(`✅ Feature 3b: Injected /federate and /federate/config routes after /history handler`);
      routeInserted = true;
      patchCount++;
      break;
    }
  }

  if (!routeInserted) {
    // Try finding any route pattern to inject near
    const anyRouteMatch = code.match(/pathname\s*===\s*['"`]\/(?:health|reputation|peers)['"`]/);
    if (anyRouteMatch) {
      console.log(`⚠️  Feature 3b: Found route handler but couldn't safely inject. Manual step needed.`);
      console.log(`    Find the last "} else if (pathname === '/history')" block and add after its closing "}"`);
      console.log(`    the /federate routes. They're saved in: src/federate-routes-snippet.mjs`);
      writeFileSync('src/federate-routes-snippet.mjs', ROUTE_CODE, 'utf-8');
    } else {
      console.log(`⚠️  Feature 3b: Could not find HTTP route handler — manual integration needed.`);
    }
  }
}


// ============================================================
// FEATURE 4: Update version to 5.0
// ============================================================

const versionPatterns = [
  { pattern: /version:\s*['"`]4\.0['"`]/g, replacement: (m) => m.replace('4.0', '5.0') },
  { pattern: /version:\s*['"`]v4\.0['"`]/g, replacement: (m) => m.replace('v4.0', 'v5.0') },
  { pattern: /VERSION\s*=\s*['"`]4\.0['"`]/g, replacement: (m) => m.replace('4.0', '5.0') },
  { pattern: /VERSION\s*=\s*['"`]v4\.0['"`]/g, replacement: (m) => m.replace('v4.0', 'v5.0') },
];

let versionUpdated = false;
for (const { pattern, replacement } of versionPatterns) {
  const matches = code.match(pattern);
  if (matches) {
    code = code.replace(pattern, replacement);
    console.log(`✅ Version: Updated ${matches.length} occurrence(s) from 4.0 → 5.0`);
    versionUpdated = true;
    patchCount++;
    break;
  }
}
if (!versionUpdated) {
  console.log(`ℹ️  Version: No "4.0" version string found — may already be updated or uses a different format`);
}


// ============================================================
// WRITE THE PATCHED FILE
// ============================================================

writeFileSync(AGENT_PATH, code, 'utf-8');

console.log('');
console.log('============================================================');
console.log(`📝 Patched ${AGENT_PATH}`);
console.log(`   Original: ${originalLength.toLocaleString()} chars`);
console.log(`   Patched:  ${code.length.toLocaleString()} chars (+${(code.length - originalLength).toLocaleString()})`);
console.log(`   Features applied: ${patchCount}`);
console.log('');
console.log('Next steps:');
console.log('  1. sudo systemctl restart node-health-agent');
console.log('  2. sleep 3 && sudo systemctl status node-health-agent');
console.log('  3. curl http://127.0.0.1:55225/federate | head -20');
console.log('  4. sudo journalctl -u node-health-agent -n 20 | grep PROFILE');
console.log('');
console.log('To rollback:');
console.log(`  cp ${BACKUP_PATH} ${AGENT_PATH} && sudo systemctl restart node-health-agent`);
console.log('============================================================');
