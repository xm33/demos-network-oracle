#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────
// DNO Commerce Probe Runner v0.1.0
// Layer 2 — Commerce Intelligence
// 
// Probes attestation authority endpoints and writes results
// to data/commerce-last-check.json. Separate service from
// the Oracle's network monitoring (node-health-agent).
//
// NEVER modifies /organism, /health, or Layer 1 canonical state.
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';

const VERSION = '0.1.0';
const CYCLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const JITTER_MS = 30 * 1000; // ±30 seconds
const PROBE_TIMEOUT_MS = 5000; // 5 seconds per probe
const CYCLE_BUDGET_MS = 60 * 1000; // 60 seconds total
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const RATE_LIMIT_FAILURE_THRESHOLD = 5;

// ─── Paths ───────────────────────────────────────────────────

const BASE_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_DIR = join(BASE_DIR, '..');
const REGISTRY_PATH = join(PROJECT_DIR, 'data', 'commerce-registry.json');
const OUTPUT_PATH = join(PROJECT_DIR, 'data', 'commerce-last-check.json');

// ─── State ───────────────────────────────────────────────────

let registry = null;
let previousResults = new Map(); // authority_id → { consecutive_failures, last_healthy_at, probe_count }
let incidents = [];
let cycleCount = 0;

// ─── Registry ────────────────────────────────────────────────

function loadRegistry() {
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf-8');
    registry = JSON.parse(raw);
    console.log(`[commerce-probes] Registry loaded: v${registry.registry_version}, ${registry.authorities.length} authorities`);
    return true;
  } catch (err) {
    console.error(`[commerce-probes] FATAL: Cannot load registry at ${REGISTRY_PATH}: ${err.message}`);
    return false;
  }
}

// ─── Probe Definitions ──────────────────────────────────────

const PROBE_CONFIG = {
  gleif: {
    probe_class: 'http_open',
    url: 'https://api.gleif.org/api/v1/lei-records?page[size]=1',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 5 * 60 * 1000,
    validate: (body) => body && typeof body === 'object' && Array.isArray(body.data),
    validate_desc: 'response contains data array',
  },
  ecb_frankfurter: {
    probe_class: 'http_open',
    url: 'https://api.frankfurter.dev/v1/latest',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 5 * 60 * 1000,
    validate: (body) => body && typeof body === 'object' && body.rates && typeof body.rates === 'object',
    validate_desc: 'response contains rates object',
  },
  fedramp: {
    probe_class: 'http_open',
    url: 'https://marketplace.fedramp.gov/api/v2/products?limit=1',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 5 * 60 * 1000,
    accept_4xx: true,
    validate: (body) => true,
    validate_desc: 'endpoint responded',
  },
  finra: {
    probe_class: 'api_key_optional',
    url: 'https://api.brokercheck.finra.org/search/genericsearch/grid?query=test&hl=true&nrows=1&r=25',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 10 * 60 * 1000, // conservative
    accept_4xx: true,
    validate: (body) => true,
    validate_desc: 'endpoint responded',
  },
  dns_txt: {
    probe_class: 'http_open',
    url: 'https://cloudflare-dns.com/dns-query?name=demos.sh&type=A',
    method: 'GET',
    headers: { 'Accept': 'application/dns-json' },
    schedule_ms: 5 * 60 * 1000,
    validate: (body) => body && typeof body === 'object' && body.Status !== undefined,
    validate_desc: 'DNS response contains Status field',
  },
  twitter_x: {
    probe_class: 'http_open',
    url: 'https://publish.twitter.com/oembed?url=https://twitter.com/demos_network',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 10 * 60 * 1000,
    // 200 = handle exists. 404 = handle not found but endpoint is reachable.
    accept_404: true,
    validate: (body) => true, // any response is fine
    validate_desc: 'endpoint responded',
  },
  ethos: {
    probe_class: 'http_open',
    url: 'https://api.ethos.network/api/v1/score',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 5 * 60 * 1000,
    // may return 400 or empty without an address — that's still reachable
    accept_4xx: true,
    validate: (body) => true,
    validate_desc: 'endpoint responded',
  },
  world_id: {
    probe_class: 'http_expected_error',
    url: 'https://developer.worldcoin.org/api/v2/verify',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({}),
    schedule_ms: 10 * 60 * 1000,
    expected_error_codes: [400, 401, 403, 404, 422],
    validate: (body) => true,
    validate_desc: 'endpoint reachable (expected error)',
  },
  erc_8004: {
    probe_class: 'rpc_read',
    env_required: 'BASE_SEPOLIA_RPC',
    schedule_ms: 10 * 60 * 1000,
    // Contract: 0x8004bd8daB57f14Ed299135749a5CB5c42d341BF on Base Sepolia
    // We call a simple view function to verify the contract is reachable
    rpc_call: {
      method: 'eth_call',
      params: [{
        to: '0x8004bd8daB57f14Ed299135749a5CB5c42d341BF',
        // getReputation(uint256) with tokenId=1 — selector 0x0981e592 (may vary)
        // Fallback: just check the contract has code
        data: '0x0000000000000000000000000000000000000000' // will be replaced with eth_getCode
      }, 'latest'],
    },
    validate: (body) => true,
    validate_desc: 'RPC responded',
  },
  gitcoin_passport: {
    probe_class: 'api_key_required',
    env_required: 'GITCOIN_PASSPORT_API_KEY',
    env_required_2: 'GITCOIN_PASSPORT_SCORER_ID',
    url: 'https://api.scorer.gitcoin.co/registry/v2/score',
    method: 'GET',
    schedule_ms: 10 * 60 * 1000,
    accept_4xx: true,
    validate: (body) => true,
    validate_desc: 'endpoint responded with key',
  },
  sam_gov: {
    probe_class: 'api_key_required',
    env_required: 'SAM_GOV_API_KEY',
    url: 'https://api.sam.gov/entity-information/v3/entities?api_key={KEY}&samRegistered=Yes&page=0&size=1',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    schedule_ms: 10 * 60 * 1000,
    validate: (body) => body !== null,
    validate_desc: 'endpoint responded with key',
  },
};

// ─── Non-probeable authorities ───────────────────────────────

const NON_PROBEABLE = [
  { authority_id: 'ofac_sdn', name: 'OFAC SDN', path_type: 'PUBLIC_API', probe_class: 'on_chain_future', observation_state: 'observation_pending', reason: 'Requires Demos StorageProgram indexing to observe attestation txs', deferred_to: 'v0.2.0' },
  { authority_id: 'on_chain_disputes', name: 'On-chain dispute count', path_type: 'PUBLIC_API', probe_class: 'on_chain_future', observation_state: 'observation_pending', reason: 'Requires StorageProgram indexing', deferred_to: 'v0.2.0' },
  { authority_id: 'cyberab_sprs', name: 'CyberAB / SPRS', path_type: 'CLOSED_DATA', probe_class: 'closed_data_future', observation_state: 'unsupported', reason: 'Vendor-side TLSN session. Not observable by Oracle.', deferred_to: 'unplanned' },
  { authority_id: 'ddtc', name: 'DDTC', path_type: 'CLOSED_DATA', probe_class: 'closed_data_future', observation_state: 'unsupported', reason: 'Vendor-side TLSN session. Not observable by Oracle.', deferred_to: 'unplanned' },
  { authority_id: 'isda', name: 'ISDA', path_type: 'BILATERAL', probe_class: 'bilateral_future', observation_state: 'observation_pending', reason: 'Requires reading both parties\' Storage Programs', deferred_to: 'v0.2.0' },
  { authority_id: 'agency_whitelist', name: 'Agency-internal whitelist', path_type: 'BILATERAL', probe_class: 'bilateral_future', observation_state: 'observation_pending', reason: 'Requires reading both parties\' Storage Programs', deferred_to: 'v0.2.0' },
];

// ─── Probe Execution ─────────────────────────────────────────

function getAuthorityName(id) {
  if (!registry) return id;
  const auth = registry.authorities.find(a => a.authority_id === id);
  return auth ? auth.name : id;
}

function getAuthorityPathType(id) {
  if (!registry) return 'PUBLIC_API';
  const auth = registry.authorities.find(a => a.authority_id === id);
  return auth ? (auth.path_type === 'public_api' ? 'PUBLIC_API' : auth.path_type.toUpperCase()) : 'PUBLIC_API';
}

function getFreshnessBudget(id) {
  if (!registry) return null;
  const auth = registry.authorities.find(a => a.authority_id === id);
  return auth ? auth.freshness_budget || null : null;
}

function classifyLatency(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 500) return 'fast';
  if (ms < 2000) return 'normal';
  if (ms < 5000) return 'slow';
  return 'timeout';
}

function evaluateFreshness(authorityId, observedAt) {
  const budget = getFreshnessBudget(authorityId);
  if (!budget) return 'not_applicable';
  if (!observedAt) return 'unknown';
  // Parse budget like "24h", "7d", "30d", "90d", "6h"
  const match = budget.match(/^(\d+)([hd])$/);
  if (!match) return 'not_applicable';
  const value = parseInt(match[1]);
  const unit = match[2];
  const budgetMs = unit === 'h' ? value * 3600000 : value * 86400000;
  const age = Date.now() - new Date(observedAt).getTime();
  return age <= budgetMs ? 'fresh' : 'stale';
}

async function executeHttpProbe(authorityId, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  const start = Date.now();
  try {
    const fetchOpts = {
      method: config.method || 'GET',
      headers: config.headers || {},
      signal: controller.signal,
    };
    if (config.body) fetchOpts.body = config.body;

    const response = await fetch(config.url, fetchOpts);
    const latency = Date.now() - start;
    clearTimeout(timeout);

    // Handle rate limiting
    if (response.status === 429) {
      return {
        reachability: 'degraded',
        reachability_reason: `HTTP 429 — rate limited by ${getAuthorityName(authorityId)}`,
        error_class: 'http_429_rate_limited',
        latency_ms: latency,
      };
    }

    // Handle expected errors (World ID, Ethos without params)
    if (config.probe_class === 'http_expected_error') {
      if (config.expected_error_codes.includes(response.status) || response.status === 200) {
        return {
          reachability: 'healthy',
          reachability_reason: `HTTP ${response.status} — endpoint reachable${response.status !== 200 ? ' (expected error for probe without valid input)' : ''}`,
          error_class: response.status !== 200 ? 'http_4xx_expected' : null,
          latency_ms: latency,
        };
      }
    }

    // Handle 4xx
    if (response.status >= 400 && response.status < 500) {
      if (config.accept_404 && response.status === 404) {
        return {
          reachability: 'healthy',
          reachability_reason: `HTTP 404 — endpoint reachable (resource not found is expected)`,
          error_class: 'http_4xx_expected',
          latency_ms: latency,
        };
      }
      if (config.accept_4xx) {
        return {
          reachability: 'healthy',
          reachability_reason: `HTTP ${response.status} — endpoint reachable`,
          error_class: 'http_4xx_expected',
          latency_ms: latency,
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          reachability: 'unavailable',
          reachability_reason: `HTTP ${response.status} — authentication/authorization failure`,
          error_class: 'api_key_invalid',
          latency_ms: latency,
        };
      }
      return {
        reachability: 'degraded',
        reachability_reason: `HTTP ${response.status} — unexpected client error`,
        error_class: 'http_4xx_unexpected',
        latency_ms: latency,
      };
    }

    // Handle 5xx
    if (response.status >= 500) {
      return {
        reachability: 'unavailable',
        reachability_reason: `HTTP ${response.status} — server error`,
        error_class: 'http_5xx',
        latency_ms: latency,
      };
    }

    // Success — validate body
    if (response.status >= 200 && response.status < 300) {
      let body = null;
      try {
        const text = await response.text();
        body = JSON.parse(text);
      } catch {
        // Non-JSON response — still reachable
      }

      if (config.validate && body !== null && !config.validate(body)) {
        return {
          reachability: 'degraded',
          reachability_reason: `HTTP ${response.status} but body validation failed — expected: ${config.validate_desc}`,
          error_class: 'malformed_response',
          latency_ms: latency,
        };
      }

      return {
        reachability: 'healthy',
        reachability_reason: `HTTP ${response.status}, ${config.validate_desc}`,
        error_class: null,
        latency_ms: latency,
      };
    }

    // Unexpected status
    return {
      reachability: 'degraded',
      reachability_reason: `Unexpected HTTP ${response.status}`,
      error_class: 'http_4xx_unexpected',
      latency_ms: latency,
    };

  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - start;

    if (err.name === 'AbortError') {
      return { reachability: 'unavailable', reachability_reason: 'Probe timed out (> 5s)', error_class: 'timeout', latency_ms: latency };
    }
    if (err.code === 'ENOTFOUND' || err.message?.includes('getaddrinfo')) {
      return { reachability: 'unavailable', reachability_reason: 'DNS resolution failed', error_class: 'dns_error', latency_ms: latency };
    }
    if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.message?.includes('TLS') || err.message?.includes('certificate')) {
      return { reachability: 'unavailable', reachability_reason: 'TLS handshake failed', error_class: 'tls_error', latency_ms: latency };
    }

    return { reachability: 'unavailable', reachability_reason: `Network error: ${err.code || err.message || 'unknown'}`, error_class: 'unknown_error', latency_ms: latency };
  }
}

async function executeRpcProbe(authorityId, config) {
  const rpcUrl = process.env[config.env_required];
  if (!rpcUrl) {
    return {
      reachability: 'unsupported',
      reachability_reason: `RPC not configured (${config.env_required})`,
      error_class: 'api_key_missing',
      latency_ms: null,
      configured: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();

  try {
    // Use eth_getCode to check if the contract exists — simpler than calling a function
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: ['0x8004bd8daB57f14Ed299135749a5CB5c42d341BF', 'latest'],
      }),
      signal: controller.signal,
    });

    const latency = Date.now() - start;
    clearTimeout(timeout);

    const body = await response.json();

    if (body.error) {
      return { reachability: 'degraded', reachability_reason: `RPC error: ${body.error.message || 'unknown'}`, error_class: 'rpc_contract_error', latency_ms: latency };
    }

    if (body.result && body.result !== '0x' && body.result.length > 2) {
      return { reachability: 'healthy', reachability_reason: 'RPC responded, contract has code on Base Sepolia', error_class: null, latency_ms: latency };
    }

    return { reachability: 'degraded', reachability_reason: 'Contract has no code at this address', error_class: 'rpc_contract_error', latency_ms: latency };

  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - start;
    if (err.name === 'AbortError') {
      return { reachability: 'unavailable', reachability_reason: 'RPC timed out (> 5s)', error_class: 'rpc_unavailable', latency_ms: latency };
    }
    return { reachability: 'unavailable', reachability_reason: `RPC connection failed: ${err.code || err.message || 'unknown'}`, error_class: 'rpc_unavailable', latency_ms: latency };
  }
}

async function probeAuthority(authorityId) {
  const config = PROBE_CONFIG[authorityId];
  if (!config) return null;

  // Check if key-dependent probe is configured
  if (config.probe_class === 'api_key_required') {
    const key = process.env[config.env_required];
    if (!key) {
      return {
        reachability: 'unsupported',
        reachability_reason: `API key not configured (${config.env_required})`,
        error_class: 'api_key_missing',
        latency_ms: null,
        configured: false,
      };
    }
    // Key exists — substitute into URL if needed
    if (config.url?.includes('{KEY}')) {
      config._resolvedUrl = config.url.replace('{KEY}', key);
    }
  }

  // RPC probe
  if (config.probe_class === 'rpc_read') {
    return executeRpcProbe(authorityId, config);
  }

  // HTTP probe (all other classes)
  const url = config._resolvedUrl || config.url;
  return executeHttpProbe(authorityId, { ...config, url });
}

// ─── Results Assembly ────────────────────────────────────────

function assembleAuthorityResult(authorityId, probeResult) {
  const prev = previousResults.get(authorityId) || { consecutive_failures: 0, last_healthy_at: null, probe_count: 0 };
  const now = new Date().toISOString();

  const isHealthy = probeResult.reachability === 'healthy';
  const isUnsupported = probeResult.reachability === 'unsupported';
  const configured = probeResult.configured !== false;

  const consecutive_failures = isHealthy ? 0 : (isUnsupported ? prev.consecutive_failures : prev.consecutive_failures + 1);
  const last_healthy_at = isHealthy ? now : prev.last_healthy_at;
  const probe_count = isUnsupported ? prev.probe_count : prev.probe_count + 1;

  // Update state
  previousResults.set(authorityId, { consecutive_failures, last_healthy_at, probe_count });

  // Freshness: has the endpoint answered healthy within the authority's update window (its freshness_budget)? Measured
  // from the last healthy answer, not from this probe (which made every authority with a cadence read fresh, whatever
  // it answered). It is not the age of the authority's data. last_healthy_at is kept in memory: after a restart the
  // authority reads unknown until its first healthy answer.
  const freshness = configured && !isUnsupported ? evaluateFreshness(authorityId, last_healthy_at) : 'unknown';

  return {
    authority_id: authorityId,
    name: getAuthorityName(authorityId),
    path_type: getAuthorityPathType(authorityId),
    probe_class: PROBE_CONFIG[authorityId]?.probe_class || 'unknown',
    configured,
    reachability: probeResult.reachability,
    reachability_reason: probeResult.reachability_reason,
    error_class: probeResult.error_class || null,
    latency_ms: probeResult.latency_ms ?? null,
    latency_class: classifyLatency(probeResult.latency_ms),
    freshness,
    observed_at: isUnsupported ? null : now,
    consecutive_failures,
    probe_count,
    last_healthy_at,
  };
}

function deriveOverall(authorityResults) {
  const active = authorityResults.filter(a => a.configured);
  const healthy = active.filter(a => a.reachability === 'healthy').length;
  const degraded = active.filter(a => a.reachability === 'degraded').length;
  const unavailable = active.filter(a => a.reachability === 'unavailable').length;
  const total = active.length;

  if (total === 0) return { state: 'unknown', reason: 'No active probes' };

  const okCount = healthy + degraded;
  const okPct = okCount / total;

  let state, reason;
  if (healthy / total >= 0.9) {
    state = 'healthy';
    reason = `${healthy} of ${total} active probes healthy`;
  } else if (okPct >= 0.7) {
    state = 'degraded';
    reason = `${healthy} healthy, ${degraded} degraded of ${total} active probes`;
  } else if (okPct >= 0.4) {
    state = 'partial';
    reason = `${okCount} of ${total} active probes responding`;
  } else if (total > 0) {
    state = 'unavailable';
    reason = `Only ${okCount} of ${total} active probes responding`;
  } else {
    state = 'unknown';
    reason = 'No probes executed';
  }

  // Data quality
  let data_quality;
  if (okPct >= 0.7) data_quality = 'sufficient';
  else if (okPct >= 0.4) data_quality = 'partial';
  else data_quality = 'insufficient';

  // Confidence
  const confidence = (unavailable > 0 && healthy > 0) ? 'uncertain' : 'clear';

  return {
    commerce_observability_state: state,
    commerce_observability_reason: reason,
    data_quality,
    confidence,
    active_probes: total,
    active_probes_healthy: healthy,
    active_probes_degraded: degraded,
    active_probes_unavailable: unavailable,
    configured_probes: authorityResults.filter(a => a.configured).length,
    deferred_probes: NON_PROBEABLE.length,
    staleness_seconds: 0,
  };
}

function checkIncidents(authorityResults) {
  const newIncidents = [];
  const now = new Date().toISOString();

  for (const auth of authorityResults) {
    if (!auth.configured) continue;

    // API key invalid — immediate critical
    if (auth.error_class === 'api_key_invalid') {
      newIncidents.push({
        incident_type: 'commerce_api_key_invalid',
        severity: 'critical',
        authority_id: auth.authority_id,
        message: `${auth.name}: API key returned ${auth.reachability_reason}`,
        first_observed_at: now,
        consecutive_failures: auth.consecutive_failures,
      });
    }

    // Probe unavailable — warning after threshold
    if (auth.reachability === 'unavailable' && auth.consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      newIncidents.push({
        incident_type: 'commerce_probe_unavailable',
        severity: 'warning',
        authority_id: auth.authority_id,
        message: `${auth.name}: unavailable for ${auth.consecutive_failures} consecutive cycles`,
        first_observed_at: now,
        consecutive_failures: auth.consecutive_failures,
      });
    }

    // Rate limited — info after threshold
    if (auth.error_class === 'http_429_rate_limited' && auth.consecutive_failures >= RATE_LIMIT_FAILURE_THRESHOLD) {
      newIncidents.push({
        incident_type: 'commerce_probe_rate_limited',
        severity: 'info',
        authority_id: auth.authority_id,
        message: `${auth.name}: rate-limited for ${auth.consecutive_failures} consecutive cycles`,
        first_observed_at: now,
        consecutive_failures: auth.consecutive_failures,
      });
    }

    // Stale — info
    if (auth.freshness === 'stale') {
      newIncidents.push({
        incident_type: 'commerce_probe_stale',
        severity: 'info',
        authority_id: auth.authority_id,
        message: `${auth.name}: data exceeds freshness budget`,
        first_observed_at: now,
        consecutive_failures: 0,
      });
    }
  }

  return newIncidents;
}

// ─── Output Writer ───────────────────────────────────────────

function writeOutput(authorityResults, cycleDurationMs) {
  const overall = deriveOverall(authorityResults);
  const newIncidents = checkIncidents(authorityResults);

  const output = {
    schema_version: '1.0',
    probe_runner_version: VERSION,
    registry_version: registry?.registry_version || 'unknown',
    generated_at: new Date().toISOString(),
    cycle_duration_ms: cycleDurationMs,
    layer: 'commerce_intelligence',

    overall,

    authorities: authorityResults,

    non_probeable_authorities: NON_PROBEABLE,

    incidents: newIncidents,

    limits: {
      note: 'This data represents attestation authority reachability, not commerce readiness, legal compliance, or transaction safety.',
      layer_boundary: 'Layer 2 only. Does not influence Layer 1 canonical status or /organism.',
      network_context: 'testnet',
      registry_source_note: 'Attestation path definitions derived from pre-release Demos agent commerce materials (not yet public). Authority endpoints are production public APIs.',
      not_legal_advice: true,
    },

    disclaimer: 'The Demos Network Oracle observes whether attestation authority endpoints are reachable. This is infrastructure observability, not certification. The Oracle does not verify commerce claims, certify legal compliance, or recommend transactions.',
  };

  // Atomic write: write to temp file, then rename
  const tmpPath = OUTPUT_PATH + '.tmp';
  const dataDir = dirname(OUTPUT_PATH);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf-8');
  try {
    renameSync(tmpPath, OUTPUT_PATH);
  } catch {
    // Fallback: overwrite directly
    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  }

  return output;
}

// ─── Main Cycle ──────────────────────────────────────────────

async function runProbeCycle() {
  cycleCount++;
  const cycleStart = Date.now();
  console.log(`[commerce-probes] Cycle ${cycleCount} starting...`);

  const authorityIds = Object.keys(PROBE_CONFIG);
  const results = [];

  for (const authorityId of authorityIds) {
    // Check cycle budget
    if (Date.now() - cycleStart > CYCLE_BUDGET_MS) {
      console.warn(`[commerce-probes] Cycle budget exceeded (${CYCLE_BUDGET_MS}ms). Skipping remaining probes.`);
      break;
    }

    try {
      const probeResult = await probeAuthority(authorityId);
      if (probeResult) {
        const assembled = assembleAuthorityResult(authorityId, probeResult);
        results.push(assembled);

        const icon = assembled.reachability === 'healthy' ? '✓' :
                     assembled.reachability === 'degraded' ? '~' :
                     assembled.reachability === 'unsupported' ? '○' :
                     assembled.reachability === 'unavailable' ? '✗' : '?';
        console.log(`  ${icon} ${authorityId}: ${assembled.reachability} (${assembled.latency_ms ?? '-'}ms)`);
      }
    } catch (err) {
      console.error(`  ✗ ${authorityId}: probe crashed — ${err.message}`);
      const assembled = assembleAuthorityResult(authorityId, {
        reachability: 'unknown',
        reachability_reason: `Probe code error: ${err.message}`,
        error_class: 'unknown_error',
        latency_ms: null,
      });
      results.push(assembled);
    }
  }

  const cycleDuration = Date.now() - cycleStart;
  const output = writeOutput(results, cycleDuration);

  const overall = output.overall;
  console.log(`[commerce-probes] Cycle ${cycleCount} complete in ${cycleDuration}ms — ${overall.commerce_observability_state} (${overall.active_probes_healthy}/${overall.active_probes} healthy)`);

  if (output.incidents.length > 0) {
    for (const inc of output.incidents) {
      console.log(`  ⚠ ${inc.severity}: ${inc.message}`);
    }
  }
}

// ─── Startup ─────────────────────────────────────────────────

async function main() {
  console.log(`[commerce-probes] DNO Commerce Probe Runner v${VERSION}`);
  console.log(`[commerce-probes] Layer 2 — Commerce Intelligence`);
  console.log(`[commerce-probes] This service does NOT modify /organism or Layer 1 canonical state.`);
  console.log('');

  // Load registry
  if (!loadRegistry()) {
    console.error('[commerce-probes] Cannot start without registry. Exiting.');
    process.exit(1);
  }

  // Log configuration
  const configuredKeys = [];
  const missingKeys = [];
  for (const [id, config] of Object.entries(PROBE_CONFIG)) {
    if (config.env_required && !process.env[config.env_required]) {
      missingKeys.push(`${id} (${config.env_required})`);
    } else if (config.env_required) {
      configuredKeys.push(id);
    }
  }
  if (missingKeys.length > 0) {
    console.log(`[commerce-probes] Disabled probes (keys not configured): ${missingKeys.join(', ')}`);
  }
  if (configuredKeys.length > 0) {
    console.log(`[commerce-probes] Key-configured probes: ${configuredKeys.join(', ')}`);
  }

  const activeCount = Object.keys(PROBE_CONFIG).length - missingKeys.length;
  console.log(`[commerce-probes] Active probes: ${activeCount}, Deferred: ${NON_PROBEABLE.length}`);
  console.log(`[commerce-probes] Cycle interval: ${CYCLE_INTERVAL_MS / 1000}s (±${JITTER_MS / 1000}s jitter)`);
  console.log(`[commerce-probes] Output: ${OUTPUT_PATH}`);
  console.log('');

  // Run first cycle immediately
  await runProbeCycle();

  // Schedule subsequent cycles with jitter
  function scheduleNext() {
    const jitter = Math.round((Math.random() - 0.5) * 2 * JITTER_MS);
    const delay = CYCLE_INTERVAL_MS + jitter;
    setTimeout(async () => {
      await runProbeCycle();
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// Handle clean shutdown
process.on('SIGTERM', () => {
  console.log('[commerce-probes] Received SIGTERM. Shutting down.');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[commerce-probes] Received SIGINT. Shutting down.');
  process.exit(0);
});

main().catch(err => {
  console.error(`[commerce-probes] Fatal error: ${err.message}`);
  process.exit(1);
});
