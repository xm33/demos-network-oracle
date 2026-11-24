// dahr-recency.mjs — DAHR attestation state as /health reports it, and the DAHR error log de-dup.
// Pure: no clock, no I/O. Callers pass `now` (ms since epoch) and log the lines these functions return.
//
// attestation.available means: a DAHR relay returned a transaction hash within the last
// DAHR_AVAILABLE_WINDOW_CYCLES monitor cycles. It is evaluated when /health is served, so a stalled
// monitor loop also turns it false. It is never true before the first success and never latches.
// Why 15 cycles (300 s at the default 20 s cycle): measured 99.46% relay success (4,450 ok / 24 timeouts,
// 2026-11-20..21); an occasional timeout must not flip it, and a real outage shows within about 5 minutes.

export const DAHR_AVAILABLE_WINDOW_CYCLES = 15;

export function dahrWindowMs(monitorIntervalMs) {
  return DAHR_AVAILABLE_WINDOW_CYCLES * monitorIntervalMs;
}

export function attestationAvailable(lastOkAt, now, windowMs) {
  if (typeof lastOkAt !== "number" || !Number.isFinite(lastOkAt)) return false;
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
  if (typeof windowMs !== "number" || !(windowMs > 0)) return false;
  var age = now - lastOkAt;
  return age >= 0 && age <= windowMs;
}

// available expires on the clock, without a new monitor cycle, so the /health ETag (built from the cycle) must carry
// it: otherwise a revalidating client gets a 304 and keeps an expired true. Adds "-a1" or "-a0" before the closing quote.
export function etagWithAttestation(etag, available) {
  var bit = available === true ? "-a1" : "-a0";
  return /"$/.test(etag) ? etag.slice(0, -1) + bit + '"' : etag + bit;
}

// The DAHR error log, de-duplicated. One "attestation error" line when the message differs from the previous
// one, or is the first after a success (or ever); identical repeats are counted silently and summarized as
// "<msg> repeated N times" at most once per windowMs, and on the next change or success. The first success
// after failures always returns a line.
export function createDahrErrorLog(windowMs) {
  var failing = false, lastMsg = null, pending = 0, failures = 0, lastEmitAt = null;
  function flush() {
    if (pending === 0) return [];
    var line = "DAHR: " + lastMsg + " repeated " + pending + " time" + (pending === 1 ? "" : "s");
    pending = 0;
    return [line];
  }
  return {
    error: function(msg, now) {
      msg = String(msg);
      failures++;
      if (!failing || msg !== lastMsg) {
        var out = failing ? flush() : [];
        failing = true; lastMsg = msg; pending = 0; lastEmitAt = now;
        out.push("DAHR: attestation error: " + msg);
        return out;
      }
      pending++;
      if (now - lastEmitAt >= windowMs) { lastEmitAt = now; return flush(); }
      return [];
    },
    success: function() {
      if (!failing) return [];
      var out = flush();
      out.push("DAHR: attestation working again after " + failures + " failed attempt" + (failures === 1 ? "" : "s"));
      failing = false; lastMsg = null; pending = 0; failures = 0; lastEmitAt = null;
      return out;
    },
  };
}
