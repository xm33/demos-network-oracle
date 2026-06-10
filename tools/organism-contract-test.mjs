// DNO /organism contract test — public verification tool.
// Usage:
//   bun tools/organism-contract-test.mjs [baseUrl] [localSchemaPath]
//   bun tools/organism-contract-test.mjs                          # localhost, schema fetched from live /organism/schema
//   bun tools/organism-contract-test.mjs https://demos-oracle.com # verify the public deployment yourself
// Exit 0 = response conforms to the published contract; non-zero = violation (details on stderr).
// DNO informs context; it does not advise, predict, score, certify, or decide action.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "fs";

const base = process.argv[2] || "http://localhost:55225";
const schemaPath = process.argv[3] || null;

let schema;
if (schemaPath) {
  schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  console.log("schema source: local file " + schemaPath);
} else {
  const r = await fetch(base + "/organism/schema");
  if (!r.ok) { console.error("FAIL: GET /organism/schema -> HTTP " + r.status); process.exit(1); }
  schema = await r.json();
  console.log("schema source: " + base + "/organism/schema");
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
if (!ajv.validateSchema(schema)) {
  console.error("FAIL: schema itself is invalid:\n" + ajv.errorsText(ajv.errors, { separator: "\n" }));
  process.exit(1);
}
const validate = ajv.compile(schema);

const resp = await fetch(base + "/organism");
if (!resp.ok) { console.error("FAIL: GET /organism -> HTTP " + resp.status); process.exit(1); }
const data = await resp.json();

const bad = (schema.required || []).filter(k => data[k] === null || data[k] === undefined);
if (bad.length) { console.error("FAIL: required top-level fields null/missing: " + bad.join(", ")); process.exit(1); }

if (!validate(data)) {
  console.error("FAIL: contract violations:\n" + ajv.errorsText(validate.errors, { separator: "\n" }));
  process.exit(1);
}
const v = (schema["x-changelog"] && schema["x-changelog"][0].version) || "?";
console.log("PASS: " + base + "/organism conforms to contract v" + v + " (" + (schema.required || []).length + " required fields, enums, types, non-null verified)");
