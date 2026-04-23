#!/usr/bin/env bun
// scripts/backfill-identity-to-history.js
//
// POINT-IN-TIME MIGRATION. Run once during Stage 2.
// Adds `identity` field to every entry in node_states JSON across all
// historical rows in public_node_history.
//
// IDEMPOTENCY: A row is rewritten only if at least one entry in node_states
// lacks identity. If every entry already has identity, the row is skipped.
// Re-running after successful backfill is a no-op (rows_scanned > 0,
// rows_changed = 0).
//
// BATCHING: Processes in batches of BATCH_SIZE rows per transaction to
// avoid holding a long write lock against the live DB. Default 3000.
// Operator rule: reduce via --batch-size=N if first batch shows lock issues.
// Do not increase above 3000 default.
//
// Usage:
//   bun scripts/backfill-identity-to-history.js --dry-run
//   bun scripts/backfill-identity-to-history.js
//   bun scripts/backfill-identity-to-history.js --batch-size=1500
//   bun scripts/backfill-identity-to-history.js --pause-ms=100

import { Database } from "bun:sqlite";

const BATCH_SIZE = parseInt(
  process.argv.find(a => a.startsWith("--batch-size="))?.split("=")[1] || "3000",
  10
);
const PAUSE_MS = parseInt(
  process.argv.find(a => a.startsWith("--pause-ms="))?.split("=")[1] || "0",
  10
);
const dryRun = process.argv.includes("--dry-run");

const db = new Database("logs/marketplace.db");

// Build name -> identity map from node_metadata (testnet only -- public_node_history is testnet-only)
const metaRows = db.query(
  "SELECT canonical_name, identity_hash FROM node_metadata WHERE source_chain = 'testnet'"
).all();
const nameToIdentity = new Map();
for (const r of metaRows) nameToIdentity.set(r.canonical_name, r.identity_hash);

console.log(`Loaded ${nameToIdentity.size} testnet names from node_metadata`);
for (const [name, id] of nameToIdentity) console.log(`  ${name} -> ${id}`);

// Count total rows for progress
const totalCount = db.query("SELECT COUNT(*) as c FROM public_node_history").get().c;
console.log(`\nTotal rows in public_node_history: ${totalCount}`);
console.log(`Batch size: ${BATCH_SIZE}  (expected batches: ${Math.ceil(totalCount / BATCH_SIZE)})`);
console.log(`Dry run: ${dryRun}`);
if (PAUSE_MS > 0) console.log(`Pause between batches: ${PAUSE_MS}ms`);
console.log();

// Pre-scan: any orphan names? Reject if yes.
const sampleRows = db.query("SELECT node_states FROM public_node_history LIMIT 1000").all();
const allNames = new Set();
for (const row of sampleRows) {
  try {
    const parsed = JSON.parse(row.node_states);
    for (const entry of parsed) {
      if (entry.name) allNames.add(entry.name);
    }
  } catch {}
}
const orphans = [...allNames].filter(n => !nameToIdentity.has(n));
if (orphans.length > 0) {
  console.error(`ERROR: orphan names in history sample (not in node_metadata): ${orphans.join(', ')}`);
  console.error(`Stage 2 plan assumed zero orphans. Abort and reconcile before proceeding.`);
  process.exit(2);
}
console.log(`Pre-scan: no orphan names found in first 1000 rows.\n`);

const updateStmt = dryRun ? null : db.prepare(
  "UPDATE public_node_history SET node_states = ? WHERE id = ?"
);

// Main loop: fetch rows in batches by id range
const maxId = db.query("SELECT MAX(id) as m FROM public_node_history").get().m;
const minId = db.query("SELECT MIN(id) as m FROM public_node_history").get().m;

let totalScanned = 0;
let totalChanged = 0;
let totalSkipped = 0;
let batchNum = 0;
const totalBatches = Math.ceil((maxId - minId + 1) / BATCH_SIZE);

for (let startId = minId; startId <= maxId; startId += BATCH_SIZE) {
  batchNum++;
  const endId = startId + BATCH_SIZE - 1;
  const batchStart = Date.now();
  let batchScanned = 0, batchChanged = 0, batchSkipped = 0;

  const rows = db.query(
    "SELECT id, node_states FROM public_node_history WHERE id >= ? AND id <= ?"
  ).all(startId, endId);

  if (!dryRun) db.exec("BEGIN");

  try {
    for (const row of rows) {
      batchScanned++;
      const parsed = JSON.parse(row.node_states);

      let anyLacksIdentity = false;
      for (const entry of parsed) {
        if (!entry.identity) { anyLacksIdentity = true; break; }
      }

      if (!anyLacksIdentity) {
        batchSkipped++;
        continue;
      }

      // Inject identity (in place, preserves entry order)
      for (const entry of parsed) {
        if (entry.identity) continue;
        const id = nameToIdentity.get(entry.name);
        if (!id) {
          throw new Error(`Unexpected orphan name at row ${row.id}: ${entry.name}`);
        }
        entry.identity = id;
      }

      if (!dryRun) {
        updateStmt.run(JSON.stringify(parsed), row.id);
      }
      batchChanged++;
    }

    if (!dryRun) db.exec("COMMIT");
  } catch (err) {
    if (!dryRun) db.exec("ROLLBACK");
    console.error(`\nBatch ${batchNum} FAILED (rolled back): ${err.message}`);
    console.error(`State: ${totalScanned} scanned, ${totalChanged} changed across ${batchNum - 1} successful batches.`);
    process.exit(1);
  }

  const batchElapsed = ((Date.now() - batchStart) / 1000).toFixed(2);
  console.log(`  batch ${batchNum}/${totalBatches}: scanned=${batchScanned} changed=${batchChanged} skipped=${batchSkipped} elapsed=${batchElapsed}s`);
  totalScanned += batchScanned;
  totalChanged += batchChanged;
  totalSkipped += batchSkipped;

  if (PAUSE_MS > 0 && batchNum < totalBatches) {
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }
}

// Final reconciliation
const remaining = db.query(
  "SELECT COUNT(*) as c FROM public_node_history WHERE node_states NOT LIKE '%\"identity\"%'"
).get().c;

console.log(`\n=== Done (${dryRun ? 'DRY RUN' : 'committed'}) ===`);
console.log(`  Batches: ${batchNum}`);
console.log(`  Rows scanned: ${totalScanned}`);
console.log(`  Rows changed: ${totalChanged}`);
console.log(`  Rows skipped (already had identity on every entry): ${totalSkipped}`);
console.log(`  Rows STILL without identity in node_states: ${remaining}  ${remaining === 0 ? '✓' : (dryRun ? '(dry-run: reflects current state; real run will zero this)' : '(expected 0 after real run)')}`);
