// runtime-fetch.test.mjs — RUNTIME_FETCH guard: DNO's capped reads use the runtime's fetch, never the global one, and
// every capped read stops receiving when it ends.
//
// Importing the Demos SDK replaces globalThis.fetch (@bundlr-network/client -> near-api-js/lib/connect.js sets it to
// its node-fetch import): its bodies are Node streams, which readJsonCapped cannot read. On 2026-10-01 that made the deployed
// agent read 0 of 3 seeds and no validator list while the seeds were answering. The agent imports the SDK BEFORE DNO's
// own modules, so this suite replaces the global first and only then loads them (a nativeFetch captured from the global
// at load would fail here), and it runs the pre-restart check in a child process that loads the real SDK first.
//
// Cancelling a body does not make the runtime stop receiving it: a response that is not read to its end must have its
// request aborted, or a peer can make DNO buffer gigabytes until the timeout. cappedJson aborts on every path.
// Run: bun src/runtime-fetch.test.mjs   (executable harness, not `bun test`)

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TAG = "RUNTIME_FETCH";
const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- first, what the SDK's import does: replace the global fetch with one whose bodies are Node streams -------------
const runtimeGlobal = globalThis.fetch;
const nodeStreamFetch = async (input, init) => {
  const r = await runtimeGlobal(input, init);
  return { ok: r.ok, status: r.status, headers: r.headers, body: r.body ? Readable.fromWeb(r.body) : null, json: () => r.json(), text: () => r.text() };
};
globalThis.fetch = nodeStreamFetch;
// ---- only now DNO's modules, as in the agent (SDK first, then these) -------------------------------------------------
const { cappedJson, readJsonCapped, parseProbeOrigin } = await import("./public-safety.mjs");
const { runValidatorRound, createWatchHistory } = await import("./validator-watch.mjs");

const KEY = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const ROWS = [1, 2, 3].map((n) => ({ address: KEY(n), status: "2", connectionUrl: "" }));
// A seed: /info, and the two nodeCalls the validator read makes.
function seed(key) {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") return Response.json({ identity: key, peerlist: [{ identity: key, sync: { block: 5000 } }] });
    const msg = (await req.json()).params[0].message;
    return Response.json({ result: 200, response: msg === "getValidators" ? ROWS : { minValidatorStake: "1000" } });
  } });
  return { srv, url: "http://127.0.0.1:" + srv.port };
}
const A = seed(KEY(9)), B = seed(KEY(8));
const loopResolver = async (u) => { const p = parseProbeOrigin(u); return p && p.hostname === "127.0.0.1" ? "http://127.0.0.1:" + p.port : null; };
const infoRead = (url) => cappedJson(url + "/info", null, { timeoutMs: 3000, maxBytes: 4096 });
const round = () => runValidatorRound({ seeds: [{ name: "a", url: A.url }, { name: "b", url: B.url }], resolveOrigin: loopResolver, reference: () => null,
  history: createWatchHistory(60000, 5000), dials: false });

console.log("\n[" + TAG + "] the global fetch was replaced before DNO's modules loaded");
// A read that throws is a failed check, not a crashed suite.
const attempt = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e && (e.name + ": " + e.message)).slice(0, 160) }; } };
// A read that never ends is a failed check too, not a suite that hangs: how a read ended, or "hung" after ms.
const ended = (promise, ms) => Promise.race([promise.then(() => "read", (e) => (e && e.name) || "error"), sleep(ms).then(() => "hung")]);
const base = await attempt(() => infoRead(A.url));
check("R1 cappedJson reads with the runtime's fetch: status, ok, a time to headers, the parsed body", base.status === 200 && base.ok === true && base.data.identity === KEY(9) && Number.isFinite(base.headersMs), JSON.stringify(base).slice(0, 200));
const viaGlobal = await globalThis.fetch(A.url + "/info");
let globalRead = "read";
try { await readJsonCapped(viaGlobal, 4096); } catch (e) { globalRead = e && e.name; }
check("R2 the hazard is real here: the global's body is a Node stream, and readJsonCapped cannot read it", typeof viaGlobal.body.getReader !== "function" && globalRead === "TypeError", globalRead);
globalThis.fetch = () => { throw new Error("the global fetch must not be used for DNO's reads"); };
const r = await round();
check("R4 a validator round with its default fetch reads both seeds' lists while the global fetch throws",
  r.list.agreed === true && r.list.seedsAgreed === 2 && r.counts.active === 3 && r.seedErrors.every((e) => e.list === null), JSON.stringify([r.list.reason, r.seedErrors]));
const non2xx = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{\"a\":1}", { status: 503 }) });
const st = await attempt(() => cappedJson("http://127.0.0.1:" + non2xx.port + "/", null, { timeoutMs: 3000, maxBytes: 4096 }));
const st2 = await attempt(() => cappedJson("http://127.0.0.1:" + non2xx.port + "/", null, { timeoutMs: 3000, maxBytes: 4096, read: () => true }));
check("R5 a status that is not read gives no data; read(status) decides", st.status === 503 && st.ok === false && st.data === undefined && !!st2.data && st2.data.a === 1, JSON.stringify([st, st2]).slice(0, 300));
non2xx.stop(true);
{
  // What a capped request carries, whatever the caller passes: identity encoding, the caller's own headers, no redirect
  // followed, no automatic decompression.
  const seen = [];
  const echo = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { seen.push({ ae: req.headers.get("accept-encoding"), ct: req.headers.get("content-type"), conn: req.headers.get("connection"), method: req.method }); return Response.json({ ok: 1 }); } });
  const e = "http://127.0.0.1:" + echo.port + "/";
  await attempt(() => cappedJson(e, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }, { timeoutMs: 3000 }));
  await attempt(() => cappedJson(e, { headers: { "Accept-Encoding": "gzip, br" }, redirect: "follow", decompress: true }, { timeoutMs: 3000 }));
  await attempt(() => cappedJson(e, { headers: { "accept-encoding": "gzip", "connection": "keep-alive" }, keepalive: true, signal: AbortSignal.abort() }, { timeoutMs: 3000 }));
  check("R5b the caller's headers are sent, and identity encoding and Connection: close are kept even when the caller names others, in any letter case; a caller's signal is not used",
    seen.length === 3 && seen[0].method === "POST" && seen[0].ct === "application/json" && seen.every((x) => x.ae === "identity" && x.conn === "close"), JSON.stringify(seen));
  // What the runtime's fetch is handed, whatever the caller passes (a recording fetch in its place): each fixed option
  // on its own, since the runtime reads the Connection header before the keepalive option and one hides the other.
  const handed = [], mine = AbortSignal.abort();
  const recording = async (u, init) => { handed.push(init); return Response.json({ ok: 1 }); };
  await attempt(() => cappedJson(e, { keepalive: true, decompress: true, redirect: "follow", signal: mine, headers: { CONNECTION: "keep-alive", "ACCEPT-ENCODING": "br" } }, { timeoutMs: 3000, fetch: recording }));
  await attempt(() => cappedJson(e, null, { timeoutMs: 3000, fetch: recording }));
  check("R5e the request handed to the runtime: keepalive false, decompress false, redirect manual, this read's own signal, identity encoding and Connection: close, with or without a caller's init",
    handed.length === 2 && handed.every((h) => h.keepalive === false && h.decompress === false && h.redirect === "manual" && h.signal instanceof AbortSignal && h.signal !== mine
      && h.headers.get("accept-encoding") === "identity" && h.headers.get("connection") === "close"),
    JSON.stringify(handed.map((h) => [h.keepalive, h.decompress, h.redirect, h.signal !== mine, h.headers.get("accept-encoding"), h.headers.get("connection")])));
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { seen.push("target"); return Response.json({ secret: 1 }); } });
  const hop = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response(null, { status: 301, headers: { Location: "http://127.0.0.1:" + target.port + "/" } }); } });
  const viaHop = await attempt(() => cappedJson("http://127.0.0.1:" + hop.port + "/", { redirect: "follow" }, { timeoutMs: 3000 }));
  check("R5c a redirect is never followed, also when the caller asks: the 301 is the status, and the address it points at is not requested",
    viaHop.status === 301 && viaHop.ok === false && viaHop.data === undefined && !seen.includes("target"), JSON.stringify(viaHop).slice(0, 200));
  const gz = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response(Bun.gzipSync(Buffer.from(JSON.stringify({ a: "x".repeat(200000) }))), { headers: { "content-encoding": "gzip", "content-type": "application/json" } }); } });
  const bomb = await attempt(() => cappedJson("http://127.0.0.1:" + gz.port + "/", { decompress: true }, { timeoutMs: 3000, maxBytes: 4096 }));
  check("R5d a small compressed body that expands past the cap is refused (the runtime does not expand it first)", bomb.threw && bomb.threw.startsWith("ResponseTooLarge"), JSON.stringify(bomb).slice(0, 200));
  [echo, target, hop, gz].forEach((x) => x.stop(true));
}
globalThis.fetch = nodeStreamFetch;

console.log("\n[" + TAG + "] a capped read stops receiving");
// A peer that never stops sending, on a raw socket so what the socket accepted and when it closed are known exactly.
// The peer itself stops at FLOOD_LIMIT and marks the run (capped): if a read here ever fails to stop receiving, this
// suite must fail, not fill the memory of the host it runs on (it runs on the production host before a restart).
const FLOOD_LIMIT = 64 * 1048576;
const COMPLETE = JSON.stringify({ identity: KEY(7), peerlist: [{ identity: KEY(7), sync: { block: 7000 } }] });
const floods = [];
function flood(mode) {
  const st = { accepted: 0, closedAt: null, openedAt: null, capped: false };
  const server = net.createServer((c) => {
    st.openedAt = Date.now();
    // The client's end of the connection is over when it sends FIN ("end"), or the socket closes or errors. The server
    // keeps reading so that it notices.
    const over = () => { if (st.closedAt === null) st.closedAt = Date.now(); };
    c.on("error", over); c.on("close", over); c.on("end", over); c.on("data", () => {});
    c.once("data", () => {
      const chunk = Buffer.alloc(256 * 1024, 0x20);
      // "complete": a whole small answer (its length declared, the connection left open), and then the peer goes on sending.
      if (mode === "complete") c.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + COMPLETE.length + "\r\n\r\n" + COMPLETE);
      else if (mode === "declared") c.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 107374182400\r\n\r\n");
      else if (mode === "endless") c.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n");
      else if (mode === "chunked") c.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n");
      else c.write("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n");
      const frame = mode === "chunked" ? Buffer.concat([Buffer.from(chunk.length.toString(16) + "\r\n"), chunk, Buffer.from("\r\n")]) : chunk;
      const pump = () => {
        if (st.closedAt !== null || c.destroyed) return;
        for (;;) {
          if (st.accepted >= FLOOD_LIMIT) { st.capped = true; c.destroy(); return; }
          const ok = c.write(frame); st.accepted += frame.length;
          if (!ok) { c.once("drain", pump); return; }
        }
      };
      pump();
    });
  });
  floods.push(server);
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ st, url: "http://127.0.0.1:" + server.address().port })));
}
const MB = 1048576;
for (const [mode, want] of [["declared", "ResponseTooLarge"], ["endless", "ResponseTooLarge"], ["chunked", "ResponseTooLarge"], ["status503", "status 503"]]) {
  const f = await flood(mode), t0 = Date.now();
  let got;
  try { const res = await cappedJson(f.url + "/info", { redirect: "manual" }, { timeoutMs: 5000, maxBytes: 2 * MB, read: (s) => s === 200 }); got = "status " + res.status; } catch (e) { got = e && e.name; }
  const took = Date.now() - t0;
  for (let i = 0; i < 30 && f.st.closedAt === null; i++) await sleep(50);          // up to 1.5 s for the close to arrive
  const closedAfter = f.st.closedAt === null ? null : f.st.closedAt - t0;
  check("R6 " + mode + ": the read ends as " + want + " well before the timeout, the connection is closed, and little was received",
    got === want && took < 2500 && closedAfter !== null && closedAfter < 3000 && !f.st.capped && f.st.accepted < 48 * MB,
    JSON.stringify({ got, took_ms: took, closed_after_ms: closedAfter, accepted_MB: Math.round(f.st.accepted / MB), peer_gave_up: f.st.capped }));
}
// A call that names no cap, or no timeout, is still capped and still ends.
{
  const f = await flood("endless"), t0 = Date.now();
  const got = await ended(cappedJson(f.url + "/info"), 8000);
  for (let i = 0; i < 30 && f.st.closedAt === null; i++) await sleep(50);
  check("R6b a read with no options is capped at the default (2 MB) and closes its connection", got === "ResponseTooLarge" && f.st.closedAt !== null && Date.now() - t0 < 3000 && !f.st.capped && f.st.accepted < 48 * MB,
    JSON.stringify({ got, closed: f.st.closedAt !== null, accepted_MB: Math.round(f.st.accepted / MB), peer_gave_up: f.st.capped }));
  const silent = net.createServer(() => {}); floods.push(silent);
  await new Promise((res) => silent.listen(0, "127.0.0.1", res));
  const t1 = Date.now(), slow = await ended(cappedJson("http://127.0.0.1:" + silent.address().port + "/info", null, { timeoutMs: 400 }), 6000);
  check("R6c a peer that accepts and says nothing ends as TimeoutError at the timeout", slow === "TimeoutError" && Date.now() - t1 >= 380 && Date.now() - t1 < 2000, JSON.stringify({ slow, ms: Date.now() - t1 }));
  // Headers at once, then a body that never comes: the timeout covers the body too.
  const st = { closedAt: null };
  const stall = net.createServer((c) => { const over = () => { if (st.closedAt === null) st.closedAt = Date.now(); }; c.on("error", over); c.on("close", over); c.on("end", over); c.on("data", () => {});
    c.once("data", () => c.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{\"a\":")); }); floods.push(stall);
  await new Promise((res) => stall.listen(0, "127.0.0.1", res));
  const t2 = Date.now(), stalled = await ended(cappedJson("http://127.0.0.1:" + stall.address().port + "/info", null, { timeoutMs: 500 }), 6000);
  const took = Date.now() - t2;
  for (let i = 0; i < 30 && st.closedAt === null; i++) await sleep(50);
  check("R6d a body that stalls after the headers ends as TimeoutError at the timeout, and the connection is closed", stalled === "TimeoutError" && took >= 480 && took < 2500 && st.closedAt !== null, JSON.stringify({ stalled, took, closed: st.closedAt !== null }));
}
// A read that ended well leaves no connection behind either. The runtime keeps a connection for the next request to the
// same address unless the request says otherwise, and goes on taking what the peer sends on it: a peer that answers a
// whole small response and then keeps sending would fill DNO's memory after the read had returned its data.
{
  const f = await flood("complete"), t0 = Date.now();
  const res = await attempt(() => cappedJson(f.url + "/info", null, { timeoutMs: 5000, maxBytes: 2 * MB }));
  const took = Date.now() - t0;
  for (let i = 0; i < 30 && f.st.closedAt === null; i++) await sleep(50);
  const closedAfter = f.st.closedAt === null ? null : f.st.closedAt - t0;
  check("R6f complete: the read returns the answer, and the connection is closed at once though the peer goes on sending (little was received)",
    res.status === 200 && !!res.data && res.data.identity === KEY(7) && took < 2500 && closedAfter !== null && closedAfter < 1500 && !f.st.capped && f.st.accepted < 48 * MB,
    JSON.stringify({ got: res.threw || res.status, took_ms: took, closed_after_ms: closedAfter, accepted_MB: Math.round(f.st.accepted / MB), peer_gave_up: f.st.capped }));
  // And when the caller asks for a kept connection, it is still not kept.
  const g = await flood("complete"), t1 = Date.now();
  const res2 = await attempt(() => cappedJson(g.url + "/info", { keepalive: true, headers: { Connection: "keep-alive" } }, { timeoutMs: 5000, maxBytes: 2 * MB }));
  for (let i = 0; i < 30 && g.st.closedAt === null; i++) await sleep(50);
  check("R6g a caller that asks for a kept connection does not get one: the same answer, the same close",
    res2.status === 200 && !!res2.data && g.st.closedAt !== null && g.st.closedAt - t1 < 1500 && !g.st.capped && g.st.accepted < 48 * MB,
    JSON.stringify({ got: res2.threw || res2.status, closed_after_ms: g.st.closedAt === null ? null : g.st.closedAt - t1, accepted_MB: Math.round(g.st.accepted / MB), peer_gave_up: g.st.capped }));
}
// A finished read leaves no timer behind: a process that made one read with a 20 s timeout exits at once.
{
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ a: 1 }) });
  const t0 = Date.now();
  const kid = Bun.spawn([process.execPath, "-e", 'const { cappedJson } = await import("./src/public-safety.mjs"); const r = await cappedJson(process.env.U, null, { timeoutMs: 20000 }); console.log(r.data.a);'],
    { cwd: join(__dir, ".."), env: { ...process.env, U: "http://127.0.0.1:" + srv.port + "/" }, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(kid.stdout).text()).trim(), code = await kid.exited, ms = Date.now() - t0;
  check("R6e the timeout's timer is cleared when the read ends (the process exits long before the 20 s timeout)", code === 0 && out === "1" && ms < 10000, JSON.stringify({ code, out, ms }));
  srv.stop(true);
}
// The same through the validator round: a seed that answers a nodeCall with 503 and an endless body.
{
  const f1 = await flood("status503"), f2 = await flood("declared"), t0 = Date.now();
  const rr = await runValidatorRound({ seeds: [{ name: "a", url: f1.url }, { name: "b", url: f2.url }], resolveOrigin: loopResolver, reference: () => null, history: createWatchHistory(60000, 5000), dials: false });
  for (let i = 0; i < 30 && (f1.st.closedAt === null || f2.st.closedAt === null); i++) await sleep(50);
  check("R7 a validator round against two such seeds: no list, both connections closed, well before the 5 s timeout",
    rr.list.agreed === false && rr.seedErrors.map((e) => e.list).join() === "HTTP 503,response too large" && f1.st.closedAt !== null && f2.st.closedAt !== null && !f1.st.capped && !f2.st.capped && Date.now() - t0 < 4000,
    JSON.stringify([rr.seedErrors, f1.st.closedAt === null, f2.st.closedAt === null, f1.st.capped, f2.st.capped, Date.now() - t0]));
}
floods.forEach((s) => s.close());

console.log("\n[" + TAG + "] the sources");
const AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8"), WATCH = readFileSync(join(__dir, "validator-watch.mjs"), "utf8");
check("R8 agent.mjs makes no capped read of its own: no readJsonCapped, CAPPED_FETCH_OPTIONS or nativeFetch; the seeds through readSeedInfo, two reads through cappedJson",
  !/readJsonCapped|CAPPED_FETCH_OPTIONS|nativeFetch/.test(AGENT) && (AGENT.match(/await cappedJson\(/g) || []).length === 2 && (AGENT.match(/await readSeedInfo\(/g) || []).length === 1,
  String((AGENT.match(/await cappedJson\(/g) || []).length));
const call = AGENT.slice(AGENT.indexOf("latestValidatorRound = await runValidatorRound({"), AGENT.indexOf("});", AGENT.indexOf("latestValidatorRound = await runValidatorRound({")));
check("R9 the agent passes no fetch to the validator round (its default is the runtime's)", call.length > 0 && !/\bfetch\s*:/.test(call), call.slice(0, 200));
check("R10 validator-watch.mjs: the round's default fetch is nativeFetch, and its reads go through cappedJson",
  WATCH.includes("{ fetch: nativeFetch, now: Date.now, dials: true }") && !/\{ fetch: fetch,/.test(WATCH) && !/readJsonCapped|o\.fetch\(/.test(WATCH) && /cappedJson\(url, /.test(WATCH));

// `bun run test` must be runnable before a restart: only suites that need no running agent. The suites that read one
// (they default to the live port) are in test:served, run after the restart. public-api-v11 is in both: its static part
// runs before the restart with --static.
{
  const scripts = JSON.parse(readFileSync(join(__dir, "..", "package.json"), "utf8")).scripts;
  const entries = (name) => String(scripts[name]).split("&&").map((c) => c.trim()).map((c) => ({ suite: (c.match(/src\/([\w-]+)\.test\.mjs/) || [])[1], staticOnly: /\s--static\b/.test(c) })).filter((e) => e.suite);
  const all = readdirSync(__dir).filter((f) => f.endsWith(".test.mjs")).map((f) => f.slice(0, -9));
  const NEEDS_AGENT = ["display-privacy", "dahr-attestation-honesty", "public-api-v11"], SERVED = ["display-privacy", "dahr-attestation-honesty", "f3-route-pathname", "self-removal", "public-api-v11"];
  const offline = entries("test"), names = offline.map((e) => e.suite);
  const wrong = offline.filter((e) => NEEDS_AGENT.includes(e.suite) && !(e.suite === "public-api-v11" && e.staticOnly)).map((e) => e.suite);
  const missing = all.filter((n) => !names.includes(n) && !NEEDS_AGENT.includes(n));
  check("R12 package.json: `test` runs every suite that needs no running agent (this one too), public-api-v11 with --static, and none that needs one; `test:served` runs the five that read one",
    missing.length === 0 && wrong.length === 0 && names.every((n) => all.includes(n)) && names.includes("runtime-fetch") && offline.some((e) => e.suite === "public-api-v11" && e.staticOnly)
      && entries("test:served").map((e) => e.suite).join() === SERVED.join() && entries("test:served").every((e) => !e.staticOnly)
      && scripts["pre-restart-check"] === "bun tools/pre-restart-check.mjs" && scripts["post-restart-check"] === "bun tools/post-restart-check.mjs",
    JSON.stringify({ missing, wrong, served: entries("test:served").map((e) => e.suite) }));
}

// The runbook's step after a restart reads the agent's own log: these are the lines it looks for.
check("R13 the log lines the runbook counts are the agent's: the start banner, a seed read, the history start, and its failure",
  AGENT.includes('log("  Demos Network Oracle Agent v" + AGENT_VERSION);') && AGENT.includes('log("  PublicNode " + name + ": OK " + r.latencyMs + "ms block="')
  && AGENT.includes('"  Public history: rows before " + new Date(OWN_HEIGHT_SINCE).toISOString() + " were not written under the own-height rule; median-based figures do not use them"')
  && AGENT.includes('logError("  [history] own-height mark not readable (" + eOhs.message + "): no stored row is used for median-based figures");')
  && AGENT.includes('log("  PublicNode " + name + ": FAIL " + r.error);'));

console.log("\n[" + TAG + "] the real SDK, loaded first (as the agent loads it)");
// A child process: SDK first, then tools/validator-set-probe.mjs as the pre-restart check runs it, against local seeds.
const child = `
const before = globalThis.fetch;
const kept = { "Bun.fetch": Bun.fetch, Headers, Response, Request, AbortController, AbortSignal, DOMException, ReadableStream, TextDecoder, URL };
try { await import("@kynesyslabs/demosdk/websdk"); } catch (e) { console.log("NO-SDK"); process.exit(64); }
console.log("SDK-IMPORT fetch " + (globalThis.fetch !== before ? "replaced" : "kept") + " · others changed: " + (Object.keys(kept).filter((k) => (k === "Bun.fetch" ? Bun.fetch : globalThis[k]) !== kept[k]).join(",") || "none"));
const { run } = await import("./tools/validator-set-probe.mjs");
const { parseProbeOrigin } = await import("./src/public-safety.mjs");
const loop = async (u) => { const p = parseProbeOrigin(u); return p && p.hostname === "127.0.0.1" ? "http://127.0.0.1:" + p.port : null; };
process.exit(await run(["--dial", "seed-a=" + process.env.SEED_A, "seed-b=" + process.env.SEED_B], { agentReads: true, sdkReplaced: globalThis.fetch !== before, resolveOrigin: loop, kept: null }));
`;
const underSdk = async (a, b) => {
  const kid = Bun.spawn([process.execPath, "-e", child], { cwd: join(__dir, ".."), env: { ...process.env, SEED_A: a, SEED_B: b }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(kid.stdout).text(); return { out, code: await kid.exited };
};
let skipped = 0;
const okRun = await underSdk(A.url, B.url);
if (okRun.code === 64 && okRun.out.includes("NO-SDK")) { skipped += 6; console.log("  skip R11, R11b to R11f: @kynesyslabs/demosdk is not installed here (run this suite where the agent's node_modules are)"); }
else {
  // What the fix rests on: the import replaces the global fetch (the suites and the harness stand in for exactly that)
  // and leaves alone everything else a capped read uses. A newer SDK that changes either must be looked at again.
  check("R11d importing the real SDK replaces the global fetch, and leaves Bun.fetch, Headers, Response, Request, AbortController, AbortSignal, DOMException, ReadableStream, TextDecoder and URL as they were",
    okRun.out.includes("SDK-IMPORT fetch replaced · others changed: none"), (okRun.out.split("\n").find((l) => l.startsWith("SDK-IMPORT")) || "no SDK-IMPORT line"));
  const brief = (r) => "exit " + r.code + " | " + r.out.split("\n").filter((l) => /AGENT|seeds answered|list:|global fetch/.test(l)).join(" | ");
  check("R11 with the real SDK loaded before DNO's modules, the agent's own seed read and a validator round work (AGENT READS OK, exit 0)",
    okRun.code === 0 && okRun.out.includes("the Demos SDK was loaded first, as in the agent; it replaced the global fetch") && okRun.out.includes("2 of 2 seeds answered; 2 gave their own height. Two give a status from the seeds alone; with fewer, validators stand in (Witnesses, below).")
    && okRun.out.includes("Witnesses (validators the agent reads when fewer than two seeds give their own height)") && okRun.out.includes("(seeds_only)")
    && okRun.out.trim().endsWith("AGENT READS OK: 2 of 2 seeds gave their own height, and two seeds agree on the validator list."), brief(okRun));
  // The same, against one seed that answers and one address where nothing listens: the verdict must be FAILED, exit 3.
  const freed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }), nobody = "http://127.0.0.1:" + freed.port; freed.stop(true);   // a port nothing listens on
  const badRun = await underSdk(A.url, nobody);
  // tools/pre-restart-check.mjs itself, as the runbook runs it, with dials switched off as the agent's setting does.
  // Loopback seeds are not public origins, so the list cannot be agreed here: what is checked is that the SDK loads,
  // the seeds are read with the agent's read, the list is read without dials, and the verdict is FAILED, not OK.
  const pre = Bun.spawn([process.execPath, "tools/pre-restart-check.mjs", "seed-a=" + A.url, "seed-b=" + B.url], { cwd: join(__dir, ".."), env: { ...process.env, VALIDATOR_WATCH_DIALS: "0" }, stdout: "pipe", stderr: "pipe" });
  const preOut = await new Response(pre.stdout).text(), preCode = await pre.exited;
  check("R11c tools/pre-restart-check.mjs with VALIDATOR_WATCH_DIALS=0: the list only, no dials; never OK when no list is agreed; and with seeds given it reads no cross-check RPC of this host",
    preCode === 3 && preOut.includes("the Demos SDK was loaded first, as in the agent") && preOut.includes("2 of 2 seeds answered; 2 gave their own height.") && preOut.includes("Watch (one round: the list only, no dials)") && !/cross-check RPCs/.test(preOut)
    && /AGENT READS FAILED: no validator list was agreed by two seeds\. Do not restart on this\.\s*$/.test(preOut), "exit " + preCode + " | " + preOut.split("\n").slice(-4).join(" | "));
  // --dial given by hand does not turn the dials back on: the switch decides, as it does in the agent.
  const byHand = Bun.spawn([process.execPath, "tools/pre-restart-check.mjs", "--dial", "seed-a=" + A.url, "--dial", "seed-b=" + B.url], { cwd: join(__dir, ".."), env: { ...process.env, VALIDATOR_WATCH_DIALS: "0" }, stdout: "pipe", stderr: "pipe" });
  const byHandOut = await new Response(byHand.stdout).text(), byHandCode = await byHand.exited;
  // A store of this test's own, holding a kept candidate, in the folder the check would read by default (LOG_DIR).
  const logDir = mkdtempSync(join(tmpdir(), "dno-pre-restart-logs-"));
  {
    const { Database } = await import("bun:sqlite"), { createCandidateStore } = await import("./witnesses.mjs");
    const db = new Database(join(logDir, "marketplace.db")), store = createCandidateStore(db);
    store.save([{ key: "c7".repeat(32), url: "http://203.0.113.77:53550", at: Date.now() - 60000 }], Date.now() - 70000);
    db.close();
  }
  const withDials = Bun.spawn([process.execPath, "tools/pre-restart-check.mjs", "seed-a=" + A.url, "seed-b=" + B.url], { cwd: join(__dir, ".."), env: { ...process.env, VALIDATOR_WATCH_DIALS: "1", LOG_DIR: logDir }, stdout: "pipe", stderr: "pipe" });
  const withDialsOut = await new Response(withDials.stdout).text(); await withDials.exited;
  rmSync(logDir, { recursive: true, force: true });
  check("R11c3 with the seeds given as arguments the check does not read this host's store either: the candidate kept there is not read, and the witness line says the agent keeps none here",
    withDialsOut.includes("  candidates: none (this run's validator round did not count, and the agent keeps none here)") && !/kept by the agent/.test(withDialsOut) && !/read as the agent reads them/.test(withDialsOut),
    withDialsOut.split("\n").filter((l) => /candidates|read as the agent/.test(l)).join(" | "));
  check("R11c2 --dial given by hand is ignored while the switch is off (the list only, no dials, the same verdict); with the switch on the same run dials",
    byHandCode === 3 && byHandOut.includes("Watch (one round: the list only, no dials)") && !byHandOut.includes("with one dial per published origin") && byHandOut.split("\n").slice(-3).join("\n") === preOut.split("\n").slice(-3).join("\n")
    && !withDialsOut.includes("the list only, no dials") && /Watch \(one round[^)]*dial/.test(withDialsOut),
    "exit " + byHandCode + " | " + byHandOut.split("\n").filter((l) => /^Watch/.test(l)).join(" | ") + " || " + withDialsOut.split("\n").filter((l) => /^Watch/.test(l)).join(" | "));
  // The check as the runbook runs it: no argument. The tool and its modules are copied next to a seed configuration
  // and a fleet config of this test's own, so the seeds come from src/agent.mjs and the cross-check RPC is read.
  const box = mkdtempSync(join(tmpdir(), "dno-pre-restart-"));
  let rpcHits = 0;
  const rpc = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { rpcHits++; return Response.json({ result: 200, response: { block: 1 } }); } });
  try {
    mkdirSync(join(box, "src")); mkdirSync(join(box, "tools"));
    for (const f of ["tools/pre-restart-check.mjs", "tools/validator-set-probe.mjs", "src/public-safety.mjs", "src/seed-read.mjs", "src/status-rule.mjs", "src/validator-watch.mjs", "src/witnesses.mjs"]) copyFileSync(join(__dir, "..", f), join(box, f));
    symlinkSync(join(__dir, "..", "node_modules"), join(box, "node_modules"), "dir");
    writeFileSync(join(box, "src", "agent.mjs"), `const PUBLIC_NODES = {\n  // "seed-off": { url: "http://127.0.0.1:9", identity: "${KEY(7)}" },\n  "seed-a": { url: "${A.url}", identity: "${KEY(9)}" },\n  "seed-b": { url: "${B.url}", identity: "${KEY(8)}" },\n};\n`);
    writeFileSync(join(box, "src", "fleet.config.mjs"), `export const FLEET_CROSS_VALIDATION_RPCS = [{ name: "rpc-name-not-to-print", url: "http://127.0.0.1:${rpc.port}" }];\n`);
    const tool = async (args) => { const kid = Bun.spawn([process.execPath, "tools/pre-restart-check.mjs", ...args], { cwd: box, env: { ...process.env, VALIDATOR_WATCH_DIALS: "0" }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(kid.stdout).text(); return { out, code: await kid.exited }; };
    const plain = await tool([]), hitsPlain = rpcHits;
    check("R11e the check with no argument: the seeds are the configured ones (a commented-out entry is not one), read as the agent reads them, and the cross-check RPC is read once, its name not printed",
      plain.code === 3 && plain.out.includes("the Demos SDK was loaded first, as in the agent") && /\n  seed-a  answered · names the configured key · its own height\n  seed-b  answered · names the configured key · its own height\n  2 of 2 seeds answered; 2 gave their own height\./.test(plain.out)
      && plain.out.includes("cross-check RPCs (not in status), the agent's capped read: 1 of 1 answered") && hitsPlain === 1 && !/seed-off|rpc-name-not-to-print/.test(plain.out)
      && /AGENT READS FAILED: no validator list was agreed by two seeds\. Do not restart on this\.\s*$/.test(plain.out), "exit " + plain.code + " | hits " + hitsPlain + " | " + plain.out.split("\n").filter((l) => /seed-|cross-check|AGENT|answered;/.test(l)).join(" | "));
    const given = await tool(["seed-a=" + A.url, "seed-b=" + B.url]);
    check("R11f with the seeds given as arguments, the same tool next to the same fleet config reads no cross-check RPC", given.code === 3 && rpcHits === hitsPlain && !/cross-check RPCs/.test(given.out), "exit " + given.code + " | hits " + rpcHits);
  } finally { rpc.stop(true); rmSync(box, { recursive: true, force: true }); }
  check("R11b and it says FAILED, exit 3, when the agent could not publish a status from the reads", badRun.code === 3 && /AGENT READS FAILED: 1 of 2 seeds answered \/info, and the agent needs two, or validators that stand in \(the agent keeps no candidates here\)\. Do not restart on this\.\s*$/.test(badRun.out), brief(badRun));
}

A.srv.stop(true); B.srv.stop(true);
globalThis.fetch = runtimeGlobal;
console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed" + (skipped ? ", " + skipped + " skipped (R11 to R11f need the Demos SDK: run where the agent's node_modules are)" : ""));
process.exit(failed ? 1 : 0);
