// tools/homepage-preview/inputs.mjs — what the preview tools (check.mjs, serve.mjs) serve besides homepage.html:
// the fixture scenarios, and the kit files under the content-hashed names the agent gives them, read from the working tree.
// The agent serves them as /assets/<base>-<first 8 hex of sha256>.<ext> (src/agent.mjs loadKitAsset), the mark as
// /assets/dno-mark-<8>.jpg. check.mjs and serve.mjs answer the same names, so the page loads exactly these bytes.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const TYPES = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".txt": "text/plain" };
const KIT = [["assets/site.css", "site"], ["assets/site.js", "site"], ["assets/dno-favicon.png", "dno-favicon"], ["assets/fonts/Geist-Variable.woff2", "geist"], ["assets/fonts/GeistMono-Variable.woff2", "geist-mono"],
  ["assets/dno-planet.avif", "dno-planet"], ["assets/dno-planet.webp", "dno-planet"], ["assets/dno-planet.jpg", "dno-planet"], ["assets/dno-mark.jpg", "dno-mark"]];

export function kitAssets(root) {
  const assets = {};
  for (const [f, base] of KIT) {
    try { const b = readFileSync(join(root, f)), ext = f.slice(f.lastIndexOf(".")); assets["/assets/" + base + "-" + createHash("sha256").update(b).digest("hex").slice(0, 8) + ext] = { b, type: TYPES[ext] }; } catch (e) {}
  }
  return assets;
}

// Scenarios (fixtures/): name → [organism file, health file].
export const SCENARIOS = { capture: ["organism-capture-20261021T072727Z.json", "health-capture-20261021T072727Z.json"],
  capture_witnesses: ["organism-capture-20261023T122827Z.json", "health-capture-20261023T122827Z.json"],
  seeds_only: ["organism-seeds_only.json", "health-seeds_only.json"], seed_and_validators: ["organism-seed_and_validators.json", "health-seed_and_validators.json"],
  validators_only: ["organism-validators_only.json", "health-validators_only.json"], insufficient: ["organism-insufficient.json", "health-insufficient.json"] };
