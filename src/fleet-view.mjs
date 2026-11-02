// fleet-view.mjs — the operator's private fleet page (/fleet, /fleet.json), served on the internal listener only.
// Pure functions: no I/O, no imports from agent.mjs. The agent gathers the inputs and serves the output.
// Layer 3: the node names, chains and exporter ports come from the untracked fleet.config.mjs (FLEET_VIEW); nothing
// here is published, and nothing read here flows back into the public reading.

import { keyOf } from "./public-safety.mjs";
import { STATUS_ACTIVE, STATUS_UNSTAKING } from "./validator-watch.mjs";

export const FLEET_VIEW_RULE = Object.freeze({
  behindBlocks: 100,          // a testnet node more than this many blocks below the baseline is "behind"
  baselineMaxAgeMs: 300000,   // the seeds' median must be at most this old when the fleet cycle takes it
  validatorStaleMs: 180000,   // the validator round is stale after 3 min
  machineStaleMs: 300000,     // a machine sample is stale after 5 min
  diskNoticePct: 10,          // disk free at or below this share is a notice (a mark, not a failure)
  cycleStaleMinMs: 300000,    // the fleet cycle is stale after twice its interval, but never sooner than 5 min (a cycle can overrun)
  metricsMaxBytes: 2 * 1024 * 1024,
});
const CHAINS = new Set(["testnet", "fixnet", "down"]);
const PUBLIC_SITE = "https://demos-oracle.com";

// ---- configuration --------------------------------------------------------------------------------------------------
// One entry per configured node. A missing or malformed FLEET_VIEW still serves: chain "unknown", exporter null.
export function readFleetViewConfig(raw, nodeNames) {
  var cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  var names = Array.isArray(nodeNames) ? nodeNames.slice() : Object.keys(cfg);
  return names.map(function(name) {
    var c = cfg[name] && typeof cfg[name] === "object" ? cfg[name] : {};
    var port = Number.isInteger(c.exporter) && c.exporter >= 1 && c.exporter <= 65535 ? c.exporter : null;
    return {
      name: name,
      chain: CHAINS.has(c.chain) ? c.chain : "unknown",
      exporter: port,
      validator: c.validator === true,
      note: typeof c.note === "string" && c.note.length <= 120 ? c.note : null,
    };
  });
}
// The only URL the sampler may fetch for a configured port: loopback, /metrics.
export function exporterUrl(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? "http://127.0.0.1:" + port + "/metrics" : null;
}

// ---- node_exporter text ---------------------------------------------------------------------------------------------
function labelsOf(s) {
  var out = {}, re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g, m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}
// Reads the four facts the page shows from Prometheus text. A fact that is absent is null, never 0.
export function parseNodeMetrics(text) {
  var r = { load1: null, rootAvail: null, rootSize: null, memAvail: null, memTotal: null, cpus: null };
  if (typeof text !== "string") return r;
  var cpus = new Set();
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.charCodeAt(0) === 35) continue; // '#'
    var m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    var name = m[1], labels = m[2] ? labelsOf(m[2]) : {}, v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    if (name === "node_load1" && r.load1 === null) r.load1 = v;
    else if (name === "node_filesystem_avail_bytes" && labels.mountpoint === "/" && r.rootAvail === null) r.rootAvail = v;
    else if (name === "node_filesystem_size_bytes" && labels.mountpoint === "/" && r.rootSize === null) r.rootSize = v;
    else if (name === "node_memory_MemAvailable_bytes" && r.memAvail === null) r.memAvail = v;
    else if (name === "node_memory_MemTotal_bytes" && r.memTotal === null) r.memTotal = v;
    else if (name === "node_cpu_seconds_total" && labels.mode === "idle" && labels.cpu !== undefined) cpus.add(labels.cpu);
  }
  r.cpus = cpus.size > 0 ? cpus.size : null;
  return r;
}

// ---- states ---------------------------------------------------------------------------------------------------------
// tone: ok | warn | bad | neutral | unknown (the site kit's lamp tones).
function st(code, tone, text, extra) { return Object.assign({ code: code, tone: tone, text: text }, extra || {}); }

// probe: one latestFixnetNodes entry, or undefined. baseline: { height, observedAt } snapshotted at the cycle, or null.
export function nodeState(cfg, probe, baseline, cycleAt) {
  if (!probe) return st("incomplete", "unknown", "incomplete · no result this cycle");
  if (probe.ok !== true) {
    if (cfg.chain === "down") return st("down", "neutral", cfg.note || "node configured as down");
    return st("no_answer", "unknown", "no answer this cycle");
  }
  if (probe.identityMatch === false) return st("identity_mismatch", "bad", "identity mismatch · answered with another key");
  var height = Number.isInteger(probe.block) && probe.blockFrom === "self" ? probe.block : null;
  if (cfg.chain === "fixnet") return st("not_compared", "neutral", "answering · not compared", { height: height });
  if (cfg.chain === "down") return st("answering_down", "neutral", "answering · configured as down", { height: height });
  if (cfg.chain !== "testnet") return st("chain_unknown", "neutral", "answering · chain not configured", { height: height });
  if (height === null) return st("incomplete", "unknown", "incomplete · own height not reported", { height: null });
  var okBase = baseline && Number.isInteger(baseline.height) && Number.isFinite(baseline.observedAt)
    && Number.isFinite(cycleAt) && cycleAt - baseline.observedAt <= FLEET_VIEW_RULE.baselineMaxAgeMs && cycleAt >= baseline.observedAt - 60000;
  if (!okBase) return st("comparison_unavailable", "neutral", "comparison unavailable", { height: height });
  var diff = height - baseline.height;
  if (diff < -FLEET_VIEW_RULE.behindBlocks) return st("behind", "warn", "behind by " + (-diff) + " blocks", { height: height, diff: diff });
  return st("no_issue", "ok", "no issue observed", { height: height, diff: diff });
}

// sample: { at, ok, metrics } from the sampler, or undefined.
export function machineState(cfg, sample, now) {
  if (cfg.exporter === null) return st("not_configured", "unknown", "no reading · not configured");
  if (!sample) return st("no_reading", "unknown", "no reading · not sampled yet");
  if (!Number.isFinite(sample.at) || now - sample.at > FLEET_VIEW_RULE.machineStaleMs) return st("stale", "unknown", "no reading · last sample too old");
  if (sample.ok !== true || !sample.metrics) return st("no_reading", "unknown", "no reading · exporter did not answer");
  var m = sample.metrics;
  var disk = Number.isFinite(m.rootAvail) && Number.isFinite(m.rootSize) && m.rootSize > 0 ? { free: m.rootAvail, size: m.rootSize, pct: 100 * m.rootAvail / m.rootSize } : null;
  var mem = Number.isFinite(m.memAvail) && Number.isFinite(m.memTotal) && m.memTotal > 0 ? { free: m.memAvail, total: m.memTotal, pct: 100 * m.memAvail / m.memTotal } : null;
  var load = Number.isFinite(m.load1) ? { load1: m.load1, cpus: Number.isInteger(m.cpus) ? m.cpus : null } : null;
  if (!disk && !mem && !load) return st("no_reading", "unknown", "no reading · series missing");
  var notice = disk && disk.pct <= FLEET_VIEW_RULE.diskNoticePct;
  return st(notice ? "disk_notice" : "reporting", notice ? "warn" : "ok", notice ? "disk free at or below the mark" : "reporting", { disk: disk, mem: mem, load: load, at: sample.at });
}

// The four validator facts for one key from the latest validator round. Every missing input gives null, not "no".
export function validatorFacts(round, identity, now) {
  var key = keyOf(identity);
  var out = { at: null, stale: true, listed: null, status: null, statusCode: null, confirmed: null, rounds: null, countedRounds: null, windowMinutes: null, windowComplete: null, listAgreed: null };
  if (!round || !key) return out;
  out.at = Number.isFinite(round.roundAt) ? round.roundAt : null;
  out.stale = out.at === null || now - out.at > FLEET_VIEW_RULE.validatorStaleMs;
  out.listAgreed = !!(round.list && round.list.agreed);
  if (out.listAgreed && Array.isArray(round.list.rows)) {
    var row = round.list.rows.find(function(r) { return r && r.key === key; });
    // The list gives a status code; the words are the public page's (validator-watch listedStatus): 2 ACTIVE, 3 UNSTAKING.
    out.listed = !!row; out.statusCode = row ? row.status : null;
    out.status = !row ? null : row.status === STATUS_ACTIVE ? "ACTIVE" : row.status === STATUS_UNSTAKING ? "UNSTAKING" : "other";
  }
  if (round.witnessFacts && Array.isArray(round.witnessFacts.rows)) {
    var w = round.witnessFacts.rows.find(function(r) { return r && r.key === key; });
    if (w) { out.confirmed = w.confirmed === true; out.rounds = Number.isInteger(w.rounds) ? w.rounds : null; }
    else if (out.listed === true) { out.confirmed = false; }
  }
  var win = round.everyRound && round.everyRound.window;
  if (win) { out.countedRounds = Number.isInteger(win.counted_rounds) ? win.counted_rounds : null; out.windowMinutes = Number.isInteger(win.minutes) ? win.minutes : null; out.windowComplete = win.complete === true; }
  return out;
}

// ---- the whole view -------------------------------------------------------------------------------------------------
// inputs: { config: [readFleetViewConfig entries], identities: {name: identity}, probes: [latestFixnetNodes],
//   cycleAt, cycleIntervalMs, baseline, samples: {name: sample}, round: latestValidatorRound,
//   wallet: { balance, lowMark }, agentStartedAt }
export function buildFleetView(inputs, now) {
  var i = inputs || {};
  var config = Array.isArray(i.config) ? i.config : [];
  var probes = Array.isArray(i.probes) ? i.probes : [];
  var samples = i.samples && typeof i.samples === "object" ? i.samples : {};
  var cycleAt = Number.isFinite(i.cycleAt) && i.cycleAt > 0 ? i.cycleAt : null;
  var interval = Number.isFinite(i.cycleIntervalMs) && i.cycleIntervalMs > 0 ? i.cycleIntervalMs : 20000;
  var staleAfter = Math.max(2 * interval, FLEET_VIEW_RULE.cycleStaleMinMs);
  var cycleStale = cycleAt === null || now - cycleAt > staleAfter;
  var nodes = config.map(function(c) {
    var probe = probes.find(function(p) { return p && (p.name === c.name || p.name === "fleet-" + c.name); });
    // No fresh fleet cycle: every node row says so, in one grey state, instead of a per-node guess.
    var s = cycleAt === null ? st("not_observed", "unknown", "not observed yet · no fleet cycle since the agent started")
      : cycleStale ? st("stale", "unknown", "stale · fleet cycle too old")
      : nodeState(c, probe, i.baseline || null, cycleAt);
    return {
      name: c.name, chain: c.chain, validator: c.validator, state: s,
      peers: probe && probe.ok === true && Number.isInteger(probe.peers) ? probe.peers : null,
      version: probe && probe.ok === true && typeof probe.version === "string" && probe.version !== "?" ? probe.version : null,
    };
  });
  var machines = config.map(function(c) { return { name: c.name, exporter: c.exporter, state: machineState(c, samples[c.name], now) }; });
  var vNode = config.find(function(c) { return c.validator; });
  var validator = vNode ? Object.assign({ name: vNode.name }, validatorFacts(i.round, (i.identities || {})[vNode.name], now)) : null;
  var reporting = machines.filter(function(m) { return m.state.code === "reporting" || m.state.code === "disk_notice"; }).length;
  var stale = [];
  if (cycleAt !== null && cycleStale) stale.push("fleet cycle");
  if (validator && validator.stale) stale.push("validator reading");
  var attention = [];
  if (cycleAt === null) attention.push("no fleet cycle yet since the agent started");
  else if (!cycleStale) nodes.forEach(function(n) { if (n.state.tone === "warn" || n.state.tone === "bad" || n.state.code === "no_answer" || n.state.code === "incomplete") attention.push(n.name + ": " + n.state.text); });
  machines.forEach(function(m) { if (m.state.tone === "warn") attention.push(m.name + ": " + m.state.text); });
  stale.forEach(function(s) { attention.push(s + " is stale"); });
  var w = i.wallet || {};
  return {
    generatedAt: now,
    cycle: { at: cycleAt, intervalMs: interval, staleAfterMs: staleAfter, stale: cycleStale },
    baseline: i.baseline && Number.isInteger(i.baseline.height) ? { height: i.baseline.height, observedAt: i.baseline.observedAt } : null,
    nodes: nodes,
    validator: validator,
    machines: machines,
    machinesReporting: reporting,
    machinesConfigured: machines.length,
    wallet: { balance: Number.isFinite(w.balance) ? w.balance : null, lowMark: Number.isFinite(w.lowMark) ? w.lowMark : null },
    agentStartedAt: Number.isFinite(i.agentStartedAt) ? i.agentStartedAt : null,
    attention: attention,
  };
}

// ---- HTML -----------------------------------------------------------------------------------------------------------
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function utc(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) + " UTC" : "—"; }
function ago(ms, now) {
  if (!Number.isFinite(ms)) return "never";
  var s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 120 ? s + " s ago" : s < 7200 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago";
}
function span(ms, now) {
  if (!Number.isFinite(ms)) return "—";
  var h = Math.max(0, (now - ms) / 3600000), d = Math.floor(h / 24);
  return (d > 0 ? d + " d " : "") + Math.floor(h % 24) + " h";
}
function dur(ms) { return !Number.isFinite(ms) ? "—" : ms < 120000 ? Math.round(ms / 1000) + " s" : Math.round(ms / 60000) + " min"; }
function n0(v) { return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—"; }
function gb(b) { return Number.isFinite(b) ? (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + " GB" : "—"; }
function lamp(tone, text) { return '<span class="lampt"><span class="ind" data-tone="' + esc(tone) + '"></span>' + esc(text) + '</span>'; }
function cell(label, html, cls) { return '<td data-label="' + esc(label) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + html + '</td>'; }

const PAGE_CSS = ".pv-band{background:#140f02;border-bottom:1px solid #5A4A1A;color:var(--metal-1);font-size:.8125rem}.pv-band .wrap{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;padding-block:9px}.pv-band b{font:600 .75rem/1.4 var(--mono);letter-spacing:.14em;color:var(--elevated-risk)}"
  + ".fv-body{padding-block:32px 72px}.fv-sec + .fv-sec{margin-top:48px;padding-top:32px;border-top:1px solid var(--line)}.fv-sec h2{font-size:1.375rem;font-weight:500;color:var(--metal-2);margin-bottom:8px}.fv-note{color:var(--metal-1);max-width:46rem;margin-bottom:6px}.fv-meta{font:400 .8125rem/1.5 var(--mono);color:var(--mute);margin:8px 0 0;max-width:46rem}"
  + ".fv-now{display:flex;gap:12px;align-items:baseline;font-size:1.25rem;color:var(--metal-2);margin-bottom:18px}.fv-now b{font-weight:500;color:var(--ink)}.fv-now>span{line-height:1.5}"
  + ".fv-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line)}.fv-facts>div{padding:12px 16px 12px 0;border-bottom:1px solid var(--line)}.fv-facts dt{color:var(--mute);font-size:.8125rem;margin-bottom:4px}.fv-facts dd{font:400 .875rem/1.5 var(--mono);color:var(--ink);margin:0}"
  + ".fv-tbl td{font-family:var(--mono);font-size:.875rem}.fv-tbl .nm{font-family:var(--sans);color:var(--ink)}.fv-tbl .id{display:block;color:var(--mute);font-size:.75rem;margin-top:2px}.lampt{display:inline-flex;align-items:baseline;gap:8px;white-space:nowrap}"
  + ".fv-kv{display:grid;grid-template-columns:14rem minmax(0,1fr);border-top:1px solid var(--line);max-width:52rem}.fv-kv>div{display:contents}.fv-kv dt,.fv-kv dd{padding:11px 0;border-bottom:1px solid var(--line);margin:0}.fv-kv dt{color:var(--mute);font-size:.875rem;padding-right:16px}.fv-kv dd{color:var(--ink);font-family:var(--mono);font-size:.875rem}.fv-words dd{font-family:var(--sans);color:var(--metal-1);font-size:.9375rem}"
  + ".pv-chip{margin-left:auto;font:600 .6875rem/1 var(--mono);letter-spacing:.14em;color:var(--elevated-risk);border:1px solid #5A4A1A;border-radius:999px;padding:8px 12px;white-space:nowrap}.pv-foot{border-top:1px solid var(--line);padding-block:24px 40px;color:var(--mute);font-size:.8125rem}"
  + "@media (max-width:899px){.fv-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}"
  + "@media (max-width:719px){.fv-tbl.stack td,.fv-tbl.stack td.num{text-align:left}.fv-tbl.stack td::before{text-align:left;font-family:var(--sans)}.fv-tbl.stack td .lampt{white-space:normal}.fv-kv{grid-template-columns:minmax(0,1fr)}.fv-kv dt{border-bottom:0;padding-bottom:0}.fv-kv dd{padding-top:2px}.fv-facts{grid-template-columns:minmax(0,1fr)}.fv-now{font-size:1.0625rem}}";

// kit: { head: '<meta …> <link stylesheet …>' (siteHead(null): no share tags, no canonical), markPath }
export function renderFleetPage(view, kit, now) {
  var k = kit || {};
  var v = view;
  var cycleStale = v.cycle.stale;
  var nodeRows = v.nodes.map(function(n) {
    var s = n.state;
    var sub = n.chain === "testnet" ? "testnet" + (n.validator ? " · staked validator" : "") : n.chain === "unknown" ? "chain not configured" : n.chain;
    var diff = Number.isInteger(s.diff) ? (s.diff > 0 ? "+" + n0(s.diff) : n0(s.diff)) : "—";
    return "<tr>" + cell("Node", '<span class="nm">' + esc(n.name) + '</span><span class="id">' + esc(sub) + '</span>')
      + cell("State", lamp(s.tone, s.text))
      + cell("Height", Number.isInteger(s.height) ? n0(s.height) : "—", "num")
      + cell("To seeds' median (same cycle)", diff, "num")
      + cell("Peers", Number.isInteger(n.peers) ? String(n.peers) : "—", "num")
      + cell("Version", n.version ? esc(n.version) : "—", "mono") + "</tr>";
  }).join("");
  var machineRows = v.machines.map(function(m) {
    var s = m.state, d = s.disk, me = s.mem, l = s.load;
    var via = m.exporter === null ? "not configured" : "loopback :" + m.exporter;
    var diskHtml = d ? (s.code === "disk_notice" ? lamp("warn", gb(d.free) + " · " + Math.round(d.pct) + "%") : esc(gb(d.free) + " · " + Math.round(d.pct) + "%")) : "—";
    return "<tr>" + cell("Machine", '<span class="nm">' + esc(m.name) + '</span>')
      + cell("Read via", esc(via))
      + cell("Disk free (/ of its size)", diskHtml, "num")
      + cell("Memory available", me ? esc(gb(me.free) + " · " + Math.round(me.pct) + "%") : "—", "num")
      + cell("Load, 1 min / cores", l ? esc(l.load1.toFixed(1) + " / " + (l.cpus === null ? "?" : l.cpus)) : "—", "num")
      + cell("Exporter", s.code === "reporting" || s.code === "disk_notice" ? esc("up · " + ago(s.at, now)) : lamp(s.tone, s.text)) + "</tr>";
  }).join("");
  var val = v.validator;
  var valHtml = "";
  if (val) {
    var vt = val.stale ? "unknown" : null;
    var listedText = val.listAgreed === false ? "list not agreed this round" : val.listed === null ? "unavailable" : val.listed ? (val.status === "other" ? "other status (code " + val.statusCode + ")" : val.status) : "not on the agreed list";
    var listedTone = vt || (val.listed && val.status === "ACTIVE" ? "ok" : val.listed === false ? "warn" : "unknown");
    // Not confirmed this round covers not dialed, no answer and off the seeds' height alike: shown as such, not as "no".
    var confText = val.confirmed === null ? "unavailable this round" : val.confirmed ? "yes, this round" : "not confirmed this round";
    var confTone = vt || (val.confirmed === null ? "unknown" : val.confirmed ? "ok" : "neutral");
    // Until the window is complete (e.g. just after a restart) the count is shown as filling, in grey, never as a shortfall.
    var hasRounds = Number.isInteger(val.rounds) && Number.isInteger(val.countedRounds);
    var roundsText = !hasRounds ? "unavailable" : val.rounds + " of " + val.countedRounds + " counted rounds" + (val.windowMinutes ? " · last " + val.windowMinutes + " min" : "") + (val.windowComplete ? "" : " · window still filling");
    var roundsTone = vt || (!hasRounds || !val.windowComplete || val.countedRounds === 0 ? "unknown" : val.rounds === val.countedRounds ? "ok" : "warn");
    valHtml = '<section class="fv-sec" id="validator" aria-labelledby="val-h"><h2 id="val-h">The validator · ' + esc(val.name) + '</h2>'
      + '<p class="fv-note">The facts the public reading shows for every listed validator, looked up here for our own key, from this agent\'s vantage only. ACTIVE is the list\'s state, not proof that the node signs blocks; the round count counts answers to DNO\'s probe at the seeds\' height, not signing. Round at ' + esc(utc(val.at)) + (val.stale ? " · <b>stale</b>" : "") + '.</p>'
      + '<dl class="fv-kv"><div><dt>On the agreed list</dt><dd>' + lamp(listedTone, listedText) + '</dd></div>'
      + '<div><dt>Answered as its key, at the seeds\' height</dt><dd>' + lamp(confTone, confText) + '</dd></div>'
      + '<div><dt>Rounds in the window</dt><dd>' + lamp(roundsTone, roundsText) + '</dd></div></dl></section>';
  }
  var att = v.attention.length ? "<b>Attention: " + esc(v.attention.join(" · ")) + "</b>" : "<b>Nothing needs attention in the latest readings.</b>";
  var testnet = v.nodes.filter(function(n) { return n.chain === "testnet"; });
  var fixnet = v.nodes.filter(function(n) { return n.chain === "fixnet"; });
  var fixAns = fixnet.filter(function(n) { return n.state.code === "not_compared"; }).length;
  var line2 = v.cycle.at === null ? "Nodes: not observed yet · machines reporting: " + v.machinesReporting + " of " + v.machinesConfigured
    : cycleStale ? "Nodes: stale · last fleet cycle " + utc(v.cycle.at) + " · machines reporting: " + v.machinesReporting + " of " + v.machinesConfigured
    : "Testnet: " + testnet.map(function(n) { return n.name + " " + n.state.text; }).join(", ") + (testnet.length ? "" : "none configured")
    + " · fixnet: " + fixAns + " of " + fixnet.length + " answering, not compared"
    + " · machines reporting: " + v.machinesReporting + " of " + v.machinesConfigured;
  var topTone = v.attention.length ? "warn" : "ok";
  var w = v.wallet;
  var walletText = w.balance === null ? "unavailable" : n0(w.balance) + " DEM" + (w.lowMark !== null ? (w.balance <= w.lowMark ? " · at or below the low mark (" + n0(w.lowMark) + ")" : " · above the low mark (" + n0(w.lowMark) + ")") : "");
  var nav = '<nav class="nav" aria-label="Primary"><a href="#nodes">Nodes</a>' + (val ? '<a href="#validator">Validator</a>' : '') + '<a href="#machines">Machines</a><a href="' + PUBLIC_SITE + '/">Public reading ↗</a></nav>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fleet · private · DNO</title>'
    + (k.head || '') + '<meta name="robots" content="noindex, nofollow, noarchive"><style>' + PAGE_CSS + '</style></head><body>'
    + '<a class="skip" href="#main">Skip to content</a>'
    + '<div class="pv-band" role="region" aria-label="Private page notice"><div class="wrap"><b>PRIVATE · fleet</b><span>Operator page on the agent\'s internal listener. Not part of the public reading. Never linked from it.</span></div></div>'
    + '<header class="site-head"><div class="wrap"><a class="brand" href="' + PUBLIC_SITE + '/" aria-label="Demos Network Oracle, public reading">'
    + (k.markPath ? '<img class="mark mark--nav" src="' + esc(k.markPath) + '" width="92" height="92" alt="" decoding="async">' : '')
    + '<span class="brand-name"><b>DNO</b><small>Demos Network Oracle</small></span></a>' + nav + '<span class="pv-chip">PRIVATE</span></div></header>'
    + '<main id="main"><header class="doc-head"><div class="wrap"><div><p class="doc-kicker">Fleet · private</p><h1>Fleet</h1><p class="doc-lede">The operator\'s own nodes and machines, as this agent saw them. It reads the public reading for context; nothing on this page flows back into it.</p></div></div></header>'
    + '<div class="wrap fv-body">'
    + '<section class="fv-sec" id="now" aria-labelledby="now-h"><h2 id="now-h" class="sr">The fleet now</h2>'
    + '<p class="fv-now"><span class="ind" data-tone="' + topTone + '"></span><span>' + att + '<br>' + esc(line2) + '</span></p>'
    + '<dl class="fv-facts">'
    + '<div><dt>Fleet cycle</dt><dd>' + (v.cycle.at === null ? esc("none since the agent started · every " + dur(v.cycle.intervalMs))
      : esc(utc(v.cycle.at) + " · " + ago(v.cycle.at, now) + " · every " + dur(v.cycle.intervalMs) + " · stale after " + dur(v.cycle.staleAfterMs)) + (cycleStale ? " · <b>stale</b>" : "")) + '</dd></div>'
    + '<div><dt>Seeds\' median at that cycle</dt><dd>' + (v.baseline ? esc(n0(v.baseline.height) + " · " + utc(v.baseline.observedAt)) : "unavailable") + '</dd></div>'
    + '<div><dt>Agent wallet</dt><dd>' + esc(walletText) + '</dd></div>'
    + '<div><dt>Agent</dt><dd>' + esc(v.agentStartedAt ? "up since " + new Date(v.agentStartedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC · " + span(v.agentStartedAt, now) : "—") + '</dd></div>'
    + '</dl></section>'
    + '<section class="fv-sec" id="nodes" aria-labelledby="nodes-h"><h2 id="nodes-h">Nodes</h2>'
    + '<p class="fv-note">' + (v.cycle.at === null ? "No fleet cycle yet since the agent started. Each cycle makes" : "From the fleet cycle at " + esc(utc(v.cycle.at)) + ":") + ' one direct read of each node. Testnet nodes are compared with the public seeds\' median recorded <em>in that same cycle</em>; fixnet nodes run a separate, inert chain and are shown answering or not, never compared. A later public reading never changes these rows.</p>'
    + '<div class="tbl-wrap"><table class="tbl stack fv-tbl"><thead><tr><th scope="col">Node</th><th scope="col">State</th><th scope="col" class="num">Height</th><th scope="col" class="num">To seeds\' median (same cycle)</th><th scope="col" class="num">Peers</th><th scope="col">Version</th></tr></thead><tbody>'
    + nodeRows + '</tbody></table></div></section>'
    + valHtml
    + '<section class="fv-sec" id="machines" aria-labelledby="mach-h"><h2 id="mach-h">Machines</h2>'
    + '<p class="fv-note">One machine per node, read from its node exporter on the loopback port configured for it, sampled every 60 s on its own clock: <b>' + v.machinesReporting + ' of ' + v.machinesConfigured + ' reporting</b>. A machine with no answer, or a sample older than 5 minutes, shows "no reading", never its last value.</p>'
    + '<div class="tbl-wrap"><table class="tbl stack fv-tbl"><thead><tr><th scope="col">Machine</th><th scope="col">Read via</th><th scope="col" class="num">Disk free (/ of its size)</th><th scope="col" class="num">Memory available</th><th scope="col" class="num">Load, 1 min / cores</th><th scope="col">Exporter</th></tr></thead><tbody>'
    + machineRows + '</tbody></table></div>'
    + '<p class="fv-meta">Amber on disk free at ' + FLEET_VIEW_RULE.diskNoticePct + '% or less: a notice at a mark you set, not a machine failure. Load is the 1-minute load average beside the number of logical CPUs, not a CPU percentage.</p></section>'
    + '<section class="fv-sec" id="words" aria-labelledby="words-h"><h2 id="words-h">Words on this page</h2><dl class="fv-kv fv-words">'
    + '<div><dt>No issue observed</dt><dd>A testnet node answered this cycle as its own key, reported its own height, and is not more than ' + FLEET_VIEW_RULE.behindBlocks + ' blocks below the seeds\' median recorded in the same cycle.</dd></div>'
    + '<div><dt>Incomplete</dt><dd>Something the rule needs was missing this cycle: no result for the node, or no height of its own. Absence of a failure is not shown as "no issue".</dd></div>'
    + '<div><dt>Comparison unavailable</dt><dd>The seeds\' median for that cycle is missing, older than 5 minutes, or from fewer than two seeds. No height difference is shown, never a 0.</dd></div>'
    + '<div><dt>Answering · not compared</dt><dd>A fixnet node answered the fleet cycle. The fixnet is a separate, inert chain, so its height is not compared with the testnet.</dd></div>'
    + '<div><dt>Stale</dt><dd>Each source has its own clock: the fleet cycle (stale after twice its interval, and never sooner than 5 min), the validator reading (after 3 min) and each machine sample (after 5 min). A stale source turns only its own lamps grey; the top line names it.</dd></div>'
    + '</dl></section></div></main>'
    + '<footer class="pv-foot"><div class="wrap">Private operator page · served on 127.0.0.1 only · Cache-Control: no-store · no public page links here. Generated ' + esc(utc(now)) + '.</div></footer>'
    + '</body></html>';
}
