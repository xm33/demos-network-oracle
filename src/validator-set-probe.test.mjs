// validator-set-probe.test.mjs — VALIDATOR_SET_PROBE guard: the named test's tool reads what it should and prints
// nothing it must not. Runs tools/validator-set-probe.mjs against local synthetic seeds (Bun.serve on loopback).
// Rules under test: the SDK's nodeCall wire format; counts by status; a value only when at least two seeds report it
// and all that report it agree; no host, address, connectionUrl, stake or full key in the output; unexpected shapes
// are reported and make the tool exit non-zero.
// Run: bun src/validator-set-probe.test.mjs   (executable harness, not `bun test`)

import { probeSeed, formatReport, summarize, seedsFromAgent } from "../tools/validator-set-probe.mjs";
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

[A, B, C, E].forEach((s) => s.stop(true));
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
