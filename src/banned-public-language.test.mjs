// banned-public-language.test.mjs — one ban list, and a disavowal-aware check.
// A plain substring test fails on the commerce disclaimer, which says
// "recommend transactions" in order to reject that reading.
// Run: bun src/banned-public-language.test.mjs

import {
  ALLOWED_DISAVOWALS,
  BANNED_PUBLIC_LANGUAGE,
  CHARACTERIZATION,
  publicLanguageHit,
} from "./banned-public-language.mjs";

const TAG = "BANNED_PUBLIC_LANGUAGE";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const MUST_HIT = [
  "validator quality",
  "DNO becomes the canonical public record of growth",
  "canonical truth",
  "network truth",
  "commerce transactions settled",
  "this rail is real",
  "organic demand",
  "adoption of the rail",
];

console.log("\n[" + TAG + "] the shared list");
for (const phrase of MUST_HIT) {
  check("hits: " + phrase, publicLanguageHit(phrase));
}
check("hyphenated disavowal is not the banned phrase",
  !BANNED_PUBLIC_LANGUAGE.test("never a validator-quality metric"));
check("characterization does not treat validator_growth as adoption",
  !CHARACTERIZATION.test("validator_growth.first_counted"));

const disclaimer = ALLOWED_DISAVOWALS[2];
check("a bare 'transaction' search hits the required disclaimer",
  /\btransactions?\b/i.test(disclaimer));
check("the shared list leaves that disclaimer in place",
  !publicLanguageHit(disclaimer));
check("a disavowal glued to a real claim still hits",
  publicLanguageHit(disclaimer + " Demos shows organic demand."));

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
