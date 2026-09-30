// validator-set-probe.test.mjs — VALIDATOR_SET_PROBE guard: the named test's tool reads what it should and prints
// nothing it must not. Runs tools/validator-set-probe.mjs against local synthetic seeds (Bun.serve on loopback).
// Rules under test: the SDK's nodeCall wire format; counts by status; a value only when at least two seeds report it
// and all that report it agree; no host, address, connectionUrl, stake or full key in the output; unexpected shapes
// are reported and make the tool exit non-zero.
// Run: bun src/validator-set-probe.test.mjs   (executable harness, not `bun test`)

import { probeSeed, formatReport, summarize, seedsFromAgent, dialReport, firstSeenAgreement, firstSeenValue } from "../tools/validator-set-probe.mjs";
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

[A, B, C, E].forEach((s) => s.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
