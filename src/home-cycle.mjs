// home-cycle.mjs — the This cycle card's lines, one source: the agent's page for readers without JavaScript and the
// page's script (inlined at build) both use this file; home-cycle.test.mjs has the cases. No imports.

var NUM_WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
var isNum = function(v) { return typeof v === "number" && Number.isFinite(v); };
var fmt = function(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };

// The count the lead prints (on_chain_validators while agreed), or null. Line 2 names the same count or none.
export function leadCount(oc) {
  return oc && oc.state === "agreed" && isNum(oc.active) && isNum(oc.seeds_agreed) ? oc.active : null;
}
// The ACTIVE count as the agreeing seeds list it, or why there is none this cycle.
export function cycleLead(oc) {
  if (!oc || oc.state === "pending") return "ACTIVE on chain: reading.";
  if (leadCount(oc) !== null) return fmt(oc.active) + " ACTIVE on chain as " + (NUM_WORD[oc.seeds_agreed] || fmt(oc.seeds_agreed)) + " public seeds list them.";
  return "ACTIVE on chain: not reported this cycle" + (typeof oc.reason === "string" && oc.reason ? " (" + oc.reason + ")" : "") + ".";
}

// The second line, in parts. r is one observation: { publicNodes (the configured seeds, each with ok), agreement (the
// object /health publishes, or /organism's string), data_quality_reason, staleness_seconds, height_static_seconds,
// active_incidents }. active: leadCount() of the same /health, or null.
export function seedsParts(r, active) {
  r = r || {};
  var ag = r.agreement && typeof r.agreement === "object" ? r.agreement : { state: r.agreement };
  var st = typeof ag.state === "string" ? ag.state.toLowerCase() : null;
  var compared = st === "strong" || st === "moderate" || st === "weak";
  var nodes = Array.isArray(r.publicNodes) && r.publicNodes.length ? r.publicNodes : null;
  var k = nodes ? nodes.filter(function(n) { return n && n.ok === true; }).length : null;
  var m = isNum(ag.total_nodes) ? ag.total_nodes : null;          // seeds that gave their own height
  var dq = typeof r.data_quality_reason === "string" ? r.data_quality_reason : null;
  var own = function(x) { return x === 0 ? "none gave its own height" : x === 1 ? "1 gave its own height" : x + " gave their own height"; };
  var fewer = nodes && m !== null && m < k && (compared || dq === "too_few_heights");
  var p = { answered: null, heights: null, stall: null, incidents: null, status: null };
  if (dq === "no_observation") p.answered = "No observation of the configured seeds has completed yet.";
  else if (dq === "stale") {
    p.answered = "The last observation of the configured seeds is " + (isNum(r.staleness_seconds) ? Math.floor(r.staleness_seconds / 60) + " min old." : "more than 5 min old.");
    p.heights = "Heights were not compared.";
  } else {
    if (nodes) p.answered = k + " of " + nodes.length + " configured seeds answered" + (fewer ? "; " + own(m) : "") + ".";
    else if (compared && m !== null) p.answered = m + " configured seeds gave their own height.";
    else if (dq === "too_few_answers") p.answered = "Fewer than two configured seeds answered.";
    else if (dq === "too_few_heights") p.answered = "Fewer than two configured seeds gave their own height.";
    else p.answered = "Seeds: not reported in this reading.";
    if (!compared) p.heights = "Heights were not compared.";
    else {
      var subject = fewer ? "Those heights" : nodes || m !== null ? "Their heights" : "The seeds' heights";
      if (st === "strong") p.heights = subject + " align.";
      else if (isNum(ag.block_spread)) {
        p.heights = subject + " differ by " + (m === 2 ? "" : "up to ") + fmt(ag.block_spread) + " blocks"
          + (m !== null && m >= 3 && isNum(ag.aligned_nodes) && ag.aligned_nodes < m ? "; " + ag.aligned_nodes + " of " + m + (ag.aligned_nodes === 1 ? " is" : " are") + " within 25 blocks of the median" : "") + ".";
      } else p.heights = "Height agreement is " + st + ".";
    }
  }
  // A stale observation's figures are as old as the observation: the height is not said to be still.
  if (dq !== "stale" && isNum(r.height_static_seconds) && r.height_static_seconds >= 300) p.stall = "The height has not moved for " + Math.floor(r.height_static_seconds / 60) + " min.";
  if (isNum(r.active_incidents) && r.active_incidents > 0) p.incidents = r.active_incidents + " active public incident" + (r.active_incidents === 1 ? "" : "s") + ".";
  p.status = "Status is those seeds" + (isNum(active) ? ", not the " + fmt(active) : "") + ".";
  return p;
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

// The peer-listed count for the door line, or null when it is not known.
export function cycleDoor(discovered) {
  return isNum(discovered) ? fmt(discovered) + " peer-listed" : null;
}
