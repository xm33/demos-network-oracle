// validator-watch.test.mjs — VALIDATOR_WATCH guard: the on-chain validators read and the watch count what they should
// and publish nothing they must not. Runs src/validator-watch.mjs against synthetic seeds and validators (Bun.serve on
// loopback) with a resolver that admits loopback http origins only; one section uses the production resolver.
// Rules under test: the SDK's nodeCall wire format; a figure only when two seeds return the same list; minValidatorStake
// only when two seeds report the same value; ACTIVE rows only; one dial per origin; the per-round cap; no dial to an
// address that is not a public http origin; redirects refused; the 2 MB cap; one outcome per row; the ±25 band; the
// every-round window; versions sanitised; stale and disabled states; counts only in what is published.
// Run: bun src/validator-watch.test.mjs   (executable harness, not `bun test`)

import { runValidatorRound, createWatchHistory, publicOnChainValidators, publicValidatorWatch, roundLogLine, agreeLists, reduceValidatorRows, heightPlace, keyOf } from "./validator-watch.mjs";
import { parseProbeOrigin, resolvePublicProbeOrigin } from "./public-safety.mjs";

const TAG = "VALIDATOR_WATCH";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

// Loopback http origins only, parsed the way production parses them.
const loopResolver = async (u) => { const p = parseProbeOrigin(u); return p && p.protocol === "http:" && p.hostname === "127.0.0.1" ? "http://127.0.0.1:" + p.port : null; };
const KEY = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const STAKE_VALUE = "987654321987654321";

// ---- synthetic validators ----------------------------------------------------------------------------------------
let HEIGHT = 5000;
const hits = {};
function validator(name, fn) {
  hits[name] = 0;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { hits[name]++; return fn(new URL(req.url), req); } });
  return { name, srv, url: "http://127.0.0.1:" + srv.port };
}
const infoOf = (key, height, version) => ({ identity: key, version: version === undefined ? "0.9.9 RC" : version, peerlist: [
  { identity: "0x" + "ee".repeat(32), sync: { block: height + 3 } },            // another peer first: its height must not be used
  ...(height === null ? [] : [{ identity: key.toUpperCase().replace("0X", "0x"), sync: { block: height, status: "synced" } }])] });
const V = {};
const trap = validator("trap", () => Response.json({ identity: KEY(0x99) }));
V.a = validator("a", (u) => u.pathname === "/info" ? Response.json(infoOf(KEY(0x11), HEIGHT)) : new Response("nf", { status: 404 }));
V.b = validator("b", () => Response.json(infoOf(KEY(0x12), HEIGHT + 25)));                  // edge of the band: at
V.c = validator("c", () => Response.json(infoOf(KEY(0x13), HEIGHT - 26)));                  // one past the band: off
V.d = validator("d", () => Response.json(infoOf(KEY(0x14), null)));                         // no own entry: height not reported
V.e = validator("e", () => Response.json(infoOf(KEY(0x77), HEIGHT)));                       // another key answers
V.f = validator("f", () => Response.json({ version: "0.9.9 RC", peerlist: [] }));          // no key
V.g = validator("g", () => new Response("down", { status: 500 }));
V.h = validator("h", () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
V.i = validator("i", () => Response.json([1, 2, 3]));
V.j = validator("j", () => new Response(null, { status: 302, headers: { location: trap.url + "/info" } }));
V.k = validator("k", () => new Response(JSON.stringify({ identity: KEY(0x1b), pad: "x".repeat(3 * 1024 * 1024) }), { headers: { "content-type": "application/json" } }));
V.l = validator("l", () => Response.json(infoOf(KEY(0x1c), HEIGHT, "<script>x</script>")));   // version not a clean label
V.m = validator("m", () => Response.json(infoOf(KEY(0x1d), HEIGHT, "0.9.8")));
V.u = validator("u", () => Response.json(infoOf(KEY(0x1e), HEIGHT)));                       // an UNSTAKING row's origin
const closedUrl = "http://127.0.0.1:1";

const row = (keyN, status, url) => ({ address: KEY(keyN), status, connectionUrl: url, stakedAmount: STAKE_VALUE, firstSeen: 1, validAt: 2, unstakeRequestedAt: null, unstakeAvailableAt: null });
const BASE_ROWS = [
  row(0x11, "2", V.a.url), row(0x12, "2", V.b.url), row(0x13, "2", V.c.url), row(0x14, "2", V.d.url), row(0x15, "2", V.e.url),
  row(0x16, "2", V.f.url), row(0x17, "2", V.g.url), row(0x18, "2", V.h.url), row(0x19, "2", V.i.url), row(0x1a, "2", V.j.url),
  row(0x1b, "2", V.k.url), row(0x1c, "2", V.l.url), row(0x1d, "2", V.m.url), row(0x1e, "3", V.u.url),
  row(0x1f, "2", V.a.url + "/"),               // shares an origin with 0x11: dialed once, answered with another key
  row(0x20, "2", closedUrl),                   // nothing listens: no answer
  row(0x21, "2", "http://10.0.0.8:53550"),     // not loopback: the test resolver refuses it like a private address
  row(0x22, "2", "https://127.0.0.1:" + V.a.srv.port), // https: never dialed
  row(0x23, "2", V.a.url + "/admin"),          // a path: not a bare origin
  row(0x24, "2", null),                        // no address published
  row(0x25, "0", null),                        // another status
];

// ---- synthetic seeds ---------------------------------------------------------------------------------------------
const calls = [];
function seed(name, behave) {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (req.method !== "POST" || u.pathname !== "/") return new Response("nf", { status: 404 });
    const body = await req.json();
    const p = body && Array.isArray(body.params) ? body.params[0] : null;
    calls.push({ seed: name, method: body.method, type: p && p.type, message: p && p.message, identity: req.headers.get("identity"), ct: req.headers.get("content-type") });
    if (body.method !== "nodeCall" || !p || p.type !== "nodeCall") return Response.json({ result: 400, response: "bad request" });
    const b = behave();
    if (p.message === "getValidators") return b.list === "down" ? new Response("x", { status: 503 }) : Response.json(b.list === "shape" ? { result: 200, response: "not a list" } : b.list === "error" ? { result: 500, response: "boom" } : { result: 200, response: b.list });
    if (p.message === "getNetworkParameters") return Response.json({ result: 200, response: { minValidatorStake: b.stake, shardSize: 4, blockTimeMs: 10000 } });
    return Response.json({ result: 404, response: "unknown" });
  } });
  return { name, url: "http://127.0.0.1:" + srv.port, srv };
}
const SEED = { a: { list: BASE_ROWS, stake: "1000000000000" }, b: { list: BASE_ROWS, stake: "1000000000000" }, c: { list: BASE_ROWS.slice(0, 5), stake: "2000000000000" } };
const S = { a: seed("seed-a", () => SEED.a), b: seed("seed-b", () => SEED.b), c: seed("seed-c", () => SEED.c) };
const SEEDS = [S.a, S.b, S.c].map((s) => ({ name: s.name, url: s.url }));
const ref = (h) => () => (h === null ? null : { height: h, observedAt: 1 });
const resetHits = () => Object.keys(hits).forEach((k) => (hits[k] = 0));
async function round(extra) {
  return runValidatorRound(Object.assign({ seeds: SEEDS, resolveOrigin: loopResolver, reference: ref(HEIGHT), history: createWatchHistory(3600000, 60000) }, extra));
}
// The synthetic validators' own ports: none may appear in anything published.
const PORTS = () => new RegExp("\\b(" + Object.values(V).map((v) => v.srv.port).join("|") + ")\\b");
const FORBIDDEN = (text) => [/127\.0\.0\.1/, /10\.0\.0\.8/, /https?:/, /0x[0-9a-f]{8,}/i, /(?:11|12|13|1e|1f|20){16}/i, new RegExp(STAKE_VALUE), PORTS()]
  .filter((re) => re.test(text)).map(String);

console.log("\n[" + TAG + "] the read");
{
  calls.length = 0;
  const r = await round();
  const oc = publicOnChainValidators(r, r.listAt, { seedsConfigured: 3 });
  check("R1 nodeCalls use the SDK wire format, unauthenticated, JSON", calls.length === 6 && calls.every((c) => c.method === "nodeCall" && c.type === "nodeCall" && !c.identity && /application\/json/.test(c.ct || ""))
    && calls.filter((c) => c.message === "getValidators").length === 3 && calls.filter((c) => c.message === "getNetworkParameters").length === 3, JSON.stringify(calls.slice(0, 2)));
  check("R2 two of three seeds return the same list: figures from that list", oc.state === "agreed" && oc.seeds_answered === 3 && oc.seeds_agreed === 2 && oc.seeds_configured === 3
    && oc.listed === 21 && oc.active === 19 && oc.unstaking === 1 && oc.other_status === 1 && /2 of 3 public seeds/.test(oc.reason), JSON.stringify(oc));
  check("R3 minValidatorStake from the two seeds that report the same value", oc.min_validator_stake === "1000000000000", oc.min_validator_stake);
  SEED.c = { list: BASE_ROWS.slice(0, 4), stake: "3000000000000" }; SEED.b = { list: BASE_ROWS.slice(0, 5), stake: "2000000000000" };
  const r2 = await round();
  const oc2 = publicOnChainValidators(r2, r2.listAt, { seedsConfigured: 3 });
  check("R4 three different lists: no figure, reason says so", oc2.state === "not_agreed" && oc2.active === null && oc2.listed === null && oc2.min_validator_stake === null && oc2.seeds_answered === 3 && oc2.seeds_agreed === 0 && /different validator lists/.test(oc2.reason), JSON.stringify(oc2));
  const w2 = publicValidatorWatch(r2, r2.roundAt, {});
  check("R5 no agreed list: nothing dialed, the watch says why", w2.state === "no_agreed_list" && w2.answered_as_listed === null && w2.watched === null && /no agreed validator list/.test(w2.reason) && r2.outcomes === null, JSON.stringify(w2));
  SEED.b = { list: "down", stake: "1000000000000" }; SEED.c = { list: "shape", stake: "1000000000000" };
  const r3 = await round();
  const oc3 = publicOnChainValidators(r3, r3.listAt, { seedsConfigured: 3 });
  check("R6 one list and one unexpected shape: fewer than two, no figure; the stake still agrees", oc3.state === "not_agreed" && oc3.seeds_answered === 1 && /fewer than two/.test(oc3.reason) && oc3.min_validator_stake === "1000000000000", JSON.stringify(oc3));
  check("R7 rows without an address or a status, or a repeated address, are an unexpected shape", reduceValidatorRows([{ address: KEY(1), status: 2 }]) === null
    && reduceValidatorRows([{ address: "", status: "2" }]) === null && reduceValidatorRows([{ address: KEY(1), status: "2" }, { address: KEY(1).toUpperCase().replace("0X", "0x"), status: "2" }]) === null
    && reduceValidatorRows("x") === null && reduceValidatorRows([]).length === 0);
  const reduced = reduceValidatorRows([row(0x31, "2", "http://example.invalid:1")]);
  check("R8 stake and timestamps are dropped on arrival", reduced.length === 1 && JSON.stringify(Object.keys(reduced[0]).sort()) === JSON.stringify(["key", "status", "url"]), JSON.stringify(reduced));
  const st = agreeLists([{ rows: [], stake: "5" }, { rows: [], stake: "6" }, { rows: [], stake: null }]);
  check("R9 stake split: not reported; an empty list agreed by two is a list of zero", st.stake === null && st.agreed === true && st.rows.length === 0);
  SEED.a = { list: BASE_ROWS, stake: "1000000000000" }; SEED.b = { list: BASE_ROWS, stake: "1000000000000" }; SEED.c = { list: BASE_ROWS.slice(0, 5), stake: "2000000000000" };
  const onlyActive = BASE_ROWS.filter((x) => x.status === "2");
  SEED.a = { list: onlyActive, stake: "1" }; SEED.b = { list: onlyActive, stake: "1" };
  const r4 = await round();
  check("R10 no UNSTAKING row listed: unstaking is null, not 0", publicOnChainValidators(r4, r4.listAt, {}).unstaking === null);
  SEED.a = { list: BASE_ROWS, stake: "1000000000000" }; SEED.b = { list: BASE_ROWS, stake: "1000000000000" };
}

console.log("\n[" + TAG + "] the watch");
{
  resetHits();
  const r = await round();
  const w = publicValidatorWatch(r, r.roundAt, {});
  check("W1 ACTIVE rows watched; the UNSTAKING row's origin is never dialed", w.state === "observed" && w.watched === 19 && hits.u === 0, "watched " + w.watched + " u " + hits.u);
  check("W2 one dial per origin: two rows on one origin, one answered as itself, one with another key", hits.a === 1, "hits.a " + hits.a);
  check("W3 not dialed: not a public http origin (private, https, path, none)", w.not_dialed === 4 && w.not_dialed_reasons.not_public_http === 4 && w.not_dialed_reasons.seeds_differ === 0 && w.not_dialed_reasons.over_cap === 0, JSON.stringify(w.not_dialed_reasons));
  check("W4 redirect refused: no answer, and the redirect target is never dialed", hits.j === 1 && hits.trap === 0);
  check("W5 no answer: HTTP 500, invalid JSON, a JSON array, a redirect, a body over 2 MB, a closed port", w.no_answer === 6, "no_answer " + w.no_answer);
  check("W6 answered with another key (two: e, and the row sharing a's origin); answered without a key (f)", w.answered_other_key === 2 && w.answered_no_key === 1, w.answered_other_key + " / " + w.answered_no_key);
  check("W7 answered as the listed key: a, b, c, d, l, m", w.answered_as_listed === 6, "as listed " + w.answered_as_listed);
  check("W8 heights: ±25 of the seeds' median is at (a, b, l, m); 26 below is off (c); no own entry is not reported (d)", w.at_seed_height === 4 && w.off_seed_height === 1 && w.height_not_reported === 1 && w.height_not_compared === 0 && w.reference_height === HEIGHT && w.height_band_blocks === 25, JSON.stringify([w.at_seed_height, w.off_seed_height, w.height_not_reported]));
  check("W9 the outcomes add up to the watched rows", w.not_dialed + w.no_answer + w.answered_other_key + w.answered_no_key + w.answered_as_listed === w.watched
    && w.at_seed_height + w.off_seed_height + w.height_not_reported + w.height_not_compared === w.answered_as_listed);
  check("W10 versions: a shared release version is named; one validator's version is only counted; free text is no version", JSON.stringify(w.versions) === JSON.stringify([{ version: "0.9.9 RC", count: 4 }, { version: null, count: 1 }]) && w.versions_other === 1, JSON.stringify([w.versions, w.versions_other]));
  check("W11 heights from the answer's own entry, never the first listed peer", heightPlace(HEIGHT + 3, { height: HEIGHT }, 25) === "at" && w.off_seed_height === 1);

  resetHits();
  const capped = await round({ maxOrigins: 3 });
  const wc = publicValidatorWatch(capped, capped.roundAt, {});
  const dialed = Object.entries(hits).filter(([k, n]) => n > 0).map(([k]) => k).sort().join(",");
  check("W12 per-round cap: the first origins in address order are dialed, the rest are over the cap", wc.not_dialed_reasons.over_cap === 11 && wc.not_dialed_reasons.not_public_http === 4 && dialed === "a,b,c", dialed + " " + JSON.stringify(wc.not_dialed_reasons));

  const diff = BASE_ROWS.map((x) => (x.address === KEY(0x12) ? Object.assign({}, x, { connectionUrl: V.m.url }) : x));
  SEED.b = { list: diff, stake: "1000000000000" };
  const rd = await round();
  const wd = publicValidatorWatch(rd, rd.roundAt, {});
  check("W13 the agreeing seeds list different addresses for one row: not dialed", wd.not_dialed_reasons.seeds_differ === 1, JSON.stringify(wd.not_dialed_reasons));
  SEED.b = { list: BASE_ROWS, stake: "1000000000000" };

  const rn = await round({ reference: ref(null) });
  const wn = publicValidatorWatch(rn, rn.roundAt, {});
  check("W14 the seeds' median unknown: heights not compared, at and off are null, the round does not count", wn.at_seed_height === null && wn.off_seed_height === null && wn.height_not_compared === 5 && wn.reference_height === null && wn.window.counted_rounds === 0 && /not known this round/.test(wn.reason), JSON.stringify([wn.height_not_compared, wn.window]));

  resetHits();
  const rp = await round({ resolveOrigin: resolvePublicProbeOrigin });
  const wp = publicValidatorWatch(rp, rp.roundAt, {});
  const oc = publicOnChainValidators(rp, rp.listAt, {});
  check("W15 with the production resolver no loopback, private, https or path address is dialed (seeds included)", Object.values(hits).every((n) => n === 0) && oc.state === "not_agreed" && oc.seeds_answered === 0, JSON.stringify(hits));
  check("W16 production resolver: https and private addresses are refused before any connection", (await resolvePublicProbeOrigin("https://8.8.8.8:443")) === null && (await resolvePublicProbeOrigin("http://10.0.0.8:53550")) === null && (await resolvePublicProbeOrigin("http://8.8.8.8:53550")) === "http://8.8.8.8:53550");

  resetHits();
  const rx = await round({ dials: false });
  const wx = publicValidatorWatch(rx, rx.roundAt, { dials: false });
  check("W17 dials turned off: the read continues, nothing is dialed, the watch says so", wx.state === "disabled" && /turned off/.test(wx.reason) && Object.entries(hits).every(([k, n]) => n === 0) && publicOnChainValidators(rx, rx.listAt, {}).state === "agreed");
}

console.log("\n[" + TAG + "] every round, last hour");
{
  const H = createWatchHistory(600000, 60000);   // a 10-minute window, one round a minute: 10 expected rounds
  const all = new Set(["k1", "k2", "k3"]);
  let t = 1000000;
  H.record(t, true, all);
  check("E1 incomplete before a full window", H.summary(t).count === null && H.summary(t).window.complete === false && H.summary(t).window.observed_minutes === 0);
  for (let i = 1; i <= 10; i++) { t += 60000; H.record(t, true, i === 4 ? new Set(["k1", "k2"]) : i === 7 ? new Set(["k1", "k3"]) : all); }
  const s = H.summary(t);
  check("E2 complete after a full window; a row missing one counted round is not counted", s.window.complete === true && s.window.counted_rounds === 10 && s.window.expected_rounds === 10 && s.count === 1, JSON.stringify(s));
  t += 60000; H.record(t, false, null);
  check("E3 a round that does not count (no list, or no median) neither adds nor removes", H.summary(t).count === 1 && H.summary(t).window.counted_rounds === 9, JSON.stringify(H.summary(t)));
  for (let i = 0; i < 3; i++) { t += 60000; H.record(t, true, all); }
  check("E4 once the missed round leaves the window, the row counts again", H.summary(t).count === 2 && H.summary(t).window.counted_rounds === 9, JSON.stringify(H.summary(t)));
  for (let i = 0; i < 6; i++) { t += 60000; H.record(t, false, null); }
  check("E5 fewer than half the expected rounds counted in the window: no figure", H.summary(t).count === null && H.summary(t).window.complete === false, JSON.stringify(H.summary(t)));
  const fresh = createWatchHistory(600000, 60000);
  check("E6 a restart starts the window again", fresh.summary(t).count === null && fresh.summary(t).window.counted_rounds === 0 && fresh.summary(t).window.observed_minutes === 0);

  // Through runValidatorRound with a clock: rows at the seeds' height every round are counted once the window is full.
  let clock = 5000000;
  const hist = createWatchHistory(180000, 60000);
  let last;
  for (let i = 0; i < 4; i++) { last = await round({ history: hist, now: () => clock, intervalMs: 60000, windowMs: 180000 }); clock += 60000; }
  const we = publicValidatorWatch(last, last.roundAt, { windowMs: 180000, intervalMs: 60000 });
  check("E7 end to end: after a full window, the rows at the seeds' height in every round are counted", we.every_round_last_hour === 4 && we.window.complete === true && we.window.minutes === 3, JSON.stringify([we.every_round_last_hour, we.window]));
}

console.log("\n[" + TAG + "] states and what is published");
{
  const pend = publicOnChainValidators(null, Date.now(), { seedsConfigured: 3 }), wpend = publicValidatorWatch(null, Date.now(), {});
  check("P1 before the first read: pending, every figure null", pend.state === "pending" && pend.active === null && pend.seeds_configured === 3 && wpend.state === "pending" && wpend.answered_as_listed === null);
  const r = await round();
  const late = r.roundAt + 300001;
  const os = publicOnChainValidators(r, r.listAt + 300001, {}), ws = publicValidatorWatch(r, late, {});
  check("P2 a read or a round older than 300 s is stale: figures null, the time kept", os.state === "stale" && os.active === null && os.observed_at !== null && ws.state === "stale" && ws.answered_as_listed === null && ws.round_at !== null && /older than 300 s/.test(ws.reason));
  const text = JSON.stringify([publicOnChainValidators(r, r.listAt, {}), publicValidatorWatch(r, r.roundAt, {})]);
  const leaks = FORBIDDEN(text);
  check("P3 published objects: no address, key, connection URL, host, port or stake", leaks.length === 0, leaks.join(" "));
  const line = roundLogLine(r);
  check("P4 the log line carries counts only", FORBIDDEN(line).length === 0 && /2\/3 seeds agreed, 21 rows, 19 ACTIVE/.test(line), line);
  const w = publicValidatorWatch(r, r.roundAt, {});
  check("P5 no per-row field in what is published", !/"(key|address|url|connectionUrl|height|outcome|rows|stakedAmount)"/.test(text) && Array.isArray(w.versions));
  check("P6 key comparison ignores case and a leading 0x only", keyOf("0xAB12") === "ab12" && keyOf("AB12") === "ab12" && keyOf("0xab 12") === null && keyOf(12) === null);
}

console.log("\n[" + TAG + "] hardening");
{
  // Seeds and validators built for one case each. rowsFor(name) gives each seed's list.
  const mk = (fn) => { const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fn }); return { srv, url: "http://127.0.0.1:" + srv.port }; };
  const seedOf = (rowsFn, stake, asked) => mk(async (req) => {
    const p = (await req.json()).params[0];
    if (asked) asked.n++;
    return Response.json(p.message === "getValidators" ? { result: 200, response: rowsFn() } : { result: 200, response: { minValidatorStake: stake } });
  });
  const run = (seeds, extra) => runValidatorRound(Object.assign({ seeds: seeds.map((x, i) => ({ name: "s" + i, url: x.url })), resolveOrigin: loopResolver, reference: ref(HEIGHT), history: createWatchHistory(3600000, 60000) }, extra));
  const stopAll = (xs) => xs.forEach((x) => x.srv.stop(true));

  // Free text in a version never reaches what is published; a version one validator reports is only counted.
  const HOSTILE = ["certified safe - best", "203.0.113.9:53550", "0xc8bc5866fecf583bc1232f04fa54fd", "approved ready (trusted)", "0.9.9 RC", "0.9.9 RC", "v1.2.3", "1.0.0-beta.2", "1.0.0-beta.2"];
  const vals = HOSTILE.map((ver, i) => mk(() => Response.json({ identity: KEY(0x40 + i), version: ver, peerlist: [{ identity: KEY(0x40 + i), sync: { block: HEIGHT } }] })));
  const hRows = vals.map((v, i) => row(0x40 + i, "2", v.url));
  const hs = [seedOf(() => hRows, "1"), seedOf(() => hRows, "1")];
  const hr = await run(hs);
  const hw = publicValidatorWatch(hr, hr.roundAt, {});
  const htext = JSON.stringify(hw);
  check("H1 hostile version text is never published; shared release versions are named; single ones are counted",
    JSON.stringify(hw.versions) === JSON.stringify([{ version: "0.9.9 RC", count: 2 }, { version: "1.0.0-beta.2", count: 2 }, { version: null, count: 4 }]) && hw.versions_other === 1
    && !/certified|safe|best|approved|ready|trusted|203\.0|c8bc/.test(htext), JSON.stringify([hw.versions, hw.versions_other]));
  stopAll(vals.concat(hs));

  // At most six version groups are named; the rest are counted.
  const eight = Array.from({ length: 16 }, (_, i) => mk(() => Response.json({ identity: KEY(0x60 + i), version: "0." + (1 + (i >> 1)) + ".0", peerlist: [{ identity: KEY(0x60 + i), sync: { block: HEIGHT } }] })));
  const eRows = eight.map((v, i) => row(0x60 + i, "2", v.url));
  const es = [seedOf(() => eRows, "1"), seedOf(() => eRows, "1")];
  const ew = publicValidatorWatch(await run(es), Date.now(), {});
  check("H2 six version groups at most, the rest counted as other", ew.versions.length === 6 && ew.versions.every((g) => g.count === 2) && ew.versions_other === 4, JSON.stringify([ew.versions, ew.versions_other]));
  stopAll(eight.concat(es));

  // Bodies past 2 MB with no declared length, and compressed bodies, are no answer.
  const { gzipSync } = await import("node:zlib");
  const big = "x".repeat(3 * 1024 * 1024);
  const chunked = mk(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 48; i++) c.enqueue(new TextEncoder().encode(big.slice(0, 65536))); c.close(); } }), { headers: { "content-type": "application/json" } }));
  const gz = mk(() => new Response(gzipSync(JSON.stringify({ identity: KEY(0x71), pad: big })), { headers: { "content-type": "application/json", "content-encoding": "gzip" } }));
  const bRows = [row(0x70, "2", chunked.url), row(0x71, "2", gz.url)];
  const bs = [seedOf(() => bRows, "1"), seedOf(() => bRows, "1")];
  const bw = publicValidatorWatch(await run(bs), Date.now(), {});
  check("H3 a 3 MB body without a declared length, and a gzip body that expands past 2 MB, are no answer", bw.no_answer === 2 && bw.answered_as_listed === 0, JSON.stringify([bw.no_answer, bw.answered_as_listed]));
  stopAll([chunked, gz].concat(bs));

  // The four counts stay nested round after round, including a round whose median is unknown.
  let clock = 9000000, refNow = HEIGHT;
  const hist = createWatchHistory(180000, 60000);
  const seq = [];
  for (let i = 0; i < 6; i++) {
    const r = await round({ history: hist, now: () => clock, reference: () => (i === 4 ? null : { height: refNow, observedAt: clock }) });
    seq.push(publicValidatorWatch(r, r.roundAt, { windowMs: 180000, intervalMs: 60000 })); clock += 60000;
  }
  const nested = seq.every((w) => (w.every_round_last_hour === null || (w.at_seed_height !== null && w.every_round_last_hour <= w.at_seed_height)) && (w.at_seed_height === null || w.at_seed_height <= w.answered_as_listed) && w.answered_as_listed <= w.watched);
  check("H4 nested counts in every round; a round without the median publishes no hour figure", nested && seq[3].every_round_last_hour === 4 && seq[4].every_round_last_hour === null && seq[4].window.counted_this_round === false && seq[5].every_round_last_hour === 4,
    JSON.stringify(seq.map((w) => [w.answered_as_listed, w.at_seed_height, w.every_round_last_hour])));

  // A restart starts the window again even when the old history would have a figure.
  const old = createWatchHistory(180000, 60000), fresh = createWatchHistory(180000, 60000);
  const all = new Set(["k1", "k2"]);
  for (let i = 0; i <= 3; i++) old.record(1000 + i * 60000, true, all);
  fresh.record(1000 + 3 * 60000, true, all);
  check("H5 after a restart the hour figure is insufficient until a full window has passed again", old.summary(1000 + 180000).count === 2 && fresh.summary(1000 + 180000).count === null && fresh.summary(1000 + 180000).window.observed_minutes === 0);

  // Four seeds split two and two: no figure, for the list and for the stake.
  const lA = [row(0x81, "2", null)], lB = [row(0x82, "2", null)];
  const four = [seedOf(() => lA, "5"), seedOf(() => lA, "5"), seedOf(() => lB, "6"), seedOf(() => lB, "6")];
  const fr = await run(four);
  const fo = publicOnChainValidators(fr, fr.listAt, { seedsConfigured: 4 });
  check("H6 a two-two split is no agreement, for the list and for minValidatorStake", fo.state === "not_agreed" && fo.min_validator_stake === null && /different validator lists/.test(fo.reason), JSON.stringify(fo));
  stopAll(four);

  // A seed whose last /info named another key is not asked.
  const asked = { n: 0 };
  const sx = [seedOf(() => lA, "5"), seedOf(() => lA, "5"), seedOf(() => lA, "5", asked)];
  const xr = await runValidatorRound({ seeds: sx.map((x, i) => ({ name: "s" + i, url: x.url, exclude: i === 2 ? "its last /info answered with another key" : null })), resolveOrigin: loopResolver, reference: ref(HEIGHT), history: createWatchHistory(3600000, 60000) });
  check("H7 an excluded seed is not asked and not counted", asked.n === 0 && xr.list.seedsAnswered === 2 && xr.list.seedsAgreed === 2 && /its last \/info answered with another key/.test(roundLogLine(xr)), JSON.stringify([asked.n, xr.list.seedsAnswered]));
  stopAll(sx);

  // Name lookups: at most eight outstanding, each holding its slot until it settles; the cap and the budget stop them.
  let calls = 0, inflight = 0, peak = 0;
  const slow = (ms) => async (u) => { calls++; inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, ms)); inflight--; return null; };
  const names = (n, base) => Array.from({ length: n }, (_, i) => row(base + i, "2", "http://validator-" + (base + i) + ".invalid:53550"));
  const nameRound = async (rowsN, resolver, extra) => {
    const ss = [seedOf(() => rowsN, "1"), seedOf(() => rowsN, "1")];
    const t0 = Date.now();
    const rr = await runValidatorRound(Object.assign({ seeds: ss.map((x, i) => ({ name: "s" + i, url: x.url })), resolveOrigin: (u) => (/validator-/.test(u) ? resolver(u) : loopResolver(u)), reference: ref(HEIGHT), history: createWatchHistory(3600000, 60000) }, extra));
    stopAll(ss);
    return { w: publicValidatorWatch(rr, rr.roundAt, {}), took: Date.now() - t0 };
  };
  let res = await nameRound(names(20, 0x90), slow(350), { maxOrigins: 12 });
  check("H8 a published name that does not resolve is name_unresolved, not 'not a public http origin'", res.w.not_dialed_reasons.name_unresolved === 12 && res.w.not_dialed_reasons.not_public_http === 0, JSON.stringify(res.w.not_dialed_reasons));
  check("H9 lookups: never more than eight outstanding, each keeps its slot until it settles, the cap stops them", calls === 12 && peak === 8 && res.w.not_dialed_reasons.over_cap === 8 && res.took >= 650 && res.took < 2000, JSON.stringify({ calls, peak, took: res.took }));
  calls = 0; inflight = 0; peak = 0;
  const never = async (u) => { calls++; await new Promise((r) => { const tm = setTimeout(r, 60000); if (tm.unref) tm.unref(); }); return null; };
  res = await nameRound(names(12, 0xb0), never, { lookupTimeoutMs: 300 });
  check("H12 a lookup that never settles gives up its slot at the lookup timeout", calls === 12 && res.w.not_dialed_reasons.name_unresolved === 12 && res.took >= 550 && res.took < 2000, JSON.stringify({ calls, took: res.took }));
  calls = 0; inflight = 0; peak = 0;
  res = await nameRound(names(24, 0xc0), slow(350), { lookupBudgetMs: 500 });
  check("H13 no new lookup after the lookup budget; names not looked up are over the round cap", calls === 16 && res.w.not_dialed_reasons.name_unresolved === 16 && res.w.not_dialed_reasons.over_cap === 8, JSON.stringify({ calls, reasons: res.w.not_dialed_reasons }));
  // Address literals the resolver refuses take no slot: with a cap of three, the three dialable origins behind them are dialed.
  resetHits();
  const lits = [row(0x01, "2", "http://10.0.0.1:53550"), row(0x02, "2", "http://192.168.1.1:53550"), row(0x03, "2", "http://[::1]:53550"),
    row(0x11, "2", V.a.url), row(0x12, "2", V.b.url), row(0x13, "2", V.c.url)];
  const ls = [seedOf(() => lits, "1"), seedOf(() => lits, "1")];
  const lw = publicValidatorWatch(await run(ls, { maxOrigins: 3 }), Date.now(), {});
  check("H14 refused address literals take no slot under the cap", lw.not_dialed_reasons.not_public_http === 3 && lw.not_dialed_reasons.over_cap === 0 && hits.a === 1 && hits.b === 1 && hits.c === 1 && lw.answered_as_listed === 3, JSON.stringify([lw.not_dialed_reasons, hits.a, hits.b, hits.c]));
  stopAll(ls);

  // A status is a short code: a newline or free text in it is an unexpected shape, so two lists cannot be made to collide.
  const odd = [{ address: KEY(0xaa), status: "2\nbb 2" }], even = [{ address: KEY(0xaa), status: "2" }, { address: KEY(0xbb), status: "2" }];
  check("H10 a status with a newline is an unexpected shape", reduceValidatorRows(odd) === null && reduceValidatorRows(even).length === 2);

  // Two seeds agree on an empty list: zero rows, and nothing dialed.
  const zs = [seedOf(() => [], "1"), seedOf(() => [], "1")];
  const zr = await run(zs);
  const zw = publicValidatorWatch(zr, zr.roundAt, {});
  check("H11 an agreed empty list: zero ACTIVE, zero watched, nothing dialed", publicOnChainValidators(zr, zr.listAt, {}).active === 0 && zw.watched === 0 && zw.answered_as_listed === 0);
  stopAll(zs);
}

Object.values(V).concat([trap]).forEach((v) => v.srv.stop(true));
Object.values(S).forEach((s) => s.srv.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
