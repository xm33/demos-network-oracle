// post-restart-check.test.mjs — POST_RESTART_CHECK guard: the named test after a restart (tools/post-restart-check.mjs).
// It must say NOT READING for what production showed on 2026-10-01 (200 on every route, 0 of 3 seeds read), and READING
// only when two seeds gave their own height, the status comes from them, and the validator list is agreed.
// The rows are in the agent's own shape: a seed that was not read has { ok: false, error } and no height_source key.
// Synthetic /health bodies and a loopback server only.
// Run: bun src/post-restart-check.test.mjs   (executable harness, not `bun test`)

import { healthVerdict, run, freshSeconds, FRESH_SECONDS, ROLLBACK_MIN_WAIT_SECONDS, DEFAULT_WAIT_SECONDS } from "../tools/post-restart-check.mjs";
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
const health = (o = {}) => Object.assign({ observed_at: iso(NOW - 12000), status: "stable", data_quality: "sufficient", data_quality_reason: null,
  publicNodes: [own("kyne-node2"), own("kyne-node3"), no("kyne-node3b")], on_chain_validators: OC }, o);
const v = (h) => healthVerdict(h, NOW);

console.log("\n[" + TAG + "] what /health says");
{
  const good = v(health());
  check("H1 two seeds with their own height, sufficient, list agreed: reading, three lines", good.reading && good.listAgreed && !good.older && good.problems.length === 0 && good.lines.join("\n") ===
    "  seeds: 2 of 3 answered; 2 gave their own height (kyne-node2 own height · kyne-node3 own height · kyne-node3b HTTP 503) · observed 12 s ago\n  data quality: sufficient · status: stable\n  validators list: agreed by 2 of 3 seeds · 35 ACTIVE", good.lines.join(" | "));
  // 1 Oct: every route answered 200, and this is what /health said.
  const oct1 = v(health({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers",
    publicNodes: [no("kyne-node2", "connection failed"), no("kyne-node3", "connection failed"), no("kyne-node3b", "connection failed")],
    on_chain_validators: { state: "not_agreed", active: null, seeds_agreed: 0, seeds_configured: 3, reason: "fewer than two public seeds returned a validator list" } }));
  check("H2 the 1 Oct picture (no row has a height_source key): not reading, the reason is the seeds, and it is this version, not an older one", !oct1.reading && !oct1.older && oct1.problems.join("; ") === "fewer than two seeds answered" && !oct1.listAgreed
    && oct1.lines[0].startsWith("  seeds: 0 of 3 answered; 0 gave their own height") && oct1.lines[1] === "  data quality: insufficient (too_few_answers) · status: unknown", JSON.stringify(oct1));
  const heights = v(health({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_heights", publicNodes: [own("kyne-node2"), fp("kyne-node3"), no("kyne-node3b")] }));
  check("H3 two answered, one own height: not reading", !heights.reading && heights.problems[0] === "fewer than two seeds gave their own height" && heights.lines[0].includes("kyne-node3 first peer's height"));
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
  check("H9 a fault in DNO's own read shows as such on the seeds line", !internal.reading && internal.lines[0].includes("kyne-node2 internal error"));
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
  check("H11 no line carries a key or an address", [good, oct1, heights, internal].every((x) => !/0x[0-9a-f]{8}|\d+\.\d+\.\d+\.\d+/i.test(x.lines.join("\n"))));
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
    && bad.out[bad.out.length - 1] === `AGENT IS NOT READING after ${W} s: fewer than two seeds answered. Roll back.`, JSON.stringify(bad.out));
  const short = await sim([OCT1], ["--wait", "30"]);
  check("R2b the same after a wait too short for a start: exit 3, 'NOT READING YET', and no 'Roll back'", short.code === 3 && short.polls === 7
    && short.out[short.out.length - 1] === "AGENT IS NOT READING YET after 30 s: fewer than two seeds answered. A start needs about a minute: run this again with the default wait before deciding anything." && !/Roll back/.test(short.out.join("\n")), JSON.stringify(short.out));
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
    && listOnly.out[listOnly.out.length - 1].startsWith(`THE VALIDATOR LIST IS NOT AGREED after ${W} s. It is not in status and is no reason to roll back`) && !/Roll back\./.test(listOnly.out.join("\n")), JSON.stringify(listOnly.out));
  // The verdict is not the last poll alone. The list is never agreed, so the check runs to the end of the wait; in the
  // last round one of the two answering seeds times out.
  const oneOut = at({ status: "unknown", data_quality: "insufficient", data_quality_reason: "too_few_answers", publicNodes: [own("kyne-node2"), no("kyne-node3", "timeout"), no("kyne-node3b")], on_chain_validators: NOLIST });
  const flake = await sim([...Array(POLLS - 1).fill(at({ on_chain_validators: NOLIST })), oneOut]);
  check("R10 reading for the whole wait, then one seed times out in the last round: exit 7, not 'Roll back'", flake.code === 7 && flake.polls === POLLS && !/[Rr]oll back\.|AGENT IS READING|NOT READING/.test(flake.out.join("\n"))
    && flake.out[flake.out.length - 1] === `AGENT WAS READING DURING THIS CHECK AND IS NOT NOW (after ${W} s): fewer than two seeds answered. A seed that stops answering looks like this; the failure of 1 Oct never read. Not a rollback yet: run this again in a minute.`, JSON.stringify(flake.out));
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
    && byDefault.out[0] === `post-restart check · waited ${DEFAULT_WAIT_SECONDS} s` && byDefault.out[byDefault.out.length - 1] === `AGENT IS NOT READING after ${DEFAULT_WAIT_SECONDS} s: fewer than two seeds answered. Roll back.`, JSON.stringify(byDefault.out));
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
  check("S2 the same server reading no seed, read once: NOT READING YET, exit 3", code2 === 3 && /^AGENT IS NOT READING YET after 0 s: fewer than two seeds answered\. /.test(out2[out2.length - 1]) && !/Roll back/.test(out2.join("\n")), JSON.stringify(out2));
  // The command itself, as the runbook runs it: the exit code is the verdict's.
  const cli = async (b) => { body = b; const kid = Bun.spawn([process.execPath, join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "post-restart-check.mjs"), "http://127.0.0.1:" + srv.port, "--wait", "0"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(kid.stdout).text(); return { code: await kid.exited, last: text.trim().split("\n").pop() }; };
  const cliOk = await cli(health({ observed_at: iso(Date.now() - 5000) }));
  check("S3 run as a command: READING, exit 0", cliOk.code === 0 && cliOk.last === "AGENT IS READING: two seeds gave their own height and the status comes from them. The validator list is agreed.", JSON.stringify(cliOk));
  const cliOld = await cli({ observed_at: iso(Date.now() - 5000), status: "stable", data_quality: "sufficient", publicNodes: [{ name: "kyne-node2", ok: true, block: 5 }, { name: "kyne-node3", ok: true, block: 5 }] });
  check("S4 run as a command against an older agent: exit 6", cliOld.code === 6 && /^AN OLDER VERSION IS ANSWERING/.test(cliOld.last), JSON.stringify(cliOld));
  srv.stop(true);
}

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
