# Demos Fleet Oracle

Autonomous health monitoring agent for the [Demos Network](https://demos.network) validator fleet. Monitors 7 validator nodes, publishes attested health data on-chain via [SuperColony](https://supercolony.ai), and serves a public API + dashboard.

## Live Endpoints

- **Dashboard:** http://193.77.169.106:55225/dashboard
- **Health API:** http://193.77.169.106:55225/health
- **Incidents:** http://193.77.169.106:55225/incidents
- **Docs:** http://193.77.169.106:55225/docs

## Features

- 7-node fleet monitoring with identity verification
- Recommendation engine: `SAFE` / `CAUTION` / `UNSAFE`
- Incident log with SQLite persistence and severity tiers
- Telegram alerts with 6-hour deduplication
- DAHR-attested on-chain publishing via SuperColony
- Prometheus federation endpoint (`/federate`)
- Auto-refresh dark-theme dashboard

## Stack

- Runtime: [Bun](https://bun.sh)
- Chain: [Demos Network](https://demos.network)
- Oracle: [SuperColony](https://supercolony.ai)
- DB: SQLite (better-sqlite3)

## Agent Wallet

`0xbdb3e8189a62dce62229bf3badbf01e5bdb3fbeb22f6f59f4c7c2edafe802a45`
