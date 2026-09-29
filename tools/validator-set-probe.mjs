// validator-set-probe.mjs — the named test before any copy for an on-chain validator block on the homepage.
//
// For each configured public seed (the Path A seeds in src/agent.mjs, or the name=url pairs given on the command line):
//   1. one GET /info                       → which keys the answer carries (names only, never values)
//   2. one nodeCall getNetworkParameters   → minValidatorStake as the seed reports it
//   3. one nodeCall getValidators          → how many rows, by status code
// nodeCalls use the Demos SDK's wire format (POST to the seed's root, method "nodeCall"), unauthenticated, read-only.
//
// It prints counts, the parameter, whether the seeds agree, and the /info key names. It never prints hosts,
// addresses, connectionUrl, per-row stake or full keys. Paste its output back; nothing here is published by DNO.
//
// --dial adds one round of the validator watch, run with the agent's own module (src/validator-watch.mjs): the list the
// seeds agree on, then GET /info once at the address each ACTIVE validator published on chain, only when it is a public
// http origin (pinned address, no redirects, 2 MB). It prints the counts the agent would publish on /health, nothing else.
//
// Run:  bun tools/validator-set-probe.mjs                 (seeds from src/agent.mjs)
//       bun tools/validator-set-probe.mjs name=url ...    (explicit seeds)
//       bun tools/validator-set-probe.mjs --dial [name=url ...]
// Exit: 0 when every answer had the expected shape (or no answer came), 2 when an answer had an unexpected shape.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runValidatorRound, createWatchHistory, publicOnChainValidators, publicValidatorWatch, WATCH_DEFAULTS } from "../src/validator-watch.mjs";
import { resolvePublicProbeOrigin, sanitizeHeight } from "../src/public-safety.mjs";

const TIMEOUT_MS = 8000;
const BODY_MAX_BYTES = 2 * 1024 * 1024;
// Status codes the SDK documents for the validators table (ValidatorTypes.d.ts): "2" ACTIVE, "3" UNSTAKING, "0" EXITED.
export const STATUS_WORD = { "2": "ACTIVE", "3": "UNSTAKING", "0": "EXITED" };

export function seedsFromAgent(agentSource) {
  const start = agentSource.indexOf("const PUBLIC_NODES = {");
  if (start < 0) throw new Error("PUBLIC_NODES not found in agent.mjs");
  const block = agentSource.slice(start, agentSource.indexOf("};", start));
  return [...block.matchAll(/"([a-z0-9-]+)":\s*\{[^}]*?url:\s*"([^"]+)"/g)].map((m) => ({ name: m[1], url: m[2] }));
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return await res.text();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_BYTES) { try { await reader.cancel(); } catch {} throw new Error("answer larger than 2 MB"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await readCapped(res);
  let body = null;
  try { body = JSON.parse(text); } catch { return { status: res.status, body: null, parseError: true }; }
  return { status: res.status, body };
}

function nodeCall(url, message, data = {}) {
  // The SDK's call(): { method: "nodeCall", params: [content] } with type, message, data, extra. The node answers
  // { result, response, ... }; the SDK hands back `response`.
  const content = { type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data, extra: "" };
  return getJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "nodeCall", params: [content] }) });
}

const keysOf = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : []);
const nested = (o) => keysOf(o).map((k) => (o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? `${k}{${keysOf(o[k]).join(", ")}}` : k));

export async function probeSeed(seed) {
  const out = { name: seed.name, info: null, params: null, validators: null, shapeErrors: [] };
  const root = seed.url.replace(/\/+$/, "");
  // 1. /info: key names only.
  try {
    const r = await getJson(root + "/info");
    if (r.status !== 200 || !r.body || typeof r.body !== "object") out.info = { answered: false, why: r.status !== 200 ? "HTTP " + r.status : "not JSON" };
    else {
      const entry = Array.isArray(r.body.peerlist) && r.body.peerlist.length ? r.body.peerlist[0] : null;
      const all = [...nested(r.body), ...(entry ? nested(entry) : [])].join(" ");
      const id = typeof r.body.identity === "string" ? r.body.identity.toLowerCase() : null;
      const self = id && Array.isArray(r.body.peerlist) ? r.body.peerlist.find((p) => p && typeof p.identity === "string" && p.identity.toLowerCase() === id) : null;
      out.info = { answered: true, keys: nested(r.body), entryKeys: entry ? nested(entry) : [],
        hashField: /hash/i.test(all), shardField: /shard/i.test(all), ownHeight: self && self.sync ? sanitizeHeight(self.sync.block) : null };
    }
  } catch (e) { out.info = { answered: false, why: e.name === "TimeoutError" ? "no answer within 8 s" : "not reached" }; }
  // 2. getNetworkParameters
  try {
    const r = await nodeCall(root, "getNetworkParameters");
    const b = r.body;
    if (r.status !== 200 || !b) out.params = { answered: false, why: r.status !== 200 ? "HTTP " + r.status : "not JSON" };
    else if (b.result !== 200) out.params = { answered: false, why: "result " + b.result };
    else if (!b.response || typeof b.response !== "object" || typeof b.response.minValidatorStake !== "string" || !/^\d+$/.test(b.response.minValidatorStake)) {
      out.params = { answered: true, shapeOk: false }; out.shapeErrors.push("getNetworkParameters: no minValidatorStake digit string");
    } else out.params = { answered: true, shapeOk: true, minValidatorStake: b.response.minValidatorStake, keys: keysOf(b.response) };
  } catch (e) { out.params = { answered: false, why: e.name === "TimeoutError" ? "no answer within 8 s" : "not reached" }; }
  // 3. getValidators (current head)
  try {
    const r = await nodeCall(root, "getValidators", {});
    const b = r.body;
    if (r.status !== 200 || !b) out.validators = { answered: false, why: r.status !== 200 ? "HTTP " + r.status : "not JSON" };
    else if (b.result !== 200) out.validators = { answered: false, why: "result " + b.result };
    else if (!Array.isArray(b.response) || !b.response.every((v) => v && typeof v === "object" && typeof v.status === "string")) {
      out.validators = { answered: true, shapeOk: false }; out.shapeErrors.push("getValidators: not a list of rows with a status");
    } else {
      const byStatus = {};
      b.response.forEach((v) => { byStatus[v.status] = (byStatus[v.status] || 0) + 1; });
      out.validators = { answered: true, shapeOk: true, rows: b.response.length, byStatus, rowKeys: keysOf(b.response[0] || {}) };
    }
  } catch (e) { out.validators = { answered: false, why: e.name === "TimeoutError" ? "no answer within 8 s" : "not reached" }; }
  return out;
}

// What the homepage may say, from these answers. A value is printed only when at least two seeds report it and all
// that report it agree; otherwise "not reported".
export function summarize(results) {
  const withParams = results.filter((r) => r.params && r.params.shapeOk);
  const stakes = [...new Set(withParams.map((r) => r.params.minValidatorStake))];
  const withRows = results.filter((r) => r.validators && r.validators.shapeOk);
  const sig = (r) => JSON.stringify(Object.entries(r.validators.byStatus).sort());
  const rowSigs = [...new Set(withRows.map(sig))];
  const stake = withParams.length >= 2 && stakes.length === 1 ? stakes[0] : null;
  const rows = withRows.length >= 2 && rowSigs.length === 1 ? withRows[0].validators.byStatus : null;
  return { seeds: results.length, paramsAnswered: withParams.length, stakeAgrees: stakes.length <= 1, stake,
    validatorsAnswered: withRows.length, rowsAgree: rowSigs.length <= 1, rows,
    shapeErrors: results.flatMap((r) => r.shapeErrors.map((e) => `${r.name}: ${e}`)) };
}

export function formatReport(results, when = new Date()) {
  const lines = [`validator-set probe · ${when.toISOString()} · ${results.length} seed${results.length === 1 ? "" : "s"}`, ""];
  const status = (o) => (!o ? "not asked" : !o.answered ? `no answer (${o.why})` : o.shapeOk === false ? "answered, unexpected shape" : "answered");
  for (const r of results) {
    lines.push(r.name);
    lines.push(`  /info                 ${status(r.info)}${r.info && r.info.answered ? ` · keys: ${r.info.keys.join(", ")}` : ""}`);
    if (r.info && r.info.answered) {
      lines.push(`                        peerlist entry keys: ${r.info.entryKeys.join(", ") || "no entries"}`);
      lines.push(`                        a key naming a hash: ${r.info.hashField ? "yes" : "no"} · a key naming a shard: ${r.info.shardField ? "yes" : "no"}`);
    }
    lines.push(`  getNetworkParameters  ${status(r.params)}${r.params && r.params.shapeOk ? ` · minValidatorStake ${r.params.minValidatorStake} (as reported) · keys: ${r.params.keys.join(", ")}` : ""}`);
    const v = r.validators;
    lines.push(`  getValidators         ${status(v)}${v && v.shapeOk ? ` · ${v.rows} row${v.rows === 1 ? "" : "s"} · ${Object.entries(v.byStatus).sort().map(([k, n]) => `status "${k}"${STATUS_WORD[k] ? ` (${STATUS_WORD[k]})` : ""}: ${n}`).join(" · ") || "none"}` : ""}`);
    if (v && v.shapeOk && v.rowKeys.length) lines.push(`                        row keys: ${v.rowKeys.join(", ")} (values not printed)`);
  }
  const s = summarize(results);
  lines.push("", "Summary");
  lines.push(`  getNetworkParameters answered by ${s.paramsAnswered} of ${s.seeds}; minValidatorStake ${s.stake !== null ? `agrees: ${s.stake} (raw, as reported)` : s.paramsAnswered >= 2 && !s.stakeAgrees ? "differs between seeds: not reported" : "not reported (fewer than two answers)"}`);
  lines.push(`  getValidators answered by ${s.validatorsAnswered} of ${s.seeds}; counts by status ${s.rows ? `agree: ${Object.entries(s.rows).sort().map(([k, n]) => `${STATUS_WORD[k] || `"${k}"`} ${n}`).join(", ")}` : s.validatorsAnswered >= 2 && !s.rowsAgree ? "differ between seeds: not reported" : "not reported (fewer than two answers)"}`);
  lines.push(`  EXITED rows: getValidators lists rows still active at a block, so an EXITED count does not come from it.`);
  lines.push(`  Block text this read supports: ${s.rows || s.stake !== null ? "counts and the parameter above, as the public seeds report them" : "\"on-chain validator rows: not reported.\""}`);
  if (s.shapeErrors.length) lines.push("", "Unexpected shapes:", ...s.shapeErrors.map((e) => "  " + e));
  return { text: lines.join("\n"), summary: s };
}

// --dial: one watch round with the agent's module. The seeds' median comes from the seeds' own heights in this run's
// /info answers (at least two). opts.resolveOrigin exists for tests; the default is the agent's resolver.
export async function dialReport(seeds, results, opts = {}) {
  const hs = results.map((r) => (r.info && r.info.answered ? r.info.ownHeight : null)).filter((h) => h !== null && h !== undefined).sort((a, b) => a - b);
  const reference = hs.length >= 2 ? { height: hs[Math.floor(hs.length / 2)], observedAt: Date.now() } : null;
  const round = await runValidatorRound({ seeds, resolveOrigin: opts.resolveOrigin || resolvePublicProbeOrigin, reference: () => reference,
    history: createWatchHistory(WATCH_DEFAULTS.windowMs, WATCH_DEFAULTS.intervalMs) });
  const oc = publicOnChainValidators(round, round.listAt, { seedsConfigured: seeds.length });
  const w = publicValidatorWatch(round, round.roundAt, {});
  const lines = ["", "Watch (one round, --dial)"];
  lines.push(`  list: ${oc.state === "agreed" ? `${oc.seeds_agreed} of ${oc.seeds_configured} public seeds returned the same list · ${oc.listed} rows · ACTIVE ${oc.active} · UNSTAKING ${oc.unstaking === null ? "none listed" : oc.unstaking} · other ${oc.other_status}` : `no figure: ${oc.reason}`}`);
  lines.push(`  seeds' median: ${reference ? `${reference.height} (from ${hs.length} own heights)` : "not known (fewer than two own heights): heights not compared"}`);
  if (w.state !== "observed") { lines.push(`  dials: none (${w.reason})`); return { text: lines.join("\n"), onChain: oc, watch: w }; }
  const r = w.not_dialed_reasons;
  lines.push(`  ACTIVE rows dialed at the address each published on chain: ${w.watched - w.not_dialed} of ${w.watched}`);
  lines.push(`    not dialed ${w.not_dialed} (no public http origin published ${r.not_public_http} · name did not resolve to a public address ${r.name_unresolved} · seeds list different addresses ${r.seeds_differ} · over the round cap ${r.over_cap})`);
  lines.push(`    no answer ${w.no_answer}`);
  lines.push(`    answered with another key ${w.answered_other_key}`);
  lines.push(`    answered without a key ${w.answered_no_key}`);
  lines.push(`    answered as the listed key ${w.answered_as_listed}: ${w.at_seed_height === null ? `heights not compared (${w.height_not_compared} with a height)` : `at the seeds' height (±${w.height_band_blocks}) ${w.at_seed_height} · off ${w.off_seed_height}`} · own height not reported ${w.height_not_reported}`);
  lines.push(`  versions among answers as the listed key: ${w.versions.length ? w.versions.map((g) => `${g.version === null ? "no release version" : g.version} ${g.count}`).join(" · ") + (w.versions_other ? ` · other ${w.versions_other}` : "") : "none"}`);
  lines.push(`  every round, last hour: not from one run (the agent keeps an hour of rounds)`);
  return { text: lines.join("\n"), onChain: oc, watch: w };
}

if (import.meta.main) {
  const all = process.argv.slice(2);
  const dial = all.includes("--dial");
  const args = all.filter((a) => a !== "--dial");
  const here = dirname(fileURLToPath(import.meta.url));
  let seeds;
  if (args.length) seeds = args.map((a) => { const i = a.indexOf("="); return { name: a.slice(0, i), url: a.slice(i + 1) }; });
  else {
    let src = null;
    try { src = readFileSync(join(here, "..", "src", "agent.mjs"), "utf8"); } catch (e) {}
    if (!src) { console.error("No src/agent.mjs next to this tool. Give the seeds: bun validator-set-probe.mjs [--dial] name=http://host:port ..."); process.exit(64); }
    seeds = seedsFromAgent(src);
  }
  const results = [];
  for (const seed of seeds) results.push(await probeSeed(seed));
  const { text, summary } = formatReport(results);
  console.log(text);
  if (dial) console.log((await dialReport(seeds, results)).text);
  process.exit(summary.shapeErrors.length ? 2 : 0);
}
