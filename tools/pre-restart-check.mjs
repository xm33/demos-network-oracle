// pre-restart-check.mjs — the named test before a restart of the agent, run on the host that runs it.
//
// It loads the Demos SDK first, exactly as src/agent.mjs does (there the SDK import comes before DNO's own modules), and
// only then DNO's modules. Importing the SDK replaces the global fetch (@bundlr-network/client -> near-api-js sets it to
// its node-fetch import); on 2026-10-01 that made the deployed agent read 0 of 3 seeds while the same reads outside the agent
// worked. Then it makes the agent's own reads against the configured seeds (src/agent.mjs), with the agent's own code:
//   - each seed's /info with readSeedInfo (src/seed-read.mjs), the function the agent's public round calls, and the
//     agent's own rule for "enough to publish a status" (seedsSufficient: two seeds with their own height)
//   - one validator round with src/validator-watch.mjs: the list read on the seeds, then one dial per published origin
//     unless VALIDATOR_WATCH_DIALS switches the dials off (read with the agent's own function, dialsEnabled). The switch
//     is taken from this process's environment, which holds .env of the folder this runs in (the runtime loads it). A
//     value set only in the service unit is not seen here
//   - the cross-check RPCs of src/fleet.config.mjs with the agent's capped read (a count; not part of the verdict).
//     They are not read when the seeds are given as arguments
// It prints counts and names of seeds, never hosts, addresses or keys.
// What it does not do: start the agent. It runs once, in a new process, without the agent's database or wallet.
//
// Run:  bun tools/pre-restart-check.mjs            (in the agent's checkout: it needs node_modules and src/)
// Exit: 0 "AGENT READS OK"; 3 or 2 "AGENT READS FAILED" (do not restart; 2: only an unexpected answer shape);
//       64 the check could not run: no SDK here, or the seeds configured in src/agent.mjs could not be read from it.

const before = globalThis.fetch;
try { await import("@kynesyslabs/demosdk/websdk"); }
catch (e) { console.error("The Demos SDK is not installed next to this tool. Run it in the agent's checkout, where node_modules is."); process.exit(64); }
const sdkReplaced = globalThis.fetch !== before;
const { run } = await import("./validator-set-probe.mjs");
// The cross-check RPCs, when the fleet config is here (it is not in the repository). Their names are never printed.
// Not when the seeds are given as arguments: that run is not about this host's configuration (the suites run it so,
// and a suite must not read this host's RPCs).
let rpcs = null;
const seedsGiven = process.argv.slice(2).some((a) => /^[A-Za-z0-9._-]+=https?:\/\//.test(a));
if (!seedsGiven) { try { rpcs = (await import("../src/fleet.config.mjs")).FLEET_CROSS_VALIDATION_RPCS || null; } catch (e) {} }
// As the agent: the validator list is always read; published addresses are dialed unless the switch is off.
const { dialsEnabled } = await import("../src/validator-watch.mjs");
const dials = dialsEnabled(process.env.VALIDATOR_WATCH_DIALS);
process.exit(await run([...(dials ? ["--dial"] : []), ...process.argv.slice(2)], { agentReads: true, sdkReplaced, rpcs }));
