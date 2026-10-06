// sentinel-state.mjs — where the sentinel keeps its state file, for the sentinel (which writes it) and the agent's
// /sentinel route (which reads it).
//
// It was /tmp/sentinel-dedup.json, written by one service and read by another. A service that runs with a private /tmp
// (systemd PrivateTmp=yes, as the agent's unit does) does not see the other's file, so /sentinel answered "unknown"
// while the sentinel was running. The file now lives in the agent's log directory, which both services see.
// A relative LOG_DIR is taken from the checkout's root (the folder above src/), not from the working directory, so two
// services started from different folders still name the same file.

import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";

export const SENTINEL_STATE_FILE = "sentinel-dedup.json";
export function sentinelStatePath(logDir) {
  var dir = typeof logDir === "string" && logDir.trim() ? logDir.trim() : "logs";
  var root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return isAbsolute(dir) ? join(dir, SENTINEL_STATE_FILE) : join(root, dir, SENTINEL_STATE_FILE);
}
