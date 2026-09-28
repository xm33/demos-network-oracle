// public-api-v11.test.mjs — PUBLIC_API_V11 guard: the 1.1 additions (catalog, exact lookup, condition records,
// height movement, conditional GET) and the homepage that renders them.
// Static part: homepage.html against agent.mjs (server-side fill markers, mark asset, ban list).
// Served part: every public representation of the new data, against a running agent.
// Run:  bun src/public-api-v11.test.mjs [baseUrl]   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const HOME = readFileSync(join(ROOT, "homepage.html"), "utf8");
const BASE = process.argv[2] || "http://localhost:55225";
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
  '<p class="status-reason" id="status-reason" data-src="api" aria-live="polite">The first request to /organism is in flight.</p>',
  '<p class="seeds" id="seeds-line">Awaiting first reading of /health.</p>',
  '<p class="insufficient" id="insufficient" hidden>',
  '<span class="ind" id="ag-ind" data-tone="pending"></span><span id="ag-state">reading</span>',
  '<span id="live-text">connecting</span>',
  card("trend", "trend"), card("risk", "risk"), card("confidence", "confidence"), card("data_quality", "data quality")
];
MARKERS.forEach((m, i) => check("H" + (i + 1) + " fill marker present once: " + m.slice(0, 48), count(HOME, m) === 1, "count " + count(HOME, m)));
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
check("H20 public JSON field names avoid the banned word (readiness_flag)", !/\breported_ready\b|^\s+ready: /m.test(SRC.slice(SRC.indexOf("function toPublicPeer"), SRC.indexOf("function toPublicPeer") + 900)) && /readiness_flag:/.test(SRC));

console.log("\n[" + TAG + "] served (base: " + BASE + ")");
async function get(path, headers) { const r = await fetch(BASE + path, { headers: headers || {} }); let body = null; try { body = await r.clone().json(); } catch (e) { body = await r.text(); } return { status: r.status, headers: r.headers, body }; }
try {
  const org = await get("/organism");
  const o = org.body;
  check("S1 api_version 1.1", o.api_version === "1.1", o.api_version);
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
  check("S6 catalog rows in /health carry the 1.1 fields", rows.every((v) => typeof v.listed_this_cycle === "boolean" && Number.isInteger(v.listed_by) && "first_seen" in v && "last_listed" in v && "reported_readiness_flag" in v && "reported_sync_status" in v), rows.length + " rows");
  check("S7 rows not listed this crawl carry no reported values", rows.filter((v) => !v.listed_this_cycle).every((v) => v.block === null && v.online === false && v.reported_readiness_flag === null && v.reported_sync_status === null && v.sync_pct === null));
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
  check("S24 no public JSON key named 'ready'", !allKeys.includes("ready") && !allKeys.includes("reported_ready"));

  const home = await get("/");
  const html = typeof home.body === "string" ? home.body : "";
  check("S25 / is filled for readers without JavaScript once an observation exists", !o.observed_at || (html.includes('<div class="panel" id="panel" data-state="live">') && html.includes('<span id="status-value">' + String(o.status).toUpperCase() + "</span>")));
  const mk = await fetch(BASE + "/assets/dno-mark-" + markSha.slice(0, 8) + ".jpg");
  const mkBytes = Buffer.from(await mk.arrayBuffer());
  check("S26 the mark asset is served byte-for-byte, cached", mk.status === 200 && mk.headers.get("content-type") === "image/jpeg" && /immutable/.test(mk.headers.get("cache-control") || "") && createHash("sha256").update(mkBytes).digest("hex") === markSha);
} catch (e) {
  check("S0 served layer reachable at " + BASE, false, e.message);
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
