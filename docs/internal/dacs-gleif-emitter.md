# DACS GLEIF VerifyResult Emitter — Internal Conformance Instrument

**Layer:** 3 — private operator / conformance tooling
**Public surface:** none
**Scheduler:** none
**Storage:** none by default (local test artifacts only)
**Status:** built, proven (47/47 fixtures, Bun on n3), first live VerifyResult emitted + converges with PATH-OS

---

## What this is

A standalone module (`src/gleif-verify.mjs`) that, given a structurally valid LEI:

1. fetches the GLEIF public-authority record (record-by-id endpoint),
2. reads two status fields — `registration.status` (primary) and `entity.status` (context),
3. applies DNO's deterministic, source-grounded DACS-2 mapping,
4. emits a `VerifyResult` carrying the compared triple `claim + decision + resolvedEntity`, plus non-compared diagnostics.

It exists to support the **DACS-2 Vet drift-test** with PATH-OS Labs (DACS-Standard#146): two independent implementations verify the same LEI by their own paths and must converge on the deterministic verdict.

Invoke directly, or via the runner `tools/dacs-drift-runner.mjs`.

## What this is NOT

This tool does **not**:
- certify legal entities,
- recommend transactions or influence on-chain behaviour,
- score, rank, approve, deny, or bless counterparties,
- provide public validity signals or badges,
- replace GLEIF as the authority source,
- turn DNO into an entity-verification authority.

## The watch-only boundary (read this before changing anything)

DNO is **watch-only**. A `VerifyResult` is a structured *observation of what an authority reported*, under a deterministic mapping — NOT DNO's own judgment about the entity. The honest reading of any output is:

> DNO observed authority source GLEIF, received raw status fields, applied mapping version M, and produced DACS decision D for claim C.

It must never be presented — in copy, UI, or machine output — as:

> DNO certifies this entity. / DNO says this counterparty is safe to transact with.

The danger is not the logic; it is perception drift. A `pass` verdict reads as approval, and an agent consuming a public verdict could use it as a decision primitive (`if pass → transact`). Even careful framing gets collapsed by readers into "DNO says pass." That is why verdicts stay Layer 3.

## Runtime rules

| Aspect | Allowed | Forbidden (without a separate watch-only design review) |
|---|---|---|
| Invocation | on-demand / harness | scheduled execution |
| Storage | local test artifacts | any persistent or public verdict store |
| Surfacing | private operator/conformance contexts; GitHub conformance issues | any public or agent-facing endpoint, badge, or widget |
| Integration | explicit reviewed future consumer | accidental wiring into Layer 1/2 surfaces |
| Public examples | methodology only (the method, the enum, the philosophy) | real-LEI VerifyResults on demos-oracle.com, even one "example" |

Seeded/conformance example results belong in GitHub issues (e.g. #146) or private fixtures — **not** on any DNO public surface.

## Decision mapping (source-grounded — do not modify without re-running the drift-test)

Grounded in GLEIF LEI-CDF 3.1 + the State Transition & Validation Rules:

- `ISSUED` + entity not `INACTIVE` → `pass`
- `ISSUED` + entity `INACTIVE` → `indeterminate` (status conflict)
- `LAPSED` → `indeterminate` (GLEIF: a lapsed LEI remains valid)
- `RETIRED` → `indeterminate` — **Mode-B, the legitimate divergence point** (`alternateDefensibleDecision: fail`; a stricter "valid-and-current" reading gives fail)
- `ANNULLED` / `DUPLICATE` / `CANCELLED` → `fail` (GLEIF's three assignment-error states)
- `MERGED` → `indeterminate` (deprecated in LEI-CDF 3.1; low-confidence)
- `PENDING_*` / `TRANSFERRED` / unknown → `indeterminate` (never silently pass/fail; never `error` — the authority answered)

`registration.status` is primary; `entity.status` is decisive only in the `ISSUED + INACTIVE` conflict. Do not collapse LAPSED/RETIRED/MERGED into one rule — they are deliberately distinct (Mode-A / Mode-B-divergence / deprecated).

## For future operators

The hard part of this tool is not running it. The hard part is preserving **what it must never become.**

This was built for a specific conformance exercise. Its continued existence does not imply DNO should become a general LEI-verification service. Any expansion — scheduling, persistent storage, public exposure, agent-facing endpoints, new use cases — requires a fresh design review against DNO's watch-only and three-layer principles **before merging.** When in doubt, keep it small and private.
