// post-restart-check.mjs — the named test after a restart of the agent: is it reading?
//
// On 2026-10-01 a restarted agent served 200, passed the served suites and read 0 of 3 seeds for 40 minutes. This check
// asks the running agent's own /health and waits (the service needs 30 to 45 s to start, the first rounds a little more)
// until the answer is settled, or the wait is over.
//
// READING, the question a rollback depends on, is whether the agent has a reading by its own rule (status-rule.mjs):
//   1. the last public observation is fresh
//   2. data_quality is "sufficient" and witnesses.mode names what the reading rests on: at least two seeds that gave
//      their own height (seeds_only), one seed and validators that answer as listed within 25 blocks of it
//      (seed_and_validators), or such validators alone (validators_only), and the seed rows show the same
//   3. no seed read ended in an internal error (a fault in DNO's own read: the failure of 2026-10-01 was one)
// The on-chain validators list is reported on its own line. Two seeds are what agrees a list: while fewer than two
// are asked for it (a seed that answered with another key than the configured one is not asked), a list that is not
// agreed is expected, the agent keeps a witness candidate for 24 h after its last answer, and the check does not wait
// for it. With two seeds asked, a list that is not agreed makes the page say "not reported this cycle", and is no
// reason to roll back.
// A reading that rests on validators alone, with no seed height, is said apart and is not a pass: the seeds are read
// by name through the runtime's fetch and the validators at an address literal, so a fault in DNO's own seed read looks
// exactly like every seed being down. The failure of 2026-10-01 was such a fault.
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
// Exit: 0 "AGENT IS READING", a seed's own height is in the reading, and the validator list is agreed or fewer than
//         two seeds are asked for it
//       8 "AGENT IS READING WITHOUT A SEED": validators alone at the end of the wait (such a reading does not end the
//         wait early); seeds down and a fault in DNO's seed read look the same (not a pass and not by itself a
//         rollback: the pre-restart check's seed lines, and whether the seeds answer another client, decide)
//       5 "AGENT IS READING", two seeds are asked and the validator list is not agreed (not a rollback; run it again)
//       9 "AGENT IS READING", and no read of the validator list has completed in the whole wait: the validator round
//         is not running to its end (not a rollback by this check; the agent's log says whether a round failed)
//       7 it read during this check and its latest observation is not enough (not a rollback; run it again)
//       3 "AGENT IS NOT READING" (roll back, when the wait was long enough for a start), or it did not stay up
//         during this check (roll back, whatever the wait: it answered and then stopped or started again)
//       4 /health was never read (roll back, when the wait was long enough for a start)
//       6 an older version is answering: this check is for the version that publishes witnesses (API 1.2)
//       64 the arguments could not be read
//       70 this check's own code failed on what /health returned: nothing is concluded about the agent

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
// { older, reading, mode, problems, listAgreed, listExpected, listLine, lines, observedAt }: problems are the reasons it is
// not reading; listExpected is false while fewer than two seeds are asked for the list (no list can be agreed then: a
// seed that did not answer, or answered with another key than the configured one, is not asked); observedAt is the
// observation's time in ms, or null.
export function healthVerdict(h, now) {
  const nodes = Array.isArray(h && h.publicNodes) ? h.publicNodes : [];
  const oc = h && h.on_chain_validators && typeof h.on_chain_validators === "object" ? h.on_chain_validators : null;
  const wit = h && h.witnesses && typeof h.witnesses === "object" && typeof h.witnesses.mode === "string" ? h.witnesses : null;
  // An agent older than 1.2 publishes no witnesses object: what its reading rests on cannot be judged here.
  const older = !!h && typeof h === "object" && nodes.length > 0 && !wit;
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
  const faults = nodes.filter((n) => n && !n.ok && n.error === "internal error").length;
  if (faults > 0) problems.push(`${faults} seed read${faults === 1 ? "" : "s"} ended in an internal error, a fault in DNO's own read`);
  // What the reading rests on, in the agent's own words (witnesses), checked against the seed rows it publishes.
  const mode = wit ? wit.mode : null, wv = wit && wit.validators && typeof wit.validators === "object" ? wit.validators : null;
  const n = wv && Number.isInteger(wv.counted) ? wv.counted : 0;
  const agreedAt = wv && typeof wv.list_agreed_at === "string" ? ` · their list was agreed at ${wv.list_agreed_at.slice(0, 16).replace("T", " ")} UTC` : "";
  if (wit) lines.push("  reading: " + ({ seeds_only: "from the seeds alone", seed_and_validators: `one seed and ${n} validator${n === 1 ? "" : "s"} within 25 blocks of it${agreedAt}`,
    validators_only: `${n} validators that answer as listed, no seed${agreedAt}`,
    insufficient: "none" + (wv ? ` · ${wv.read} validator${wv.read === 1 ? "" : "s"} read, ${wv.own_height} answered as listed with a height` : " · no validator was read") }[mode] || "not a known mode") + ` (${mode})`);
  const expectOwn = { seeds_only: s.ownHeights >= 2, seed_and_validators: s.ownHeights === 1 && n >= 1, validators_only: s.ownHeights === 0 && n >= 2 };
  if (wit && mode !== "insufficient" && expectOwn[mode] !== true) problems.push(`the reading is said to be ${mode}, and the seed rows show ${s.ownHeights} own height${s.ownHeights === 1 ? "" : "s"} and ${n} validator${n === 1 ? "" : "s"} counted`);
  if (!wit || mode === "insufficient") { if (!s.sufficient) problems.push((s.reason === "too_few_answers" ? "fewer than two seeds answered" : "fewer than two seeds gave their own height") + (wit ? ", and no validator stood in" : "")); }
  const dq = h && h.data_quality, why = h && h.data_quality_reason;
  lines.push(`  data quality: ${dq || "not reported"}${why ? ` (${why})` : ""} · status: ${(h && h.status) || "not reported"}`);
  if (dq !== "sufficient" && problems.length === 0) problems.push(`data quality is ${dq || "not reported"}`);
  // A document that contradicts itself is not a reading: no agent of this version says "sufficient" beside no mode, or
  // gives a mode beside the status unknown.
  const st = h && h.status;
  if (problems.length === 0 && wit && mode === "insufficient") problems.push("data quality is sufficient, and the agent says the reading rests on nothing (insufficient)");
  if (problems.length === 0 && (typeof st !== "string" || st === "unknown")) problems.push(`the status is ${typeof st === "string" ? st : "not reported"} beside a reading`);
  const listAgreed = !!oc && oc.state === "agreed";
  const listExpected = nodes.filter((n) => n && n.ok && n.identityMatch !== false).length >= 2;
  const listLine = !oc ? "  validators list: not reported by this server"
    : listAgreed ? `  validators list: agreed by ${oc.seeds_agreed} of ${oc.seeds_configured} seeds · ${oc.active} ACTIVE` : `  validators list: ${oc.state}${oc.reason ? ` (${oc.reason})` : ""}`;
  lines.push(listLine);
  // pending: no read of the validator list has completed since the agent started (the first one takes about a minute).
  const listPending = !!oc && oc.state === "pending";
  return { older, reading: !older && problems.length === 0, mode, counted: n, ownHeights: s.ownHeights, problems, listAgreed, listExpected, listPending, listLine: listLine.trim(), lines, observedAt: Number.isFinite(observedAt) ? observedAt : null };
}
// What "AGENT IS READING" says the status comes from.
export function readingWords(v) {
  if (v.mode === "seed_and_validators") return `one seed gave its own height, ${v.counted} validator${v.counted === 1 ? " that answers as listed is" : "s that answer as listed are"} within 25 blocks of it, and the status comes from them`;
  if (v.mode === "validators_only") return `no seed gave its own height, and the status comes from ${v.counted} validators that answer as listed`;
  return (v.ownHeights === 3 ? "three" : v.ownHeights > 3 ? String(v.ownHeights) : "two") + " seeds gave their own height and the status comes from them";
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
  let last = null, readError = null, sawReading = false, answered = false, newest = null, wentAway = null, ownFault = null;
  for (;;) {
    try {
      const res = await fetchFn(base + "/health", { signal: AbortSignal.timeout(5000), headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { category: "HTTP " + res.status });
      const body = await res.json();
      // A 200 that is not a /health document (an empty body parses as null) is a failed read, not an agent without an observation.
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("not a /health document"), { category: "not JSON" });
      // What this check makes of the document is its own code: a fault there says nothing about the agent, and must
      // not read as "the agent does not answer".
      try { last = healthVerdict(body, now()); } catch (e) { ownFault = e; break; }
      readError = null; answered = true;
      if (newest !== null && !last.older && (last.observedAt === null || last.observedAt < newest)) wentAway = "its observation went back to " + (last.observedAt === null ? "none" : "an earlier one");
      if (last.observedAt !== null && (newest === null || last.observedAt > newest)) newest = last.observedAt;
      if (last.reading) sawReading = true;
      // A reading that rests on validators alone does not end the wait: one round in which no seed answered, right
      // after a start, is followed by rounds in which they do. Only a reading with a seed's own height ends it early.
      if (last.older || (last.reading && last.mode !== "validators_only" && (last.listAgreed || !last.listExpected) && !wentAway)) break;
    } catch (e) {
      readError = e && e.category ? e.category : e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : e instanceof SyntaxError ? "not JSON" : "connection failed";
      if (answered && readError === "connection failed") wentAway = "its port stopped answering after it had answered";
    }
    if (now() - started >= waitS * 1000) break;
    await sleep(5000);
  }
  const waited = Math.round((now() - started) / 1000), long = waited >= ROLLBACK_MIN_WAIT_SECONDS;
  log(`post-restart check · waited ${waited} s`);
  if (ownFault) {
    log(`THIS CHECK FAILED ON WHAT /health RETURNED (${ownFault && ownFault.name ? ownFault.name : "error"}): a fault in the check's own code. Nothing is concluded about the agent, and this is no reason to roll back. Send this output.`);
    return 70;
  }
  if (!last) {
    log(`AGENT IS NOT ANSWERING after ${waited} s: /health could not be read (${readError}). ` + (long ? "A start takes under a minute: roll back." : "A start needs about a minute: run this again with the default wait before deciding anything."));
    return 4;
  }
  last.lines.forEach((l) => log(l));
  if (last.older) { log("AN OLDER VERSION IS ANSWERING: its /health has no witnesses object (API 1.2). This check is for the new version; nothing is concluded. If the service was restarted on the new code, the restart did not take effect."); return 6; }
  if (wentAway) {
    log(`THE AGENT DID NOT STAY UP DURING THIS CHECK (after ${waited} s): ${wentAway}. An agent that stops or starts again by itself is failing: roll back. systemd knows which: a start time later than your own restart, or a restart count above 0, is the proof; with the start time of your restart and a count of 0 the process did not start again, and this check is run once more instead.`);
    return 3;
  }
  // The verdict is not the last poll alone: an agent that read during this check is not the 1 Oct failure, whatever the last poll says.
  if (readError || !last.reading) {
    const why = readError ? `the latest read of /health failed (${readError}); the lines above are the read before it` : last.problems.join("; ") || "the latest observation is not enough";
    if (sawReading && readError) { log(`AGENT WAS READING DURING THIS CHECK AND ITS /health DID NOT ANSWER AT THE END (after ${waited} s: ${readError}); the lines above are the read before it. Not a rollback yet: run this again.`); return 7; }
    if (sawReading) { log(`AGENT WAS READING DURING THIS CHECK AND IS NOT NOW (after ${waited} s): ${why}. A seed or a validator that stops answering looks like this; the failure of 1 Oct never read. Not a rollback yet: run this again in a minute.`); return 7; }
    if (!long) { log(`AGENT IS NOT READING YET after ${waited} s: ${why}. A start needs about a minute: run this again with the default wait before deciding anything.`); return 3; }
    log(`AGENT IS NOT READING after ${waited} s: ${why}. Roll back.`);
    return 3;
  }
  if (last.mode === "validators_only") {
    log(`AGENT IS READING WITHOUT A SEED after ${waited} s: ${readingWords(last)}. This check cannot tell seeds that are down from a fault in DNO's own seed read (the failure of 1 Oct was one). Run tools/pre-restart-check.mjs: where it says a seed gave no answer for a timeout, a failed connection or an internal error, and that seed answers another client from this host, DNO's read is at fault: roll back. Otherwise this is the outage the validators stand in for.`);
    return 8;
  }
  if (last.listAgreed) { log(`AGENT IS READING: ${readingWords(last)}. The validator list is agreed.`); return 0; }
  if (!last.listExpected) { log(`AGENT IS READING: ${readingWords(last)}. No validator list is agreed while fewer than two seeds are asked for it; the agent keeps a witness candidate for 24 h after its last answer.`); return 0; }
  log(`AGENT IS READING: ${readingWords(last)}.`);
  if (last.listPending) {
    // A validator round runs once a minute and the first begins with the agent: after a wait of two minutes or more one
    // has had time to complete. A round that fails inside DNO never completes, and says so in the agent's log only.
    if (!long) { log(`THE VALIDATOR LIST HAS NOT BEEN READ YET after ${waited} s. A first read needs about a minute: run this again with the default wait.`); return 5; }
    log(`THE VALIDATOR ROUND HAS NOT COMPLETED after ${waited} s: no read of the validator list has finished since the agent started, though a round runs once a minute. This is not what a list that is not agreed looks like. The agent's log says whether a round failed inside DNO ("round failed"): send this output with that count. It is no reason to roll back by itself: the seeds are read, and no validator can stand in until a round completes.`);
    return 9;
  }
  log(`THE VALIDATOR LIST IS NOT AGREED after ${waited} s. It is no reason to roll back: the page says "not reported this cycle", and the agent keeps the witness candidates it has. Run this again in a minute; if it stays, send this output.`);
  return 5;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
