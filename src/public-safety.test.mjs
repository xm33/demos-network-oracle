// public-safety.test.mjs — PUBLIC_SAFETY guard for src/public-safety.mjs (runtime) and its use in agent.mjs (static).
// Run: bun src/public-safety.test.mjs   (executable harness, not `bun test`)
// Test data is synthetic: documentation address ranges and generated identities only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isValidIdentity, truncIdentity, sanitizeHeight, sanitizeLabel, escHtml, probeErrorCategory,
  adminTokenMatches, isPublicIp, parseProbeOrigin, resolvePublicProbeOrigin, mapWithConcurrency, readJsonCapped
} from "./public-safety.mjs";

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
check("O1 bare origin parsed", parseProbeOrigin("http://8.8.8.8:53550") !== null && parseProbeOrigin("8.8.8.8:53550").origin === "http://8.8.8.8:53550");
check("O2 paths, queries, credentials, other schemes rejected",
  ["http://8.8.8.8:53550/latest/meta-data", "http://8.8.8.8:53550/?x=1", "http://u:p@8.8.8.8:53550", "file:///etc/passwd", "gopher://8.8.8.8:70", "http://8.8.8.8#frag"].every((s) => parseProbeOrigin(s) === null));
const fakeLookup = (answers) => async () => answers.map((address) => ({ address }));
check("O3 IP literal resolved without DNS", (await resolvePublicProbeOrigin("http://8.8.8.8:53550", () => { throw new Error("dns"); })) === "http://8.8.8.8:53550");
check("O4 private literal refused", (await resolvePublicProbeOrigin("http://127.0.0.1:55225")) === null && (await resolvePublicProbeOrigin("http://169.254.169.254")) === null);
check("O5 hostname resolving to a private address refused", (await resolvePublicProbeOrigin("http://node.example:53550", fakeLookup(["8.8.8.8", "10.0.0.5"]))) === null);
check("O6 hostname resolving to public addresses is pinned to the checked address", (await resolvePublicProbeOrigin("http://node.example:53550", fakeLookup(["8.8.8.8"]))) === "http://8.8.8.8:53550");
check("O7 DNS failure refused", (await resolvePublicProbeOrigin("http://node.example:53550", async () => { throw new Error("NXDOMAIN"); })) === null);
check("O8 https is not probed (a pinned address cannot pass its certificate check)", (await resolvePublicProbeOrigin("https://node.example", fakeLookup(["8.8.8.8"]))) === null && (await resolvePublicProbeOrigin("https://8.8.8.8")) === null);
check("O9 IPv6 results are pinned in brackets", (await resolvePublicProbeOrigin("http://node.example:53550", fakeLookup(["2606:4700:4700::1111"]))) === "http://[2606:4700:4700::1111]:53550");
const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024).fill(32)); } }));
let bigErr = null; try { await readJsonCapped(big, 256 * 1024); } catch (e) { bigErr = e; }
check("B1 an endless body stops at the cap", bigErr instanceof RangeError && probeErrorCategory(bigErr) === "response too large");
check("B2 a declared oversize body is refused before reading", await readJsonCapped(new Response("{}", { headers: { "content-length": "9999999" } }), 1024).then(() => false, (e) => e instanceof RangeError));
check("B3 a small body parses", (await readJsonCapped(new Response('{"a":1}'), 1024)).a === 1);
let inFlight = 0, maxInFlight = 0;
await mapWithConcurrency([...Array(20).keys()], 4, async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; });
check("C1 concurrency is bounded", maxInFlight === 4, "max " + maxInFlight);

console.log("\n[" + TAG + "] agent.mjs uses the helpers at the boundary");
check("S1 agent imports public-safety", /from "\.\/public-safety\.mjs"/.test(SRC));
check("S2 no unescaped toLocaleString() into server-built HTML cells", !/'<td>' \+ \(\w+(\.\w+)? \? \w+(\.\w+)?\.toLocaleString\(\)/.test(SRC));
check("S3 admin token compared with adminTokenMatches, never read from the query string", /adminTokenMatches\(/.test(SRC) && !/reqQuery\.get\(\s*"token"\s*\)/.test(SRC));
check("S4 discovered-peer probes resolve their target first", /resolvePublicProbeOrigin\(/.test(SRC));
check("S4b discovered-peer probes do not follow redirects", /fetch\(connUrl \+ "\/info", \{[^}]*redirect: "manual"/.test(SRC));
check("S5 request handler is wrapped (a throwing route cannot stop the process)", /function safeHandle\(/.test(SRC) && /createServer\(safeHandle\(/.test(SRC));
check("S6 /home no longer writes headers twice", !/"Location": "\/" \}\);\s*res\.end\(\);\s*res\.writeHead\(200/.test(SRC));
check("S7 no IPv4 literal outside loopback in agent.mjs", !/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(SRC.replace(/"\d+\.\d+\.\d+"/g, "")));

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
