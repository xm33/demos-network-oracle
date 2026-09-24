import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const BASE = process.argv[2] || process.env.DNO_F3_BASE || "";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

console.log("\nF-3 route pathname guard\n");

check("S1 handler parses pathname once", /var\s+reqPath\s*=\s*reqUrl\.pathname/.test(SRC), "missing reqPath");
check("S2 handler keeps searchParams", /var\s+reqQuery\s*=\s*reqUrl\.searchParams/.test(SRC), "missing reqQuery");
check("S3 /health matches pathname", /reqPath\s*===\s*"\/health"/.test(SRC) && !/req\.url\s*===\s*"\/health"/.test(SRC));
check("S4 /organism matches pathname", /reqPath\s*===\s*"\/organism"/.test(SRC) && !/req\.url\s*===\s*"\/organism"/.test(SRC));
check("S5 /peers matches pathname", /reqPath\s*===\s*"\/peers"/.test(SRC) && !/req\.url\s*===\s*"\/peers"/.test(SRC));
check("S6 no leftover exact req.url === routes", !/req\.url\s*===/.test(SRC));
check("S7 incidents still read query", /reqQuery/.test(SRC) && /incidents/.test(SRC));
check("S8 commerce token still read", /reqQuery\.get\(\s*"token"\s*\)/.test(SRC) || /searchParams\.get\(\s*"token"\s*\)/.test(SRC));
check("S9 export from/to readable", /history\/export/.test(SRC) && (/reqQuery\.get\(\s*"from"\s*\)/.test(SRC) || /searchParams\.get\(\s*"from"\s*\)/.test(SRC)));

function pathOf(u) { return new URL(u, "http://d").pathname; }
check("U1 /health?cb=1", pathOf("/health?cb=1") === "/health");
check("U2 /organism?foo=bar", pathOf("/organism?foo=bar") === "/organism");
check("U3 /peers?x=1", pathOf("/peers?x=1") === "/peers");
check("U4 unknown keeps path", pathOf("/no-such?cb=1") === "/no-such");

if (BASE) {
  async function probe(p) {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
    let body = null;
    try { body = await r.json(); } catch (e) { body = {}; }
    return { status: r.status, body };
  }
  const health = await probe("/health");
  const healthQs = await probe("/health?cb=1");
  const orgQs = await probe("/organism?cb=1");
  const peersQs = await probe("/peers?foo=bar");
  const missing = await probe("/no-such-route-f3?cb=1");
  check("L1 GET /health 200", health.status === 200);
  check("L2 GET /health?cb=1 200", healthQs.status === 200 && healthQs.body && "last_updated" in healthQs.body);
  check("L3 GET /organism?cb=1 200", orgQs.status === 200 && orgQs.body && typeof orgQs.body.status === "string");
  check("L4 GET /peers?foo=bar 200", peersQs.status === 200);
  check("L5 unknown path 404", missing.status === 404);
} else {
  console.log("  skip live probes");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
