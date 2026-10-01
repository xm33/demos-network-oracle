// catalog-intake.test.mjs — CATALOG_INTAKE guard: one public peerlist cannot fill the catalog.
// Runs the real catalogBeginCrawl / catalogIngestPeerlist / catalogFinishCrawl from agent.mjs (extracted from the
// source, with the source's constants) against an in-memory SQLite table built from the shipped schema.
// Rule under test: a new identity is retained only after two distinct public peerlists have listed it, in the same
// crawl or across crawls; until then it is pending (never published); the pending set is bounded; skips are logged.
// One peerlist brings at most CATALOG_MAX_NEW_PER_PEERLIST never-seen identities into the count per crawl.
// Run: bun src/catalog-intake.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { isValidIdentity, sanitizeLabel, sanitizeHeight } from "./public-safety.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, "agent.mjs"), "utf8");
const TAG = "CATALOG_INTAKE";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const extract = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n}\n", i) + 3); };
const declStart = SRC.indexOf("const CATALOG_MAX_ROWS = ");
const declEnd = SRC.indexOf("\n", SRC.indexOf("var catalogLatest = ", declStart)) + 1;
if (declStart < 0 || declEnd <= declStart) throw new Error("catalog declarations not found");
const code = SRC.slice(declStart, declEnd) + extract("function catalogBeginCrawl(") + extract("function catalogIngestPeerlist(") + extract("function catalogFinishCrawl(");
const createSql = SRC.match(/CREATE TABLE IF NOT EXISTS validator_discoveries \([^)]*\)/)[0];
const addedCols = JSON.parse(SRC.match(/\[("last_block INTEGER"[^\]]*)\]\.forEach\(function\(col\) \{\s*try \{ sharedDb\.run\("ALTER TABLE validator_discoveries/)[0].match(/\[[^\]]*\]/)[0]);

const SEED_IDS = new Set(["0x" + "a2".repeat(32), "0x" + "a3".repeat(32)]);
const id = (s) => "0x" + createHash("sha256").update(s).digest("hex");
function fresh(opts = {}) {
  const db = new Database(":memory:");
  db.run(createSql);
  addedCols.forEach((c) => db.run("ALTER TABLE validator_discoveries ADD COLUMN " + c));
  if (opts.failInsert) { const run = db.run.bind(db); db.run = (sql, params) => { if (/^INSERT/.test(sql)) throw new Error("disk full"); return run(sql, params); }; }
  const logs = [];
  const env = new Function("isValidIdentity", "sanitizeLabel", "sanitizeHeight", "isExcludedFromDiscovered", "sharedDb", "log", "logError",
    "var discoveredPeers = {};\n" + code + "\nreturn { begin: catalogBeginCrawl, ingest: catalogIngestPeerlist, finish: catalogFinishCrawl, pending: () => catalogPending, peers: () => discoveredPeers, consts: { MIN: CATALOG_MIN_PEERLISTS, PENDING_MAX: CATALOG_PENDING_MAX, PER_CRAWL: CATALOG_MAX_NEW_PER_CRAWL, PER_PEERLIST: CATALOG_MAX_NEW_PER_PEERLIST } };")(
    isValidIdentity, sanitizeLabel, sanitizeHeight, (x) => SEED_IDS.has(String(x).toLowerCase()), db, (m) => logs.push(m), (m) => logs.push("ERR " + m));
  const crawl = (at, lists) => { env.begin(); for (const [src, ids] of Object.entries(lists)) env.ingest(src, ids.map((x) => ({ identity: x, sync: { block: 100, status: "synced" }, status: { online: true } }))); env.finish([], at); };
  const rows = () => db.query("SELECT identity, first_seen, last_seen, public_listed_since, last_listed_by FROM validator_discoveries ORDER BY identity").all();
  const row = (x) => db.query("SELECT identity, first_seen, last_seen, public_listed_since, last_listed_by FROM validator_discoveries WHERE identity = ?").get(x.toLowerCase());
  const legacy = (x, at) => db.run("INSERT INTO validator_discoveries (identity, first_seen, last_seen, connection, online) VALUES (?, ?, ?, ?, ?)", [x.toLowerCase(), at, at, "unknown", 1]);
  return { env, crawl, rows, row, legacy, logs, db };
}
const T0 = 1_800_000_000_000, R = 20_000;

console.log("\n[" + TAG + "] two public peerlists before a new identity is kept");
{
  const t = fresh();
  const X = id("x"), Y = id("y");
  t.crawl(T0, { s2: [X, Y], s3: [Y] });
  check("C1 an identity listed by two peerlists in one crawl is kept", !!t.row(Y) && t.row(Y).first_seen === T0 && t.row(Y).public_listed_since === T0);
  check("C2 an identity listed by one peerlist only is not kept", !t.row(X));
  check("C3 nor published this crawl", !!t.env.peers()[Y.toLowerCase()] && !t.env.peers()[X.toLowerCase()]);
  check("C4 the wait is logged", t.logs.some((m) => /1 identity listed by one public peerlist only: not retained until a second lists it/.test(m)), t.logs.join(" | "));
  t.crawl(T0 + R, { s2: [X, Y], s3: [Y] });
  check("C5 the same peerlist listing it again is still one peerlist", !t.row(X));
  check("C6 no second log line for an identity already waiting", t.logs.filter((m) => /listed by one public peerlist only/.test(m)).length === 1);
  t.crawl(T0 + 2 * R, { s2: [Y], s3: [X, Y] });
  const x = t.row(X);
  check("C7 a second peerlist in a later crawl: kept, first recorded when first listed", !!x && x.first_seen === T0 && x.public_listed_since === T0 && x.last_seen === T0 + 2 * R, JSON.stringify(x));
  check("C8 and published from that crawl", !!t.env.peers()[X.toLowerCase()] && t.env.pending().size === 0);
  t.crawl(T0 + 3 * R, { s2: [X] });
  check("C9 a kept identity listed by one peerlist later keeps being updated", t.row(X).last_seen === T0 + 3 * R && t.row(X).last_listed_by === 1);
}
{
  const t = fresh();
  const Z = id("z");
  t.crawl(T0, { s2: [Z, Z.toUpperCase().replace("0X", "0x"), Z] });
  check("C10 one peerlist listing a key twice or in two cases is one peerlist", !t.row(Z) && t.env.pending().size === 1);
  t.crawl(T0 + R, { s2: ["0x" + "a2".repeat(32), "0x" + "A3".repeat(32)], s3: ["0x" + "a2".repeat(32)] });
  check("C11 the seeds' own identities never wait and are never kept", t.rows().length === 0 && t.env.pending().size === 1);
}

console.log("\n[" + TAG + "] a flood from one peerlist");
{
  const t = fresh();
  const { PER_PEERLIST } = t.env.consts;
  for (let c = 0; c < 3; c++) t.crawl(T0 + c * R, { poisoned: Array.from({ length: 2500 }, (_, i) => id("flood-" + c + "-" + i)), s3: [] });
  check("F1 thousands of identities from one peerlist add no row", t.rows().length === 0);
  check("F2 one peerlist brings at most its budget into the waiting set per crawl", t.env.pending().size === 3 * PER_PEERLIST, t.env.pending().size);
  check("F2b the rest is logged, per crawl", t.logs.filter((m) => new RegExp("^ERR .*1 public peerlist listed more than " + PER_PEERLIST + " new identities this crawl; " + (2500 - PER_PEERLIST) + " identities were not counted").test(m)).length === 3, t.logs.filter((m) => /per-crawl|listed more than/.test(m)).join(" | "));
}
{
  // The waiting set's own bound, reached with many peerlists within their budgets.
  const t = fresh();
  const { PENDING_MAX, PER_PEERLIST } = t.env.consts;
  const lists = {};
  for (let s = 0; s < 100; s++) lists["src-" + s] = Array.from({ length: PER_PEERLIST }, (_, i) => id("many-" + s + "-" + i));
  t.crawl(T0, lists);
  check("F3 the waiting set stays bounded, and dropping is logged", t.env.pending().size === PENDING_MAX && t.logs.some((m) => /^ERR .*waiting identit(y|ies) dropped: the pending set is full/.test(m)), t.env.pending().size);
  check("F4 the least recently listed are dropped first", !t.env.pending().has(id("many-0-0")) && t.env.pending().has(id("many-99-" + (PER_PEERLIST - 1))));
}

console.log("\n[" + TAG + "] caps still apply to identities two peerlists list");
{
  const t = fresh();
  const { PER_CRAWL, PER_PEERLIST } = t.env.consts;
  // Pairs of peerlists, each pair listing its own group of PER_PEERLIST identities: every listing is within budget.
  const groups = Math.ceil((PER_CRAWL + 100) / PER_PEERLIST), lists = {}, all = [];
  for (let g = 0; g < groups; g++) {
    const grp = Array.from({ length: PER_PEERLIST }, (_, i) => id("pair-" + g + "-" + i));
    lists["a" + g] = grp; lists["b" + g] = grp; all.push(...grp);
  }
  t.crawl(T0, lists);
  check("P1 at most the per-crawl cap is added", t.rows().length === PER_CRAWL, t.rows().length);
  check("P2 the rest is logged as not retained this crawl", t.logs.some((m) => new RegExp("^ERR .*" + (all.length - PER_CRAWL) + " new identities not retained this crawl \\(per-crawl or total cap reached\\); they wait for the next").test(m)), t.logs.join(" | "));
  t.crawl(T0 + R, { a0: all });                              // waiting and kept identities use no budget
  const late = t.row(all[all.length - 1]);
  check("P3 they are kept on a later crawl, first recorded when first listed", t.rows().length === all.length && !!late && late.first_seen === T0, JSON.stringify(late));
}

console.log("\n[" + TAG + "] rows recorded before 1.1 (from DNO's own node) follow the same rule");
{
  const t = fresh();
  const L = id("legacy");
  t.legacy(L, T0 - 90 * 86400000);
  t.crawl(T0, { s2: [L] });
  check("L1 a 1.0 row listed by one public peerlist stays hidden, first_seen unchanged", t.row(L).public_listed_since === null && t.row(L).first_seen === T0 - 90 * 86400000 && !t.env.peers()[L.toLowerCase()], JSON.stringify(t.row(L)));
  t.crawl(T0 + R, { s3: [L] });
  const l = t.row(L);
  check("L2 a second public peerlist makes it public, first recorded when a public peerlist first listed it", l.public_listed_since === T0 && l.first_seen === T0 && !!t.env.peers()[L.toLowerCase()], JSON.stringify(l));
  check("L3 it is logged as a 1.0 row made public", t.logs.some((m) => /1 row recorded before 1\.1 now listed by 2 public peerlists: public from now/.test(m)));
}

console.log("\n[" + TAG + "] promotions do not take waiting slots; a failed write publishes nothing and loses nothing");
{
  const t = fresh();
  const { PENDING_MAX, PER_PEERLIST } = t.env.consts;
  const lists = {};
  for (let s = 0; s < PENDING_MAX / PER_PEERLIST; s++) lists["w" + s] = Array.from({ length: PER_PEERLIST }, (_, i) => id("wait-" + s + "-" + i));
  t.crawl(T0, lists);
  const pair = Array.from({ length: PER_PEERLIST }, (_, i) => id("pair-x-" + i));
  t.crawl(T0 + R, { s2: pair, s3: pair });
  check("W1 same-crawl promotions drop no waiting identity", t.env.pending().size === PENDING_MAX && t.rows().length === PER_PEERLIST && !t.logs.some((m) => /pending set is full/.test(m)), [t.env.pending().size, t.rows().length]);
}
{
  const t = fresh({ failInsert: true });
  const A = id("fail-a"), Bk = id("fail-b");
  t.crawl(T0, { s2: [A, Bk], s3: [A, Bk] });
  check("W2 a failed write publishes nothing and logs no addition", t.rows().length === 0 && Object.keys(t.env.peers()).length === 0 && !t.logs.some((m) => /\+\d+ new identit/.test(m)) && t.logs.some((m) => /write failed: disk full/.test(m)));
  check("W3 the promoted identities wait again with their sources", t.env.pending().has(A.toLowerCase()) && t.env.pending().get(A.toLowerCase()).sources.length === 2);
}

console.log("\n[" + TAG + "] one peerlist's budget per crawl");
{
  const t = fresh();
  const { PER_PEERLIST } = t.env.consts;
  const L = id("legit-waiting");
  t.crawl(T0, { s2: [L] });                                   // listed once: waiting
  for (let c = 1; c <= 20; c++) t.crawl(T0 + c * R, { poisoned: Array.from({ length: 2500 }, (_, i) => id("b-flood-" + c + "-" + i)), s2: [] });
  check("B1 a waiting identity survives 20 crawls of a one-peerlist flood", t.env.pending().has(L.toLowerCase()) && t.env.pending().size === 1 + 20 * PER_PEERLIST, t.env.pending().size);
  t.crawl(T0 + 21 * R, { poisoned: Array.from({ length: 2500 }, (_, i) => id("b-flood-21-" + i)), s3: [L] });
  check("B2 and is kept when a second peerlist lists it, first recorded at its first listing", !!t.row(L) && t.row(L).first_seen === T0, JSON.stringify(t.row(L)));
}
{
  const t = fresh();
  const { PER_PEERLIST } = t.env.consts;
  const flood = Array.from({ length: 1000 }, (_, i) => id("b-pair-" + i));
  t.crawl(T0, { s2: flood, s3: flood });
  check("B3 a flood two peerlists list grows the catalog by at most the budget per crawl", t.rows().length === PER_PEERLIST, t.rows().length);
  t.crawl(T0 + R, { s2: flood, s3: flood });
  check("B3b and by the budget again the next crawl", t.rows().length === 2 * PER_PEERLIST, t.rows().length);
}
{
  const t = fresh();
  const { PER_PEERLIST } = t.env.consts;
  const W = Array.from({ length: 10 }, (_, i) => id("b-wait-" + i));
  t.crawl(T0, { s3: W });                                     // ten identities waiting on s3's listing
  const k = id("b-kept");
  t.crawl(T0 + R, { s2: [k], s3: [k] });                      // one kept identity
  const flood = Array.from({ length: 3 * PER_PEERLIST }, (_, i) => id("b-new-" + i));
  t.crawl(T0 + 2 * R, { s2: [...flood, ...W, k] });           // s2 lists far more new identities than its budget, then W and k
  check("B4 waiting and kept identities use no budget: W is kept and k stays listed", W.every((x) => !!t.row(x)) && t.row(k).last_seen === T0 + 2 * R, W.filter((x) => !t.row(x)).length);
  check("B4b the new identities beyond the budget are not counted this crawl", t.env.pending().size === PER_PEERLIST, t.env.pending().size);
}
{
  const t = fresh();
  const L = id("legacy-budget");
  t.legacy(L, T0 - 86400000);
  const { PER_PEERLIST } = t.env.consts;
  t.crawl(T0, { s2: [...Array.from({ length: PER_PEERLIST }, (_, i) => id("b-fill-" + i)), L], s3: [L] });
  check("B5 a row recorded before 1.1 uses no budget", t.row(L).public_listed_since === T0, JSON.stringify(t.row(L)));
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
