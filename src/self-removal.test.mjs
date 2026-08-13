// self-removal.test.mjs — SELF_ROUTE_REMOVAL guard.
//
// Invariant: /self is not part of the public HTTP API.
// The former /self route exposed runtime/diagnostic fields and an RPC value
// whose runtime source can include private fallback configuration.
//
// This suite is intentionally narrow:
//   - prove the /self responder is absent;
//   - prove /self is no longer advertised;
//   - keep route-local diagnostic scaffolding deleted;
//   - prove the normal unknown-route 404 catch-all remains;
//   - prove the route-removal checker detects an in-memory reintroduction.
//
// It does NOT impose source-wide bans on wallet, RPC, balance, or other symbols
// that have legitimate retained uses elsewhere.
//
// Run source checks:
//   bun run src/self-removal.test.mjs
//
// Run source + served checks after deployment:
//   bun run src/self-removal.test.mjs http://127.0.0.1:55225
//
// NOT `bun test` — this is an executable script harness.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const BASE = process.argv[2] || null;

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function hasSelfResponder(src) {
  return /req\.url\s*===\s*["']\/self["']/.test(src);
}

function hasSelfLiteral(src) {
  return /["']\/self["']/.test(src);
}

function hasTerminal404(src) {
  return /\}\s*else\s*\{\s*res\.writeHead\(404\);\s*res\.end\(JSON\.stringify\(\{\s*error\s*:/.test(src);
}

// S1 — /self responder is gone.
check(
  "S1 no /self responder",
  !hasSelfResponder(SRC)
);

// S2 — /self is not self-advertised or otherwise retained as a route literal.
check(
  "S2 no /self route literal",
  !hasSelfLiteral(SRC)
);

// S3 — route-local diagnostic scaffolding stays deleted.
check(
  "S3a writeBudget removed",
  !SRC.includes("writeBudget")
);

check(
  "S3b selfBudget removed",
  !SRC.includes("selfBudget")
);

// S4 — ordinary unknown-route fall-through remains present.
// This is a structural-presence guard, not a full parser of the dispatcher.
check(
  "S4 terminal JSON 404 catch-all present",
  hasTerminal404(SRC)
);

// S5 — mutation sensitivity, entirely in memory.
// Reinsert a synthetic /self matcher immediately before an existing route.
const mutationAnchor = '} else if (req.url === "/organism/schema") {';
const mutated = SRC.replace(
  mutationAnchor,
  '} else if (req.url === "/self") {\n' +
    '      res.writeHead(200, { "Content-Type": "application/json" });\n' +
    '      res.end(JSON.stringify({ synthetic: true }));\n' +
    '    ' + mutationAnchor
);

check(
  "S5a mutation anchor applied",
  mutated !== SRC,
  "organism/schema anchor was not found"
);

check(
  "S5b reintroduced /self is detected",
  mutated !== SRC && hasSelfResponder(mutated),
  "route-removal checker did not detect synthetic /self"
);

// S6–S7 — deployment-only served-surface compatibility proof.
if (BASE) {
  try {
    const r = await fetch(BASE.replace(/\/+$/, "") + "/self");
    const body = await r.text();

    check(
      "S6 served /self returns 404",
      r.status === 404,
      `HTTP ${r.status}`
    );

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}

    check(
      "S7 /self uses ordinary unknown-route contract",
      parsed &&
        typeof parsed === "object" &&
        parsed.error === "Not found. Try /docs for API documentation.",
      "unexpected 404 response body"
    );
  } catch (err) {
    check(
      "S6 served /self returns 404",
      false,
      String(err?.message || err)
    );
    check(
      "S7 /self uses ordinary unknown-route contract",
      false,
      "request failed before response-body check"
    );
  }
} else {
  console.log("  skip S6-S7 served checks (no baseUrl argument)");
}

console.log(`\nSELF_ROUTE_REMOVAL: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
