# Demos Fleet Oracle

Autonomous health oracle for the [Demos Network](https://demos.network) validator fleet. Monitors validator nodes every 20 minutes, publishes attested health data on-chain via [SuperColony](https://supercolony.ai), and serves a public API + dashboard.

## Live Endpoints

| Endpoint | Description |
|----------|-------------|
| [/dashboard](http://193.77.169.106:55225/dashboard) | Live fleet dashboard — auto-refresh 20s |
| [/health](http://193.77.169.106:55225/health) | Full fleet snapshot — signals, incidents, reputation |
| [/incidents](http://193.77.169.106:55225/incidents) | Incident log with severity and duration |
| [/reputation](http://193.77.169.106:55225/reputation) | Per-node reputation scores 0-100 (24h window) |
| [/sentinel](http://193.77.169.106:55225/sentinel) | Anomaly detector status |
| [/version](http://193.77.169.106:55225/version) | Running version vs latest GitHub commit |
| [/federate](http://193.77.169.106:55225/federate) | Prometheus metrics endpoint |
| [/history](http://193.77.169.106:55225/history) | Last 72 health cycles (24h) |
| [/peers](http://193.77.169.106:55225/peers) | Known + discovered validators |
| [/badge](http://193.77.169.106:55225/badge) | SVG status badge |
| [/docs](http://193.77.169.106:55225/docs) | Full API documentation |

## Quick Start

### Check fleet health
```bash
curl -s http://193.77.169.106:55225/health | jq '{recommendation, signals, fleet_size, healthy: .fleet.healthy}'
```

### Get machine-readable signals
```bash
curl -s http://193.77.169.106:55225/health | jq '.signals'
```

### Filter warnings and criticals only
```bash
curl -s http://193.77.169.106:55225/health | jq '.signals | map(select(.severity == "warning" or .severity == "critical"))'
```

### Check if safe to propose
```bash
curl -s http://193.77.169.106:55225/health | jq '.recommendation.safe_to_propose'
```

### Embed status badge
```markdown
![Fleet Status](http://193.77.169.106:55225/badge)
```

### Prometheus scraping
```yaml
- job_name: demos-fleet-oracle
  scrape_interval: 60s
  metrics_path: /federate
  static_configs:
    - targets: ['193.77.169.106:55225']
```

## Signal Schema

```json
{
  "type": "block_lag",
  "severity": "info | warning | critical",
  "nodes": ["n4"],
  "value": 31,
  "message": "n4 is 31 blocks behind fleet"
}
```

Signal types: `all_healthy`, `node_offline`, `block_lag`, `identity_mismatch`, `not_ready`, `not_synced`, `chain_stall`, `low_online_count`, `block_divergence`, `public_node_offline`, `public_network_block`, `discovered_validators`

## Architecture

3-instance setup across 3 physical locations:

| Instance | Role | Behavior |
|----------|------|----------|
| n3 (primary) | Always publishes | Main oracle, serves public API |
| n1 (validator) | Watchdog | Publishes only if primary silent |
| m1 (backup) | Independent | Always publishes independently |

## Features

- Machine-readable `signals[]` array in `/health`
- Recommendation engine: `SAFE` / `CAUTION` / `UNSAFE`
- SQLite-backed incident log with severity tiers
- Sentinel v1: block stall, persistent lag, flapping, online drop, divergence detection
- DAHR-attested on-chain publishing via SuperColony
- Telegram alerts with 6-hour deduplication
- Prometheus federation endpoint
- Per-node reputation scores (0-100, 24h window)
- Auto-refresh dark-theme dashboard
- Validator auto-discovery via peerlist crawling

## Running Your Own Instance

```bash
git clone https://github.com/xm33/demos-fleet-oracle.git
cd demos-fleet-oracle
bun install
cp .env.example .env
bun run src/agent.mjs
```

Requirements: [Bun](https://bun.sh) runtime, Demos Network node running locally.

## Stack

- Runtime: [Bun](https://bun.sh)
- Chain: [Demos Network](https://demos.network)
- Oracle layer: [SuperColony](https://supercolony.ai)
- DB: SQLite (bun:sqlite)
- Anomaly detection: Sentinel v1

## Agent Wallet

`0xbdb3e8189a62dce62229bf3badbf01e5bdb3fbeb22f6f59f4c7c2edafe802a45`

## License

MIT
