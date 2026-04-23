#!/usr/bin/env bun
// scripts/populate-node-metadata.js
//
// POINT-IN-TIME MIGRATION SCRIPT. Run once during Stage 1 deployment.
// After this runs, node_metadata is the source of truth for identity metadata.
// Do not re-run without dropping the table first — INSERT OR IGNORE makes it
// idempotent but you will not pick up upstream edits to PUBLIC_NODES / FIXNET_NODES.
//
// Usage:
//   bun scripts/populate-node-metadata.js --dry-run    # print what would be inserted
//   bun scripts/populate-node-metadata.js              # actually insert
//
// Architecture memo: Evolution B, Stage 1 (metadata foundation).
// Legacy source_type / trust_tier / joined_at are preserved as JSON in notes
// per operator decision (preservation over silent deletion).

import { Database } from "bun:sqlite";

// Duplicated inline from src/agent.mjs (Option 4: one-shot script).
// If agent.mjs maps change, this script is stale — but after Stage 1 runs,
// node_metadata is the source of truth and this script is historical.
const PUBLIC_NODES = {
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

const FIXNET_NODES = {
  "kynesys-anchor": {
    url: "http://node3.demos.sh:60001",
    identity: "0x412bee5548b43bc0a23429c06946c1eb990d900f6c0ed5c3ad001481e7f7a8ef",
    source_type: "anchor",
    trust_tier: "verified",
    operator: "Kynesys",
    joined_at: "2026-04-22"
  },
  "fleet-n1": {
    url: "http://193.77.44.160:53550",
    identity: "0x8f3abd366c7b846c1ee940f35d2d7ef7774dfe636e6284a32bf2c5a3e1b3ba05",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n2": {
    url: "http://193.77.44.160:54550",
    identity: "0xbfda23d32dee055bda23f1e74a25abb7e33478da1b2013768e135cc2ed924f37",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n3": {
    url: "http://193.77.169.106:53550",
    identity: "0x4ba486bc92263f2cb15608ed369eafbd576097e79194f0895c1e01d232aa4b52",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n4": {
    url: "http://193.77.50.180:54550",
    identity: "0x848ae0759c5eba1974ec942b8e1fb4962e1b256ff89e93bdb6ad12ea58ad76a9",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n5": {
    url: "http://193.77.50.180:53550",
    identity: "0x95cbd7147cf09dc46d91cd6ae8f2912ae0f597fac9c61d0b0c347a46374af80f",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-n6": {
    url: "http://193.77.169.106:54550",
    identity: "0x3ab3365e67583a89968082475816cf2f16f8f9a3b936a38513493d0c6b69f768",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  },
  "fleet-m1": {
    url: "http://82.192.52.254:53550",
    identity: "0x56b46be173e20f540401d079811e5b524903a197ae5d07824d0e70a22ee6e591",
    source_type: "fleet",
    trust_tier: "verified",
    operator: "XM33",
    joined_at: "2026-04-22"
  }
};

// Explicit seed membership (architecture memo: seeds are operational role, not operator-derived).
const TESTNET_SEEDS = new Set(["kyne-node2", "kyne-node3", "kyne-node3b"]);
const FIXNET_SEEDS  = new Set(["kynesys-anchor"]);

const dryRun = process.argv.includes("--dry-run");
const db = new Database("logs/marketplace.db");
const now = Date.now();

function isSeed(sourceChain, canonicalName) {
  if (sourceChain === "testnet") return TESTNET_SEEDS.has(canonicalName) ? 1 : 0;
  if (sourceChain === "fixnet")  return FIXNET_SEEDS.has(canonicalName) ? 1 : 0;
  return 0;
}

function buildRow(canonicalName, node, sourceChain) {
  const notes = JSON.stringify({
    legacy_joined_at: node.joined_at || null,
    legacy_source_type: node.source_type || null,
    legacy_trust_tier: node.trust_tier || null
  });
  return {
    identity_hash: node.identity,
    canonical_name: canonicalName,
    operator_claim: node.operator || null,
    operator_verification: null,
    seed_node: isSeed(sourceChain, canonicalName),
    source_chain: sourceChain,
    current_url: node.url || null,
    previous_urls: null,
    tags: null,
    notes: notes,
    created_at: now,
    updated_at: now
  };
}

const rows = [];
for (const name in PUBLIC_NODES) rows.push(buildRow(name, PUBLIC_NODES[name], "testnet"));
for (const name in FIXNET_NODES) rows.push(buildRow(name, FIXNET_NODES[name], "fixnet"));

// Defensive: catch duplicate identities across the two inline maps BEFORE insert.
const identitySeen = new Map();
const duplicates = [];
for (const r of rows) {
  if (identitySeen.has(r.identity_hash)) {
    duplicates.push({
      identity: r.identity_hash,
      first:  identitySeen.get(r.identity_hash),
      second: `${r.source_chain}:${r.canonical_name}`
    });
  } else {
    identitySeen.set(r.identity_hash, `${r.source_chain}:${r.canonical_name}`);
  }
}
if (duplicates.length > 0) {
  console.error("ERROR: duplicate identity_hash in inline maps — aborting.");
  for (const d of duplicates) {
    console.error(`  ${d.identity}`);
    console.error(`    first seen:  ${d.first}`);
    console.error(`    second seen: ${d.second}`);
  }
  process.exit(2);
}

console.log(`Prepared ${rows.length} rows.`);
console.log(`  testnet: ${rows.filter(r => r.source_chain === "testnet").length}`);
console.log(`  fixnet:  ${rows.filter(r => r.source_chain === "fixnet").length}`);
console.log(`  seeds:   ${rows.filter(r => r.seed_node === 1).length}`);
console.log();

if (dryRun) {
  console.log("=== DRY RUN — no writes ===");
  for (const r of rows) {
    console.log(`  [${r.source_chain}] seed=${r.seed_node} ${r.canonical_name}`);
    console.log(`    identity: ${r.identity_hash}`);
    console.log(`    operator: ${r.operator_claim}`);
    console.log(`    url:      ${r.current_url}`);
    console.log(`    notes:    ${r.notes}`);
  }
  console.log("\n=== END DRY RUN (use without --dry-run to insert) ===");
  process.exit(0);
}

// Real run: verify table exists first (fail fast if schema not deployed).
const tableCheck = db.query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='node_metadata'"
).get();
if (!tableCheck) {
  console.error("ERROR: node_metadata table does not exist. Deploy the schema change to agent.mjs and restart node-health-agent.service first.");
  process.exit(1);
}

const stmt = db.prepare(`INSERT OR IGNORE INTO node_metadata
  (identity_hash, canonical_name, operator_claim, operator_verification,
   seed_node, source_chain, current_url, previous_urls, tags, notes,
   created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

let inserted = 0;
let skipped = 0;
for (const r of rows) {
  const result = stmt.run(
    r.identity_hash, r.canonical_name, r.operator_claim, r.operator_verification,
    r.seed_node, r.source_chain, r.current_url, r.previous_urls, r.tags, r.notes,
    r.created_at, r.updated_at
  );
  if (result.changes > 0) inserted++;
  else skipped++;
}

const total = db.query("SELECT COUNT(*) as c FROM node_metadata").get().c;
console.log(`\n=== Done ===`);
console.log(`  Inserted: ${inserted}`);
console.log(`  Skipped (already present): ${skipped}`);
console.log(`  Total rows in node_metadata: ${total}`);
