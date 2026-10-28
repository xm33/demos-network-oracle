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
import * as HC from "./home-cycle.mjs";
import { escHtml } from "./public-safety.mjs";
const { tileOnChain } = HC;
// The reading panel as the agent fills it for readers without JavaScript, checked by one predicate on the served page
// (S25b) and on the two operator captures (H52): the band's four tiles filled (none left "reading"); the on-chain count
// only with its unit and the list read's own clock; the answered count only with the check's own clock (the words of
// home-cycle.mjs since FS R2: "list read HH:MM:SS UTC", "checked HH:MM:SS UTC"); then what status is made of; never
// "nodes aligned". S25b alone runs only against a live agent; it kept FS v0.2's "list HH:MM:SS" and failed on n3 after
// the FS deploy (2026-10-28) on a correct page, so the same predicate now runs statically too.
const panelOf = (html) => html.slice(html.indexOf('id="panel"'), html.indexOf('<p class="bound">', html.indexOf('id="panel"')));
const TILE_RE = (k) => new RegExp('<p class="tv( none)?" id="tile-' + k + '-v">([^<]*)(?: <span class="tu">([^<]*)</span>)?</p><p class="ts" id="tile-' + k + '-s" data-src="api">([^<]*)</p>');
const bandTiles = (card) => ["median", "seeds", "onchain", "answered"].map((k) => card.match(TILE_RE(k)) || []);
// The page and /organism may be a round apart, so any ending the given witnesses' modes allow is accepted.
const statusEnding = (w) => (w.mode === "seed_and_validators" ? "Status is that seed and (that validator|those validators)" : w.mode === "validators_only" ? "Status is those validators alone"
  : w.mode === "insufficient" ? "Status is unknown" : "Status is those seeds");   // insufficient is never compared: unknown, whether or not validators were read
const seedsLineOk = (card, ws) => ws.some((w) => new RegExp('<p class="seeds" id="seeds-line" aria-live="polite"( hidden)?>[^<]+ ' + statusEnding(w) + (statusEnding(w) === "Status is unknown" ? "" : "(, not the [\\d,]+)?") + '\\.</p>').test(card));
function panelNoJsOk(card, health, ws) {
  const band = bandTiles(card), oc = (health && health.on_chain_validators) || {};
  return band.every((m) => m.length > 0 && m[2] !== "reading")
    && (band[2][3] === undefined || (band[2][3] === "ACTIVE" && /^[\d,]+$/.test(band[2][2]) && /^list read \d\d:\d\d:\d\d UTC$/.test(band[2][4])))
    && (oc.state !== "agreed" || band[2][2] === tileOnChain(health).value)
    && (!/^[\d,]+$/.test(band[3][2] || "") || /^checked \d\d:\d\d:\d\d UTC$/.test(band[3][4]))
    && seedsLineOk(card, ws)
    && !/nodes aligned/.test(card);
}
import { BANNED_PUBLIC_LANGUAGE, CHARACTERIZATION, publicLanguageHit } from "./banned-public-language.mjs";
import { RULE, MODES } from "./status-rule.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const HOME = readFileSync(join(ROOT, "homepage.html"), "utf8");
const AGENTSRC = readFileSync(join(ROOT, "src", "agent.mjs"), "utf8");
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
const BANNED = BANNED_PUBLIC_LANGUAGE;
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
  '<span class="ind" id="band-ind" data-tone="pending"></span><span id="band-status">reading</span>',
  '<p class="seeds" id="seeds-line" aria-live="polite">The first request to /organism is in flight.</p>',
  '<p class="insufficient" id="insufficient" hidden>',
  '<span class="ind" id="ag-ind" data-tone="pending"></span><span id="ag-state">reading</span>',
  '<span id="live-text">connecting</span>',
  card("trend", "trend"), card("risk", "risk"), card("confidence", "confidence"), card("data_quality", "data quality"),
  // V7 first screen (PR-3 ④): the reading's sentence, its clock and version, and its own agreement card.
  '<p class="summary" id="summary" data-src="api">reading</p>', '<span id="obs-at">not read yet</span>', '<span id="api-v">reading</span>', card("reading_agreement", "agreement")
];
const VW_MARKER = '<p class="note" id="vw-line">Validator counts are published on <a href="/health">/health</a> as on_chain_validators and validator_watch.</p>';
MARKERS.forEach((m, i) => check("H" + (i + 1) + " fill marker present once: " + m.slice(0, 48), count(HOME, m) === 1, "count " + count(HOME, m)));
check("H25 validators line: marker present once, and the agent fills it from the same text", count(HOME, VW_MARKER) === 1 && SRC.includes("validators: '" + VW_MARKER + "'"), "count " + count(HOME, VW_MARKER));
// The band beside the status word (FS): the four tiles and the line under them. The peer-listed door left the panel;
// section 02 (populations) keeps it beside its own count.
const TILE_MARKER = (k) => '<p class="tv" id="tile-' + k + '-v">reading</p><p class="ts" id="tile-' + k + '-s" data-src="api"></p>';
const BETWEEN_MARKER = '<span id="tile-between">Neither validator figure shows how many validators are online.</span> <a href="#validators" id="tile-between-a">Validators on chain</a>';
check("H26 the band: each tile marker and the line under the band present once, and the agent fills them from the same strings",
  ["median", "seeds", "onchain", "answered"].every((k) => count(HOME, TILE_MARKER(k)) === 1 && SRC.includes("homeTileMarker(\"" + k + "\")")) && count(HOME, BETWEEN_MARKER) === 1
  && SRC.includes("between: '" + BETWEEN_MARKER + "'") && SRC.includes("return '<p class=\"tv\" id=\"tile-' + key + '-v\">reading</p><p class=\"ts\" id=\"tile-' + key + '-s\" data-src=\"api\"></p>';")
  && !HOME.includes('id="door-n"') && !HOME.includes('id="cycle-lead"'), ["median", "seeds", "onchain", "answered"].map((k) => count(HOME, TILE_MARKER(k))).join(","));
// Every element the page's script asks for by id is in the page: a removed element whose handler stays stops the whole
// script before the first render (FS: the door's click handler outlived the door).
{
  const asked = [...new Set([...HOME.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))], lacking = asked.filter((id) => !HOME.includes('id="' + id + '"'));
  check("H41 every id the page's script asks for with $('…') is in the page", asked.length > 50 && lacking.length === 0, lacking.join(", "));
}
// The agent's fill for readers without JavaScript, run as shipped (its source, sliced from agent.mjs) on homepage.html,
// with the two operator captures as the agent's state: the band is filled from the same functions, nothing in it is
// left "reading", a count stands only with its clock, and a list not agreed carries no count.
{
  const i = SRC.indexOf("var HOME_TONE = {"), j = SRC.indexOf("// The locked DNO mark");
  const FX = join(ROOT, "tools", "homepage-preview", "fixtures"), fx = (n) => JSON.parse(readFileSync(join(FX, n), "utf8"));
  const fill = (o, h) => new Function("escHtml", "computeCanonicalState", "publicOnChainValidators", "publicValidatorWatch", "latestValidatorRound", "validatorPublishConfig", "latestPublicNodes", "validatorsNoJsLine", "HC",
    "var { " + Object.keys(HC).join(", ") + " } = HC;\n" + SRC.slice(i, j) + "\nreturn renderHomepageNoJs;")(
    escHtml, () => Object.assign({}, o, { agreement: Object.assign({ state: o.agreement }, o.agreement_detail) }), () => h.on_chain_validators, () => h.validator_watch, null, () => ({}), h.publicNodes, () => null, HC)(HOME);
  const bandOf = (html) => html.slice(html.indexOf('id="band"'), html.indexOf('<div class="strip cards" id="cards">'));
  const explainOf = (html) => html.slice(html.indexOf('<details class="explain" id="explain">'), html.indexOf('</details>', html.indexOf('<details class="explain" id="explain">')));
  const A = fill(fx("organism-capture-20261021T072727Z.json"), fx("health-capture-20261021T072727Z.json")), B = fill(fx("organism-capture-20261023T122827Z.json"), fx("health-capture-20261023T122827Z.json"));
  const a = bandOf(A), b = bandOf(B), xa = explainOf(A), xb = explainOf(B);
  check("H42 no-JS fill, 21 Oct capture: the band carries the median, the seeds, 35 ACTIVE with its list clock, 6 with its check clock, and the line names both",
    i > 0 && j > i && a.includes('<span id="band-status">stable</span>') && a.includes('id="tile-median-v">6,675</p>') && a.includes('id="tile-seeds-v">2 <span class="tu">of 3</span></p><p class="ts" id="tile-seeds-s" data-src="api">gave their own height; 1 did not</p>')
    && a.includes('id="tile-onchain-v">35 <span class="tu">ACTIVE</span></p><p class="ts" id="tile-onchain-s" data-src="api">list read 07:27:23 UTC</p>')
    && a.includes('id="tile-answered-v">6</p><p class="ts" id="tile-answered-s" data-src="api">checked 07:27:23 UTC</p>')
    && a.includes(">35 and 6 are two observations on their own clocks. Neither shows how many validators are online.</span>") && a.includes(">How the 35 split</a>") && !/>reading</.test(a), a.slice(0, 900));
  check("H43 no-JS fill, 23 Oct capture (no agreed list, so the watch round gives no counts): no count on chain or answered, and the line names neither",
    b.includes('class="tv none" id="tile-onchain-v">unknown</p>') && b.includes('class="tv none" id="tile-answered-v">unknown</p>') && b.includes('id="tile-seeds-v">1 <span class="tu">of 3</span></p>')
    && b.includes(">Neither validator figure shows how many validators are online.</span>") && !/>reading</.test(b) && !/\b35\b/.test(b), b.slice(0, 900));
  // The seeds line under the band: left out when calm (21 Oct: two seeds, aligned), kept when validators stand in (23 Oct).
  check("H46 no-JS fill: the seeds line is hidden when it says nothing the band does not, shown when it does, and Explain carries it in full either way",
    a.includes('<p class="seeds" id="seeds-line" aria-live="polite" hidden>2 of 3 configured seeds answered.') && b.includes('<p class="seeds" id="seeds-line" aria-live="polite">1 of 3 configured seeds answered.')
    && xa.includes('<p id="x-seeds">2 of 3 configured seeds answered.') && xb.includes('<p id="x-seeds">1 of 3 configured seeds answered. 4 validators'), a.slice(Math.max(0, a.indexOf("seeds-line") - 20), a.indexOf("seeds-line") + 160));
  // Explain this reading, without JavaScript: the summary verbatim, each figure's clock, each field's value and reason.
  const o21 = fx("organism-capture-20261021T072727Z.json"), o23 = fx("organism-capture-20261023T122827Z.json");
  check("H47 no-JS fill: Explain this reading carries the summary, the source clocks and every field's reason, nothing left reading",
    xa.includes('<p class="summary" id="summary" data-src="api">' + escHtml(o21.summary) + '</p>') && xa.includes('<span id="x-status">stable</span>')
    && xa.includes('<span id="x-at-reading">read 07:27:13 UTC</span>') && xa.includes('<span id="x-at-list">read 07:27:23 UTC</span>') && xa.includes('<span id="x-at-check">round 07:27:23 UTC</span>')
    && xa.includes('<span class="xw" data-why="risk">' + escHtml(o21.risk_factors.join(" · ")) + '</span>') && xa.includes('<span class="xw" data-why="confidence">' + escHtml(o21.confidence_reason) + '</span>')
    && xa.includes('<span class="xw" data-why="data_quality">No reason is published for this value in this reading.</span>') && xa.includes('<span data-whyv="reading_agreement">strong</span>')
    && xb.includes('<span class="xw" data-why="risk">' + escHtml(o23.risk_factors.join(" · ")) + '</span>') && !/>reading</.test(xa) && !/>reading</.test(xb) && !/>not read yet</.test(xa)
    && xa.includes('<p class="xnote" id="x-insufficient" hidden>') && xa.includes("LIVE is the age of DNO's last completed observation, not the network's state."), xa.slice(0, 900));
  // F-FS-02: the on-chain source line, without JavaScript, on an agreed list (21 Oct), a list not agreed with validators
  // standing in (23 Oct), and the insufficient reading (0 of 3 seeds).
  const xc = explainOf(fill(fx("organism-insufficient.json"), fx("health-insufficient.json")));
  const SRC_SPAN = (s) => '<span id="x-src-list">' + s + '</span>';
  check("H51 no-JS fill: the on-chain source line claims agreement only for an agreed list, and gives the list's own reason otherwise",
    xa.includes(SRC_SPAN("2 of 3 public seeds returned the same validator list")) && xb.includes(SRC_SPAN("no agreed validator list: fewer than two public seeds returned a validator list"))
    && xc.includes(SRC_SPAN("no agreed validator list: fewer than two public seeds returned a validator list")) && ![xb, xc].some((x) => /returned the same validator list|alike/.test(x)), [xa, xb, xc].map((x) => (x.match(/<span id="x-src-list">[^<]*<\/span>/) || ["(none)"])[0]).join(" | "));
}
// S25b's predicate, run here on the agent's no-JS fill of both captures (the static suite never reached S25b before).
{
  const FX = join(ROOT, "tools", "homepage-preview", "fixtures"), fx = (n) => JSON.parse(readFileSync(join(FX, n), "utf8"));
  const i = SRC.indexOf("var HOME_TONE = {"), j = SRC.indexOf("// The locked DNO mark");
  const fill = (o, h) => new Function("escHtml", "computeCanonicalState", "publicOnChainValidators", "publicValidatorWatch", "latestValidatorRound", "validatorPublishConfig", "latestPublicNodes", "validatorsNoJsLine", "HC",
    "var { " + Object.keys(HC).join(", ") + " } = HC;\n" + SRC.slice(i, j) + "\nreturn renderHomepageNoJs;")(
    escHtml, () => Object.assign({}, o, { agreement: Object.assign({ state: o.agreement }, o.agreement_detail) }), () => h.on_chain_validators, () => h.validator_watch, null, () => ({}), h.publicNodes, () => null, HC)(HOME);
  const caps = ["20261021T072727Z", "20261023T122827Z"].map((t) => { const o = fx("organism-capture-" + t + ".json"), h = fx("health-capture-" + t + ".json"); return { o, h, card: panelOf(fill(o, h)) }; });
  const t21 = bandTiles(caps[0].card);
  check("H52 S25b's check of the no-JS panel, run on both captures: tiles filled, each count with its own clock in the module's words, the seeds line, no 'nodes aligned'",
    caps.every((c) => c.card.length > 1000 && panelNoJsOk(c.card, c.h, [c.o.witnesses || {}, c.h.witnesses || {}]))
    && t21[2][4] === "list read 07:27:23 UTC" && t21[3][4] === "checked 07:27:23 UTC", JSON.stringify(t21.map((m) => m.slice(2))));
}
check("H50 the on-chain source line is a fill marker (present once, the agent fills the same one), and no fixed agreement wording is left in it",
  count(HOME, '<dd><span id="x-src-list">the validator list</span>, from <code>/health</code>, <span id="x-at-list">not read yet</span></dd>') === 1
  && SRC.includes("xSrcList: '<span id=\"x-src-list\">the validator list</span>'") && !HOME.includes("returned alike"), count(HOME, 'id="x-src-list"'));
// The insufficient-reading banner: the operator's approved words (2026-10-28, "banner approve"), directly under the band;
// the old banner's detail is inside Explain, shown only when data quality is insufficient.
check("H48 the insufficient banner is the approved text, placed before the reading's lines; the old detail lives in Explain only",
  HOME.includes('<p class="insufficient" id="insufficient" hidden>DNO could not form a sufficient reading from public sources this time, so the status is unknown.</p>')
  && HOME.indexOf('id="insufficient"') > HOME.indexOf('id="band"') && HOME.indexOf('id="insufficient"') < HOME.indexOf('id="seeds-line"')
  && count(HOME, "Network observability is limited.") === 1 && HOME.indexOf("Network observability is limited.") > HOME.indexOf('id="x-insufficient"') && HOME.indexOf("Network observability is limited.") < HOME.indexOf('id="x-insufficient"') + 80);
// Each field's definition link in Explain points at a section the methodology page really has.
{
  const METH = readFileSync(join(ROOT, "methodology.html"), "utf8");
  const ex = HOME.slice(HOME.indexOf('<details class="explain" id="explain">'), HOME.indexOf('</details>', HOME.indexOf('<details class="explain" id="explain">')));
  const anchors = [...ex.matchAll(/href="\/methodology#([a-z0-9-]+)"/g)].map((m) => m[1]);
  check("H49 Explain links each of the six fields to its own section on /methodology, and every section exists", anchors.length === 6 && new Set(anchors).size === 6 && anchors.every((id) => METH.includes('id="' + id + '"')), anchors.join(", "));
}
// The band's labels name the field each tile shows: the seeds' median (one seed's height is not a median, and DNO reads
// heights the seeds report, not the chain's latest block), and the rows that answered DNO as their listed key (rows that
// answered with another key or none answered DNO too: validator_watch publishes them apart).
{
  const labels = [...HOME.slice(HOME.indexOf('id="band"'), HOME.indexOf('<div class="rsum">')).matchAll(/<p class="k">([^<]+)<\/p>/g)].map((m) => m[1]);
  check("H44 the band's labels are its fields' names: median block, public seeds, on chain, answered as listed (never latest block, never answered DNO)",
    JSON.stringify(labels) === JSON.stringify(["median block", "public seeds", "on chain", "answered as listed"]) && !/>\s*(latest block|answered DNO)\s*</i.test(HOME), labels.join(" | "));
}
// The panel head as the operator's board has it (2026-10-28): "read HH:MM:SS UTC · next in N s", the API version moved
// to the panel's last line, Pause and Refresh kept as text (a page that updates itself can be paused: WCAG 2.2.2).
check("H45 the head: the agent writes 'read HH:MM:SS UTC', the page says 'next in N s', Pause and Refresh stay, the API version is on the last line",
  SRC.includes(`'<span id="obs-at">read ' + e(c.observed_at.slice(11, 19)) + ' UTC</span>'`) && HOME.includes("`next in ${left} s`") && HOME.includes('id="btn-pause"') && HOME.includes('id="btn-refresh"')
  && /<p class="bound">[^<]*API <span id="api-v">reading<\/span>\.<\/p>/.test(HOME));
// A figure that waits on its own gate is not on the first screen: the block interval (FR-WEB-INTERVAL), the seeds' block
// hash (the strip, from 2026-11-01), and the recent blocks' signatures (committee build).
{
  const band = HOME.slice(HOME.indexOf('id="band"'), HOME.indexOf('<p class="bound">'));
  check("H40 the band ships no gated figure: no interval, no block hash, no recent-blocks signature count", band.length > 0 && !/every \[|\bevery \d+ s\b|block hash|signature|recent blocks|\[300\]/i.test(band), (band.match(/.{30}(every \[|block hash|signature|recent blocks).{30}/i) || [])[0]);
}
check("H27 This cycle card: no 'nodes aligned' and no calm or status-reason line in the page", !/nodes aligned/.test(HOME.slice(HOME.indexOf('id="panel"'), HOME.indexOf('<p class="bound">', HOME.indexOf('id="panel"')))) && !HOME.includes('id="calm"') && !HOME.includes('id="status-reason"'));
check("H12 agent builds the same markers", MARKERS.slice(0, 7).every((m) => SRC.includes(JSON.stringify(m).slice(1, -1).replace(/\\"/g, '"')) || SRC.includes("'" + m + "'")));
const markSha = createHash("sha256").update(readFileSync(join(ROOT, "assets", "dno-mark.jpg"))).digest("hex");
const shaInSrc = (SRC.match(/MARK_ASSET_SHA256 = "([0-9a-f]{64})"/) || [])[1];
check("H13 assets/dno-mark.jpg is the locked mark the agent serves", !!shaInSrc && markSha === shaInSrc, markSha.slice(0, 12));
check("H14 homepage references the mark asset path", HOME.includes('href="/assets/dno-mark-' + markSha.slice(0, 8) + '.jpg"') && !HOME.includes("data:image/jpeg"));
check("H15 homepage reads the same origin", HOME.includes("const SERVED_BY_AGENT = true;"));
const homeText = withoutAllowed(HOME);
check("H16 homepage: no banned word", !BANNED.test(homeText), (homeText.match(BANNED) || [])[0]);
// Correctness wave 1, "no implied approval" (STUDY-DNO-usefulness-correctness-2026-10-21 §3 c, i; R-05, R-06, R-07).
check("R05a a zero incident count is not shown in the ok tone (the count is structurally zero: DNO opens no record of that kind)", !/setTone\(\$\('inc-ind'\), 'ok'\)/.test(HOME), "ok tone on inc-ind");
check("R05b the zero says so", HOME.includes("No active public incidents. DNO currently opens no record of this kind; condition records are listed below."));
check("R06 the 'After the 1.1 update' note shows under API 1.1 only, not under every later version", HOME.includes("h.api_version === '1.1'") && !/\/\^1\\\.\[1-9\]\\d\*\(\\\.\|\$\)\//.test(HOME.slice(HOME.indexOf("'seen-drop'"), HOME.indexOf("'seen-drop'") + 400)), "regex still present");
check("R07a /badge carries no tick (an approval glyph) for any status", !/\\u2713|\u2713|✓/.test(SRC.slice(SRC.indexOf('reqPath === "/badge"'), SRC.indexOf('reqPath === "/badge"') + 1600)), "tick in the badge route");
check("R07b the badge text is the status word alone when stable", SRC.includes('bLabel + (bIcon ? " " + bIcon : "")'));
// Reading integrity (PR-2; SPEC-DNO-V7 D-1, D-2, D-5, D-6): one observation, no retained count, each /health part on its own clock.
check("D1a the reading's reasons are /organism's: no same-label substitution from /health", !/same\('risk'\)|same\('confidence'\)/.test(HOME) && HOME.includes("const rf = o.risk_factors;") && HOME.includes("const cr = o.confidence_reason;"));
check("D1b /health joins the seeds line on observation identity only (equal observed_at), never on alike labels", !HOME.includes("statusAlike") && HOME.includes("h.observed_at === o.observed_at") && HOME.includes("function seedsReading(o, h) {\n    if (sameObservation(h, o)) {"));
check("D5a no stored or historical ACTIVE count in the page: ONE_READ and the oneread mode are gone", !/ONE_READ|oneread|\bone read\b/.test(HOME), (HOME.match(/.{20}(ONE_READ|oneread|\bone read\b).{20}/) || [])[0]);
check("D5b a /health without on_chain_validators is 'unpublished': not reported, nothing retained (the band's tile: HOME_CYCLE.tileOnChain, B11)", HOME.includes("oc ? 'live' : 'unpublished'") && HOME.includes("HOME_CYCLE.tileOnChain(h)") && !/tileOnChain\([^)]*(last|prev|cache)/i.test(HOME));
check("D2 the watch round shows its own clock beside the list-read clock", HOME.includes("`watch round ${clock(parseTime(w.round_at))}`") && HOME.includes("`List read ${clock(parseTime(oc.observed_at))}`"));
check("H16b homepage: no adoption, demand, settled-commerce, or rail-reality claim", !CHARACTERIZATION.test(homeText), (homeText.match(CHARACTERIZATION) || [])[0]);
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
const listOf = (name) => [...SRC.slice(SRC.indexOf("var " + name + " = ["), SRC.indexOf("];", SRC.indexOf("var " + name + " = ["))).matchAll(/\["(\/[a-z\/-]*)", "[a-z-]+", "([^"]+)"(?:, "([a-z]+)")?\]/g)].map((m) => ({ path: m[1], label: m[2], group: m[3] || null }));
const navAgent = listOf("SITE_NAV").map((n) => n.path + " " + n.label);
const hrefs = (html) => [...html.matchAll(/<a href="(\/[a-z\/-]*)"(?: aria-current="page")?>([^<]+)<\/a>/g)].map((m) => m[1] + " " + m[2]);
const navHome = hrefs((HOME.match(/<nav class="nav" aria-label="Primary">([\s\S]*?)<\/nav>/) || ["", ""])[1]);
check("H22 homepage nav = site nav: five links (Reading, Sources, Methodology, Explore, Developers)", navAgent.length === 5 && JSON.stringify(navAgent) === JSON.stringify(navHome)
  && JSON.stringify(navAgent) === JSON.stringify(["/ Reading", "/sources Sources", "/methodology Methodology", "/reference Explore", "/docs Developers"]), navHome.join(", "));
// NAV-REACH: every HTML page the agent serves is linked from the Menu and the footer of every page, not only by its URL.
const PAGES = ["/", "/sources", "/methodology", "/criteria", "/reference", "/timeline", "/commerce", "/about-demos", "/agent", "/docs"];
const pageList = listOf("SITE_PAGES");
check("NAV-REACH1 each listed page is a route the agent serves", PAGES.every((p) => p === "/" || SRC.includes('reqPath === "' + p + '"')), PAGES.filter((p) => p !== "/" && !SRC.includes('reqPath === "' + p + '"')).join(" "));
check("NAV-REACH2 SITE_PAGES lists every page, each in the Read or About group", PAGES.every((p) => pageList.some((n) => n.path === p)) && pageList.every((n) => n.group === "read" || n.group === "about"), pageList.map((n) => n.path).join(" "));
check("NAV-REACH3 the agent's Menu and footer are built from SITE_PAGES (every other page gets every page)", /details class="menu"><summary>Menu<\/summary><ul>' \+ sitePageLinks\(active\)/.test(SRC) && SRC.includes('sitePageLinks(active, "read")') && SRC.includes('sitePageLinks(active, "about")'));
const homeFoot = HOME.slice(HOME.indexOf('<footer class="site-foot">'), HOME.indexOf("</footer>", HOME.indexOf('<footer class="site-foot">'))), homeMenu = HOME.slice(HOME.indexOf('<details class="menu">'), HOME.indexOf("</details>", HOME.indexOf('<details class="menu">')));
check("NAV-REACH4 the homepage's footer and Menu link every page", PAGES.every((p) => homeFoot.includes('href="' + p + '"') && homeMenu.includes('href="' + p + '"')), PAGES.filter((p) => !homeFoot.includes('href="' + p + '"') || !homeMenu.includes('href="' + p + '"')).join(" "));
check("NAV-REACH5 /commerce/methodology is linked from /commerce", readFileSync(join(ROOT, "commerce.html"), "utf8").includes('href="/commerce/methodology"'));
const kitCss = readFileSync(join(ROOT, "assets", "site.css"), "utf8");
const chrome = kitCss.slice(kitCss.indexOf("/* chrome:start */"), kitCss.indexOf("/* chrome:end */"));
check("H23 homepage inlines the site kit's chrome CSS verbatim", chrome.length > 1000 && HOME.includes(chrome));
// Self-hosted type and the decorative artwork (PR-3 ①): files served by content hash, named by the same hash where used.
const kitHash = (f) => createHash("sha256").update(readFileSync(join(ROOT, f))).digest("hex").slice(0, 8);
const fontSans = "/assets/geist-" + kitHash("assets/fonts/Geist-Variable.woff2") + ".woff2", fontMono = "/assets/geist-mono-" + kitHash("assets/fonts/GeistMono-Variable.woff2") + ".woff2";
check("K1 the chrome's @font-face names the served font files by their content hash", chrome.includes('url("' + fontSans + '")') && chrome.includes('url("' + fontMono + '")'), fontSans + " " + fontMono);
check("K2 the homepage preloads the same sans file; the site head preloads the served one", HOME.includes('<link rel="preload" href="' + fontSans + '" as="font" type="font/woff2" crossorigin>') && SRC.includes('loadKitAsset("assets/fonts/Geist-Variable.woff2", "geist", ".woff2", "font/woff2")'));
check("K3 no visitor's browser is sent to a font host: no Google Fonts in the homepage, the kit stylesheet or the agent", !/fonts\.(googleapis|gstatic)\.com/.test(HOME + kitCss + SRC));
check("K4 the font licence ships beside the fonts and is served", readFileSync(join(ROOT, "assets", "fonts", "OFL.txt"), "utf8").includes("SIL Open Font License, Version 1.1") && SRC.includes('loadKitAsset("assets/fonts/OFL.txt"'));
check("K5 the artwork is served in three formats from one source, by content hash", ["avif", "webp", "jpg"].every((x) => SRC.includes('loadKitAsset("assets/dno-planet.' + x + '", "dno-planet", ".' + x + '"')));
// V7 palette (PR-3 ③): decorative colours are declared once, in the chrome, far from every tone and from LIVE cyan.
const tok = (name) => (chrome.match(new RegExp("--" + name + ":\\s*(#[0-9A-Fa-f]{6})")) || [])[1];
const lab = (hex) => { const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const X = (c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047, Y = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722, Z = (c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]; };
const dE = (a, b) => Math.hypot(...lab(a).map((v, k) => v - lab(b)[k]));
const DECOR = ["navy-line", "violet", "violet-2", "ice", "ice-2"], TONES = ["operable", "elevated-risk", "degraded", "unknown", "metal-0", "live"];
check("PAL1 each decorative colour is ΔE > 20 (CIE76) from every tone colour and from LIVE cyan", DECOR.every((d) => tok(d) && TONES.every((t) => tok(t) && dE(tok(d), tok(t)) > 20)),
  DECOR.map((d) => d + " " + Math.min(...TONES.map((t) => (tok(d) && tok(t) ? dE(tok(d), tok(t)) : 0))).toFixed(1)).join(", "));
check("PAL2 no tone or lamp rule uses a decorative colour", ![...(kitCss + HOME).matchAll(/\[data-tone[^{]*\{[^}]*\}|\.ind(?![\w-])[^{]*\{[^}]*\}/g)].some((m) => /--(navy-line|violet|ice)/.test(m[0])));
check("H35 the agent fills the V7 first-screen markers from the same strings", SRC.includes("summary: '<p class=\"summary\" id=\"summary\" data-src=\"api\">reading</p>'") && SRC.includes("observedAt: '<span id=\"obs-at\">not read yet</span>'") && SRC.includes("apiVersion: '<span id=\"api-v\">reading</span>'") && SRC.includes('reading_agreement: homeCardMarker("reading_agreement")'));
const artRef = (x) => "/assets/dno-planet-" + kitHash("assets/dno-planet." + x) + "." + x;
check("K6 the hero names the served artwork files by their content hash (AVIF, WebP, JPEG)", ["avif", "webp", "jpg"].every((x) => HOME.includes('url("' + artRef(x) + '")')), ["avif", "webp", "jpg"].map(artRef).join(" "));
// The subpages in the V7 shell: one width and one surface on every page, the title band's artwork by content hash, notes styled.
const homeOwn = HOME.split(chrome).join(""), homeOwnTokens = homeOwn.match(/--(?:measure|bg|bg-2|surface|elevated|line)\s*:[^;]*/g) || [];
check("SK1 one width and one surface on every page: the homepage sets the width and the surfaces only through the shared chrome", chrome.length > 1000 && HOME.includes(chrome) && homeOwnTokens.length === 0, homeOwnTokens.join("; "));
check("SK2 the subpages' title band names the served artwork files by their content hash (AVIF, WebP, JPEG)", ["avif", "webp", "jpg"].every((x) => kitCss.includes('url("' + artRef(x) + '")')), ["avif", "webp", "jpg"].map(artRef).join(" "));
check("SK3 notes are styled on the subpages, not only on the homepage", /(^|[\s,}])\.note\s*\{/m.test(kitCss));
// Sources (S2b): the decision figure states status-rule.mjs's witness rule, and the published text below it is unchanged.
const SOURCES = readFileSync(join(ROOT, "sources.html"), "utf8");
const srcFig = (SOURCES.match(/<figure class="decision"[\s\S]*?<\/figure>/) || [""])[0];
const srcBranch = (b) => (srcFig.match(new RegExp('<div class="branch" data-branch="' + b + '">[\\s\\S]*?</ul>')) || [""])[0];
const modesOf = (h) => [...h.matchAll(/data-mode="([a-z_]+)"/g)].map((m) => m[1]);
const textOf = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
check("SB1 the Sources figure names the published witness modes, each once, in the rule's order", JSON.stringify(modesOf(srcFig)) === JSON.stringify(MODES), modesOf(srcFig).join(" "));
check("SB2 YES (two seed heights) leads only to seeds_only; NO leads to the three other modes", JSON.stringify(modesOf(srcBranch("yes"))) === JSON.stringify(["seeds_only"]) && JSON.stringify(modesOf(srcBranch("no"))) === JSON.stringify(MODES.slice(1))
  && /two configured public seeds report their own height/.test(textOf(srcFig)), "yes: " + modesOf(srcBranch("yes")).join(" ") + " / no: " + modesOf(srcBranch("no")).join(" "));
check("SB3 the ACTIVE count is never drawn as an input: absent from the figure, and the page says it never enters status", !/ACTIVE/.test(srcFig) && SOURCES.includes("the list's ACTIVE count never enters status."));
const srcFigText = textOf(srcFig), candHours = RULE.candidateMaxAgeMs / 3600000;
const figBands = [...srcFigText.matchAll(/±\s*(\d+)/g)].map((m) => +m[1]);
check("SB4 the figure's numbers are status-rule.mjs's (band, validators read, candidate age)", figBands.length === 2 && figBands.every((b) => b === RULE.bandBlocks) && srcFigText.includes("Up to " + RULE.witnessMax + " validators") && srcFigText.includes("last " + candHours + " hours"),
  "bands " + figBands.join(",") + " vs " + RULE.bandBlocks + ", max " + RULE.witnessMax + ", " + candHours + " h");
const layerRows = [...((SOURCES.match(/<section id="layers">[\s\S]*?<\/section>/) || [""])[0]).matchAll(/<td data-label="Layer">([^<]+)<\/td>[\s\S]*?<td data-label="Enters status">([^<]+)<\/td>/g)].map((m) => m[1] + " = " + m[2]);
const entersRows = [...((SOURCES.match(/<ul class="enters">[\s\S]*?<\/ul>/) || [""])[0]).matchAll(/<li><span>([^<]+)<\/span><b>([^<]+)<\/b><\/li>/g)].map((m) => m[1] + " = " + m[2]);
check("SB5 'What enters status' repeats the Source layers table row for row (six rows since A1)", layerRows.length === 6 && JSON.stringify(entersRows) === JSON.stringify(layerRows), entersRows.join("; "));
const srcArticleAt = SOURCES.indexOf('<div class="wrap doc-grid">'), srcArticle = srcArticleAt < 0 ? "" : SOURCES.slice(srcArticleAt, SOURCES.indexOf("</article>") + "</article>".length);
check("SB6 the published Sources text (section list and article) is byte for byte the article after D8's one sentence (six fields); the orientation adds nothing inside it", createHash("sha256").update(srcArticle).digest("hex") === "82dee27f4d306bbf18a6a31198b2ccec549b905935fc4f00f1c6840365225002" && !/other six values/.test(srcArticle)
  && ["resolution", "layers", "separation", "endpoints", "dahr", "limits"].every((id) => count(SOURCES, 'id="' + id + '"') === 1));
const idsIn = (h) => new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const srcIds = idsIn(SOURCES), methIds = idsIn(readFileSync(join(ROOT, "methodology.html"), "utf8")), aboutIds = idsIn(readFileSync(join(ROOT, "about-demos.html"), "utf8"));
const srcLinks = [...SOURCES.matchAll(/href="(\/methodology|\/about-demos)?#([^"]+)"/g)].map((m) => [m[1] || "", m[2]]);
const deadLinks = srcLinks.filter(([pg, id]) => !(pg === "" ? srcIds : pg === "/methodology" ? methIds : aboutIds).has(id)).map(([pg, id]) => pg + "#" + id);
check("SB7 every in-page and cross-page anchor on Sources lands on an id that exists", srcLinks.length >= 10 && deadLinks.length === 0, deadLinks.join(" "));
check("SB8 one h1 on Sources, the page's name; the slogan sits under it", count(SOURCES, "<h1") === 1 && SOURCES.includes("<h1>Sources</h1>\n        <p class=\"doc-tagline\">Follow the evidence.</p>"));
check("SB9 the locked sentence is not in the Sources text: the shared footer carries it once", count(SOURCES, "DNO informs context; it does not advise") === 0 && count(SRC, "DNO informs context; it does not advise, predict, score, certify, or decide action.</p>'") === 1);
const srcOrient = textOf(SOURCES.slice(SOURCES.indexOf('<p class="doc-kicker">'), srcArticleAt)).split(/(?<=[.!?])\s+/).filter(publicLanguageHit);
check("SB10 the new Sources text (title band and orientation) passes the public-language ban", srcArticleAt > 0 && srcOrient.length === 0, srcOrient.join(" | "));
const s2Classes = /\.(branch|branches|outcome|outcomes|fork|enters)\b/;
const kitSelectors = [...kitCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((sel) => !sel.startsWith("@")).flatMap((sel) => sel.split(",")).map((sel) => sel.trim());
const unscoped = kitSelectors.filter((sel) => s2Classes.test(sel) && !/^\.(decision|orient)\s/.test(sel));
check("SB11 the Sources figure's styles are scoped under .decision or .orient (the homepage has a .branch figure of its own)", unscoped.length === 0, unscoped.join(" | "));
const ruleBody = (sel) => ([...kitCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].find((m) => m[1].split(",").map((x) => x.trim()).includes(sel)) || ["", "", ""])[2];
check("SB12 an outcome reflows at large text sizes: its one column can shrink and a mode name may break", /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(ruleBody(".decision .outcome")) && /overflow-wrap:\s*anywhere/.test(ruleBody(".decision .outcome code")),
  ruleBody(".decision .outcome").trim() + " | " + ruleBody(".decision .outcome code").trim());
check("SK4 the homepage loads no stylesheet: only the chrome is shared, inline, so no subpage rule can reach it", !/<link[^>]*rel="stylesheet"/.test(HOME) && !HOME.includes("<!--dno:head-->") && !/\/assets\/site-[0-9a-f]{8}\.css/.test(HOME));
const kitRules = [...kitCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].split(",").map((x) => x.trim()), body: m[2] }));
const stackTdRules = kitRules.filter((r) => r.sel.includes(".tbl.stack td")), stackLabel = kitRules.filter((r) => r.sel.includes(".tbl.stack td::before"));
check("SK5 on phones a stacked cell keeps its text in one flow beside its label (no grid item per word), and the last row draws one rule", stackTdRules.length >= 2 && stackTdRules.every((r) => !/display\s*:\s*(grid|flex)/.test(r.body))
  && stackLabel.length === 1 && /position\s*:\s*absolute/.test(stackLabel[0].body) && kitRules.some((r) => r.sel.includes(".tbl.stack tr:last-child td") && /border-bottom:\s*0/.test(r.body)),
  stackTdRules.map((r) => r.body.trim()).join(" | "));
// About Demos (S2a): plain words, then the two views, then the words, above the unchanged article.
const ABOUT = readFileSync(join(ROOT, "about-demos.html"), "utf8");
const abArticleAt = ABOUT.indexOf('<div class="wrap doc-grid">'), abArticle = abArticleAt < 0 ? "" : ABOUT.slice(abArticleAt, ABOUT.indexOf("</article>") + "</article>".length);
const abSection = (id) => (ABOUT.match(new RegExp('<section class="orient" id="' + id + '"[\\s\\S]*?</section>')) || [""])[0];
const abPlain = abSection("plain"), abFits = abSection("fits"), abTerms = abSection("terms");
const abNew = ABOUT.slice(ABOUT.indexOf('<p class="doc-kicker">'), abArticleAt), abNewText = textOf(abNew.replace(/<code>[\s\S]*?<\/code>/g, " "));
const abAt = (h) => (h ? ABOUT.indexOf(h) : -1), abFull = ABOUT.indexOf('<div class="wrap orient-full" id="full">');
check("SA1 the order is plain words, where DNO fits, then the words straight after, then the full text, numbered 01 to 04", abAt(abPlain) > 0 && abAt(abPlain) < abAt(abFits) && abAt(abFits) < abAt(abTerms) && abAt(abTerms) < abFull && abFull < abArticleAt
  && ABOUT.slice(abAt(abFits) + abFits.length, abAt(abTerms)).trim() === "" && JSON.stringify([...abNew.matchAll(/<p class="orient-k">(\d\d) \//g)].map((m) => m[1])) === '["01","02","03","04"]');
const ABOUT_IDS = "cannot-see dahr dno-dahr h-cannot h-dahr h-dno-dahr h-health h-inside h-shards h-sources h-two h-val h-what h-words inside lanes-cap lifecycle main node-health phase-1 sd-block sd-cap sd-hashes sd-next sd-order sd-seed sd-set sd-shard shard-demo shards sm-cap sm-meaning sm-moves sources two-mechanisms validator-reads validators what words words-table".split(" ");
const abIdList = [...ABOUT.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
check("SA2 the published About Demos text is byte for byte the article after D9's three sentences (nothing else inside it moved); every id it had is still there, once", createHash("sha256").update(abArticle).digest("hex") === "929e4947c82c88e75ee8ccec43d23ae454da74e67c03650ad630af531476457e"
  && !/never sees the second one|<dd>Nothing\.<\/dd>|<li>Who is in a shard\.<\/li>/.test(abArticle) && (abArticle.match(/does not use or check/g) || []).length === 3
  && ABOUT_IDS.every((id) => abIdList.filter((x) => x === id).length === 1) && new Set(abIdList).size === abIdList.length, ABOUT_IDS.filter((id) => abIdList.filter((x) => x === id).length !== 1).join(" "));
check("D9 the homepage's limits list no longer says DNO cannot see who is in the shard as an absolute: it names what a node publishes and that DNO does not use or check it", !/<li>Who is in the shard, or who the secretary is\.<\/li>/.test(HOME) && /beyond what a node publishes about its own\. DNO does not use or check that\./.test(HOME));
{ const METH = readFileSync(join(ROOT, "methodology.html"), "utf8"); check("D8 the methodology and sources say six fields, never seven values; incidents and conditions are records beside them", !/\bseven values\b|all seven|the seven values|none of the seven/.test(METH) && (METH.match(/six fields/g) || []).length >= 4 && /incident and condition records beside them/.test(METH) && /other five fields/.test(SOURCES)); }
check("SA3 one h1 on About Demos, the page's name; the slogan sits under it", count(ABOUT, "<h1") === 1 && ABOUT.includes("<h1>About Demos</h1>\n        <p class=\"doc-tagline\">The network, from outside.</p>"));
const monitorS = Number((SRC.match(/const MONITOR_INTERVAL_MS = parseInt\(process\.env\.MONITOR_INTERVAL_MS \|\| "(\d+)"\)/) || [])[1]) / 1000;
const readOn = abArticle.match(/read on (\d{1,2}) ([A-Z][a-z]+) (\d{4})/) || [], readShort = readOn.length ? readOn[1] + " " + readOn[2].slice(0, 3) + " " + readOn[3] : "?";
const healthTable = (abArticle.match(/<section id="node-health"[\s\S]*?<\/table>/) || [""])[0], healthRow = (abTerms.match(/<tr data-term="health">[\s\S]*?<\/tr>/) || [""])[0];
const tableWords = [...healthTable.matchAll(/<td data-label="Status"><code>([a-z]+)<\/code>/g)].map((m) => m[1]), rowWords = [...((healthRow.match(/<td data-label="In Demos">[\s\S]*?<\/td>/) || [""])[0]).matchAll(/<code>([a-z]+)<\/code>/g)].map((m) => m[1]);
const dahrName = (abArticle.match(/DAHR is the ([A-Z][A-Za-z ]+?) \(/) || [])[1];
check("SA4 what the new text repeats is the source's: the 20 s cycle, the docs' reading date, a node's four words, DAHR's name, the docs' phrase",
  monitorS > 0 && abFits.includes("every " + monitorS + " s") && abArticle.includes("every " + monitorS + " s")
  && abFits.includes("read " + readShort) && ABOUT.includes("<span>Read <b>" + readShort + "</b></span>")
  && tableWords.length === 4 && JSON.stringify(rowWords) === JSON.stringify(tableWords)
  && !!dahrName && abPlain.includes("With DAHR, the " + dahrName + ", the node")
  && abPlain.includes("“an interconnectivity layer across chains and web contexts”") && abArticle.includes("as an interconnectivity layer across chains and web contexts")
  && abPlain.includes("stores only those hashes, not the response") && abArticle.includes("stores only hashes of the response"),
  [monitorS, readShort, tableWords.join(","), rowWords.join(","), dahrName].join(" | "));
const abHrefs = [...abNew.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), abArticleHrefs = new Set([...abArticle.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]));
const abDead = abHrefs.filter((h) => h.startsWith("#") ? !abIdList.includes(h.slice(1)) : h.startsWith("/methodology#") ? !methIds.has(h.split("#")[1]) : h.startsWith("http") ? !abArticleHrefs.has(h) : !["/sources", "/methodology"].includes(h));
check("SA5 every link in the new text lands: anchors on ids that exist, and no outside source the article does not already cite", abHrefs.length >= 8 && abDead.length === 0, abDead.join(" "));
check("SA6 the locked sentence is not in the About Demos text: the shared footer carries it once", count(ABOUT, "DNO informs context; it does not advise") === 0);
const abBanned = textOf(abNew).split(/(?<=[.!?])\s+/).filter(publicLanguageHit);
check("SA7 the new About Demos text (title band and orientation) passes the public-language ban", abArticleAt > 0 && abBanned.length === 0, abBanned.join(" | "));
const abProse = textOf(abNew.replace(/<code>[\s\S]*?<\/code>/g, " ").replace(/<a href="https?:[^"]*">[^<]*<\/a>/g, " "));   // a cited page's title is its own, not the page's prose
const abBand = textOf((ABOUT.match(/<header class="doc-head">[\s\S]*?<\/header>/) || [""])[0]), abBandAcr = [...abBand.matchAll(/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*s?\b/g)].map((m) => m[0]).filter((a) => a !== "DNO");
const abAcr = [...new Set([...abProse.matchAll(/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*s?\b/g)].map((m) => m[0]))];
check("SA8 the title band names no acronym but DNO; the new prose none but DAHR (named at first use, as the article names it) and SDKs (introduced as developer kits)", abBand.length > 100 && abBandAcr.length === 0 && abAcr.every((a) => ["DNO", "DAHR", "HTTPS", "SDKs"].includes(a))
  && abNewText.indexOf("DAHR") === abNewText.indexOf("DAHR, the " + dahrName) && abNewText.indexOf("SDKs") === abNewText.indexOf("developer kits (SDKs)") + "developer kits (".length, "band: " + abBandAcr.join(" ") + " | prose: " + abAcr.join(" "));
const abOutside = textOf((abFits.match(/<div data-lens="outside">[\s\S]*?<\/div>/) || [""])[0]);
check("SA9 'where DNO fits' names the validators that stand in, not only the three seeds", /three configured public seeds/.test(abOutside) && /When fewer than two seeds give their own height, validators that answer as listed can stand in/.test(abOutside), abOutside);
const abExample = textOf(abPlain);
check("SA10 the DAHR example keeps its limits and does not say who records the hashes (the docs do not)", abExample.includes("It does not show that any application used it, that the content returned was correct, or that a given transaction was included.")
  && !/node (records|stores|writes|posts|signs)/.test(abExample) && abArticle.includes("the pages linked here do not say which party signs and broadcasts it"));
const abStyle = (ABOUT.match(/\/\* About Demos: the orientation above the article \(S2a\)\.[^*]*\*\/([\s\S]*?)<\/style>/) || ["", ""])[1];
const abSel = [...abStyle.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).flatMap((s) => s.split(",")).map((s) => s.trim());
check("SA11 the S2a styles in the page are scoped under .orient", abSel.length >= 5 && abSel.every((s) => /^\.orient\s/.test(s)), abSel.filter((s) => !/^\.orient\s/.test(s)).join(" | "));
// A node's own /info can list its shard and name the secretary (seed read 2026-10-24, A35): the limit is that DNO does not read or check it, not that it cannot be seen.
const abSeeClaims = abNewText.split(/(?<=[.!?])\s+/).filter((x) => /\b(cannot|can't|does not|never|not) (see|sees|seen)\b/i.test(x) && /shard|consensus|secretary|vote/i.test(x));
check("SA12 the new text says DNO does not use or check consensus data (it fetches the /info that carries it), never that it cannot see it", abSeeClaims.length === 0 && (abNewText.match(/does not use or check it/g) || []).length === 2 && !/neither reads nor checks/.test(abNewText), abSeeClaims.join(" | "));

// ---- S2c: the Methodology page opens with the six fields, who decides a round, and what stays outside ----------------
const METHP = readFileSync(join(ROOT, "methodology.html"), "utf8");
const meArticleAt = METHP.indexOf('<div class="wrap doc-grid">'), meArticle = meArticleAt < 0 ? "" : METHP.slice(meArticleAt, METHP.indexOf("</article>") + "</article>".length);
const meOrient = meArticleAt < 0 ? "" : METHP.slice(METHP.indexOf("<main"), meArticleAt);
const meText = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
check("SC1 one h1 on Methodology, the page's name, with the kicker and tagline; 'How the Oracle works' names the full text", count(METHP, "<h1") === 1 && METHP.includes("<h1>Methodology</h1>") && /<p class="doc-kicker">Method<\/p>/.test(METHP) && /04 \/ How the Oracle works, in full/.test(meOrient));
check("SC2 the orientation (fields, who-decides, outside, full) sits above the article, each id once", ["fields", "who-decides", "outside", "full"].every((id) => count(meOrient, 'id="' + id + '"') === 1 && count(METHP, 'id="' + id + '"') === 1) && meOrient.indexOf('id="fields"') < meOrient.indexOf('id="who-decides"') && meOrient.indexOf('id="who-decides"') < meOrient.indexOf('id="outside"') && meOrient.indexOf('id="outside"') < meOrient.indexOf('id="full"'));
{ const PAGES = ["homepage.html", "methodology.html", "sources.html", "about-demos.html", "agent-guide.html", "criteria.html", "commerce.html", "commerce-methodology.html"];
  const held = PAGES.filter((f) => /\((date of deploy|date|TBD|TODO)[^)]*\)|\bTODO\b|\bTBD\b/.test(readFileSync(join(ROOT, f), "utf8")));
  check("PH1 no served page carries an unfilled placeholder: '(date of deploy)', '(date …)', TODO or TBD", held.length === 0, held.join(", ")); }
check("SC3 the published Methodology text (section list and article) is byte for byte the article after the 2026-10-25 changelog entries, D5, D3 and the IP-addresses-targeted entry (dated 2026-10-26) and paragraph: the orientation adds nothing inside it; every section id once", createHash("sha256").update(meArticle).digest("hex") === "66e40fe83cc4d774b6b353f5c3b4be84b94240003c5f6af9861695d0dfa508a3"
  && ["what-the-oracle-is", "what-it-measures", "how-it-works", "validators", "witnesses", "block-identity", "clocks", "known-limitations", "methodology-changelog"].every((id) => count(METHP, 'id="' + id + '"') === 1));
{ const AG = readFileSync(join(ROOT, "agent-guide.html"), "utf8");
  check("D5 the locked sentence is not in the Methodology or Agent Guide text either: the shared footer carries it on every page; the sentences around it stay",
    count(METHP, "DNO informs context; it does not advise") === 0 && count(AG, "DNO informs context; it does not advise") === 0
    && AG.includes("<p>These fields describe how complete this observation is.</p>") && AG.includes('<div class="aside">This API describes state. It does not suggest actions.<br>The Oracle publishes its core assessment. Your agent interprets it.</div>')
    && METHP.includes("The locked sentence in the footer of every page is no longer repeated at the end of the limitations.")); }
{ const beta = [["homepage.html", HOME], ["methodology.html", METHP], ["src/agent.mjs", AGENTSRC]].map(([n, t]) => [n, count(t, "Demos beta")]);
  const NEW = "a census of the public Demos testnet";
  check("D3 'Demos beta' is gone from every page and from the /catalog notes: each place says 'the public Demos testnet', the name the site gives the network elsewhere; only the changelog quotes the old words",
    count(HOME, NEW) === 2 && count(METHP, "not " + NEW + ", and not a promise of monitoring.") === 1 && count(AGENTSRC, "Not " + NEW + ".") === 3
    && beta.every(([n, c]) => c === (n === "methodology.html" ? 1 : 0)) && /Peer-listed identities are said not to be a census of the public Demos testnet, the name this site gives the network everywhere else, where the page said "Demos beta"\. No rule changed\.<\/p>/.test(METHP), JSON.stringify(beta)); }
const FIELDS = ["status", "trend", "risk", "data_quality", "confidence", "agreement"];
const fieldRows = [...meOrient.matchAll(/<li data-field="([a-z_]+)"><code>([a-z_]+)<\/code><span>([^<]+)<\/span><a href="#([^"]+)">the rule<\/a><\/li>/g)];
check("SC4 the six fields, in the schema's order, each naming itself once and linking to its own rule in the article", fieldRows.length === 6 && JSON.stringify(fieldRows.map((m) => m[1])) === JSON.stringify(FIELDS) && fieldRows.every((m) => m[1] === m[2] && m[4] === "what-it-measures-" + m[1].replace("_", "-") && count(meArticle, 'id="' + m[4] + '"') === 1), fieldRows.map((m) => m[1]).join(" "));
const meArtText = meText(meArticle);
const fieldSentences = fieldRows.map((m) => m[3].replace(/\s+/g, " ").trim());
const notBound = fieldSentences.filter((t) => !t.split(/(?<=[.])\s+/).every((sent) => sent.length < 12 || meArtText.includes(sent.replace(/\.$/, ""))));
check("SC5 every sentence in the fields list is the article's own (no new definition on the orientation)", notBound.length === 0, notBound.join(" | "));
check("SC5b the records are named beside the six with the article's own sentence, never as a seventh field", /Beside the six: the incident and condition records\. Condition records follow status, so they do not feed it\./.test(meOrient) && meArtText.includes("Condition records follow status, so they do not feed it") && !/seventh|seven values/.test(meOrient));
const modeRows = [...meOrient.matchAll(/<li data-mode="([a-z_]+)">/g)].map((m) => m[1]);
check("SC6 the modes list names status-rule.mjs's modes, each once, in the rule's order", JSON.stringify(modeRows) === JSON.stringify(MODES), modeRows.join(" "));
const modesText = meText((meOrient.match(/<ul class="enters modes">[\s\S]*?<\/ul>/) || [""])[0]);
check("SC7 the modes' numbers are the rule's (±band twice, the 300 s age), and the witness rule, the drawn decision and the clocks are linked", [...modesText.matchAll(/±\s*(\d+)/g)].every((m) => +m[1] === RULE.bandBlocks) && count(modesText, "±") === 2 && /300 s/.test(modesText) && /href="#witnesses"/.test(meOrient) && /href="\/sources#path"/.test(meOrient) && count(SOURCES, 'id="path"') === 1 && /href="#clocks"/.test(meOrient) && count(METHP, 'id="clocks"') === 1);
check("SC8 'outside the reading' links each item to its rule, and every target exists once in the article", ["#block-identity", "#validators", "#public-vs-reference-separation", "#what-it-measures-incidents"].every((h) => meOrient.includes('href="' + h + '"') && count(meArticle, 'id="' + h.slice(1) + '"') === 1));
check("SC9 the version line is kept, once, with the full text", count(METHP, "Methodology v1.2 · 2026-10-05 · aligned with") === 1 && meOrient.includes("not aspirational, not approximate"));
check("SC10 no banned public language and no verdict words in the orientation", !publicLanguageHit(meText(meOrient)) && !/\b(healthy|health score|verified|certif|same chain|majority)\b/i.test(meText(meOrient)));
check("SC11 the page CSS is scoped to the orientation (.orient .fields), no bare selectors", [...METHP.matchAll(/^\s*\.[a-z][^{]*\{/gm)].every((m) => /^\s*\.orient[ #.]/.test(m[0])) && /\.orient \.fields \{/.test(METHP));


// ---- FR-REPRO: the agent guide tells a reader how to repeat the block-identity method ------------------------------------
const GUIDE = readFileSync(join(ROOT, "agent-guide.html"), "utf8");
const frSec = (GUIDE.match(/<section id="repeat-the-method">[\s\S]*?<\/section>/) || [""])[0];
const frText = frSec.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
check("FR1 the agent guide has 'Repeat the Method', once, listed in its contents, after Combining Endpoints", frSec.length > 0 && count(GUIDE, 'id="repeat-the-method"') === 1 && /<li><a href="#repeat-the-method">Repeat the Method<\/a><\/li>/.test(GUIDE) && GUIDE.indexOf('id="combining-endpoints"') < GUIDE.indexOf('id="repeat-the-method"') && GUIDE.indexOf('id="repeat-the-method"') < GUIDE.indexOf('id="commerce-api-layer-2"'));
check("FR2 five steps, in order: own height and hash · the block at that height · another seed · network identity · what DNO publishes", ["1. A seed's own height and block hash.", "2. The block at that height, from the same seed.", "3. The same height on another seed.", "4. Network identity.", "5. What DNO publishes about the same comparison."].map((t) => frText.indexOf(t)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1])));
const frCurls = [...frSec.matchAll(/curl [^\n]*/g)].map((m) => m[0]);
check("FR3 every request in the recipe is read-only with a timeout, and the calls are the ones DNO's method names", frCurls.length >= 4 && frCurls.every((c) => /--max-time \d/.test(c) && !/-L\b|--location/.test(c)) && ["getBlockByNumber", "getGenesisDataHash", "getNetworkInfo"].every((m) => new RegExp("\\b" + m + "\\b").test(frSec)) && /"method":"nodeCall","params":\[\{"type":"nodeCall","message":/.test(frSec));
const frSeedUrls = [...AGENTSRC.matchAll(/url: "(http:\/\/[a-z0-9.\-]+:\d+)"/g)].map((m) => m[1]);
const frUrls = [...frSec.matchAll(/http:\/\/[a-z0-9.\-]+:\d+/g)].map((m) => m[0]);
check("FR4 the seed URLs in the recipe are configured public seeds (the ones Sources publishes), no other host", frUrls.length >= 2 && frUrls.every((u) => frSeedUrls.includes(u)), frUrls.filter((u) => !frSeedUrls.includes(u)).join(" "));
check("FR5 the five states are named as /health publishes them, and the rule is linked", ["same_block", "different_block", "mixed", "no_shared_height", "insufficient"].every((st) => frSec.includes("<code>" + st + "</code>")) && /href="\/methodology#block-identity"/.test(frSec) && count(METHP, 'id="block-identity"') === 1);
check("FR6 the limits are stated: repeating ≠ reproducing an earlier round; one organization; not corroboration, finality, or participation; a missing comparison is not a disagreement", /does not reproduce an earlier DNO round/.test(frText) && /one organization/.test(frText) && /not independent corroboration/.test(frText) && /does not show that a block is final/.test(frText) && /not a disagreement/.test(frText));
check("FR7 full values decide equality; a prefix only recognises", /Compare the full 64-character values; a prefix is for recognising a hash, not for deciding equality\./.test(frText));
check("FR8 no banned public language or verdict words in the recipe", !publicLanguageHit(frText) && !/\b(healthy|verified|certif|synced|majority|canonical)\b/i.test(frText));
check("FR9 the Methodology orientation links the recipe", /href="\/agent#repeat-the-method">repeat it yourself<\/a>/.test(METHP));


// ---- FR-REF-503 and FR-COM-NOJS: an unavailable state is said, never a 200 that reads empty or a page that keeps waiting --
{
  const refBranch = (AGENTSRC.match(/reqPath === "\/reference"\) \{\s*([\s\S]*?)\n      function esc\(/) || ["", ""])[1];
  check("REF1 /reference without the store answers 503 in the site's shell (head, header, footer), says the tables are unavailable and that this says nothing about the network — never 200 'No data'",
    /res\.writeHead\(503,/.test(refBranch) && /siteHead\(\)/.test(refBranch) && /siteHeader\("reference"\)/.test(refBranch) && /siteFooter\("reference"\)/.test(refBranch) && /says nothing about the network/.test(refBranch) && !/No data/.test(refBranch) && !/writeHead\(200/.test(refBranch), refBranch.slice(0, 160));
  const COM = readFileSync(join(ROOT, "commerce.html"), "utf8");
  const comScript = (COM.match(/<script>([\s\S]*?)<\/script>/) || ["", ""])[1];
  check("COM1 without JavaScript the Commerce page says where the same observations are (a <noscript> note linking /commerce/observations)", /<noscript><p class="note" id="com-noscript">[^<]*<a href="\/commerce\/observations">\/commerce\/observations<\/a>/.test(COM));
  const catchBody = (comScript.match(/\} catch\(e\) \{([\s\S]*?)\n  \}\n\}\)\(\);/) || ["", ""])[1];
  check("COM2 when the observations cannot be read, every placeholder gets a state (the four cards and the table), none keeps 'Loading'",
    ["obs-state", "obs-dq", "obs-conf", "obs-count"].every((id) => catchBody.includes("'" + id + "'")) && /classList\.remove\('loading'\)/.test(catchBody) && /setTableNote\(/.test(catchBody), catchBody.slice(0, 200));
  check("COM3 with no authority observed the table says so instead of keeping its placeholder row (and says when the runner's file could not be read)", /if \(!d\.authorities \|\| d\.authorities\.length === 0\) setTableNote\(d\.error \? 'The probe runner\\'s results could not be read; the values above are the fallback\.' : 'No authority was observed in the last probe cycle\.'\);/.test(comScript));
  check("COM5 before the script runs (or without it) the placeholders say 'not read yet', never 'Loading' or 'reading' that would wait for ever", !/>Loading\.\.\.<|>reading</.test(COM) && (COM.match(/>not read yet</g) || []).length === 4 && />Not read yet\.</.test(COM));
  check("COM4 setTableNote writes text, not markup (textContent), and replaces the placeholder row", /function setTableNote\(text\) \{[\s\S]*?td\.textContent = text;[\s\S]*?replaceChildren\(tr\);\s*\}/.test(comScript) && !/innerHTML/.test(comScript));
}

// ---- S3: the two Commerce pages take the shared layout, and every word about a probe is the probe runner's own -----------
// The probe runner (src/commerce-probes.mjs) and the agent's public builder are the oracle: each check reads the value from
// the code and looks for the page's sentence about it, so a changed threshold, state or field fails here until the page says it.
{
  const COMP = readFileSync(join(ROOT, "commerce.html"), "utf8");
  const CMETH = readFileSync(join(ROOT, "commerce-methodology.html"), "utf8");
  const PROBES = readFileSync(join(ROOT, "src", "commerce-probes.mjs"), "utf8");
  const pubBuilder = (AGENTSRC.match(/function buildPublicCommerceObservation\(\) \{([\s\S]*?)\n\}\n/) || ["", ""])[1];
  const sec = (html, id) => (html.match(new RegExp('<section[^>]* id="' + id + '"[\\s\\S]*?</section>')) || [""])[0];
  const head = (html) => html.slice(html.indexOf('<header class="doc-head">'), html.indexOf("</header>", html.indexOf('<header class="doc-head">')));
  const one = (h, re) => (h.match(re) || []).length === 1;
  const headOk = (h, kicker) => one(h, /<p class="doc-kicker">/g) && h.includes('<p class="doc-kicker">' + kicker + "</p>") && one(h, /<h1>/g) && one(h, /<p class="doc-lede">/g) && /<div class="doc-facts">[\s\S]*<span>Layer <b>2<\/b> · separate from the reading<\/span>/.test(h);
  check("S3-1 Commerce: the shared title band — kicker 'Layer 2 · Commerce observation', one h1, one lede, facts beside the title saying Layer 2 is separate from the reading", headOk(head(COMP), "Layer 2 · Commerce observation"));
  check("S3-2 Commerce methodology: the shared title band — kicker 'Layer 2 · Method', one h1, one lede, the same facts line; contents beside the article", headOk(head(CMETH), "Layer 2 · Method") && /<div class="wrap doc-grid">\s*<details class="toc" open>/.test(CMETH) && /<article class="prose">/.test(CMETH));
  const comStyle = (COMP.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
  const comSelectors = comStyle.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")[0].trim()).filter((sel) => sel && !/^@media/.test(sel));
  check("S3-3 no inline style on either page; the methodology page has no page style; the Commerce page's own rules all sit under .orient", !/ style="/.test(COMP) && !/ style="/.test(CMETH) && !/<style>/.test(CMETH) && comSelectors.length > 0 && comSelectors.every((sel) => sel.split(",").every((x) => /^\.orient\b/.test(x.trim()))), comSelectors.filter((sel) => !/^\.orient\b/.test(sel)).join(" | "));
  const comScript = (COMP.match(/<script>([\s\S]*?)<\/script>/) || ["", ""])[1];
  check("S3-4 no colour carries a state: no hex or rgb colour on either page, no style or class set by the script, and the state is printed as the API's own lowercase word", !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(COMP + CMETH) && !/\.style\.|className\s*=|classList\.add|toUpperCase/.test(comScript) && /String\(a\.reachability \|\| 'unknown'\)/.test(comScript));
  const ths = [...(COMP.match(/<thead>[\s\S]*?<\/thead>/) || [""])[0].matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]);
  const labels = (comScript.match(/td\.setAttribute\('data-label', \[([^\]]+)\]\[i\]\)/) || ["", ""])[1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
  check("S3-5 the authority table stacks on a phone: class 'tbl stack', and each cell's label is its column header, in order", /<table class="tbl stack authority-table">/.test(COMP) && ths.length === 5 && JSON.stringify(ths) === JSON.stringify(labels), JSON.stringify(labels));
  const apiDisclaimer = (pubBuilder.match(/disclaimer: "([^"]+)"/) || ["", ""])[1];
  check("S3-6 the API's disclaimer, word for word, on both pages; on Commerce with the Layer 1 boundary and a link to /organism", apiDisclaimer.length > 100
    && /<p class="orient-key" id="com-disclaimer">/.test(COMP) && COMP.includes(apiDisclaimer + " Commerce observation is Layer 2 — it does not influence Layer 1 core network assessment (<a href=\"/organism\">/organism</a>).</p>")
    && /<p class="note" id="com-disclaimer">/.test(CMETH) && CMETH.includes(apiDisclaimer + " Commerce observation does not influence core network assessment."));
  check("S3-7 Layer 2's data quality and confidence are labelled Layer 2 and said not to be the reading's, on both pages",
    COMP.includes('<span class="k">Data quality (Layer 2)</span>') && COMP.includes('<span class="k">Confidence (Layer 2)</span>') && COMP.includes("Data quality and confidence here are Layer 2's, computed from the probes; they are not the reading's.")
    && /<h2>Data quality and confidence \(Layer 2\)<\/h2>/.test(CMETH) && CMETH.includes("They are computed from the probes alone and never enter the reading."));
  // Every reachability value the runner can return has a row, and the runner's thresholds are the page's.
  const reach = sec(CMETH, "reachability");
  const runnerStates = [...new Set([...PROBES.matchAll(/reachability: '([a-z_]+)'/g)].map((m) => m[1]))].sort();
  const rowStates = [...reach.matchAll(/<tr><td><code>([a-z_]+)<\/code><\/td>/g)].map((m) => m[1]).sort();
  check("S3-8 every reachability value the probe runner returns has one row on the methodology page, and no other row", runnerStates.length >= 5 && JSON.stringify(runnerStates) === JSON.stringify(rowStates), "runner " + runnerStates.join(",") + " · page " + rowStates.join(","));
  const row = (h, st) => (h.match(new RegExp("<tr><td><code>" + st + "</code></td><td>([\\s\\S]*?)</td></tr>")) || ["", ""])[1];
  const r401 = /if \(response\.status === 401 \|\| response\.status === 403\) \{\s*return \{\s*reachability: 'unavailable'/.test(PROBES);
  const r429 = /if \(response\.status === 429\) \{\s*return \{\s*reachability: 'degraded'/.test(PROBES);
  const r5xx = /if \(response\.status >= 500\) \{\s*return \{\s*reachability: 'unavailable'/.test(PROBES);
  const nonJsonPasses = /catch \{\s*\/\/ Non-JSON response — still reachable\s*\}/.test(PROBES) && /config\.validate && body !== null && !config\.validate\(body\)/.test(PROBES);
  check("S3-9 the rows say what the runner does: 429 and an unexpected status are degraded; 401/403, 5xx and a timeout are unavailable; a 404 or named 4xx can be the expected answer; a body that is not JSON is not checked; no row calls a slow answer degraded",
    r401 && r429 && r5xx && nonJsonPasses && /HTTP 429/.test(row(reach, "degraded")) && /unexpected status code/.test(row(reach, "degraded")) && !/slow/i.test(row(reach, "degraded"))
    && /HTTP 401 or 403/.test(row(reach, "unavailable")) && /server error \(5xx\)/.test(row(reach, "unavailable")) && /within the timeout/.test(row(reach, "unavailable"))
    && /a 404 or a named 4xx is the expected answer/.test(row(reach, "healthy")) && /A body that is not JSON is not checked\./.test(row(reach, "healthy")));
  const timeoutS = Number((PROBES.match(/const PROBE_TIMEOUT_MS = (\d+);/) || ["", "0"])[1]) / 1000;
  const cycleMin = Number((PROBES.match(/const CYCLE_INTERVAL_MS = (\d+) \* 60 \* 1000;/) || ["", "0"])[1]);
  const jitterS = Number((PROBES.match(/const JITTER_MS = (\d+) \* 1000;/) || ["", "0"])[1]);
  const budgetS = Number((PROBES.match(/const CYCLE_BUDGET_MS = (\d+) \* 1000;/) || ["", "0"])[1]);
  check("S3-10 the timings are the runner's: a probe allows " + timeoutS + " s; a cycle about every " + cycleMin + " min (±" + jitterS + " s), " + budgetS + " s in all, a probe not reached left out",
    timeoutS === 5 && reach.includes("A probe allows " + timeoutS + " seconds.") && sec(CMETH, "observes").includes("about every " + cycleMin + " minutes (±" + jitterS + " s)") && sec(CMETH, "observes").includes("A cycle allows " + budgetS + " seconds in total; a probe not reached in that time is left out of that cycle's results.")
    && head(COMP).includes("Probed every <b>" + cycleMin + " min</b>") && head(CMETH).includes("every <b>" + cycleMin + " min</b>"));
  const lat = (PROBES.match(/function classifyLatency\(ms\) \{([\s\S]*?)\n\}/) || ["", ""])[1];
  const latMs = [...lat.matchAll(/if \(ms < (\d+)\) return '(\w+)';/g)].map((m) => [Number(m[1]), m[2]]);
  const sFmt = (ms) => (ms / 1000).toString() + " s";
  check("S3-11 the latency classes are the runner's, and the page says /commerce/observations does not publish them (it does not)",
    latMs.length === 3 && latMs.every(([ms, cls]) => reach.includes("<code>" + cls + "</code> under " + sFmt(ms))) && !/latency/.test(pubBuilder) && reach.includes("The latency class does not change the state, and /commerce/observations does not publish it."), JSON.stringify(latMs));
  check("S3-12 unsupported authorities: the runner marks them not configured, the public builder leaves them out, and the page says they are not probed, not counted, not listed",
    /reachability: 'unsupported',[\s\S]{0,160}configured: false/.test(PROBES) && /\.filter\(function\(a\) \{ return a\.configured; \}\)/.test(pubBuilder) && /not probed, not counted, and not listed in <a href="\/commerce\/observations">\/commerce\/observations<\/a>/.test(row(reach, "unsupported")));
  // The overall rule and Layer 2's data quality and confidence, from deriveOverall.
  const derive = (PROBES.match(/function deriveOverall\(authorityResults\) \{([\s\S]*?)\n\}/) || ["", ""])[1];
  const pct = (re) => Math.round(Number((derive.match(re) || ["", "NaN"])[1]) * 100);
  const hPct = pct(/if \(healthy \/ total >= ([\d.]+)\)/), dPct = pct(/\} else if \(okPct >= ([\d.]+)\) \{\s*state = 'degraded'/), pPct = pct(/\} else if \(okPct >= ([\d.]+)\) \{\s*state = 'partial'/);
  const qS = pct(/if \(okPct >= ([\d.]+)\) data_quality = 'sufficient'/), qP = pct(/else if \(okPct >= ([\d.]+)\) data_quality = 'partial'/);
  const overall = sec(CMETH, "overall"), quality = sec(CMETH, "quality");
  check("S3-13 the overall rule is the runner's (" + [hPct, dPct, pPct].join("/") + "%): healthy counts healthy probes only, the rest count 'answered' = healthy or degraded; unknown when none is active",
    hPct === 90 && dPct === 70 && pPct === 40 && /const okCount = healthy \+ degraded;/.test(derive) && /if \(total === 0\) return \{ state: 'unknown'/.test(derive)
    && overall.includes("\"Answered\" means <code>healthy</code> or <code>degraded</code>.") && row(overall, "healthy").includes(hPct + "% or more of the active probes are <code>healthy</code>")
    && row(overall, "degraded").includes(dPct + "% or more answered") && row(overall, "partial").includes(pPct + "% or more answered") && row(overall, "unavailable").includes("Under " + pPct + "% answered") && /No active probe is configured/.test(row(overall, "unknown")));
  check("S3-14 Layer 2's data quality and confidence rules are the runner's (" + qS + "/" + qP + "%; uncertain = some healthy and some unavailable in one cycle)",
    qS === 70 && qP === 40 && /const confidence = \(unavailable > 0 && healthy > 0\) \? 'uncertain' : 'clear';/.test(derive)
    && quality.includes("<code>sufficient</code> when " + qS + "% or more of the active probes answered; <code>partial</code> from " + qP + "%") && quality.includes("some probes are <code>healthy</code> and some <code>unavailable</code>"));
  // Freshness (F1, decided `last_healthy`): the runner measures the window from the endpoint's last healthy answer. The pages
  // say that, and that it is not the age of the authority's data; the runtime behaviour is src/commerce-freshness.test.mjs.
  // If the runner measures from anything else, this check fails until the words change with it.
  const fromHealthy = /evaluateFreshness\(authorityId, last_healthy_at\)/.test(PROBES) && !/evaluateFreshness\(authorityId, now\)/.test(PROBES);
  const freshStates = [...new Set([...PROBES.matchAll(/return '(fresh|stale|unknown|not_applicable)'|\? 'fresh' : 'stale'|: 'unknown';/g)].map((m) => m[0]))];
  const fresh = sec(CMETH, "freshness");
  check("S3-15 freshness: a row for each value the runner returns; measured from the endpoint's last healthy answer, and both pages say so and that it is not the age of the authority's data; the old 'known limitation' is gone",
    ["fresh", "stale", "unknown", "not_applicable"].every((st) => row(fresh, st).length > 0) && freshStates.length >= 3 && fromHealthy
    && row(fresh, "fresh") === "The endpoint's last <code>healthy</code> answer is within the authority's update window."
    && row(fresh, "stale") === "The endpoint has not answered <code>healthy</code> within the authority's update window."
    && row(fresh, "unknown") === "The authority was not probed, or has not answered <code>healthy</code> since the probe runner last started."
    && fresh.includes('<p id="freshness-scope">Freshness is about the Oracle\'s own answers from the endpoint, not the age of the authority\'s data')
    && COMP.includes('<p class="orient-more" id="freshness-note">Freshness says whether the endpoint has answered <code>healthy</code> within the authority\'s update window; it is not the age of the authority\'s data. The State column says what the last probe found. <a href="/commerce/methodology#freshness">How freshness is read</a>.</p>')
    && !/freshness-limit|Known limitation/.test(COMP + CMETH));
  // Where an authority's data is read through another service, the page says so.
  check("S3-16 the endpoints the runner probes through another service are named (the ECB's rates via Frankfurter, the DNS check via Cloudflare's resolver), and the one testnet endpoint (Base Sepolia) is not called production",
    (!/api\.frankfurter\.dev/.test(PROBES) || sec(CMETH, "observes").includes("the ECB's reference rates are read through Frankfurter")) && (!/cloudflare-dns\.com/.test(PROBES) || sec(CMETH, "observes").includes("Cloudflare's public DNS resolver"))
    && sec(CMETH, "observes").includes("the state says whether that service answered, not the authority") && !/does not require special access/.test(CMETH)
    && (!/env_required: 'BASE_SEPOLIA_RPC'/.test(PROBES) || (sec(CMETH, "testnet").includes("reads a contract on Base Sepolia, a public testnet") && !/probed by the Oracle are production public APIs/.test(CMETH.replace("Most authority endpoints probed", "")))));
  const words = textOf(COMP.replace(/<script>[\s\S]*?<\/script>/, "") + CMETH).split(/(?<=[.!?])\s+/).filter(publicLanguageHit);
  check("S3-17 no banned public language on either page outside the disclaimer the shared list allows", words.length === 0, words.join(" | "));
}

// ---- S4: the server-built pages (/docs, /timeline, /reference) take the shared title band; markup only ------------------
{
  const docsSrc = (AGENTSRC.match(/var DOCS_HTML = ([\s\S]*?)\n'<\/article><\/div><\/main><!--dno:footer--><\/body><\/html>';/) || ["", ""])[1];
  const docsHead = docsSrc.slice(docsSrc.indexOf('<header class="doc-head">'), docsSrc.indexOf("</header>"));
  check("S4-1 /docs: kicker 'Read-only API', one h1, one lede; version, API version, wallet and the contract link in a facts box beside the title; the publication sentence kept, the wallet line not repeated",
    docsHead.includes('<p class="doc-kicker">Read-only API</p><h1>API</h1>') && count(docsHead, "<h1>") === 1 && count(docsHead, 'class="doc-lede"') === 1
    && docsHead.includes(`<div class="doc-facts"><span>Agent <b>v' + AGENT_VERSION + '</b> · API <b>' + API_VERSION + '</b></span><span>Oracle wallet <code>__AGENT_WALLET__</code></span><span>Contract <a href="/organism/schema">/organism/schema</a></span></div>`)
    && docsHead.includes("'<div class=\"doc-intro\"><p>' + (SUPERCOLONY_ENABLED ? 'On-chain publication of DNO\\'s own posts is enabled' : 'On-chain publication of DNO\\'s own posts is currently disabled') + '; the public reading is never posted. Observation continues independently, and that says nothing by itself about the Demos network.</p></div>'")
    && count(docsSrc, "__AGENT_WALLET__") === 1 && !/Oracle wallet: /.test(docsSrc));
  const tlSrc = (AGENTSRC.match(/function renderTimelinePage\(\) \{([\s\S]*?)\n\}\n/) || ["", ""])[1];
  check("S4-2 /timeline: kicker 'Records and releases' (it carries incidents, condition records and releases), one h1; no inline style",
    tlSrc.includes('<header class="doc-head"><div class="wrap"><div><p class="doc-kicker">Records and releases</p><h1>Observation timeline</h1>') && !/ style="/.test(tlSrc) && /<div class="wrap tl-wrap">/.test(tlSrc) && /\.tl-wrap\{padding-block:40px 72px\}/.test(tlSrc));
  check("S4-3 /timeline: a condition record's dot carries no severity colour — its tag says 'condition record', not the severity, so no colour may say it either; an incident's dot keeps the colour its tag names",
    tlSrc.includes(`items += '<div class="tl-item' + (isCond ? '' : ' sev-' + sev) + '"><div class="tl-date">' + day + '</div><div class="tl-body"><span class="tl-tag">' + (isCond ? "condition record" : sev) + '</span>`) && !/class="tl-item sev-' \+ sev/.test(tlSrc));
  const refSrc = (AGENTSRC.match(/\} else if \(reqPath === "\/reference"\) \{([\s\S]*?)\n    \} else if \(reqPath === "\/agent"\) \{/) || ["", ""])[1];
  check("S4-4 /reference: kicker 'Explore' on the page and on its 503 shell; no inline style; the lede counts no tables, because the fixnet table is drawn only when a fixnet probe ran",
    count(refSrc, '<header class="doc-head"><div class="wrap"><div><p class="doc-kicker">Explore</p><h1>Reference</h1>') === 2 && !/ style="/.test(refSrc) && /\.ref-tbl \.tag\{margin:0\}/.test(refSrc)
    && /if \(fx\.length > 0\) \{/.test(refSrc) && !/Two tables|Neither enters/.test(refSrc) && refSrc.includes('<p class="doc-lede">The tables here enter no status, risk or agreement. None is a validator list, a stake list or an official-node list.</p>'));
  const s4Words = textOf(docsHead + tlSrc.slice(tlSrc.indexOf("<header"), tlSrc.indexOf("</header>")) + refSrc.slice(refSrc.indexOf('<p class="doc-lede">The tables'), refSrc.indexOf("</header>", refSrc.indexOf('<p class="doc-lede">The tables')))).split(/(?<=[.!?])\s+/).filter(publicLanguageHit);
  check("S4-5 no banned public language in the three title bands", s4Words.length === 0, s4Words.join(" | "));
}

// ---- CF: the chrome follow-up (A28, A29; trigger S1 merged): the LIVE pill's name in words, its no-JS time on every
// page, and a status change said once. The homepage's runtime behaviour is checked in tools/homepage-preview (CF1–CF5).
{
  const SITEJS = readFileSync(join(ROOT, "assets", "site.js"), "utf8");
  const PEND_LABEL = 'aria-label="connecting: reading the age of the last completed public observation"';
  const homePill = (HOME.match(/<a class="live" id="live"[^>]*>/) || [""])[0];
  const kitPill = (AGENTSRC.match(/'<a class="live" id="live"[^\n]*/) || [""])[0];
  check("CF-1 the pill ships with a name in words, the same on the homepage and every subpage, and with no aria-live (its age ticks)",
    homePill.includes(PEND_LABEL) && AGENTSRC.includes("const LIVE_PENDING_LABEL = '" + PEND_LABEL + "';") && kitPill.includes("' + LIVE_PENDING_LABEL + '") && !/aria-live/.test(homePill + kitPill));
  const setLiveCalls = [...SITEJS.matchAll(/setLive\(([^;]*)\);/g)].map((m) => m[1]).filter((a) => !/^state, text, label$/.test(a));
  const words = ["LIVE: the last completed public observation is ", "STALE: the last completed public observation is ", "OFFLINE: this page could not read the age of the last completed public observation"];
  const homeLive = (HOME.match(/function renderLive\(\) \{([\s\S]*?)\n  \}/) || ["", ""])[1];
  check("CF-2 site.js names the pill on every update, and in the homepage's words (live, stale, offline)",
    setLiveCalls.length === 4 && setLiveCalls.every((a) => /, liveLabel\('(live|stale|down|pending)'(, s)?\)$/.test(a)) && /if \(live\.getAttribute\('aria-label'\) !== label\) live\.setAttribute\('aria-label', label\);/.test(SITEJS)
    && words.every((w) => SITEJS.includes(w) && homeLive.includes(w)) && /live\.setAttribute\('aria-label', label\)/.test(homeLive), setLiveCalls.join(" | "));
  const fill = (AGENTSRC.match(/function fillLiveNoJs\(html, observedAt\) \{([\s\S]*?)\n\}/) || ["", ""])[1];
  check("CF-3 without JavaScript the pill gives the time of the last completed public observation, text and name alike, by one function the homepage and every subpage use",
    /'<span id="live-text">as of ' \+ at \+ '<\/span>'/.test(fill) && /'aria-label="as of ' \+ at \+ ': the time of the last completed public observation"'/.test(fill) && /html = fillLiveNoJs\(html, c\.observed_at\);/.test(AGENTSRC)
    && /function subpageNoJs\(html\) \{\s*try \{ return fillLiveNoJs\(html, computeCanonicalState\(\)\.observed_at\); \} catch \(e\) \{ return html; \}\s*\}/.test(AGENTSRC));
  const SUBS = ["/docs", "/sources", "/agent", "/timeline", "/about-demos", "/methodology", "/criteria", "/commerce", "/commerce/methodology"];
  const notFilled = SUBS.filter((pth) => { const blk = (AGENTSRC.match(new RegExp('reqPath === "' + pth.replace(/\//g, "\\/") + '"\\) \\{\\n([^\\n]*\\n){1,2}')) || [""])[0]; return !/res\.end\(subpageNoJs\(/.test(blk); });
  const refBlk = (AGENTSRC.match(/\} else if \(reqPath === "\/reference"\) \{([\s\S]*?)\n    \} else if \(reqPath === "\/agent"\) \{/) || ["", ""])[1];
  check("CF-4 every subpage route sends its page through subpageNoJs (the nine above, and /reference's page and its 503 shell)", notFilled.length === 0 && count(refBlk, "res.end(subpageNoJs(") === 2, notFilled.join(", "));
  const announce = (HOME.match(/function announceStatus\(st\) \{([\s\S]*?)\n  \}/) || ["", ""])[1];
  const cycleLive = (HOME.match(/panel\.dataset\.state = 'live';([\s\S]*?)const r = seedsReading/) || ["", ""])[1];
  const cycleFail = (HOME.match(/if \(!o\) \{([\s\S]*?)\n    \}\n    panel\.dataset\.state = 'live';/) || ["", ""])[1];
  check("CF-5 the homepage says a status change once, politely, in a hidden status region: only when a reading's status differs from the last reading's, never from a failed read",
    count(HOME, '<p class="sr" id="status-change" role="status" aria-live="polite"></p>') === 1 && /if \(st && lastStatus && st !== lastStatus\) setText\(\$\('status-change'\), `Status is now \$\{st\}; it was \$\{lastStatus\}\.`\);/.test(announce)
    && /if \(st\) lastStatus = st;/.test(announce) && /announceStatus\(st\);/.test(cycleLive) && !/announceStatus/.test(cycleFail) && count(HOME, "announceStatus(") === 2);
}

// ---- The 2026-10-25 releases are in the methodology changelog; Criteria and the Agent Guide take the shared title band ------
{
  const cl = (METHP.match(/<section id="methodology-changelog">[\s\S]*?<\/section>/) || [""])[0];
  check("CL1 the changelog dates today's releases above v1.2: block identity (enters no status field, linked to its section and the recipe) and the six-field correction (no rule changed)",
    /<p><b>Block identity — 2026-10-25\.<\/b>[^\n]*enters no status field[^\n]*href="#block-identity"[^\n]*href="\/agent#repeat-the-method"/.test(cl) && /<p><b>Corrections — 2026-10-25\.<\/b>[^\n]*six fields[^\n]*No rule changed\.<\/p>/.test(cl) && cl.indexOf("Block identity — 2026-10-25") < cl.indexOf("v1.2 — 2026-10-05"));
  const CRIT = readFileSync(join(ROOT, "criteria.html"), "utf8");
  const critHead = CRIT.slice(CRIT.indexOf('<header class="doc-head">'), CRIT.indexOf('<div class="wrap doc-grid">'));
  const critArt = CRIT.slice(CRIT.indexOf('<article class="prose">'), CRIT.indexOf("</article>"));
  check("TB1 Criteria: kicker 'Definitions only', one h1, one lede carrying 'definitions only: descriptive not prescriptive', a facts box beside the title (version, date, /criteria.json) as About Demos has; the title band holds no note",
    /<p class="doc-kicker">Definitions only<\/p>/.test(critHead) && count(CRIT, "<h1") === 1 && count(critHead, 'class="doc-lede"') === 1 && /definitions only: descriptive not prescriptive/.test(critHead) && /<div class="doc-facts">\s*<span>Criteria Framework <b>v1\.0<\/b><\/span>\s*<span>Effective <b>2026-07-06<\/b><\/span>\s*<span>Machine-readable <a href="\/criteria\.json">\/criteria\.json<\/a><\/span>\s*<\/div>/.test(critHead) && !/class="note"/.test(critHead));
  check("TB2 Criteria: the two notes open the article, unchanged in text, first in it", /^<article class="prose">\s*<div class="note">\s*<b>Definitions only — applied to no named participant here\.<\/b>/.test(critArt) && count(critArt, '<div class="note">') >= 2 && critArt.indexOf("gated and not live") > 0 && critArt.indexOf("gated and not live") < critArt.indexOf("<section"));
  const AGH = GUIDE.slice(GUIDE.indexOf('<header class="doc-head">'), GUIDE.indexOf('<div class="wrap doc-grid">'));
  check("TB3 Agent Guide: kicker 'Developers', one h1, one lede (the two merged), no doc-intro", /<p class="doc-kicker">Developers<\/p>/.test(AGH) && count(GUIDE, "<h1") === 1 && count(AGH, 'class="doc-lede"') === 1 && !/doc-intro/.test(AGH) && /how to repeat the method/.test(AGH));
}
const heroH1 = (HOME.match(/<h1 id="hero-title">([\s\S]*?)<\/h1>/) || ["", ""])[1];
check("H36 the hero heading is type: 'Observe.' and 'Explain.', no mark, no image inside", heroH1.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() === "Observe. Explain." && !/<(img|svg|use)\b/.test(heroH1), heroH1);
check("H37 the reading names its network inside the panel head", /<h2 id="cycle-title"[^>]*>[\s\S]*?Demos public testnet[\s\S]*?<\/h2>/.test(HOME));
const seedUrls = [...SRC.slice(SRC.indexOf("const PUBLIC_NODES = {"), SRC.indexOf("};", SRC.indexOf("const PUBLIC_NODES = {"))).matchAll(/url: "(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]));
const seedOps = new Set([...SRC.slice(SRC.indexOf("const PUBLIC_NODES = {"), SRC.indexOf("};", SRC.indexOf("const PUBLIC_NODES = {"))).matchAll(/operator: "([^"]+)"/g)].map((m) => m[1]));
const WORD = ["no", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const seedHead = (HOME.match(/<p class="ek">Configured public seeds<\/p>\s*<h3 class="twin-h">([^<]+)<\/h3>/) || [])[1];
check("H38 the seeds panel counts what the agent dials: its URLs, their hostnames and one operator, from PUBLIC_NODES", seedUrls.length > 0 && seedOps.size === 1 && seedHead === WORD[seedUrls.length] + " URLs. " + WORD[new Set(seedUrls.map((u) => u.hostname)).size] + " hostnames. One organization." && HOME.includes("The " + WORD[seedUrls.length].toLowerCase() + " seeds are public URLs of one organization."), seedHead + " | " + seedUrls.length + " URLs");
const persp = [...HOME.matchAll(/<a class="persp-c" href="([^"]+)">([\s\S]*?)<\/a>/g)];
check("H39 the three perspective cards each link a page of the site and say so in an action line", persp.length === 3 && persp.every((m) => listOf("SITE_PAGES").some((pg) => pg.path === m[1]) && /<span class="persp-go">[^<]+ →<\/span>$/.test(m[2])), persp.map((m) => m[1]).join(" "));
// Owner ruling of 2026-09-29: last_count counts relays that returned a transaction hash; the reading is never posted.
check("H24 the DAHR sentence is conditional and exact", HOME.includes("This cycle, DAHR was attempted on the cross-check RPCs, not on the seeds whose answers enter status. last_count is how many of those relays returned a transaction hash.") && HOME.includes("' DNO\\'s own on-chain posts are disabled; the reading is never posted.'") && HOME.includes("' The reading is never posted.'") && HOME.includes("'DAHR attestation unavailable.'") && !HOME.includes("returned an attestation object"));
// The API version the agent serves is the newest one the schema's changelog describes, and the schema's own version.
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "organism.schema.json"), "utf8"));
const apiVersion = (SRC.match(/var API_VERSION = "([0-9.]+)";/) || [])[1];
const changelog = Array.isArray(SCHEMA["x-changelog"]) ? SCHEMA["x-changelog"].map((e) => String(e.version)) : [];
check("H27x the agent's API version is 1.2, the newest entry of the schema's changelog", apiVersion === "1.2" && changelog.length > 0 && changelog.every((v) => v <= apiVersion) && changelog.includes(apiVersion), apiVersion + " | " + changelog.join(","));
// Every endpoint /docs lists has a route (up to 7.1.1 it listed GET /signals, which answered 404).
const docsPaths = [...SRC.matchAll(/docsEntry\('GET (\/[^' ?]*)/g)].map((m) => m[1]);
const noRoute = docsPaths.filter((p) => !SRC.includes('reqPath === "' + p + '"') && !SRC.includes('reqPath.startsWith("' + p + '")'));
check("H28 every endpoint /docs lists has a route in the agent", docsPaths.length >= 15 && noRoute.length === 0, docsPaths.length + " listed; no route: " + noRoute.join(", "));
// And the other way: every route the public handler serves is on /docs. Not listed, by their nature: /docs itself, /home
// (a redirect to /), and the routes the public listener answers 404 or 401 for (the internal views and the private one).
const NOT_PUBLIC = ["/docs", "/home", "/history", "/history/export", "/dashboard", "/private/commerce/status"];
const served = [...new Set([...SRC.matchAll(/reqPath === "(\/[^"]*)"/g)].map((m) => m[1].replace(/(.)\/$/, "$1")))];
const unlisted = served.filter((p) => !NOT_PUBLIC.includes(p) && !docsPaths.includes(p));
check("H28b every route the public site serves is listed on /docs, which says 'every route'", served.length >= 28 && unlisted.length === 0 && NOT_PUBLIC.every((p) => served.includes(p)) && /Every route the public site serves/.test(SRC), served.length + " routes; not listed: " + unlisted.join(", "));
check("H28c /docs says which of them are not JSON", /docsEntry\('GET \/federate', 'Prometheus text, not JSON/.test(SRC) && /docsEntry\('GET \/badge', 'An SVG image, not JSON/.test(SRC) && /JSON unless noted, and the pages are HTML/.test(SRC));
check("H29 the height signal on /health says what was read, not 'the public network'", SRC.includes('message: "Highest own height among the seeds that answered: " + pubBlock + " (" + pubOnline.length + " answered)"') && !/Public network at block/.test(SRC) && !/nodes online\)"/.test(SRC));
check("H30 a record without a block publishes none: null, not block 0", SRC.includes("detectedBlock: r.detected_block || null, resolvedBlock: r.resolved_block || null,"));
// The disclosure: DNO reads its operator's nodes as fleet data, so "DNO reads it like any other" said too much. What is
// true is said the same way wherever it is said: in the public reading that validator counts like any other.
{
  const core = "counts like any other validator, and only if it publishes an address on chain";
  const places = { "the site footer (src/agent.mjs)": SRC, "homepage.html": HOME };
  for (const f of ["about-demos.html", "criteria.html", "methodology.html", "README.md"]) places[f] = readFileSync(join(ROOT, f), "utf8");
  const without = Object.keys(places).filter((k) => places[k].split(core).length !== 2);
  const old = Object.keys(places).filter((k) => /reads? (it|that validator) like any other|read like any other|which DNO reads like any other/.test(places[k]));
  check("H31 the disclosure says the same in six places: in the public reading the operator's validator counts like any other, and none says DNO reads it like any other", without.length === 0 && old.length === 0, "without: " + without.join(", ") + " | old wording: " + old.join(", "));
}
// The seed table shows what DNO read: no percentage of a seed's height against the highest seed's, and the count beside
// it is named for what it counts.
check("H34 the agent's own version label is this release's (it read 6.9 through three releases): /version, /docs and /federate say 7.2", /^const AGENT_VERSION = "7\.2";/m.test(SRC));
check("H32 the homepage has no 'Sync' column and no 'at head' label; the count is 'within 100 blocks of the highest seed'", !/>Sync<\/th>/.test(HOME) && !/sync_pct/.test(HOME) && !/>at head</.test(HOME) && HOME.includes('<p class="k">within 100 blocks of the highest seed</p>'));
check("H33 the homepage shows no median when nothing was compared (one seed's height is not a median), and no dash for a latency that was not observed", HOME.includes("setOdometer(compared && isNum(a.median_block) ? a.median_block : null, compared ? undefined : 'not computed');") && !HOME.includes("no latency this cycle"));
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
  const VW_KEYS = "answered_as_listed,answered_as_listed_seeds,answered_no_key,answered_other_key,at_seed_height,distinct_ips_targeted,every_round_last_hour,height_band_blocks,height_not_compared,height_not_reported,interval_seconds,max_rows_per_origin,no_answer,not_dialed,not_dialed_reasons,off_seed_height,origins_dialed,other_key_shared,other_key_shared_origins,reason,reference_height,reference_observed_at,round_at,state,versions,versions_other,watched,window";
  check("V1 /health on_chain_validators: exactly the published keys", ocv && Object.keys(ocv).sort().join(",") === OC_KEYS, ocv && Object.keys(ocv).sort().join(","));
  check("V2 /health validator_watch: exactly the published keys", vwt && Object.keys(vwt).sort().join(",") === VW_KEYS, vwt && Object.keys(vwt).sort().join(","));
  check("V3 states from the documented sets", ocv && ["pending", "agreed", "not_agreed", "stale"].includes(ocv.state) && vwt && ["pending", "observed", "no_agreed_list", "read_fault", "stale", "disabled"].includes(vwt.state), ocv && vwt && ocv.state + " / " + vwt.state);
  const ocCounts = ["listed", "active", "unstaking", "other_status", "first_agreed_today", "first_agreed_week", "first_agreed_month", "first_agreed_as_of"];
  const vwCounts = ["watched", "not_dialed", "no_answer", "answered_other_key", "answered_no_key", "answered_as_listed", "every_round_last_hour",
    "origins_dialed", "max_rows_per_origin", "distinct_ips_targeted", "other_key_shared", "other_key_shared_origins", "answered_as_listed_seeds"];
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
    && (vwt.other_key_shared === 0) === (vwt.other_key_shared_origins === 0) && vwt.origins_dialed <= vwt.watched - vwt.not_dialed && Number.isInteger(vwt.distinct_ips_targeted) && vwt.distinct_ips_targeted <= vwt.origins_dialed && (vwt.origins_dialed === 0) === (vwt.distinct_ips_targeted === 0));
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
  // NAV-REACH served: the footer of every page links every page; nothing is sent to a font host.
  const unreachable = [];
  for (const pth of ["/"].concat(pages)) {
    const t = await get(pth).then((r) => (typeof r.body === "string" ? r.body : ""));
    const fs0 = t.indexOf('<footer class="site-foot">'), foot = fs0 < 0 ? "" : t.slice(fs0, t.indexOf("</footer>", fs0));
    const missing = PAGES.filter((q) => !foot.includes('href="' + q + '"'));
    if (missing.length || /fonts\.(googleapis|gstatic)\.com/.test(t)) unreachable.push(pth + " → " + (missing.join(" ") || "font host"));
  }
  { const t = await get("/").then((r) => (typeof r.body === "string" ? r.body : ""));
    check("S41 / for readers without JavaScript: the summary, its clock and the reading's agreement are filled once an observation exists", !o.observed_at
      || (t.includes('<p class="summary" id="summary" data-src="api">') && !t.includes('<p class="summary" id="summary" data-src="api">reading</p>') && !t.includes('<span id="obs-at">not read yet</span>') && !/<div data-card="reading_agreement"><p class="k">agreement<\/p><p class="v"><span class="ind" data-tone="pending">/.test(t))); }
  check("S39 every page's footer links every page, and no page loads a font host", unreachable.length === 0, unreachable.join("; "));
  // S4 served: every subpage carries one kicker and one h1 as rendered; on /timeline no condition record is drawn in a severity colour.
  const noKicker = [];
  for (const pth of pages) {
    const t = await get(pth).then((r) => (typeof r.body === "string" ? r.body : ""));
    if (count(t, 'class="doc-kicker"') !== 1 || count(t, "<h1") !== 1) noKicker.push(pth + " kickers " + count(t, 'class="doc-kicker"') + " h1 " + count(t, "<h1"));
  }
  check("S4-6 every subpage, as served: exactly one kicker and one h1", noKicker.length === 0, noKicker.join(", "));
  { const cat = await get("/catalog"); const notes = cat.body && Array.isArray(cat.body.notes) ? cat.body.notes : [];
    check("D3-s /catalog's notes, as served, say 'Not a census of the public Demos testnet.' and never 'Demos beta'", notes.some((n) => /Not a census of the public Demos testnet\./.test(n)) && !notes.some((n) => /Demos beta/.test(n)), JSON.stringify(notes).slice(0, 200)); }
  // CF served: once an observation exists, no page's pill says "connecting"; each gives a time, in its text and its name.
  if (o.observed_at) {
    const pillOff = [];
    for (const pth of ["/"].concat(pages)) {
      const t = await get(pth).then((r) => (typeof r.body === "string" ? r.body : ""));
      const m = t.match(/<a class="live" id="live"[^>]*aria-label="as of (\d\d:\d\d:\d\d) UTC: the time of the last completed public observation"[^>]*>(?:<span class="dot"[^>]*><\/span>)<span id="live-text">as of (\d\d:\d\d:\d\d) UTC<\/span><\/a>/);
      if (!m || m[1] !== m[2] || t.includes('<span id="live-text">connecting</span>')) pillOff.push(pth);
    }
    check("CF-6 every page as served, once an observation exists: the pill says 'as of HH:MM:SS UTC' in its text and its name, never 'connecting'", pillOff.length === 0, pillOff.join(", "));
  }
  { const t = await get("/timeline").then((r) => (typeof r.body === "string" ? r.body : ""));
    const condItems = [...t.matchAll(/<div class="tl-item([^"]*)"><div class="tl-date">[^<]*<\/div><div class="tl-body"><span class="tl-tag">condition record</g)].map((m) => m[1]);
    check("S4-7 /timeline as served: no condition record carries a severity class (" + condItems.length + " condition records on the page)", condItems.every((c) => !/sev-/.test(c)) && !/ style="/.test(t.slice(t.indexOf("<main"), t.indexOf("</main>")))); }
  const kitFiles = [[fontSans, "font/woff2"], [fontMono, "font/woff2"]];
  let filesOk = true;
  for (const [pth, type] of kitFiles) { const r = await fetch(BASE + pth); filesOk = filesOk && r.status === 200 && r.headers.get("content-type") === type && /immutable/.test(r.headers.get("cache-control") || ""); await r.arrayBuffer(); }
  check("S40 the self-hosted fonts are served by content hash, immutable, with their type", filesOk, kitFiles.map((k) => k[0]).join(", "));
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
  // The whole reading panel: the band (status, four tiles) first, then the reading's lines and the six cards.
  const cardHtml = html.slice(html.indexOf('id="panel"'), html.indexOf('<p class="bound">', html.indexOf('id="panel"')));
  // The card's second line says what status is made of in this observation (1.2): the seeds; one seed and the validators
  // standing in; validators alone; or, when validators were read and gave no reading, that status is unknown. The page
  // and /organism may be a round apart, so any of the endings the two rounds' modes allow is accepted.
  const hw = (await get("/health")).body.witnesses || {};
  check("S25b the band and the reading's line for readers without JavaScript: four tiles filled (none left reading), a count only with its own clock, then what status is made of; no 'nodes aligned'",
    !o.observed_at || panelNoJsOk(cardHtml, health, [wt, hw]), cardHtml.slice(0, 600));
  const mk = await fetch(BASE + "/assets/dno-mark-" + markSha.slice(0, 8) + ".jpg");
  const mkBytes = Buffer.from(await mk.arrayBuffer());
  check("S26 the mark asset is served byte-for-byte, cached", mk.status === 200 && mk.headers.get("content-type") === "image/jpeg" && /immutable/.test(mk.headers.get("cache-control") || "") && createHash("sha256").update(mkBytes).digest("hex") === markSha);
} catch (e) {
  check("S0 served layer reachable at " + BASE, false, e.message);
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
