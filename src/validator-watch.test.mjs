// validator-watch.test.mjs — VALIDATOR_WATCH guard: the on-chain validators read and the watch count what they should
// and publish nothing they must not. Runs src/validator-watch.mjs against synthetic seeds and validators (Bun.serve on
// loopback) with a resolver that admits loopback http origins only; one section uses the production resolver.
// Rules under test: the SDK's nodeCall wire format; a figure only when two seeds return the same list; minValidatorStake
// only when two seeds report the same value; ACTIVE rows only; one dial per origin; the per-round cap; no dial to an
// address that is not a public http origin; redirects refused; the 2 MB cap; one outcome per row; the ±25 band; the
// every-round window; versions sanitised; stale and disabled states; counts only in what is published.
// Run: bun src/validator-watch.test.mjs   (executable harness, not `bun test`)

import { runValidatorRound, createWatchHistory, publicOnChainValidators, publicValidatorWatch, roundLogLine, agreeLists, reduceValidatorRows, heightPlace, keyOf, createFirstAgreedStore, validatorsSentence, listedStatus, dialsEnabled } from "./validator-watch.mjs";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
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
  check("R8 stake and timestamps are dropped on arrival", reduced.length === 1 && JSON.stringify(Object.keys(reduced[0]).sort()) === JSON.stringify(["key", "noUrl", "status", "url"]), JSON.stringify(reduced));
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
  check("W3 not dialed: no address published (none), not a public http origin (private, https, path)", w.not_dialed === 4 && w.not_dialed_reasons.no_address === 1 && w.not_dialed_reasons.not_public_http === 3 && w.not_dialed_reasons.seeds_differ === 0 && w.not_dialed_reasons.over_cap === 0, JSON.stringify(w.not_dialed_reasons));
  check("W18 origins: 14 dialed, at most 2 rows on one; the row sharing a's origin is other_key_shared, the answer naming an unlisted key is not",
    w.origins_dialed === 14 && w.max_rows_per_origin === 2 && w.other_key_shared === 1 && w.other_key_shared_origins === 1 && w.answered_other_key === 2 && w.answered_as_listed_seeds === 0,
    JSON.stringify([w.origins_dialed, w.max_rows_per_origin, w.other_key_shared, w.other_key_shared_origins]));
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
  check("W12 per-round cap: the first origins in address order are dialed, the rest are over the cap", wc.not_dialed_reasons.over_cap === 11 && wc.not_dialed_reasons.not_public_http === 3 && wc.not_dialed_reasons.no_address === 1 && dialed === "a,b,c", dialed + " " + JSON.stringify(wc.not_dialed_reasons));

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
  const rs = await round({ seedKeys: new Set([keyOf(KEY(0x11)), keyOf(KEY(0x12)), keyOf(KEY(0x15)), keyOf(KEY(0x55))]) });
  check("W19 seeds among the answers: only keys answered as listed count (0x15 is a seed key whose row answered with another key; 0x55 is not listed)", publicValidatorWatch(rs, rs.roundAt, {}).answered_as_listed_seeds === 2);
}

console.log("\n[" + TAG + "] one origin, many rows (the 29 Sep shape: 19 rows on one origin, 9 with no address)");
{
  const X = KEY(0xd0);
  const one = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: X, version: "0.9.9 RC", peerlist: [{ identity: X, sync: { block: HEIGHT } }] }); } });
  const u19 = "http://127.0.0.1:" + one.port;
  const rows19 = [row(0xd0, "2", u19)].concat(Array.from({ length: 18 }, (_, i) => row(0xe0 + i, "2", u19))).concat(Array.from({ length: 9 }, (_, i) => row(0xa0 + i, "2", null)));
  const s19 = [Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const p = (await req.json()).params[0]; return Response.json(p.message === "getValidators" ? { result: 200, response: rows19 } : { result: 200, response: { minValidatorStake: "1" } }); } })];
  s19.push(Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const p = (await req.json()).params[0]; return Response.json(p.message === "getValidators" ? { result: 200, response: rows19 } : { result: 200, response: { minValidatorStake: "1" } }); } }));
  const r19 = await runValidatorRound({ seeds: s19.map((x, i) => ({ name: "s" + i, url: "http://127.0.0.1:" + x.port })), resolveOrigin: loopResolver, reference: ref(HEIGHT), history: createWatchHistory(3600000, 60000) });
  const w19 = publicValidatorWatch(r19, r19.roundAt, {});
  check("O1 one answer on a 19-row origin: 1 as listed, 18 other_key_shared on 1 origin; 9 no_address; one origin dialed carrying 19 rows",
    w19.watched === 28 && w19.answered_as_listed === 1 && w19.answered_other_key === 18 && w19.other_key_shared === 18 && w19.other_key_shared_origins === 1
    && w19.not_dialed_reasons.no_address === 9 && w19.origins_dialed === 1 && w19.max_rows_per_origin === 19, JSON.stringify(w19));
  check("O2 the rows add up: as listed + other key + no key + no answer + not dialed = ACTIVE", w19.answered_as_listed + w19.answered_other_key + w19.answered_no_key + w19.no_answer + w19.not_dialed === w19.watched);
  [one, ...s19].forEach((x) => x.stop(true));
}

console.log("\n[" + TAG + "] published origins and dialed addresses");
{
  // Two seeds serving a given list; a round over it with a given resolver.
  async function roundOver(list, resolveOrigin) {
    const ss = [0, 1].map(() => Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const p = (await req.json()).params[0];
      return Response.json(p.message === "getValidators" ? { result: 200, response: list } : { result: 200, response: { minValidatorStake: "1" } }); } }));
    const r = await runValidatorRound({ seeds: ss.map((x, i) => ({ name: "s" + i, url: "http://127.0.0.1:" + x.port })), resolveOrigin, reference: ref(HEIGHT), history: createWatchHistory(3600000, 60000) });
    ss.forEach((x) => x.stop(true));
    return publicValidatorWatch(r, r.roundAt, {});
  }
  let dials = 0;
  const one = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { dials++; return Response.json({ identity: KEY(0xc0), peerlist: [{ identity: KEY(0xc0), sync: { block: HEIGHT } }] }); } });
  const pinned = "http://127.0.0.1:" + one.port;
  // Two different published names that resolve to the same address: one dial, two published origins; the second row's
  // answer names a key that is not listed on its own published origin, so it is another key, not a shared origin.
  const names = async (u) => { const p = parseProbeOrigin(u); return p && p.protocol === "http:" && (p.hostname === "alpha.example" || p.hostname === "beta.example") ? pinned : loopResolver(u); };
  const w20 = await roundOver([row(0xc0, "2", "http://alpha.example:53550"), row(0xc1, "2", "http://beta.example:53550")], names);
  check("W20 two published names on one address: dialed once, two published origins, the second row is another key, not a shared origin",
    dials === 1 && w20.origins_dialed === 2 && w20.max_rows_per_origin === 1 && w20.answered_as_listed === 1 && w20.answered_other_key === 1 && w20.other_key_shared === 0 && w20.other_key_shared_origins === 0,
    JSON.stringify([dials, w20.origins_dialed, w20.max_rows_per_origin, w20.answered_other_key, w20.other_key_shared]));
  one.stop(true);
  // Three rows on one published origin that does not answer: three no answer, none shared.
  const w21 = await roundOver([row(0xc2, "2", closedUrl), row(0xc3, "2", closedUrl), row(0xc4, "2", closedUrl)], loopResolver);
  check("W21 a shared published origin that does not answer: every row there is no answer, none is counted as sharing",
    w21.no_answer === 3 && w21.other_key_shared === 0 && w21.origins_dialed === 1 && w21.max_rows_per_origin === 3, JSON.stringify([w21.no_answer, w21.other_key_shared, w21.origins_dialed]));
  // Three rows on one published origin that answers with a key none of them lists: three other key, none shared.
  const w22 = await roundOver([row(0xc5, "2", V.e.url), row(0xc6, "2", V.e.url), row(0xc7, "2", V.e.url)], loopResolver);
  check("W22 a shared published origin answering with an unlisted key: every row there is another key, none is counted as sharing",
    w22.answered_other_key === 3 && w22.other_key_shared === 0 && w22.other_key_shared_origins === 0, JSON.stringify([w22.answered_other_key, w22.other_key_shared]));
  // Two ACTIVE rows and one UNSTAKING row publish one origin, and it answers as the UNSTAKING key: that key is listed there,
  // so the two ACTIVE rows share a published origin with a key that answered. The UNSTAKING row is never counted as watched.
  const w23 = await roundOver([row(0xc8, "2", V.u.url), row(0xc9, "2", V.u.url), row(0x1e, "3", V.u.url)], loopResolver);
  check("W23 an origin answering as a listed key that is not ACTIVE: the ACTIVE rows there share it with a key that answered",
    w23.watched === 2 && w23.answered_other_key === 2 && w23.other_key_shared === 2 && w23.other_key_shared_origins === 1, JSON.stringify([w23.watched, w23.answered_other_key, w23.other_key_shared]));
}

console.log("\n[" + TAG + "] the sentence for readers without JavaScript");
{
  const oc = { state: "agreed", active: 35, seeds_agreed: 2, seeds_configured: 3, observed_at: "2026-09-29T11:31:45.000Z" };
  const w = { state: "observed", answered_as_listed: 7, at_seed_height: 7, every_round_last_hour: null, window: { minutes: 60, observed_minutes: 23 },
    other_key_shared: 18, other_key_shared_origins: 1, not_dialed_reasons: { no_address: 9 } };
  const s1 = validatorsSentence(oc, w);
  check("N1 the 29 Sep reading: the ladder's counts, the advisor's sentence, the rows with no address",
    s1 === "35 ACTIVE on chain, as 2 of 3 public seeds listed them at 11:31:45 UTC. Of these, 7 answered DNO as the listed key at the address each published, 7 at the seeds' height; every round in the last hour: insufficient observation (23 of 60 min). 18 listed keys share one published origin with a key that answered. That is not 18 nodes down. 9 ACTIVE rows publish no address on chain. Not in status.", s1);
  const s2 = validatorsSentence(oc, Object.assign({}, w, { other_key_shared: 1, other_key_shared_origins: 1, not_dialed_reasons: { no_address: 1 } }));
  const s3 = validatorsSentence(oc, Object.assign({}, w, { other_key_shared: 5, other_key_shared_origins: 2, not_dialed_reasons: { no_address: 0 } }));
  check("N2 one key, one row: singular forms; several origins: each with a key that answered",
    s2.includes(" 1 listed key shares one published origin with a key that answered. That is not a node down. 1 ACTIVE row publishes no address on chain.")
    && s3.includes(" 5 listed keys share 2 published origins, each with a key that answered. That is not 5 nodes down. Not in status.") && !/no address/.test(s3), s2 + " | " + s3);
  check("N3 no agreed list: no sentence; dials off: the list only", validatorsSentence(Object.assign({}, oc, { state: "not_agreed" }), w) === null
    && validatorsSentence(oc, { state: "disabled" }) === "35 ACTIVE on chain, as 2 of 3 public seeds listed them at 11:31:45 UTC. Not in status.");
}

console.log("\n[" + TAG + "] find a node: one key against the agreed list");
{
  const r = await round();
  const at = r.listAt;
  const k11 = listedStatus(r, KEY(0x11), at, {}), k1e = listedStatus(r, KEY(0x1e).toUpperCase().replace("0X", "0x"), at, {}), k25 = listedStatus(r, KEY(0x25), at, {}), k99 = listedStatus(r, KEY(0x99), at, {});
  check("F1 a key on the agreed list: ACTIVE, UNSTAKING, another status; a key not on it: not_listed (case-insensitive)",
    k11.status === "ACTIVE" && k1e.status === "UNSTAKING" && k25.status === "other" && k99.status === "not_listed" && k11.state === "agreed" && k11.seeds_agreed === 2, JSON.stringify([k11, k1e, k25, k99]));
  const stale = listedStatus(r, KEY(0x11), at + 10 * 60000, {});
  SEED.b = { list: BASE_ROWS.slice(0, 5), stake: "1" }; SEED.c = { list: BASE_ROWS.slice(0, 4), stake: "2" };
  const rd = await round();
  SEED.b = { list: BASE_ROWS, stake: "1000000000000" }; SEED.c = { list: BASE_ROWS.slice(0, 5), stake: "2000000000000" };
  const differ = listedStatus(rd, KEY(0x11), rd.listAt, {}), none = listedStatus(null, KEY(0x11), at, {}), bad = listedStatus(r, "0xzz", at, {});
  check("F2 no agreed or fresh list: no status, the list's own reason; a malformed key is not_listed",
    stale.status === null && stale.reason === "the last read is older than 300 s" && differ.status === null && /different validator lists/.test(differ.reason)
    && none.status === null && none.reason === "no read has completed yet" && bad.status === "not_listed", JSON.stringify([stale, differ, none, bad]));
  const txt = JSON.stringify([k11, k1e, k25, k99, stale, differ]);
  check("F3 the answer carries no key, URL, stake or time other than when the list was read", FORBIDDEN(txt).length === 0 && Object.keys(k11).sort().join(",") === "observed_at,reason,seeds_agreed,seeds_configured,state,status", FORBIDDEN(txt).join(" "));
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

console.log("\n[" + TAG + "] the first-agreed clock (DNO's clock)");
{
  const H = 3600000, D = 24 * H;
  const K = (n) => Array.from({ length: n }, (_, i) => "k" + i);
  const t0 = 1_800_000_000_000;
  let db = new Database(":memory:");
  let st = createFirstAgreedStore(db);
  let s0 = st.summary(t0);
  check("G1 empty store: no figure, and says why (T5)", s0.today === null && s0.week === null && s0.month === null && s0.since === null && s0.reason === "no agreed list with an ACTIVE key has been recorded yet", JSON.stringify(s0));
  st.record(t0, K(35));
  let s1 = st.summary(t0 + H);
  check("G2 the store's first list is a baseline: +today is not reported until the record covers 24 h, never +35", s1.today === null && s1.reason === "the record started less than 24 h ago" && st.size() === 35, JSON.stringify(s1));
  // one round a minute for the next 25 hours, same list (rounds are sparse here: the rule only looks at the round before)
  for (let t = t0 + 60000; t <= t0 + 25 * H; t += 30 * 60000) st.record(t, K(35));
  const tA = t0 + 25 * H;
  let s2 = st.summary(tA);
  check("G3 warm store, no new key: +today 0, not null (T1); +week not yet", s2.today === 0 && s2.week === null && s2.reason === "the record started less than 7 days ago", JSON.stringify(s2));
  st.record(tA + 60000, K(35).concat(["new1"]));
  let s3 = st.summary(tA + 60000);
  check("G4 one new ACTIVE key on an agreed list: +today 1 (T2)", s3.today === 1, JSON.stringify(s3));
  // restart: a new store on the same database
  const st2 = createFirstAgreedStore(db);
  check("G5 a restart keeps the figures (T4)", JSON.stringify(st2.summary(tA + 60000)) === JSON.stringify(s3) && st2.size() === 36);
  // a 3 h gap inside the window: keys first seen after it still count, the list before the gap being inside the window
  st2.record(tA + 3 * H, K(35).concat(["new1", "gap1"]));
  check("G6 a key first seen after a gap inside the window counts", st2.summary(tA + 3 * H).today === 2, JSON.stringify(st2.summary(tA + 3 * H)));
  // a 30 h gap that crosses the start of the day: the key's join time is not known, so +today has no figure
  st2.record(tA + 33 * H, K(35).concat(["new1", "gap1", "gap2"]));
  const s4 = st2.summary(tA + 33 * H);
  check("G7 a gap across the start of the window: no figure for that window, and says why", s4.today === null && s4.reason === "a gap in the record crosses the start of the last 24 h", JSON.stringify(s4));
  // keys that later leave ACTIVE still count where they first appeared
  st2.record(tA + 33 * H + 60000, K(35));
  const dbx = new Database(":memory:"), stx = createFirstAgreedStore(dbx);
  for (let t = t0; t <= tA; t += 30 * 60000) stx.record(t, K(3));
  stx.record(tA + 60000, K(3).concat(["x1"]));
  stx.record(tA + 120000, K(3));
  check("G8 not net of exits: a key that left ACTIVE still counts where it first appeared", stx.summary(tA + 120000).today === 1 && stx.size() === 4, JSON.stringify(stx.summary(tA + 120000)));
  // after 31 days of record, the baseline 35 are never new: +month counts only the keys added after the first list
  let tB = t0 + 31 * D;
  for (let t = tA + 34 * H; t <= tB; t += 50 * 60000) st2.record(t, K(35));
  const s6 = st2.summary(tB);
  check("G9 the store's first list never counts, even a month later: +month 3 (new1, gap1, gap2), +week 0, +today 0", s6.month === 3 && s6.week === 0 && s6.today === 0 && s6.reason === null, JSON.stringify(s6));
  // a write that fails leaves memory unchanged and every figure empty
  const db3 = new Database(":memory:"), st3 = createFirstAgreedStore(db3);
  st3.record(t0, K(3));
  db3.run("DROP TABLE validator_first_agreed");
  const ok3 = st3.record(t0 + 60000, K(4));
  const s7 = st3.summary(t0 + 60000);
  check("G10 a failed write: nothing recorded in memory, every figure null, and says why", ok3 === false && st3.size() === 3 && s7.today === null && s7.month === null && s7.reason === "the store could not record this round's list", JSON.stringify(s7));
  // A write that fails once (a busy database): the figures come back with the next write that succeeds, and the key the
  // failed write missed counts from the list that recorded it.
  const real = new Database(":memory:");
  let failNext = false;
  const flaky = { run: (...a) => real.run(...a), query: (...a) => real.query(...a), transaction: (fn) => real.transaction(fn),
    prepare: (...a) => { if (failNext) throw new Error("database is locked"); return real.prepare(...a); } };
  const st5 = createFirstAgreedStore(flaky);
  for (let t = t0; t <= tA; t += 30 * 60000) st5.record(t, K(3));
  failNext = true;
  const okA = st5.record(tA + 60000, K(3).concat(["late1"])), sA = st5.summary(tA + 60000);
  failNext = false;
  const okB = st5.record(tA + 120000, K(3).concat(["late1"])), sB = st5.summary(tA + 120000);
  check("G10b a write that fails once: no figure while it fails, then +today 1 from the next list that is recorded", okA === false && sA.today === null && sA.reason === "the store could not record this round's list"
    && okB === true && sB.today === 1 && sB.reason === "the record started less than 7 days ago" && st5.size() === 4, JSON.stringify([sA, sB]));
  const cantOpen = createFirstAgreedStore({ run: () => { throw new Error("disk I/O error"); } });
  check("G10c a store that cannot be opened: every figure null, nothing recorded, and says why", cantOpen.record(t0, K(3)) === false && cantOpen.size() === 0 && cantOpen.summary(t0).reason === "the store is not available on this server");
  check("G11 no database: every figure null, and says why", createFirstAgreedStore(null).summary(t0).reason === "no store is configured on this server");
  // An agreed list with no ACTIVE key does not start the record: the next list's keys are the baseline, never +35.
  const st6 = createFirstAgreedStore(new Database(":memory:"));
  st6.record(t0, []);
  const s8 = st6.summary(t0 + 1000);
  for (let t = t0 + 60000; t <= t0 + 25 * H; t += 30 * 60000) st6.record(t, K(35));
  const s9 = st6.summary(t0 + 60000 + 24 * H);
  check("G15 an empty first list does not start the record; the first list with keys is the baseline (+0, never +35)",
    s8.since === null && s8.reason === "no agreed list with an ACTIVE key has been recorded yet" && s9.today === 0 && s9.since === t0 + 60000, JSON.stringify([s8, s9]));
  // The boundary: a record that started exactly at the start of the window covers it.
  const st7 = createFirstAgreedStore(new Database(":memory:"));
  for (let t = t0; t <= t0 + D; t += 30 * 60000) st7.record(t, K(3));
  check("G16 a record that started exactly 24 h ago covers the day: +today 0", st7.summary(t0 + D).today === 0, JSON.stringify(st7.summary(t0 + D)));
  // A gap that crosses the start of the week but not of the day: the week has no figure, the day does.
  const st8 = createFirstAgreedStore(new Database(":memory:"));
  for (let t = t0; t <= t0 + 2 * D; t += 30 * 60000) st8.record(t, K(3));
  const tG = t0 + 2 * D + 5 * D;                                 // five days without an agreed list
  st8.record(tG, K(3).concat(["late"]));
  for (let t = tG + 30 * 60000; t <= tG + 3 * D; t += 30 * 60000) st8.record(t, K(3).concat(["late"]));
  const s10 = st8.summary(tG + 3 * D);                         // the week now starts a day after the list before the gap
  check("G17 a gap across the start of the last 7 days only: +today 0, +week null with the reason, +month null (record under 30 days)",
    s10.today === 0 && s10.week === null && s10.month === null && s10.reason === "a gap in the record crosses the start of the last 7 days", JSON.stringify(s10));
  // Agreed lists with no ACTIVE key are not coverage: three days of them, then five keys never seen, is a gap across the
  // day's start, not "+5 today".
  const st9 = createFirstAgreedStore(new Database(":memory:"));
  for (let t = t0; t <= t0 + 2 * D; t += 30 * 60000) st9.record(t, K(35));
  for (let t = t0 + 2 * D + 30 * 60000; t <= t0 + 5 * D; t += 30 * 60000) st9.record(t, []);
  st9.record(t0 + 5 * D + 60000, K(35).concat(["n1", "n2", "n3", "n4", "n5"]));
  const s11 = st9.summary(t0 + 5 * D + 60000);
  check("G18 a stretch of agreed lists with no ACTIVE key is a gap, not coverage: +today null with the reason, never +5",
    s11.today === null && s11.reason === "a gap in the record crosses the start of the last 24 h", JSON.stringify(s11));

  // Through a round: figures only while the list agrees; no key, URL or protocol time in what is published (T3, T6).
  const gdb = new Database(":memory:"), gst = createFirstAgreedStore(gdb);
  let clock = 1_900_000_000_000;
  const rg1 = await round({ growth: gst, now: () => clock });
  const og1 = publicOnChainValidators(rg1, rg1.listAt, {});
  check("G12 a round records the agreed ACTIVE keys; the first list is a baseline", gst.size() === 19 && og1.first_agreed_today === null && og1.first_agreed_reason === "the record started less than 24 h ago" && og1.first_agreed_since === new Date(clock).toISOString() && og1.first_agreed_as_of === new Date(clock).toISOString(), JSON.stringify(og1));
  SEED.b = { list: BASE_ROWS.slice(0, 5), stake: "1000000000000" }; SEED.c = { list: BASE_ROWS.slice(0, 4), stake: "1000000000000" };
  clock += 60000;
  const rg2 = await round({ growth: gst, now: () => clock });
  const og2 = publicOnChainValidators(rg2, rg2.listAt, {});
  check("G13 seeds disagree: every first-agreed figure null, nothing recorded, the list's own reason (T3)", og2.state === "not_agreed" && og2.first_agreed_today === null && og2.first_agreed_week === null && og2.first_agreed_as_of === null && gst.size() === 19
    && og2.first_agreed_reason === og2.reason && publicOnChainValidators(null, clock, {}).first_agreed_reason === "no read has completed yet"
    && publicOnChainValidators(rg2, rg2.listAt + 10 * 60000, {}).first_agreed_reason === "the last read is older than 300 s", JSON.stringify(og2));
  SEED.b = { list: BASE_ROWS, stake: "1000000000000" }; SEED.c = { list: BASE_ROWS.slice(0, 5), stake: "2000000000000" };
  const txt = JSON.stringify([og1, og2]);
  check("G14 no key, URL, protocol time or stake in what is published (T6)", FORBIDDEN(txt).length === 0 && !/firstSeen|validAt|stakedAmount|first_seen/.test(txt), FORBIDDEN(txt).join(" "));
}

console.log("\n[" + TAG + "] the dial switch");
{
  // As the value reaches the code: the agent's own .env reader keeps quotes and a trailing comment, the runtime's does not.
  const off = ["0", " 0 ", '"0"', "'0'", "`0`", "0 # no dials on this host", "0#off", '"0" # no dials', "false", "FALSE", "off", "Off", "no", '"off"', "off#x"];
  const on = [undefined, null, "", "1", "true", "on", "yes", "00", "0x", "#0", '"1"', '"1#0"', "1 # 0"];
  check("D1 0, false, off and no switch the dials off, also in quotes of any kind, in another case or with a trailing comment (with or without a space)", off.every((v) => dialsEnabled(v) === false), JSON.stringify(off.filter((v) => dialsEnabled(v) !== false)));
  check("D2 nothing set, or anything else, leaves them on", on.every((v) => dialsEnabled(v) === true), JSON.stringify(on.filter((v) => dialsEnabled(v) !== true)));
  // The agent's .env reader, as written in agent.mjs: the value keeps its quotes. The switch must still be read as off.
  const AGENT = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8"), PRE = readFileSync(new URL("../tools/pre-restart-check.mjs", import.meta.url), "utf8");
  const envLine = AGENT.split("\n").find((l) => l.includes('readFileSync(".env","utf8")')) || "";
  const parse = (text) => { const env = {}; text.split("\n").forEach(function(line) { var m = line.match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim(); }); return env; };
  check("D3 a quoted 0 in .env, read as the agent reads .env, is off", envLine.includes("line.match(/^([^#=]+)=(.*)$/)") && envLine.includes("process.env[m[1].trim()] = m[2].trim()")
    && parse('VALIDATOR_WATCH_DIALS="0"').VALIDATOR_WATCH_DIALS === '"0"' && dialsEnabled(parse('VALIDATOR_WATCH_DIALS="0"').VALIDATOR_WATCH_DIALS) === false
    && dialsEnabled(parse("VALIDATOR_WATCH_DIALS=0 # off").VALIDATOR_WATCH_DIALS) === false, envLine.slice(0, 160));
  check("D4 the agent and the pre-restart check read the switch with this function, and neither compares it to \"0\" itself",
    AGENT.includes("const VALIDATOR_WATCH_DIALS = dialsEnabled(process.env.VALIDATOR_WATCH_DIALS);") && PRE.includes("const dials = dialsEnabled(process.env.VALIDATOR_WATCH_DIALS);")
    && !/VALIDATOR_WATCH_DIALS\s*[!=]==/.test(AGENT + PRE));
}

Object.values(V).concat([trap]).forEach((v) => v.srv.stop(true));
Object.values(S).forEach((s) => s.srv.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
