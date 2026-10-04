// validator-set-probe.test.mjs — VALIDATOR_SET_PROBE guard: the named test's tool reads what it should and prints
// nothing it must not. Runs tools/validator-set-probe.mjs against local synthetic seeds (Bun.serve on loopback).
// Rules under test: the SDK's nodeCall wire format; counts by status; a value only when at least two seeds report it
// and all that report it agree; no host, address, connectionUrl, stake or full key in the output; unexpected shapes
// are reported and make the tool exit non-zero.
// Run: bun src/validator-set-probe.test.mjs   (executable harness, not `bun test`)

import { probeSeed, formatReport, summarize, seedsFromAgent, dialReport, firstSeenAgreement, firstSeenValue, agentSeedReads, agentSeedLine, agentReadsReport, agentRpcReads, agentVerdict, seedsForRound, seedsUnread, keysOf, run } from "../tools/validator-set-probe.mjs";
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
  check("P3 /info key names only", text.includes("keys: identity, peerlist, version, (1 other name not printed)") && text.includes("peerlist entry keys: identity, connection{string}, status{online, ready}, sync{status, block}") && text.includes("a key naming a hash: no · a key naming a shard: no"), text);
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
  // The tool's own one read of a seed follows no redirect: an answer may not send it to another address.
  let trapped = 0;
  const trapSrv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { trapped++; return Response.json(INFO); } });
  const redir = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { return new Response(null, { status: 302, headers: { location: url(trapSrv) + new URL(req.url).pathname } }); } });
  const sent = await probeSeed({ name: "redir", url: url(redir) });
  check("X9 a seed that answers with a redirect is not followed: no request reaches the address it names, and the seed has not answered", trapped === 0 && !(sent.info && sent.info.answered), JSON.stringify([trapped, sent.info]));
  trapSrv.stop(true); redir.stop(true);
  const { spawnSync } = await import("node:child_process");
  {
    // tools/pre-restart-check.mjs in a folder without the agent's node_modules: it must not pass, and must not go on.
    // The runtime fetches a package it does not find when no node_modules is near (and whether that takes long depends
    // on its cache), so the child gets a package cache of its own and a registry that is this suite's: a request there
    // is counted. Asked 0 times is the proof that the check looked on disk first.
    const { mkdtempSync, mkdirSync, copyFileSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const box = mkdtempSync(join(tmpdir(), "dno-nosdk-")); mkdirSync(join(box, "tools"));
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "pre-restart-check.mjs"), join(box, "tools", "pre-restart-check.mjs"));
    let asked = 0;
    const registry = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { asked++; return new Response("{}", { status: 404, headers: { "content-type": "application/json" } }); } });
    const env = { ...process.env, BUN_INSTALL_CACHE_DIR: join(box, "cache"), BUN_CONFIG_REGISTRY: url(registry) + "/", NPM_CONFIG_REGISTRY: url(registry) + "/", npm_config_registry: url(registry) + "/", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    const kid = Bun.spawn([process.execPath, join(box, "tools", "pre-restart-check.mjs")], { cwd: box, env, stdout: "pipe", stderr: "pipe" });
    const lone = { status: await kid.exited, stderr: await new Response(kid.stderr).text(), stdout: await new Response(kid.stdout).text() };
    registry.stop(true);
    check("X10 the pre-restart check without the Demos SDK beside it: exit 64, it says so, reads nothing and asks no registry for a package (it looks on disk first)", lone.status === 64 && /^The Demos SDK is not installed next to this tool\./.test(lone.stderr) && lone.stdout === "" && asked === 0,
      JSON.stringify([lone.status, lone.stderr.slice(0, 90), asked]));
    rmSync(box, { recursive: true, force: true });
  }
  const bad = spawnSync("bun", [join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "validator-set-probe.mjs"), "--dail"], { encoding: "utf8" });
  check("X5 an argument that is not name=url (a mistyped flag) stops the tool with usage, exit 64", bad.status === 64 && /^1 argument is not a name=url pair\./.test(bad.stderr) && !/dail/.test(bad.stderr + bad.stdout), JSON.stringify([bad.status, bad.stderr.slice(0, 80)]));
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
    return Response.json({ result: 200, response: msg === "getValidators" ? vrows(o.rows ? o.rows() : o.extraRow ? [{ address: K("d9"), status: "2", connectionUrl: null, stakedAmount: "1", firstSeen: 1, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null }] : []) : { minValidatorStake: "1000" } });
  } });
  // A seed that takes the connection and never answers: started here, awaited at the end of this block.
  const HANG = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
  const hangRead = (async () => { const t = Date.now(); const r = await agentSeedReads([{ name: "seed-hang", url: "http://127.0.0.1:" + HANG.port, identity: K("b1") }]); return { ms: Date.now() - t, r: r[0] }; })();
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
    rep.text.includes("bun " + Bun.version + " · the Demos SDK was loaded first, as in the agent; it replaced the global fetch") && rep.text.includes("4 of 6 seeds answered; 2 gave their own height. Two give a status from the seeds alone; with fewer, validators stand in (Witnesses, below).")
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
  // 1.2: the verdict follows the agent's rule on the reads, validators included (witnessReport's result).
  const fault = { ok: false, error: "internal error" };
  const wit = (mode, o = {}) => Object.assign({ mode, counted: 0, internalErrors: 0, why: null }, o);
  const vw = (r, list, w, shape) => { const x = agentVerdict(r, list, shape || 0, w); return x.code + " " + x.text; };
  check("V9 a read that ended in an internal error is DNO's own fault: FAILED, though two seeds gave a height",
    vw([own, own, fault], "agreed", wit("seeds_only")) === "3 AGENT READS FAILED: 1 read ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this."
    && vw([own, own, no], "agreed", wit("seeds_only", { internalErrors: 2 })) === "3 AGENT READS FAILED: 2 reads ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this."
    && v([own, own, fault], "agreed") === "3 AGENT READS FAILED: 1 read ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this.", vw([own, own, fault], "agreed", wit("seeds_only")));
  check("V10 one seed and validators within 25 blocks of it: OK, and a list that cannot be agreed by one seed is a note",
    vw([own, no, no], "not_agreed", wit("seed_and_validators", { counted: 3 })) === "0 AGENT READS OK: 1 of 3 seeds gave its own height, and 3 validators that answer as listed are within 25 blocks of it. The agent would publish a reading that rests on them. No validator list is agreed while fewer than two seeds are asked for it; the agent keeps a candidate for 24 h after its last answer."
    && vw([own, no, no], "not_agreed", wit("seed_and_validators", { counted: 1 })).includes("and 1 validator that answers as listed is within 25 blocks of it."), vw([own, no, no], "not_agreed", wit("seed_and_validators", { counted: 3 })));
  check("V11 no seed, validators alone: a reading, and not a pass. Seeds that are down and a fault in DNO's own seed read look the same, so it has its own exit code and nothing restarts on it",
    vw([no, no, no], "not_agreed", wit("validators_only", { counted: 3 })) === "4 AGENT READS GIVE A READING WITHOUT A SEED: no seed gave its own height, and 3 validators that answer as listed agree within 25 blocks. The agent would publish a reading that rests on validators alone. This check cannot tell seeds that are down from a fault in DNO's own seed read: do not restart on this without knowing which it is. No validator list is agreed while fewer than two seeds are asked for it; the agent keeps a candidate for 24 h after its last answer."
    && agentVerdict([no, no, no], "not_agreed", 0, wit("validators_only", { counted: 3 })).ok === false);
  const otherKey = { name: "s", ok: true, block: 7000, height_source: null, identityMatch: false };
  check("V11b a seed that answered with another key is not asked for the list: with one seed left to ask, a list that is not agreed is a note",
    vw([own, otherKey, no], "not_agreed", wit("seed_and_validators", { counted: 1 })).startsWith("0 AGENT READS OK: 1 of 3 seeds gave its own height, and 1 validator that answers as listed is within 25 blocks of it.")
    && vw([own, Object.assign({}, own), no], "not_agreed", wit("seeds_only")) === "3 AGENT READS FAILED: no validator list was agreed by two seeds. Do not restart on this.");
  check("V12 no reading: FAILED with the seeds' count and why no validator stands in",
    vw([own, no, no], "not_agreed", wit("insufficient", { why: "the agent keeps no candidates here" })) === "3 AGENT READS FAILED: 1 of 3 seeds answered /info, and the agent needs two, or validators that stand in (the agent keeps no candidates here). Do not restart on this."
    && vw([own, fp, no], "agreed", wit("insufficient", { why: "none of the validators read is within 25 blocks of the seed" })) === "3 AGENT READS FAILED: 1 of the 2 seeds that answered gave its own height, and the agent needs two, or validators that stand in (none of the validators read is within 25 blocks of the seed). Do not restart on this.");
  check("V13 two seeds answered and no list agreed is still a failure, whatever the mode", vw([own, own, no], "not_agreed", wit("seeds_only")) === "3 AGENT READS FAILED: no validator list was agreed by two seeds. Do not restart on this."
    && vw([own, fp, no], "not_agreed", wit("seed_and_validators", { counted: 2 })) === "3 AGENT READS FAILED: no validator list was agreed by two seeds. Do not restart on this.");
  check("V14 a reading with a fault beside it is still FAILED", /^3 AGENT READS FAILED: 1 read ended in an internal error/.test(vw([own, no, no], "not_agreed", wit("seed_and_validators", { counted: 2, internalErrors: 1 }))));

  check("V15 a list read or a dial of the check's validator round that ended in an internal error fails it too, whatever else holds: such a round's 'no answer' is DNO's own fault",
    (() => { const x = agentVerdict([own, own, no], "agreed", 0, wit("seeds_only"), 3); return x.code + " " + x.text; })() === "3 AGENT READS FAILED: 3 reads ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this."
    && agentVerdict([own, own, fault], "agreed", 0, wit("seeds_only", { internalErrors: 1 }), 2).text === "AGENT READS FAILED: 4 reads ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this."
    && agentVerdict([own, own, no], "agreed", 0, wit("seeds_only"), 0).code === 0 && agentVerdict([own, own, no], "agreed", 0, wit("seeds_only"), undefined).code === 0);

  // run(): the whole check, as tools/pre-restart-check.mjs calls it. Loopback seeds need a resolver that admits them.
  const loop = async (u) => { const p = parseProbeOrigin(u); return p && p.hostname === "127.0.0.1" ? "http://127.0.0.1:" + p.port : null; };
  // kept: null by default. A suite must not read this host's store: run in the agent's checkout it would find the agent's
  // kept candidates and read real validators.
  const runOut = async (args, ctx) => { const out = [], log = console.log; console.log = (...a) => out.push(a.join(" ")); let code; try { code = await run(args, Object.assign({ agentReads: true, sdkReplaced: true, resolveOrigin: loop, kept: null }, ctx)); } finally { console.log = log; } return { code, text: out.join("\n") }; };
  const pair = (a, b) => ["seed-a=" + url(a), "seed-b=" + url(b)];
  dialHits.n = 0;
  const good = await runOut(["--dial", ...pair(G1, G2)]);
  check("W1 two good seeds, with dials: exit 0, the verdict last; the published origin is dialed once by the watch and read once as a witness", good.code === 0 && good.text.trim().endsWith("AGENT READS OK: 2 of 2 seeds gave their own height, and two seeds agree on the validator list.") && dialHits.n === 2
    && good.text.includes("Watch (one round, --dial)") && leaks(good.text).length === 0, good.code + " | " + good.text.split("\n").slice(-3).join(" | ") + " | dials " + dialHits.n);
  check("W1b the witnesses are read even when two seeds answer, so the read is tested before every restart; the rule then leaves them out", good.text.includes("Witnesses (validators the agent reads when fewer than two seeds give their own height)\n  candidates: 1, from this run's validator list\n  read as the agent reads them: 1 of 1 answered as the listed key with its own height\n  the agent's rule on these reads: 2 seeds gave their own height, so the seeds alone decide and no validator enters the reading (seeds_only)"), good.text.split("\n").slice(-6).join(" | "));
  dialHits.n = 0;
  const nodial = await runOut(pair(G1, G2));
  check("W2 without --dial (VALIDATOR_WATCH_DIALS=0): the list is still read and agreed, and no published address is dialed, as a witness either", nodial.code === 0 && dialHits.n === 0 && nodial.text.includes("Watch (one round: the list only, no dials)")
    && nodial.text.includes("  not read: the dials are off (VALIDATOR_WATCH_DIALS), and the agent then reads no validator") && nodial.text.trim().endsWith("and two seeds agree on the validator list."), nodial.code + " | dials " + dialHits.n);
  const few = await runOut(["--dial", ...pair(G1, NOSELF)]);
  check("W3 a seed that does not list itself: exit 3, FAILED (the agent would publish unknown)", few.code === 3 && few.text.trim().endsWith("AGENT READS FAILED: 1 of the 2 seeds that answered gave its own height, and the agent needs two, or validators that stand in (the agent keeps no candidates here). Do not restart on this."), few.code + " | " + few.text.split("\n").slice(-1));
  const one = await runOut(["--dial", ...pair(G1, DOWN)]);
  check("W4 one seed down and no candidates kept: exit 3, FAILED (the agent would publish unknown); the list one seed cannot agree is not a second failure", one.code === 3 && one.text.trim().endsWith("AGENT READS FAILED: 1 of 2 seeds answered /info, and the agent needs two, or validators that stand in (the agent keeps no candidates here). Do not restart on this.")
    && one.text.includes("  candidates: none (this run's validator round did not count, and the agent keeps none here)"), one.code + " | " + one.text.split("\n").slice(-1));
  // 1.2: one seed down, and the agent kept candidates from the last agreed list. The validator stands in.
  const KEPT = (list) => ({ agreedAt: Date.now() - 3600000, candidates: list });
  const cand = (key, srv) => ({ key: key.slice(2), url: "http://127.0.0.1:" + srv.port });
  const val2 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: K("c8"), peerlist: [{ identity: K("c8"), sync: { block: 7002 } }] }); } });
  const far = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: K("c9"), peerlist: [{ identity: K("c9"), sync: { block: 7026 } }] }); } });
  dialHits.n = 0;
  const stood = await runOut(["--dial", ...pair(G1, DOWN)], { kept: KEPT([cand(K("c7"), val)]) });
  check("W9 one seed down, a kept validator within 25 blocks of the other: exit 0, OK, and it says what the reading rests on", stood.code === 0 && dialHits.n === 1
    && stood.text.includes("  candidates: 1, kept by the agent from the list two seeds agreed on at ") && stood.text.includes("  the agent's rule on these reads: one seed gave its own height and 1 validator is within 25 blocks of it (seed_and_validators)")
    && stood.text.trim().endsWith("AGENT READS OK: 1 of 2 seeds gave its own height, and 1 validator that answers as listed is within 25 blocks of it. The agent would publish a reading that rests on them. No validator list is agreed while fewer than two seeds are asked for it; the agent keeps a candidate for 24 h after its last answer.")
    && leaks(stood.text).length === 0, stood.code + " | " + stood.text.split("\n").slice(-5).join(" | "));
  const offBand = await runOut(["--dial", ...pair(G1, DOWN)], { kept: KEPT([cand(K("c9"), far)]) });
  check("W10 the kept validator is 26 blocks from the seed: it does not stand in, exit 3", offBand.code === 3 && offBand.text.trim().endsWith("AGENT READS FAILED: 1 of 2 seeds answered /info, and the agent needs two, or validators that stand in (none of the validators read is within 25 blocks of the seed). Do not restart on this."), offBand.text.split("\n").slice(-1));
  const alone = await runOut(["--dial", "seed-a=" + url(DOWN), "seed-b=" + url(DOWN)], { kept: KEPT([cand(K("c7"), val), cand(K("c8"), val2)]) });
  check("W11 no seed answers, two kept validators agree: exit 4, a reading that rests on validators alone and is not a pass", alone.code === 4 && alone.text.includes("  the agent's rule on these reads: no seed gave its own height; 2 validators agree within 25 blocks (validators_only)")
    && alone.text.trim().split("\n").pop().startsWith("AGENT READS GIVE A READING WITHOUT A SEED: no seed gave its own height, and 2 validators that answer as listed agree within 25 blocks.") && !/AGENT READS OK/.test(alone.text), alone.code + " | " + alone.text.split("\n").slice(-1));
  const single = await runOut(["--dial", "seed-a=" + url(DOWN), "seed-b=" + url(DOWN)], { kept: KEPT([cand(K("c7"), val)]) });
  check("W12 no seed answers and one kept validator: one is not a reading, exit 3", single.code === 3 && single.text.trim().endsWith("AGENT READS FAILED: 0 of 2 seeds answered /info, and the agent needs two, or validators that stand in (the validators read give no majority within 25 blocks). Do not restart on this."), single.text.split("\n").slice(-1));
  dialHits.n = 0;
  const offSwitch = await runOut(pair(G1, DOWN), { kept: KEPT([cand(K("c7"), val)]) });
  check("W13 the dials are off: the kept validators are not read, and one seed is not enough, exit 3", offSwitch.code === 3 && dialHits.n === 0 && offSwitch.text.trim().endsWith("AGENT READS FAILED: 1 of 2 seeds answered /info, and the agent needs two, or validators that stand in (the dials are off). Do not restart on this."), offSwitch.text.split("\n").slice(-1));
  // A fault in DNO's own read: the transport throws a TypeError for chosen requests, and the peers answer as always.
  {
    const real = Bun.fetch.bind(Bun), port = (srv) => String(srv.port);
    const faulty = (pick) => async (u, init) => { if (pick(new URL(u), (init && init.method) || "GET")) throw new TypeError("resp.body.getReader is not a function"); return real(u, init); };
    const control = await runOut(["--dial", ...pair(G1, G2)], { fetch: faulty(() => false) });
    const dialFault = await runOut(["--dial", ...pair(G1, G2)], { fetch: faulty((u, m) => m === "GET" && u.port === port(val)) });
    check("W30 the dial of a validator ends in an internal error while both seeds and the validator answer: FAILED, exit 3. The check does not print 'no answer' for it, and names no candidate from that round (without the fault: exit 0)",
      control.code === 0 && dialFault.code === 3 && dialFault.text.includes("  dials: none (a fault in DNO's own read: 1 dial of this round ended in an internal error, so no counts are given for it)") && !/no answer \d/.test(dialFault.text)
      && dialFault.text.includes("  candidates: none (") && dialFault.text.trim().endsWith("AGENT READS FAILED: 1 read ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this.") && leaks(dialFault.text).length === 0,
      dialFault.code + " | " + dialFault.text.split("\n").filter((l) => /dials:|candidates|AGENT/.test(l)).join(" | "));
    // The dial works and the witness read of the same address does not (the second GET to it).
    const seen = {}; const second = (u, m) => { if (m !== "GET" || u.port !== port(val)) return false; seen[u.port] = (seen[u.port] || 0) + 1; return seen[u.port] >= 2; };
    const witFault = await runOut(["--dial", ...pair(G1, G2)], { fetch: faulty(second) });
    check("W31 a witness read ends in an internal error: FAILED, exit 3, though two seeds gave their height and the watch round counted",
      witFault.code === 3 && witFault.text.includes("  read as the agent reads them: 0 of 1 answered as the listed key with their own height · 1 ended in an internal error")
      && witFault.text.trim().endsWith("AGENT READS FAILED: 1 read ended in an internal error, a fault in DNO's own read and not the peer's. Do not restart on this."), witFault.code + " | " + witFault.text.split("\n").slice(-4).join(" | "));
    const listFault = await runOut(["--dial", ...pair(G1, G2)], { fetch: faulty((u, m) => m === "POST" && u.port === port(G2)) });
    check("W32 one seed's list read ends in an internal error: FAILED, and the fault is named before the list that was not agreed",
      listFault.code === 3 && listFault.text.includes("  list: no figure: DNO's own read of the validator list ended in an internal error for 1 of 2 public seeds")
      && listFault.text.trim().endsWith("AGENT READS FAILED: 1 read ended in an internal error, a fault in DNO's own read and not the peer's; no validator list was agreed by two seeds. Do not restart on this."), listFault.code + " | " + listFault.text.split("\n").slice(-1));
    // One seed is asked for the list (the other is down), a kept validator stands in, and the list read of the one seed faults.
    const lone = await runOut(["--dial", ...pair(G1, DOWN)], { kept: KEPT([cand(K("c7"), val)]), fetch: faulty((u, m) => m === "POST" && u.port === port(G1)) });
    check("W33 with one seed asked for the list, its faulty list read is not passed over as 'no list is agreed while fewer than two seeds are asked': FAILED, exit 3 (it was: exit 0)",
      lone.code === 3 && /^AGENT READS FAILED: 1 read ended in an internal error, a fault in DNO's own read and not the peer's\. Do not restart on this\.$/.test(lone.text.trim().split("\n").pop()), lone.code + " | " + lone.text.split("\n").slice(-1));
    const seedFault = await runOut(["--dial", ...pair(G1, G2)], { fetch: faulty((u, m) => m === "GET" && u.port === port(G2)) });
    check("W34 a seed's /info read that ends in an internal error is said as that on the seed's line, and fails the check", seedFault.code === 3 && seedFault.text.includes("seed-b  no answer (internal error)") && /1 read ended in an internal error/.test(seedFault.text.trim().split("\n").pop()),
      seedFault.code + " | " + seedFault.text.split("\n").filter((l) => /seed-b|AGENT/.test(l)).join(" | "));
  }
  const stale = await runOut(["--dial", ...pair(G1, DOWN)], { kept: { agreedAt: null, candidates: [] } });
  check("W14 candidates older than 24 h are none (the store gives none): exit 3", stale.code === 3 && /the agent keeps no candidates here/.test(stale.text.trim().split("\n").pop()));
  const gone = await runOut(["--dial", ...pair(G1, DOWN)], { kept: KEPT([{ key: K("c7").slice(2), url: "http://127.0.0.1:1" }]) });
  check("W15 the kept validator does not answer: no reading, exit 3, and no fault is claimed", gone.code === 3 && gone.text.includes("  read as the agent reads them: 0 of 1 answered as the listed key with their own height") && !/internal error/.test(gone.text), gone.text.split("\n").slice(-4).join(" | "));
  // The agent's store, read without writing.
  {
    const { mkdtempSync, rmSync, statSync, readFileSync: rf } = await import("node:fs"), { tmpdir } = await import("node:os"), { join: pj } = await import("node:path");
    const { Database } = await import("bun:sqlite"), { createCandidateStore } = await import("./witnesses.mjs"), { keptCandidates } = await import("../tools/validator-set-probe.mjs");
    const dir = mkdtempSync(pj(tmpdir(), "dno-kept-")), file = pj(dir, "marketplace.db");
    const db = new Database(file); createCandidateStore(db).save([cand(K("c7"), val)], Date.now() - 60000); db.close();
    const before = rf(file).toString("hex"), got = keptCandidates(file, Date.now());
    {
      // The same on a store in WAL mode that another connection holds open and writes to, as a running agent does.
      const wfile = pj(dir, "wal.db"), agentDb = new Database(wfile);
      agentDb.run("PRAGMA journal_mode = WAL"); createCandidateStore(agentDb).save([cand(K("c7"), val)], Date.now() - 60000);
      agentDb.run("CREATE TABLE t (x INTEGER)"); agentDb.run("INSERT INTO t VALUES (1)");
      const mainBefore = rf(wfile).toString("hex"), walGot = keptCandidates(wfile, Date.now());
      agentDb.run("INSERT INTO t VALUES (2)");                                   // the agent goes on writing
      const stillWrites = agentDb.query("SELECT COUNT(*) AS n FROM t").get().n === 2, keptAfter = createCandidateStore(agentDb).load(Date.now()).candidates.length;
      check("W16b beside a store in WAL mode that the agent holds open: the kept candidates are read, the store's main file is byte for byte as it was, and the agent goes on writing and still holds what it kept",
        agentDb.query("PRAGMA journal_mode").get().journal_mode === "wal" && walGot && walGot.candidates.length === 1 && rf(wfile).toString("hex") === mainBefore && stillWrites && keptAfter === 1, JSON.stringify([walGot, stillWrites, keptAfter]));
      agentDb.close();
    }
    check("W16 the agent's kept candidates are read from its store without writing to it; no store here is none", got && got.candidates.length === 1 && got.candidates[0].key === K("c7").slice(2) && rf(file).toString("hex") === before
      && keptCandidates(pj(dir, "absent.db"), Date.now()) === null && keptCandidates(file, Date.now() + 25 * 3600000).candidates.length === 0);
    rmSync(dir, { recursive: true, force: true });
  }
  [val2, far].forEach((x) => x.stop(true));
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
  check("W7b with one seed left to ask (this run has no --dial) and one seed height: exit 3 for the missing reading; the list one seed cannot agree is not a second failure", twoOnly.code === 3 && twoOnly.text.trim().endsWith("AGENT READS FAILED: 1 of the 2 seeds that answered gave its own height, and the agent needs two, or validators that stand in (the dials are off). Do not restart on this."), twoOnly.code + " | " + twoOnly.text.split("\n").slice(-1));
  // The candidates as the agent would hold and read them.
  const seedKeyKept = await runOut(["--dial"], { agentSource: conf([["seed-a", G1, K("a1")], ["seed-x", DOWN, K("c7")]]), kept: KEPT([cand(K("c7"), val)]) });
  check("W17 a kept candidate whose key is a configured seed's is not read as a witness, as in the agent: no reading, exit 3 (it was: OK, where the agent publishes unknown)", seedKeyKept.code === 3
    && seedKeyKept.text.includes("  candidates: none (") && !/read as the agent reads them/.test(seedKeyKept.text) && seedKeyKept.text.trim().endsWith("validators that stand in (the agent keeps no candidates here). Do not restart on this."), seedKeyKept.code + " | " + seedKeyKept.text.split("\n").slice(-4).join(" | "));
  const otherKeyKept = await runOut(["--dial"], { agentSource: conf([["seed-a", G1, K("a1")], ["seed-otherkey", OTHERKEY, K("a4")]]), kept: KEPT([cand(K("c7"), val)]) });
  check("W18 one seed with its height, one that answers as another key (so it is not asked for the list), and a kept validator within 25 blocks: the agent reads, and so does this check (it was: FAILED for a list no two seeds could agree)", otherKeyKept.code === 0
    && otherKeyKept.text.trim().split("\n").pop().startsWith("AGENT READS OK: 1 of 2 seeds gave its own height, and 1 validator that answers as listed is within 25 blocks of it."), otherKeyKept.code + " | " + otherKeyKept.text.split("\n").slice(-1));
  // A kept candidate whose key is the one a seed URL answered with (not that seed's configured key): the agent reads it.
  const val9 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: K("a9"), peerlist: [{ identity: K("a9"), sync: { block: 7003 } }] }); } });
  const aliasKept = await runOut(["--dial"], { agentSource: conf([["seed-a", G1, K("a1")], ["seed-otherkey", OTHERKEY, K("a4")]]), kept: KEPT([cand(K("a9"), val9)]) });
  check("W18b a seed's key is its configured key, as in the agent: a kept candidate with the key some seed URL answered with is still read, and stands in (it was: dropped, FAILED 'the agent keeps no candidates here')", aliasKept.code === 0
    && aliasKept.text.includes("  candidates: 1, kept by the agent from the list two seeds agreed on at ") && aliasKept.text.trim().split("\n").pop().startsWith("AGENT READS OK: 1 of 2 seeds gave its own height, and 1 validator that answers as listed is within 25 blocks of it."),
    aliasKept.code + " | " + aliasKept.text.split("\n").slice(-4).join(" | "));
  val9.stop(true);
  const unreadable = await runOut(["--dial", ...pair(G1, DOWN)], { kept: { unreadable: true } });
  check("W19 a store that is there and cannot be read is said as that, not as an agent that keeps none", unreadable.code === 3 && unreadable.text.includes("  the agent's store is here and could not be read: the candidates it keeps are not known to this check")
    && unreadable.text.includes("  candidates: none (this run's validator round did not count, and the kept ones could not be read)") && unreadable.text.trim().endsWith("validators that stand in (the agent's store could not be read). Do not restart on this."), unreadable.text.split("\n").slice(-4).join(" | "));
  {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join: pj } = await import("node:path"), { keptCandidates } = await import("../tools/validator-set-probe.mjs");
    const dir = mkdtempSync(pj(tmpdir(), "dno-kept-")), file = pj(dir, "marketplace.db");
    writeFileSync(file, "this is not a database, and it is long enough to be read as one".repeat(40));
    check("W19b and the store read says which it was", JSON.stringify(keptCandidates(file, Date.now())) === JSON.stringify({ unreadable: true }) && keptCandidates(pj(dir, "none.db"), Date.now()) === null);
    rmSync(dir, { recursive: true, force: true });
  }
  dialHits.n = 0;
  const renewed = await runOut(["--dial", ...pair(G1, G2)], { kept: KEPT([{ key: K("c8").slice(2), url: "http://127.0.0.1:9", at: Date.now() - 3600000 }, Object.assign(cand(K("c7"), val), { at: Date.now() - 7200000 })]) });
  check("W20 when this run's validator round counts, the candidates are the kept ones renewed by it, as the agent would hold them: a kept key that is no longer on the list is gone, one that answered is kept", renewed.code === 0
    && renewed.text.includes("  candidates: 1, the ones the agent keeps, renewed by this run's validator list\n  read as the agent reads them: 1 of 1 answered as the listed key with its own height") && dialHits.n === 2, renewed.text.split("\n").slice(-6).join(" | "));
  // More rows on the list: c1 is ACTIVE at an address where nothing answers; 01 answers as listed, with the lowest key.
  {
    const row = (key, urlOf) => ({ address: key, status: "2", connectionUrl: urlOf, stakedAmount: "1", firstSeen: 1, validAt: 1, unstakeRequestedAt: null, unstakeAvailableAt: null });
    const low = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: K("01"), peerlist: [{ identity: K("01"), sync: { block: 7000 } }] }); } });
    const more = () => [row(K("c1"), "http://127.0.0.1:9"), row(K("01"), "http://127.0.0.1:" + low.port)];
    const M1 = agentSeed(K("a1"), { rows: more }), M2 = agentSeed(K("a2"), { rows: more });
    const kept1 = KEPT([{ key: K("c1").slice(2), url: "http://127.0.0.1:9", at: Date.now() - 3600000 }]);
    const keptOne = await runOut(["--dial", ...pair(M1, M2)], { kept: kept1 });
    check("W21 a kept candidate that does not answer in this run's round stays, as in the agent: it is read with those that answered (3 candidates, 2 of 3 with a height)", keptOne.code === 0
      && keptOne.text.includes("  candidates: 3, the ones the agent keeps, renewed by this run's validator list\n  read as the agent reads them: 2 of 3 answered as the listed key with their own height"), keptOne.text.split("\n").slice(-6).join(" | "));
    // The order of the dials: each published address is checked just before it is dialed, in dial order.
    const asked = [], spy = async (u) => { asked.push(u); return loop(u); };
    await runOut(["--dial", ...pair(M1, M2)], { kept: KEPT([Object.assign(cand(K("c7"), val), { at: Date.now() - 3600000 })]), resolveOrigin: spy });
    const first = (port) => asked.findIndex((u) => u === "http://127.0.0.1:" + port);
    check("W22 the kept candidates are dialed first, before a row with a lower key", first(val.port) >= 0 && first(low.port) >= 0 && first(val.port) < first(low.port), JSON.stringify([first(val.port), first(low.port)]));
    // Answers as the listed key, and lists itself nowhere: no height of its own.
    const nohi = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ identity: K("c2"), peerlist: [{ identity: K("ee"), sync: { block: 7000 } }] }); } });
    const noHeight = await runOut(["--dial", ...pair(G1, DOWN)], { kept: KEPT([cand(K("c2"), nohi)]) });
    check("W23 a kept validator that answers as listed without its own height is not counted as one with a height: 0 of 1, no reading, exit 3", noHeight.code === 3
      && noHeight.text.includes("  read as the agent reads them: 0 of 1 answered as the listed key with their own height"), noHeight.text.split("\n").slice(-4).join(" | "));
    low.stop(true); nohi.stop(true); M1.stop(true); M2.stop(true);
  }
  // The agent's store is opened read-only: a store that has no candidates table yet still has none after the check.
  {
    const { mkdtempSync, rmSync, readFileSync: rf } = await import("node:fs"), { tmpdir } = await import("node:os"), { join: pj } = await import("node:path");
    const { Database } = await import("bun:sqlite"), { keptCandidates } = await import("../tools/validator-set-probe.mjs");
    const dir = mkdtempSync(pj(tmpdir(), "dno-kept-ro-")), file = pj(dir, "marketplace.db");
    const db = new Database(file); db.run("CREATE TABLE incidents (id TEXT)"); db.close();
    const before = rf(file).toString("hex"), got = keptCandidates(file, Date.now());
    const after = new Database(file, { readonly: true }), tables = after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name); after.close();
    {
      // The same on a WAL store nothing else holds: the read may leave the store's side files, never a change in the store.
      const wfile = pj(dir, "wal-alone.db"), w0 = new Database(wfile); w0.run("PRAGMA journal_mode = WAL"); w0.run("CREATE TABLE incidents (id TEXT)"); w0.run("INSERT INTO incidents VALUES ('INC-1')"); w0.close();
      const mainBefore = rf(wfile).toString("hex"), gotW = keptCandidates(wfile, Date.now()), mainAfterRead = rf(wfile).toString("hex");
      const again = new Database(wfile), rowsAfter = again.query("SELECT id FROM incidents").all().map((r) => r.id).join(), tablesAfter = again.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).join();
      again.run("INSERT INTO incidents VALUES ('INC-2')"); const writable = again.query("SELECT COUNT(*) AS n FROM incidents").get().n === 2; again.close();
      check("W24b on a store in WAL mode that nothing else holds: no candidates table appears, the main file's bytes are the same after the read, and the store opens and takes writes afterwards as before",
        !!gotW && gotW.candidates.length === 0 && mainAfterRead === mainBefore && tablesAfter === "incidents", JSON.stringify([gotW, tablesAfter, mainAfterRead === mainBefore]));
      check("W24c and its content is what it was", rowsAfter === "INC-1" && tablesAfter === "incidents" && writable, JSON.stringify([rowsAfter, tablesAfter, writable]));
    }
    check("W24 the check writes nothing into the agent's store: one without the candidates table has none afterwards, and its bytes are the same", got && got.candidates.length === 0 && tables.join() === "incidents" && rf(file).toString("hex") === before, JSON.stringify([got, tables]));
    rmSync(dir, { recursive: true, force: true });
  }
  // One seed with its own height, one that answers as another key (and lists that key with a height), one that does not
  // list itself; the store keeps no candidates. The agent has one seed height, its watch counts no round, and it would
  // publish unknown. Before the round's reference followed the agent's read rule, this check counted the other key's
  // height as a second seed height, named candidates from its own round and said OK.
  const ALIAS = agentSeed(K("b9"));
  const mixed = await errOut({ agentSource: conf([["seed-a", G1, K("a1")], ["seed-alias", ALIAS, K("a4")], ["seed-noself", NOSELF, K("a3")]]) }), mixedDial = Object.assign(await runOut(["--dial"], { agentSource: conf([["seed-a", G1, K("a1")], ["seed-alias", ALIAS, K("a4")], ["seed-noself", NOSELF, K("a3")]]) }));
  check("W9x a height from a seed that answers as another key is not a seed height here either: the round does not count, no candidate is named, exit 3",
    mixedDial.code === 3 && mixedDial.text.includes("  seeds' median: not known (fewer than two own heights): heights not compared") && mixedDial.text.includes("  candidates: none (this run's validator round did not count, and the agent keeps none here)")
    && mixedDial.text.trim().endsWith("AGENT READS FAILED: 1 of the 3 seeds that answered gave its own height, and the agent needs two, or validators that stand in (the agent keeps no candidates here). Do not restart on this.") && mixed.code === 3,
    mixedDial.code + " | " + mixedDial.text.split("\n").filter((l) => /median|candidates|AGENT/.test(l)).join(" | "));
  ALIAS.stop(true);
  // Text a peer chose is not echoed: a field name, a status or a result that carries an address.
  const HOSTILE = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ identity: K("f1"), "peer at 10.9.8.7:53550": 1, version: "0.9.9 RC", peerlist: [{ identity: K("f1"), sync: { block: 7000 }, "http://10.9.8.7": { "10.9.8.7": 1, port: 2 } }] });
    const msg = (await req.json()).params[0].message;
    return Response.json(msg === "getValidators" ? { result: 200, response: [{ address: K("c7"), status: "http://10.9.8.7:53550", connectionUrl: null, "url 10.9.8.7:53550": 1 }] } : { result: "see 10.9.8.7", response: null });
  } });
  const hostile = await runOut(["seed-x=" + url(HOSTILE)], { agentReads: false });
  check("W10x a field name, a status or a result that is not a plain name, a status or a number is counted, not printed", !/10\.9\.8\.7/.test(hostile.text) && hostile.text.includes("keys: identity, peerlist, version, (1 other name not printed)")
    && hostile.text.includes("peerlist entry keys: identity, sync{block}, (1 other name not printed)") && hostile.text.includes('status "(not a status code)": 1') && hostile.text.includes("no answer (result not a status code)")
    && hostile.text.includes("row keys: status, address, connectionUrl, (1 other name not printed)"), hostile.text.split("\n").slice(0, 8).join(" | "));
  check("W10b of a peer's field names only those DNO itself reads are printed; any other is counted, however plain it looks", JSON.stringify(keysOf({ version_name: 1, identity: 2, peerlist: [] })) === JSON.stringify(["identity", "peerlist", "(1 other name not printed)"])
    && JSON.stringify(keysOf({ call: 1, this: 1, number: 1, now: 1 })) === JSON.stringify(["(4 other names not printed)"]) && keysOf(null).length === 0 && keysOf([1]).length === 0
    && keysOf(Object.fromEntries(Array.from({ length: 60000 }, (_, i) => ["n" + i, 1]))).join().length < 60);
  // A peer cannot make the report long, or make it print a method of Object, a long number or a number that is not a code.
  const LOUD = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ identity: K("f1"), version: "0.9.9 RC", peerlist: [{ identity: K("f1"), sync: { block: 7000 } }] });
    const msg = (await req.json()).params[0].message;
    if (msg === "getNetworkParameters") return Response.json({ result: 200, response: { minValidatorStake: "9".repeat(50000) } });
    return Response.json({ result: 200, response: ["toString", "constructor", "2", "3", "0", "11", "12", "13", "14", "15", "16", "17"].map((st, i) => ({ address: K((0x30 + i).toString(16)), status: st, connectionUrl: null })) });
  } });
  const HUGE = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { return req.method === "GET" ? new Response("x", { status: 500 }) : Response.json({ result: 1e21, response: null }); } });
  const loud = await runOut(["seed-x=" + url(LOUD), "seed-y=" + url(HUGE)], { agentReads: false });
  check("W10c a status named like a method prints as 'not a status code', never as code; at most 8 kinds of status are named; a stake of 50,000 digits is an unexpected shape; a result that is not a small whole number is not printed",
    !/function|native code|\[object/.test(loud.text) && loud.text.includes('status "(not a status code)": 2') && loud.text.includes('status "(more kinds)": ') && (loud.text.match(/status "/g) || []).length <= 9
    && !/9{100}/.test(loud.text) && loud.text.includes("seed-x: getNetworkParameters: no minValidatorStake digit string of at most 78 digits") && !/1e\+21/.test(loud.text) && loud.text.includes("no answer (result not a status code)")
    && loud.text.length < 3000, loud.text.length + " | " + loud.text.split("\n").filter((l) => /getValidators|getNetworkParameters/.test(l)).join(" | ").slice(0, 600));
  LOUD.stop(true); HUGE.stop(true);
  HOSTILE.stop(true);
  const unread = await errOut({ agentSource: conf([["seed-a", G1, K("a1")], ["seed-b", 'BASE + "/x"', K("a2")]]) });
  check("W8 a configured seed the check cannot read in full: exit 64 before any read, and it says how many", unread.code === 64 && unread.text === "" && unread.err === "src/agent.mjs configures 2 seeds; 1 could be read with a url and an identity. The pre-restart check needs all of them.", JSON.stringify(unread));
  const noBlock = await errOut({ agentSource: "const OTHER = {};" });
  check("W8b a source with no seed configuration: exit 64, said plainly", noBlock.code === 64 && noBlock.err === "The seeds could not be read from src/agent.mjs: it has no PUBLIC_NODES block.", JSON.stringify(noBlock));
  const plain = await runOut(pair(G1, G2), { agentReads: false });
  check("W6 the plain probe (no agent reads) prints no verdict and keeps its exit codes", plain.code === 0 && !/AGENT READS/.test(plain.text) && !/Watch \(/.test(plain.text));
  // The store the check reads by default: marketplace.db in the agent's log folder (LOG_DIR, as the agent reads it).
  {
    const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const { Database } = await import("bun:sqlite"), { createCandidateStore } = await import("./witnesses.mjs");
    const dir = mkdtempSync(join(tmpdir(), "dno-logdir-")), db = new Database(join(dir, "marketplace.db"));
    createCandidateStore(db).save([cand(K("c7"), val)], Date.now() - 60000); db.close();
    const was = process.env.LOG_DIR; process.env.LOG_DIR = dir;
    let byDefault; try { byDefault = await runOut(["--dial", ...pair(G1, DOWN)], { kept: undefined }); } finally { if (was === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = was; }
    check("W35 by default the check reads the candidates the agent keeps from marketplace.db in its log folder: one seed down, the kept validator stands in, exit 0", byDefault.code === 0
      && byDefault.text.includes("  candidates: 1, kept by the agent from the list two seeds agreed on at ") && byDefault.text.trim().split("\n").pop().startsWith("AGENT READS OK: 1 of 2 seeds gave its own height, and 1 validator"), byDefault.code + " | " + byDefault.text.split("\n").slice(-4).join(" | "));
    rmSync(dir, { recursive: true, force: true });
  }
  const hung = await hangRead;
  check("G6 a seed that never answers is given the agent's own five seconds, and is then 'no answer (timeout)'", hung.r.ok === false && hung.r.error === "timeout" && hung.ms >= 4500 && hung.ms < 9000 && agentSeedLine(hung.r) === "seed-hang  no answer (timeout)", JSON.stringify(hung));
  [G1, G2, NOSELF, OTHERKEY, DOWN, DIFF, val, HANG].forEach((x) => x.stop(true));
}

[A, B, C, E].forEach((s) => s.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
