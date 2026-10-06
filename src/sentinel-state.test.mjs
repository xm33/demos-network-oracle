// sentinel-state.test.mjs — SENTINEL_STATE guard: the sentinel and the agent's /sentinel route name the same file.
// Until 1.2 the file was in /tmp. The agent's service has a private /tmp (systemd PrivateTmp=yes), so it never saw the
// file the sentinel wrote, and /sentinel answered "unknown" while the sentinel ran.
// Run: bun src/sentinel-state.test.mjs   (executable harness, not `bun test`)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sentinelStatePath, SENTINEL_STATE_FILE } from "./sentinel-state.mjs";

const TAG = "SENTINEL_STATE";
const __dir = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(__dir, "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const AGENT = readFileSync(join(__dir, "agent.mjs"), "utf8"), SENTINEL = readFileSync(join(__dir, "sentinel.mjs"), "utf8");
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

console.log("\n[" + TAG + "] one file for both services");
{
  check("T1 a relative log directory is taken from the checkout's root", sentinelStatePath("logs") === join(ROOT, "logs", "sentinel-dedup.json") && sentinelStatePath("data/dno") === join(ROOT, "data", "dno", "sentinel-dedup.json"), sentinelStatePath("logs"));
  check("T2 none given: logs, as the agent's default", sentinelStatePath(undefined) === join(ROOT, "logs", SENTINEL_STATE_FILE) && sentinelStatePath("") === sentinelStatePath("logs") && sentinelStatePath("  ") === sentinelStatePath("logs"));
  check("T3 an absolute log directory is used as given", sentinelStatePath("/var/lib/dno") === "/var/lib/dno/sentinel-dedup.json");
  // Started from another folder, a service names the same file: the working directory does not enter into it.
  const kid = Bun.spawnSync([process.execPath, "-e", 'const m = await import(' + JSON.stringify(join(__dir, "sentinel-state.mjs")) + '); console.log(m.sentinelStatePath("logs"));'], { cwd: tmpdir() });
  check("T4 a service started from another folder names the same file", kid.stdout.toString().trim() === sentinelStatePath("logs"), kid.stdout.toString().trim() + " " + kid.stderr.toString().slice(0, 200));
  check("T5 the sentinel writes it there, with its own LOG_DIR", SENTINEL.includes("const DEDUP_FILE = sentinelStatePath(process.env.LOG_DIR);") && SENTINEL.includes('import { sentinelStatePath } from "./sentinel-state.mjs";'));
  check("T6 the agent's /sentinel route reads it there, with its LOG_DIR", AGENT.includes("var dedup = JSON.parse(readFileSync(sentinelStatePath(LOG_DIR), \"utf8\"));") && AGENT.includes('var LOG_DIR = process.env.LOG_DIR || "logs";'));
  check("T7 neither names a file in /tmp any more", !/["'`]\/tmp\//.test(code(SENTINEL)) && !/["'`]\/tmp\/sentinel/.test(code(AGENT)));
  check("T8 a write that fails is logged, not swallowed", /catch\(e\) \{ if \(!saveFailed\) log\("state file not written \(/.test(SENTINEL));
}

console.log("\n[" + TAG + "] what /sentinel answers from the file the sentinel wrote");
{
  // The route's own lines, run against a file written the way the sentinel writes it.
  const a = AGENT.indexOf("      var sentinelData = { status: \"unknown\", last_check: null };"), b = AGENT.indexOf("      res.writeHead(200", a);
  const route = new Function("readFileSync", "sentinelStatePath", "LOG_DIR", "internal", "Date", AGENT.slice(a, b) + "\nreturn sentinelData;");
  const dir = mkdtempSync(join(tmpdir(), "dno-sentinel-")), NOW = 1_790_000_000_000;
  class At extends Date { static now() { return NOW; } }
  const answer = (internal) => route(readFileSync, sentinelStatePath, dir, internal, At);
  check("R1 no file yet: unknown, and nothing thrown", a > 0 && b > a && JSON.stringify(answer(false)) === JSON.stringify({ status: "unknown", last_check: null }) && JSON.stringify(answer(true)) === JSON.stringify({ status: "unknown", last_check: null, alerts_24h: null }));
  writeFileSync(sentinelStatePath(dir), JSON.stringify({ "stall:fleet-n3": NOW - 3600000, "lag:fleet-n4": NOW - 30 * 3600000, _lastCheck: NOW - 120000 }));
  const pub = answer(false), int = answer(true);
  check("R2 a check two minutes ago: ok, with when", pub.status === "ok" && pub.last_check === new Date(NOW - 120000).toISOString(), JSON.stringify(pub));
  check("R3 the public answer is status and last_check and nothing else: no alert count (it is a number about the operator's own nodes), no alert key", JSON.stringify(Object.keys(pub)) === JSON.stringify(["status", "last_check"]) && !/fleet-n|alerts/.test(JSON.stringify(pub)));
  check("R3b the internal listener gets the count of the last 24 h and the keys", int.alerts_24h === 1 && JSON.stringify(int.recent_alert_keys) === JSON.stringify(["stall:fleet-n3"]));
  writeFileSync(sentinelStatePath(dir), JSON.stringify({ _lastCheck: NOW - 16 * 60000 }));
  check("R4 no check for more than 15 minutes: unknown; no count on either listener", answer(false).status === "unknown" && !("alerts_24h" in answer(false)) && answer(true).alerts_24h === null);
  check("R5 /docs says what the public route gives", AGENT.includes("docsEntry('GET /sentinel', 'Whether DNO\\'s own alert process completed a check in the last 15 minutes: status ok or unknown, and last_check. No counts.')"));
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
