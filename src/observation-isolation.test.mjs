// observation-isolation.test.mjs — L1_OBSERVATION_ISOLATION guard.
//
// Watch-only invariant: the canonical assessment (computeCanonicalState ->
// /organism, /health) and the node-admission path (the submissions ->
// PUBLIC_NODES loader) must NEVER read the Under-Observation tables or any
// observation-side state. Observation is evidence; it is never an admission input.
//
// Option A (static): this test reads src/agent.mjs as text, extracts the exact
// bodies of the canonical/admission functions by brace-matching from a symbol
// anchor, and asserts ZERO forbidden references inside them — including raw SQL
// strings that name the observation tables. It changes nothing in agent.mjs.
//
// What it deliberately does NOT do: call computeCanonicalState() at runtime and
// diff output (true Layer C). That needs a refactor of the canonical function to
// be purely functional + exported — a separate, gated task. This static guard
// catches the realistic failure mode (a future edit adds an observation
// reference to a canonical body) without touching the safety-critical path.
//
// Run:  bun run src/observation-isolation.test.mjs   (NOT `bun test` — this is an
//       execute-the-IIFE harness; `bun test` reports 0/0 false-green.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const LINES = SRC.split("\n");

const L1_OBSERVATION_ISOLATION = "L1_OBSERVATION_ISOLATION";

// Symbols that must never appear inside a canonical/admission body.
const FORBIDDEN_CANONICAL_REFERENCES = [
  "node_observations",
  "observation_reset_events",
  "meets_published_criteria",
  "discoveredPeers",
  // evaluator exports go here when the evaluator exists, e.g. "evaluateObservations"
];

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}

// --- body extraction: brace-balance forward from a symbol anchor -------------
// Returns the source text of the block beginning at the first line matching
// `anchorRe`, ending at the line where brace depth returns to zero. Returns null
// if the anchor is not found (so the caller can fail loudly — see existence checks).
function extractBlock(anchorRe) {
  let startIdx = -1;
  for (let i = 0; i < LINES.length; i++) {
    if (anchorRe.test(LINES[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  let depth = 0, started = false, out = [];
  for (let i = startIdx; i < LINES.length; i++) {
    const line = LINES[i];
    out.push(line);
    for (const ch of line) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; }
    }
    if (started && depth === 0) break;
  }
  return out.join("\n");
}

// --- the canonical/admission bodies the guard protects -----------------------
// Anchored by symbol, not line number (line numbers drift; symbols are the contract).
const TARGETS = [
  {
    name: "computeCanonicalState",
    anchor: /^function computeCanonicalState\s*\(/,
  },
  {
    name: "submissions->PUBLIC_NODES loader (M9 try-block)",
    // The admission doorway: the try-block that reads approved submissions and
    // writes PUBLIC_NODES. Anchored on its distinctive query line; brace-balance
    // captures the enclosing try { ... } catch.
    anchor: /SELECT \* FROM submissions WHERE status='approved'/,
    // For a non-`function {` anchor, walk back to the opening `try {` so the
    // extracted block is the whole loader scope, not a mid-statement fragment.
    backAnchor: /^\s*try\s*\{/,
  },
];

// ============================================================================
// EXISTENCE GUARD (anti-false-green): a static body-scan that scans a
// function which has been renamed or deleted silently passes (empty input ->
// zero forbidden refs). So FIRST assert every target body is actually found.
// If computeCanonicalState is ever renamed, THIS fails loudly.
// ============================================================================
console.log(`\n[${L1_OBSERVATION_ISOLATION}] existence guards`);

const bodies = {};
for (const t of TARGETS) {
  let body;
  if (t.backAnchor) {
    // find the query line, then walk back to the nearest opening try {
    let qIdx = LINES.findIndex((l) => t.anchor.test(l));
    check(`target present: ${t.name}`, qIdx !== -1,
      "anchor query line not found — loader renamed or removed?");
    if (qIdx === -1) { bodies[t.name] = null; continue; }
    let openIdx = -1;
    for (let i = qIdx; i >= 0; i--) { if (t.backAnchor.test(LINES[i])) { openIdx = i; break; } }
    check(`enclosing scope found: ${t.name}`, openIdx !== -1, "no enclosing try { above query");
    // brace-balance forward from the try {
    let depth = 0, started = false, out = [];
    for (let i = openIdx; i < LINES.length; i++) {
      out.push(LINES[i]);
      for (const ch of LINES[i]) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
      if (started && depth === 0) break;
    }
    body = out.join("\n");
  } else {
    body = extractBlock(t.anchor);
    check(`target present: ${t.name}`, body !== null,
      "symbol not found — function renamed or removed?");
  }
  bodies[t.name] = body;
}

// Sanity: computeCanonicalState body must be substantial (guards against an
// anchor that matched a comment/string and extracted a 1-line fragment).
const ccs = bodies["computeCanonicalState"];
check("computeCanonicalState body is substantial (>50 lines)",
  ccs !== null && ccs.split("\n").length > 50,
  ccs ? `only ${ccs.split("\n").length} lines extracted` : "null body");

// ============================================================================
// LAYER A — single-writer assertion on the canonical input variable.
// latestPublicNodes must be assigned from publicNodeResults and nothing else.
// ============================================================================
console.log(`\n[${L1_OBSERVATION_ISOLATION}] Layer A — canonical single-writer`);

const writeMatches = LINES.filter((l) => /(^|[^.\w])latestPublicNodes\s*=[^=]/.test(l));
// Expected: the `let latestPublicNodes = []` declaration + one runtime assignment.
check("latestPublicNodes has exactly one runtime writer (+ its declaration)",
  writeMatches.length === 2,
  `found ${writeMatches.length} assignment lines: ${JSON.stringify(writeMatches.map(s=>s.trim()))}`);
const runtimeWrite = writeMatches.find((l) => !/let\s+latestPublicNodes/.test(l));
check("the runtime writer assigns from publicNodeResults",
  !!runtimeWrite && /latestPublicNodes\s*=\s*publicNodeResults\b/.test(runtimeWrite),
  runtimeWrite ? runtimeWrite.trim() : "no runtime write found");

// ============================================================================
// LAYER B — negative reachability: no forbidden reference inside any
// canonical/admission body. Includes raw SQL strings (catches a
// `SELECT ... FROM node_observations` join even via a helper IF that SQL is
// lexically in the scanned body).
// ============================================================================
console.log(`\n[${L1_OBSERVATION_ISOLATION}] Layer B — no observation references in canonical/admission bodies`);

for (const [name, body] of Object.entries(bodies)) {
  if (body === null) continue; // existence guard already failed for this one
  for (const ref of FORBIDDEN_CANONICAL_REFERENCES) {
    check(`${name}: no reference to "${ref}"`,
      !body.includes(ref),
      `forbidden symbol "${ref}" appears inside ${name} — watch-only boundary breach`);
  }
}

// ============================================================================
// LAYER B-SQL — belt-and-braces: assert the forbidden TABLE names never appear
// in any SQL string inside the canonical/admission bodies (semantic, not just
// variable-name). Redundant with the includes() check above for the table
// names, but explicit about the SQL surface so the intent is unmistakable.
// ============================================================================
console.log(`\n[${L1_OBSERVATION_ISOLATION}] Layer B-SQL — no observation tables in canonical SQL`);

const OBSERVATION_TABLES = ["node_observations", "observation_reset_events"];
for (const [name, body] of Object.entries(bodies)) {
  if (body === null) continue;
  // crude SQL-string scan: any quoted segment mentioning an observation table
  for (const tbl of OBSERVATION_TABLES) {
    const sqlRe = new RegExp(`(SELECT|FROM|JOIN|INTO|UPDATE)[^;]*\\b${tbl}\\b`, "i");
    check(`${name}: no SQL touches ${tbl}`,
      !sqlRe.test(body),
      `SQL referencing ${tbl} found inside ${name}`);
  }
}

// ----------------------------------------------------------------------------
console.log(`\n[${L1_OBSERVATION_ISOLATION}] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("  ✗ WATCH-ONLY BOUNDARY ASSERTION FAILED — do not deploy.");
  process.exit(1);
}
console.log("  ✓ canonical/admission paths are isolated from observation tables.");
