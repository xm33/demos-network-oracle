// src/criteria-catalog-constitution.test.mjs — CRITERIA_CATALOG_CONSTITUTION guard.
// Invariant: /criteria is definitions-only — six criteria / five numeric thresholds,
// C6 descriptive & non-collapsing, evaluator gated-not-live, no (network|canonical|
// primary) "truth" claim, admission stays out of Demos's governance, page<->JSON
// version parity. Reads static files (for this static page, file bytes == served bytes).
// Run: bun run src/criteria-catalog-constitution.test.mjs   (NOT `bun test`)
// Wire: append to package.json "test" chain:  && bun src/criteria-catalog-constitution.test.mjs
// Breach: reintroduce "Demos alone owns admission" -> G3 FAIL; revert -> green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
// HTML/JSON live at repo ROOT (confirmed: methodology.html is at root, not src/);
// this guard file lives in src/, so go up one level.
const HTML_PATH = join(__dir, "..", "criteria.html");
const JSON_PATH = join(__dir, "..", "criteria.json");
const GUARD = "CRITERIA_CATALOG_CONSTITUTION";

const html = readFileSync(HTML_PATH, "utf8");
const json = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const meth = readFileSync(join(__dir, "..", "methodology.html"), "utf8");
const crit = (id) => json.criteria.find((c) => c.id === id);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}

console.log(`\n${GUARD} guard\n`);

// A — existence & metadata
check("A1 identifies as the Criteria Catalog",
      html.includes("Criteria Catalog") && html.includes("Criteria Framework v1.0"));
check("A2 links the machine-readable companion", html.includes("/criteria.json"));

// B — definitions-only boundary
check("B1 definitions-only, descriptive-not-prescriptive",
      html.includes("definitions only") && html.includes("descriptive not prescriptive"));
check("B2 disclaims per-participant application + results",
      html.includes("no named participant") && html.includes("This page contains no results"));
check("B3 evaluator flagged gated and not live", html.includes("gated and not live"));

// C — version parity + six-criteria/five-threshold invariant
check("C1 JSON metadata v1.0 / 2026-07-06 / definitions_only / 120h",
      json.criteria_framework_version === "1.0" && json.effective_date === "2026-07-06" &&
      json.status === "definitions_only" && json.observation_window_hours === 120);
check("C2 page and JSON agree on version/date",
      html.includes("v" + json.criteria_framework_version) && html.includes(json.effective_date));
check("C3 six criteria, five numeric + C6 descriptive",
      json.criteria.length === 6 &&
      crit("C1").threshold.operator === "<=" && crit("C1").threshold.value === 3 &&
      crit("C2").threshold.operator === ">=" && crit("C2").threshold.value === 97 &&
      crit("C3").threshold.operator === ">=" && crit("C3").threshold.value === 95 &&
      crit("C4").threshold.operator === "<=" && crit("C4").threshold.value === 2 &&
      crit("C5").threshold.operator === ">=" && crit("C5").threshold.value === 120 &&
      crit("C6").threshold.operator === "descriptive" && crit("C6").threshold.value === null);

// D — C6 descriptive / non-collapsing (the six/five confusion guard)
check("D1 C6 descriptive, no numeric threshold",
      html.includes("descriptive — no numeric threshold") && html.includes("not scored"));
check("D2 C6 never collapsed to a pole",
      html.includes("never collapsed into a good/bad pole") &&
      ["agreement_with_dno","honesty","safety"].every((k) => crit("C6").does_not_mean.includes(k)));

// E — no per-participant data + §2.5 "truth" ban
check("E1 no network/canonical/primary 'truth' claim", !/(network|canonical|primary)\s+truth/i.test(html));
check("E2 JSON marks per-node outputs not_published",
      ["per_node_results","per_node_measurements","scores","rankings","verdicts","reputation"]
        .every((k) => json.not_published.includes(k)));
check("E3 heuristic: no per-node result surface leaked",
      !/top\s+validators/i.test(html) && !/best\s+validator/i.test(html) &&
      !/approved\s+validator/i.test(html) && !/certified\s+validator/i.test(html) &&
      !/validator\s+(score|ranking|rank)\b/i.test(html));

// M — methodology page (/methodology): §2.5 "truth" ban applies here too
check("M3 no 'where truth comes from' claim", !/where\s+truth\s+comes\s+from/i.test(meth));

// F — gated evaluator boundary
check("F1 names the gated, separate evaluator capability",
      html.includes("separate, gated capability") && html.includes("meets-DNO-criteria"));
check("F2 JSON evaluator flags all off",
      json.evaluator_status === "gated_not_live" &&
      json.applied_to_participants === false &&
      json.currently_published_per_participant === false);

// G — banned words only in disavowals + admission-wording lock
check("G1 core disavowal sentence present",
      html.includes("does <b>not</b> score, rank, grade, certify, approve, recommend, or predict"));
check("G2 meets_published_criteria framed as never-a-score",
      html.includes("meets_published_criteria") && html.includes("validator-quality metric"));
check("G3 admission stays out of Demos governance",
      !/Demos\s+alone\s+(decides|owns)/i.test(html) && html.includes("not DNO's to decide"));

// R-series: B1 — community submission/approval subsystem removed (§2.1/§2.4/§2.6)
const agent = readFileSync(join(__dir, "..", "src", "agent.mjs"), "utf8");
check("R1a no /approve route",  !/indexOf\("\/approve/.test(agent));
check("R1b no /submit route",   !/req\.url === "\/submit"/.test(agent));
check("R1c no community node in public set",
  !/"community-node[12]"/.test(agent) && !/source_type:\s*"community"/.test(agent));
check("R1d computeCanonicalState still reads latestPublicNodes",
  /function computeCanonicalState[\s\S]{0,400}latestPublicNodes/.test(agent));
check("R1e no /submit link on homepage (tripwire; vacuous at introduction)",
  !/href="\/submit"/.test(readFileSync(join(__dir, "..", "homepage.html"), "utf8")));
check("R1f no /submit href anywhere in agent",  !/href="\/submit"/.test(agent));

// R2: /fixnet/health removed — no raw JSON representation of fleet/discovered topology (§2.6)
check("R2a no /fixnet/health route in agent",
  !/req\.url === "\/fixnet\/health"/.test(agent));
check("R2b no fixnet/health href in agent",
  !/href="\/fixnet\/health"/.test(agent));
check("R2c no fixnet/health href in homepage",
  !/href="\/fixnet\/health"/.test(readFileSync(join(__dir, "..", "homepage.html"), "utf8")));

console.log(`\n${GUARD}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
