// validator-watch.mjs — the on-chain validators read and the validator watch.
//
// The read (Path A seeds, not in status): each round, getValidators and getNetworkParameters are sent to the configured
// public seeds with the Demos SDK's nodeCall wire format (POST to the seed's root, unauthenticated, read-only). A figure
// is published only when at least two seeds return the same list (the same address–status pairs) and no other group of
// seeds is as large; minValidatorStake by the same rule. Rows are reduced on arrival to address, status and published
// connection URL: stake and timestamps are never kept.
//
// The watch (Path B, not in status): every ACTIVE row of the agreed list is dialed once per round at the connection URL
// the agreeing seeds list for it — GET /info, only when that URL is a bare public http origin, pinned to the address that
// was checked, redirects refused, at most 2 MB read. One outcome per row: not dialed, no answer, answered with another
// key, answered without a key, or answered as the listed key; for the last, its own height against the seeds' median
// (±25 blocks, the agreement band). "Every round, last hour" is kept in memory over counted rounds.
//
// Published objects carry counts only: never an address, connection URL, host, per-row height, per-row outcome or stake.
// Version groups are published only in a strict version shape and only when at least two validators share one.
//
// The first-agreed clock (DNO's clock): the host's UTC time at which an ACTIVE key first appeared on an agreed list,
// kept in SQLite. It gives how many keys were first agreed in the last 24 h, 7 d and 30 d, and never the store's first
// list, which says nothing about when those keys joined.
// Runtime tests: bun src/validator-watch.test.mjs

import { isIP } from "node:net";
import { sanitizeHeight, probeErrorCategory, mapWithConcurrency, readJsonCapped, parseProbeOrigin, CAPPED_FETCH_OPTIONS } from "./public-safety.mjs";

export const STATUS_ACTIVE = "2";
export const STATUS_UNSTAKING = "3";
export const WATCH_DEFAULTS = Object.freeze({
  timeoutMs: 5000,              // each nodeCall and each /info dial
  maxBytes: 2 * 1024 * 1024,    // each body read
  concurrency: 8,               // name lookups, and /info dials, in flight
  maxOrigins: 200,              // distinct published addresses dialed per round
  lookupTimeoutMs: 10000,       // one name lookup holds its slot until it settles, or this long at most
  lookupBudgetMs: 20000,        // no new name lookup starts after this long in a round
  bandBlocks: 25,               // "at the seeds' height": within ±25 blocks of the seeds' median (the agreement band)
  intervalMs: 60000,            // one round a minute
  windowMs: 3600000,            // "every round, last hour"
  staleMs: 300000,              // a read or a round older than this is not shown as current
  versionGroups: 6,             // version groups published; the rest are counted in versions_other
  versionMinCount: 2,           // a version is named only when at least this many validators answered with it
});
// A version as releases name them (0.9.9, v1.2, 0.9.9 RC, 1.0.0-beta.2). Anything else is "no version": a validator's
// free text never reaches a public surface.
const VERSION_RE = /^v?\d{1,2}\.\d{1,3}(\.\d{1,3})?([ -]?(rc|beta|alpha)[ .]?\d{0,2})?$/i;
export function versionOf(value) { return typeof value === "string" && VERSION_RE.test(value.trim()) ? value.trim() : null; }

// ---- wire -------------------------------------------------------------------------------------------------------
export function nodeCallBody(message, data) {
  return JSON.stringify({ method: "nodeCall", params: [{ type: "nodeCall", message: message, sender: null, receiver: null, timestamp: null, data: data || {}, extra: "" }] });
}
// CAPPED_FETCH_OPTIONS (identity encoding, no automatic decompression) with redirects refused: a 3xx is no answer.
function fetchInit(extra, timeoutMs) {
  return Object.assign({}, CAPPED_FETCH_OPTIONS, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }, extra, {
    headers: Object.assign({}, CAPPED_FETCH_OPTIONS.headers, (extra && extra.headers) || {})
  });
}
async function discard(resp) { try { if (resp.body) await resp.body.cancel(); } catch (e) {} }
function withTimeout(promise, ms) {
  var timer;
  return Promise.race([promise, new Promise(function(resolve) { timer = setTimeout(function() { resolve(null); }, ms); })]).finally(function() { clearTimeout(timer); });
}

// One nodeCall to a pinned origin. { ok: true, response } or { ok: false, error } (a category, never runtime text).
async function nodeCall(origin, message, data, o) {
  try {
    var resp = await o.fetch(origin + "/", fetchInit({ method: "POST", body: nodeCallBody(message, data), headers: { "Content-Type": "application/json" } }, o.timeoutMs));
    if (resp.status !== 200) { await discard(resp); return { ok: false, error: probeErrorCategory(null, resp.status) }; }
    var body = await readJsonCapped(resp, o.maxBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid response" };
    if (body.result !== 200) return { ok: false, error: "result " + (Number.isInteger(body.result) ? body.result : "missing") };
    return { ok: true, response: body.response };
  } catch (e) { return { ok: false, error: probeErrorCategory(e) }; }
}

// ---- rows ---------------------------------------------------------------------------------------------------------
// The comparison form of a key: trimmed, lower case, without a leading 0x. Used only to compare, never published.
export function keyOf(value) {
  if (typeof value !== "string") return null;
  var s = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-z]{1,128}$/.test(s) ? s : null;
}
const STATUS_RE = /^[0-9A-Za-z_]{1,8}$/;
// getValidators rows reduced to what the watch needs. null when the answer is not a list of rows with an address and a
// status (an unexpected shape): that seed then counts as not having returned a list.
export function reduceValidatorRows(list) {
  if (!Array.isArray(list)) return null;
  var out = [], seen = new Set();
  for (var i = 0; i < list.length; i++) {
    var v = list[i];
    if (!v || typeof v !== "object" || typeof v.status !== "string") return null;
    var key = keyOf(v.address), status = v.status.trim();
    if (key === null || !STATUS_RE.test(status) || seen.has(key)) return null;
    seen.add(key);
    // noUrl: the row publishes no address at all. url: the address as published, when short enough to be an origin.
    var raw = typeof v.connectionUrl === "string" ? v.connectionUrl.trim() : "";
    out.push({ key: key, status: status, url: raw && raw.length <= 512 ? raw : null, noUrl: !raw });
  }
  return out;
}
const DIGITS = /^\d{1,78}$/;

// One seed: both nodeCalls, in parallel, to the seed's pinned address. A seed whose latest /info answered with a key
// other than its configured one (seed.exclude) is not asked: its answers would not be that seed's.
export async function readSeed(seed, o) {
  var out = { name: seed.name, rows: null, listError: null, stake: null };
  if (seed.exclude) { out.listError = seed.exclude; return out; }
  var origin = await withTimeout(Promise.resolve().then(function() { return o.resolveOrigin(seed.url); }), o.timeoutMs).catch(function() { return null; });
  if (!origin) { out.listError = "address not resolved to a public http origin"; return out; }
  var both = await Promise.all([nodeCall(origin, "getValidators", {}, o), nodeCall(origin, "getNetworkParameters", {}, o)]);
  var v = both[0], p = both[1];
  if (!v.ok) out.listError = v.error;
  else { out.rows = reduceValidatorRows(v.response); if (!out.rows) out.listError = "unexpected shape"; }
  if (p.ok && p.response && typeof p.response === "object" && typeof p.response.minValidatorStake === "string" && DIGITS.test(p.response.minValidatorStake)) out.stake = p.response.minValidatorStake;
  return out;
}

// The single largest group of at least two entries with the same sig; null when there is none or the largest groups tie.
export function largestGroup(entries) {
  var groups = new Map();
  entries.forEach(function(e) { if (!groups.has(e.sig)) groups.set(e.sig, []); groups.get(e.sig).push(e); });
  var best = null, tie = false;
  groups.forEach(function(g) {
    if (g.length < 2) return;
    if (!best || g.length > best.length) { best = g; tie = false; } else if (g.length === best.length) tie = true;
  });
  return best && !tie ? best : null;
}
// A list's identity for agreement: its address–status pairs, in address order.
export function listSignature(rows) {
  return JSON.stringify(rows.map(function(x) { return [x.key, x.status]; }).sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }));
}
// Agreement: the largest group of at least two seeds whose lists hold the same address–status pairs. A connection URL
// is kept for a row only when every seed in that group lists the same URL for it.
export function agreeLists(reads) {
  var answered = reads.filter(function(r) { return r.rows; });
  var best = largestGroup(answered.map(function(r) { return { r: r, sig: listSignature(r.rows) }; }));
  var stakeGroup = largestGroup(reads.filter(function(r) { return r.stake !== null; }).map(function(r) { return { sig: r.stake }; }));
  var base = { seedsAnswered: answered.length, stake: stakeGroup ? stakeGroup[0].sig : null };
  if (!best) {
    return Object.assign(base, { agreed: false, seedsAgreed: 0, rows: null,
      reason: answered.length < 2 ? "fewer than two public seeds returned a validator list" : "the public seeds returned different validator lists" });
  }
  var group = best.map(function(e) { return e.r; });
  var urls = new Map();
  group.forEach(function(r) { r.rows.forEach(function(x) { if (!urls.has(x.key)) urls.set(x.key, new Set()); urls.get(x.key).add(x.noUrl ? "\u0000none" : x.url); }); });
  var rows = group[0].rows.map(function(x) {
    var u = urls.get(x.key);
    return { key: x.key, status: x.status, url: u.size === 1 ? x.url : null, noUrl: u.size === 1 && x.noUrl, urlsDiffer: u.size > 1 };
  });
  return Object.assign(base, { agreed: true, seedsAgreed: group.length, rows: rows,
    reason: group.length + " of " + reads.length + " public seeds returned the same validator list" });
}

export function countStatuses(rows) {
  var active = 0, unstaking = 0;
  rows.forEach(function(r) { if (r.status === STATUS_ACTIVE) active++; else if (r.status === STATUS_UNSTAKING) unstaking++; });
  return { listed: rows.length, active: active, unstaking: unstaking > 0 ? unstaking : null, other_status: rows.length - active - unstaking };
}

// ---- the watch ----------------------------------------------------------------------------------------------------
// One /info answer from an origin: the key it names, that key's own height from its own peerlist entry, its version.
async function dialInfo(origin, o) {
  try {
    var resp = await o.fetch(origin + "/info", fetchInit({ method: "GET" }, o.timeoutMs));
    if (resp.status !== 200) { await discard(resp); return { answered: false, error: probeErrorCategory(null, resp.status) }; }
    var data = await readJsonCapped(resp, o.maxBytes);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { answered: false, error: "invalid response" };
    var key = keyOf(data.identity), height = null;
    if (key !== null && Array.isArray(data.peerlist)) {
      var self = data.peerlist.find(function(p) { return p && keyOf(p.identity) === key; });
      if (self && self.sync) height = sanitizeHeight(self.sync.block);
    }
    return { answered: true, key: key, height: height, version: versionOf(data.version) };
  } catch (e) { return { answered: false, error: probeErrorCategory(e) }; }
}

// Name lookups share the process resolver with every other request DNO makes, the seed reads included. At most
// `concurrency` run at once: each keeps its slot until it settles, or lookupTimeoutMs at most, and its answer is used only
// if it came within that time. No new lookup starts after lookupBudgetMs. Result per name: an origin, null (did not
// resolve to a public address in time), or undefined (not looked up this round).
async function lookupNames(names, o) {
  var out = new Array(names.length), next = 0, started = Date.now();
  async function worker() {
    while (next < names.length && Date.now() - started < o.lookupBudgetMs) {
      var i = next++, timer;
      var answer = Promise.resolve().then(function() { return o.resolveOrigin(names[i]); }).catch(function() { return null; });
      out[i] = (await Promise.race([answer, new Promise(function(r) { timer = setTimeout(function() { r(null); }, o.lookupTimeoutMs); })])) || null;
      clearTimeout(timer);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, names.length)) }, worker));
  return out;
}

// Dial the ACTIVE rows, in address order. A row that publishes no address is no_address. A URL that is not a bare http
// origin is not_public_http; so is an address literal the resolver refuses (decided without a lookup, before the cap, so
// it takes no slot). Names and public literals take one slot each per distinct origin, at most maxOrigins; rows past
// that, or names not looked up within the lookup budget, are over_cap. A name that did not resolve to a public address
// in time is name_unresolved. Rows are grouped by the origin they published; each address DNO connects to is dialed
// once, so published origins that resolve to the same address share its one answer. Within a published origin the
// answer names at most one of the keys listed there; the others are answered_other_key, with shared set only when the
// answer named one of the keys listed on that same published origin. Returns { results: one per ACTIVE row
// { key, outcome, notDialed?, shared?, origin?, seed?, height?, version? }, origins: { dialed: published origins dialed,
// maxRows: the most ACTIVE rows on one of them } }.
export async function dialActive(rows, o) {
  var active = rows.filter(function(r) { return r.status === STATUS_ACTIVE; }).sort(function(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  // Every key the list shows on a published origin, whatever its status: an answer naming any of them is a key listed there.
  var listedOn = new Map();
  rows.forEach(function(r) {
    var q = !r.noUrl && !r.urlsDiffer && r.url ? parseProbeOrigin(r.url) : null;
    if (!q || q.protocol !== "http:") return;
    var b = q.protocol + "//" + q.host;
    if (!listedOn.has(b)) listedOn.set(b, new Set());
    listedOn.get(b).add(r.key);
  });
  var results = [], pending = [], names = [], originOf = new Map(), refused = new Set(), slots = new Set();
  var notDialed = function(r, why) { results.push({ key: r.key, outcome: "not_dialed", notDialed: why }); };
  for (var i = 0; i < active.length; i++) {
    var r = active[i];
    if (r.urlsDiffer) { notDialed(r, "seeds_differ"); continue; }
    if (r.noUrl) { notDialed(r, "no_address"); continue; }
    var p = r.url ? parseProbeOrigin(r.url) : null;
    if (!p || p.protocol !== "http:") { notDialed(r, "not_public_http"); continue; }
    var bare = p.protocol + "//" + p.host;           // one lookup and one dial per origin, however the URL was written
    if (refused.has(bare)) { notDialed(r, "not_public_http"); continue; }
    if (!slots.has(bare)) {
      if (isIP(p.hostname.replace(/^\[|\]$/g, ""))) {
        var lit = await Promise.resolve().then(function() { return o.resolveOrigin(bare); }).catch(function() { return null; });
        if (!lit) { refused.add(bare); notDialed(r, "not_public_http"); continue; }
        if (slots.size >= o.maxOrigins) { notDialed(r, "over_cap"); continue; }
        originOf.set(bare, lit);
      } else {
        if (slots.size >= o.maxOrigins) { notDialed(r, "over_cap"); continue; }
        names.push(bare);
      }
      slots.add(bare);
    }
    pending.push({ key: r.key, url: bare });
  }
  var looked = await lookupNames(names, o);
  names.forEach(function(n, k) { originOf.set(n, looked[k]); });
  // Grouped by the published origin (what the rows said); dialed once per address (what DNO connects to).
  var byPublished = new Map(), order = [], dials = [], dialOf = new Map();
  pending.forEach(function(r) {
    var origin = originOf.get(r.url);
    if (origin === undefined) { notDialed(r, "over_cap"); return; }
    if (!origin) { notDialed(r, "name_unresolved"); return; }
    if (!byPublished.has(r.url)) { byPublished.set(r.url, []); order.push(r.url); }
    byPublished.get(r.url).push(r);
    if (!dialOf.has(origin)) { dialOf.set(origin, dials.length); dials.push(origin); }
  });
  var answers = await mapWithConcurrency(dials, o.concurrency, function(origin) { return dialInfo(origin, o); });
  var seedKeys = o.seedKeys instanceof Set ? o.seedKeys : new Set(), maxRows = 0;
  order.forEach(function(published, idx) {
    var a = answers[dialOf.get(originOf.get(published))], listed = byPublished.get(published);
    maxRows = Math.max(maxRows, listed.length);
    var matched = a.answered && a.key !== null && listedOn.get(published).has(a.key);
    listed.forEach(function(r) {
      if (!a.answered) results.push({ key: r.key, outcome: "no_answer" });
      else if (a.key === null) results.push({ key: r.key, outcome: "answered_no_key" });
      else if (a.key !== r.key) results.push({ key: r.key, outcome: "answered_other_key", shared: matched, origin: idx });
      else results.push({ key: r.key, outcome: "answered_as_listed", seed: seedKeys.has(r.key), height: a.height, version: a.version });
    });
  });
  return { results: results, origins: { dialed: order.length, maxRows: maxRows } };
}

// Where an answer's own height sits against the seeds' median: "at", "off", "not_reported" (no own height in the
// answer) or "not_compared" (the median is not known this round).
export function heightPlace(height, reference, band) {
  if (height === null || height === undefined) return "not_reported";
  if (!reference || !Number.isFinite(reference.height)) return "not_compared";
  return Math.abs(height - reference.height) <= band ? "at" : "off";
}

// "Every round, last hour", in memory. A round counts when the list agreed and the seeds' median was known. A row is
// counted when it was answered as the listed key at the seeds' height in every counted round inside the window. The
// figure exists once the first counted round is a full window old and at least half the expected rounds counted.
export function createWatchHistory(windowMs, intervalMs) {
  var counted = [], okTimes = new Map(), firstCountedAt = null;
  function prune(now) {
    var cut = now - windowMs;
    while (counted.length && counted[0] <= cut) counted.shift();
    okTimes.forEach(function(ts, k) { while (ts.length && ts[0] <= cut) ts.shift(); if (!ts.length) okTimes.delete(k); });
  }
  return {
    record: function(at, isCounted, okKeys) {
      if (isCounted) {
        if (firstCountedAt === null) firstCountedAt = at;
        counted.push(at);
        okKeys.forEach(function(k) { if (!okTimes.has(k)) okTimes.set(k, []); okTimes.get(k).push(at); });
      }
      prune(at);
    },
    summary: function(now) {
      prune(now);
      var expected = Math.max(1, Math.floor(windowMs / intervalMs));
      var observedMs = firstCountedAt === null ? 0 : Math.max(0, Math.min(windowMs, now - firstCountedAt));
      var complete = firstCountedAt !== null && now - firstCountedAt >= windowMs && counted.length >= Math.ceil(expected / 2);
      var n = 0;
      if (complete) okTimes.forEach(function(ts) { if (ts.length === counted.length) n++; });
      return { count: complete ? n : null, window: { minutes: Math.round(windowMs / 60000), counted_rounds: counted.length, expected_rounds: expected, observed_minutes: Math.floor(observedMs / 60000), complete: complete } };
    }
  };
}

// ---- the first-agreed clock (DNO's clock) ------------------------------------------------------------------------------
// Rows: key -> first_agreed_at (the list time of the first agreed list that listed it ACTIVE) and prior_agreed_at (the
// list time of the agreed list before that one; null for keys on the store's first list). Meta: earliest (the store's
// first agreed list) and last_agreed_at. A window [now - w, now] has a figure only when the record started before it;
// a key counts in it when it is known to have first appeared inside it:
//   - first seen within gapMs of the previous agreed list: when first_agreed_at is inside the window;
//   - first seen after a longer gap: only when the list before the gap is itself inside the window. When the gap
//     crosses the window's start, the window has no figure (that key's join time is not known);
//   - a key on the store's first list: never.
// Not net of exits: a key that later leaves ACTIVE still counts where it first appeared.
// A failed write leaves memory as it was and every figure empty until a later write succeeds; the lists it missed are a
// gap in the record like any other, so the rules above still hold.
export const FIRST_AGREED_WINDOWS = Object.freeze([["today", 86400000, "24 h"], ["week", 7 * 86400000, "7 days"], ["month", 30 * 86400000, "30 days"]]);
export function createFirstAgreedStore(db, opts) {
  var gapMs = (opts && opts.gapMs) || 3600000;
  var keys = new Map(), meta = { earliest: null, last: null }, down = null, failed = false;
  if (!db) down = "no store is configured on this server";
  else {
    try {
      db.run("CREATE TABLE IF NOT EXISTS validator_first_agreed (key TEXT PRIMARY KEY, first_agreed_at INTEGER NOT NULL, prior_agreed_at INTEGER)");
      db.run("CREATE TABLE IF NOT EXISTS validator_first_agreed_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      db.query("SELECT key, first_agreed_at, prior_agreed_at FROM validator_first_agreed").all().forEach(function(r) { keys.set(r.key, { first: r.first_agreed_at, prior: r.prior_agreed_at }); });
      db.query("SELECT k, v FROM validator_first_agreed_meta").all().forEach(function(r) { if (r.k === "earliest") meta.earliest = r.v; else if (r.k === "last_agreed_at") meta.last = r.v; });
    } catch (e) { down = "the store is not available on this server"; keys.clear(); meta = { earliest: null, last: null }; }
  }
  return {
    // One agreed list, read at t, with its ACTIVE keys. Memory changes only after the write succeeded. A list with no
    // ACTIVE key is not recorded at all: as the first list it would make every later key "new", and later it would count
    // as coverage although it shows no key; a stretch of such lists is a gap in the record like any other.
    record: function(t, activeKeys) {
      if (down) return false;
      if (activeKeys.length === 0) return true;
      var fresh = activeKeys.filter(function(k) { return !keys.has(k); }), prior = meta.last;
      try {
        db.transaction(function() {
          var ins = db.prepare("INSERT OR IGNORE INTO validator_first_agreed (key, first_agreed_at, prior_agreed_at) VALUES (?, ?, ?)");
          fresh.forEach(function(k) { ins.run(k, t, prior); });
          var up = db.prepare("INSERT INTO validator_first_agreed_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
          if (meta.earliest === null) up.run("earliest", t);
          up.run("last_agreed_at", t);
        })();
      } catch (e) { failed = true; return false; }
      failed = false;
      fresh.forEach(function(k) { keys.set(k, { first: t, prior: prior }); });
      if (meta.earliest === null) meta.earliest = t;
      meta.last = t;
      return true;
    },
    summary: function(now) {
      var out = { today: null, week: null, month: null, since: meta.earliest, reason: null };
      if (down || failed) { out.reason = down || "the store could not record this round's list"; return out; }
      if (meta.earliest === null) { out.reason = "no agreed list with an ACTIVE key has been recorded yet"; return out; }
      FIRST_AGREED_WINDOWS.forEach(function(w) {
        var start = now - w[1];
        if (meta.earliest > start) { out.reason = out.reason || "the record started less than " + w[2] + " ago"; return; }
        var n = 0, unsure = false;
        keys.forEach(function(v) {
          if (v.prior === null || v.prior === undefined) return;
          if (v.first - v.prior <= gapMs) { if (v.first > start) n++; }
          else if (v.prior >= start) n++;
          else if (v.first > start) unsure = true;
        });
        if (unsure) { out.reason = out.reason || "a gap in the record crosses the start of the last " + w[2]; return; }
        out[w[0]] = n;
      });
      return out;
    },
    size: function() { return keys.size; }
  };
}

// ---- one round ----------------------------------------------------------------------------------------------------
// o: { seeds: [{name, url, exclude?}], resolveOrigin(url) -> Promise<origin|null>, reference() -> {height, observedAt}|null,
//      history, now() -> ms, fetch, dials (boolean), and any WATCH_DEFAULTS override }.
export async function runValidatorRound(opts) {
  var o = Object.assign({}, WATCH_DEFAULTS, { fetch: fetch, now: Date.now, dials: true }, opts);
  var reads = await Promise.all(o.seeds.map(function(s) { return readSeed(s, o); }));
  var list = agreeLists(reads);
  var listAt = o.now();
  if (list.agreed && o.growth) o.growth.record(listAt, list.rows.filter(function(r) { return r.status === STATUS_ACTIVE; }).map(function(r) { return r.key; }));
  var growth = o.growth ? o.growth.summary(listAt) : null;
  var dialed = list.agreed && o.dials ? await dialActive(list.rows, o) : null;
  var results = dialed ? dialed.results : null;
  var reference = results ? o.reference() : null;
  var roundAt = o.now();
  var outcomes = null, versions = null;
  if (results) {
    outcomes = { not_dialed: 0, not_dialed_reasons: { no_address: 0, not_public_http: 0, name_unresolved: 0, seeds_differ: 0, over_cap: 0 }, no_answer: 0, answered_other_key: 0, answered_no_key: 0, answered_as_listed: 0,
      at_seed_height: 0, off_seed_height: 0, height_not_reported: 0, height_not_compared: 0,
      origins_dialed: dialed.origins.dialed, max_rows_per_origin: dialed.origins.maxRows, other_key_shared: 0, other_key_shared_origins: 0, answered_as_listed_seeds: 0 };
    var vg = new Map(), sharedOrigins = new Set();
    results.forEach(function(r) {
      outcomes[r.outcome]++;
      if (r.outcome === "not_dialed") outcomes.not_dialed_reasons[r.notDialed]++;
      if (r.outcome === "answered_other_key" && r.shared) { outcomes.other_key_shared++; sharedOrigins.add(r.origin); }
      if (r.outcome !== "answered_as_listed") return;
      if (r.seed) outcomes.answered_as_listed_seeds++;
      r.place = heightPlace(r.height, reference, o.bandBlocks);
      outcomes[{ at: "at_seed_height", off: "off_seed_height", not_reported: "height_not_reported", not_compared: "height_not_compared" }[r.place]]++;
      vg.set(r.version, (vg.get(r.version) || 0) + 1);
    });
    outcomes.other_key_shared_origins = sharedOrigins.size;
    if (!reference) { outcomes.at_seed_height = null; outcomes.off_seed_height = null; }
    // Named groups: a version shared by at least versionMinCount validators, largest first, at most versionGroups of them.
    var named = [...vg.entries()].filter(function(e) { return e[0] !== null && e[1] >= o.versionMinCount; })
      .sort(function(a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
    var shown = named.slice(0, o.versionGroups);
    var total = results.filter(function(r) { return r.outcome === "answered_as_listed"; }).length;
    var none = vg.get(null) || 0;
    versions = { groups: shown.map(function(e) { return { version: e[0], count: e[1] }; }).concat(none ? [{ version: null, count: none }] : []),
      other: total - none - shown.reduce(function(s, e) { return s + e[1]; }, 0) };
  }
  var isCounted = !!(results && reference);
  o.history.record(roundAt, isCounted, isCounted ? new Set(results.filter(function(r) { return r.place === "at"; }).map(function(r) { return r.key; })) : null);
  var every = o.history.summary(roundAt);
  every.window.counted_this_round = isCounted;
  return {
    listAt: listAt, roundAt: roundAt, seedsConfigured: o.seeds.length, list: list,
    counts: list.agreed ? countStatuses(list.rows) : null,
    outcomes: outcomes, versions: versions, counted: isCounted, growth: growth,
    reference: reference ? { height: reference.height, observedAt: reference.observedAt } : null,
    everyRound: every,
    seedErrors: reads.map(function(r) { return { name: r.name, list: r.listError }; })
  };
}

// ---- published objects (counts only) --------------------------------------------------------------------------------
const iso = function(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

export function publicOnChainValidators(round, nowMs, cfg) {
  var c = Object.assign({}, WATCH_DEFAULTS, cfg);
  var out = { state: "pending", listed: null, active: null, unstaking: null, other_status: null, min_validator_stake: null,
    seeds_configured: c.seedsConfigured, seeds_answered: null, seeds_agreed: null, observed_at: null, reason: "no read has completed yet",
    first_agreed_today: null, first_agreed_week: null, first_agreed_month: null, first_agreed_as_of: null, first_agreed_since: null, first_agreed_reason: null };
  // Outside the agreed state the first-agreed figures are null for the list's own reason.
  var unagreed = function() { out.first_agreed_reason = out.reason; return out; };
  if (!round) return unagreed();
  out.observed_at = iso(round.listAt);
  if (nowMs - round.listAt > c.staleMs) { out.state = "stale"; out.reason = "the last read is older than " + Math.round(c.staleMs / 1000) + " s"; return unagreed(); }
  out.seeds_answered = round.list.seedsAnswered;
  out.seeds_agreed = round.list.seedsAgreed;
  out.min_validator_stake = round.list.stake;
  out.reason = round.list.reason;
  if (!round.list.agreed) { out.state = "not_agreed"; return unagreed(); }
  out.state = "agreed";
  Object.assign(out, round.counts);
  var g = round.growth;
  if (!g) out.first_agreed_reason = "no store is configured on this server";
  else Object.assign(out, { first_agreed_today: g.today, first_agreed_week: g.week, first_agreed_month: g.month, first_agreed_as_of: iso(round.listAt),
    first_agreed_since: g.since === null ? null : iso(g.since), first_agreed_reason: g.reason });
  return out;
}

export function publicValidatorWatch(round, nowMs, cfg) {
  var c = Object.assign({}, WATCH_DEFAULTS, cfg);
  var out = { state: "pending", round_at: null, interval_seconds: Math.round(c.intervalMs / 1000), height_band_blocks: c.bandBlocks,
    reference_height: null, reference_observed_at: null, watched: null,
    not_dialed: null, not_dialed_reasons: null, no_answer: null, answered_other_key: null, answered_no_key: null, answered_as_listed: null,
    at_seed_height: null, off_seed_height: null, height_not_reported: null, height_not_compared: null,
    origins_dialed: null, max_rows_per_origin: null, other_key_shared: null, other_key_shared_origins: null, answered_as_listed_seeds: null,
    every_round_last_hour: null, window: null, versions: null, versions_other: null, reason: "no round has completed yet" };
  if (c.dials === false) { out.state = "disabled"; out.reason = "dialing validators is turned off on this server"; return out; }
  if (!round) return out;
  out.round_at = iso(round.roundAt);
  if (nowMs - round.roundAt > c.staleMs) { out.state = "stale"; out.reason = "the last round is older than " + Math.round(c.staleMs / 1000) + " s"; return out; }
  out.window = Object.assign({}, round.everyRound.window);
  if (!round.outcomes) { out.state = "no_agreed_list"; out.reason = "no agreed validator list this round: " + round.list.reason; return out; }
  out.state = "observed";
  out.watched = round.counts.active;
  Object.assign(out, round.outcomes);
  out.not_dialed_reasons = Object.assign({}, round.outcomes.not_dialed_reasons);
  out.reference_height = round.reference ? round.reference.height : null;
  out.reference_observed_at = round.reference ? iso(round.reference.observedAt) : null;
  // Only a round that counted may carry the hour's figure, so the four counts stay nested.
  out.every_round_last_hour = round.counted ? round.everyRound.count : null;
  out.versions = round.versions.groups.map(function(g) { return { version: g.version, count: g.count }; });
  out.versions_other = round.versions.other;
  out.reason = round.reference ? "ACTIVE rows dialed at the address each published on chain" : "ACTIVE rows dialed; the seeds' median is not known this round, so heights were not compared";
  return out;
}

// Find a node: where one full key the reader supplied stands on the agreed validators list. The status of that key only,
// never another key, a URL, stake, a first-agreed time or a dial outcome, and only while the list is agreed and fresh;
// otherwise status is null and reason is the list's own. getValidators holds rows still active at a block, so an EXITED
// key is not_listed like a key that never staked.
export function listedStatus(round, key, nowMs, cfg) {
  var oc = publicOnChainValidators(round, nowMs, cfg);
  var out = { state: oc.state, status: null, seeds_agreed: oc.seeds_agreed, seeds_configured: oc.seeds_configured, observed_at: oc.observed_at, reason: oc.reason };
  if (oc.state !== "agreed") return out;
  var k = keyOf(key), hit = null;
  if (k !== null) for (var i = 0; i < round.list.rows.length; i++) if (round.list.rows[i].key === k) { hit = round.list.rows[i]; break; }
  out.status = !hit ? "not_listed" : hit.status === STATUS_ACTIVE ? "ACTIVE" : hit.status === STATUS_UNSTAKING ? "UNSTAKING" : "other";
  return out;
}

// The sentence the agent writes into the homepage for readers without JavaScript, from the two published objects:
// counts only, and the rows the ladder does not show accounted for as the page does. null outside the agreed state.
export function validatorsSentence(oc, w) {
  if (!oc || oc.state !== "agreed") return null;
  var s = oc.active + " ACTIVE on chain, as " + oc.seeds_agreed + " of " + oc.seeds_configured + " public seeds listed them at " + oc.observed_at.slice(11, 19) + " UTC.";
  if (w && w.state === "observed") {
    var span = w.window.minutes === 60 ? "the last hour" : w.window.minutes === 1 ? "the last minute" : "the last " + w.window.minutes + " minutes";
    s += " Of these, " + w.answered_as_listed + " answered DNO as the listed key at the address each published";
    if (w.at_seed_height === null) s += "; heights were not compared this round.";
    else {
      s += ", " + w.at_seed_height + " at the seeds' height";
      if (w.every_round_last_hour !== null) s += ", and " + w.every_round_last_hour + " in every round of " + span + ".";
      else if (w.window.observed_minutes < w.window.minutes) s += "; every round in " + span + ": insufficient observation (" + w.window.observed_minutes + " of " + w.window.minutes + " min).";
      else s += "; every round in " + span + ": insufficient observation (fewer than half the rounds counted).";
    }
    var shared = w.other_key_shared, origins = w.other_key_shared_origins, none = w.not_dialed_reasons ? w.not_dialed_reasons.no_address : 0;
    if (shared > 0) s += " " + shared + (shared === 1 ? " listed key shares " : " listed keys share ")
      + (origins > 1 ? origins + " published origins, each with a key that answered" : "one published origin with a key that answered")
      + ". That is not " + (shared === 1 ? "a node" : shared + " nodes") + " down.";
    if (none > 0) s += " " + none + (none === 1 ? " ACTIVE row publishes" : " ACTIVE rows publish") + " no address on chain.";
  }
  return s + " Not in status.";
}

// One log line per round. Counts only.
export function roundLogLine(round) {
  var l = round.list;
  var s = "[validators] list: " + (l.agreed ? l.seedsAgreed + "/" + round.seedsConfigured + " seeds agreed, " + round.counts.listed + " rows, " + round.counts.active + " ACTIVE" : l.reason);
  if (round.outcomes) {
    var x = round.outcomes;
    s += "; dialed " + (round.counts.active - x.not_dialed) + " of " + round.counts.active + ": " + x.answered_as_listed + " as listed (" + (x.at_seed_height === null ? "heights not compared" : x.at_seed_height + " at the seeds' height") + "), " + x.no_answer + " no answer, " + x.answered_other_key + " other key, " + x.answered_no_key + " no key";
    s += "; every round last hour: " + (!round.counted ? "not counted this round" : round.everyRound.count === null ? "window incomplete (" + round.everyRound.window.counted_rounds + "/" + round.everyRound.window.expected_rounds + ")" : round.everyRound.count);
  }
  var bad = round.seedErrors.filter(function(e) { return e.list; }).map(function(e) { return e.name + " " + e.list; });
  if (bad.length) s += "; no list from " + bad.join(", ");
  return s;
}
