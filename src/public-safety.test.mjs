// public-safety.test.mjs — PUBLIC_SAFETY guard for src/public-safety.mjs (runtime) and its use in agent.mjs (static).
// Run: bun src/public-safety.test.mjs   (executable harness, not `bun test`)
// Test data is synthetic: documentation address ranges and generated identities only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isValidIdentity, truncIdentity, sanitizeHeight, sanitizeLabel, escHtml, probeErrorCategory,
  adminTokenMatches, isPublicIp, parseProbeOrigin, resolvePublicProbeOrigin, mapWithConcurrency, readJsonCapped, CAPPED_FETCH_OPTIONS, isInternalError
} from "./public-safety.mjs";
import { gzipSync } from "node:zlib";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "PUBLIC_SAFETY";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const ID = "0x" + "ab".repeat(32);

console.log("\n[" + TAG + "] identities, heights, labels");
check("I1 valid identity", isValidIdentity(ID));
check("I2 rejects short, markup and non-hex", !isValidIdentity("0x1234") && !isValidIdentity("<img src=x>") && !isValidIdentity("0x" + "zz".repeat(32)) && !isValidIdentity(null));
check("I3 truncation is first 6 + last 4", truncIdentity(ID) === "0xabab…abab");
check("H1 integer heights kept", sanitizeHeight(395716) === 395716 && sanitizeHeight("395716") === 395716 && sanitizeHeight(0) === 0);
check("H2 hostile heights dropped", [ "<img src=x onerror=alert(1)>", -1, 1.5, NaN, Infinity, 2 ** 60, {}, [], true, "12a" ].every((v) => sanitizeHeight(v) === null));
check("L1 labels kept when plain", sanitizeLabel("0.9.9 RC") === "0.9.9 RC" && sanitizeLabel("synced") === "synced");
check("L2 labels dropped when markup or long", sanitizeLabel("<b>x</b>") === null && sanitizeLabel("x".repeat(40)) === null && sanitizeLabel(7) === null);
check("E1 HTML escaping", escHtml(`<a href="x">'&'</a>`) === "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");

console.log("\n[" + TAG + "] probe errors and admin token");
const timeout = new Error("t"); timeout.name = "TimeoutError";
check("P1 timeout category", probeErrorCategory(timeout) === "timeout");
check("P2 connection text never passes through", probeErrorCategory(new Error("Unable to connect. Is the computer able to access the url?")) === "connection failed");
check("P3 HTTP status category", probeErrorCategory(null, 503) === "HTTP 503");
check("P4 invalid JSON category", probeErrorCategory(new SyntaxError("x")) === "invalid response");
check("P4b an aborted read is a timeout", probeErrorCategory(new DOMException("The operation was aborted.", "AbortError")) === "timeout" && probeErrorCategory(new DOMException("The operation timed out.", "TimeoutError")) === "timeout");
check("P5 a fault in DNO's own read is not reported as the peer's connection failing", probeErrorCategory(new TypeError("resp.body.getReader is not a function")) === "internal error" && probeErrorCategory(new ReferenceError("x is not defined")) === "internal error");
{
  // What the runtime's fetch throws for a peer that cannot be reached: a plain Error with a code, never a TypeError.
  const freed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") }), nobody = "http://127.0.0.1:" + freed.port + "/"; freed.stop(true);   // a port nothing listens on
  let refused = null; try { await Bun.fetch(nobody); } catch (e) { refused = e; }
  check("P6 a refused connection is 'connection failed'", refused !== null && !(refused instanceof TypeError) && probeErrorCategory(refused) === "connection failed", refused && refused.name + " " + refused.code);
}
const TOKEN = "t".repeat(24);
check("A1 exact token matches", adminTokenMatches(TOKEN, TOKEN));
check("A2 empty configuration never matches", !adminTokenMatches("", "") && !adminTokenMatches(undefined, undefined) && !adminTokenMatches("", undefined));
check("A3 short configuration never matches", !adminTokenMatches("short", "short"));
check("A4 wrong or empty presentation fails", !adminTokenMatches("u".repeat(24), TOKEN) && !adminTokenMatches("", TOKEN) && !adminTokenMatches(TOKEN + "x", TOKEN));

console.log("\n[" + TAG + "] probe targets");
check("N1 public v4 allowed", isPublicIp("8.8.8.8") && isPublicIp("1.1.1.1"));
check("N2 private, loopback, link-local, CGNAT, metadata, doc, multicast blocked",
  ["10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.1.1", "172.16.5.5", "192.168.1.7", "192.0.2.10", "198.51.100.3", "203.0.113.9", "224.0.0.1", "0.0.0.0", "255.255.255.255"].every((ip) => !isPublicIp(ip)));
check("N3 v6 blocked ranges", ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1"].every((ip) => !isPublicIp(ip)));
check("N4 public v6 and mapped public v4 allowed", isPublicIp("2606:4700:4700::1111") && isPublicIp("::ffff:8.8.8.8"));
check("N5 not an IP", !isPublicIp("example.com") && !isPublicIp(""));
check("N6 v6 forms that carry or imply a private IPv4 address are blocked", ["::7f00:1", "::a00:1", "::127.0.0.1", "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "fec0::1", "2002:7f00:1::1", "2002:0a00:0001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"].every((ip) => !isPublicIp(ip)),
  ["::7f00:1", "::a00:1", "::127.0.0.1", "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "fec0::1", "2002:7f00:1::1", "2002:0a00:0001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"].filter((ip) => isPublicIp(ip)).join(" "));
check("N7 ordinary public v6 still allowed", isPublicIp("2001:4860:4860::8888") && isPublicIp("2a00:1450:4001:80b::200e"));
check("O1 bare origin parsed", parseProbeOrigin("http://8.8.8.8:53550") !== null && parseProbeOrigin("8.8.8.8:53550").origin === "http://8.8.8.8:53550");
check("O2 paths, queries, credentials, other schemes rejected",
  ["http://8.8.8.8:53550/latest/meta-data", "http://8.8.8.8:53550/?x=1", "http://u:p@8.8.8.8:53550", "file:///etc/passwd", "gopher://8.8.8.8:70", "http://8.8.8.8#frag"].every((s) => parseProbeOrigin(s) === null));
const fakeLookup = (answers) => async () => answers.map((address) => ({ address }));
check("O3 IP literal resolved without DNS", (await resolvePublicProbeOrigin("http://8.8.8.8:53550", () => { throw new Error("dns"); })) === "http://8.8.8.8:53550");
check("O4 private literal refused", (await resolvePublicProbeOrigin("http://127.0.0.1:55225")) === null && (await resolvePublicProbeOrigin("http://169.254.169.254")) === null);
check("O5 hostname resolving to a private address refused", (await resolvePublicProbeOrigin("http://node.example:53550", fakeLookup(["8.8.8.8", "10.0.0.5"]))) === null);
check("O6 hostname resolving to public addresses is pinned to the checked address", (await resolvePublicProbeOrigin("http://node.example:53550", fakeLookup(["8.8.8.8"]))) === "http://8.8.8.8:53550");
// A check that rejects is a failed check with a name, not a suite that stops.
const settled = (p) => p.catch((e) => "rejected: " + (e && e.constructor ? e.constructor.name : e));
check("O7 DNS failure refused", (await settled(resolvePublicProbeOrigin("http://node.example:53550", async () => { throw new Error("NXDOMAIN"); }))) === null
  && (await settled(resolvePublicProbeOrigin("http://node.example:53550", async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND node.example"), { code: "ENOTFOUND", name: "DNSException" }); }))) === null);
{
  // A fault in DNO's own lookup call is thrown on: read as "refused" it would say the peer's address is not public.
  const rejects = async (lookup) => { try { await resolvePublicProbeOrigin("http://node.example:53550", lookup); return "resolved"; } catch (e) { return e.constructor.name; } };
  check("O7b a TypeError or ReferenceError of the lookup call is thrown on, not read as a refused address: a lookup that is not callable as written, one that answers with something that is no list, one that names what does not exist",
    (await rejects(async () => { throw new TypeError("dnsLookup is not a function"); })) === "TypeError" && (await rejects(async () => ({ address: "8.8.8.8" }))) === "TypeError"
    && (await rejects(async () => { return notDefinedAnywhere; })) === "ReferenceError" && (await rejects(async () => [null])) === "TypeError");
  check("O7c the two kinds are told apart by one function, the one the read's categories use", isInternalError(new TypeError("x")) && isInternalError(new ReferenceError("x")) && !isInternalError(new Error("x")) && !isInternalError(new SyntaxError("x"))
    && !isInternalError(new RangeError("x")) && !isInternalError(null) && !isInternalError(Object.assign(new Error("t"), { name: "TimeoutError" })) && probeErrorCategory(new TypeError("x")) === "internal error" && probeErrorCategory(new Error("x")) === "connection failed");
}
check("O8 https is not probed (a pinned address cannot pass its certificate check)", (await resolvePublicProbeOrigin("https://node.example", fakeLookup(["8.8.8.8"]))) === null && (await resolvePublicProbeOrigin("https://8.8.8.8")) === null);
check("O9 IPv6 results are pinned in brackets", (await resolvePublicProbeOrigin("http://node.example:53550", fakeLookup(["2606:4700:4700::1111"]))) === "http://[2606:4700:4700::1111]:53550");
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024).fill(32)); } }));
const bigErr = await errOf(readJsonCapped(big, 256 * 1024));
check("B1 an endless body stops at the cap", bigErr && bigErr.name === "ResponseTooLarge" && probeErrorCategory(bigErr) === "response too large");
const declErr = await errOf(readJsonCapped(new Response("{}", { headers: { "content-length": "9999999" } }), 1024));
check("B2 a declared oversize body is refused before reading", declErr && declErr.name === "ResponseTooLarge");
check("B3 a small body parses", (await readJsonCapped(new Response('{"a":1}'), 1024)).a === 1);
const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 32));                 // 64 MB of spaces, about 64 KB compressed
const bombErr = await errOf(readJsonCapped(new Response(bomb, { headers: { "content-encoding": "gzip" } }), 256 * 1024));
check("B4 a compressed bomb stops at the cap after decompression", bombErr && bombErr.name === "ResponseTooLarge", bombErr && bombErr.message);
check("B5 a small gzip body parses", (await readJsonCapped(new Response(gzipSync(Buffer.from('{"b":2}')), { headers: { "content-encoding": "gzip" } }), 1024)).b === 2);
check("B6 a body the runtime already decoded still parses", (await readJsonCapped(new Response(' {"c":3}', { headers: { "content-encoding": "gzip" } }), 1024)).c === 3);
const deep = await errOf(readJsonCapped(new Response("[".repeat(200000) + "]".repeat(200000)), 1024 * 1024));
check("B7 a deeply nested body is parsed or is an invalid response: never a large one, a failed connection or an internal error", deep === null || probeErrorCategory(deep) === "invalid response", deep && deep.name);
check("B7b a RangeError (nesting too deep for the runtime, a number out of range) is an invalid response, like a SyntaxError; an Error of no known kind is a failed connection", probeErrorCategory(new RangeError("Maximum call stack size exceeded")) === "invalid response"
  && probeErrorCategory(new SyntaxError("x")) === "invalid response" && probeErrorCategory(new Error("x")) === "connection failed" && probeErrorCategory(new TypeError("x")) === "internal error");
{
  // A body sent without a length, in pieces: read up to the cap and not past it.
  const streamed = (bytes) => new Response(new ReadableStream({ start(c) { const text = Buffer.from(JSON.stringify({ pad: "" }).replace('""', '"' + " ".repeat(bytes - 10) + '"')); for (let i = 0; i < text.length; i += 4096) c.enqueue(new Uint8Array(text.subarray(i, i + 4096))); c.close(); } }));
  const atCap = await errOf(readJsonCapped(streamed(64 * 1024), 64 * 1024)), over = await errOf(readJsonCapped(streamed(64 * 1024 + 1), 64 * 1024)), half = await errOf(readJsonCapped(streamed(96 * 1024), 64 * 1024));
  check("B1b a streamed body of exactly the cap parses; one byte more, or one and a half times the cap, is too large", atCap === null && over && over.name === "ResponseTooLarge" && half && half.name === "ResponseTooLarge", [atCap && atCap.name, over && over.name, half && half.name].join(" "));
}
check("B8 capped fetches ask for identity encoding, no runtime decompression and no kept connection (the option and the header), and the options cannot be changed",
  CAPPED_FETCH_OPTIONS.decompress === false && CAPPED_FETCH_OPTIONS.keepalive === false && CAPPED_FETCH_OPTIONS.headers["Accept-Encoding"] === "identity" && CAPPED_FETCH_OPTIONS.headers["Connection"] === "close"
  && Object.isFrozen(CAPPED_FETCH_OPTIONS) && Object.isFrozen(CAPPED_FETCH_OPTIONS.headers));
let inFlight = 0, maxInFlight = 0;
await mapWithConcurrency([...Array(20).keys()], 4, async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; });
check("C1 concurrency is bounded", maxInFlight === 4, "max " + maxInFlight);

console.log("\n[" + TAG + "] agent.mjs uses the helpers at the boundary");
check("S1 agent imports public-safety", /from "\.\/public-safety\.mjs"/.test(SRC));
check("S2 no unescaped toLocaleString() into server-built HTML cells", !/'<td>' \+ \(\w+(\.\w+)? \? \w+(\.\w+)?\.toLocaleString\(\)/.test(SRC));
check("S3 admin token compared with adminTokenMatches, never read from the query string", /adminTokenMatches\(/.test(SRC) && !/reqQuery\.get\(\s*"token"\s*\)/.test(SRC));
check("S4 discovered-peer probes resolve their target first", /resolvePublicProbeOrigin\(/.test(SRC));
check("S4b discovered-peer probes go through the one capped read, and do not follow redirects", /cappedJson\(connUrl \+ "\/info", \{ redirect: "manual" \}, \{ timeoutMs: 5000, maxBytes: INFO_BODY_MAX_BYTES \}\)/.test(SRC));
const SEEDREAD = readFileSync(join(__dir, "seed-read.mjs"), "utf8");
check("S4c seed reads go through the shared seed read (one capped read), cross-check reads through the capped read",
  /readSeedInfo\(node, \{ timeoutMs: 5000, maxBytes: INFO_BODY_MAX_BYTES \}\)/.test(SRC) && /cappedJson\(node\.url \+ "\/info", null, \{/.test(SEEDREAD) && !/\bfetch\(/.test(SEEDREAD.replace(/fetch: o\.fetch/g, ""))
  && /cappedJson\(rpc\.url, null, \{ timeoutMs: PUBLIC_PROBE_TIMEOUT_MS, maxBytes: INFO_BODY_MAX_BYTES \}\)/.test(SRC));
check("S4d the agent makes no capped read of its own: no readJsonCapped, no CAPPED_FETCH_OPTIONS", !/readJsonCapped|CAPPED_FETCH_OPTIONS/.test(SRC));
check("S5 request handler is wrapped (a throwing route cannot stop the process)", /function safeHandle\(/.test(SRC) && /createServer\(safeHandle\(/.test(SRC));
check("S6 /home no longer writes headers twice", !/"Location": "\/" \}\);\s*res\.end\(\);\s*res\.writeHead\(200/.test(SRC));
check("S7 no IPv4 literal outside loopback in agent.mjs", !/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(SRC.replace(/"\d+\.\d+\.\d+"/g, "")));

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
