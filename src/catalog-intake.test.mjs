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
const lineOf = (start) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not in agent.mjs: " + start); return SRC.slice(i, SRC.indexOf("\n", i) + 1); };
const code = lineOf("const CATALOG_AFTER_UNKNOWN = ") + SRC.slice(declStart, declEnd) + extract("function loadCatalogCountStarted(") + extract("function catalogBeginCrawl(") + extract("function catalogIngestPeerlist(") + extract("function catalogFinishCrawl(");
const createSql = SRC.match(/CREATE TABLE IF NOT EXISTS validator_discoveries \([^)]*\)/)[0];
const addedCols = JSON.parse(SRC.match(/\[("last_block INTEGER"[^\]]*)\]\.forEach\(function\(col\) \{\s*try \{ sharedDb\.run\("ALTER TABLE validator_discoveries/)[0].match(/\[[^\]]*\]/)[0]);

const SEED_IDS = new Set(["0x" + "a2".repeat(32), "0x" + "a3".repeat(32)]);
const id = (s) => "0x" + createHash("sha256").update(s).digest("hex");
// opts.db: an existing store (a restart: the waiting set and every other in-memory value start empty, the store stays).
function fresh(opts = {}) {
  const db = opts.db || new Database(":memory:");
  if (!opts.db) {
    db.run(createSql);
    addedCols.forEach((c) => db.run("ALTER TABLE validator_discoveries ADD COLUMN " + c));
  }
  if (opts.failInsert) { const run = db.run.bind(db); db.run = (sql, params) => { if (/^INSERT/.test(sql)) throw new Error("disk full"); return run(sql, params); }; }
  const logs = [];
  const env = new Function("isValidIdentity", "sanitizeLabel", "sanitizeHeight", "isExcludedFromDiscovered", "sharedDb", "log", "logError",
    "var discoveredPeers = {};\n" + code + "\nreturn { boot: function() { catalogCountStarted = loadCatalogCountStarted(sharedDb); }, started: () => catalogCountStarted, begin: catalogBeginCrawl, ingest: catalogIngestPeerlist, finish: catalogFinishCrawl, pending: () => catalogPending, readAt: () => catalogSourceReadAt, peers: () => discoveredPeers, consts: { MIN: CATALOG_MIN_PEERLISTS, PENDING_MAX: CATALOG_PENDING_MAX, PER_CRAWL: CATALOG_MAX_NEW_PER_CRAWL, PER_PEERLIST: CATALOG_MAX_NEW_PER_PEERLIST, SOURCES_MAX: CATALOG_SOURCES_MAX } };")(
    isValidIdentity, sanitizeLabel, sanitizeHeight, (x) => SEED_IDS.has(String(x).toLowerCase()), db, (m) => logs.push(m), (m) => logs.push("ERR " + m));
  const crawl = (at, lists) => { env.begin(); for (const [src, ids] of Object.entries(lists)) env.ingest(src, ids.map((x) => ({ identity: x, sync: { block: 100, status: "synced" }, status: { online: true } }))); env.finish([], at); };
  if (opts.db) env.boot();                                    // as the agent does at start
  const rows = () => db.query("SELECT identity, first_seen, last_seen, public_listed_since, last_listed_by, counted_after FROM validator_discoveries ORDER BY identity").all();
  const row = (x) => db.query("SELECT identity, first_seen, last_seen, public_listed_since, last_listed_by, counted_after FROM validator_discoveries WHERE identity = ?").get(x.toLowerCase());
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
  check("L2 a second public peerlist makes it public, first counted when a public peerlist first listed it", l.public_listed_since === T0 && t.env.peers()[L.toLowerCase()].firstSeen === T0, JSON.stringify([l, t.env.peers()[L.toLowerCase()]]));
  check("L2b its first_seen stays what the older agent recorded (an older agent reads it again after a rollback)", l.first_seen === T0 - 90 * 86400000, JSON.stringify(l));
  check("L3 it is logged as a 1.0 row made public", t.logs.some((m) => /1 row recorded before 1\.1 now listed by 2 public peerlists: public from now/.test(m)));
  t.crawl(T0 + 2 * R, { s2: [L], s3: [L] });
  check("L4 later crawls publish the same first-counted time, read from the row", t.env.peers()[L.toLowerCase()].firstSeen === T0 && t.row(L).first_seen === T0 - 90 * 86400000 && t.row(L).public_listed_since === T0);
  // The older agent (def1a71) on the same store: its growth read and its writes.
  const olderRead = t.db.query("SELECT identity, first_seen FROM validator_discoveries").all();
  t.db.run("UPDATE validator_discoveries SET last_seen=?, online=? WHERE identity=?", [T0 + 3 * R, 1, L.toLowerCase()]);
  const N = id("seen-by-the-older-agent");
  t.db.run("INSERT OR IGNORE INTO validator_discoveries (identity, first_seen, last_seen, connection) VALUES (?, ?, ?, ?)", [N, T0 + 3 * R, T0 + 3 * R, "unknown"]);
  check("L5 after a rollback the older agent finds its own first_seen, so it shows no adopted row as new", olderRead.length === 1 && olderRead[0].first_seen === T0 - 90 * 86400000);
  check("L6 a row the older agent adds then is a 1.0 row again: hidden until two public peerlists list it", t.row(N).public_listed_since === null);
  t.crawl(T0 + 4 * R, { s2: [L, N], s3: [L, N] });
  check("L7 and on the next start of this version it is adopted like any 1.0 row: public time set, first_seen kept", t.row(N).public_listed_since === T0 + 4 * R && t.row(N).first_seen === T0 + 3 * R && t.row(L).public_listed_since === T0, JSON.stringify(t.row(N)));
}

console.log("\n[" + TAG + "] new identities: only what DNO knows it first listed inside the window is '+n'");
{
  const G = new Function(lineOf("const CATALOG_STARTING_SET_MS = ") + lineOf("const CATALOG_GAP_MS = ") + lineOf("const CATALOG_AFTER_UNKNOWN = ") + lineOf("const CATALOG_WINDOWS = ") + lineOf("const CATALOG_FIRST_COUNTED_NOTE = ")
    + extract("function catalogFirstCounted(") + extract("function catalogGrowthInput(") + "\nreturn { firstCounted: catalogFirstCounted, input: catalogGrowthInput };")();
  const H = 3600000, D = 86400000, iso = (ms) => new Date(ms).toISOString();
  // The shipped path: what the store holds, the kept start, the shipped rule.
  const growth = (t, now) => G.firstCounted(G.input(t.db, () => true), t.env.started(), now);
  const fig = (r) => [r.first_counted.today, r.first_counted.week, r.first_counted.month];
  const num = (r) => [r.numbers.today, r.numbers.week, r.numbers.month];
  const kept = (t) => { const r = t.db.query("SELECT value FROM dno_meta WHERE key = 'catalog_count_started'").get(); return r ? Number(r.value) : null; };
  const both = (list) => ({ s2: list, s3: list });

  let t = fresh();
  t.env.boot();
  const none = growth(t, T0);
  check("G1 nothing counted yet: no figure, no since, and the reason", fig(none).every((v) => v === null) && none.first_counted.since === null && none.first_counted.reason === "no identity has been counted on two public peerlists yet" && num(none).join() === "0,0,0" && kept(t) === null, JSON.stringify(none));

  // A store the older agent wrote: 46 rows the public peerlists list today, 6 they do not, 1 only one of them lists.
  const legacy = Array.from({ length: 46 }, (_, i) => id("adopted-" + i)), away = Array.from({ length: 6 }, (_, i) => id("not-listed-now-" + i)), single = id("on-one-peerlist");
  legacy.forEach((x, i) => t.legacy(x, T0 - (10 + i) * D));
  away.forEach((x, i) => t.legacy(x, T0 - (70 + i) * D));
  t.legacy(single, T0 - 30 * D);
  t.crawl(T0, both(legacy));
  check("G2 the first crawl adopts the 46 the peerlists list, and the count's start is kept, once", t.rows().filter((r) => r.public_listed_since === T0).length === 46 && t.env.started() === T0 && kept(t) === T0);
  const first = growth(t, T0 + 5 * 60000);
  check("G3 five minutes later: +0 is not claimed for any window, the 1.0 numbers are 0, and the reason is the starting set",
    fig(first).every((v) => v === null) && num(first).join() === "0,0,0" && first.first_counted.since === iso(T0 + H) && first.first_counted.reason === "the starting set is still being counted", JSON.stringify(first));

  // A new identity two hours in, on peerlists DNO read twenty seconds before without it: the one thing that is growth.
  const fresh1 = id("new-after-the-starting-set");
  t.crawl(T0 + 2 * H - R, both(legacy));
  t.crawl(T0 + 2 * H, both([...legacy, fresh1]));
  check("G4 a new identity is counted when two public peerlists list it, and carries the last read of those peerlists before it", t.row(fresh1).public_listed_since === T0 + 2 * H && t.row(fresh1).first_seen === T0 + 2 * H && t.row(fresh1).counted_after === T0 + 2 * H - R, JSON.stringify(t.row(fresh1)));
  const day0 = growth(t, T0 + 3 * H);
  check("G5 three hours in: still no window has a figure; the 1.0 numbers count the one new identity, not the 46 adopted",
    fig(day0).every((v) => v === null) && num(day0).join() === "1,1,1" && day0.first_counted.reason === "the count of new identities started less than 24 h ago", JSON.stringify(day0));
  const justBefore = growth(t, T0 + H + D - 1), at = growth(t, T0 + H + D);
  check("G6 today has a figure from the moment the last 24 h begin after the starting set, not before", fig(justBefore)[0] === null && fig(at).join() === "1,," && at.first_counted.reason === "the count of new identities started less than 7 days ago", JSON.stringify([fig(justBefore), fig(at), at.first_counted.reason]));

  // Day 3: the six rows the older agent stored 70 days ago are listed by two public peerlists for the first time.
  t.crawl(T0 + 3 * D - R, both(legacy));
  t.crawl(T0 + 3 * D, both([...legacy, ...away]));
  const day3 = growth(t, T0 + 3 * D + 60000);
  check("G7 rows an older record held are adopted whenever two peerlists list them, and are never '+n': +0 today on day 3, not +6",
    away.every((x) => t.row(x).public_listed_since === T0 + 3 * D && t.row(x).first_seen < T0 - 69 * D) && fig(day3).join() === "0,," && num(day3).join() === "0,1,1", JSON.stringify([fig(day3), num(day3)]));
  // Day 4: the row only one peerlist lists; a restart (the waiting set is in memory); then the second peerlist.
  t.crawl(T0 + 4 * D, { s2: [...legacy, single], s3: legacy });
  t = fresh({ db: t.db });
  t.crawl(T0 + 4 * D + H, { s2: legacy, s3: [...legacy, single] });
  check("G8 one listing, a restart, then a second listing: still waiting (the count of listings restarts), and the kept start is read back", t.row(single).public_listed_since === null && t.env.started() === T0);
  t.crawl(T0 + 4 * D + H + R, both([...legacy, single]));
  const day4 = growth(t, T0 + 4 * D + 2 * H);
  check("G9 when both list it, it is adopted and not counted in any window", t.row(single).public_listed_since === T0 + 4 * D + H && fig(day4).join() === "0,," && num(day4).join() === "0,1,1", JSON.stringify([t.row(single), fig(day4), num(day4)]));
  const wk = growth(t, T0 + 7 * D + H), mo = growth(t, T0 + 30 * D + H), day31 = growth(t, T0 + 31 * D);
  check("G10 after 7 days and 1 h the week has a figure; after 30 days and 1 h the month; an identity leaves a window when it is older than it",
    fig(wk).join() === "0,1," && fig(mo).join() === "0,0,1" && mo.first_counted.reason === null && fig(day31).join() === "0,0,0", JSON.stringify([fig(wk), fig(mo), fig(day31)]));

  // Day 10: a rollback. The older agent runs for five days: it updates last_seen every cycle and records four identities.
  const during = Array.from({ length: 4 }, (_, i) => id("first-seen-by-the-older-agent-" + i));
  during.forEach((x, i) => t.db.run("INSERT OR IGNORE INTO validator_discoveries (identity, first_seen, last_seen, connection) VALUES (?, ?, ?, ?)", [x, T0 + (10.5 + i) * D, T0 + 15 * D - R, "unknown"]));
  t.db.run("UPDATE validator_discoveries SET last_seen=?, online=? WHERE public_listed_since IS NOT NULL", [T0 + 15 * D - R, 1]);
  // Day 15: this version again.
  t = fresh({ db: t.db });
  const listed = [...legacy, ...away, single, fresh1, ...during];
  t.crawl(T0 + 15 * D, both(listed));
  const day15 = growth(t, T0 + 15 * D + 60000);
  check("G11 after a rollback, what the older agent recorded meanwhile is adopted and is in no window: +0 today, +0 this week, not +4",
    during.every((x, i) => t.row(x).public_listed_since === T0 + 15 * D && t.row(x).first_seen === T0 + (10.5 + i) * D && t.row(x).counted_after === null)
    && t.env.started() === T0 && fig(day15).join() === "0,0," && num(day15).join() === "0,0,1", JSON.stringify([fig(day15), num(day15), day15.first_counted.reason]));

  // A start cannot date what it finds. Day 20 to day 23 nothing runs; at the start on day 23 an identity DNO never
  // stored is on both peerlists: it may have been there, or waiting on one of them, since before the start.
  t.crawl(T0 + 20 * D, both(listed));
  t = fresh({ db: t.db });
  const atStart = id("on-both-peerlists-at-a-start");
  t.crawl(T0 + 23 * D, both([...listed, atStart]));
  const day23 = growth(t, T0 + 23 * D + 60000);
  check("G12 an identity first listed in the first read after a start is kept, with no earlier read to date it by", t.row(atStart).public_listed_since === T0 + 23 * D && t.row(atStart).counted_after === -1, JSON.stringify(t.row(atStart)));
  check("G13 it is in no window: +0 today and +0 this week, with figures", fig(day23).join() === "0,0," && num(day23).join() === "0,0,1", JSON.stringify([fig(day23), num(day23), day23.first_counted.reason]));
  // The second read after the start can date: an identity that appears now was not there twenty seconds ago.
  const afterStart = id("appears-after-the-first-read");
  t.crawl(T0 + 23 * D + R, both([...listed, atStart, afterStart]));
  const day23b = growth(t, T0 + 23 * D + 120000);
  check("G14 an identity that appears at the second read after a start is counted today: +1", t.row(afterStart).counted_after === T0 + 23 * D && fig(day23b).join() === "1,1,", JSON.stringify([t.row(afterStart), fig(day23b)]));

  // The reviewer's case: eight identities DNO never stored wait on one peerlist for eleven days; a one-minute restart;
  // six hours later the second peerlist lists them.
  const waiting = Array.from({ length: 8 }, (_, i) => id("waiting-on-one-peerlist-" + i)), listedNow = [...listed, atStart, afterStart];
  t.crawl(T0 + 24 * D, { s2: [...listedNow, ...waiting], s3: listedNow });
  check("G15 listed by one peerlist: waiting, not kept", waiting.every((x) => !t.row(x)) && t.env.pending().size === 8);
  t.crawl(T0 + 35 * D, { s2: [...listedNow, ...waiting], s3: listedNow });
  t = fresh({ db: t.db });                                                         // the restart: the waiting set is gone
  t.crawl(T0 + 35 * D + 60000, { s2: [...listedNow, ...waiting], s3: listedNow });
  t.crawl(T0 + 35 * D + 6 * H, both([...listedNow, ...waiting]));
  const day35 = growth(t, T0 + 35 * D + 7 * H);
  check("G16 after the restart they are first listed again in a first read, so when the second peerlist comes they are kept but not '+8': +0 today, +0 this week",
    waiting.every((x) => t.row(x).public_listed_since === T0 + 35 * D + 60000 && t.row(x).counted_after === -1) && fig(day35).join() === "0,0,1" && num(day35).join() === "0,0,1", JSON.stringify([t.row(waiting[0]), fig(day35), num(day35)]));
  // Without the restart the same history dates them eleven days back: in the month, not in today or the week.
  {
    const u = fresh(); u.env.boot();
    const base = Array.from({ length: 5 }, (_, i) => id("u-base-" + i)), w8 = Array.from({ length: 8 }, (_, i) => id("u-waiting-" + i));
    u.crawl(T0, both(base));
    u.crawl(T0 + 24 * D - R, both(base));
    u.crawl(T0 + 24 * D, { s2: [...base, ...w8], s3: base });
    u.crawl(T0 + 35 * D + 6 * H, both([...base, ...w8]));
    const g = growth(u, T0 + 35 * D + 7 * H);
    check("G17 without a restart they are dated from their first listing: +0 today, +0 this week, +8 this month", w8.every((x) => u.row(x).public_listed_since === T0 + 24 * D && u.row(x).counted_after === T0 + 24 * D - R) && fig(g).join() === "0,0,8", JSON.stringify([u.row(w8[0]), fig(g)]));
  }
  // A peerlist DNO could not read for three hours comes back listing an identity nobody else lists yet; a second
  // peerlist lists it a minute later. It appeared somewhere in those three hours.
  {
    const u = fresh(); u.env.boot();
    const base = Array.from({ length: 5 }, (_, i) => id("o-base-" + i)), z = id("o-after-an-outage");
    u.crawl(T0, both(base));
    u.crawl(T0 + 2 * D, both(base));
    for (let k = 1; k <= 3; k++) u.crawl(T0 + 2 * D + k * H, { s2: base });               // s3 is not read for three hours
    u.crawl(T0 + 2 * D + 3 * H + R, { s2: base, s3: [...base, z] });
    u.crawl(T0 + 2 * D + 3 * H + 2 * R, both([...base, z]));
    const row = u.row(z);
    check("G18 an identity first listed by a peerlist that was unread for three hours carries that peerlist's last read", row && row.public_listed_since === T0 + 2 * D + 3 * H + R && row.counted_after === T0 + 2 * D, JSON.stringify(row));
    const inside = growth(u, T0 + 2 * D + 4 * H), crossing = growth(u, T0 + 3 * D + 60 * 60000), past = growth(u, T0 + 3 * D + 4 * H);
    check("G19 while the whole outage is inside the last 24 h it counts: +1 today", fig(inside).join() === "1,,", JSON.stringify(fig(inside)));
    check("G20 when the outage crosses the start of the last 24 h, today has no figure and the 1.0 number does not claim it; the reason names both causes, each with its window",
      fig(crossing).join() === ",," && crossing.first_counted.reason === "a gap in the count crosses the start of the last 24 h; the count of new identities started less than 7 days ago" && num(crossing).join() === "0,1,1", JSON.stringify([fig(crossing), num(crossing), crossing.first_counted.reason]));
    // Ten days later the same outage crosses the start of the last 7 days, and the month is not covered yet.
    const week = growth(u, T0 + 9 * D + 60 * 60000), month = growth(u, T0 + 32 * D + 60 * 60000), covered = growth(u, T0 + 31 * D);
    check("G20b a window the count covers and no gap crosses has its figure next to one that has none: +0 today, no week (the gap), no month (too young)",
      fig(week).join() === "0,," && week.first_counted.reason === "a gap in the count crosses the start of the last 7 days; the count of new identities started less than 30 days ago", JSON.stringify([fig(week), week.first_counted.reason]));
    check("G20c with every window covered, only the window the gap crosses has no figure, and reason is null when every window has one",
      fig(month).join() === "0,0," && month.first_counted.reason === "a gap in the count crosses the start of the last 30 days" && fig(covered).join() === "0,0,1" && covered.first_counted.reason === null, JSON.stringify([fig(month), month.first_counted.reason, fig(covered), covered.first_counted.reason]));
    check("G21 once the last 24 h begin after it was listed: +0 today", fig(past).join() === "0,,", JSON.stringify(fig(past)));
  }
  // A peerlist over its budget at a start: the identities left for the next crawl are not dated by this one.
  {
    const u = fresh(); u.env.boot();
    const { PER_PEERLIST } = u.env.consts;
    const many = Array.from({ length: PER_PEERLIST + 10 }, (_, i) => id("flood-at-start-" + i));
    u.crawl(T0, both(many));
    u.crawl(T0 + R, both(many));
    check("G22 identities a first read left for the next crawl (over the budget) are still of unknown age", u.rows().length === PER_PEERLIST + 10 && u.rows().every((r) => r.counted_after === -1), JSON.stringify(u.rows().filter((r) => r.counted_after !== -1).slice(0, 2)));
  }

  // Every peerlist that lists an identity before it is kept must have been read before, or its age is unknown. Here x
  // waits on peerlist c from day 2. DNO restarts on day 39 while c does not answer. x appears on a, which DNO has
  // read since the restart; then c answers, and its first read since the restart lists x.
  {
    const u = fresh(); u.env.boot();
    const base = Array.from({ length: 5 }, (_, i) => id("m-base-" + i)), x = id("m-waiting-on-c");
    u.crawl(T0, { a: base, c: base });
    u.crawl(T0 + 2 * D, { a: base, c: [...base, x] });
    const v = fresh({ db: u.db });                                                 // the restart: c is down
    v.crawl(T0 + 39 * D, { a: base });
    v.crawl(T0 + 40 * D - R, { a: base });
    v.crawl(T0 + 40 * D, { a: [...base, x] });
    check("G28 listed by a peerlist DNO read before: waiting, dated by that read", v.env.pending().get(x) && v.env.pending().get(x).after === T0 + 40 * D - R, JSON.stringify(v.env.pending().get(x)));
    v.crawl(T0 + 40 * D + R, { a: [...base, x], c: [...base, x] });
    const g = growth(v, T0 + 40 * D + H);
    check("G28b the second peerlist lists it in its first read since the restart: kept, of unknown age, +0 today (it was on that peerlist since day 2)",
      v.row(x) && v.row(x).public_listed_since === T0 + 40 * D && v.row(x).counted_after === -1 && fig(g).join() === "0,0,0", JSON.stringify([v.row(x), fig(g)]));
    // The same two listings in one crawl.
    const w = fresh({ db: (() => { const z = fresh(); z.env.boot(); z.crawl(T0, { a: base, c: base }); return z.db; })() });
    w.crawl(T0 + 39 * D, { a: base });
    w.crawl(T0 + 40 * D, { a: [...base, x], c: [...base, x] });
    check("G29 one peerlist read before and one in its first read, in the same crawl: unknown age", w.row(x) && w.row(x).counted_after === -1, JSON.stringify(w.row(x)));
    // No restart: c is not read for 72 hours, then lists x in the crawl in which a lists it too.
    const y = fresh(); y.env.boot();
    y.crawl(T0, { a: base, c: base });
    y.crawl(T0 + 37 * D, { a: base, c: base });
    for (let k = 1; k <= 3; k++) y.crawl(T0 + 37 * D + k * D - R, { a: base });
    y.crawl(T0 + 40 * D, { a: [...base, x], c: [...base, x] });
    const gy = growth(y, T0 + 40 * D + H);
    check("G30 two peerlists list it at once, one of them unread for three days: it carries the earlier read, today has no figure, the week counts it",
      y.row(x) && y.row(x).counted_after === T0 + 37 * D && fig(gy).join() === ",1,1" && gy.first_counted.reason === "a gap in the count crosses the start of the last 24 h", JSON.stringify([y.row(x), fig(gy), gy.first_counted.reason]));
    // A later listing by an unread peerlist reaches back too: x waits on a (read 20 s before), and c, unread for three days, lists it next.
    const q = fresh(); q.env.boot();
    q.crawl(T0, { a: base, c: base });
    q.crawl(T0 + 37 * D, { a: base, c: base });
    q.crawl(T0 + 40 * D - R, { a: base });
    q.crawl(T0 + 40 * D, { a: [...base, x] });
    q.crawl(T0 + 40 * D + R, { a: [...base, x], c: [...base, x] });
    check("G30b a peerlist that lists it later, before it is kept, counts too: the earliest read is carried", q.row(x) && q.row(x).public_listed_since === T0 + 40 * D && q.row(x).counted_after === T0 + 37 * D, JSON.stringify(q.row(x)));
  }
  // A row this version did not insert is never counted, whatever its times say. The older agent recorded four rows
  // while the host clock ran a day ahead; the clock was corrected; this version adopts them.
  {
    const u = fresh(); u.env.boot();
    const base = Array.from({ length: 5 }, (_, i) => id("k-base-" + i)), ahead = Array.from({ length: 4 }, (_, i) => id("k-clock-ahead-" + i));
    u.crawl(T0, both(base));
    ahead.forEach((x) => u.legacy(x, T0 + 3 * D));                                 // first_seen a day after the adoption below
    u.crawl(T0 + 2 * D - R, both(base));
    u.crawl(T0 + 2 * D, both([...base, ...ahead]));
    const g = growth(u, T0 + 2 * D + H);
    check("G31 adopted rows whose first_seen is later than their adoption (a clock stepped back) are not counted: the mark decides, not the times",
      ahead.every((x) => u.row(x).public_listed_since === T0 + 2 * D && u.row(x).first_seen === T0 + 3 * D && u.row(x).counted_after === null) && fig(g).join() === "0,," && num(g).join() === "0,0,0", JSON.stringify([u.row(ahead[0]), fig(g), num(g)]));
  }
  // The record of when each peerlist was last read is bounded.
  {
    const u = fresh(); u.env.boot();
    const { SOURCES_MAX } = u.env.consts;
    const many = Array.from({ length: SOURCES_MAX + 36 }, (_, i) => "q" + i);
    u.crawl(T0, Object.fromEntries(many.map((src) => [src, []])));
    check("G32 the record of peerlist reads is bounded: the most recently read stay", u.env.readAt().size === SOURCES_MAX && !u.env.readAt().has("q0") && u.env.readAt().get("q" + (many.length - 1)) === T0, u.env.readAt().size);
    // The oldest entry in it is read again, with one new peerlist: the one read longest ago makes room, not the one just read.
    const oldest = "q" + (many.length - SOURCES_MAX), next = "q" + (many.length - SOURCES_MAX + 1);
    u.crawl(T0 + R, { [oldest]: [], "q-new": [] });
    check("G32b a peerlist read again moves to the newest place: the one read longest ago is dropped from the record", u.env.readAt().size === SOURCES_MAX && u.env.readAt().get(oldest) === T0 + R && !u.env.readAt().has(next) && u.env.readAt().has("q-new"),
      JSON.stringify([u.env.readAt().has(oldest), u.env.readAt().has(next), u.env.readAt().has("q-new")]));
  }
  // Waiting identities dropped at the cap are forgotten as a restart forgets them: one that is still listed must not
  // look newly listed in the next crawl. Sixty peerlists, fewer than the read record holds, so each keeps its read time.
  {
    const u = fresh(); u.env.boot();
    const { PENDING_MAX, PER_PEERLIST, SOURCES_MAX } = u.env.consts;
    const srcs = Array.from({ length: 60 }, (_, i) => "p" + i);
    const wave = (n) => Object.fromEntries(srcs.map((src, i) => [src, Array.from({ length: PER_PEERLIST }, (_, k) => id("drop-" + n + "-" + i + "-" + k))]));
    u.crawl(T0, Object.assign({ "p-idle": [] }, Object.fromEntries(srcs.map((src) => [src, []]))));   // every peerlist has been read once; p-idle is not read again
    const first = wave(1), dropped = first.p0[0];
    u.crawl(T0 + R, first);
    const before = [u.env.pending().size, u.env.readAt().size, u.env.readAt().get("p0"), u.env.readAt().get("p-idle"), u.env.pending().get(dropped) && u.env.pending().get(dropped).after];
    u.crawl(T0 + 2 * R, wave(2));                                                  // more than the waiting set holds
    check("G33 the waiting set overflows, the earliest are dropped, and after that no peerlist counts as read, also one that crawl did not read",
      srcs.length + 1 < SOURCES_MAX && before.join() === [srcs.length * PER_PEERLIST, srcs.length + 1, T0 + R, T0, T0].join() && 2 * srcs.length * PER_PEERLIST > PENDING_MAX
      && u.env.pending().size === PENDING_MAX && !u.env.pending().has(dropped) && u.env.readAt().size === 0 && u.logs.some((m) => /^ERR .*waiting identities dropped/.test(m)), JSON.stringify([before, u.env.pending().size, u.env.readAt().size]));
    u.crawl(T0 + 3 * R, { p0: [dropped], p50: [] });                               // still listed: it waits again
    check("G33b a dropped identity that is still listed waits again with unknown age", u.env.pending().get(dropped) && u.env.pending().get(dropped).after === -1, JSON.stringify(u.env.pending().get(dropped)));
    u.crawl(T0 + 4 * R, { p0: [dropped], p50: [dropped] });
    check("G33c and is kept with unknown age when a second peerlist lists it, not as newly listed", u.row(dropped) && u.row(dropped).counted_after === -1, JSON.stringify(u.row(dropped)));
    // Once a crawl drops nothing, reads are recorded again and the next new identity is dated.
    const later = id("after-the-flood");
    u.crawl(T0 + 5 * R, { p0: [dropped], p50: [dropped] });
    u.crawl(T0 + 6 * R, { p0: [dropped, later], p50: [dropped, later] });
    check("G33d after a crawl that drops nothing, a new identity is dated again", u.row(later) && u.row(later).counted_after === T0 + 5 * R, JSON.stringify([u.row(later), u.env.pending().size]));
  }

  // A row written while the host clock ran ahead is in no window until its time has come.
  {
    const u = fresh(); u.env.boot();
    const base = Array.from({ length: 5 }, (_, i) => id("f-base-" + i)), x = id("f-dated-ahead");
    u.crawl(T0, both(base));
    u.crawl(T0 + 5 * D - R, both(base));
    u.crawl(T0 + 5 * D, both([...base, x]));                                       // the clock is two days ahead here
    const nowTrue = growth(u, T0 + 3 * D), later = growth(u, T0 + 5 * D + H);
    check("G34 a row dated after the present is not '+1 today'; it is once its time has come", u.row(x).public_listed_since === T0 + 5 * D && fig(nowTrue).join() === "0,," && num(nowTrue).join() === "0,0,0" && fig(later).join() === "1,,", JSON.stringify([fig(nowTrue), num(nowTrue), fig(later)]));
  }

  // The start is kept: evicting the earliest rows, or a clock that steps back, does not move it.
  const month1 = growth(t, T0 + 40 * D);
  legacy.forEach((x) => t.db.run("DELETE FROM validator_discoveries WHERE identity = ?", [x]));
  t = fresh({ db: t.db });
  const month2 = growth(t, T0 + 40 * D);
  check("G23 when the rows of the starting set are gone (evicted at the row cap), the start does not move and the month keeps its figure",
    t.env.started() === T0 && month2.first_counted.since === iso(T0 + H) && fig(month2).join() === fig(month1).join() && fig(month2)[2] !== null && month2.first_counted.reason === null, JSON.stringify([fig(month1), fig(month2), month2.first_counted]));
  const back = fresh();
  back.env.boot();
  const set = Array.from({ length: 5 }, (_, i) => id("clock-" + i)), early = id("clock-stepped-back");
  back.crawl(T0, both(set));
  back.crawl(T0 + R, both(set));
  back.crawl(T0 - 2 * H, both([...set, early]));                                  // the clock stepped back two hours
  const again = fresh({ db: back.db });                                         // and the agent restarts: the start is read back, not worked out again
  const stepped = growth(again, T0 + 26 * H);
  check("G24 a clock that steps back does not turn the starting set into growth, also after a restart: the start stays, and nothing is +n",
    again.env.started() === T0 && kept(again) === T0 && again.row(early).public_listed_since === T0 - 2 * H && fig(stepped).join() === "0,," && num(stepped).join() === "0,0,0", JSON.stringify([again.env.started(), fig(stepped), num(stepped)]));

  check("G25 no window ever counts the starting set, an adopted row or a row of unknown age; where a figure is given the 1.0 number is the same; today is never above the week, nor the week above the month",
    [T0 + H + D, T0 + 3 * D, T0 + 8 * D, T0 + 16 * D, T0 + 23 * D + 60000, T0 + 31 * D, T0 + 36 * D, T0 + 100 * D].every((now) => { const r = growth(t, now); return fig(r).every((v, i) => v === null || (v <= 2 && v === num(r)[i])) && num(r)[0] <= num(r)[1] && num(r)[1] <= num(r)[2]; }));
  check("G26 the note says what is in no window", /starting set/.test(none.first_counted.note) && /older DNO record/.test(none.first_counted.note) && /a peerlist listed in its first read after DNO started, before DNO kept it/.test(none.first_counted.note) && /gap/.test(none.first_counted.note) && /1\.0 fields/.test(none.first_counted.note));
  // The public first-counted time is read from public_listed_since wherever a row is published.
  check("G27 /catalog, the exact lookup and validator_growth publish public_listed_since as first_seen, never the older record's value",
    /SELECT identity, public_listed_since AS first_seen, last_seen FROM validator_discoveries WHERE public_listed_since IS NOT NULL"\)\.all\(\)/.test(SRC)
    && /SELECT identity, public_listed_since AS first_seen, last_seen FROM validator_discoveries WHERE lower\(identity\) = \? AND public_listed_since IS NOT NULL/.test(SRC)
    && /SELECT identity, COALESCE\(public_listed_since, first_seen\) AS first_seen, last_seen, public_listed_since FROM validator_discoveries/.test(SRC)
    && !/SELECT identity, first_seen, last_seen FROM validator_discoveries/.test(SRC));
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
{
  // The waiting set is full; two identities two peerlists list cannot be stored and go back to wait: two others are dropped.
  const t = fresh({ failInsert: true });
  const { PENDING_MAX, PER_PEERLIST } = t.env.consts;
  const lists = {};
  for (let s = 0; s < PENDING_MAX / PER_PEERLIST; s++) lists["w" + s] = Array.from({ length: PER_PEERLIST }, (_, i) => id("full-" + s + "-" + i));
  t.crawl(T0, { s2: [], s3: [] });
  t.crawl(T0 + R, lists);
  const full = [t.env.pending().size, t.env.readAt().size > 0, t.logs.some((m) => /pending set is full/.test(m))];
  t.crawl(T0 + 2 * R, { s2: [id("back-a"), id("back-b")], s3: [id("back-a"), id("back-b")] });
  check("W4 identities that go back to wait into a full set drop the least recently listed: logged, and no peerlist counts as read after it",
    full.join() === [PENDING_MAX, true, false].join() && t.env.pending().size === PENDING_MAX && t.env.pending().has(id("back-a")) && !t.env.pending().has(lists.w0[0])
    && t.logs.some((m) => /^ERR .*2 waiting identities dropped: the pending set is full/.test(m)) && t.env.readAt().size === 0, JSON.stringify([full, t.env.pending().size, t.env.readAt().size, t.logs.slice(-3)]));
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
