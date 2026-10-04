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
// The same run is the named test for a Path A seed that would replace or join the three (T-R1 to T-R3): add the
// candidate as one more name=url pair and read its /info line (T-R1), whether it returned the same address–status list
// as the other seeds (T-R2), and whether any two seeds answered /info with the same identity (T-R3: one vantage, not two).
// Seed names are the ones given on the command line; identities are compared, never printed.
//
// --dial adds one round of the validator watch, run with the agent's own module (src/validator-watch.mjs): the list the
// seeds agree on, then GET /info once at the address each ACTIVE validator published on chain, only when it is a public
// http origin (pinned address, no redirects, 2 MB). It prints the counts the agent would publish on /health, nothing else.
//
// The named test before a restart is tools/pre-restart-check.mjs: it loads the Demos SDK first, as the agent does, and
// then runs this tool with the agent's own reads added (run(args, { agentReads: true })): each seed with readSeedInfo
// (src/seed-read.mjs), the validators that can stand in for a seed with readWitnesses (src/witnesses.mjs), and the
// agent's own rule on those reads, assess (src/status-rule.mjs). It ends with a verdict line.
//
// Run:  bun tools/validator-set-probe.mjs                 (seeds from src/agent.mjs)
//       bun tools/validator-set-probe.mjs name=url ...    (explicit seeds)
//       bun tools/validator-set-probe.mjs --dial [name=url ...]
// Exit: 0 when every answer had the expected shape (or no answer came), 2 when an answer had an unexpected shape,
//       3 from the pre-restart check when the agent could not publish a status from these reads (fewer than two seeds
//       gave their own height and no validator stands in), when a read ended in an internal error, or when two seeds
//       were asked for the validator list and none was agreed,
//       4 from the pre-restart check when the reads give a reading and no seed gave its own height: validators alone
//       stand in. The check cannot tell seeds that are down from a fault in DNO's own seed read, so it is not a pass.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { runValidatorRound, createWatchHistory, publicOnChainValidators, publicValidatorWatch, keyOf, WATCH_DEFAULTS, reduceValidatorRows, listSignature, largestGroup } from "../src/validator-watch.mjs";
import { resolvePublicProbeOrigin, sanitizeHeight, cappedJson, probeErrorCategory, nativeFetch } from "../src/public-safety.mjs";
import { readSeedInfo, seedsSufficient } from "../src/seed-read.mjs";
import { readWitnesses, createCandidateStore, witnessSnapshot, nextCandidates } from "../src/witnesses.mjs";
import { assess } from "../src/status-rule.mjs";

const TIMEOUT_MS = 8000;
const BODY_MAX_BYTES = 2 * 1024 * 1024;
// Status codes the SDK documents for the validators table (ValidatorTypes.d.ts): "2" ACTIVE, "3" UNSTAKING, "0" EXITED.
export const STATUS_WORD = { "2": "ACTIVE", "3": "UNSTAKING", "0": "EXITED" };

// The PUBLIC_NODES block of agent.mjs, without whole-line comments: a commented-out entry is not a seed of the agent.
function publicNodesBlock(agentSource) {
  const start = agentSource.indexOf("const PUBLIC_NODES = {");
  if (start < 0) throw new Error("PUBLIC_NODES not found in agent.mjs");
  return agentSource.slice(start, agentSource.indexOf("};", start)).replace(/^\s*\/\/.*$/gm, "");
}
export function seedsFromAgent(agentSource) {
  const block = publicNodesBlock(agentSource);
  // name, url, and the configured identity (compared with the answer, never printed).
  return [...block.matchAll(/"([a-z0-9-]+)":\s*\{([^}]*)\}/g)].map((m) => {
    const url = /url:\s*"([^"]+)"/.exec(m[2]), id = /identity:\s*"(0x[0-9a-fA-F]+)"/.exec(m[2]);
    return url ? { name: m[1], url: url[1], identity: id ? id[1] : null } : null;
  }).filter(Boolean);
}

// The pre-restart check compares each answer with the configured identity: an entry of PUBLIC_NODES it cannot read in
// full is an error, not a seed to skip or to take on its word. null when every configured seed was read.
// Entries are counted by their names ("name": {), so one whose url is not a string literal is seen as not read.
export function seedsUnread(agentSource, seeds) {
  const configured = (publicNodesBlock(agentSource).match(/"[^"\n]+":\s*\{/g) || []).length;
  const full = seeds.filter((s) => s.identity).length;
  return configured > 0 && seeds.length === configured && full === configured ? null : `src/agent.mjs configures ${configured} seeds; ${full} could be read with a url and an identity.`;
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
  // The runtime's fetch: under the SDK's replacement (pre-restart check) a body has no getReader and would be read uncapped.
  const res = await nativeFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
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

// The seeds as the agent reads them: readSeedInfo, the function the agent's public round calls, with the agent's timeout
// and cap, all seeds at once as in the agent. A seed from src/agent.mjs is read at its configured URL against its
// configured identity. A seed given as name=url has no configured identity: it is first asked which key it names.
export async function agentSeedReads(seeds, opts = {}) {
  return Promise.all(seeds.map(async (seed) => {
    const node = { url: seed.identity ? seed.url : seed.url.replace(/\/+$/, ""), identity: seed.identity || "" };
    if (!seed.identity) { const first = await readSeedInfo(node, opts); node.identity = first.ok && first.answeredId ? first.answeredId : ""; }
    return Object.assign({ name: seed.name }, await readSeedInfo(node, opts));
  }));
}
// One line per seed: names, categories and words, never a host, an address or a key.
export function agentSeedLine(r) {
  if (!r.ok) return `${r.name}  no answer (${r.error})`;
  const key = r.identityMatch === true ? "names the configured key" : r.identityMatch === false ? "names another key: no height is taken from it" : "names no key";
  const height = r.height_source === "self" ? "its own height" : r.height_source === "first_peer" ? "does not list itself: its first listed peer's height, which is not counted" : "no height";
  return `${r.name}  answered · ${key} · ${height}`;
}
// sdkReplaced: whether loading the SDK replaced the global fetch (pre-restart check), or null when no SDK was loaded.
export function agentReadsReport(reads, sdkReplaced, rpcs) {
  const s = seedsSufficient(reads);
  const lines = ["", "As the agent reads (readSeedInfo, the agent's own seed read)",
    `  bun ${typeof Bun !== "undefined" ? Bun.version : "?"} · ` + (sdkReplaced === null || sdkReplaced === undefined ? "no SDK was loaded for this run" : `the Demos SDK was loaded first, as in the agent; it ${sdkReplaced ? "replaced" : "did not replace"} the global fetch`),
    ...reads.map((r) => "  " + agentSeedLine(r)),
    `  ${s.answered} of ${reads.length} seeds answered; ${s.ownHeights} gave ${s.ownHeights === 1 ? "its" : "their"} own height. Two give a status from the seeds alone; with fewer, validators stand in (Witnesses, below).`];
  if (rpcs) lines.push(`  cross-check RPCs (not in status), the agent's capped read: ${rpcs.ok} of ${rpcs.total} answered` + (rpcs.total > rpcs.ok ? ` (${rpcs.failed.join(" · ")})` : ""));
  return { answered: s.answered, ownHeights: s.ownHeights, sufficient: s.sufficient, text: lines.join("\n") };
}
// The cross-check RPCs in src/fleet.config.mjs, read as the agent reads them. Counts and categories only: their names are
// fleet names and are not printed. null when there is no fleet config here. Not part of the verdict.
export async function agentRpcReads(rpcList) {
  if (!Array.isArray(rpcList) || rpcList.length === 0) return null;
  const out = await Promise.all(rpcList.map(async (rpc) => {
    try { const res = await cappedJson(rpc.url, null, { timeoutMs: 10000, maxBytes: BODY_MAX_BYTES }); return res.ok ? null : probeErrorCategory(null, res.status); }   // the agent's PUBLIC_PROBE_TIMEOUT_MS
    catch (e) { return probeErrorCategory(e); }
  }));
  const failed = out.filter((x) => x !== null), counts = {};
  failed.forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
  return { total: out.length, ok: out.length - failed.length, failed: Object.keys(counts).sort().map((c) => `${counts[c]} ${c}`) };
}
// The seeds as the agent hands them to its validator round: a seed whose /info named another key than the configured
// one is not asked for the list (its answers would not be that seed's). reads: agentSeedReads, or null.
export function seedsForRound(seeds, reads) {
  return seeds.map((s) => { const r = reads && reads.find((x) => x.name === s.name); return Object.assign({}, s, { exclude: r && r.ok && r.identityMatch === false ? "its last /info answered with another key" : null }); });
}
// The witness candidates the agent keeps (dno_meta in its store), read without writing: the store is opened read-only.
// { agreedAt, candidates } as createCandidateStore gives them; null when there is no store here; { unreadable: true }
// when there is one and it could not be read (that is not "the agent keeps none").
export function keptCandidates(storePath, now) {
  if (!existsSync(storePath)) return null;
  try {
    const db = new Database(storePath, { readonly: true });
    try { const store = createCandidateStore(db); return store.readable ? store.load(now) : { unreadable: true }; } finally { db.close(); }
  } catch (e) { return { unreadable: true }; }
}
// The validators that stand in when fewer than two seeds give their own height, read as the agent reads them
// (readWitnesses), and the agent's own rule on this run's reads (assess). The candidates are the ones the agent would
// hold after this run's validator round: the kept ones renewed by what the round showed (nextCandidates) when it counted
// (an agreed list and two seed heights), else the kept ones as they are. A configured seed's key is never among them,
// as in the agent. They are read in both cases, so the read itself is tested before every restart; the rule (assess)
// leaves them out while two seeds gave a height, where the agent does not read them at all. Counts only: never a key,
// an address or a height.
// o: { reads (agentSeedReads), dials, facts (this run's witnessFacts or null), kept ({ agreedAt, candidates }, null, or
//      { unreadable: true }), seedKeys (Set: the configured seeds' keys), resolveOrigin, fetch }.
// Returns { text, reading, mode, internalErrors, why }.
export async function witnessReport(o) {
  const lines = ["", "Witnesses (validators the agent reads when fewer than two seeds give their own height)"];
  const seedHeights = o.reads.filter((r) => r.ok && r.height_source === "self" && sanitizeHeight(r.block) !== null).map((r) => sanitizeHeight(r.block));
  const answered = o.reads.filter((r) => r.ok).length;
  let rows = null, source = null, agreedAt = null, why = null;
  if (!o.dials) { lines.push("  not read: the dials are off (VALIDATOR_WATCH_DIALS), and the agent then reads no validator"); why = "the dials are off"; }
  else {
    const seedKeys = o.seedKeys instanceof Set ? o.seedKeys : new Set();
    const unreadable = !!(o.kept && o.kept.unreadable);
    const keptList = (o.kept && Array.isArray(o.kept.candidates) ? o.kept.candidates : []).filter((c) => !seedKeys.has(c.key));
    const renewed = o.facts ? nextCandidates(keptList, o.facts) : null;
    if (renewed) source = { list: renewed, words: keptList.length ? "the ones the agent keeps, renewed by this run's validator list" : "from this run's validator list" };
    else if (keptList.length) { source = { list: keptList, words: "kept by the agent from the list two seeds agreed on at " + new Date(o.kept.agreedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" }; agreedAt = o.kept.agreedAt; }
    if (unreadable) lines.push("  the agent's store is here and could not be read: the candidates it keeps are not known to this check");
    if (!source || !source.list.length) {
      lines.push("  candidates: none (" + (source ? "no validator answered as listed at the seeds' height in this run, and none is kept" : unreadable ? "this run's validator round did not count, and the kept ones could not be read" : "this run's validator round did not count, and the agent keeps none here") + ")");
      why = source ? "no validator answered as listed at the seeds' height" : unreadable ? "the agent's store could not be read" : "the agent keeps no candidates here";
    } else {
      rows = await readWitnesses(source.list, Object.assign({}, o.resolveOrigin ? { resolveOrigin: o.resolveOrigin } : {}, o.fetch ? { fetch: o.fetch } : {}));
      const good = rows.filter((r) => r.asListed && r.height !== null).length, faults = rows.filter((r) => r.error === "internal error").length;
      lines.push(`  candidates: ${source.list.length}, ${source.words}`);
      lines.push(`  read as the agent reads them: ${good} of ${rows.length} answered as the listed key with ${good === 1 ? "its" : "their"} own height` + (faults ? ` · ${faults} ended in an internal error` : ""));
    }
  }
  const snap = rows ? witnessSnapshot(rows, agreedAt) : null;
  const reading = assess({ timeReason: null, seedsTotal: o.reads.length, seedsAnswered: answered, seedHeights,
    validators: snap ? { read: snap.read, heights: snap.rows.map((r) => r.height), listAgreedAt: null } : null,   // beside two seed heights the rule leaves them out
    maxIncidentSeverity: "none", publicIncidentCount: 0, movement: {} });
  const mode = reading.witnesses.mode, n = reading.witnesses.validators ? reading.witnesses.validators.counted : 0;
  const words = { seeds_only: `${seedHeights.length} seeds gave their own height, so the seeds alone decide and no validator enters the reading`,
    seed_and_validators: `one seed gave its own height and ${n} validator${n === 1 ? " is" : "s are"} within 25 blocks of it`,
    validators_only: `no seed gave its own height; ${n} validators agree within 25 blocks`, insufficient: "no reading" }[mode];
  lines.push(`  the agent's rule on these reads: ${words} (${mode})`);
  if (mode === "insufficient" && !why) why = seedHeights.length === 1 ? "none of the validators read is within 25 blocks of the seed" : "the validators read give no majority within 25 blocks";
  return { text: lines.join("\n"), reading, mode, counted: n, internalErrors: rows ? rows.filter((r) => r.error === "internal error").length : 0, why };
}

// The verdict of the pre-restart check. reads: agentSeedReads; listState: the validator list's state when it was read
// (null when it was not); shapeErrors: how many answers had an unexpected shape; witness: witnessReport's result (absent:
// the seeds alone are judged, as before 1.2). OK only when the agent could publish a status from these reads by its own
// rule (two seeds with their own height, or validators standing in for the missing one), no read ended in an internal
// error, and the validator list is agreed. A list that is not agreed is a note, not a failure, while fewer than two
// seeds are asked for it: two seeds are what agrees a list, and a seed that answered /info with another key than the
// configured one is not asked (its answers would not be that seed's).
// A reading without any seed height (validators alone) is said apart, with its own exit code: the seeds are read by
// name through the runtime's fetch and the validators at an address literal, so a fault in the first path alone looks
// exactly like every seed being down. Nothing restarts on it by itself.
export function agentVerdict(reads, listState, shapeErrors, witness) {
  const s = seedsSufficient(reads), problems = [], notes = [];
  const mode = witness ? witness.mode : s.sufficient ? "seeds_only" : "insufficient";
  const faults = reads.filter((r) => !r.ok && r.error === "internal error").length + (witness ? witness.internalErrors : 0);
  if (faults > 0) problems.push(`${faults} read${faults === 1 ? "" : "s"} ended in an internal error, a fault in DNO's own read and not the peer's`);
  if (mode === "insufficient") {
    const stand = witness ? `, or validators that stand in (${witness.why})` : "";
    if (s.reason === "too_few_answers") problems.push(`${s.answered} of ${reads.length} seeds answered /info, and the agent needs two${stand}`);
    else problems.push(`${s.ownHeights} of the ${s.answered} seeds that answered gave ${s.ownHeights === 1 ? "its" : "their"} own height, and the agent needs two${stand}`);
  }
  const asked = reads.filter((r) => r.ok && r.identityMatch !== false).length;   // the seeds the agent asks for the list
  if (listState !== null && listState !== "agreed") {
    if (asked >= 2 || !witness) problems.push("no validator list was agreed by two seeds");
    else notes.push("No validator list is agreed while fewer than two seeds are asked for it; the agent keeps a candidate for 24 h after its last answer.");
  }
  const shapeOnly = problems.length === 0 && shapeErrors > 0;
  if (shapeErrors > 0) problems.push("an answer had an unexpected shape (see above)");
  if (problems.length > 0) return { ok: false, code: shapeOnly ? 2 : 3, text: "AGENT READS FAILED: " + problems.join("; ") + ". Do not restart on this." };
  const tail = notes.length ? " " + notes.join(" ") : "";
  if (mode === "seed_and_validators") return { ok: true, code: 0, text: `AGENT READS OK: ${s.ownHeights} of ${reads.length} seeds gave its own height, and ${witness.counted} validator${witness.counted === 1 ? " that answers as listed is" : "s that answer as listed are"} within 25 blocks of it. The agent would publish a reading that rests on them.` + tail };
  if (mode === "validators_only") return { ok: false, code: 4, text: `AGENT READS GIVE A READING WITHOUT A SEED: no seed gave its own height, and ${witness.counted} validators that answer as listed agree within 25 blocks. The agent would publish a reading that rests on validators alone. This check cannot tell seeds that are down from a fault in DNO's own seed read: do not restart on this without knowing which it is.` + tail };
  return { ok: true, code: 0, text: `AGENT READS OK: ${s.ownHeights} of ${reads.length} seeds gave their own height` + (listState === null ? "." : ", and two seeds agree on the validator list.") };
}

// Field names as a peer sent them are text the peer chose, so none of them is printed as sent. Printed: which of the
// names DNO itself reads are present (a fixed list), and how many others there are. Whether some name contains "hash"
// or "shard" is told as yes or no.
const KNOWN_NAMES = Object.freeze(["identity", "peerlist", "version", "connection", "string", "status", "online", "ready", "sync", "block", "address", "connectionUrl", "firstSeen", "validAt", "minValidatorStake"]);
const isObject = (o) => !!o && typeof o === "object" && !Array.isArray(o);
export const keysOf = (o) => {
  if (!isObject(o)) return [];
  const all = Object.keys(o), known = KNOWN_NAMES.filter((k) => Object.prototype.hasOwnProperty.call(o, k)), other = all.length - known.length;
  return other ? known.concat(["(" + other + " other name" + (other === 1 ? "" : "s") + " not printed)"]) : known;
};
const nested = (o) => (isObject(o) ? KNOWN_NAMES.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => (isObject(o[k]) ? `${k}{${keysOf(o[k]).join(", ")}}` : k))
  .concat(keysOf(o).filter((k) => k.startsWith("("))) : []);
const namesHold = (o, word) => isObject(o) && Object.keys(o).some((k) => k.toLowerCase().includes(word) || (isObject(o[k]) && Object.keys(o[k]).some((j) => j.toLowerCase().includes(word))));
// A status is printed only as the code the SDK documents (digits); a result only as a small whole number; the stake
// only at the length the agent accepts.
const STATUS_CODE = /^\d{1,3}$/;
const STATUS_KINDS_MAX = 8;
const STAKE_DIGITS = /^\d{1,78}$/;
const resultWord = (v) => (Number.isInteger(v) && v >= 0 && v <= 999 ? String(v) : "not a status code");

export async function probeSeed(seed) {
  const out = { name: seed.name, info: null, params: null, validators: null, shapeErrors: [] };
  const root = seed.url.replace(/\/+$/, "");
  // 1. /info: key names only.
  try {
    const r = await getJson(root + "/info");
    if (r.status !== 200 || !r.body || typeof r.body !== "object") out.info = { answered: false, why: r.status !== 200 ? "HTTP " + r.status : "not JSON" };
    else {
      const entry = Array.isArray(r.body.peerlist) && r.body.peerlist.length ? r.body.peerlist[0] : null;
      const id = keyOf(r.body.identity);
      const self = id && Array.isArray(r.body.peerlist) ? r.body.peerlist.find((p) => p && keyOf(p.identity) === id) : null;
      out.info = { answered: true, keys: nested(r.body), entryKeys: entry ? nested(entry) : [],
        hashField: namesHold(r.body, "hash") || namesHold(entry, "hash"), shardField: namesHold(r.body, "shard") || namesHold(entry, "shard"),
        ownHeight: self && self.sync ? sanitizeHeight(self.sync.block) : null, key: id };
    }
  } catch (e) { out.info = { answered: false, why: e.name === "TimeoutError" ? "no answer within 8 s" : "not reached" }; }
  // 2. getNetworkParameters
  try {
    const r = await nodeCall(root, "getNetworkParameters");
    const b = r.body;
    if (r.status !== 200 || !b) out.params = { answered: false, why: r.status !== 200 ? "HTTP " + r.status : "not JSON" };
    else if (b.result !== 200) out.params = { answered: false, why: "result " + resultWord(b.result) };
    else if (!b.response || typeof b.response !== "object" || typeof b.response.minValidatorStake !== "string" || !STAKE_DIGITS.test(b.response.minValidatorStake)) {
      out.params = { answered: true, shapeOk: false }; out.shapeErrors.push("getNetworkParameters: no minValidatorStake digit string of at most 78 digits");
    } else out.params = { answered: true, shapeOk: true, minValidatorStake: b.response.minValidatorStake, keys: keysOf(b.response) };
  } catch (e) { out.params = { answered: false, why: e.name === "TimeoutError" ? "no answer within 8 s" : "not reached" }; }
  // 3. getValidators (current head)
  try {
    const r = await nodeCall(root, "getValidators", {});
    const b = r.body;
    if (r.status !== 200 || !b) out.validators = { answered: false, why: r.status !== 200 ? "HTTP " + r.status : "not JSON" };
    else if (b.result !== 200) out.validators = { answered: false, why: "result " + resultWord(b.result) };
    else if (!Array.isArray(b.response) || !b.response.every((v) => v && typeof v === "object" && typeof v.status === "string")) {
      out.validators = { answered: true, shapeOk: false }; out.shapeErrors.push("getValidators: not a list of rows with a status");
    } else {
      const byStatus = {}, firstSeen = new Map();   // its names are digits, or one of two fixed words (below)
      b.response.forEach((v) => {
        let st = STATUS_CODE.test(v.status.trim()) ? v.status.trim() : "(not a status code)";
        if (!(st in byStatus) && Object.keys(byStatus).length >= STATUS_KINDS_MAX) st = "(more kinds)";
        byStatus[st] = (byStatus[st] || 0) + 1;
        // ACTIVE rows' firstSeen, kept in memory only to count agreement; never printed.
        const k = keyOf(v.address);
        if (k && v.status === "2") firstSeen.set(k, firstSeenValue(v.firstSeen));
      });
      // The address–status pairs, in memory only, to compare whole lists across seeds (T-R2); never printed. A list the
      // agent would not accept (a row without a usable address or status, or an address twice) is an unexpected shape.
      const pairs = reduceValidatorRows(b.response);
      if (!pairs) out.shapeErrors.push("getValidators: a row without a usable address or status, or an address listed twice: the agent would not accept this list");
      out.validators = { answered: true, shapeOk: true, rows: b.response.length, byStatus, rowKeys: keysOf(b.response[0] || {}), firstSeen, pairs };
    }
  } catch (e) { out.validators = { answered: false, why: e.name === "TimeoutError" ? "no answer within 8 s" : "not reached" }; }
  return out;
}

// A firstSeen value, normalised for comparison: a whole number (or a string of digits), or a date string. null when
// absent; kind "other" for any other shape.
export function firstSeenValue(v) {
  if (Number.isSafeInteger(v) && v >= 0) return { key: "n" + v, n: v, kind: "number" };
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return { key: "n" + Number(v), n: Number(v), kind: "number" };
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))) return { key: "t" + Date.parse(v), n: Date.parse(v), kind: "date" };
  if (v === null || v === undefined || v === "") return null;
  return { key: "x" + String(v).slice(0, 64), n: null, kind: "other" };
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
    validatorsAnswered: withRows.length, rowsAgree: rowSigs.length <= 1, rows, firstSeen: firstSeenAgreement(withRows, results),
    lists: listAgreement(results), identities: identityOverlap(results),
    shapeErrors: results.flatMap((r) => r.shapeErrors.map((e) => `${r.name}: ${e}`)) };
}

// Whether the seeds agree on protocol firstSeen for ACTIVE rows, and what the agreed values look like (block heights or
// times), before any page may use it. A row agrees under the list's own rule: the single largest group of at least two
// seeds holding the same value. Counts only: no value, no key.
export function firstSeenAgreement(withRows, results) {
  if (withRows.length < 2) return null;
  const heights = results.map((r) => (r.info && r.info.answered ? r.info.ownHeight : null)).filter((h) => Number.isSafeInteger(h));
  const top = heights.length ? Math.max(...heights) : null;
  const keys = new Set(withRows.flatMap((r) => [...r.validators.firstSeen.keys()]));
  const out = { active: keys.size, agreed: 0, missing: 0, differ: 0, heights: 0, ms: 0, seconds: 0, dates: 0, other: 0 };
  keys.forEach((k) => {
    const vals = withRows.map((r) => r.validators.firstSeen.get(k)).filter((v) => v !== undefined);
    const present = vals.filter((v) => v !== null);
    const group = largestGroup(present.map((v) => ({ v, sig: v.key })));
    if (!group) { if (present.length < 2) out.missing++; else out.differ++; return; }
    out.agreed++;
    const v = group[0].v;
    if (v.kind === "date") out.dates++;
    else if (v.kind !== "number") out.other++;
    else if (v.n >= 1e12 && v.n < 1e14) out.ms++;
    else if (v.n >= 1e9 && v.n < 1e10) out.seconds++;
    else if (top !== null && v.n <= top + 1000) out.heights++;
    else out.other++;
  });
  return out;
}

// T-R2: which seeds returned the same address–status list (the agent's rule: the single largest group of at least two;
// largest groups that tie are no agreement), which returned another list, which returned a list the agent would not
// accept, and which returned none. Names only.
export function listAgreement(results) {
  const withPairs = results.filter((r) => r.validators && r.validators.shapeOk && Array.isArray(r.validators.pairs));
  const groups = new Map();
  withPairs.forEach((r) => { const sig = listSignature(r.validators.pairs); if (!groups.has(sig)) groups.set(sig, []); groups.get(sig).push(r.name); });
  const multi = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);
  const same = multi.length && (multi.length === 1 || multi[0].length > multi[1].length) ? multi[0] : [];
  const tied = !same.length && multi.length >= 2 ? multi.filter((g) => g.length === multi[0].length) : [];
  const grouped = same.concat(...tied);
  return { same, tied, other: withPairs.map((r) => r.name).filter((n) => !grouped.includes(n)),
    unaccepted: results.filter((r) => r.validators && r.validators.shapeOk && !Array.isArray(r.validators.pairs)).map((r) => r.name),
    none: results.filter((r) => !(r.validators && r.validators.shapeOk)).map((r) => r.name) };
}

// T-R3: seeds that answered /info with the same identity are one vantage, not two. Names only.
export function identityOverlap(results) {
  const byKey = new Map(), noKey = [];
  results.forEach((r) => {
    if (!(r.info && r.info.answered)) return;
    if (!r.info.key) { noKey.push(r.name); return; }
    if (!byKey.has(r.info.key)) byKey.set(r.info.key, []);
    byKey.get(r.info.key).push(r.name);
  });
  return { withKey: [...byKey.values()].reduce((t, g) => t + g.length, 0), noKey, shared: [...byKey.values()].filter((g) => g.length > 1) };
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
  const L = s.lists;
  lines.push(`  getValidators lists, address and status of every row: ${L.same.length ? `the same list from ${L.same.join(", ")}`
    : L.tied.length ? `a tie, no single largest group (${L.tied.map((g) => g.join(", ")).join(" / ")}): the agent publishes no figure` : "no two seeds returned the same list"}`
    + `${L.other.length ? ` · another list from ${L.other.join(", ")}` : ""}${L.unaccepted.length ? ` · a list the agent would not accept from ${L.unaccepted.join(", ")}` : ""}${L.none.length ? ` · no list from ${L.none.join(", ")}` : ""}`);
  const I = s.identities;
  lines.push(`  /info identities: ${I.withKey < 2 ? "fewer than two seeds answered with an identity" : I.shared.length ? I.shared.map((g) => `${g.join(" and ")} answered with the same identity (one vantage, not ${g.length})`).join("; ") : `each of the ${I.withKey} seeds that answered with an identity has its own`}`
    + `${I.noKey.length ? ` · an answer without an identity from ${I.noKey.join(", ")}` : ""} (not printed)`);
  const fs = s.firstSeen;
  if (fs) lines.push(`  firstSeen on ACTIVE rows: two or more seeds agree on ${fs.agreed} of ${fs.active} (missing ${fs.missing} · differ ${fs.differ}); agreed values look like block heights ${fs.heights} · millisecond times ${fs.ms} · second times ${fs.seconds} · date strings ${fs.dates} · other ${fs.other} (values not printed)`);
  lines.push(`  Block text this read supports: ${s.rows || s.stake !== null ? "counts and the parameter above, as the public seeds report them" : "\"on-chain validator rows: not reported.\""}`);
  if (s.shapeErrors.length) lines.push("", "Unexpected shapes:", ...s.shapeErrors.map((e) => "  " + e));
  return { text: lines.join("\n"), summary: s };
}

// --dial: one watch round with the agent's module. The seeds' median comes from the seeds' own heights (at least two):
// by the agent's own read rule when its reads are at hand (opts.reads: a seed that answered with another key gives no
// height there, as in the agent), else from this run's /info answers. opts.resolveOrigin exists for tests; the default is
// the agent's resolver.
export async function dialReport(seeds, results, opts = {}) {
  const hs = (Array.isArray(opts.reads)
    ? opts.reads.map((r) => (r.ok && r.height_source === "self" ? sanitizeHeight(r.block) : null))
    : results.map((r) => (r.info && r.info.answered ? r.info.ownHeight : null))).filter((h) => h !== null && h !== undefined).sort((a, b) => a - b);
  const reference = hs.length >= 2 ? { height: hs[Math.floor(hs.length / 2)], observedAt: Date.now() } : null;
  // A seed's key: the configured one, and the one its /info named (seeds given on the command line have none configured).
  const seedKeys = new Set(results.map((r) => (r.info && r.info.answered ? r.info.key : null)).concat(seeds.map((x) => keyOf(x.identity))).filter(Boolean));
  const dials = opts.dials !== false;
  const round = await runValidatorRound({ seeds, resolveOrigin: opts.resolveOrigin || resolvePublicProbeOrigin, reference: () => reference, seedKeys,
    first: opts.first instanceof Set ? opts.first : new Set(), history: createWatchHistory(WATCH_DEFAULTS.windowMs, WATCH_DEFAULTS.intervalMs), dials });
  const oc = publicOnChainValidators(round, round.listAt, { seedsConfigured: seeds.length });
  const w = publicValidatorWatch(round, round.roundAt, { dials });
  const lines = ["", dials ? "Watch (one round, --dial)" : "Watch (one round: the list only, no dials)"];
  lines.push(`  list: ${oc.state === "agreed" ? `${oc.seeds_agreed} of ${oc.seeds_configured} public seeds returned the same list · ${oc.listed} rows · ACTIVE ${oc.active} · UNSTAKING ${oc.unstaking === null ? "none listed" : oc.unstaking} · other ${oc.other_status}` : `no figure: ${oc.reason}`}`);
  lines.push(`  seeds' median: ${reference ? `${reference.height} (from ${hs.length} own heights)` : "not known (fewer than two own heights): heights not compared"}`);
  if (w.state !== "observed") { lines.push(`  dials: none (${w.reason})`); return { text: lines.join("\n"), onChain: oc, watch: w, facts: round.witnessFacts, seedKeys }; }
  const r = w.not_dialed_reasons;
  lines.push(`  ACTIVE rows dialed at the address each published on chain: ${w.watched - w.not_dialed} of ${w.watched}, on ${w.origins_dialed} origin${w.origins_dialed === 1 ? "" : "s"} (most rows on one origin: ${w.max_rows_per_origin})`);
  lines.push(`    not dialed ${w.not_dialed} (no address published ${r.no_address} · not a public http origin ${r.not_public_http} · name did not resolve to a public address ${r.name_unresolved} · seeds list different addresses ${r.seeds_differ} · over the round cap ${r.over_cap})`);
  lines.push(`    no answer ${w.no_answer}`);
  lines.push(`    answered with another key ${w.answered_other_key} (sharing an origin with a key that answered there: ${w.other_key_shared}, on ${w.other_key_shared_origins} origin${w.other_key_shared_origins === 1 ? "" : "s"})`);
  lines.push(`    answered without a key ${w.answered_no_key}`);
  lines.push(`    answered as the listed key ${w.answered_as_listed} (Path A seed keys among them: ${w.answered_as_listed_seeds}): ${w.at_seed_height === null ? `heights not compared (${w.height_not_compared} with a height)` : `at the seeds' height (±${w.height_band_blocks}) ${w.at_seed_height} · off ${w.off_seed_height}`} · own height not reported ${w.height_not_reported}`);
  lines.push(`  versions among answers as the listed key: ${w.versions.length ? w.versions.map((g) => `${g.version === null ? "no release version" : g.version} ${g.count}`).join(" · ") + (w.versions_other ? ` · other ${w.versions_other}` : "") : w.versions_other ? `other ${w.versions_other}` : "none"}`);
  lines.push(`  every round, last hour: not from one run (the agent keeps an hour of rounds)`);
  return { text: lines.join("\n"), onChain: oc, watch: w, facts: round.witnessFacts, seedKeys };
}

// args: [--dial] [name=url ...]. ctx.agentReads adds the agent's own /info read and a verdict line (pre-restart check).
// ctx.agentSource: the text to take the seeds from in place of src/agent.mjs (tests). Returns the exit code.
export async function run(all, ctx = {}) {
  const dial = all.includes("--dial");
  const args = all.filter((a) => a !== "--dial");
  const bad = args.filter((a) => !/^[A-Za-z0-9._-]+=https?:\/\/\S+$/.test(a));
  // An argument is not echoed: a mistyped pair still carries its host.
  if (bad.length) { console.error(bad.length + " argument" + (bad.length === 1 ? " is" : "s are") + " not a name=url pair.\nUsage: bun validator-set-probe.mjs [--dial] name=http://host:port ..."); return 64; }
  const here = dirname(fileURLToPath(import.meta.url));
  let seeds;
  if (args.length) seeds = args.map((a) => { const i = a.indexOf("="); return { name: a.slice(0, i), url: a.slice(i + 1) }; });
  else {
    let src = null;
    try { src = typeof ctx.agentSource === "string" ? ctx.agentSource : readFileSync(join(here, "..", "src", "agent.mjs"), "utf8"); } catch (e) {}
    if (!src) { console.error("No src/agent.mjs next to this tool. Give the seeds: bun validator-set-probe.mjs [--dial] name=http://host:port ..."); return 64; }
    let missing;
    try { seeds = seedsFromAgent(src); missing = seedsUnread(src, seeds); }
    catch (e) { console.error("The seeds could not be read from src/agent.mjs: it has no PUBLIC_NODES block."); return 64; }
    if (ctx.agentReads && missing) { console.error(missing + " The pre-restart check needs all of them."); return 64; }
  }
  const results = [];
  for (const seed of seeds) results.push(await probeSeed(seed));
  const { text, summary } = formatReport(results);
  console.log(text);
  let reads = null;
  if (ctx.agentReads) {
    reads = await agentSeedReads(seeds);
    console.log(agentReadsReport(reads, ctx.sdkReplaced, await agentRpcReads(ctx.rpcs)).text);
  }
  // The kept candidates, for the pre-restart check. ctx.kept: given by tests; by default the agent's store in this
  // folder (LOG_DIR as the agent reads it, logs by default), opened read-only.
  const kept = !ctx.agentReads ? null : ctx.kept !== undefined ? ctx.kept : keptCandidates(join(process.env.LOG_DIR || "logs", "marketplace.db"), Date.now());
  const keptKeys = new Set((kept && Array.isArray(kept.candidates) ? kept.candidates : []).map((c) => c.key));
  // The pre-restart check always reads the validator list, as the agent does; it dials only with --dial. The kept
  // candidates are dialed first, as in the agent.
  let listState = null, facts = null, seedKeys = new Set(seeds.map((x) => keyOf(x.identity)).filter(Boolean));
  if (dial || ctx.agentReads) {
    const d = await dialReport(seedsForRound(seeds, reads), results, Object.assign({ dials: dial, reads, first: keptKeys }, ctx.resolveOrigin ? { resolveOrigin: ctx.resolveOrigin } : {}));
    console.log(d.text);
    listState = d.onChain.state; facts = d.facts; seedKeys = d.seedKeys;
  }
  if (!ctx.agentReads) return summary.shapeErrors.length ? 2 : 0;
  // The witnesses, as the agent would read them.
  const witness = await witnessReport({ reads, dials: dial, facts, kept, seedKeys, resolveOrigin: ctx.resolveOrigin });
  console.log(witness.text);
  const verdict = agentVerdict(reads, listState, summary.shapeErrors.length, witness);
  console.log("\n" + verdict.text);
  return verdict.code;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
