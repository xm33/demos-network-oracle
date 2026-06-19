#!/usr/bin/env bun
// dacs-drift-runner.mjs — DNO DACS-2 GLEIF drift-test runner.
//
// Layer 3 — private operator / conformance tooling. NOT a service, scheduler,
// public API, certification endpoint, or DNO public-surface feature.
//
// Thin wrapper over verifyLei() so repeated drift comparisons against PATH-OS
// don't depend on remembering the exact invocation. Prints deterministic JSON
// to stdout. Writes nothing to disk (no stored verdict dataset by stealth).
//
// Usage:
//   bun dacs-drift-runner.mjs <LEI> [LEI ...]
// Example:
//   bun dacs-drift-runner.mjs 506700GE1G29325QX363 743700SEJ147Y3TSFE83

import { verifyLei } from "./gleif-verify.mjs";

function usage() {
  console.error("Usage: bun dacs-drift-runner.mjs <LEI> [LEI ...]");
}

const leis = process.argv.slice(2);
if (leis.length === 0) {
  usage();
  process.exit(1);
}

const out = {
  tool: "dno-dacs-gleif-drift-runner",
  layer: "layer-3-private-conformance",
  publicSurface: false,
  runStartedAt: new Date().toISOString(),
  results: [],
};

for (const lei of leis) {
  const startedAt = new Date().toISOString();
  try {
    // Pass through verbatim — do NOT reshape the claim or the result.
    // A malformed LEI returns null (no VerifyResult is itself the answer).
    const result = await verifyLei(lei);
    out.results.push({
      input: lei,
      startedAt,
      completedAt: new Date().toISOString(),
      emitted: result !== null,
      result, // null for malformed, else the full VerifyResult verbatim
    });
  } catch (err) {
    // A thrown error is a runner-level failure, distinct from a decision:"error"
    // VerifyResult (which verifyLei returns for transport/schema problems).
    out.results.push({
      input: lei,
      startedAt,
      completedAt: new Date().toISOString(),
      emitted: false,
      runnerError: err instanceof Error ? err.message : String(err),
    });
  }
}

out.runCompletedAt = new Date().toISOString();
console.log(JSON.stringify(out, null, 2));
