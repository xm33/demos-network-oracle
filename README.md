# Demos Network Oracle

**Live at:** [demos-oracle.com](https://demos-oracle.com)

The Demos Network Oracle (DNO) is a watch-only network intelligence service for the [Demos blockchain](https://demos.network) testnet. It monitors public validator nodes, tracks network agreement, detects incidents, attests observed public sources on-chain via DAHR when attestation is available, and serves a public API.

Built by [XM33](https://demos-oracle.com), independently of the Demos team.

## Core Principles

- **Watch-only.** The Oracle observes the network; it does not validate, vote, or participate in consensus.
- **Public-first.** Canonical truth comes from public validator nodes. Fleet-internal data is reference-only.
- **Observation ≠ endorsement.** Being monitored by the Oracle is not a signal of approval.
- **Explainability.** Every categorical signal comes with a paired reason string.

## Live Endpoints

| Endpoint | Description |
|----------|-------------|
| [/](https://demos-oracle.com/) | Homepage — live status, agreement, incidents |
| [/organism](https://demos-oracle.com/organism) | Canonical JSON state (primary machine-readable endpoint) |
| [/health](https://demos-oracle.com/health) | Network health snapshot |
| [/methodology](https://demos-oracle.com/methodology) | How the Oracle computes what it publishes |
| [/agent](https://demos-oracle.com/agent) | Agent/consumer integration guide |
| [/sources](https://demos-oracle.com/sources) | Data provenance and monitoring sources |
| [/community](https://demos-oracle.com/community) | Community node onboarding (reference surface) |
| [/submit](https://demos-oracle.com/submit) | Submit a community node for observation |

## Canonical data model

The Oracle publishes seven canonical fields via `/organism`:

| Field | Type | Paired reason |
|---|---|---|
| `status` | operable / partial / degraded / unknown | `status_reason` |
| `trend` | improving / stable / worsening | — |
| `risk` | low / elevated / high | `risk_factors` |
| `data_quality` | sufficient / partial / insufficient | — |
| `confidence` | clear / provisional | `confidence_reason` |
| `agreement` | strong / split / unknown | `agreement_reason` |
| `active_incidents` | integer | (incident list) |

Status = **operability** of the network right now. Risk = **resilience** under near-term stress.

## Quick Start

### Read current state

```bash
curl -s https://demos-oracle.com/organism | jq '{status, risk, agreement, summary}'
```

### Check if network is operable

```bash
curl -s https://demos-oracle.com/organism | jq -r '.status'
```

### Full health snapshot

```bash
curl -s https://demos-oracle.com/health | jq
```

## Architecture

- Single-file Node/Bun service: `src/agent.mjs` (~3,500 lines)
- Runtime: Bun
- Monitoring interval: 20 seconds
- Publishing interval: 20 minutes
- On-chain attestation: DAHR when available (state at /health)

## Running your own

Not currently a supported use case — the Oracle is operated as a singular public service. If you want to run a modified instance for research or auditing, see [/methodology](https://demos-oracle.com/methodology) and the source in `src/agent.mjs`.

## Reporting issues

Bugs, data inconsistencies, or security issues: see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).

---

**Attribution.** This repository and the Oracle service are built and maintained by XM33, independent of the Demos team. Inclusion of a node in the Oracle's monitoring set does not imply endorsement by Demos or XM33.
