# Salus Clinical Trial Distribution × Demos DAHR — Research Plan

**Status:** Queued for later research
**Owner:** xm33
**Related:** Frank Demos deep-dive on Salus wholesale × Demos agent commerce (running 2026-10-29)
**Why separate:** Wholesale settlement and clinical-trial chain-of-custody are distinct enough to warrant their own pass.

---

## The thesis

Salus runs clinical trial distribution under license — temperature-controlled logistics, custody transfers, regulatory filings across CEE markets. DAHR turns any HTTPS endpoint into a signed, hash-anchored, on-chain attestation. If Salus can prove *when* a temperature log was true, *who* held custody at *which* timestamp, and *what* a regulator's registry said at the moment of a shipment, that proof becomes billable to trial sponsors — not just internal plumbing.

The four Demos questions as a lens throughout:
1. May an approved AI know it?
2. May the public know it?
3. May a subsystem use it?
4. May an actor act on it?
YES to 1 does not imply 4. Clinical-trial data is the sharpest test of this lens in the Salus stack.

---

## Research areas

### 1. Regulatory landscape for trial-distribution attestations
- EU Clinical Trial Regulation (CTR 536/2014) and Annex requirements for temperature monitoring and chain-of-custody records.
- How EMA / national competent authorities (JAZMP in Slovenia) treat electronic vs paper evidence in inspections.
- Whether a hash-anchored attestation is admissible as supplementary evidence or must be the system of record.
- GDPR interplay: trial participant data, pseudonymization, and what may legally be anchored on a public L1 vs kept on an L2PS subnet.
- US equivalent if Salus has FDA-regulated exposure: 21 CFR Part 11, DSCSA traceability for investigational products.

### 2. DAHR technical fit
- Can DAHR anchor a continuous temperature stream (IoT logger → HTTPS endpoint → hash) or only point-in-time snapshots?
- Batch vs streaming attestation: one hash per shipment leg vs per-reading anchoring. Cost and latency implications.
- Retention: how long must attestations remain verifiable? Map to EU CTR record-retention periods (typically 25+ years for trial master files).
- Integration surface: does Salus's existing warehouse management / TMS expose HTTPS endpoints today, or would this require new middleware?

### 3. Commercial model
- Who pays: the sponsor, the CRO, or Salus as value-add?
- Pricing: per-attestation, per-shipment, or subscription for a trial's full lifecycle?
- Competitive landscape: existing e-clinical supply vendors (e.g., Marken, PCI, Thermo Fisher) and whether any offer cryptographic attestation today.
- The pitch: "independent, tamper-evident proof that any counterparty or auditor can verify without calling Salus."

### 4. Legal exposure specific to this line
- Does anchoring trial-distribution events change Salus's classification under ZIUTK / MiCA? (Probably not — no custody of crypto, no service to others — but confirm.)
- Data-processing agreements with sponsors: does DAHR anchoring require new contractual language?
- Liability if an attestation is later found inaccurate: who bears it, Salus or the Demos network?

### 5. Pilot design (testnet era)
- Pick one trial lane, one product class, one market.
- Anchor: delivery receipt photo + GPS + temperature log hash + customs stamp, per shipment.
- Counterparty: one sponsor or CRO willing to verify attestations manually.
- Success metric: time-to-verify for the counterparty vs current PDF/email process.

---

## Open questions (surface, don't resolve)
- Is there any Slovenian or EU guidance on DLT evidence in GxP contexts?
- Does JAZMP have a position on electronic traceability systems beyond FMD?
- What does the Demos spec say about attestation of *continuous* data vs discrete events?
- Has any pharma company publicly piloted DLT chain-of-custody? (Verify before claiming.)

---

## Sequencing
1. Wait for Frank Demos wholesale briefing — avoid duplicated legal research.
2. Run this clinical-trial pass as a second Frank Demos task or a dedicated research session.
3. Cross-reference findings; merge into one Salus × Demos strategy doc if both pass.

---

*Not a legal opinion. Counsel review required before any pilot touches regulated trial data.*
