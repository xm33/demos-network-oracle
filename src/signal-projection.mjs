// signal-projection.mjs
// Public-surface signal projection for /health and the dashboard.
// Constitutional control (DNO §3.1 no private-data leakage, §3.4 nothing L3 public):
// the PUBLIC allowlist is the single load-bearing boundary. toPublicSignals is a
// PROJECTION, not a filter — it rebuilds each signal from a fixed field set and
// never carries through unlisted fields (fleet aliases ride in interpolated
// message strings, so whole-object rebuild is required, not field scrubbing).

// Load-bearing allowlist (3). The projection consults ONLY this positive set.
export const PUBLIC_SIGNAL_TYPES = new Set([
  "public_node_offline",
  "public_network_block",
  "discovered_validators",
]);

// Completeness-set (10) — for the completeness test ONLY, never consulted by the
// projection. Named "non-public" not "fleet": chain_stall, no_data, all_healthy
// are not fleet-derived; a fleet label would re-encode a rebutted source rationale.
// Invariant enforced by test: PUBLIC ∪ NON_PUBLIC = full type universe, disjoint.
export const NON_PUBLIC_SIGNAL_TYPES = new Set([
  "no_data",
  "node_offline",
  "block_lag",
  "identity_mismatch",
  "not_ready",
  "not_synced",
  "chain_stall",
  "low_online_count",
  "block_divergence",
  "all_healthy",
]);

// Fields permitted on a public signal. Any field outside this set is dropped by
// construction (fresh object, no spread).
const PUBLIC_SIGNAL_FIELDS = ["type", "severity", "nodes", "value", "message"];

// Projection: reject non-allowlisted type; rebuild a fresh object from the fixed
// field set; value-shape assert each field; drop malformed entries.
// NEVER spreads the source object.
export function toPublicSignals(signals) {
  if (!Array.isArray(signals)) return [];
  const out = [];
  for (const sig of signals) {
    if (sig === null || typeof sig !== "object") continue;
    if (!PUBLIC_SIGNAL_TYPES.has(sig.type)) continue;
    // value-shape asserts — malformed => drop (fail closed)
    if (typeof sig.severity !== "string") continue;
    if (!Array.isArray(sig.nodes)) continue;
    if (!sig.nodes.every(function (n) { return typeof n === "string"; })) continue;
    if (typeof sig.message !== "string") continue;
    // value may be number or null (no_data uses null, but no_data is non-public;
    // public types carry numbers — allow number|null, reject anything else)
    if (!(typeof sig.value === "number" || sig.value === null)) continue;
    out.push({
      type: sig.type,
      severity: sig.severity,
      nodes: sig.nodes.slice(),
      value: sig.value,
      message: sig.message,
    });
  }
  return out;
}
