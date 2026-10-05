// seed-read.test.mjs — SEED_READ guard: one seed's /info read and what the answer says (src/seed-read.mjs).
// The agent's public round and the pre-restart check call the same readSeedInfo, so these checks cover both.
// As in the agent, the global fetch is replaced before DNO's modules load (the Demos SDK does that at import): the
// seed read must not depend on it. Synthetic identities and loopback servers only.
// Run: bun src/seed-read.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TAG = "SEED_READ";
const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const runtimeGlobal = globalThis.fetch;
globalThis.fetch = () => { throw new Error("the global fetch must not be used for a seed read"); };
const { readSeedInfo, seedsSufficient } = await import("./seed-read.mjs");

const KEY = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const SEED = KEY(0xa2), OTHER = KEY(0xb7), PEER = KEY(0x11);
const hits = {};
// A server whose answer to GET /info is set per test.
function server(answer) {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { hits[srv.port] = (hits[srv.port] || 0) + 1; return answer(req); } });
  return { srv, url: "http://127.0.0.1:" + srv.port, node: { url: "http://127.0.0.1:" + srv.port, identity: SEED }, hits: () => hits[srv.port] || 0 };
}
const info = (body) => () => Response.json(body);
const all = [];
const s = (answer) => { const x = server(answer); all.push(x.srv); return x; };

console.log("\n[" + TAG + "] what an answer says");
{
  const self = s(info({ identity: SEED, version: "0.9.9 RC", peerlist: [{ identity: PEER, sync: { block: 4960 } }, { identity: SEED.toUpperCase().replace("0X", "0x"), sync: { block: 5000 } }] }));
  const r = await readSeedInfo(self.node);
  check("A1 a seed that lists itself: its own height, height_source self, identity matches, version and peer count",
    r.ok === true && r.block === 5000 && r.height_source === "self" && r.identityMatch === true && r.version === "0.9.9 RC" && r.peers === 2 && Number.isFinite(r.latencyMs), JSON.stringify(r).slice(0, 240));
  check("A2 the peerlist and the answering identity are returned for the catalog intake", Array.isArray(r.peerlist) && r.peerlist.length === 2 && r.answeredId === SEED);
  // One node that writes its key in another letter case on a second URL is one node: the intake gets one name for it.
  const shouted = s(info({ identity: SEED.toUpperCase().replace("0X", "0x"), peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
  const sh = await readSeedInfo(shouted.node);
  check("A2b the answering identity is given in lower case, whatever case the node wrote it in: one node answering in two letter cases is one peerlist for the catalog intake",
    SEED === SEED.toLowerCase() && sh.ok === true && sh.answeredId === SEED && sh.answeredId === r.answeredId && sh.identityMatch === true, JSON.stringify([sh.answeredId, sh.identityMatch]));

  const versions = [];
  for (const v of ["0.9.8", "v1.2", "1.0.0-beta.2", "203.0.113.9:53550", "node7.example:53550", "10.0.0.8", "<b>x</b>", "testnet build of Tuesday", "", 7, null]) {
    const srv = s(info({ identity: SEED, version: v, peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
    versions.push((await readSeedInfo(srv.node)).version);
  }
  check("A1b a seed's version is published only when it reads as a release version, by the validators' rule: an address, a host name, markup or free text is '?'",
    JSON.stringify(versions) === JSON.stringify(["0.9.8", "v1.2", "1.0.0-beta.2", "?", "?", "?", "?", "?", "?", "?", "?"]), JSON.stringify(versions));

  const first = s(info({ identity: SEED, peerlist: [{ identity: PEER, sync: { block: 4960 } }] }));
  const f = await readSeedInfo(first.node);
  check("A3 a seed that does not list itself: its first listed peer's height, marked first_peer (counted nowhere)", f.ok === true && f.block === 4960 && f.height_source === "first_peer" && f.identityMatch === true, JSON.stringify(f).slice(0, 200));

  const other = s(info({ identity: OTHER, peerlist: [{ identity: SEED, sync: { block: 5000 } }, { identity: OTHER, sync: { block: 5001 } }] }));
  const o = await readSeedInfo(other.node);
  check("A4 an answer that names another key is not this seed's: no height at all, identityMatch false, and that key goes to the intake",
    o.ok === true && o.block === null && o.height_source === null && o.identityMatch === false && o.answeredId === OTHER, JSON.stringify(o).slice(0, 200));

  const noid = s(info({ peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
  const n = await readSeedInfo(noid.node);
  check("A5 an answer that names no identity: identityMatch null, the own entry still gives the height", n.ok === true && n.identityMatch === null && n.block === 5000 && n.height_source === "self" && n.answeredId === null, JSON.stringify(n).slice(0, 200));

  const hostile = s(info({ identity: SEED, version: "<script>alert(1)</script>" + "x".repeat(80), peerlist: [{ identity: SEED, sync: { block: "<b>9</b>" } }, { identity: PEER, sync: { block: -4 } }] }));
  const h = await readSeedInfo(hostile.node);
  check("A6 markup as a height gives no height; a version label is sanitized and bounded", h.ok === true && h.block === null && h.height_source === null && !/[<>]/.test(h.version) && h.version.length <= 32, JSON.stringify(h).slice(0, 200));

  // One key form for every comparison (keyOf: trimmed, lower case, 0x or not), the form the validator watch compares in.
  const bare = SEED.slice(2), forms = [SEED, bare, SEED.toUpperCase().replace("0X", "0x"), bare.toUpperCase(), "  " + SEED + " ", "0X" + bare];
  const got = [];
  for (const configured of [SEED, bare, bare.toUpperCase()]) for (const answered of forms) for (const listed of [SEED, bare.toUpperCase()]) {
    const x = s(info({ identity: answered, peerlist: [{ identity: PEER, sync: { block: 4960 } }, { identity: listed, sync: { block: 5000 } }] }));
    const r8 = await readSeedInfo({ url: x.url, identity: configured });
    got.push(r8.ok === true && r8.identityMatch === true && r8.block === 5000 && r8.height_source === "self");
  }
  check("A8 the configured key, the key the answer names and the key of the own entry are compared in one form: 0x or not, any letter case, blanks around (36 combinations, each its own height)",
    got.length === 36 && got.every(Boolean), JSON.stringify(got));
  const near = s(info({ identity: SEED.slice(0, -1) + "3", peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
  const short = s(info({ identity: "abc", peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
  const n9 = await readSeedInfo(near.node), s9 = await readSeedInfo(short.node);
  check("A9 an answer that names any other key, one character apart or a short one, is another node's: no height, identityMatch false; a name that is not an identity does not go to the intake",
    n9.identityMatch === false && n9.block === null && n9.height_source === null && s9.identityMatch === false && s9.block === null && s9.answeredId === null, JSON.stringify([n9, s9]).slice(0, 300));
  const outs = [];
  for (const odd of [5, null, { a: 1 }, ["0x"], "", "<b>" + bare, "x".repeat(200)]) {
    const x = s(info({ identity: odd, peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
    const r10 = await readSeedInfo(x.node);
    outs.push(r10.ok === true && r10.identityMatch === null && r10.answeredId === null && r10.block === 5000 && r10.height_source === "self");
  }
  check("A10 an identity that is no key at all (a number, null, an object, markup, 200 characters) names none: identityMatch null, never true", outs.length === 7 && outs.every(Boolean), JSON.stringify(outs));
  const unkeyed = s(info({ identity: SEED, peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
  const u = await readSeedInfo({ url: unkeyed.url, identity: undefined }), u2 = await readSeedInfo({ url: unkeyed.url, identity: "" });
  const named = s(info({ identity: "undefined", peerlist: [{ identity: "undefined", sync: { block: 5000 } }] }));
  const u3 = await readSeedInfo({ url: named.url, identity: undefined }), u4 = await readSeedInfo({ url: named.url });
  check("A11 a node configured without a key matches nothing: the answer names another key, so no height, also when the answer names itself \"undefined\"",
    u.identityMatch === false && u.block === null && u2.identityMatch === false && u2.block === null && u3.identityMatch === false && u3.block === null && u4.identityMatch === false && u4.height_source === null, JSON.stringify([u, u2, u3, u4]).slice(0, 400));

  const empty = s(info({ identity: SEED }));
  const e = await readSeedInfo(empty.node);
  check("A7 no peerlist: answered, no height, zero peers", e.ok === true && e.block === null && e.peers === 0 && e.peerlist.length === 0);
}

console.log("\n[" + TAG + "] when there is no answer to read (never throws, a category only)");
{
  const down = s(() => new Response("down", { status: 503 }));
  const d = await readSeedInfo(down.node);
  check("B1 HTTP 503: not ok, the status as the category", d.ok === false && d.error === "HTTP 503" && d.status === 503, JSON.stringify(d));

  const target = s(info({ identity: SEED, peerlist: [{ identity: SEED, sync: { block: 5000 } }] }));
  const redir = s(() => new Response(null, { status: 301, headers: { Location: target.url + "/info" } }));
  const r = await readSeedInfo(redir.node);
  check("B2 a redirect is not followed: HTTP 301, and the address it points at is never requested", r.ok === false && r.error === "HTTP 301" && target.hits() === 0 && redir.hits() === 1, JSON.stringify([r, target.hits(), redir.hits()]));

  const loop = s((req) => new Response(null, { status: 302, headers: { Location: new URL(req.url).origin + "/info" } }));
  const l = await readSeedInfo(loop.node);
  check("B3 a redirect loop costs one request", l.ok === false && l.error === "HTTP 302" && loop.hits() === 1, JSON.stringify([l, loop.hits()]));

  const text = s(() => new Response("not json", { headers: { "content-type": "application/json" } }));
  const t = await readSeedInfo(text.node);
  check("B4 a body that is not JSON: invalid response", t.ok === false && t.error === "invalid response", JSON.stringify(t));

  const big = s(() => new Response(JSON.stringify({ identity: SEED, pad: "x".repeat(70000) })));
  const b = await readSeedInfo(big.node, { maxBytes: 65536 });
  check("B5 a body past the cap: response too large", b.ok === false && b.error === "response too large", JSON.stringify(b));

  const slow = s(() => new Promise(() => {}));
  const t0 = Date.now(), w = await readSeedInfo(slow.node, { timeoutMs: 300 });
  check("B6 no headers before the timeout: timeout, at the timeout", w.ok === false && w.error === "timeout" && Date.now() - t0 < 2000, JSON.stringify([w, Date.now() - t0]));

  const freed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }), nobody = "http://127.0.0.1:" + freed.port; freed.stop(true);   // a port nothing listens on
  const gone = await readSeedInfo({ url: nobody, identity: SEED });
  check("B7 nothing listening: connection failed", gone.ok === false && gone.error === "connection failed", JSON.stringify(gone));

  const broken = await readSeedInfo({ url: "http://127.0.0.1:" + all[0].port, identity: SEED }, { fetch: () => { throw new TypeError("resp.body.getReader is not a function"); } });
  check("B8 a fault in DNO's own read is an internal error, not the seed's connection failing", broken.ok === false && broken.error === "internal error", JSON.stringify(broken));
  check("B9 no result carries runtime text or an address", [d, r, l, t, b, w, gone, broken].every((x) => !/127\.0\.0\.1|Unable|socket|getReader/.test(JSON.stringify(x))));
}

console.log("\n[" + TAG + "] enough seeds to publish a status");
{
  const own = (h) => ({ ok: true, block: h, height_source: "self" }), fp = (h) => ({ ok: true, block: h, height_source: "first_peer" }), no = { ok: false, error: "HTTP 503" };
  const q = (...r) => { const x = seedsSufficient(r); return [x.answered, x.ownHeights, x.sufficient, x.reason].join(); };
  check("C1 two seeds with their own height, one down: sufficient", q(own(5000), own(5001), no) === "2,2,true,");
  check("C2 one seed answered: too_few_answers", q(own(5000), no, no) === "1,1,false,too_few_answers");
  check("C3 no seed answered: too_few_answers", q(no, no, no) === "0,0,false,too_few_answers");
  check("C4 two answered, one own height (the other is a first-peer height): too_few_heights", q(own(5000), fp(4960), no) === "2,1,false,too_few_heights");
  check("C5 two answered, neither lists itself: too_few_heights", q(fp(4960), fp(4961), fp(4962)) === "3,0,false,too_few_heights");
  check("C6 an own height that is not a height does not count", q(own("<b>"), own(5000), own(null)) === "3,1,false,too_few_heights");
  check("C7 the agent's publicNodes rows are accepted as they are", seedsSufficient([{ name: "a", ok: true, block: 5, height_source: "self", latencyMs: 3 }, { name: "b", ok: true, block: 6, height_source: "self" }]).sufficient === true);
}

console.log("\n[" + TAG + "] the sources: the agent and the pre-restart check use this module");
{
  const AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8"), PROBE = readFileSync(join(__dir, "..", "tools", "validator-set-probe.mjs"), "utf8");
  check("D1 the agent's public round reads each seed with readSeedInfo and takes its data-quality reason from seedsSufficient",
    /await readSeedInfo\(node, \{ timeoutMs: 5000, maxBytes: INFO_BODY_MAX_BYTES \}\)/.test(AGENT) && /dataQualityReason = seedsSufficient\(publicNodes\)\.reason;/.test(AGENT)
    && !/selfEntry|peerlist\[0\]\.sync/.test(AGENT.slice(AGENT.indexOf("async function probePublicNodes()"), AGENT.indexOf("\n}\n", AGENT.indexOf("async function probePublicNodes()")))));
  check("D1b the agent hands the catalog the answering node's peerlist under the identity that answer named (one node answering two URLs is one peerlist)",
    /catalogIngestPeerlist\(r\.answeredId \|\| \("seed:" \+ name\), r\.peerlist\);/.test(AGENT));
  check("D2 the pre-restart check reads with readSeedInfo and judges with seedsSufficient", /readSeedInfo\(/.test(PROBE) && /seedsSufficient\(/.test(PROBE) && !/cappedJson\(seed\.url/.test(PROBE));
}

all.forEach((x) => x.stop(true));
globalThis.fetch = runtimeGlobal;
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
