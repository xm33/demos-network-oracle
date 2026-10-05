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
