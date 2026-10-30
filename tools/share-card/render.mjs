// Renders the share card (assets/dno-share.jpg, 1200x630) and the touch icon (assets/dno-touch-icon.png, 180x180)
// from card.html, with the site's own fonts, the homepage artwork and the locked mark. Run once when the card's
// words or artwork change: `node tools/share-card/render.mjs`. Uses the preview harness's Playwright.
// The served files are whatever is committed: the agent hashes them at load, and src/site-meta.test.mjs checks
// their sizes. A re-render need not give the same bytes (renderer versions differ); it must give the same picture.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "..");
const { chromium } = await import(pathToFileURL(join(root, "tools", "homepage-preview", "node_modules", "playwright", "index.mjs")).href);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "card.html")).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const out = [["#card", "assets/dno-share.jpg", { type: "jpeg", quality: 88 }], ["#touch", "assets/dno-touch-icon.png", { type: "png" }]];
for (const [sel, file, opt] of out) {
  await page.locator(sel).screenshot(Object.assign({ path: join(root, file), animations: "disabled" }, opt));
  console.log(file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex"));
}
await browser.close();
