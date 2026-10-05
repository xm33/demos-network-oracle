// pre-restart-check.mjs — the named test before a restart of the agent, run on the host that runs it.
//
// It loads the Demos SDK first, exactly as src/agent.mjs does (there the SDK import comes before DNO's own modules), and
// only then DNO's modules. Importing the SDK replaces the global fetch (@bundlr-network/client -> near-api-js sets it to
// its node-fetch import); on 2026-10-01 that made the deployed agent read 0 of 3 seeds while the same reads outside the agent
// worked. Then it makes the agent's own reads against the configured seeds (src/agent.mjs), with the agent's own code:
//   - each seed's /info with readSeedInfo (src/seed-read.mjs), the function the agent's public round calls
//   - one validator round with src/validator-watch.mjs: the list read on the seeds, then one dial per published origin
//     unless VALIDATOR_WATCH_DIALS switches the dials off (read with the agent's own function, dialsEnabled). The switch
//     and LOG_DIR are read as the agent reads them: a line in .env of the folder this runs in wins over a variable of
//     the shell (the runtime's own loading of .env lets the shell win, which the agent does not). A value set only in
//     the service unit is not seen here
//   - the validators that stand in for a seed, with readWitnesses (src/witnesses.mjs): this run's candidates when its
//     validator round counted, else the ones the agent keeps in its store (LOG_DIR/marketplace.db in this folder,
//     opened read-only; nothing is written to it). Not read when the dials are off
//   - the agent's own rule on those reads, assess (src/status-rule.mjs): two seeds with their own height, or one seed
//     and validators within 25 blocks of it, or validators alone
//   - the cross-check RPCs of src/fleet.config.mjs with the agent's capped read (a count; not part of the verdict).
//     They are not read when the seeds are given as arguments
// It prints counts and names of seeds, never hosts, addresses or keys.
// What it does not do: start the agent. It runs once, in a new process, without the agent's database or wallet.
//
// Run:  bun tools/pre-restart-check.mjs            (in the agent's checkout: it needs node_modules and src/)
// Exit: 0 "AGENT READS OK"; 3 or 2 "AGENT READS FAILED" (do not restart; 2: only an unexpected answer shape). FAILED
//       when the rule gives no reading, when any of the reads above ended in an internal error (a seed's /info, a list
//       read, a dial, a witness read: a fault in DNO's own read, not an answer of a peer), or when two seeds were asked
//       for the validator list and none was agreed;
//       4 "AGENT READS GIVE A READING WITHOUT A SEED": validators alone stand in. Seeds that are down and a fault in
//       DNO's own seed read look the same from here, so this is not a pass and nothing restarts on it by itself;
//       64 the check could not run: no SDK here, or the seeds configured in src/agent.mjs could not be read from it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const before = globalThis.fetch;
const noSdk = () => { console.error("The Demos SDK is not installed next to this tool. Run it in the agent's checkout, where node_modules is."); process.exit(64); };
// The SDK the agent loads is the one in this checkout's node_modules. Looked for on disk first: in a folder without
// node_modules the runtime would try to fetch a package by itself, and that would not be the agent's SDK.
if (!existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@kynesyslabs", "demosdk"))) noSdk();
try { await import("@kynesyslabs/demosdk/websdk"); }
catch (e) { noSdk(); }
const sdkReplaced = globalThis.fetch !== before;
const { run } = await import("./validator-set-probe.mjs");
// The cross-check RPCs, when the fleet config is here (it is not in the repository). Their names are never printed.
// Not when the seeds are given as arguments: that run is not about this host's configuration (the suites run it so,
// and a suite must not read this host's RPCs).
let rpcs = null;
const seedsGiven = process.argv.slice(2).some((a) => /^[A-Za-z0-9._-]+=https?:\/\//.test(a));
if (!seedsGiven) { try { rpcs = (await import("../src/fleet.config.mjs")).FLEET_CROSS_VALIDATION_RPCS || null; } catch (e) {} }
// The two settings this check uses, as the agent reads them (src/agent.mjs reads .env itself, and its line wins). Only
// these two names are taken, and no value is printed. Not when the seeds are given as arguments: that run is not about
// this host's configuration.
if (!seedsGiven) {
  try {
    readFileSync(".env", "utf8").split("\n").forEach((line) => { const m = line.match(/^([^#=]+)=(.*)$/); const k = m ? m[1].trim() : null; if (k === "VALIDATOR_WATCH_DIALS" || k === "LOG_DIR") process.env[k] = m[2].trim(); });
  } catch (e) { /* no .env here: the process's environment stands */ }
}
// As the agent: the validator list is always read; published addresses are dialed unless the switch is off.
const { dialsEnabled } = await import("../src/validator-watch.mjs");
const dials = dialsEnabled(process.env.VALIDATOR_WATCH_DIALS);
// With the seeds given as arguments the agent's store in this folder is not read either: no kept candidates.
// --dial given by hand is ignored: the switch decides, as it does in the agent.
process.exit(await run([...(dials ? ["--dial"] : []), ...process.argv.slice(2).filter((a) => a !== "--dial")], Object.assign({ agentReads: true, sdkReplaced, rpcs }, seedsGiven ? { kept: null } : {})));
