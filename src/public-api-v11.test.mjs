// public-api-v11.test.mjs — PUBLIC_API_V11 guard: the 1.1 additions (catalog, exact lookup, condition records,
// height movement, conditional GET), the 1.2 additions (witnesses, the standstill limit) and the homepage that renders them.
// Static part: homepage.html against agent.mjs (server-side fill markers, mark asset, ban list).
// Served part: every public representation of the new data, against a running agent.
// Run:  bun src/public-api-v11.test.mjs [baseUrl]   (executable harness, not `bun test`)
//       bun src/public-api-v11.test.mjs --static    the static part only: needs no running agent (before a restart)

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cycleLead } from "./home-cycle.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const HOME = readFileSync(join(ROOT, "homepage.html"), "utf8");
const STATIC_ONLY = process.argv.includes("--static");
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) || "http://localhost:55225";
const TAG = "PUBLIC_API_V11";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const count = (hay, needle) => hay.split(needle).length - 1;
const FULL_ID = /0x[0-9a-fA-F]{64}/;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const HOSTPORT = /[a-z0-9.-]+:\d{4,5}\b/i;
const BANNED = /\b(approved|certified|trusted|recommended|safe|best|scores?|ranking|ranked|network truth|canonical truth|sanctions-clean|compliant|ready)\b/i;
const ALLOWED = ["Neither is a score or a go/no-go.", "DNO informs context; it does not advise, predict, score, certify, or decide action."];
function withoutAllowed(s) { for (const a of ALLOWED) s = s.split(a).join(""); return s; }
function keysDeep(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { out.push(k); keysDeep(v[k], out); }
  return out;
}
function stringsDeep(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsDeep(x, out));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { out.push(k); stringsDeep(v[k], out); }
  return out;
}

console.log("\n[" + TAG + "] static: homepage.html and agent.mjs agree");
// The agent fills these markers for readers without JavaScript; a marker that drifts is silently not filled.
const card = (key, label) => '<div data-card="' + key + '"><p class="k">' + label + '</p><p class="v"><span class="ind" data-tone="pending"></span><span class="val">reading</span></p><p class="s" data-src="api"></p>';
const MARKERS = [
  '<div class="panel" id="panel" data-state="pending">',
  '<span class="ind" id="status-ind" data-tone="pending"></span><span id="status-value">READING</span>',
  '<p class="cycle-lead" id="cycle-lead" data-src="api">ACTIVE on chain: reading.</p>',
  '<p class="seeds" id="seeds-line" aria-live="polite">The first request to /organism is in flight.</p>',
  '<p class="insufficient" id="insufficient" hidden>',
  '<span class="ind" id="ag-ind" data-tone="pending"></span><span id="ag-state">reading</span>',
  '<span id="live-text">connecting</span>',
  card("trend", "trend"), card("risk", "risk"), card("confidence", "confidence"), card("data_quality", "data quality")
];
const VW_MARKER = '<p class="note" id="vw-line">Validator counts are published on <a href="/health">/health</a> as on_chain_validators and validator_watch.</p>';
MARKERS.forEach((m, i) => check("H" + (i + 1) + " fill marker present once: " + m.slice(0, 48), count(HOME, m) === 1, "count " + count(HOME, m)));
check("H25 validators line: marker present once, and the agent fills it from the same text", count(HOME, VW_MARKER) === 1 && SRC.includes("validators: '" + VW_MARKER + "'"), "count " + count(HOME, VW_MARKER));
const DOOR_MARKER = '<span id="door-n"></span>';
check("H26 This cycle door: the peer-listed count marker present once, and the agent fills it", count(HOME, DOOR_MARKER) === 1 && SRC.includes("door: '" + DOOR_MARKER + "'"), "count " + count(HOME, DOOR_MARKER));
check("H27 This cycle card: no 'nodes aligned' and no calm or status-reason line in the page", !/nodes aligned/.test(HOME.slice(HOME.indexOf('id="panel"'), HOME.indexOf('id="cards"'))) && !HOME.includes('id="calm"') && !HOME.includes('id="status-reason"'));
check("H12 agent builds the same markers", MARKERS.slice(0, 7).every((m) => SRC.includes(JSON.stringify(m).slice(1, -1).replace(/\\"/g, '"')) || SRC.includes("'" + m + "'")));
const markSha = createHash("sha256").update(readFileSync(join(ROOT, "assets", "dno-mark.jpg"))).digest("hex");
const shaInSrc = (SRC.match(/MARK_ASSET_SHA256 = "([0-9a-f]{64})"/) || [])[1];
check("H13 assets/dno-mark.jpg is the locked mark the agent serves", !!shaInSrc && markSha === shaInSrc, markSha.slice(0, 12));
check("H14 homepage references the mark asset path", HOME.includes('href="/assets/dno-mark-' + markSha.slice(0, 8) + '.jpg"') && !HOME.includes("data:image/jpeg"));
check("H15 homepage reads the same origin", HOME.includes("const SERVED_BY_AGENT = true;"));
const homeText = withoutAllowed(HOME);
check("H16 homepage: no banned word", !BANNED.test(homeText), (homeText.match(BANNED) || [])[0]);
check("H17 homepage: no IPv4 literal, no full identity, no Demos violet", !IPV4.test(HOME) && !FULL_ID.test(HOME) && !/#2B36D9/i.test(HOME));
check("H18 homepage: no old seed sentence (DNO dials more than the seeds)", !HOME.includes("only endpoints DNO dials"));
check("H19 lookup is requested in one place, inside the explicit button's handler", count(HOME, "getJSON('/catalog/lookup") === 1
  && /\$\('lookup-btn'\)\.addEventListener\('click', async \(\) => \{[^}]*?getJSON\('\/catalog\/lookup\?key='/.test(HOME));
// R2: what a peerlist's readiness flag means has not been confirmed on a real /info, so it is on no public surface.
// The validator changes when a reading turns stale: the body then says unknown, so a 304 for the body that said
// "stable" would be wrong. Runs the shipped function and the body's own test with a fixed clock: the two must turn at
// the same instant (the body rounds to whole seconds, so that is 300.5 s, not 300.0 s).
{
  const i = SRC.indexOf("  function observationValidators(route) {"), fn = SRC.slice(i, SRC.indexOf("\n  }\n", i) + 5);
  const g = SRC.indexOf("function getStaleness() {"), stalenessFn = SRC.slice(g, SRC.indexOf("\n}\n", g) + 3);
  const limit = Number(SRC.match(/const PUBLIC_STALE_AFTER_SECONDS = (\d+);/)[1]);
  const at = Date.UTC(2026, 9, 1, 12, 0, 0);
  const tagAt = (now, route, round) => new Function("lastPublicObservedAt", "cycleCount", "latestValidatorRound", "Date", "PUBLIC_STALE_AFTER_SECONDS", stalenessFn + fn + "\nreturn observationValidators;")(
    at, 7, round || null, class extends Date { static now() { return now; } }, limit)(route);
  // The body's test, as computeCanonicalState writes it.
  const bodyRule = SRC.match(/var stalenessSeconds = Math\.max\(0, Math\.round\(\(nowMs - \(observedAtMs \|\| AGENT_STARTED_AT\)\) \/ 1000\)\);/) && /else if \(stalenessSeconds > PUBLIC_STALE_AFTER_SECONDS\) dataQualityReason = "stale";/.test(SRC);
  const bodyStale = (now) => Math.max(0, Math.round((now - at) / 1000)) > limit;
  const fresh = tagAt(at + 299000, "organism"), stale = tagAt(at + 301000, "organism"), later = tagAt(at + 900000, "organism");
  check("H19b the ETag is the same while a reading is fresh, changes once when it turns stale, and then stays",
    i > 0 && g > 0 && limit === 300 && stale.etag !== fresh.etag && later.etag === stale.etag && /-stale"$/.test(stale.etag) && stale.lastModified === fresh.lastModified, JSON.stringify([fresh, stale]));
  const around = [299999, 300000, 300001, 300013, 300250, 300492, 300499, 300500, 300501, 301000];
  check("H19c the ETag turns stale at the same instant as the body, not half a second before it",
    !!bodyRule && around.every((d) => /-stale"$/.test(tagAt(at + d, "organism").etag) === bodyStale(at + d)) && !bodyStale(at + 300499) && bodyStale(at + 300500),
    JSON.stringify(around.map((d) => [d, /-stale"$/.test(tagAt(at + d, "organism").etag), bodyStale(at + d)])));
  // Each route computes its validators once, before its body, and sends them with the 200. Computed again after the
  // body, a stale ETag could go out with a body that was built while the reading was still fresh.
  const routeBody = (path) => { const a = SRC.indexOf('reqPath === "' + path + '") {'); return SRC.slice(a, SRC.indexOf("} else if (reqPath ===", a + 10)); };
  const once = (path, name, firstBodyCall) => { const b = routeBody(path), calls = b.split('observationValidators("' + name + '")').length - 1; return calls === 1 && b.indexOf('observationValidators("' + name + '")') < b.indexOf(firstBodyCall); };
  check("H19e /organism, /health and /catalog each compute their validators once, before the body",
    once("/organism", "organism", "computeCanonicalState()") && once("/health", "health", "computeCanonicalState()") && once("/catalog", "catalog", "getPublicCatalog()"),
    JSON.stringify(["/organism", "/health", "/catalog"].map((p) => routeBody(p).split("observationValidators(").length - 1)));
  check("H19d /health keeps its validator-round part after the stale mark", tagAt(at + 301000, "health", { roundAt: 5 }).etag === 'W/"health-' + at + '-7-stale-v5"' && tagAt(at + 1000, "health", { roundAt: 5 }).etag === 'W/"health-' + at + '-7-v5"');
}
check("H20 no readiness flag in public output (toPublicPeer, catalog rows, validator_growth rows)", !/readiness_flag\s*:|reported_readiness_flag|reported_ready\b/.test(SRC)
  && !/^\s+ready: /m.test(SRC.slice(SRC.indexOf("function toPublicPeer"), SRC.indexOf("function toPublicPeer") + 900)));

check("H21 homepage has no Attest tagline and no /dashboard link", !/Observe\. Attest\. Explain\./.test(HOME) && !/href="\/dashboard"/.test(HOME));
// The homepage header and the site kit's header list the same links in the same order.
const navAgent = [...SRC.slice(SRC.indexOf("var SITE_NAV = ["), SRC.indexOf("];", SRC.indexOf("var SITE_NAV = ["))).matchAll(/\["(\/[a-z\/-]+)", "[a-z-]+", "([^"]+)"\]/g)].map((m) => m[1] + " " + m[2]);
const navHome = [...(HOME.match(/<nav class="nav" aria-label="Primary">([\s\S]*?)<\/nav>/) || ["", ""])[1].matchAll(/<a href="(\/[a-z\/-]+)">([^<]+)<\/a>/g)].map((m) => m[1] + " " + m[2]);
check("H22 homepage nav = site nav", navAgent.length === 7 && JSON.stringify(navAgent) === JSON.stringify(navHome), navHome.join(", "));
const kitCss = readFileSync(join(ROOT, "assets", "site.css"), "utf8");
const chrome = kitCss.slice(kitCss.indexOf("/* chrome:start */"), kitCss.indexOf("/* chrome:end */"));
check("H23 homepage inlines the site kit's chrome CSS verbatim", chrome.length > 1000 && HOME.includes(chrome));
// Owner ruling of 2026-09-29: last_count counts relays that returned a transaction hash; the reading is never posted.
check("H24 the DAHR sentence is conditional and exact", HOME.includes("This cycle, DAHR was attempted on the cross-check RPCs, not on the seeds whose answers enter status. last_count is how many of those relays returned a transaction hash.") && HOME.includes("' DNO\\'s own on-chain posts are disabled; the reading is never posted.'") && HOME.includes("' The reading is never posted.'") && HOME.includes("'DAHR attestation unavailable.'") && !HOME.includes("returned an attestation object"));
if (STATIC_ONLY) {
  console.log("\n[" + TAG + "] served checks skipped (--static)");
  console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}
console.log("\n[" + TAG + "] served (base: " + BASE + ")");
async function get(path, headers) { const r = await fetch(BASE + path, { headers: headers || {} }); let body = null; try { body = await r.clone().json(); } catch (e) { body = await r.text(); } return { status: r.status, headers: r.headers, body }; }
try {
  const org = await get("/organism");
  const o = org.body;
  check("S1 api_version 1.2", o.api_version === "1.2", o.api_version);
  check("S2 additive fields typed", (o.observed_at === null || typeof o.observed_at === "string")
    && (o.height_static_seconds === null || Number.isInteger(o.height_static_seconds))
    && Number.isInteger(o.active_public_conditions) && o.active_public_conditions >= 0
    && [null, "no_observation", "stale", "too_few_answers", "too_few_heights"].includes(o.data_quality_reason));
  check("S3 data_quality_reason set exactly when insufficient", (o.data_quality === "insufficient") === (o.data_quality_reason !== null));
  const etag = org.headers.get("etag");
  const again = etag ? await get("/organism", { "If-None-Match": etag }) : { status: 0 };
  check("S4 conditional GET answers 304", !!etag && again.status === 304, etag + " -> " + again.status);

  const health = (await get("/health")).body;
  const ag = health.agreement || {};
  check("S5 agreement in the unknown state carries no comparison", ag.state !== "unknown" || (ag.aligned_nodes === null && ag.block_spread === null));
  const vg = health.validator_growth || {};
  const rows = (vg.validators || []).filter((v) => !v.monitored);
  check("S6 catalog rows in /health carry the 1.1 fields", rows.every((v) => typeof v.listed_this_cycle === "boolean" && Number.isInteger(v.listed_by) && "first_seen" in v && "last_listed" in v && !("reported_readiness_flag" in v) && "reported_sync_status" in v), rows.length + " rows");
  check("S7 rows not listed this crawl carry no reported values", rows.filter((v) => !v.listed_this_cycle).every((v) => v.block === null && v.online === false && v.reported_sync_status === null && v.sync_pct === null));
  check("S8 listed_by never exceeds public peerlists read", rows.every((v) => v.listed_by <= (vg.public_peerlists_read || 0)));

  const cat = (await get("/catalog")).body;
  const ROW_KEYS = "display,first_seen,identity_truncated,last_listed,listed_by,listed_this_cycle,reported";
  check("S9 /catalog scope and crawl block", cat.scope === "retained_catalog" && cat.crawl && "public_peerlists_read" in cat.crawl && Array.isArray(cat.rows));
  check("S10 /catalog rows have exactly the sanitized keys", cat.rows.every((r) => Object.keys(r).sort().join(",") === ROW_KEYS), cat.rows[0] && Object.keys(cat.rows[0]).sort().join(","));
  check("S11 /catalog display and truncation forms", cat.rows.every((r) => /^discovered-[0-9a-f]{4}$/i.test(r.display) && /^0x[0-9a-f]{4}…[0-9a-f]{4}$/i.test(r.identity_truncated) && r.display.slice(-4) === r.identity_truncated.slice(-4)));
  check("S12 /catalog reported block only when listed", cat.rows.every((r) => (r.reported === null) === !r.listed_this_cycle));
  check("S13 /catalog same rows as /health", cat.rows.length === rows.length, cat.rows.length + " vs " + rows.length);
  const leaks = stringsDeep(cat).filter((s) => FULL_ID.test(s) || IPV4.test(s) || HOSTPORT.test(s));
  check("S14 /catalog: no full identity, address or host:port", leaks.length === 0, leaks.slice(0, 3).join(", "));
  const bad = await get("/catalog?q=" + encodeURIComponent("<script>"));
  check("S15 /catalog?q= rejects non-hex queries", bad.status === 400, bad.status);
  if (cat.rows.length) {
    const suf = cat.rows[0].display.slice(-4);
    const q = (await get("/catalog?q=" + suf)).body;
    check("S16 /catalog?q=<last 4> finds that row", q.rows.some((r) => r.display === cat.rows[0].display));
  }

  const now = (await get("/catalog?listed=now")).body, not = (await get("/catalog?listed=not")).body;
  check("S28 /catalog?listed=now|not split the rows by the latest crawl", now.rows.every((r) => r.listed_this_cycle) && not.rows.every((r) => !r.listed_this_cycle) && now.rows.length + not.rows.length === cat.rows.length, now.rows.length + " + " + not.rows.length + " vs " + cat.rows.length);
  check("S29 /catalog?listed= rejects other values", (await get("/catalog?listed=yes")).status === 400);
  const catRes = await get("/catalog"), catTag = catRes.headers.get("etag");
  check("S30 /catalog answers 304 to its own ETag", !!catTag && (await get("/catalog", { "If-None-Match": catTag })).status === 304, catTag);
  const inv = (await get("/catalog/lookup?key=0x1234")).body;
  check("S17 lookup: an invalid key is reported invalid", inv.valid_key === false && inv.in_catalog === false);
  const rnd = "0x" + createHash("sha256").update("dno-test-" + Date.now()).digest("hex");
  const miss = await get("/catalog/lookup?key=" + rnd);
  check("S18 lookup: an unknown key is not in the catalog; nothing cached", miss.body.valid_key === true && miss.body.in_catalog === false && miss.body.row === null && /no-store/.test(miss.headers.get("cache-control") || ""));
  check("S19 lookup never returns a full key", !FULL_ID.test(JSON.stringify(miss.body)) && !FULL_ID.test(JSON.stringify(inv)));

  const inc = await get("/incidents?scope=public&status=active");
  check("S20 /incidents rows carry kind and public scope", inc.status === 200 && inc.body.incidents.every((i) => ["incident", "condition"].includes(i.kind) && i.scope === "public"));
  check("S21 /incidents counts condition records", Number.isInteger(inc.body.active_public_conditions) && inc.body.active_public_conditions === o.active_public_conditions, inc.body.active_public_conditions + " vs " + o.active_public_conditions);
  check("S22 /incidents rejects bad parameters", (await get("/incidents?status=open")).status === 400 && (await get("/incidents?limit=0")).status === 400 && (await get("/incidents?scope=fleet")).status === 400);
  // Fleet history must not be public: these fail until INTERNAL_PORT moves /history to the loopback listener.
  check("S23 fleet history is not on the public listener", (await get("/history")).status === 404);
  check("S27 nor anything under /history", (await get("/history/")).status === 404 && (await get("/history/export")).status === 404 && (await get("/history/export/x")).status === 404);

  const peers = (await get("/peers")).body;
  const allKeys = keysDeep([peers, health, cat]);
  check("S24 no public JSON key naming readiness", !allKeys.some((k) => /ready|readiness/i.test(k)), allKeys.filter((k) => /ready|readiness/i.test(k)).slice(0, 3).join(","));
  // R4: fleet data is not on the public listener, whatever INTERNAL_PORT is.
  check("S31 /dashboard is not on the public listener", (await get("/dashboard")).status === 404 && (await get("/dashboard/")).status === 404);
  // R5: the two 1.0 counts that add seeds and catalog rows together say so.
  check("S32 validator_growth labels online and synced as mixed", vg.mixed_fields && Array.isArray(vg.mixed_fields.fields) && vg.mixed_fields.fields.join(",") === "online,synced" && typeof vg.mixed_fields.note === "string");
  // R7: blocks advanced in the window, as observed; no rate.
  const cm = o.last_24h && o.last_24h.chain_movement;
  check("S33 last_24h blocks_advanced is null or a non-negative integer when chain movement is known", !cm || cm.state === "unknown" || (cm.blocks_advanced === null || (Number.isInteger(cm.blocks_advanced) && cm.blocks_advanced >= 0)), JSON.stringify(cm));
  // R1: a seed that did not list itself has no height; its first listed peer's height is on its row only.
  const pn = health.publicNodes || [];
  const own = pn.filter((n) => n.ok && n.height_source === "self" && Number.isInteger(n.block)).length;
  // 1.2: what the reading rests on. Counts and one time; the mode decides what agreement compared.
  const wt = o.witnesses || {}, wv = wt.validators, ps = wt.public_seeds || {}, ad = o.agreement_detail || {};
  const compared = wt.mode === "seed_and_validators" ? 2 : wt.mode === "validators_only" ? (wv || {}).counted : own;
  check("S34 agreement counts the heights compared: the seeds that reported their own height; beside one seed, that seed and one validator; with no seed, the counted validators", ad.total_nodes === compared, ad.total_nodes + " vs " + compared + " (" + wt.mode + ")");
  check("W1 /organism witnesses: exactly its keys, and a mode from the documented set", Object.keys(wt).sort().join(",") === "counted,mode,public_seeds,validators" && ["seeds_only", "seed_and_validators", "validators_only", "insufficient"].includes(wt.mode)
    && Object.keys(ps).sort().join(",") === "answered,configured,own_height" && (wv === null || Object.keys(wv).sort().join(",") === "counted,list_agreed_at,own_height,read"), JSON.stringify(wt));
  check("W2 the seed counts are the /health rows' own: configured, answered, with their own height", ps.configured === pn.length && ps.answered === pn.filter((n) => n.ok).length && ps.own_height === own, JSON.stringify(ps) + " vs " + pn.length + "/" + own);
  check("W3 the mode follows the counts: two seed heights are seeds_only with no validator read; one is never seeds_only; a reading without a seed height is validators_only",
    (own >= 2 ? wt.mode === "seeds_only" || o.data_quality_reason === "stale" || o.data_quality_reason === "no_observation" : wt.mode !== "seeds_only") && (wt.mode !== "seeds_only" || wv === null)
    && (wt.mode !== "seed_and_validators" || (own === 1 && wv && wv.counted >= 1)) && (wt.mode !== "validators_only" || (own === 0 && wv && wv.counted >= 2 && wv.counted * 2 > wv.own_height)), JSON.stringify(wt));
  check("W4 counted: the heights the reading rests on, none without a reading", wt.counted === (wt.mode === "seeds_only" ? own : wt.mode === "seed_and_validators" ? 1 + wv.counted : wt.mode === "validators_only" ? wv.counted : 0)
    && (wv === null || (wv.counted <= wv.own_height && wv.own_height <= wv.read && wv.read <= 8)), JSON.stringify(wt));
  check("W5 no reading is unknown and insufficient, and a reading is neither: the three go together", (wt.mode === "insufficient") === (o.status === "unknown") && (wt.mode === "insufficient") === (o.data_quality === "insufficient"), wt.mode + " " + o.status + " " + o.data_quality);
  check("W6 a reading that rests on validators says so: risk is not low, a risk factor names it, and validators alone are uncertain", wt.mode === "seeds_only" || wt.mode === "insufficient"
    || (o.risk !== "low" && o.risk_factors.some((f) => /validator/.test(f)) && (wt.mode !== "validators_only" || o.confidence === "uncertain")), JSON.stringify([o.risk, o.risk_factors, o.confidence]));
  check("W7 list_agreed_at is a time at most 24 h before the observation", wv === null || (wv.list_agreed_at !== null && Date.parse(o.observed_at) - Date.parse(wv.list_agreed_at) <= 86400000 && Date.parse(wv.list_agreed_at) <= Date.parse(o.observed_at)), wv && wv.list_agreed_at);
  check("W8 witnesses carries no key, address, URL or height", !stringsDeep(wt).some((x) => FULL_ID.test(x) || IPV4.test(x) || HOSTPORT.test(x) || /https?:|0x[0-9a-f]{8,}/i.test(x)) && !/\d{5,}/.test(JSON.stringify(wt).replace(/"list_agreed_at":"[^"]*"/, "")), JSON.stringify(wt));
  check("W9 the standstill limit is published, and status obeys it: a reading at or past it is not stable", o.height_standstill_after_seconds === 1800 && health.height_standstill_after_seconds === 1800
    && !(o.status === "stable" && Number.isInteger(o.height_static_seconds) && o.height_static_seconds >= o.height_standstill_after_seconds), o.status + " " + o.height_static_seconds);
  check("W10 /health carries the same witnesses object (the two requests may fall in different rounds: the keys and the seed counts must match)", health.witnesses && Object.keys(health.witnesses).sort().join(",") === "counted,mode,public_seeds,validators"
    && health.witnesses.public_seeds.configured === ps.configured, JSON.stringify(health.witnesses));
  const firstPeer = pn.filter((n) => n.height_source === "first_peer").map((n) => n.name);
  const vgSeeds = (vg.validators || []).filter((v) => v.monitored && firstPeer.includes(v.display));
  check("S35 a first-peer seed has no height in validator_growth", vgSeeds.length === firstPeer.length && vgSeeds.every((v) => v.block === null && v.lag === null && v.sync_pct === null), JSON.stringify(vgSeeds.map((v) => [v.display, v.block])));
  // New peer-listed identities: a window the count does not cover has no figure, and says why; the 1.0 fields stay numbers.
  const fc = vg.first_counted, WIN = ["today", "week", "month"];
  check("G1 validator_growth.first_counted: exactly its keys, each window an integer or null, since an ISO time or null",
    fc && Object.keys(fc).sort().join(",") === "month,note,reason,since,today,week" && WIN.every((w) => fc[w] === null || (Number.isInteger(fc[w]) && fc[w] >= 0))
      && (fc.since === null || !Number.isNaN(Date.parse(fc.since))) && typeof fc.note === "string", JSON.stringify(fc));
  check("G2 a window without a figure has a reason, and a later window never has a figure when an earlier one has none",
    fc && (WIN.every((w) => fc[w] !== null) ? fc.reason === null : typeof fc.reason === "string" && fc.reason.length > 0)
      && !(fc.today === null && fc.week !== null) && !(fc.week === null && fc.month !== null), JSON.stringify(fc));
  check("G3 the 1.0 today, week and month are numbers, equal to first_counted where it has a figure, and never above the rows counted after the starting set",
    fc && WIN.every((w) => Number.isInteger(vg[w]) && vg[w] >= 0 && vg[w] <= vg.discovered && (fc[w] === null || fc[w] === vg[w])) && vg.today <= vg.week && vg.week <= vg.month, JSON.stringify([vg.today, vg.week, vg.month, fc]));
  const firstTimes = (cat.rows || []).map((r) => Date.parse(r.first_seen)).filter((t) => !Number.isNaN(t));
  check("G4 since is set once an identity is published: one hour after the count's start, which is not later than the earliest first_seen in /catalog",
    firstTimes.length === 0 ? fc.since === null || !Number.isNaN(Date.parse(fc.since)) : fc.since !== null && Date.parse(fc.since) <= Math.min(...firstTimes) + 3600000, JSON.stringify([fc && fc.since, firstTimes.length && new Date(Math.min(...firstTimes)).toISOString()]));
  // SPEC-v7: the on-chain validators read and watch, on /health only, counts only.
  const ocv = health.on_chain_validators, vwt = health.validator_watch;
  const OC_KEYS = "active,first_agreed_as_of,first_agreed_month,first_agreed_reason,first_agreed_since,first_agreed_today,first_agreed_week,listed,min_validator_stake,observed_at,other_status,reason,seeds_agreed,seeds_answered,seeds_configured,state,unstaking";
  const VW_KEYS = "answered_as_listed,answered_as_listed_seeds,answered_no_key,answered_other_key,at_seed_height,every_round_last_hour,height_band_blocks,height_not_compared,height_not_reported,interval_seconds,max_rows_per_origin,no_answer,not_dialed,not_dialed_reasons,off_seed_height,origins_dialed,other_key_shared,other_key_shared_origins,reason,reference_height,reference_observed_at,round_at,state,versions,versions_other,watched,window";
  check("V1 /health on_chain_validators: exactly the published keys", ocv && Object.keys(ocv).sort().join(",") === OC_KEYS, ocv && Object.keys(ocv).sort().join(","));
  check("V2 /health validator_watch: exactly the published keys", vwt && Object.keys(vwt).sort().join(",") === VW_KEYS, vwt && Object.keys(vwt).sort().join(","));
  check("V3 states from the documented sets", ocv && ["pending", "agreed", "not_agreed", "stale"].includes(ocv.state) && vwt && ["pending", "observed", "no_agreed_list", "stale", "disabled"].includes(vwt.state), ocv && vwt && ocv.state + " / " + vwt.state);
  const ocCounts = ["listed", "active", "unstaking", "other_status", "first_agreed_today", "first_agreed_week", "first_agreed_month", "first_agreed_as_of"];
  const vwCounts = ["watched", "not_dialed", "no_answer", "answered_other_key", "answered_no_key", "answered_as_listed", "every_round_last_hour",
    "origins_dialed", "max_rows_per_origin", "other_key_shared", "other_key_shared_origins", "answered_as_listed_seeds"];
  check("V4 a count only in the agreed or observed state", ocv && vwt && (ocv.state === "agreed" || ocCounts.every((k) => ocv[k] === null)) && (vwt.state === "observed" || vwCounts.every((k) => vwt[k] === null))
    && (ocv.state !== "agreed" || (Number.isInteger(ocv.active) && ocv.seeds_agreed >= 2)) && (ocv.min_validator_stake === null || /^\d+$/.test(ocv.min_validator_stake)));
  const vLeaks = stringsDeep([ocv, vwt]).filter((x) => FULL_ID.test(x) || IPV4.test(x) || HOSTPORT.test(x) || /https?:|0x[0-9a-f]{8,}/i.test(x));
  check("V5 neither object carries an address, key, URL or host", vLeaks.length === 0, vLeaks.slice(0, 3).join(", "));
  // SPEC-v7.1: every ACTIVE row in exactly one outcome; the first-agreed windows nest and say why when empty.
  const z = (v) => (Number.isInteger(v) ? v : 0);
  const part = !vwt || vwt.state !== "observed" || (
    z(vwt.not_dialed) + z(vwt.no_answer) + z(vwt.answered_other_key) + z(vwt.answered_no_key) + z(vwt.answered_as_listed) === vwt.watched
    && Object.values(vwt.not_dialed_reasons || {}).reduce((t, n) => t + z(n), 0) === vwt.not_dialed
    && z(vwt.at_seed_height) + z(vwt.off_seed_height) + z(vwt.height_not_reported) + z(vwt.height_not_compared) === vwt.answered_as_listed
    && z(vwt.other_key_shared) <= vwt.answered_other_key && z(vwt.answered_as_listed_seeds) <= vwt.answered_as_listed
    && (vwt.other_key_shared === 0) === (vwt.other_key_shared_origins === 0) && vwt.origins_dialed <= vwt.watched - vwt.not_dialed);
  check("V7 validator_watch: every ACTIVE row in exactly one outcome, and each subset inside its set", part, vwt && JSON.stringify(vwt).slice(0, 400));
  const win = ocv ? [ocv.first_agreed_today, ocv.first_agreed_week, ocv.first_agreed_month] : [];
  const nest = win.every((v) => v === null || (Number.isInteger(v) && v >= 0)) && (win.includes(null) ? typeof ocv.first_agreed_reason === "string" && ocv.first_agreed_reason.length > 0 : ocv.first_agreed_reason === null)
    && [[0, 1], [1, 2], [0, 2]].every(([a, b]) => win[a] === null || win[b] === null || win[a] <= win[b])
    && (ocv.first_agreed_since === null || ocv.first_agreed_as_of === null || Date.parse(ocv.first_agreed_since) <= Date.parse(ocv.first_agreed_as_of));
  check("V8 on_chain_validators first-agreed windows: counts or null with a reason, today <= week <= month", ocv && nest, ocv && JSON.stringify(win) + " " + ocv.first_agreed_reason);
  // SPEC-v7.1 F: the full-key check says where that key stands on the agreed list, for that key only.
  // The lookup reads the same round, under the same freshness rule, as /health (a round may land between the reads).
  const h9a = (await get("/health")).body.on_chain_validators;
  const lkOk = await get("/catalog/lookup?key=" + "0x" + createHash("sha256").update("dno-v9-" + Date.now()).digest("hex")), lkBad = await get("/catalog/lookup?key=0x12");
  const h9b = (await get("/health")).body.on_chain_validators;
  const oc9 = lkOk.body && lkOk.body.on_chain;
  const sameRound = (h) => h && oc9 && oc9.state === h.state && oc9.observed_at === h.observed_at && oc9.seeds_agreed === h.seeds_agreed && oc9.reason === h.reason;
  check("V10 /catalog/lookup on_chain comes from the same round as /health's on_chain_validators", sameRound(h9a) || sameRound(h9b), JSON.stringify([oc9, h9a && h9a.observed_at, h9b && h9b.observed_at]));
  check("V9 /catalog/lookup on_chain: a status for a valid key only while the list agrees (a key nobody listed is not_listed), null for an invalid key, never a key in the answer",
    oc9 && Object.keys(oc9).sort().join(",") === "observed_at,reason,seeds_agreed,seeds_configured,state,status"
    && (oc9.state === "agreed" ? oc9.status === "not_listed" : oc9.status === null && typeof oc9.reason === "string")
    && lkBad.body && lkBad.body.valid_key === false && lkBad.body.on_chain === null
    && !/0x[0-9a-f]{64}/i.test(JSON.stringify(lkOk.body)), JSON.stringify([oc9, lkBad.body && lkBad.body.on_chain]));
  check("V6 /organism carries neither", !("on_chain_validators" in o) && !("validator_watch" in o) && !JSON.stringify(o).includes("min_validator_stake"));
  // Site kit: assets under a content hash, cached; every page carries the one header with the locked mark.
  const aboutPage = await get("/about-demos");
  const aboutHtml = typeof aboutPage.body === "string" ? aboutPage.body : "";
  const kitRefs = [...new Set(aboutHtml.match(/\/assets\/(?:site|dno-favicon)-[0-9a-f]{8}\.(?:css|js|png)/g) || [])];
  let kitOk = kitRefs.length === 3;
  for (const a of kitRefs) { const r = await fetch(BASE + a); kitOk = kitOk && r.status === 200 && /immutable/.test(r.headers.get("cache-control") || ""); }
  check("S37 site kit assets are served under a content hash, immutable", kitOk, kitRefs.join(", "));
  const pages = ["/about-demos", "/methodology", "/sources", "/agent", "/criteria", "/commerce", "/commerce/methodology", "/reference", "/timeline", "/docs"];
  const badPages = [];
  for (const pth of pages) {
    const r = await get(pth); const t = typeof r.body === "string" ? r.body : "";
    if (r.status !== 200 || !t.includes('<header class="site-head">') || !t.includes('src="/assets/dno-mark-' + markSha.slice(0, 8) + '.jpg"') || t.includes("<!--dno:") || /cx="50" cy="19"|class="doc-logo"|href="\/dashboard"/.test(t)) badPages.push(pth);
  }
  check("S38 every page: the site header with the locked mark, markers filled, no old mark, no /dashboard link", badPages.length === 0, badPages.join(", "));
  const docs = await get("/docs");
  const docsHtml = typeof docs.body === "string" ? docs.body : "";
  check("S36 /docs prints no full wallet or identity and no /dashboard link", docs.status === 200 && !FULL_ID.test(docsHtml) && !/0x[0-9a-fA-F]{40}\b/.test(docsHtml) && !/href="\/dashboard"/.test(docsHtml));
  // Every endpoint /docs lists is served: up to 7.1.1 it listed GET /signals, which answered 404.
  const listed = [...docsHtml.matchAll(/<dt><code>GET (\/[^<\s]*)<\/code><\/dt>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/\?key=0x…$/, "?key=0x" + "ab".repeat(32)));
  const notServed = [];
  for (const pth of listed) { const r = await fetch(BASE + pth); if (r.status !== 200) notServed.push(pth + " " + r.status); await r.arrayBuffer(); }
  check("S36b every GET endpoint /docs lists answers 200", listed.length >= 15 && notServed.length === 0, listed.length + " listed; " + notServed.join(", "));

  const home = await get("/");
  const html = typeof home.body === "string" ? home.body : "";
  check("S25 / is filled for readers without JavaScript once an observation exists", !o.observed_at || (html.includes('<div class="panel" id="panel" data-state="live">') && html.includes('<span id="status-value">' + String(o.status).toUpperCase() + "</span>")));
  const cardHtml = html.slice(html.indexOf('id="panel"'), html.indexOf('id="cards"'));
  const ocH = health.on_chain_validators;
  // The card's second line says what status is made of in this observation (1.2): the seeds; one seed and the validators
  // standing in; validators alone; or, when validators were read and gave no reading, that status is unknown. The page
  // and /organism may be a round apart, so any of the endings the two rounds' modes allow is accepted.
  const hw = (await get("/health")).body.witnesses || {};
  const ending = (w) => (w.mode === "seed_and_validators" ? "Status is that seed and (that validator|those validators)" : w.mode === "validators_only" ? "Status is those validators alone"
    : w.mode === "insufficient" && w.validators ? "Status is unknown" : "Status is those seeds");
  const seedsLineOk = (card) => [wt, hw].some((w) => new RegExp('<p class="seeds" id="seeds-line" aria-live="polite">[^<]+ ' + ending(w) + (ending(w) === "Status is unknown" ? "" : "(, not the [\\d,]+)?") + '\\.</p>').test(card));
  check("S25b the card's lines for readers without JavaScript: the ACTIVE count first, then what status is made of in this observation; no 'nodes aligned'",
    !o.observed_at || (/<p class="cycle-lead" id="cycle-lead" data-src="api">([\d,]+ ACTIVE on chain as \w+ public seeds list them\.|ACTIVE on chain: (reading|not reported this cycle[^<]*)\.)<\/p>/.test(cardHtml)
      && (ocH.state !== "agreed" || cardHtml.includes(">" + cycleLead(ocH) + "<"))
      && seedsLineOk(cardHtml)
      && !/nodes aligned/.test(cardHtml)), cardHtml.slice(0, 600));
  const mk = await fetch(BASE + "/assets/dno-mark-" + markSha.slice(0, 8) + ".jpg");
  const mkBytes = Buffer.from(await mk.arrayBuffer());
  check("S26 the mark asset is served byte-for-byte, cached", mk.status === 200 && mk.headers.get("content-type") === "image/jpeg" && /immutable/.test(mk.headers.get("cache-control") || "") && createHash("sha256").update(mkBytes).digest("hex") === markSha);
} catch (e) {
  check("S0 served layer reachable at " + BASE, false, e.message);
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
