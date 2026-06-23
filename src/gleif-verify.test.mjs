// gleif-verify.test.mjs — proof harness for the GLEIF emitter (spec §8).
//
// Two layers:
//   1. Pure-function tests (no network): checksum, normalization, decision map.
//      These prove the intellectual core deterministically.
//   2. Mode-A fixture tests: drive verifyLei end-to-end against RECORDED GLEIF
//      responses by stubbing global fetch. Offline + deterministic.
//
// The seeded ISSUED fixture is the real live record for 506700GE1G29325QX363.
// The status-conflict fixture is that record with entity.status flipped to
// INACTIVE (synthesized per spec §8). The no-record fixture is a 404.
// The LAPSED fixture is a real captured record (743700SEJ147Y3TSFE83), and the
// RETIRED fixture is a real captured record (9845006A7A5583CF9B64) — both frozen
// snapshots pulled live from n3 on 2026-06-19 (do NOT re-fetch at test time).
//
// Run:  bun gleif-verify.test.mjs   (or: node gleif-verify.test.mjs)

import { verifyLei, isValidLei, mod97, normalizeEntityName, mapDecision } from "./gleif-verify.mjs";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---- the real live seeded record (506700GE1G29325QX363), trimmed to fields we read ----
const SEEDED_RECORD = {
  meta: { goldenCopy: { publishDate: "2026-06-18T16:00:00Z" } },
  data: {
    type: "lei-records",
    id: "506700GE1G29325QX363",
    attributes: {
      lei: "506700GE1G29325QX363",
      entity: { legalName: { name: "Global Legal Entity Identifier Foundation", language: "de-CH" }, status: "ACTIVE" },
      registration: { status: "ISSUED", nextRenewalDate: "2027-03-15T00:00:00Z" },
    },
  },
};

// status-conflict = seeded record, entity.status -> INACTIVE (spec §8 synthesis)
const CONFLICT_RECORD = structuredClone(SEEDED_RECORD);
CONFLICT_RECORD.data.attributes.entity.status = "INACTIVE";

// LAPSED fixture — REAL captured record (743700SEJ147Y3TSFE83, "Dadaal Service Oy"),
// pulled live from n3 on 2026-06-19. Snapshot frozen here (do NOT re-fetch at test
// time — this entity may renew back to ISSUED). Note: registration LAPSED while
// entity ACTIVE — the exact "lapsed remains valid" case that proves registration.status
// must drive (else entity.status ACTIVE would wrongly yield pass).
const LAPSED_RECORD = {
  data: {
    type: "lei-records",
    id: "743700SEJ147Y3TSFE83",
    attributes: {
      lei: "743700SEJ147Y3TSFE83",
      entity: { legalName: { name: "Dadaal Service Oy", language: "fi" }, status: "ACTIVE" },
      registration: { status: "LAPSED", nextRenewalDate: "2026-06-17T09:00:00Z" },
    },
  },
};

// RETIRED fixture — REAL captured record (9845006A7A5583CF9B64,
// "ΤΑΜΕΙΟ ΠΡΟΝΟΙΑΣ ΕΡΓΑΤΩΝ ΔΗΜΟΥ ΑΓΛΑΝΤΖΙΑΣ"), pulled live from n3 on 2026-06-19;
// Raw response frozen in fixtures/gleif-raw/ (+ manifest.json: bodyHash is provenance, verdictFields are the invariant). A GLEIF golden-copy republish moves bodyHash, not the verdict.
// Snapshot frozen (terminal status — RETIRED via a COMPLETED dissolution won't flip
// back). Two things this row proves that LAPSED doesn't: (1) the RETIRED →
// indeterminate / alt-fail / confidence-B verdict end-to-end, and (2) NFC handling
// on a non-Latin (Greek) entity name (raw == normalized, no case-fold/accent-strip).
// entity.eventGroups is retained (not read by the emitter) as the in-record grounding
// for the lifecycle-end reading — asserted separately as input, not emitter output.
const RETIRED_RECORD = {
  data: {
    type: "lei-records",
    id: "9845006A7A5583CF9B64",
    attributes: {
      lei: "9845006A7A5583CF9B64",
      entity: {
        legalName: { name: "ΤΑΜΕΙΟ ΠΡΟΝΟΙΑΣ ΕΡΓΑΤΩΝ ΔΗΜΟΥ ΑΓΛΑΝΤΖΙΑΣ", language: "el" },
        status: "INACTIVE",
        eventGroups: [
          { groupType: "STANDALONE", events: [
            { type: "DISSOLUTION", status: "COMPLETED", effectiveDate: "2026-03-19T00:00:00Z" },
          ] },
        ],
      },
      registration: { status: "RETIRED", nextRenewalDate: "2027-06-15T13:47:42Z" },
    },
  },
};

// Install a fetch stub keyed by LEI -> { status, jsonBody }.
function stubFetch(map) {
  globalThis.fetch = async (url) => {
    const lei = String(url).split("/").pop();
    const entry = map[lei];
    if (!entry) return new Response("", { status: 404 });
    const bodyStr = entry.body == null ? "" : JSON.stringify(entry.body);
    return new Response(bodyStr, { status: entry.status, headers: { "Content-Type": "application/vnd.api+json" } });
  };
}

(async () => {
  console.log("\n# 1. Pure-function tests\n");

  // -- LEI checksum (ISO 7064 MOD 97-10) --
  check("seeded LEI is valid", isValidLei("506700GE1G29325QX363"));
  eq("mod97 of valid LEI == 1", mod97("506700GE1G29325QX363"), 1);
  check("wrong-length rejected", !isValidLei("506700GE1G29325QX36"));
  check("lowercase rejected", !isValidLei("506700ge1g29325qx363"));
  check("bad check digits rejected", !isValidLei("506700GE1G29325QX300"));
  check("non-string rejected", !isValidLei(12345));
  check("empty rejected", !isValidLei(""));

  // -- normalization (NFC + trim + collapse; NOT case-fold/accent-strip) --
  eq("collapse + trim", normalizeEntityName("  ACME   Ltd. "), "ACME Ltd.");
  eq("accents preserved", normalizeEntityName("ČEZ"), "ČEZ");
  eq("case preserved", normalizeEntityName("Acme LTD"), "Acme LTD");
  eq("null in -> null out", normalizeEntityName(null), null);
  eq("whitespace-only -> null", normalizeEntityName("   "), null);
  // NFC: decomposed é (e + combining acute) must fold to composed é, same length-1 grapheme
  eq("NFC composes", normalizeEntityName("e\u0301"), "\u00e9");

  // -- decision map (the intellectual core, §5) --
  eq("ISSUED+ACTIVE -> pass", mapDecision("ISSUED", "ACTIVE").decision, "pass");
  eq("ISSUED+INACTIVE -> indeterminate", mapDecision("ISSUED", "INACTIVE").decision, "indeterminate");
  eq("ISSUED+NULL -> pass", mapDecision("ISSUED", "NULL").decision, "pass");
  eq("LAPSED -> indeterminate", mapDecision("LAPSED", "ACTIVE").decision, "indeterminate");
  eq("RETIRED -> indeterminate", mapDecision("RETIRED", "INACTIVE").decision, "indeterminate");
  eq("RETIRED alt = fail", mapDecision("RETIRED", "INACTIVE").alternateDefensibleDecision, "fail");
  eq("RETIRED confidence B", mapDecision("RETIRED", "INACTIVE").mappingConfidence, "B");
  eq("ANNULLED -> fail", mapDecision("ANNULLED", "ACTIVE").decision, "fail");
  eq("DUPLICATE -> fail", mapDecision("DUPLICATE", "ACTIVE").decision, "fail");
  eq("CANCELLED -> fail", mapDecision("CANCELLED", "ACTIVE").decision, "fail");
  eq("MERGED -> indeterminate", mapDecision("MERGED", "INACTIVE").decision, "indeterminate");
  eq("PENDING_TRANSFER -> indeterminate", mapDecision("PENDING_TRANSFER", "ACTIVE").decision, "indeterminate");
  eq("TRANSFERRED -> indeterminate", mapDecision("TRANSFERRED", "ACTIVE").decision, "indeterminate");
  eq("unknown -> indeterminate", mapDecision("WITHDRAWN_CANCELLED", "ACTIVE").decision, "indeterminate");
  eq("unknown confidence D", mapDecision("ZZZ_FUTURE", "ACTIVE").mappingConfidence, "D");
  // primary/precedence: a non-ISSUED reg status is NOT overridden by ACTIVE entity
  eq("ANNULLED+ACTIVE still fail", mapDecision("ANNULLED", "ACTIVE").decision, "fail");

  console.log("\n# 2. Mode-A fixtures (end-to-end, offline)\n");

  // Fixture 1: ISSUED (seeded) -> pass + resolvedEntity
  // Fixture 5: status-conflict -> indeterminate
  // Fixture 3: no-record (404) -> fail
  // Fixture 4: malformed -> null
  stubFetch({
    "506700GE1G29325QX363": { status: 200, body: SEEDED_RECORD },
    "CONFLICT00000000CONF": { status: 200, body: CONFLICT_RECORD }, // not a real checksum; see note
  });

  const seeded = await verifyLei("506700GE1G29325QX363");
  eq("[seeded] decision", seeded?.decision, "pass");
  eq("[seeded] resolvedEntity", seeded?.resolvedEntity, "Global Legal Entity Identifier Foundation");
  eq("[seeded] claim.identifier", seeded?.claim?.identifier, "506700GE1G29325QX363");
  eq("[seeded] claim has exactly 2 keys", Object.keys(seeded?.claim ?? {}).length, 2);
  eq("[seeded] registrationStatus diag", seeded?.diagnostics?.registrationStatus, "ISSUED");
  eq("[seeded] entityStatus diag", seeded?.diagnostics?.entityStatus, "ACTIVE");
  check("[seeded] bodyHash present", typeof seeded?.diagnostics?.bodyHash === "string" && seeded.diagnostics.bodyHash.startsWith("sha256:"));

  // no-record: a well-formed LEI the stub doesn't know -> 404 -> fail
  // (use a real-checksum LEI that won't be in the map)
  const noRecLei = "529900T8BM49AURSDO55"; // valid checksum, not in stub -> 404
  const noRec = await verifyLei(noRecLei);
  eq("[no-record] decision", noRec?.decision, "fail");
  eq("[no-record] resolvedEntity null", noRec?.resolvedEntity, null);
  eq("[no-record] reason", noRec?.diagnostics?.decisionReason, "no_record_found");

  // malformed -> null (no VerifyResult)
  const malformed = await verifyLei("NOTALEI");
  eq("[malformed] returns null", malformed, null);

  // status-conflict: drive the real decision path with the CONFLICT record.
  // We bypass the checksum gate by verifying the mapping directly already (above),
  // and here prove the end-to-end wiring reads entity.status INACTIVE correctly
  // by stubbing a VALID-checksum LEI to return the conflict body.
  stubFetch({ "506700GE1G29325QX363": { status: 200, body: CONFLICT_RECORD } });
  const conflict = await verifyLei("506700GE1G29325QX363");
  eq("[status-conflict] decision", conflict?.decision, "indeterminate");
  eq("[status-conflict] reason", conflict?.diagnostics?.decisionReason, "status_conflict_issued_entity_inactive");

  // Fixture 2 (LAPSED): real captured record, registration LAPSED + entity ACTIVE.
  // Proves registration.status drives (ACTIVE entity does NOT yield pass).
  stubFetch({ "743700SEJ147Y3TSFE83": { status: 200, body: LAPSED_RECORD } });
  const lapsed = await verifyLei("743700SEJ147Y3TSFE83");
  eq("[lapsed] decision", lapsed?.decision, "indeterminate");
  eq("[lapsed] reason", lapsed?.diagnostics?.decisionReason, "registration_lapsed_valid_not_current");
  eq("[lapsed] registrationStatus diag", lapsed?.diagnostics?.registrationStatus, "LAPSED");
  eq("[lapsed] entityStatus diag (ACTIVE, not overridden)", lapsed?.diagnostics?.entityStatus, "ACTIVE");
  eq("[lapsed] resolvedEntity present", lapsed?.resolvedEntity, "Dadaal Service Oy");

  // Fixture 6 (RETIRED): real captured record, registration RETIRED + entity INACTIVE,
  // grounded by a COMPLETED DISSOLUTION event. Proves the lifecycle-end verdict
  // (indeterminate, alt-fail defensible, confidence B) AND non-Latin NFC handling.
  const GREEK = "ΤΑΜΕΙΟ ΠΡΟΝΟΙΑΣ ΕΡΓΑΤΩΝ ΔΗΜΟΥ ΑΓΛΑΝΤΖΙΑΣ";
  stubFetch({ "9845006A7A5583CF9B64": { status: 200, body: RETIRED_RECORD } });
  const retired = await verifyLei("9845006A7A5583CF9B64");
  // -- emitter output --
  eq("[retired] decision", retired?.decision, "indeterminate");
  eq("[retired] reason", retired?.diagnostics?.decisionReason, "registration_retired_lifecycle_end");
  eq("[retired] registrationStatus diag", retired?.diagnostics?.registrationStatus, "RETIRED");
  eq("[retired] entityStatus diag", retired?.diagnostics?.entityStatus, "INACTIVE");
  eq("[retired] mappingConfidence B", retired?.diagnostics?.mappingConfidence, "B");
  eq("[retired] alternateDefensibleDecision fail", retired?.diagnostics?.alternateDefensibleDecision, "fail");
  eq("[retired] resolvedEntity (Greek)", retired?.resolvedEntity, GREEK);
  eq("[retired] resolvedEntityRaw (Greek)", retired?.diagnostics?.resolvedEntityRaw, GREEK);
  eq("[retired] NFC: normalized == raw (no fold/strip)", retired?.diagnostics?.resolvedEntityNormalized, GREEK);
  check("[retired] dataQualityFlags empty", Array.isArray(retired?.diagnostics?.dataQualityFlags) && retired.diagnostics.dataQualityFlags.length === 0);
  check("[retired] bodyHash present", typeof retired?.diagnostics?.bodyHash === "string" && retired.diagnostics.bodyHash.startsWith("sha256:"));
  // -- in-record grounding (INPUT, not emitter output): the dissolution event that
  //    makes this lifecycle-end (indeterminate) rather than assignment-error (fail) --
  const retEvent = RETIRED_RECORD.data.attributes.entity.eventGroups?.[0]?.events?.[0];
  check("[retired] grounding: record carries DISSOLUTION/COMPLETED",
    retEvent?.type === "DISSOLUTION" && retEvent?.status === "COMPLETED");

  console.log(`\n----\n${passed} passed, ${failed} failed${failed ? "" : "  ✓ all green"}\n`);
  if (failed) process.exit(1);
})();
