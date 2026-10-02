// validator-set-probe.test.mjs — VALIDATOR_SET_PROBE guard: the named test's tool reads what it should and prints
// nothing it must not. Runs tools/validator-set-probe.mjs against local synthetic seeds (Bun.serve on loopback).
// Rules under test: the SDK's nodeCall wire format; counts by status; a value only when at least two seeds report it
// and all that report it agree; no host, address, connectionUrl, stake or full key in the output; unexpected shapes
// are reported and make the tool exit non-zero.
// Run: bun src/validator-set-probe.test.mjs   (executable harness, not `bun test`)

import { probeSeed, formatReport, summarize, seedsFromAgent, dialReport, firstSeenAgreement, firstSeenValue, agentSeedReads, agentSeedLine, agentReadsReport, agentRpcReads, agentVerdict, seedsForRound, seedsUnread, run } from "../tools/validator-set-probe.mjs";
import { parseProbeOrigin } from "./public-safety.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TAG = "VALIDATOR_SET_PROBE";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

// Synthetic values only (documentation ranges for addresses).
const ADDR = (b) => "0x" + b.repeat(32);
const ROW = (i, status) => ({ address: ADDR(("b" + (i % 10)).slice(0, 2)), status, connectionUrl: "http://203.0.113." + (i + 1) + ":53550", stakedAmount: "123456789" + i, firstSeen: 1, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null });
const INFO = { identity: ADDR("aa"), version: "0.9.9 RC", version_name: "Test", peerlist: [{ identity: ADDR("ab"), connection: { string: "http://198.51.100.9:53550" }, status: { online: true, ready: true }, sync: { block: 12345, status: "synced" } }] };
const calls = [];
function seedServer(opts) {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/info") return Response.json(INFO);
    if (req.method === "POST" && u.pathname === "/") {
      const body = await req.json();
      const p = body && Array.isArray(body.params) ? body.params[0] : null;
      calls.push({ method: body.method, type: p && p.type, message: p && p.message, identityHeader: req.headers.get("identity") });
      if (body.method !== "nodeCall" || !p || p.type !== "nodeCall") return Response.json({ result: 400, response: "bad request" });
      if (p.message === "getNetworkParameters") return Response.json({ result: 200, response: { minValidatorStake: opts.stake, shardSize: 4, blockTimeMs: 10000, networkFee: 0, rpcFee: 0, additionalFee: 0 } });
      if (p.message === "getValidators") return Response.json(opts.badRows ? { result: 200, response: "not a list" } : { result: 200, response: opts.rows });
      return Response.json({ result: 404, response: "unknown nodeCall" });
    }
    return new Response("nf", { status: 404 });
  } });
}
const rows6 = [ROW(0, "2"), ROW(1, "2"), ROW(2, "2"), ROW(3, "2"), ROW(4, "2"), ROW(5, "3")];
const A = seedServer({ stake: "1000000000000000000", rows: rows6 });
const B = seedServer({ stake: "1000000000000000000", rows: rows6 });
const C = seedServer({ stake: "2000000000000000000", rows: rows6.slice(0, 4) });
const E = seedServer({ stake: "1000000000000000000", badRows: true });
const url = (s) => "http://127.0.0.1:" + s.port;
const FORBIDDEN = [/203\.0\.113\./, /198\.51\.100\./, /127\.0\.0\.1/, /0x[0-9a-f]{64}/i, /123456789\d/, /53550/];
const leaks = (text) => FORBIDDEN.filter((re) => re.test(text)).map(String);

console.log("\n[" + TAG + "] two seeds that agree");
{
  const rs = [await probeSeed({ name: "seed-a", url: url(A) }), await probeSeed({ name: "seed-b", url: url(B) })];
  const { text, summary } = formatReport(rs, new Date(0));
  check("P1 nodeCalls use the SDK wire format, unauthenticated", calls.length >= 4 && calls.every((c) => c.method === "nodeCall" && c.type === "nodeCall" && !c.identityHeader) && calls.some((c) => c.message === "getValidators") && calls.some((c) => c.message === "getNetworkParameters"), JSON.stringify(calls.slice(0, 2)));
  check("P2 counts by status, the parameter as reported, agreement", summary.stake === "1000000000000000000" && JSON.stringify(summary.rows) === JSON.stringify({ 2: 5, 3: 1 }) && /agree: ACTIVE 5, UNSTAKING 1/.test(text) && /agrees: 1000000000000000000 \(raw, as reported\)/.test(text), text);
  check("P3 /info key names only", text.includes("keys: identity, peerlist, version, version_name") && text.includes("peerlist entry keys: connection{string}, identity, status{online, ready}, sync{block, status}") && text.includes("a key naming a hash: no · a key naming a shard: no"), text);
  check("P4 no host, address, connectionUrl, stake or full key in the output", leaks(text).length === 0, leaks(text).join(" "));
  check("P5 the EXITED limit is stated", /EXITED count does not come from it/.test(text));
}

console.log("\n[" + TAG + "] disagreement, a silent seed, an unexpected shape");
{
  const rs = [await probeSeed({ name: "seed-a", url: url(A) }), await probeSeed({ name: "seed-b", url: url(B) }), await probeSeed({ name: "seed-c", url: url(C) })];
  const { text, summary } = formatReport(rs);
  check("D1 seeds that differ: neither value is printed", summary.stake === null && summary.rows === null && /differs between seeds: not reported/.test(text) && /differ between seeds: not reported/.test(text), text);
  check("D2 the block stays 'not reported'", text.includes('"on-chain validator rows: not reported."'));
  const down = await probeSeed({ name: "seed-d", url: "http://127.0.0.1:1" });
  check("D3 a seed that does not answer says so", down.info.answered === false && down.params.answered === false && down.validators.answered === false && formatReport([down]).text.includes("no answer"), JSON.stringify(down));
  const one = formatReport([await probeSeed({ name: "seed-a", url: url(A) }), down]);
  check("D4 one answering seed is not enough", one.summary.stake === null && /fewer than two answers/.test(one.text));
  const bad = await probeSeed({ name: "seed-e", url: url(E) });
  const s = summarize([bad]);
  check("D5 an unexpected shape is reported (the tool exits 2)", bad.validators.shapeOk === false && s.shapeErrors.length === 1 && formatReport([bad]).text.includes("Unexpected shapes:"), JSON.stringify(s.shapeErrors));
}

console.log("\n[" + TAG + "] seeds come from the agent's configuration");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "agent.mjs"), "utf8");
  const seeds = seedsFromAgent(src);
  check("S1 the three configured seeds, by name", seeds.map((s) => s.name).join(",") === "kyne-node2,kyne-node3,kyne-node3b" && seeds.every((s) => /^https?:\/\//.test(s.url)), seeds.map((s) => s.name).join(","));
  check("S1b each with its configured identity (compared with the answer by the pre-restart check, never printed)", seeds.every((s) => /^0x[0-9a-fA-F]{64}$/.test(s.identity)) && new Set(seeds.map((s) => s.identity)).size === 3);
  // A configuration the tool cannot read in full is an error for the pre-restart check, not a shorter list of seeds.
  const a0 = src.indexOf("const PUBLIC_NODES = {"), a1 = src.indexOf("};", a0), block = src.slice(a0, a1);
  const noId = src.slice(0, a0) + block.replace(/identity:\s*"0x[0-9a-fA-F]+"/, 'identity: SOME_CONSTANT') + src.slice(a1);
  const nested = src.slice(0, a0) + block.replace(/url:\s*"[^"]+"/, 'extra: { a: 1 }, $&') + src.slice(a1);
  check("S1c every configured seed is read; an entry without a literal identity, or one the pattern cannot take in, is reported",
    seedsUnread(src, seeds) === null && /configures 3 seeds; 2 could be read/.test(seedsUnread(noId, seedsFromAgent(noId)) || "") && /configures 3 seeds; 2 could be read/.test(seedsUnread(nested, seedsFromAgent(nested)) || ""),
    JSON.stringify([seedsUnread(src, seeds), seedsUnread(noId, seedsFromAgent(noId)), seedsUnread(nested, seedsFromAgent(nested))]));
  // A commented-out entry is not a seed of the agent; an entry whose url is not a string literal, or whose name the
  // pattern does not take, is reported, not skipped.
  const entry = block.match(/"kyne-node3b":\s*\{[^}]*\},?/)[0];
  const commented = src.slice(0, a0) + block.replace(entry, entry.split("\n").map((l) => "  // " + l.trim()).join("\n")) + src.slice(a1);
  const computed = src.slice(0, a0) + block.replace(/url:\s*"[^"]+"/, 'url: BASE + "/x"') + src.slice(a1);
  const oddName = src.slice(0, a0) + block.replace('"kyne-node3":', '"Kyne_Node3":') + src.slice(a1);
  check("S1d a commented-out entry is not read and not counted; a url that is not a string literal, or a name the pattern does not take, is reported",
    seedsFromAgent(commented).map((x) => x.name).join() === "kyne-node2,kyne-node3" && seedsUnread(commented, seedsFromAgent(commented)) === null
    && /configures 3 seeds; 2 could be read/.test(seedsUnread(computed, seedsFromAgent(computed)) || "") && /configures 3 seeds; 2 could be read/.test(seedsUnread(oddName, seedsFromAgent(oddName)) || ""),
    JSON.stringify([seedsFromAgent(commented).map((x) => x.name), seedsUnread(commented, seedsFromAgent(commented)), seedsUnread(computed, seedsFromAgent(computed)), seedsUnread(oddName, seedsFromAgent(oddName))]));
}

console.log("\n[" + TAG + "] --dial: one watch round with the agent's module");
{
  const VKEY = "0x" + "c1".repeat(32);
  const val = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: VKEY, version: "0.9.9 RC", peerlist: [{ identity: VKEY, sync: { block: 12346 } }] }); } });
  const vrows = [
    { address: VKEY, status: "2", connectionUrl: "http://127.0.0.1:" + val.port, stakedAmount: "5555555555", firstSeen: 12000, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null },
    { address: ADDR("d2"), status: "2", connectionUrl: "http://203.0.113.7:53550", stakedAmount: "5555555555", firstSeen: 12001, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null }];
  const dialSeed = (id) => Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/info") return Response.json({ identity: id, version: "0.9.9 RC", peerlist: [{ identity: id, sync: { block: 12345 } }] });
    const p = (await req.json()).params[0];
    if (p.message === "getValidators") return Response.json({ result: 200, response: vrows });
    if (p.message === "getNetworkParameters") return Response.json({ result: 200, response: { minValidatorStake: "1000000000000" } });
    return Response.json({ result: 404, response: null });
  } });
  const D1 = dialSeed(ADDR("e1")), D2 = dialSeed(ADDR("e2"));
  const seeds = [{ name: "seed-a", url: url(D1) }, { name: "seed-b", url: url(D2) }];
  const results = [await probeSeed(seeds[0]), await probeSeed(seeds[1])];
  const loop = async (u) => { const x = new URL(u); return x.protocol === "http:" && x.hostname === "127.0.0.1" && x.pathname === "/" ? x.origin : null; };
  const rep = await dialReport(seeds, results, { resolveOrigin: loop });
  check("X1 --dial: the agreed list, the seeds' median and the watch counts the agent would publish", rep.onChain.active === 2 && rep.watch.answered_as_listed === 1 && rep.watch.at_seed_height === 1
    && rep.watch.not_dialed === 1 && /seeds' median: 12345 \(from 2 own heights\)/.test(rep.text) && /answered as the listed key 1 \(Path A seed keys among them: 0\): at the seeds' height \(±25\) 1/.test(rep.text) && /on 1 origin \(most rows on one origin: 1\)/.test(rep.text) && /not from one run/.test(rep.text), rep.text);
  check("X2 --dial prints no host, address, connectionUrl, port or stake", leaks(rep.text).length === 0 && !rep.text.includes(String(val.port)) && !/5555555555/.test(rep.text), leaks(rep.text).join(" "));
  const plain = formatReport(results, new Date(0)).text;
  check("X4 firstSeen: whether two seeds agree and what the values look like, counts only", /firstSeen on ACTIVE rows: two or more seeds agree on 2 of 2 \(missing 0 · differ 0\); agreed values look like block heights 2 · millisecond times 0 · second times 0 · date strings 0 · other 0 \(values not printed\)/.test(plain)
    && !/12000|12001/.test(plain), plain.split("\n").filter((l) => /firstSeen/.test(l)).join(" | "));
  // The list's rule for firstSeen too: two of three seeds holding the same value agree; digits in a string are a number.
  const fsRows = (vals) => ({ validators: { firstSeen: new Map(Object.entries(vals).map(([k, v]) => [k, firstSeenValue(v)])) } });
  const agree3 = firstSeenAgreement([fsRows({ a: 12000, b: "1759140000000", c: null, d: "2026-09-01T10:00:00Z" }), fsRows({ a: 12000, b: 1759140000000, c: null, d: "2026-09-01T10:00:00Z" }),
    fsRows({ a: 12999, b: 1759140000000, c: 5, d: "2026-09-02T10:00:00Z" })], [{ info: { answered: true, ownHeight: 13000 } }]);
  check("X6 firstSeen: two of three seeds agreeing is agreement; a digit string is a number; a date string is a date; one value is missing, not a disagreement",
    JSON.stringify(agree3) === JSON.stringify({ active: 4, agreed: 3, missing: 1, differ: 0, heights: 1, ms: 1, seconds: 0, dates: 1, other: 0 }), JSON.stringify(agree3));
  // T-R2 and T-R3: a candidate seed with another list, and a seed that answers with another seed's identity.
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/info") return Response.json({ identity: ADDR("e1"), version: "0.9.9 RC", peerlist: [{ identity: ADDR("e1"), sync: { block: 12345 } }] });
    const p = (await req.json()).params[0];
    if (p.message === "getValidators") return Response.json({ result: 200, response: vrows.slice(0, 1) });
    return Response.json({ result: 200, response: { minValidatorStake: "1000000000000" } });
  } });
  const withCandidate = results.concat([await probeSeed({ name: "candidate", url: url(other) }), await probeSeed({ name: "silent", url: "http://127.0.0.1:1" })]);
  const t2 = formatReport(withCandidate, new Date(0)).text;
  check("X7 the Path A candidate tests: the same list from two seeds, another list from the candidate, none from a silent seed (T-R2); a shared identity named by seed names, never printed (T-R3)",
    t2.includes("getValidators lists, address and status of every row: the same list from seed-a, seed-b · another list from candidate · no list from silent")
    && t2.includes("/info identities: seed-a and candidate answered with the same identity (one vantage, not 2) (not printed)")
    && formatReport(results, new Date(0)).text.includes("/info identities: each of the 2 seeds that answered with an identity has its own (not printed)")
    && !/e1e1|e2e2/i.test(t2), t2.split("\n").filter((l) => /lists, address|identities/.test(l)).join(" | "));
  // A tie between the two largest groups is no agreement, and the line says so; a list the agent would not accept is not
  // "no list", and it is an unexpected shape; an /info answer without an identity is named, not counted as a vantage.
  const seedOf = (id, list) => Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/info") return Response.json(id ? { identity: id, peerlist: [] } : { peerlist: [] });
    const p = (await req.json()).params[0];
    return Response.json(p.message === "getValidators" ? { result: 200, response: list } : { result: 200, response: { minValidatorStake: "1" } });
  } });
  const L1 = vrows, L2 = vrows.slice(0, 1), BAD = [{ status: "2", connectionUrl: null }];
  const T = [seedOf(ADDR("f1"), L1), seedOf(ADDR("f2"), L1), seedOf(ADDR("f3"), L2), seedOf(ADDR("f4"), L2), seedOf(null, BAD)];
  const tres = [];
  for (const [i, x] of T.entries()) tres.push(await probeSeed({ name: ["a", "b", "c", "cand", "odd"][i], url: url(x) }));
  const t3 = formatReport(tres, new Date(0));
  check("X8 a two-two tie is no agreement and says so; a list the agent would not accept is named and is an unexpected shape; an answer without an identity is named",
    t3.text.includes("getValidators lists, address and status of every row: a tie, no single largest group (a, b / c, cand): the agent publishes no figure · a list the agent would not accept from odd")
    && t3.text.includes("/info identities: each of the 4 seeds that answered with an identity has its own · an answer without an identity from odd (not printed)")
    && /odd: getValidators: a row without a usable address or status/.test(t3.text), t3.text.split("\n").filter((l) => /lists, address|identities|odd:/.test(l)).join(" | "));
  T.forEach((x) => x.stop(true));
  other.stop(true);
  const { spawnSync } = await import("node:child_process");
  const bad = spawnSync("bun", [join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "validator-set-probe.mjs"), "--dail"], { encoding: "utf8" });
  check("X5 an argument that is not name=url (a mistyped flag) stops the tool with usage, exit 64", bad.status === 64 && /Not a name=url pair: --dail/.test(bad.stderr) && !/--dia\n/.test(bad.stdout), JSON.stringify([bad.status, bad.stderr.slice(0, 80)]));
  const prod = await dialReport(seeds, results);
  check("X3 --dial with the agent's resolver dials no loopback address, seeds included", prod.watch.state === "no_agreed_list" && /no figure/.test(prod.text), prod.text);
  [D1, D2, val].forEach((s) => s.stop(true));
}

console.log("\n[" + TAG + "] the pre-restart check: the agent's own seed read, its own rule, and a verdict");
{
  // Seeds as the agent needs them: /info names the seed's key and lists it with its own height; nodeCalls as above.
  const K = (b) => "0x" + b.repeat(32);
  const dialHits = { n: 0 };
  const val = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { dialHits.n++; return Response.json({ identity: K("c7"), peerlist: [{ identity: K("c7"), sync: { block: 7001 } }] }); } });
  const vrows = (extra) => [{ address: K("c7"), status: "2", connectionUrl: "http://127.0.0.1:" + val.port, stakedAmount: "1", firstSeen: 1, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null }].concat(extra || []);
  const agentSeed = (key, o = {}) => Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (o.status) return new Response("busy", { status: o.status });
    if (req.method === "GET") {
      return Response.json({ identity: o.names || key, version: "0.9.9 RC", peerlist: [{ identity: K("ee"), sync: { block: 6960 } }].concat(o.noSelf ? [] : [{ identity: key, sync: { block: 7000 } }]) });
    }
    const msg = (await req.json()).params[0].message;
    return Response.json({ result: 200, response: msg === "getValidators" ? vrows(o.extraRow ? [{ address: K("d9"), status: "2", connectionUrl: null, stakedAmount: "1", firstSeen: 1, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null }] : []) : { minValidatorStake: "1000" } });
  } });
  const G1 = agentSeed(K("a1")), G2 = agentSeed(K("a2")), NOSELF = agentSeed(K("a3"), { noSelf: true }), OTHERKEY = agentSeed(K("a4"), { names: K("a9") }), DOWN = agentSeed(K("a5"), { status: 503 }), DIFF = agentSeed(K("a6"), { extraRow: true });
  const cfg = (name, srv, key) => ({ name, url: url(srv), identity: key });
  // The global fetch is replaced the way the Demos SDK's import replaces it: the agent's read must not use it.
  const realGlobal = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the global fetch must not be used for the agent's read"); };
  const reads = await agentSeedReads([cfg("seed-a", G1, K("a1")), cfg("seed-b", G2, K("a2")), cfg("seed-noself", NOSELF, K("a3")), cfg("seed-otherkey", OTHERKEY, K("a4")), cfg("seed-down", DOWN, K("a5")), { name: "seed-gone", url: "http://127.0.0.1:1", identity: K("a7") }]);
  const named = await agentSeedReads([{ name: "by-url", url: url(G1) + "/" }]);
  const rpcs = await agentRpcReads([{ name: "fleet-secret-name", url: url(G1) + "/info" }, { name: "fleet-other-name", url: url(DOWN) + "/info" }, { name: "x", url: "http://127.0.0.1:1" }, { name: "y", url: url(DOWN) + "/info" }]);
  globalThis.fetch = realGlobal;
  const lines = reads.map(agentSeedLine);
  check("G1 the agent's seed read works while the global fetch throws; each seed is read against its configured identity",
    reads[0].ok && reads[0].height_source === "self" && reads[0].block === 7000 && reads[1].height_source === "self" && reads[2].height_source === "first_peer" && reads[3].identityMatch === false && reads[3].block === null
    && reads[4].error === "HTTP 503" && reads[5].error === "connection failed", JSON.stringify(reads.map((r) => [r.name, r.ok, r.height_source, r.error])));
  check("G2 one line per seed: a name and words", lines.join(" | ") === ["seed-a  answered · names the configured key · its own height", "seed-b  answered · names the configured key · its own height",
    "seed-noself  answered · names the configured key · does not list itself: its first listed peer's height, which is not counted", "seed-otherkey  answered · names another key: no height is taken from it · no height",
    "seed-down  no answer (HTTP 503)", "seed-gone  no answer (connection failed)"].join(" | "), lines.join(" | "));
  check("G3 a seed given as name=url is read against the key it names itself", named[0].ok && named[0].height_source === "self" && named[0].identityMatch === true);
  check("G4 cross-check RPCs: a count and categories, never a name", JSON.stringify(rpcs) === JSON.stringify({ total: 4, ok: 1, failed: ["2 HTTP 503", "1 connection failed"] }) && (await agentRpcReads([])) === null && (await agentRpcReads(null)) === null, JSON.stringify(rpcs));
  const rep = agentReadsReport(reads, true, rpcs);
  check("G5 the report: the runtime's version, the SDK line, the counts the agent's rule uses, the RPC count; no host, key or fleet name",
    rep.text.includes("bun " + Bun.version + " · the Demos SDK was loaded first, as in the agent; it replaced the global fetch") && rep.text.includes("4 of 6 seeds answered; 2 gave their own height. The agent needs two for a status.")
    && rep.text.includes("cross-check RPCs (not in status), the agent's capped read: 1 of 4 answered (2 HTTP 503 · 1 connection failed)") && rep.sufficient === true && leaks(rep.text).length === 0 && !/fleet-secret-name|fleet-other-name/.test(rep.text), rep.text);

  const own = { ok: true, block: 7000, height_source: "self" }, fp = { ok: true, block: 6960, height_source: "first_peer" }, no = { ok: false, error: "HTTP 503" };
  const v = (r, list, shape) => { const x = agentVerdict(r, list, shape || 0); return x.code + " " + x.text; };
  check("V1 two own heights and an agreed list: OK, exit 0", v([own, own, no], "agreed") === "0 AGENT READS OK: 2 of 3 seeds gave their own height, and two seeds agree on the validator list.");
  check("V2 one seed answered: FAILED, exit 3", v([own, no, no], "agreed") === "3 AGENT READS FAILED: 1 of 3 seeds answered /info, and the agent needs two. Do not restart on this.");
  check("V3 two answered but one own height: FAILED, exit 3 (the agent would publish unknown)", v([own, fp, no], "agreed") === "3 AGENT READS FAILED: 1 of the 2 seeds that answered gave its own height, and the agent needs two. Do not restart on this.");
  check("V4 no seed lists itself: FAILED", v([fp, fp, fp], "agreed") === "3 AGENT READS FAILED: 0 of the 3 seeds that answered gave their own height, and the agent needs two. Do not restart on this.");
  check("V5 the list is not agreed: FAILED, exit 3", v([own, own, own], "not_agreed") === "3 AGENT READS FAILED: no validator list was agreed by two seeds. Do not restart on this.");
  check("V6 only an unexpected answer shape: FAILED, exit 2, never OK", v([own, own, no], "agreed", 1) === "2 AGENT READS FAILED: an answer had an unexpected shape (see above). Do not restart on this.");
  check("V7 several problems: all named, exit 3", v([own, no, no], "stale", 2) === "3 AGENT READS FAILED: 1 of 3 seeds answered /info, and the agent needs two; no validator list was agreed by two seeds; an answer had an unexpected shape (see above). Do not restart on this.");
  check("V8 no list read: the seeds alone", v([own, own], null) === "0 AGENT READS OK: 2 of 2 seeds gave their own height.");

  // run(): the whole check, as tools/pre-restart-check.mjs calls it. Loopback seeds need a resolver that admits them.
  const loop = async (u) => { const p = parseProbeOrigin(u); return p && p.hostname === "127.0.0.1" ? "http://127.0.0.1:" + p.port : null; };
  const runOut = async (args, ctx) => { const out = [], log = console.log; console.log = (...a) => out.push(a.join(" ")); let code; try { code = await run(args, Object.assign({ agentReads: true, sdkReplaced: true, resolveOrigin: loop }, ctx)); } finally { console.log = log; } return { code, text: out.join("\n") }; };
  const pair = (a, b) => ["seed-a=" + url(a), "seed-b=" + url(b)];
  dialHits.n = 0;
  const good = await runOut(["--dial", ...pair(G1, G2)]);
  check("W1 two good seeds, with dials: exit 0, the verdict last, the published origin dialed once", good.code === 0 && good.text.trim().endsWith("AGENT READS OK: 2 of 2 seeds gave their own height, and two seeds agree on the validator list.") && dialHits.n === 1
    && good.text.includes("Watch (one round, --dial)") && leaks(good.text).length === 0, good.code + " | " + good.text.split("\n").slice(-3).join(" | ") + " | dials " + dialHits.n);
  dialHits.n = 0;
  const nodial = await runOut(pair(G1, G2));
  check("W2 without --dial (VALIDATOR_WATCH_DIALS=0): the list is still read and agreed, and no published address is dialed", nodial.code === 0 && dialHits.n === 0 && nodial.text.includes("Watch (one round: the list only, no dials)")
    && nodial.text.trim().endsWith("and two seeds agree on the validator list."), nodial.code + " | dials " + dialHits.n);
  const few = await runOut(["--dial", ...pair(G1, NOSELF)]);
  check("W3 a seed that does not list itself: exit 3, FAILED (the agent would publish unknown)", few.code === 3 && few.text.trim().endsWith("AGENT READS FAILED: 1 of the 2 seeds that answered gave its own height, and the agent needs two. Do not restart on this."), few.code + " | " + few.text.split("\n").slice(-1));
  const one = await runOut(["--dial", ...pair(G1, DOWN)]);
  check("W4 one seed down: exit 3, FAILED on both counts", one.code === 3 && /AGENT READS FAILED: 1 of 2 seeds answered \/info, and the agent needs two; no validator list was agreed by two seeds\. Do not restart on this\.$/.test(one.text.trim()), one.code + " | " + one.text.split("\n").slice(-1));
  const differ = await runOut(["--dial", ...pair(G1, DIFF)]);
  check("W5 the seeds' lists differ: exit 3", differ.code === 3 && differ.text.trim().endsWith("AGENT READS FAILED: no validator list was agreed by two seeds. Do not restart on this."), differ.code + " | " + differ.text.split("\n").slice(-1));
  // A seed whose /info names another key than the configured one is not asked for the list, as in the agent.
  const three = [cfg("seed-a", G1, K("a1")), cfg("seed-b", G2, K("a2")), cfg("seed-otherkey", OTHERKEY, K("a4"))];
  const forRound = seedsForRound(three, await agentSeedReads(three));
  check("W5b the seed that named another key is excluded from the validator round, with the agent's words; the others are not",
    forRound.map((x) => x.exclude).join("|") === "||its last /info answered with another key" && seedsForRound(three, null).every((x) => x.exclude === null), JSON.stringify(forRound.map((x) => x.exclude)));
  const excluded = await dialReport(forRound, await Promise.all(three.map(probeSeed)), { resolveOrigin: loop, dials: false });
  check("W5c the list is then agreed by the two seeds that are asked", excluded.onChain.state === "agreed" && excluded.onChain.seeds_agreed === 2 && excluded.onChain.seeds_answered === 2, JSON.stringify(excluded.onChain));
  // run() with the seeds taken from the agent's configuration, as tools/pre-restart-check.mjs runs it with no arguments.
  const conf = (entries) => "const PUBLIC_NODES = {\n" + entries.map(([n, srv, key]) => `  "${n}": {\n    url: ${typeof srv === "string" ? srv : JSON.stringify(url(srv))},\n    identity: "${key}",\n    source_type: "public"\n  },`).join("\n") + "\n};\n";
  const errOut = async (ctx) => { const err = [], e = console.error; console.error = (...a) => err.push(a.join(" ")); try { return Object.assign(await runOut([], ctx), { err: err.join("\n") }); } finally { console.error = e; } };
  const fromConf = await errOut({ agentSource: conf([["seed-a", G1, K("a1")], ["seed-b", G2, K("a2")], ["seed-otherkey", OTHERKEY, K("a4")]]) });
  check("W7 seeds from the configuration, one answering with another key: it is not asked for the validator list (2 of 3 return it, though all three would), exit 0",
    fromConf.code === 0 && fromConf.text.includes("seed-otherkey  answered · names another key: no height is taken from it · no height") && fromConf.text.includes("getValidators answered by 3 of 3")
    && fromConf.text.includes("  list: 2 of 3 public seeds returned the same list") && fromConf.text.trim().endsWith("AGENT READS OK: 2 of 3 seeds gave their own height, and two seeds agree on the validator list.") && leaks(fromConf.text).length === 0,
    fromConf.code + " | " + fromConf.text.split("\n").filter((l) => /another key|AGENT|  list:|getValidators answered by/.test(l)).join(" | "));
  const twoOnly = await errOut({ agentSource: conf([["seed-a", G1, K("a1")], ["seed-otherkey", OTHERKEY, K("a4")]]) });
  check("W7b with one seed left to ask, no list is agreed: exit 3", twoOnly.code === 3 && /no validator list was agreed by two seeds\. Do not restart on this\.$/.test(twoOnly.text.trim()), twoOnly.code + " | " + twoOnly.text.split("\n").slice(-1));
  const unread = await errOut({ agentSource: conf([["seed-a", G1, K("a1")], ["seed-b", 'BASE + "/x"', K("a2")]]) });
  check("W8 a configured seed the check cannot read in full: exit 64 before any read, and it says how many", unread.code === 64 && unread.text === "" && unread.err === "src/agent.mjs configures 2 seeds; 1 could be read with a url and an identity. The pre-restart check needs all of them.", JSON.stringify(unread));
  const noBlock = await errOut({ agentSource: "const OTHER = {};" });
  check("W8b a source with no seed configuration: exit 64, said plainly", noBlock.code === 64 && noBlock.err === "The seeds could not be read from src/agent.mjs: it has no PUBLIC_NODES block.", JSON.stringify(noBlock));
  const plain = await runOut(pair(G1, G2), { agentReads: false });
  check("W6 the plain probe (no agent reads) prints no verdict and keeps its exit codes", plain.code === 0 && !/AGENT READS/.test(plain.text) && !/Watch \(/.test(plain.text));
  [G1, G2, NOSELF, OTHERKEY, DOWN, DIFF, val].forEach((x) => x.stop(true));
}

[A, B, C, E].forEach((s) => s.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
