// dahr-recency.test.mjs — attestation.available is recency, not a latch; the DAHR error log is de-duplicated.
// Run:  bun src/dahr-recency.test.mjs   (NOT `bun test`)
// Breach: make attestationAvailable return `lastOkAt !== null` (the old latch, in effect) -> R4 and R6 FAIL.
// Breach: drop the equality check in createDahrErrorLog.error -> L1 FAILS.

import { DAHR_AVAILABLE_WINDOW_CYCLES, dahrWindowMs, attestationAvailable, createDahrErrorLog, etagWithAttestation } from "./dahr-recency.mjs";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\nDAHR_RECENCY\n");

const W = dahrWindowMs(20000);
const T = 1_790_000_000_000;
check("R0 window is 15 monitor cycles (300 s at the default 20 s)", DAHR_AVAILABLE_WINDOW_CYCLES === 15 && W === 300000, String(W));
check("R1 never succeeded (null) -> false", attestationAvailable(null, T, W) === false);
check("R2 success just now -> true", attestationAvailable(T, T, W) === true);
check("R3 success window-1 ms ago -> true", attestationAvailable(T - (W - 1), T, W) === true);
check("R3b success exactly window ago -> true (inclusive bound)", attestationAvailable(T - W, T, W) === true);
check("R4 success window+1 ms ago -> false", attestationAvailable(T - (W + 1), T, W) === false);

// A failed attempt does not advance lastOkAt (agent.mjs keeps the old value), so an old success stays old.
{
  let state = { lastCount: 0, lastOkAt: null };
  const cycle = (okCount, now) => { state = { lastCount: okCount, lastOkAt: okCount > 0 ? now : state.lastOkAt }; };
  cycle(2, T);                       // success
  cycle(0, T + 12 * 24 * 3600e3);    // 12 days of failure: one failed cycle at the end
  check("R5 a failed attempt after an old success keeps lastOkAt old", state.lastOkAt === T);
  check("R6 ... and available is false", attestationAvailable(state.lastOkAt, T + 12 * 24 * 3600e3, W) === false);
  cycle(0, T + 60e3);
  check("R7 one failed cycle inside the window does not flip it", attestationAvailable(state.lastOkAt, T + 60e3, W) === true);
}
check("R8 non-number inputs -> false",
  attestationAvailable(undefined, T, W) === false && attestationAvailable("1", T, W) === false &&
  attestationAvailable(T, NaN, W) === false && attestationAvailable(T, T, 0) === false);
check("R9 a lastOkAt in the future (clock stepped back) -> false", attestationAvailable(T + 1000, T, W) === false);

check("E1 the /health ETag carries the bit inside the quotes, and differs when available flips",
  etagWithAttestation('W/"health-1-7-v5"', true) === 'W/"health-1-7-v5-a1"' &&
  etagWithAttestation('W/"health-1-7-stale"', false) === 'W/"health-1-7-stale-a0"' &&
  etagWithAttestation('W/"h"', true) !== etagWithAttestation('W/"h"', false));
check("E2 only true gives -a1", etagWithAttestation('W/"h"', 1) === 'W/"h-a0"' && etagWithAttestation('W/"h"', null) === 'W/"h-a0"');

// --- error log de-dup ---
{
  const L = createDahrErrorLog(W);
  const a = L.error("Failed to create proxy session", T);
  const b = L.error("Failed to create proxy session", T + 20e3);
  const c = L.error("Failed to create proxy session", T + W);
  check("L1 same error x3 across the window: one error line, then one 'repeated' line",
    eq(a, ["DAHR: attestation error: Failed to create proxy session"]) && eq(b, []) &&
    eq(c, ["DAHR: Failed to create proxy session repeated 2 times"]), JSON.stringify([a, b, c]));
  const d = L.error("Failed to create proxy session", T + W + 20e3);
  check("L2 no second summary inside the next window", eq(d, []), JSON.stringify(d));
  const e = L.error("DAHR proxy timed out", T + W + 40e3);
  check("L3 a new message flushes the count and logs", eq(e, [
    "DAHR: Failed to create proxy session repeated 1 time",
    "DAHR: attestation error: DAHR proxy timed out"]), JSON.stringify(e));
  const s = L.success();
  check("L4 first success after failures always logs, and says how many failed",
    eq(s, ["DAHR: attestation working again after 5 failed attempts"]), JSON.stringify(s));
  check("L5 a later success says nothing", eq(L.success(), []));
  const f = L.error("DAHR proxy timed out", T + W + 60e3);
  check("L6 success resets: the same message as before the success logs again",
    eq(f, ["DAHR: attestation error: DAHR proxy timed out"]), JSON.stringify(f));
}
{
  const L = createDahrErrorLog(W);
  L.error("x", T); L.error("x", T + 1); L.error("x", T + 2);
  const s = L.success();
  check("L7 success flushes pending repeats before the recovery line",
    eq(s, ["DAHR: x repeated 2 times", "DAHR: attestation working again after 3 failed attempts"]), JSON.stringify(s));
}
{
  const L = createDahrErrorLog(W);
  let lines = 0;
  for (let i = 0; i < 4320; i++) lines += L.error("Failed to create proxy session", T + i * 20e3).length; // one day at 20 s, 1 RPC
  check("L8 one day of one repeated error: at most 1 + one summary per window (<= 289 lines, was 4,320)", lines <= 1 + Math.ceil(4320 * 20e3 / W), String(lines));
}

console.log(`\nDAHR_RECENCY: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
