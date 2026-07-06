# DNO — Consolidated Master Handoff

**Compiled:** 2026-07-06 · **Supersedes:** `DNO-MASTER-HANDOFF-2026-06-29.md`, `DNO-HEADER-NORMALIZATION-COMPLETE-HANDOFF-2026-07-01.md`, `DNO-PROJECT-HANDOFF-2026-07-01-full.md`, `DNO-Upgrade-Brainstorm-and-Execution-Prep-2026-06-26.md`
**Operator:** xm33 · **Roles:** Claude (strategic review / adjudication / sign-off) · Claude Code (file edits + local verification) · operator (deploy + browser verification)
**Governing document:** `CLAUDE PROJECT INSTRUCTIONS` (the DNO constitution). **The constitution wins over every handoff, including this one.**
**Production:** `demos-oracle.com`, served from n3 (`deploy@n3-AS1`, `/home/deploy/supercolony-node-health-agent`, `bun run src/agent.mjs`, systemd `node-health-agent.service`, port 55225). GitHub: `git@github.com:xm33/demos-network-oracle.git`, branch `master`.

> **How to use this doc.** It is the single starting point for any new chat on this project, regardless of topic. Read §0 first — it is the honesty ledger (what is *proven* done vs *claimed* done vs *gated*). Then jump to the section for your topic. Every claim marked ✅ was proven on the live/served surface or by git state; every ⚠️ is unverified-or-inherited and must be re-checked before it is relied on. **Live n3 and served bytes beat this document. If they conflict, they win, and this doc is wrong.**

---

## §0. NOT-PROVEN-DONE REGISTER (read this first)

This is the ledger the project's discipline exists to protect: things that were *claimed* done in a prior handoff but were **not actually proven**, and things still genuinely open. Recurring failure mode across this project: *deployed-but-not-committed* work, and *handoff line-numbers/status that drift from live state*.

### 0.1 Resolved this session (2026-07-06) — now proven

| Item | Prior claim | Actual state found | How closed / proof |
|---|---|---|---|
| **Header-normalization git state** | 07-01 handoff: "COMPLETE + DEPLOYED, **all committed to master**" | **FALSE as stated.** Repo showed `master` up-to-date with origin, yet **8 files / 276 uncommitted insertions** (the header diff) sat in the working tree, serving live. Phases 3+4, 7, 9 were marked "(committed)"/"(batched)" with **no commit hash** — those were the uncommitted ones. | Committed 2026-07-06 as **`0ecc6c2`** `style(site): normalize header/nav to canonical single-source across public surfaces` (8 files, 276/190). Proven: `git status` clean; `curl demos-oracle.com \| grep -c doc-nav-inner` = 3 unchanged (no restart → history-only change). ⚠️ **Local commit only — `origin/master` is 1 commit ahead-of/behind; NOT pushed.** |

### 0.2 Genuinely OPEN — unverified or un-adjudicated (do NOT treat as done)

| ID | Item | Why open / what's unproven | Blocking? |
|---|---|---|---|
| **O-1** | **DAHR attestation live state** | Must fetch `/health` `attestation` object on n3 *fresh each session*. As of 2026-07-06 it was `available:false, last_count:0, last_ok_at:null` (verified). This is the objective trigger for O-2. **Re-fetch every session — it changes upstream.** | Decides O-2 |
| **O-2** | **"We attest" tagline (homepage:216)** | Constitution §3: the locked sentence "We observe. We attest. We explain." is approved *only where "attest" isn't misleading*; if source-attestation is unavailable, copy must distinguish publish-vs-attest. **The page already distinguishes** (line ~266 `.api-attestation` says "published on-chain (signed)"), so §3's condition is *arguably met* — but line 216's bare "We attest" still makes the stronger claim while `available:false`. **Operator decision 2026-07-01: LEFT AS-IS** (conscious, temporary; attestation expected back; avoid churn). **Pre-approved fallback if DAHR stays down: swap middle verb → "We publish."** NOT a live overclaim to fix blind; a consciously-parked exposure with an objective revisit trigger (O-1 flips `available:true` w/ recent `last_ok_at`). ⚠️ Do not "fix" this unprompted — it was adjudicated and parked on purpose. | No (parked) |
| **O-3** | **MINT DEMOS NODE NFT CTA** | Homepage hero + footer carry a `MINT DEMOS NODE NFT` CTA → `mint.demos.sh` (2 links, grep-confirmed live). **Operator decision (this session): DO NOT REMOVE.** But **not formally adjudicated** against §2.1/§7.4 (an action-nudge CTA vs. a link-out to Demos's own thing). Left by operator choice; the constitutional analysis is still owed if ever revisited. | No (operator-held) |
| **O-4** | **/community "approved"/admission language** | `/community` (generated in `agent.mjs`) uses "…not core network assessment until approved. Inclusion does not imply endorsement." "approved" is on the §2.5 **banned** list — BUT may be legitimate *disclaiming* (external approval) not DNO claiming to approve (§2.1 admission-actor). **Subtle; needs exact wording read + adjudication.** Greps queued, not run: `grep -on 'approved\|admission\|Inclusion does not imply' src/agent.mjs`. | No |
| **O-5** | **LIVE pill at 100% zoom** | Proven **byte-identical** in code across all 9 (md5 canonical). Apparent size diff = screenshot zoom artifact, not a code defect. 2-min forced-100%-zoom confirmation not done. Only reopen as code work if pills genuinely differ at identical zoom. | No |
| **O-6** | **`0ecc6c2` not pushed to origin** | The header-reconcile commit is local on n3 only. Operator call whether/when to `git push`. | No |
| **O-7** | **Untracked working-tree files on n3** | Left untracked (correctly): `DNO-MASTER-HANDOFF-2026-06-29.md`, `dahr-startProxy-escalation-to-demos.md`, `patch-*.mjs` (5 scratch patch scripts). Decide later: `.gitignore` the `patch-*.mjs`, or commit the escalation `.md`. A stray `This` phantom (paste-garble) may exist — `ls -la This`; `rm` if real, ignore if ghost. | No |

### 0.3 Primary-reference gap (methodological, per §7.1)

⚠️ The constitution §4 names **`DNO-Website-Redesign-Structured-Data-Handoff-2026-06-26.md`** as the blueprint to "read fully before proposing changes." **It is NOT present in accessible project files** — what exists is the *brainstorm-consolidation* of it (`DNO-Upgrade-Brainstorm-and-Execution-Prep-2026-06-26.md`) plus the master handoffs. Adequate for all hygiene/copy/adjudication work. **Necessary before any §6.2 JSON-LD or §6.3 Criteria Catalog build** — the full JSON-LD examples live in the handoff proper (per the consolidation's §4.2, "NOT in the handoff… must be reconstructed"). **Obtain or reconstruct it before Phase-1 structured-data work.**

---

## §1. What DNO is (the frame every decision is measured against)

DNO observes the Demos testnet from the outside and publishes machine-readable assessments of network health. It is **not** official Demos/KyneSys infrastructure, a validator gatekeeper, recommender, certifier, scoring engine, governance executor, or transaction participant.

**Central standard (constitution):** *DNO's public claims must never exceed what it can honestly assert from its designated vantage.*

**Allowed:** observe · describe · disclose · attest *when attestation actually exists* · explain uncertainty · publish machine-readable state · report whether disclosed criteria are met.
**Forbidden:** recommend / score / rank / certify / approve validators · predict outcomes · influence admission · auto-promote · act on the assessed set.

**Three layers (structurally separate, never merged):**
- **L1 — Public core assessment.** The public health view. Never contaminated by L3.
- **L2 — Commerce intelligence / GLEIF / DACS-adjacent.** Identity/verdict work. Philosophically related, structurally separate.
- **L3 — Private operator/fleet.** Diagnostics, reference nodes, internal monitoring. Never leaks to public surfaces.

**Banned public words (§2.5):** canonical/network truth, approved, certified, trusted, recommended, safe, best, score, ranking, validator quality.
**Required vocabulary:** core assessment · observed · reported · published criteria · meets published criteria · insufficient observation history · attestation unavailable · reachable/unreachable.

**The §11 winning standard — hold every change to it:**
> This system observes. It does not decide. Its claims are bounded. Its uncertainty is honest. Its public contract is stable. Its private data cannot contaminate its public assessment.

---

## §2. Current PROVEN state (verified this session or by git)

### 2.1 Live surface (verified 2026-07-06 against n3 / demos-oracle.com) ✅
- Service `active`; `demos-oracle.com/health` → `200`.
- `/health` `attestation`: `{available:false, last_count:0, last_ok_at:null}` — DAHR still down (O-1).
- Homepage: `We attest` present ×1 (the locked tagline, line 216 — parked O-2); `mint`/`mint.demos.sh` present (O-3); **zero** matches for `predictive`/`warning`/`one truth`/`resolving truth`/`network truth` — the forbidden "Predictive Warning" surface is confirmed **gone** (a prior "ready-but-unconfirmed" item, now proven shipped).
- Header canonical serving: `doc-nav-inner` ×3, `canonical-header-css v1` present.

### 2.2 Header normalization — COMPLETE, DEPLOYED, and now COMMITTED ✅
Nine public surfaces render one canonical header (logo, LIVE pill, nav, "powered by DEMOS" badge, 1100px width, Inter/Source-Code-Pro fonts). Single source: `commerce.html` marked region (`BEGIN canonical-header v1` / `-css v1`). The 7 statics carry it inline (md5-identical); the 2 generated pages (`/community`, `/timeline`) capture `CANONICAL_HEADER_CSS`/`CANONICAL_LOGO_SVG`/`DEMOS_BADGE` from `COMMERCE_HTML` via boot-time regex in `agent.mjs`, so they cannot drift.
- **Canonical CSS md5 (all 9 identical — invariant):** `816767c5ab5918fa61c63eef4fddaa4c`. Any future header change must keep this uniform across all 9 or the header has desynced.
- **Commits:** `989f60d`, `fc89638` (.gitignore), `fd30966`, `4135c64`, `b53357d`, `e217531` (phases 1/2/5/6/8) **+ `0ecc6c2`** (this session — the phase 3+4/7/9 changes that were deployed-but-uncommitted).
- **Locked values:** LIVE dot literal `#00DAFF` (never `var(--improving)`); nav UPPERCASE site-wide; `border-bottom:none` on brand+link; active nav `opacity:0.5`; content 1100px everywhere except submit form (620px, intentional).

### 2.3 Prior-session overclaim cleanup — PROVEN (06-29 master, spot-verified) ✅
- Attestation *banner/signal-card* overclaim fixed 2026-06-26 (`747783a`): "attested on-chain"→"published on-chain (signed)", `available:false`-honest. (This is distinct from O-2, the tagline, which `747783a` deliberately left: "Voice line and mint links unchanged — separate scope.")
- Dead recommend/score/predict functions removed (`getRecommendation`/`generateDecision`/`generateScores`) — carried forbidden shapes, 0 call-sites.
- C-3 local-node self-report (hardcoded `syncOk=true`) → observed tri-state (`null`=unknown).
- A-2 reachability wording + neutral dot on the monitored-node table.
- C-2 incident immutability verified (no edit needed). G-1 `truncId` dedupe.
- `/about-demos` explainer v1.2 live, out for community review.

### 2.4 Test/deploy invariants ✅
Full suite **59/59** at every deploy, incl. 4 constitutional guards: L1 observation isolation, display privacy, DAHR attestation honesty, chain-mismatch honesty. Every 2026-07-01 change was presentation-only (CSS/markup/font/copy); none touched watch-only posture, layer separation, or language discipline.

---

## §3. OPEN WORKSTREAMS (the actual project spine, per constitution §5–6)

**All of these are the real project; the header + copy audits were tactical slices. Status is honest, not aspirational.**

| ID | Workstream | Constitution | Status | Gate / next |
|---|---|---|---|---|
| **W-1** | Structured data / JSON-LD (`Dataset`, `DataDownload`, `Observation`, `StatisticalVariable`, `DefinedTermSet`) | §6.2 | **NOT STARTED** | ⚠️ Blocked on **C-1** (endpoint contract, below) AND the missing §4 primary handoff (§0.3). Must not exceed API contract. Start point: `/about-demos` `DefinedTermSet` v2 (drafted, held). |
| **W-2** | Criteria Catalog — citable reference surface | §6.3 | **NOT STARTED** | Definitions **only**, never ranking/approval. `meets_published_criteria` shown as "insufficient observation history" until Phase-2 gate. |
| **W-3** | Website design/hierarchy (hero, trust pillars, metric cards, tables, tokens, responsive) | §6.1 | Header slice DONE; broader redesign OPEN | Needs the §4 blueprint. Remove stale/overclaiming Framer copy. |
| **W-4** | Messaging/copy precision — full sweep | §6.4 | Audit STARTED (O-2/O-3/O-4 are the first cuts) | Extend the method: claim vs. live state vs. constitution, across all surfaces. |
| **W-5** | Governance/versioning (methodology/criteria/contract versions, changelog, effective dates) | §6.5 | Partial (methodology v1.0 exists) | Lightweight, solo-operator; as demand appears. |

### 3.1 GATED — do NOT build (discipline, not backlog)
- **C-1 — `/organism` vs `/health` consumer architecture.** Quantified: `/organism` = 17 contract-bound fields (incl. `summary`); `/health` = richer, non-contract, adds `attestation`/`publicNodes`/`validator_growth` **and** internal-ish `instance_role`/`legacy`/`discoveredPeers`. The site's live data (`publicNodes`, `validator_growth`, `attestation`) exists **only on `/health`**. A JSON-LD `DataDownload` → `/organism` points agents at a surface *missing* the shown data; → `/health` ties the public contract to a non-contract endpoint exposing operational fields. **Decision deferred (06-29 master): neither expand `/organism` nor build `/public-status` until a real external consumer exists.** Trigger: first concrete external consumer (agent/oracle/citation tooling actually reading it). **C-1 is a Phase-1 prerequisite for W-1, not a Phase-0 item.**
- **Phase-2 observation evaluator** (`node_observations`/`observation_reset_events` tables exist; writer never wired in — correctly). Gate: date ≥2026-06-29 (now passed) **AND** Demos Kinesis-anchor reply (pending). Boundary confirmed with RB: "DNO is pure observer"; safe roles = publish-methodology + witness-already-promoted-set only. See `DNO-Phase3-evaluator-boundary-study-v2-2026-06-30.md`, `demos-boundary-commitment-ask-2026-06-30.md`.
- **D-1 auto-promotion** — pending Demos reply. Forbidden as an actor role regardless.
- **Advanced semantic web (SHACL/RDF/SPARQL)** §6.7 — future only; do not prioritize without a real external-consumer need. SPARQL endpoint = reject near-term (new attackable/uptime surface); SHACL = defer (contract test already validates).

### 3.2 READY — operator judgment, not builds
- **B-1 — DAHR `startProxy` escalation.** Drafted, leakage-clean, saved on n3 (`dahr-startProxy-escalation-to-demos.md`). Upstream SDK fault (`Failed to create proxy session`, every ~20s cycle); **not a DNO bug**; publishing unaffected. **Action: post as a `kynesyslabs/demosdk` GitHub issue** when timing suits (space from the `/about-demos` community message). Unblocks honest "attest" (O-2).
- **`/about-demos` community review.** Feedback incoming; evaluate against primary sources — apply protocol corrections (high value), resist "add roadmap/partners/token" promotion-drift (weigh vs. constitution first). Held follow-ups: nav link + JSON-LD `DefinedTermSet` v2.

---

## §4. DACS — separate track (Layer 2; NOT part of DNO website execution)

xm33 is a contributor/critical-reviewer on DACS (Demos Agent Commerce Standards). **This is parallel work; keep it off the DNO cognitive thread.** As of 2026-07-06 everything is landed/closed or owned by others:
- All xm33 contributions merged into v0.2/v0.3 spec: #178 GLEIF §7.4.1 (`MERGED→indeterminate`), #170 existence-vs-control, #161 SB-3 do-not-collapse, #179 pay-dem, #186 FeeSchedule (§9.7.2 FR-4), #190 private-deliverables (DV-1..6, incl. the DV-6 "ACL-dropped (channel-unreadable)" precision fix).
- **#170 vector-port (`vet-control-*` → golden) — mj-deving's PR #213**, xm33-verified (indeterminate arm present + golden-tier), signed off. cX3po's 3-impl cross-run unblocked when it merges.
- #146 GLEIF drift-testing closed (two-impl convergence, xm33 source-grounded). #25/#168 closed on xm33's reproductions.
- **Nothing owed.** Future touches are confirm-greps when others' artifacts land. Do not pull DACS into DNO sessions.

---

## §5. Verification method (how anything is "done") — constitution §7.1/§7.6

1. **Read-first.** View the live code/region and grep call-sites. Never edit from memory or a handoff line-number — **they drift** (proven repeatedly: the 07-01 "all committed" claim, stale line numbers, a "drafted" B-1 file that didn't exist).
2. **Deploy-loop STEP 0 (added this session — the lesson below).** Before any patch: `cd` to repo → `git status` (clean tree?) → `git log` on the target file (already shipped?) → check any target public string against §3 **locked-sentence list**. Anchor-uniqueness comes *after* these three. Any one would have prevented this session's line-216 misstep.
3. **Assert-guarded edit.** `scp`'d `bun` scripts that abort-before-write unless every guard passes (occurrence counts, 0 call-sites for removals, neighbours intact, brace balance). Paste-proof file > multi-line SSH paste (the latter desyncs quotes/escapes — it bit us repeatedly this session).
4. **Backup before write** on its own line (`cp … .pre-<phase>` / `.bak-<tag>-$(date +%s)`; literal `then` between commands breaks `cp`).
5. **Syntax gate before restart:** `bun build src/agent.mjs --target=bun` (the `--target=bun` flag is required; missing it → silent `bun:sqlite` short-circuit — `build-check` script closes that). Then `bun run test` (59/59). **Never restart on a red gate.**
6. **Prove on the SERVED surface, not the file.** `before 404 → after 200`; grep served bytes for required strings and for forbidden ones (=0). Public curl is the real proof. Static HTML = `readFileSync` at boot ⇒ **restart required**; the 2 generated pages never touch disk.
7. **Rollback path stated** (pinned backup filename, never a glob).

---

## §6. Durable lessons (methodology — do not relearn)

- **Deployed ≠ committed.** The top recurring hazard here. Work can be live-serving yet uncommitted; a stray `git add -A` then ships it under the wrong message. **Always `git add <explicit files>`, never `-A`.** Verify tree state before *and* after any commit. (This session: found 276 lines deployed-but-uncommitted; a prior handoff called them "committed.")
- **The confident handoff is the thing to verify, not trust.** "All committed", stale line-numbers, a "drafted" file that didn't exist, a locked sentence "needing a fix" that was already correctly handled — all inherited claims that were wrong. Re-grep/`git log`/read live every time.
- **Constitution locks some sentences.** "We observe. We attest. We explain." and "DNO informs context; it does not advise…" are §3-approved. Do not "fix" a locked sentence off a stale plan — check §3 first. (This session's line-216 misstep: I reverted it after catching that `747783a` already satisfied §3's distinguish-condition and the tagline was consciously parked.)
- **Service takes ~30–45s to serve HTTP after restart.** A 502/`000` immediately post-restart is BENIGN — the boot health cycle runs before the port binds. **Never re-restart on a 502** (resets the boot clock, guarantees another). One restart, wait ~60s, verify. `curl 000` = no connection (process down/not-yet-bound), distinct from a served error code.
- **Generated pages (`/community`, `/timeline`) hide drift.** Separate templates in `agent.mjs` with their own `:root`/body-font/width. Every late header bug lived here. When normalizing anything shared, check the `agent.mjs` template's surrounding context, not just the header CSS. `agent.mjs` resists CLI regex (giant single-line templates) — read it directly for boundary questions.
- **CC/AI summaries are not verification.** Independently re-grep before every commit (caught the dot drift and the Phase-9 serif trap where a naive `var(--sans)` swap would've dropped timeline to serif because its `:root` lacked `--sans`).
- **Proof-before-commit ordering:** `curl 200` → *then* `git commit`. Keep the curl on its own line; gate the commit on its result.
- **One command per SSH paste.** Multi-line pastes desync this session's shell (replayed output became phantom "command not found" storms). Slower, but the only verifiable way.
- **Proportionality.** Don't let the lowest-value item consume the most effort; suppression can beat surgery when the "problem" is an intentional setup.
- **zsh/Mac gotchas:** no inline `#` comments in pasted blocks; no stray trailing quotes (opens `dquote>`); prefix Mac repo commands with `cd ~/Projects/demos-network-oracle &&`; wrong-directory misfire is the #1 recurring error. `zz@Zans-Air` prompt = Mac (never patch here — can't build/test, missing `fleet.config.mjs`+demosdk); `deploy@n3-AS1` = n3 (patch + gate here).

---

## §7. Infrastructure facts (for the next session)

- **Repo root (n3):** `/home/deploy/supercolony-node-health-agent` · **Mac clone:** `~/Projects/demos-network-oracle`
- **Run:** `bun run src/agent.mjs` · **unit:** `node-health-agent.service` · **port:** `55225` · **public:** `demos-oracle.com` · **branch:** `master` · **remote:** `git@github.com:xm33/demos-network-oracle.git`
- **Static pages** (`readFileSync` at boot ⇒ restart to change): `homepage.html`, `methodology.html`, `sources.html`, `agent-guide.html`, `commerce.html`, `commerce-methodology.html`, `submit.html`, `about-demos.html`. **Generated** (in `agent.mjs`): `/community`, `/timeline` via `renderHeader(activeItem, farSlot)`.
- **Restart:** `sudo systemctl restart node-health-agent.service` — then wait ~45–60s before concluding anything.
- **Build/test gate is n3-side only** (Mac can't build/test). `bun build src/agent.mjs --target=bun` → `bun run test` (59/59) → restart.
- **Endpoints:** `/organism` (17 contract-bound fields, has `summary`) · `/health` (richer, non-contract, has `attestation`/`publicNodes`/`validator_growth` + internal fields; lacks `summary`) — see C-1.
- **DAHR:** SDK `@kynesyslabs/demosdk@4.0.8`; `startProxy` failing every cycle ("Failed to create proxy session"); **publishing unaffected** (signed posts land); escalation drafted (B-1).
- **GLEIF mapping (DNO `gleif-verify.mjs` = DACS-2 §7.4.1):** ISSUED→pass; LAPSED→indeterminate; ANNULLED/DUPLICATE/CANCELLED→fail; RETIRED→indeterminate (documented alt: fail); **MERGED→indeterminate**; unknown→indeterminate. `registration.status` primary, `entity.status` diagnostic.
- **n3 rollback anchors (header work):** `src/agent.mjs.pre-phase5/6/7/8/9`. Pin a specific filename when restoring (globs break `cp` on multiple matches).
- **Untracked on n3 (O-7):** `DNO-MASTER-HANDOFF-2026-06-29.md`, `dahr-startProxy-escalation-to-demos.md`, `patch-*.mjs` ×5.

---

## §8. Required first response when picking up the REDESIGN spine (constitution §9)

The header/copy work was tactical. When a session takes up the *real* redesign/structured-data spine (W-1..W-5), open with the constitution-mandated structured response, **after** obtaining the §4 primary handoff (§0.3):
1. One-paragraph strategic assessment · 2. Top 5 risks · 3. Top 5 highest-leverage improvements · 4. Recommended implementation phases · 5. Items to reject/defer · 6. Immediate next action.
Do not edit files until the assessment and prioritization are clear.

---

## §9. Session-start checklist (any topic)

1. **Re-fetch live state** (never inherit it): `curl -s https://demos-oracle.com/health` → check `attestation` (O-1); `curl -s https://demos-oracle.com/ | grep -c 'We attest'` / `mint` / forbidden words. Service `active`? `/health` = `200`?
2. **`git status`** on n3 — is the tree clean, or is there deployed-but-uncommitted drift (the recurring hazard)? Is `0ecc6c2` still local-only (O-6)?
3. **Pick the topic section** (§0 register → the relevant §3/§4 workstream). Confirm its status against live, not against this doc.
4. **If editing:** follow §5 deploy loop with STEP 0 (git status + git log + locked-sentence check) first.
5. **If it's a build item (W-1/W-2):** confirm it's not GATED (§3.1) and that the §4 primary handoff is in hand (§0.3) before starting.

---

## §10. The standard, restated (for every decision)

The winning DNO is not the one with the most features. It is the one where an outsider quickly understands: **it observes, it does not decide; its claims are bounded; its uncertainty is honest; its public contract is stable; its private data cannot contaminate its public assessment.** Measure every proposed change against that. If a change makes DNO more useful by making it more *active, authoritative, judgmental, or governance-like* — challenge or reject it. DNO's value is being a credible witness, not deciding what others should do.
