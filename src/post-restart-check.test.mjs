// post-restart-check.test.mjs — POST_RESTART_CHECK guard: the named test after a restart (tools/post-restart-check.mjs).
// It must say NOT READING for what production showed on 2026-10-01 (200 on every route, 0 of 3 seeds read), and READING
// only when the agent has a reading by its own rule: two seeds gave their own height, or validators that answer as
// listed stand in for a missing seed (witnesses, API 1.2), with no fault in DNO's own read.
// The rows are in the agent's own shape: a seed that was not read has { ok: false, error } and no height_source key.
// Synthetic /health bodies and a loopback server only.
// Run: bun src/post-restart-check.test.mjs   (executable harness, not `bun test`)

import { healthVerdict, readingWords, run, freshSeconds, FRESH_SECONDS, ROLLBACK_MIN_WAIT_SECONDS, DEFAULT_WAIT_SECONDS } from "../tools/post-restart-check.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TAG = "POST_RESTART_CHECK";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
// As /health publishes a seed row (agent.mjs probePublicNodes, less trust_tier, the identity shortened).
// (The identity here is a full key, which /health never carries: the check must not print whatever that field holds.)
const row = (name) => ({ name, identity: "0x" + "ab".repeat(32), source_type: "public", operator: "KyneSys" });
const own = (name, h = 5000) => Object.assign(row(name), { ok: true, latencyMs: 41, block: h, height_source: "self", version: "0.9.9", peers: 46, identityMatch: true });
const fp = (name) => Object.assign(row(name), { ok: true, latencyMs: 41, block: 4960, height_source: "first_peer", version: "0.9.9", peers: 46, identityMatch: true });
const no = (name, error = "HTTP 503") => Object.assign(row(name), { ok: false, error });
const OC = { state: "agreed", active: 35, seeds_agreed: 2, seeds_configured: 3, reason: "2 of 3 public seeds returned the same validator list" };
// What 1.2 publishes beside the rows: what the reading rests on. Here it follows the seed rows, as the agent's does when
// no validator is read; a case with validators passes its own (wit).
const wit = (mode, nodes, validators = null) => { const ownH = nodes.filter((n) => n.ok && n.height_source === "self").length;
  return { mode, counted: mode === "seeds_only" ? ownH : mode === "seed_and_validators" ? 1 + validators.counted : mode === "validators_only" ? validators.counted : 0,
    public_seeds: { configured: nodes.length, answered: nodes.filter((n) => n.ok).length, own_height: ownH }, validators }; };
const health = (o = {}) => {
  const h = Object.assign({ observed_at: iso(NOW - 12000), status: "stable", data_quality: "sufficient", data_quality_reason: null,
    publicNodes: [own("kyne-node2"), own("kyne-node3"), no("kyne-node3b")], on_chain_validators: OC }, o);
  if (!("witnesses" in o)) h.witnesses = wit(h.data_quality === "sufficient" && h.publicNodes.filter((n) => n.ok && n.height_source === "self").length >= 2 ? "seeds_only" : "insufficient", h.publicNodes);
  return h;
};
// (used below) a document no agent of this version writes: every field good, and the status unknown, or no mode
const VAL = (counted, read = 3) => ({ read, own_height: Math.max(counted, 1), counted, list_agreed_at: "2026-10-02T11:00:12.000Z" });
const NOLIST1 = { state: "not_agreed", active: null, seeds_agreed: 0, seeds_configured: 3, reason: "fewer than two public seeds returned a validator list" };
// One seed answers and validators stand in; no seed answers and validators alone give the reading.
const oneSeed = [own("kyne-node2"), no("kyne-node3", "timeout"), no("kyne-node3b")], noSeed = [no("kyne-node2", "timeout"), no("kyne-node3", "timeout"), no("kyne-node3b")];
const FALLBACK = { publicNodes: oneSeed, witnesses: wit("seed_and_validators", oneSeed, VAL(2)), on_chain_validators: NOLIST1 };
const ALONE = { publicNodes: noSeed, witnesses: wit("validators_only", noSeed, VAL(3)), on_chain_validators: NOLIST1 };
const v = (h) => healthVerdict(h, NOW);

console.log("\n[" + TAG + "] what /health says");
{
  const good = v(health());
  check("H1 two seeds with their own height, sufficient, list agreed: reading, four lines", good.reading && good.listAgreed && !good.older && good.problems.length === 0 && good.mode === "seeds_only" && good.lines.join("\n") ===
    "  seeds: 2 of 3 answered; 2 gave their own height (kyne-node2 own height · kyne-node3 own height · kyne-node3b HTTP 503) · observed 12 s ago\n  reading: from the seeds alone (seeds_only)\n  data quality: sufficient · status: stable\n  validators list: agreed by 2 of 3 seeds · 35 ACTIVE", good.lines.join(" | "));
  // 1 Oct: every route answered 200, and this is what /health said.
  const oct1 = v(health({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers",
    publicNodes: [no("kyne-node2", "connection failed"), no("kyne-node3", "connection failed"), no("kyne-node3b", "connection failed")],
    on_chain_validators: { state: "not_agreed", active: null, seeds_agreed: 0, seeds_configured: 3, reason: "fewer than two public seeds returned a validator list" } }));
  check("H2 the 1 Oct picture (no row has a height_source key): not reading, the reason is the seeds, and it is this version, not an older one", !oct1.reading && !oct1.older && oct1.problems.join("; ") === "fewer than two seeds answered, and no validator stood in" && !oct1.listAgreed
    && oct1.lines[0].startsWith("  seeds: 0 of 3 answered; 0 gave their own height") && oct1.lines[1] === "  reading: none · no validator was read (insufficient)" && oct1.lines[2] === "  data quality: insufficient (too_few_answers) · status: unknown", JSON.stringify(oct1));
  const heights = v(health({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_heights", publicNodes: [own("kyne-node2"), fp("kyne-node3"), no("kyne-node3b")] }));
  check("H3 two answered, one own height: not reading", !heights.reading && heights.problems[0] === "fewer than two seeds gave their own height, and no validator stood in" && heights.lines[0].includes("kyne-node3 first peer's height"));
  const old = v(health({ observed_at: iso(NOW - (FRESH_SECONDS + 1) * 1000) }));
  check("H4 an observation older than " + FRESH_SECONDS + " s is not this start's: not reading", !old.reading && old.problems[0] === `the last public observation is ${FRESH_SECONDS + 1} s old`);
  const none = v(health({ observed_at: null, publicNodes: [], on_chain_validators: { state: "pending" } }));
  check("H5 no observation yet: not reading, and it says so", !none.reading && !none.older && none.problems[0] === "no public observation has completed" && none.lines[0].endsWith("no observation yet"));
  // The validators list is not in status: seeds read and a list that is not agreed is READING, with the list said apart.
  for (const [name, oc, line] of [["pending", { state: "pending", reason: "no read has completed yet" }, "validators list: pending (no read has completed yet)"],
    ["not agreed", { state: "not_agreed", reason: "the public seeds returned different validator lists" }, "validators list: not_agreed (the public seeds returned different validator lists)"],
    ["stale", { state: "stale", reason: "the last read is older than 300 s" }, "validators list: stale (the last read is older than 300 s)"]]) {
    const x = v(health({ on_chain_validators: oc }));
    check("H6 seeds read, list " + name + ": reading, and the list is not agreed", x.reading && !x.listAgreed && x.problems.length === 0 && x.listLine === line, JSON.stringify(x));
  }
  const dq = v(health({ data_quality: "insufficient", data_quality_reason: "stale", status: "unknown" }));
  check("H8 seeds fine but data quality not sufficient: not reading", !dq.reading && dq.problems.join() === "data quality is insufficient");
  const internal = v(health({ publicNodes: [no("kyne-node2", "internal error"), no("kyne-node3", "internal error"), no("kyne-node3b", "internal error")], data_quality: "insufficient", status: "unknown" }));
  check("H9 a fault in DNO's own read shows as such on the seeds line, and is the first reason", !internal.reading && internal.lines[0].includes("kyne-node2 internal error") && internal.problems[0] === "3 seed reads ended in an internal error, a fault in DNO's own read");
  // 1.2: validators that answer as listed stand in for a seed that gave no height.
  const fb = v(health(FALLBACK)), al = v(health(ALONE));
  check("H16 one seed and two validators within 25 blocks of it: reading, and the lines say what it rests on", fb.reading && fb.mode === "seed_and_validators" && fb.counted === 2 && !fb.listAgreed && fb.listExpected === false
    && fb.lines[1] === "  reading: one seed and 2 validators within 25 blocks of it · their list was agreed at 2026-10-02 11:00 UTC (seed_and_validators)", JSON.stringify(fb));
  check("H17 no seed, three validators: reading, and it says so", al.reading && al.mode === "validators_only" && al.lines[1] === "  reading: 3 validators that answer as listed, no seed · their list was agreed at 2026-10-02 11:00 UTC (validators_only)"
    && readingWords(al) === "no seed gave its own height, and the status comes from 3 validators that answer as listed" && readingWords(fb) === "one seed gave its own height, 2 validators that answer as listed are within 25 blocks of it, and the status comes from them"
    && readingWords(v(health(Object.assign({}, FALLBACK, { witnesses: wit("seed_and_validators", oneSeed, VAL(1)) })))) === "one seed gave its own height, 1 validator that answers as listed is within 25 blocks of it, and the status comes from them"
    && readingWords(good) === "two seeds gave their own height and the status comes from them", JSON.stringify(al));
  const wrong = [v(health({ publicNodes: oneSeed, witnesses: wit("seeds_only", oneSeed) })), v(health({ witnesses: wit("seed_and_validators", [own("a"), own("b")], VAL(2)) })), v(health(Object.assign({}, ALONE, { witnesses: wit("validators_only", noSeed, VAL(1)) })))];
  check("H18 a mode the seed rows do not bear out is not a reading: seeds_only with one own height, seed_and_validators with two, validators_only with one validator", wrong.every((x) => !x.reading)
    && wrong[0].problems[0] === "the reading is said to be seeds_only, and the seed rows show 1 own height and 0 validators counted", JSON.stringify(wrong.map((x) => x.problems)));
  const wrong2 = [v(health({ publicNodes: oneSeed, witnesses: wit("seed_and_validators", oneSeed, VAL(0)), on_chain_validators: NOLIST1 })), v(health({ publicNodes: oneSeed, witnesses: wit("validators_only", oneSeed, VAL(3)), on_chain_validators: NOLIST1 })),
    v(health({ witnesses: Object.assign(wit("seeds_only", [own("a"), own("b")]), { mode: "made_up" }) })), v(health(Object.assign({}, ALONE, { witnesses: wit("seed_and_validators", noSeed, VAL(2)) })))];
  check("H18b nor is: a seed and validators with no validator counted; validators alone beside a seed height; a seed and validators with no seed height; a mode this check does not know", wrong2.every((x) => !x.reading)
    && wrong2[0].problems[0] === "the reading is said to be seed_and_validators, and the seed rows show 1 own height and 0 validators counted" && wrong2[1].problems[0] === "the reading is said to be validators_only, and the seed rows show 1 own height and 3 validators counted"
    && wrong2[2].problems[0].startsWith("the reading is said to be made_up") && wrong2[2].lines[1] === "  reading: not a known mode (made_up)", JSON.stringify(wrong2.map((x) => x.problems)));
  const faulty = v(health(Object.assign({}, FALLBACK, { publicNodes: [own("kyne-node2"), no("kyne-node3", "internal error"), no("kyne-node3b")] })));
  check("H19 a reading that stands on validators beside a seed read that ended in an internal error is not READING: the fault is DNO's own", !faulty.reading && faulty.problems.join() === "1 seed read ended in an internal error, a fault in DNO's own read");
  const tried = v(health({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers", publicNodes: oneSeed, witnesses: wit("insufficient", oneSeed, { read: 3, own_height: 1, counted: 0, list_agreed_at: "2026-10-02T11:00:12.000Z" }), on_chain_validators: NOLIST1 }));
  check("H20 validators were read and gave no reading: not reading, and the line says how many answered", !tried.reading && tried.lines[1] === "  reading: none · 3 validators read, 1 answered as listed with a height (insufficient)" && tried.problems.join() === "fewer than two seeds answered, and no validator stood in");
  const v711 = v({ observed_at: iso(NOW - 12000), status: "stable", data_quality: "sufficient", api_version: "1.1", publicNodes: [own("kyne-node2"), own("kyne-node3"), no("kyne-node3b")], on_chain_validators: OC });
  check("H21 the version before this one (API 1.1: rows with height_source, a validators list, no witnesses) is an older version here: not judged", v711.older && !v711.reading);
  // The agent before 1.1: rows without height_source, no validators list. Nothing can be concluded about it.
  const before = v({ observed_at: iso(NOW - 12000), status: "stable", data_quality: "sufficient", publicNodes: [{ name: "kyne-node2", ok: true, block: 5000 }, { name: "kyne-node3", ok: true, block: 5000 }, { name: "kyne-node3b", ok: false, error: "x" }] });
  check("H7 an older agent's /health is recognised as that, not judged", before.older && !before.reading);
  check("H10 a body that is not a /health answer does not throw, and is not reading", !v(null).reading && !v({}).reading && !v({ publicNodes: "x", on_chain_validators: 5 }).reading);
  const future = v(health({ observed_at: iso(NOW + 3600000) })), slack = v(health({ observed_at: iso(NOW + 4000) }));
  check("H12 an observation dated an hour after this machine's clock is not fresh; a few seconds of clock difference are", !future.reading && future.problems.join() === "the observation is dated after this machine's clock"
    && future.lines[0].endsWith("observation dated after this machine's clock") && slack.reading, JSON.stringify([future.problems, slack.problems]));
  check("H13 the verdict carries the observation's time, or null", good.observedAt === NOW - 12000 && none.observedAt === null && v({}).observedAt === null);
  check("H14 the constants the runbook relies on: fresh within 120 s, 'Roll back' only after 90 s, 180 s by default", FRESH_SECONDS === 120 && ROLLBACK_MIN_WAIT_SECONDS === 90 && DEFAULT_WAIT_SECONDS === 180);
  // An agent configured for a round a minute (1,440 a day) or every five minutes (288): an observation as old as two rounds is current.
  const aged = (s, cycles) => v(health(Object.assign({ observed_at: iso(NOW - s * 1000) }, cycles === undefined ? {} : { last_24h: { expected_cycles: cycles } })));
  check("H15 freshness follows the agent's own cadence: 120 s at a round every 20 s or when /health gives none, two rounds and 30 s when rounds are further apart",
    freshSeconds({ last_24h: { expected_cycles: 4320 } }) === 120 && freshSeconds({}) === 120 && freshSeconds(null) === 120 && freshSeconds({ last_24h: { expected_cycles: 0 } }) === 120 && freshSeconds({ last_24h: { expected_cycles: 1440 } }) === 150 && freshSeconds({ last_24h: { expected_cycles: 288 } }) === 630
    && !aged(140, 4320).reading && !aged(140).reading && aged(140, 1440).reading && !aged(151, 1440).reading && aged(600, 288).reading
    && aged(120).reading && !aged(121).reading && aged(150, 1440).reading && !aged(140, "1440").reading && freshSeconds({ last_24h: { expected_cycles: "1440" } }) === 120 && freshSeconds({ last_24h: { expected_cycles: -5 } }) === 120,
    JSON.stringify([freshSeconds({ last_24h: { expected_cycles: 1440 } }), aged(140, 4320).problems, aged(140, 1440).problems]));
  check("H11 no line carries a key or an address", [good, oct1, heights, internal, fb, al, tried].every((x) => !/0x[0-9a-f]{8}|\d+\.\d+\.\d+\.\d+/i.test(x.lines.join("\n"))));
}

console.log("\n[" + TAG + "] the wait and the verdict");
{
  // A fake clock: sleep advances it. fetch answers from a script of bodies (an Error is thrown).
  const sim = (script, args = ["--wait", String(ROLLBACK_MIN_WAIT_SECONDS)]) => {
    let t = NOW, i = 0; const out = [];
    const fetchFn = async () => { const x = script[Math.min(i++, script.length - 1)]; if (x instanceof Error) throw x; if (typeof x === "number") return { ok: false, status: x, json: async () => ({}) }; if (x === EMPTY) return { ok: true, status: 200, json: async () => null }; return { ok: true, status: 200, json: async () => x(t) }; };
    return run(args, { fetch: fetchFn, sleep: async (ms) => { t += ms; }, now: () => t, log: (l) => out.push(l) }).then((code) => ({ code, out, polls: i }));
  };
  const EMPTY = Symbol("a 200 with an empty body");
  const at = (o) => (t) => Object.assign(health(o), { observed_at: iso(t - 8000) });
  const PENDING = { state: "pending", reason: "no read has completed yet" };
  const starting = (t) => Object.assign(health({ publicNodes: [], status: "unknown", data_quality: "insufficient", data_quality_reason: "no_observation", on_chain_validators: PENDING }), { observed_at: null });
  const refused = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
  const ok = await sim([refused, 502, starting, at({ on_chain_validators: PENDING }), at({})]);
  check("R1 still starting, then seeds read, then the list agreed: it waits for all of it, exit 0, and says how long", ok.code === 0 && ok.polls === 5 && ok.out[0] === "post-restart check · waited 20 s"
    && ok.out[ok.out.length - 1] === "AGENT IS READING: two seeds gave their own height and the status comes from them. The validator list is agreed.", JSON.stringify(ok));
  const W = ROLLBACK_MIN_WAIT_SECONDS, POLLS = W / 5 + 1;   // one poll every 5 s, and one at the start
  const NOLIST = { state: "not_agreed", reason: "the public seeds returned different validator lists" };
  const OCT1 = at({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers", publicNodes: [no("kyne-node2", "connection failed"), no("kyne-node3", "connection failed"), no("kyne-node3b", "connection failed")],
    on_chain_validators: { state: "not_agreed", reason: "fewer than two public seeds returned a validator list" } });
  const bad = await sim([OCT1]);
  check("R2 the 1 Oct picture for the whole wait: exit 3, the seeds as the reason, and 'Roll back.'", bad.code === 3 && bad.polls === POLLS
    && bad.out[bad.out.length - 1] === `AGENT IS NOT READING after ${W} s: fewer than two seeds answered, and no validator stood in. Roll back.`, JSON.stringify(bad.out));
  const short = await sim([OCT1], ["--wait", "30"]);
  check("R2b the same after a wait too short for a start: exit 3, 'NOT READING YET', and no 'Roll back'", short.code === 3 && short.polls === 7
    && short.out[short.out.length - 1] === "AGENT IS NOT READING YET after 30 s: fewer than two seeds answered, and no validator stood in. A start needs about a minute: run this again with the default wait before deciding anything." && !/Roll back/.test(short.out.join("\n")), JSON.stringify(short.out));
  const down = await sim([refused]);
  check("R3 /health never answers for a wait long enough for a start: exit 4, and 'roll back'", down.code === 4 && down.out.length === 2 && down.out[1] === `AGENT IS NOT ANSWERING after ${W} s: /health could not be read (connection failed). A start takes under a minute: roll back.`, JSON.stringify(down.out));
  const downShort = await sim([refused], ["--wait", "30"]);
  check("R3b the same after a wait too short for a start: exit 4, and no 'roll back'", downShort.code === 4 && downShort.out[1] === "AGENT IS NOT ANSWERING after 30 s: /health could not be read (connection failed). A start needs about a minute: run this again with the default wait before deciding anything.", JSON.stringify(downShort.out));
  const gate = await sim([502]);
  check("R4 a 502 for the whole wait: exit 4 with the status", gate.code === 4 && gate.out[1].includes("(HTTP 502)"));
  const slowHealth = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  const hung = await sim([slowHealth]);
  check("R4b /health times out for the whole wait: exit 4, and it says timeout", hung.code === 4 && hung.out[1].startsWith(`AGENT IS NOT ANSWERING after ${W} s: /health could not be read (timeout).`), JSON.stringify(hung.out));
  // An agent that does not stay up. After a poll that answered, a refused connection is the process gone.
  const STAY = (why) => `THE AGENT DID NOT STAY UP DURING THIS CHECK (after ${W} s): ${why}. An agent that stops or starts again by itself is failing: roll back. (If you restarted the service yourself while this ran, run it again instead.)`;
  const stopped = await sim([at({ on_chain_validators: PENDING }), refused]);
  check("R5 seeds read once, then the port refuses: exit 3, never READING, 'roll back'", stopped.code === 3 && !/AGENT IS READING/.test(stopped.out.join("\n")) && stopped.out[stopped.out.length - 1] === STAY("its port stopped answering after it had answered"), JSON.stringify(stopped.out));
  const neverThenDown = await sim([OCT1, refused]);
  check("R5b no seed read, then the port refuses: exit 3, 'roll back'", neverThenDown.code === 3 && neverThenDown.out[neverThenDown.out.length - 1] === STAY("its port stopped answering after it had answered"), JSON.stringify(neverThenDown.out));
  // A crash loop: each life starts, reads once, and ends. The polls see a reading agent, then one with no observation.
  const loop = await sim([at({ on_chain_validators: PENDING }), starting, at({ on_chain_validators: PENDING }), at({})]);
  check("R5c an observation, then none, then reading with the list agreed (the agent started again): exit 3, 'roll back', never exit 0", loop.code === 3 && loop.polls === POLLS && loop.out[loop.out.length - 1] === STAY("its observation went back to none"), JSON.stringify(loop.out));
  const earlier = await sim([at({ on_chain_validators: PENDING }), (t) => Object.assign(health({ on_chain_validators: PENDING }), { observed_at: iso(t - 60000) }), at({})]);
  check("R5d an observation earlier than one seen before is another process too", earlier.code === 3 && earlier.out[earlier.out.length - 1] === STAY("its observation went back to an earlier one"), JSON.stringify(earlier.out));
  const blip = await sim([at({ on_chain_validators: PENDING }), refused, at({})]);
  check("R5e the port refuses once between two answers, and the agent reads at the end: still exit 3", blip.code === 3 && blip.polls === POLLS && /DID NOT STAY UP/.test(blip.out[blip.out.length - 1]));
  const err500 = await sim([at({ on_chain_validators: PENDING }), 500, at({})]);
  check("R5f an HTTP error or a timeout of /health between two answers is not a restart: exit 0 at the next good poll", err500.code === 0 && err500.polls === 3 && (await sim([at({ on_chain_validators: PENDING }), slowHealth, at({})])).code === 0, JSON.stringify(err500.out));
  const emptyOnce = await sim([at({ on_chain_validators: PENDING }), EMPTY, at({})]), emptyToEnd = await sim([at({ on_chain_validators: PENDING }), EMPTY]), emptyOnly = await sim([EMPTY]);
  check("R5h a 200 with an empty body is a failed read (not JSON), not an agent whose observation is gone: no restart is concluded from it",
    emptyOnce.code === 0 && emptyOnce.polls === 3 && emptyToEnd.code === 7 && /DID NOT ANSWER AT THE END \(after \d+ s: not JSON\)/.test(emptyToEnd.out[emptyToEnd.out.length - 1])
    && emptyOnly.code === 4 && emptyOnly.out[1].includes("(not JSON)"), JSON.stringify([emptyOnce.code, emptyToEnd.out.slice(-1), emptyOnly.out]));
  const timedOutAtEnd = await sim([at({ on_chain_validators: PENDING }), slowHealth]);
  check("R5g reading, then /health times out to the end of the wait: exit 7, 'run this again', no 'roll back'", timedOutAtEnd.code === 7 && timedOutAtEnd.out[timedOutAtEnd.out.length - 1] === `AGENT WAS READING DURING THIS CHECK AND ITS /health DID NOT ANSWER AT THE END (after ${W} s: timeout); the lines above are the read before it. Not a rollback yet: run this again.`, JSON.stringify(timedOutAtEnd.out));
  const listOnly = await sim([at({ on_chain_validators: NOLIST })]);
  check("R8 seeds read for the whole wait and the list never agreed: exit 5, READING, and no 'Roll back'", listOnly.code === 5 && listOnly.polls === POLLS
    && listOnly.out[listOnly.out.length - 2] === "AGENT IS READING: two seeds gave their own height and the status comes from them."
    && listOnly.out[listOnly.out.length - 1].startsWith(`THE VALIDATOR LIST IS NOT AGREED after ${W} s. It is no reason to roll back`) && !/Roll back\./.test(listOnly.out.join("\n")), JSON.stringify(listOnly.out));
  // 1.2: a reading that rests on validators. One seed cannot agree a list, so the check does not wait for one.
  const stoodIn = await sim([starting, at(FALLBACK)]);
  check("R13 one seed and validators within 25 blocks of it: exit 0 at that poll, and it says what the status comes from", stoodIn.code === 0 && stoodIn.polls === 2
    && stoodIn.out[stoodIn.out.length - 1] === "AGENT IS READING: one seed gave its own height, 2 validators that answer as listed are within 25 blocks of it, and the status comes from them. No validator list is agreed while fewer than two seeds are asked for it; the agent keeps a witness candidate for 24 h after its last answer.", JSON.stringify(stoodIn.out));
  // A seed that answered with another key than the configured one is not asked for the list: one seed is left to ask.
  const aliased = Object.assign(own("kyne-node3"), { identityMatch: false, height_source: null, block: null });
  const twoAnswerOneAsked = await sim([at({ publicNodes: [own("kyne-node2"), aliased, no("kyne-node3b")], witnesses: wit("seed_and_validators", [own("kyne-node2"), aliased, no("kyne-node3b")], VAL(2)), on_chain_validators: NOLIST1 })]);
  check("R13b two seeds answer and one of them with another key: no list can be agreed, so the check does not wait for one: exit 0 at the first poll (it waited three minutes and said 'not agreed')", twoAnswerOneAsked.code === 0 && twoAnswerOneAsked.polls === 1
    && /^AGENT IS READING: one seed gave its own height, 2 validators/.test(twoAnswerOneAsked.out[twoAnswerOneAsked.out.length - 1]) && v(health({ publicNodes: [own("kyne-node2"), aliased, no("kyne-node3b")] })).listExpected === false
    && v(health()).listExpected === true && v(health({ publicNodes: oneSeed })).listExpected === false, JSON.stringify(twoAnswerOneAsked.out.slice(-2)));
  const validatorsAlone = await sim([at(ALONE)]);
  check("R14 no seed and validators alone: a reading, said apart and not a pass (exit 8): seeds that are down and a fault in DNO's own seed read look the same from here", validatorsAlone.code === 8 && validatorsAlone.polls === 1
    && validatorsAlone.out[validatorsAlone.out.length - 1] === "AGENT IS READING WITHOUT A SEED: no seed gave its own height, and the status comes from 3 validators that answer as listed. This check cannot tell seeds that are down from a fault in DNO's own seed read (the failure of 1 Oct was one). If the seeds answer another client from this host, DNO's read is at fault: roll back. If they do not, this is the outage the validators stand in for."
    && !validatorsAlone.out.some((l) => /^AGENT IS READING:/.test(l)), JSON.stringify(validatorsAlone.out));
  const previous = await sim([() => ({ observed_at: iso(NOW), status: "stable", data_quality: "sufficient", api_version: "1.1", publicNodes: [own("kyne-node2"), own("kyne-node3")], on_chain_validators: OC })]);
  check("R15 the version before this one on the port (the restart did not take effect): exit 6 at once, and it says so", previous.code === 6 && previous.polls === 1
    && previous.out[previous.out.length - 1] === "AN OLDER VERSION IS ANSWERING: its /health has no witnesses object (API 1.2). This check is for the new version; nothing is concluded. If the service was restarted on the new code, the restart did not take effect.", JSON.stringify(previous.out));
  const faultRun = await sim([at(Object.assign({}, FALLBACK, { publicNodes: [own("kyne-node2"), no("kyne-node3", "internal error"), no("kyne-node3b")] }))]);
  check("R16 a fault in DNO's own read for the whole wait is 'Roll back', though validators give a reading", faultRun.code === 3 && faultRun.out[faultRun.out.length - 1] === `AGENT IS NOT READING after ${W} s: 1 seed read ended in an internal error, a fault in DNO's own read. Roll back.`, JSON.stringify(faultRun.out));
  // The verdict is not the last poll alone. The list is never agreed, so the check runs to the end of the wait; in the
  // last round one of the two answering seeds times out.
  const oneOut = at({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers", publicNodes: [own("kyne-node2"), no("kyne-node3", "timeout"), no("kyne-node3b")], on_chain_validators: NOLIST });
  const flake = await sim([...Array(POLLS - 1).fill(at({ on_chain_validators: NOLIST })), oneOut]);
  check("R10 reading for the whole wait, then one seed times out in the last round: exit 7, not 'Roll back'", flake.code === 7 && flake.polls === POLLS && !/[Rr]oll back\.|AGENT IS READING|NOT READING/.test(flake.out.join("\n"))
    && flake.out[flake.out.length - 1] === `AGENT WAS READING DURING THIS CHECK AND IS NOT NOW (after ${W} s): fewer than two seeds answered, and no validator stood in. A seed that stops answering looks like this; the failure of 1 Oct never read. Not a rollback yet: run this again in a minute.`, JSON.stringify(flake.out));
  const flakeMid = await sim([at({ on_chain_validators: NOLIST }), oneOut, at({ on_chain_validators: NOLIST })]);
  check("R10b a round without enough seeds in the middle of the wait changes nothing: exit 5", flakeMid.code === 5 && flakeMid.polls === POLLS);
  const recovered = await sim([OCT1, OCT1, at({})]);
  check("R10c no seed read at first, then reading with the list agreed: exit 0 at that poll", recovered.code === 0 && recovered.polls === 3);
  const olderAgent = await sim([() => ({ observed_at: iso(NOW), status: "stable", data_quality: "sufficient", publicNodes: [{ name: "kyne-node2", ok: true, block: 5 }, { name: "kyne-node3", ok: true, block: 5 }] })]);
  check("R9 an older agent on the port: exit 6 at once, nothing concluded, no 'Roll back'", olderAgent.code === 6 && olderAgent.polls === 1 && /AN OLDER VERSION IS ANSWERING/.test(olderAgent.out[olderAgent.out.length - 1]) && !/Roll back/.test(olderAgent.out.join("\n")), JSON.stringify(olderAgent.out));
  // As a real agent answers: the observation is the same for several polls (a round every 20 s, a poll every 5 s), then a newer one.
  const steady = (obs) => (t) => Object.assign(health({ on_chain_validators: PENDING }), { observed_at: iso(obs) });
  const same = await sim([steady(NOW - 3000), steady(NOW - 3000), steady(NOW - 3000), steady(NOW - 3000), steady(NOW + 17000), steady(NOW + 17000), (t) => Object.assign(health(), { observed_at: iso(NOW + 17000) })]);
  check("R12 the same observation over several polls, then a newer one, then the list agreed: exit 0, and nothing 'went back'", same.code === 0 && same.polls === 7 && !/DID NOT STAY UP/.test(same.out.join("\n")), JSON.stringify(same.out));
  const rises = await sim([steady(NOW - 3000), steady(NOW + 17000), steady(NOW + 37000), steady(NOW + 17000), (t) => Object.assign(health(), { observed_at: iso(NOW + 57000) })]);
  check("R12b the newest observation seen is what later ones are compared with: one older than it, though newer than the first, is another process", rises.code === 3 && /DID NOT STAY UP .*its observation went back to an earlier one/.test(rises.out[rises.out.length - 1]), JSON.stringify(rises.out));
  // The wait the runbook uses: no --wait at all.
  const byDefault = await sim([OCT1], []);
  check("R11 with no --wait the check waits " + DEFAULT_WAIT_SECONDS + " s, and the 1 Oct picture ends in 'Roll back.'", byDefault.code === 3 && byDefault.polls === DEFAULT_WAIT_SECONDS / 5 + 1
    && byDefault.out[0] === `post-restart check · waited ${DEFAULT_WAIT_SECONDS} s` && byDefault.out[byDefault.out.length - 1] === `AGENT IS NOT READING after ${DEFAULT_WAIT_SECONDS} s: fewer than two seeds answered, and no validator stood in. Roll back.`, JSON.stringify(byDefault.out));
  const now0 = await sim([at({})], ["--wait", "0"]);
  check("R6 --wait 0 reads once", now0.code === 0 && now0.polls === 1);
  const usage = await run(["not-a-url"], { log: () => {} });
  check("R7 a base that is not a URL: usage, exit 64", usage === 64);
}

console.log("\n[" + TAG + "] against a server");
{
  let body = health({ observed_at: iso(Date.now() - 5000) });
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json(body) : new Response("nf", { status: 404 })) });
  const out = [];
  const code = await run(["http://127.0.0.1:" + srv.port + "/", "--wait", "0"], { log: (l) => out.push(l) });
  check("S1 a real read of /health: READING, exit 0, and the output names no address", code === 0 && /AGENT IS READING/.test(out[out.length - 1]) && !/127\.0\.0\.1|localhost/.test(out.join("\n")), JSON.stringify(out));
  body = health({ observed_at: iso(Date.now() - 5000), status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers", publicNodes: [no("kyne-node2", "internal error"), no("kyne-node3", "internal error"), no("kyne-node3b")] });
  const out2 = [];
  const code2 = await run(["http://127.0.0.1:" + srv.port, "--wait", "0"], { log: (l) => out2.push(l) });
  check("S2 the same server reading no seed, read once: NOT READING YET, exit 3, the fault first", code2 === 3 && /^AGENT IS NOT READING YET after 0 s: 2 seed reads ended in an internal error, a fault in DNO's own read; fewer than two seeds answered, and no validator stood in\. /.test(out2[out2.length - 1]) && !/Roll back/.test(out2.join("\n")), JSON.stringify(out2));
  // The command itself, as the runbook runs it: the exit code is the verdict's.
  const cli = async (b) => { body = b; const kid = Bun.spawn([process.execPath, join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "post-restart-check.mjs"), "http://127.0.0.1:" + srv.port, "--wait", "0"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(kid.stdout).text(); return { code: await kid.exited, last: text.trim().split("\n").pop() }; };
  const cliOk = await cli(health({ observed_at: iso(Date.now() - 5000) }));
  check("S3 run as a command: READING, exit 0", cliOk.code === 0 && cliOk.last === "AGENT IS READING: two seeds gave their own height and the status comes from them. The validator list is agreed.", JSON.stringify(cliOk));
  const cliOld = await cli({ observed_at: iso(Date.now() - 5000), status: "stable", data_quality: "sufficient", publicNodes: [{ name: "kyne-node2", ok: true, block: 5 }, { name: "kyne-node3", ok: true, block: 5 }] });
  check("S4 run as a command against an older agent: exit 6", cliOld.code === 6 && /^AN OLDER VERSION IS ANSWERING/.test(cliOld.last), JSON.stringify(cliOld));
  srv.stop(true);
}

console.log("\n[" + TAG + "] a document that contradicts itself is not a reading");
{
  const good = healthVerdict(health(), NOW);
  const unknownBesideMode = healthVerdict(health({ status: "unknown" }), NOW);
  const noStatus = healthVerdict((() => { const h = health(); delete h.status; return h; })(), NOW);
  const noMode = healthVerdict(health({ witnesses: wit("insufficient", [own("a"), own("b"), no("c")]) }), NOW);
  check("K1 every field good and the status unknown, or no status at all: not READING, and the reason is said", good.reading === true && unknownBesideMode.reading === false && unknownBesideMode.problems.join() === "the status is unknown beside a reading"
    && noStatus.reading === false && noStatus.problems.join() === "the status is not reported beside a reading", JSON.stringify([unknownBesideMode.problems, noStatus.problems]));
  check("K2 data quality sufficient and two seed heights beside the mode insufficient: not READING", noMode.reading === false && noMode.problems.join() === "data quality is sufficient, and the agent says the reading rests on nothing (insufficient)", JSON.stringify(noMode.problems));
  const asked = [], out = [];
  const code = await run(["--wait", "0"], { fetch: async (u, init) => { asked.push(u); return Response.json(health({ observed_at: iso(Date.now() - 5000) })); }, sleep: async () => {}, log: (l) => out.push(l) });
  check("K3 without an address the check asks the agent's own port on this host, 127.0.0.1:55225", code === 0 && asked.length === 1 && asked[0] === "http://127.0.0.1:55225/health", JSON.stringify([code, asked, out.slice(-1)]));
  const asked2 = [];
  await run(["http://127.0.0.1:18855/", "--wait", "0"], { fetch: async (u) => { asked2.push(u); return Response.json(health({ observed_at: iso(Date.now() - 5000) })); }, sleep: async () => {}, log: () => {} });
  check("K4 an address given is the one asked, without its trailing slash", asked2[0] === "http://127.0.0.1:18855/health", asked2.join());
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
