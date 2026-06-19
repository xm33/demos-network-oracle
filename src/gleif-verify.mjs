// gleif-verify.mjs — DACS-2 GLEIF VerifyResult emitter (DNO public-authority path)
//
// Standalone. Drift-tests against PATH-OS (DACS-Standard#146). Built per
// dno-gleif-verify-emitter-spec-v2.md. Does NOT import from or modify
// commerce-probes.mjs — the reachability probe and this verdict emitter are
// separate concerns (Layer-2 reachability vs DACS-2 verdict).
//
// Contract:  verifyLei(lei) -> Promise<VerifyResult | null>
//   - returns null for a malformed LEI (no VerifyResult is an authority answer)
//   - otherwise a VerifyResult with the compared triple {claim, decision, resolvedEntity}
//     plus non-compared diagnostics.
//
// Bun runtime. Uses global fetch + Web Crypto (crypto.subtle) — no deps.

const GLEIF_RECORD_BY_ID = "https://api.gleif.org/api/v1/lei-records/";
const FETCH_TIMEOUT_MS = 5000;
const CHALLENGE_ACCEPT = "application/vnd.api+json";

// --- §3 step 0: LEI structural validation (ISO 17442 / ISO 7064 MOD 97-10) ---

// An LEI is 20 chars: 18 uppercase-alphanumeric + 2 check digits, the whole
// 20 validated by ISO 7064 MOD 97-10 (the same scheme as IBAN). Letters map
// A=10..Z=35; the integer formed from all 20 chars must be ≡ 1 (mod 97).
function isValidLei(lei) {
  if (typeof lei !== "string") return false;
  if (!/^[A-Z0-9]{20}$/.test(lei)) return false;
  return mod97(lei) === 1;
}

function mod97(s) {
  // Convert each char to its numeric value and reduce iteratively to avoid
  // building a 38-digit BigInt. Letters: A-Z -> 10-35. Digits: 0-9 -> 0-9.
  let remainder = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    let chunk;
    if (code >= 48 && code <= 57) {
      chunk = String(code - 48); // '0'-'9'
    } else {
      chunk = String(code - 55); // 'A'(65)->10 ... 'Z'(90)->35
    }
    for (const d of chunk) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

// --- §5.4: entity-name normalization (NFC + trim + collapse internal ws ONLY) ---
// Deliberately NOT NFKC, NOT case-fold, NOT accent-strip — those would hide
// real legal-name differences. Matches CF-1 (NFC) per spec.
function normalizeEntityName(raw) {
  if (raw == null) return null;
  const n = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  return n.length === 0 ? null : n;
}

// --- §3 step 3: bodyHash over raw response bytes ---
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- §5.1 / §5.2: registration.status -> decision mapping ---
// Returns { decision, reason, mappingConfidence, alternateDefensibleDecision }.
// registration.status is primary; entity.status decisive only in the
// ISSUED+INACTIVE conflict (§5.3). All comparisons case-sensitive, uppercase.
function mapDecision(registrationStatus, entityStatus) {
  const reg = registrationStatus;
  const entInactive = entityStatus === "INACTIVE";

  switch (reg) {
    case "ISSUED":
      return entInactive
        ? { decision: "indeterminate", reason: "status_conflict_issued_entity_inactive", mappingConfidence: "A", alternateDefensibleDecision: null }
        : { decision: "pass", reason: "registration_issued_active", mappingConfidence: "A", alternateDefensibleDecision: null };

    // Lifecycle, valid-but-not-current
    case "LAPSED":
      return { decision: "indeterminate", reason: "registration_lapsed_valid_not_current", mappingConfidence: "A", alternateDefensibleDecision: null };

    // Lifecycle end — the flagged two-sided divergence (§5.2)
    case "RETIRED":
      return { decision: "indeterminate", reason: "registration_retired_lifecycle_end", mappingConfidence: "B", alternateDefensibleDecision: "fail" };

    // Assignment-error states (GLEIF's three) -> fail
    case "ANNULLED":
      return { decision: "fail", reason: "registration_annulled_invalid_after_issuance", mappingConfidence: "A", alternateDefensibleDecision: null };
    case "DUPLICATE":
      return { decision: "fail", reason: "registration_duplicate_non_surviving", mappingConfidence: "A", alternateDefensibleDecision: null };
    case "CANCELLED":
      return { decision: "fail", reason: "registration_cancelled_before_issuance", mappingConfidence: "A", alternateDefensibleDecision: null };

    // Deprecated (LEI-CDF 3.1) — low-confidence Mode-B
    case "MERGED":
      return { decision: "indeterminate", reason: "registration_merged_deprecated_successor", mappingConfidence: "C", alternateDefensibleDecision: "fail" };

    // Transient / administrative
    case "PENDING_VALIDATION":
    case "PENDING_TRANSFER":
    case "PENDING_ARCHIVAL":
      return { decision: "indeterminate", reason: "registration_pending", mappingConfidence: "C", alternateDefensibleDecision: null };
    case "TRANSFERRED":
      return { decision: "indeterminate", reason: "registration_transferred_lou_admin", mappingConfidence: "C", alternateDefensibleDecision: null };

    // Unknown / future (incl. WITHDRAWN_CANCELLED if it ever appears as a
    // registration value) -> honest uncertainty, never silently pass/fail,
    // never error (the authority answered).
    default:
      return { decision: "indeterminate", reason: "unknown_registration_status", mappingConfidence: "D", alternateDefensibleDecision: null };
  }
}

// --- assembly helpers ---
function buildResult(lei, decision, resolvedEntity, diagnostics) {
  return {
    claim: { scheme: "lei", identifier: lei }, // exactly two keys (§6)
    decision,
    resolvedEntity,
    diagnostics,
  };
}

function errorResult(lei, reason, bodyHash) {
  return buildResult(lei, "error", null, {
    entityStatus: null,
    registrationStatus: null,
    decisionReason: reason,
    mappingConfidence: "D",
    alternateDefensibleDecision: null,
    resolvedEntityRaw: null,
    resolvedEntityNormalized: null,
    dataQualityFlags: [],
    bodyHash: bodyHash ?? null,
  });
}

// --- §1 contract: verifyLei ---
export async function verifyLei(lei) {
  // §3 step 1 — identifier validation. Malformed => NO VerifyResult.
  if (!isValidLei(lei)) {
    // Not an authority answer; emit nothing (caller may log identifier_malformed).
    return null;
  }

  // §3 step 2 — fetch
  let res, rawBytes, bodyHash;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    res = await fetch(GLEIF_RECORD_BY_ID + lei, {
      method: "GET",
      headers: { Accept: CHALLENGE_ACCEPT },
      signal: controller.signal,
    });
    rawBytes = new Uint8Array(await res.arrayBuffer());
    bodyHash = "sha256:" + (await sha256Hex(rawBytes));
  } catch (e) {
    // network / timeout / TLS / DNS / abort
    return errorResult(lei, "transport_error", null);
  } finally {
    clearTimeout(timer);
  }

  // §3 step 2 — status branches
  if (res.status === 404) {
    // well-formed LEI, no record -> conclusive negative
    return buildResult(lei, "fail", null, {
      entityStatus: null,
      registrationStatus: null,
      decisionReason: "no_record_found",
      mappingConfidence: "A",
      alternateDefensibleDecision: null,
      resolvedEntityRaw: null,
      resolvedEntityNormalized: null,
      dataQualityFlags: [],
      bodyHash,
    });
  }
  if (res.status !== 200) {
    // any other non-2xx (3xx/4xx/5xx/429) -> could-not-complete, retryable
    return errorResult(lei, "transport_error", bodyHash);
  }

  // parse
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResult(lei, "schema_error", bodyHash);
  }

  // §4 — read the two status fields + name from the single `data` object
  const attrs = body?.data?.attributes;
  if (!attrs || typeof attrs !== "object") {
    return errorResult(lei, "schema_error", bodyHash);
  }
  const registrationStatus = attrs?.registration?.status ?? null;
  const entityStatus = attrs?.entity?.status ?? null;
  const rawName = attrs?.entity?.legalName?.name ?? null;

  if (registrationStatus == null) {
    // record present but no registration.status — uninterpretable
    return errorResult(lei, "schema_error", bodyHash);
  }

  // §5 — decision
  const { decision, reason, mappingConfidence, alternateDefensibleDecision } = mapDecision(
    registrationStatus,
    entityStatus,
  );

  // §5.4 — resolvedEntity (compared field = normalized name)
  const resolvedEntityRaw = rawName;
  const resolvedEntityNormalized = normalizeEntityName(rawName);
  const dataQualityFlags = [];

  // §5.4 item 5 — on pass with no name: resolvedEntity null + flag (pass holds)
  let resolvedEntity = resolvedEntityNormalized;
  if (resolvedEntity == null) {
    resolvedEntity = null;
    if (decision === "pass") dataQualityFlags.push("missing_legal_name");
  }

  return buildResult(lei, decision, resolvedEntity, {
    entityStatus,
    registrationStatus,
    decisionReason: reason,
    mappingConfidence,
    alternateDefensibleDecision,
    resolvedEntityRaw,
    resolvedEntityNormalized,
    dataQualityFlags,
    bodyHash,
  });
}

// Exported for unit tests (Mode-A fixtures + checksum/normalization tests).
export { isValidLei, mod97, normalizeEntityName, mapDecision };
