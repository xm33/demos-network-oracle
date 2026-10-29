// home-cycle.mjs — the This cycle card's lines and the first screen's band, one source: the agent's page for readers
// without JavaScript and the page's script (inlined at build) both use this file; home-cycle.test.mjs has the cases.
// No imports.

var isNum = function(v) { return typeof v === "number" && Number.isFinite(v); };
var fmt = function(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };

// The ACTIVE count as the agreeing seeds list it (on_chain_validators while agreed), or null: the band's on-chain tile
// shows this count, and the seeds line names the same count or none.
export function leadCount(oc) {
  return oc && oc.state === "agreed" && isNum(oc.active) && isNum(oc.seeds_agreed) ? oc.active : null;
}

// The second line, in parts. r is one observation: { publicNodes (the configured seeds, each with ok), agreement (the
// object /health publishes, or /organism's string), data_quality_reason, staleness_seconds, height_static_seconds,
// active_incidents, witnesses (1.2: what the reading rests on), height_standstill_after_seconds (1.2) }.
// active: leadCount() of the same /health, or null.
// While two seeds give their own height (witnesses.mode seeds_only, or no witnesses object: API 1.1) the line is the
// seeds' alone. When validators stand in for a missing seed it says how many, and what status then is.
export function seedsParts(r, active) {
  r = r || {};
  var ag = r.agreement && typeof r.agreement === "object" ? r.agreement : { state: r.agreement };
  var st = typeof ag.state === "string" ? ag.state.toLowerCase() : null;
  var compared = st === "strong" || st === "moderate" || st === "weak";
  var nodes = Array.isArray(r.publicNodes) && r.publicNodes.length ? r.publicNodes : null;
  var k = nodes ? nodes.filter(function(n) { return n && n.ok === true; }).length : null;
  var w = r.witnesses && typeof r.witnesses === "object" && typeof r.witnesses.mode === "string" ? r.witnesses : null;
  var mode = w ? w.mode : null, wv = w && w.validators && typeof w.validators === "object" ? w.validators : null;
  var n = wv && isNum(wv.counted) ? wv.counted : 0;                // validators counted in the reading
  var stoodIn = compared && n > 0 && (mode === "seed_and_validators" || mode === "validators_only");
  // Seeds that gave their own height. With validators in the reading agreement.total_nodes counts what was compared,
  // so the seeds' own count comes from witnesses.
  var m = w && w.public_seeds && isNum(w.public_seeds.own_height) ? w.public_seeds.own_height : isNum(ag.total_nodes) ? ag.total_nodes : null;
  var dq = typeof r.data_quality_reason === "string" ? r.data_quality_reason : null;
  var own = function(x) { return x === 0 ? "none gave its own height" : x === 1 ? "1 gave its own height" : x + " gave their own height"; };
  var fewer = nodes && m !== null && m < k && (compared || dq === "too_few_heights");
  var listed = function(x) { return x + (x === 1 ? " validator that answers as listed" : " validators that answer as listed"); };
  var p = { answered: null, heights: null, stall: null, incidents: null, status: null };
  if (dq === "no_observation") p.answered = "No observation of the configured seeds has completed yet.";
  else if (dq === "stale") {
    p.answered = "The last observation of the configured seeds is " + (isNum(r.staleness_seconds) ? Math.floor(r.staleness_seconds / 60) + " min old." : "more than 5 min old.");
    p.heights = "Heights were not compared.";
  } else {
    if (nodes) p.answered = k + " of " + nodes.length + " configured seeds answered" + (fewer ? "; " + own(m) : "") + ".";
    else if (compared && m !== null) p.answered = m === 0 ? "No configured seed gave its own height." : m === 1 ? "1 configured seed gave its own height." : m + " configured seeds gave their own height.";
    else if (dq === "too_few_answers") p.answered = "Fewer than two configured seeds answered.";
    else if (dq === "too_few_heights") p.answered = "Fewer than two configured seeds gave their own height.";
    else p.answered = "Seeds: not reported in this reading.";
    if (stoodIn && mode === "seed_and_validators") {
      // Validators that gave a height further than 25 blocks from the seed are left out of the reading, and said.
      var far = isNum(wv.own_height) && wv.own_height > n ? wv.own_height - n : 0;
      p.heights = listed(n) + (n === 1 ? " is" : " are") + " within 25 blocks of it."
        + (st !== "strong" && isNum(ag.block_spread) ? " The closest is " + fmt(ag.block_spread) + " blocks from it." : "")
        + (far > 0 ? " " + far + (far === 1 ? " other is" : " others are") + " more than 25 blocks from it." : "");
    } else if (stoodIn) {
      p.heights = listed(n) + " report heights " + (st === "strong" ? "that align." : isNum(ag.block_spread) ? "up to " + fmt(ag.block_spread) + " blocks apart." : "with " + st + " agreement.");
    } else if (!compared) {
      // No reading. When validators were read and did not stand in, the line says what they did: none gave a height,
      // none is near the one seed, one alone gave a height, or they give no majority. That is a comparison, so "not
      // compared" is said only where no validator was read.
      var vh = wv && isNum(wv.own_height) ? wv.own_height : null;
      p.heights = mode !== "insufficient" || !wv ? "Heights were not compared."
        : vh === 0 ? "No validator answered as listed with its own height."
        : m === 1 ? "No validator that answers as listed is within 25 blocks of it."
        : vh === 1 ? "1 validator answered as listed with its own height; a reading needs two."
        : "The validators that answer as listed give no majority within 25 blocks.";
    } else {
      var subject = fewer ? "Those heights" : nodes || m !== null ? "Their heights" : "The seeds' heights";
      if (st === "strong") p.heights = subject + " align.";
      else if (isNum(ag.block_spread)) {
        p.heights = subject + " differ by " + (m === 2 ? "" : "up to ") + fmt(ag.block_spread) + " blocks"
          + (m !== null && m >= 3 && isNum(ag.aligned_nodes) && ag.aligned_nodes < m ? "; " + ag.aligned_nodes + " of " + m + (ag.aligned_nodes === 1 ? " is" : " are") + " within 25 blocks of the median" : "") + ".";
      } else p.heights = "Height agreement is " + st + ".";
    }
  }
  // A stale observation's figures are as old as the observation: nothing is said about new heights then. "No new
  // height", not "the height has not moved": below the highest height read, a height DNO reads can rise without being new.
  // From the standstill limit on (1.2) a reading that would be stable reads degraded: the line says so.
  // Beside one seed the count is the seed's: the validators counted with it can show higher heights meanwhile.
  if (dq !== "stale" && isNum(r.height_static_seconds) && r.height_static_seconds >= 300) {
    var limit = isNum(r.height_standstill_after_seconds) && r.height_standstill_after_seconds > 0 ? r.height_standstill_after_seconds : null;
    p.stall = (stoodIn && mode === "seed_and_validators" ? "The seed has shown no new height for " : "No new height for ") + Math.floor(r.height_static_seconds / 60) + " min"
      + (limit !== null && compared && r.height_static_seconds >= limit ? "; from " + Math.floor(limit / 60) + " min on, status does not read stable." : ".");
  }
  if (isNum(r.active_incidents) && r.active_incidents > 0) p.incidents = r.active_incidents + " active public incident" + (r.active_incidents === 1 ? "" : "s") + ".";
  // Without a reading the status is unknown, and the line says so: what status would be made of is said only of a reading.
  if (!compared) p.status = "Status is unknown.";
  else p.status = (stoodIn && mode === "seed_and_validators" ? "Status is that seed and " + (n === 1 ? "that validator" : "those validators")
    : stoodIn ? "Status is those validators alone" : "Status is those seeds") + (isNum(active) ? ", not the " + fmt(active) : "") + ".";
  return p;
}
// The seeds line says nothing the band does not when every seed that answered gave its own height, those heights align,
// none has stopped, no incident is open, and status is the seeds': the page then leaves the line out. Any other state
// (a seed without its own height, validators standing in, a spread, a standstill, an incident, a stale or missing
// observation, a failed read) keeps it.
export function seedsCalm(r, active) {
  var p = seedsParts(r, active);
  return /^(\d+ of \d+ configured seeds answered|\d+ configured seeds gave their own height)\.$/.test(p.answered || "") && p.heights === "Their heights align."
    && !p.stall && !p.incidents && /^Status is those seeds(, not the [\d,]+)?\.$/.test(p.status || "");
}
export function cycleSeeds(r, active) {
  var p = seedsParts(r, active);
  return [p.answered, p.heights, p.stall, p.incidents, p.status].filter(Boolean).join(" ");
}
// The slim bar that follows the reader repeats the card, what moves status first: incidents, then the seeds and heights.
export function readbarText(r) {
  var p = seedsParts(r, null);
  return [p.incidents, p.answered, p.heights, p.stall].filter(Boolean).join(" ");
}

// The trend card's reason: the comparison the agent makes (agent.mjs, the trend block), in words. Backward-looking only.
// Empty for unknown: the definition on the card says why (fewer than 10 prior cycles, or data quality insufficient).
export function trendReason(trend) {
  return trend === "improving" || trend === "stable" || trend === "worsening"
    ? "This round against the mean of the previous 10\u201315 rounds: seeds answering, agreement, block spread."
    : "";
}

// ---- The band beside the status word (the first screen). Each tile is one published figure with its own clock, or
// the word the sections below use for the same field when there is none: "reading" before the first read, "not
// reported" when the document does not carry the field, "unknown" when it does and the figure is not current or not
// agreed, "not computed" for a median no comparison made, "not observed" for a watch turned off on the server. The
// page says "not read" itself when a request failed. Nothing is carried over from an earlier read.
var objOf = function(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : null; };
var clockOf = function(t) { return typeof t === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(t) ? t.slice(11, 19) : null; };
var READING = function() { return { value: "reading", unit: null, line: null, n: null }; };
var NONE = function(value, line) { return { value: value, unit: null, line: line || null, n: null }; };

// Height movement, in the words of the Agreement section's line under its median block; null when the document does
// not carry height_static_seconds. r: /organism or /health (or the agent's canonical state).
export function heightLine(r) {
  r = objOf(r) || {};
  var hs = r.height_static_seconds;
  if (hs === undefined) return null;
  if (!isNum(hs)) return "height movement not observed this cycle";
  var seen = typeof r.height_last_advanced_at === "string", span = hs < 120 ? hs + " s" : Math.floor(hs / 60) + " min";
  var w = objOf(r.witnesses), seed = !!w && w.mode === "seed_and_validators";
  var following = Array.isArray(r.risk_factors) && r.risk_factors.indexOf("following heights below a height read earlier") >= 0;
  return hs === 0 ? (seen ? "a new height arrived this cycle" : following ? "following lower heights; no arrival is claimed" : "count started this cycle; no arrival seen")
    : seed ? "the seed has shown no new height for " + (seen ? "" : "at least ") + span
    : seen ? "no new height for " + span : "no new height seen for at least " + span;
}
// The reading's median block, only where heights were compared (one seed's height is not a median), and how long since
// a new height. r: /organism (agreement a word, agreement_detail) or the /health shape (agreement an object).
export function tileMedian(r) {
  r = objOf(r);
  if (!r) return READING();
  var a = objOf(r.agreement), d = objOf(r.agreement_detail) || a;
  var st = typeof r.agreement === "string" ? r.agreement.toLowerCase() : a && typeof a.state === "string" ? a.state.toLowerCase() : null;
  var compared = st === "strong" || st === "moderate" || st === "weak";
  var n = compared && d && isNum(d.median_block) ? d.median_block : null;
  return { value: n !== null ? fmt(n) : st === null ? "not reported" : !compared ? "not computed" : "not reported",
    unit: null, line: r.data_quality_reason === "stale" ? null : heightLine(r), n: n };
}
// The configured public seeds that gave their own height in this reading (witnesses.public_seeds, API 1.2). The line
// names the seeds that gave none: "did not" give its own height, which is not "did not answer" (a seed can answer
// without its own height).
export function tileSeeds(r) {
  r = objOf(r);
  if (!r) return READING();
  var w = objOf(r.witnesses), ps = w && objOf(w.public_seeds);
  if (!ps || !isNum(ps.own_height) || !isNum(ps.configured)) return NONE("not reported");
  if (r.data_quality_reason === "stale" || r.data_quality_reason === "no_observation") return NONE("unknown");
  var own = ps.own_height, rest = ps.configured - own;
  var line = own === 0 ? "none gave its own height" : (own === 1 ? "gave its own height" : "gave their own height") + (rest > 0 ? "; " + fmt(rest) + " did not" : "");
  return { value: fmt(own), unit: "of " + fmt(ps.configured), line: line, n: own };
}
// The ACTIVE count as the agreeing seeds list it (leadCount), with the list read's own clock. h: /health.
export function tileOnChain(h) {
  h = objOf(h);
  if (!h) return READING();
  var oc = objOf(h.on_chain_validators);
  if (!oc) return NONE("not reported");
  if (oc.state === "pending") return READING();
  var n = leadCount(oc), at = clockOf(oc.observed_at);
  return { value: n === null ? "unknown" : fmt(n), unit: n === null ? null : "ACTIVE", line: at ? "list read " + at + " UTC" : null, n: n };
}
// The ACTIVE rows that answered DNO's dial as their listed key, with the watch round's own clock. The server marks the
// round stale after 300 s; a round that is not observed gives no count. h: /health.
export function tileAnswered(h) {
  h = objOf(h);
  if (!h) return READING();
  var w = objOf(h.validator_watch);
  if (!w) return NONE("not reported");
  if (w.state === "pending") return READING();
  if (w.state === "disabled") return NONE("not observed");
  var at = clockOf(w.round_at), line = at ? "checked " + at + " UTC" : null;
  if (w.state !== "observed") return NONE("unknown", line);
  if (!isNum(w.answered_as_listed)) return NONE("not reported", line);
  return { value: fmt(w.answered_as_listed), unit: null, line: line, n: w.answered_as_listed };
}
// The sentence under the band: the two validator figures are separate observations, and neither is a count of what is
// online. active and answered: the n of the two tiles (the number shown, or null).
export function tilesBetween(active, answered) {
  return { text: isNum(active) && isNum(answered) ? fmt(active) + " and " + fmt(answered) + " are two observations on their own clocks. Neither shows how many validators are online."
    : "Neither validator figure shows how many validators are online.", link: isNum(active) ? "How the " + fmt(active) + " split" : "Validators on chain" };
}
// Where each band figure comes from, with its clock, for Explain this reading: the reading's (/organism), the list
// read's and the watch round's (/health). A document not read yet says so; a field it does not carry is not reported.
export function figureClocks(o, h) {
  o = objOf(o); h = objOf(h);
  var at = function(t, word) { var c = clockOf(t); return c ? word + " " + c + " UTC" : "not reported"; };
  var oc = h && objOf(h.on_chain_validators), w = h && objOf(h.validator_watch);
  return { reading: o ? at(o.observed_at, "read") : "not read yet",
    list: !h ? "not read yet" : oc && oc.state !== "pending" ? at(oc.observed_at, "read") : oc ? "not read yet" : "not reported",
    check: !h ? "not read yet" : w && w.state !== "pending" && w.state !== "disabled" ? at(w.round_at, "round") : w && w.state === "disabled" ? "turned off on this server" : w ? "not read yet" : "not reported" };
}
// What the on-chain figure rests on, for Explain this reading, in the list's own words: the published reason while the
// seeds agreed, and in every other state (pending, stale, not agreed, or one this page does not know) a line that
// begins "no" and claims no agreement. Before /health is read, or when it carries no list, only the noun. h: /health.
export function listSource(h) {
  h = objOf(h);
  var oc = h && objOf(h.on_chain_validators);
  if (!oc) return "the validator list";
  var why = typeof oc.reason === "string" ? oc.reason.trim() : "";
  if (oc.state === "agreed") return why || "at least two public seeds returned the same validator list";
  var head = oc.state === "pending" ? "no validator list yet" : oc.state === "stale" ? "no current validator list" : "no agreed validator list";
  return why ? head + ": " + why : head;
}
// A field's reason in Explain this reading: the reading's own text, or, when it publishes none, a plain statement that
// it publishes none (the risk line in the words of the status/risk explanation). key: the card's data-card key.
export function fieldReason(key, reason) {
  if (typeof reason === "string" && reason.trim()) return reason;
  return key === "risk" ? "No risk factors are listed in this reading." : "No reason is published for this value in this reading.";
}
// W1-1. The 24 h movement in words that claim only what the rule checks. The API's `normal` means the seeds' median
// rose in the five-minute windows of the last 24 h (any static window makes it `interrupted`); it says nothing about
// rate, so the page says "advancing", in a neutral tone, with the published share. Every other state keeps its own
// word and never reads as advancing. cm: /organism.last_24h.chain_movement. Returns null when there is none to show.
export function movementLine(cm) {
  cm = objOf(cm);
  if (!cm || typeof cm.state !== "string" || !cm.state) return null;
  if (cm.state === "normal") {
    var p = isNum(cm.pct_advancing) ? cm.pct_advancing : null;
    return { word: "advancing", tone: "neutral",
      line: (p === null ? "advancing over 24 h" : p >= 1 ? "rose in every five-minute window over 24 h" : "rose in " + Math.round(p * 100) + " % of five-minute windows over 24 h") + " · no target rate" };
  }
  if (cm.state === "interrupted") return { word: "interrupted", tone: "neutral", line: isNum(cm.longest_static_minutes) ? "longest standstill " + fmt(cm.longest_static_minutes) + " min" : null };
  return { word: cm.state, tone: "unknown", line: null };
}
// W1-5. A digit string grouped as written, never converted to a number (the stake is larger than a double holds
// exactly). Anything that is not a plain digit string comes back unchanged.
export function groupDigits(s) {
  return typeof s === "string" && /^\d+$/.test(s) ? fmt(s) : s;
}
// W1-6. The UNSTAKING row of the validators ladder. The count is null when the agreed list holds no UNSTAKING row (the
// contract never sends 0), so in the agreed state null is an observation about the list, not about validators leaving.
// oc: /health.on_chain_validators; pending: the list read has not completed. Returns { text, dim }.
export function unstakingCell(oc, pending) {
  oc = objOf(oc);
  if (!oc || oc.state !== "agreed") return { text: pending ? "reading" : "not reported", dim: true };
  if (isNum(oc.unstaking)) return { text: fmt(oc.unstaking) + " listed, not dialed", dim: false };
  return { text: "none in this list · not a count of validators leaving", dim: false };
}
