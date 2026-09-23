import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name); }
}
check("alias map absent", !SRC.includes("FIXNET_DISCOVERED_OPERATORS"));
check("no quoted Walter", !SRC.includes('"Walter"'));
check("no quoted R1", !SRC.includes('"R1"'));
check("no quoted R2", !SRC.includes('"R2"'));
check("no quoted R3", !SRC.includes('"R3"'));
check("resolver present", /function\s+resolveNodeDisplay\s*\(/.test(SRC));
const start = SRC.indexOf("function resolveNodeDisplay");
const next = SRC.indexOf("function toPublicPeer");
const body = SRC.slice(start, next);
check("resolver body has no alias map", !body.includes("FIXNET_DISCOVERED_OPERATORS"));
check("resolver returns discovered-last4", body.includes('return "discovered-" + (identity ? identity.substring(identity.length - 4) : "????");'));
check("toPublicPeer still calls resolver", /resolveNodeDisplay\s*\(\s*\{/.test(SRC));
console.log(passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
