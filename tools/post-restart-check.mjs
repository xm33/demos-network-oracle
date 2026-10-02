// post-restart-check.mjs — the named test after a restart of the agent: is it reading?
//
// On 2026-10-01 a restarted agent served 200, passed the served suites and read 0 of 3 seeds for 40 minutes. This check
// asks the running agent's own /health and waits (the service needs 30 to 45 s to start, the first rounds a little more)
// until the answer is settled, or the wait is over.
//
// READING, the question a rollback depends on, is about the seeds only, because status is made of them:
//   1. the last public observation is fresh, and in it at least two seeds gave their own height
//      (seedsSufficient in src/seed-read.mjs, the agent's own rule)
//   2. data_quality is "sufficient", so the status comes from the seeds
// The on-chain validators list is reported on its own line. It is not in status: a list that is not agreed makes the
// page say "not reported this cycle", and is no reason to roll back.
// "Roll back" is said of an agent that never read during this check (the failure of 2026-10-01 never read), that never
// answered for the whole wait, or that did not stay up: after a poll that answered, its port refused a connection or its
// observation went back to none or to an earlier one. An observation only moves forward within one process, so that is
// a restart during the check; a crash loop reads once per life and would otherwise pass.
// An agent that read and whose latest observation is not enough (a seed stopped answering, or the last read of /health
// timed out) is told apart: run the check again.
// It prints names of seeds and counts only: never a host, an address or a key.
//
// Run:  bun tools/post-restart-check.mjs [base-url] [--wait seconds]     (default http://127.0.0.1:55225, 180 s)
//       On the host that runs the agent: the age of an observation is measured on this machine's clock.
// Exit: 0 "AGENT IS READING" and the validator list is agreed
//       5 "AGENT IS READING", the validator list is not agreed (not a rollback; run it again)
//       7 it read during this check and its latest observation is not enough (not a rollback; run it again)
//       3 "AGENT IS NOT READING", or it did not stay up (roll back, when the wait was long enough for a start)
//       4 /health was never read (roll back, when the wait was long enough for a start)
//       6 an older version is answering: this check is for the version that publishes height_source

import { seedsSufficient } from "../src/seed-read.mjs";

// An observation older than this is not a current one. A public round runs every 20 s by default; where /health says
// the agent is configured otherwise (last_24h.expected_cycles is the rounds of a day), two rounds and 30 s are allowed.
export const FRESH_SECONDS = 120;
export function freshSeconds(h) {
  const cycles = h && h.last_24h && h.last_24h.expected_cycles;
  return Number.isFinite(cycles) && cycles > 0 ? Math.max(FRESH_SECONDS, Math.round(2 * 86400 / cycles + 30)) : FRESH_SECONDS;
}
export const ROLLBACK_MIN_WAIT_SECONDS = 90;   // a start needs 30 to 45 s and a first round: a shorter wait cannot conclude "roll back"
export const DEFAULT_WAIT_SECONDS = 180;
const CLOCK_SLACK_MS = 5000;                    // an observation dated further ahead of this machine's clock is not this clock's

// What /health says. h: the parsed /health body; now: ms.
// { older, reading, problems, listAgreed, listLine, lines, observedAt }: problems are the reasons it is not reading (seeds
// only); observedAt is the observation's time in ms, or null.
export function healthVerdict(h, now) {
  const nodes = Array.isArray(h && h.publicNodes) ? h.publicNodes : [];
  const oc = h && h.on_chain_validators && typeof h.on_chain_validators === "object" ? h.on_chain_validators : null;
  // An agent older than 1.1 publishes neither a seed's height_source nor the validators list: its rows cannot be judged.
  const older = !!h && typeof h === "object" && nodes.length > 0 && !oc && !nodes.some((n) => n && "height_source" in n);
  const s = seedsSufficient(nodes), problems = [];
  const observedAt = h && typeof h.observed_at === "string" ? Date.parse(h.observed_at) : NaN;
  const ahead = Number.isFinite(observedAt) && observedAt - now > CLOCK_SLACK_MS;
  const age = Number.isFinite(observedAt) ? Math.max(0, Math.round((now - observedAt) / 1000)) : null;
  const seedWords = nodes.map((n) => String(n && n.name) + " " + (n && n.ok ? (n.height_source === "self" ? "own height" : n.height_source === "first_peer" ? "first peer's height" : "no height") : String((n && n.error) || "no answer"))).join(" · ");
  const lines = [`  seeds: ${s.answered} of ${nodes.length} answered; ${s.ownHeights} gave ${s.ownHeights === 1 ? "its" : "their"} own height` + (seedWords ? ` (${seedWords})` : "")
    + (age === null ? " · no observation yet" : ahead ? " · observation dated after this machine's clock" : ` · observed ${age} s ago`)];
  if (age === null) problems.push("no public observation has completed");
  else if (ahead) problems.push("the observation is dated after this machine's clock");
  else if (age > freshSeconds(h)) problems.push(`the last public observation is ${age} s old`);
  if (!s.sufficient) problems.push(s.reason === "too_few_answers" ? "fewer than two seeds answered" : "fewer than two seeds gave their own height");
  const dq = h && h.data_quality, why = h && h.data_quality_reason;
  lines.push(`  data quality: ${dq || "not reported"}${why ? ` (${why})` : ""} · status: ${(h && h.status) || "not reported"}`);
  if (dq !== "sufficient" && problems.length === 0) problems.push(`data quality is ${dq || "not reported"}`);
  const listAgreed = !!oc && oc.state === "agreed";
  const listLine = !oc ? "  validators list: not reported by this server"
    : listAgreed ? `  validators list: agreed by ${oc.seeds_agreed} of ${oc.seeds_configured} seeds · ${oc.active} ACTIVE` : `  validators list: ${oc.state}${oc.reason ? ` (${oc.reason})` : ""}`;
  lines.push(listLine);
  return { older, reading: !older && problems.length === 0, problems, listAgreed, listLine: listLine.trim(), lines, observedAt: Number.isFinite(observedAt) ? observedAt : null };
}

// args: [base-url] [--wait seconds]. io: { fetch, sleep, now, log } for tests. Returns the exit code.
export async function run(args, io = {}) {
  const fetchFn = io.fetch || fetch, sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), now = io.now || Date.now, log = io.log || console.log;
  const w = args.indexOf("--wait"), waitS = w >= 0 ? Number(args[w + 1]) : DEFAULT_WAIT_SECONDS;
  const rest = args.filter((a, i) => !(a === "--wait" || (w >= 0 && i === w + 1)));
  const base = (rest[0] || "http://127.0.0.1:55225").replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(base) || !Number.isFinite(waitS) || waitS < 0) { console.error("Usage: bun tools/post-restart-check.mjs [base-url] [--wait seconds]"); return 64; }
  const started = now();
  // answered: a poll got a /health body. newest: the latest observation time seen. wentAway: why the agent is known
  // not to have stayed up during this check.
  let last = null, readError = null, sawReading = false, answered = false, newest = null, wentAway = null;
  for (;;) {
    try {
      const res = await fetchFn(base + "/health", { signal: AbortSignal.timeout(5000), headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { category: "HTTP " + res.status });
      const body = await res.json();
      // A 200 that is not a /health document (an empty body parses as null) is a failed read, not an agent without an observation.
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("not a /health document"), { category: "not JSON" });
      last = healthVerdict(body, now()); readError = null; answered = true;
      if (newest !== null && !last.older && (last.observedAt === null || last.observedAt < newest)) wentAway = "its observation went back to " + (last.observedAt === null ? "none" : "an earlier one");
      if (last.observedAt !== null && (newest === null || last.observedAt > newest)) newest = last.observedAt;
      if (last.reading) sawReading = true;
      if (last.older || (last.reading && last.listAgreed && !wentAway)) break;
    } catch (e) {
      readError = e && e.category ? e.category : e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : e instanceof SyntaxError ? "not JSON" : "connection failed";
      if (answered && readError === "connection failed") wentAway = "its port stopped answering after it had answered";
    }
    if (now() - started >= waitS * 1000) break;
    await sleep(5000);
  }
  const waited = Math.round((now() - started) / 1000), long = waited >= ROLLBACK_MIN_WAIT_SECONDS;
  log(`post-restart check · waited ${waited} s`);
  if (!last) {
    log(`AGENT IS NOT ANSWERING after ${waited} s: /health could not be read (${readError}). ` + (long ? "A start takes under a minute: roll back." : "A start needs about a minute: run this again with the default wait before deciding anything."));
    return 4;
  }
  last.lines.forEach((l) => log(l));
  if (last.older) { log("AN OLDER VERSION IS ANSWERING: its /health has no height_source and no validators list. This check is for the new version; nothing is concluded."); return 6; }
  if (wentAway) {
    log(`THE AGENT DID NOT STAY UP DURING THIS CHECK (after ${waited} s): ${wentAway}. An agent that stops or starts again by itself is failing: roll back. (If you restarted the service yourself while this ran, run it again instead.)`);
    return 3;
  }
  // The verdict is not the last poll alone: an agent that read during this check is not the 1 Oct failure, whatever the last poll says.
  if (readError || !last.reading) {
    const why = readError ? `the latest read of /health failed (${readError}); the lines above are the read before it` : last.problems.join("; ") || "the latest observation is not enough";
    if (sawReading && readError) { log(`AGENT WAS READING DURING THIS CHECK AND ITS /health DID NOT ANSWER AT THE END (after ${waited} s: ${readError}); the lines above are the read before it. Not a rollback yet: run this again.`); return 7; }
    if (sawReading) { log(`AGENT WAS READING DURING THIS CHECK AND IS NOT NOW (after ${waited} s): ${why}. A seed that stops answering looks like this; the failure of 1 Oct never read. Not a rollback yet: run this again in a minute.`); return 7; }
    if (!long) { log(`AGENT IS NOT READING YET after ${waited} s: ${why}. A start needs about a minute: run this again with the default wait before deciding anything.`); return 3; }
    log(`AGENT IS NOT READING after ${waited} s: ${why}. Roll back.`);
    return 3;
  }
  if (last.listAgreed) { log("AGENT IS READING: two seeds gave their own height and the status comes from them. The validator list is agreed."); return 0; }
  log("AGENT IS READING: two seeds gave their own height and the status comes from them.");
  log(`THE VALIDATOR LIST IS NOT AGREED after ${waited} s. It is not in status and is no reason to roll back: the page says "not reported this cycle". Run this again in a minute; if it stays, send this output.`);
  return 5;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
