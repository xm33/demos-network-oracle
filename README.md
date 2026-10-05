# Demos Network Oracle

**Live at:** [demos-oracle.com](https://demos-oracle.com)

The Demos Network Oracle (DNO) is an independent, watch-only observer of the public [Demos](https://demos.network) testnet. It reads public nodes, publishes what they report as a machine-readable reading at `/organism`, and explains how each value is derived. It does not operate the protocol or admit validators. DNO informs context; it does not advise, predict, score, certify, or decide action.

Built by [XM33](https://demos-oracle.com). Not an official Demos or KyneSys product.

## What it is, and what it is not

- **Watch-only.** DNO reads. It does not validate, vote, or take part in consensus.
- **Its operator takes part.** XM33 runs a validator on the public Demos testnet. In the public reading that validator has no special place: it counts like any other validator, and only if it publishes an address on chain and answers there as the key the validator list holds. DNO does not publish which validator it is.
- **Public sources only.** The public reading is made from the configured public seeds. When fewer than two of them report their own block height, validators that answer as listed stand in for the missing seed, and the reading says so. The operator's private nodes never enter it.
- **Every label has a reason.** Each categorical value is published with the reason for it. `unknown` and `insufficient` are states of the reading, not errors.
- **Observation is not endorsement.** A node that DNO reads or lists is not endorsed by Demos or by XM33.

## Endpoints

| Endpoint | What it is |
|----------|------------|
| [/](https://demos-oracle.com/) | The reading, the public seeds, incidents |
| [/organism](https://demos-oracle.com/organism) | The public reading as JSON (the default for software) |
| [/organism/schema](https://demos-oracle.com/organism/schema) | The JSON Schema contract: stability policy, enums, changelog |
| [/health](https://demos-oracle.com/health) | The same labels and reasons without the summary sentence, and their parts: each seed, validator counts, signals |
| [/incidents](https://demos-oracle.com/incidents) | Public incidents and DNO's condition records |
| [/catalog](https://demos-oracle.com/catalog) | Identities listed on the public seeds' peerlists |
| [/methodology](https://demos-oracle.com/methodology) | How each value is derived, and where the observation stops |
| [/sources](https://demos-oracle.com/sources) | What DNO reads, and which of it enters status |
| [/agent](https://demos-oracle.com/agent) | How software consumes the API |
| [/timeline](https://demos-oracle.com/timeline) | Incidents, condition records and releases, by date |
| [/docs](https://demos-oracle.com/docs) | Every public endpoint |

## The reading

`/organism` publishes each label with its reason. The schema at `/organism/schema` is the contract; this table is a summary of it.

| Field | Values | Reason field |
|---|---|---|
| `status` | stable / degraded / unstable / unknown | `status_reason` |
| `risk` | low / elevated / high | `risk_factors` |
| `confidence` | clear / uncertain | `confidence_reason` |
| `data_quality` | sufficient / insufficient | `data_quality_reason` |
| `agreement` | strong / moderate / weak / unknown | `agreement_reason` |
| `trend` | improving / stable / worsening / unknown | |
| `active_incidents` | integer | [/incidents](https://demos-oracle.com/incidents) |
| `witnesses` | what the reading rests on: `seeds_only`, `seed_and_validators`, `validators_only` or `insufficient`, with counts | |

Status is what the heights DNO read show of the network, not how many nodes DNO could read. A reading that would be `stable` is `degraded` once DNO has counted 30 minutes without a new block height.

## Quick start

```bash
curl -s https://demos-oracle.com/organism | jq '{status, status_reason, risk, agreement, rests_on: .witnesses.mode, summary}'
```

```bash
curl -s https://demos-oracle.com/health | jq '.publicNodes'
```

Check a deployment against the published contract:

```bash
bun tools/organism-contract-test.mjs https://demos-oracle.com
```

## Source

- Runtime: Bun. One service, `src/agent.mjs`, with its rules in small modules:
  - `src/status-rule.mjs`: how one round's readings become status, risk, confidence and agreement
  - `src/seed-read.mjs`: one seed's `/info` read
  - `src/witnesses.mjs`: the validators that stand in for a seed that gave no height
  - `src/validator-watch.mjs`: the on-chain validator list as the seeds report it, and the dials to published addresses
  - `src/public-safety.mjs`: everything that crosses the public boundary, in and out
- A public observation round runs every 20 seconds, independent of the wallet.
- DAHR attestation is attempted on the cross-check RPCs; its state is on `/health` (`attestation`). The public reading is never posted on chain.
- Tests: `bun run test` (no running agent needed) and `bun run test:served` (against a running agent).
- Before and after a restart: `bun tools/pre-restart-check.mjs` and `bun tools/post-restart-check.mjs`.

## Running your own

Not currently a supported use case: the Oracle is operated as a single public service. To run a modified instance for research or auditing, see [/methodology](https://demos-oracle.com/methodology) and the source in `src/`.

## Reporting issues

Bugs, data inconsistencies, or security issues: see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

---

**Attribution.** This repository and the Oracle service are built and maintained by XM33, independent of the Demos team. A node that DNO reads or lists is not endorsed by Demos or by XM33.
