// tools/homepage-preview/serve.mjs — the working tree's homepage on your own machine, with live or fixture readings.
//
// Serves homepage.html from the working tree, byte for byte and re-read on every request (edit, reload), and the kit
// files under the names the agent serves them (inputs.mjs). Everything else the page asks for (/organism, /health,
// /catalog/lookup, /incidents, the links to other pages) is fetched from the source and passed through unchanged:
//   node tools/homepage-preview/serve.mjs                               live: https://demos-oracle.com (the default)
//   node tools/homepage-preview/serve.mjs --source=http://127.0.0.1:55225   a local agent
//   node tools/homepage-preview/serve.mjs --fixture=capture_witnesses      a fixture scenario (inputs.mjs); other paths 404
//   --port=8787 (the default)
// Read-only: it sends only GET requests, to the source alone, and listens on 127.0.0.1 only. Links to other pages show
// those pages as the source serves them today. No dependencies beyond Node 18+ (global fetch).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kitAssets, SCENARIOS } from "./inputs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith("--" + k + "=")); return a ? a.slice(k.length + 3) : d; };
const PORT = Number(arg("port", "8787"));
const FIXTURE = arg("fixture", null);
const SOURCE = FIXTURE ? null : new URL(arg("source", "https://demos-oracle.com")).origin;
if (FIXTURE && !SCENARIOS[FIXTURE]) { console.error("No fixture scenario '" + FIXTURE + "'. Scenarios: " + Object.keys(SCENARIOS).join(", ")); process.exit(2); }
const FIX = FIXTURE ? { "/organism": readFileSync(join(here, "fixtures", SCENARIOS[FIXTURE][0])), "/health": readFileSync(join(here, "fixtures", SCENARIOS[FIXTURE][1])) } : null;
const ASSETS = kitAssets(ROOT);

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(readFileSync(join(ROOT, "homepage.html"))); }
  if (ASSETS[u.pathname]) { res.writeHead(200, { "Content-Type": ASSETS[u.pathname].type }); return res.end(ASSETS[u.pathname].b); }
  if (FIX) {
    if (FIX[u.pathname]) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(FIX[u.pathname]); }
    res.writeHead(404); return res.end();
  }
  try {
    const r = await fetch(SOURCE + u.pathname + u.search, { headers: { Accept: req.headers.accept || "*/*" }, signal: AbortSignal.timeout(15000) });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch (e) {
    // The page shows a failed read as a failure to read; this says which.
    res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "source unreachable from this machine", source: SOURCE, detail: String(e && e.message || e) }));
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("Homepage preview: http://127.0.0.1:" + PORT + "/  (working tree homepage.html, " + Object.keys(ASSETS).length + " kit files)");
  console.log(FIX ? "Readings: fixture '" + FIXTURE + "'. Other paths 404." : "Readings and other pages: " + SOURCE + ", passed through. Ctrl-C to stop.");
});
