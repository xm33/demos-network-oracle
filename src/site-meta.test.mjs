// site-meta.test.mjs — SITE_META guard (W2): every public HTML page says what it is to search engines and link
// previews in its own words, with one canonical URL on the fixed public origin; the share card carries no live value;
// the sitemap lists exactly those pages; /favicon.ico is a well-formed ICO; browsers that ask for an address nothing
// serves get a page, every other client the JSON it always had.
// Run: bun src/site-meta.test.mjs   (executable harness, not `bun test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PUBLIC_ORIGIN, SITE_META, SITE_ROUTES, SHARE_CARD, pageMeta, sitemapXml, icoFromPng, wantsHtml, notFoundPage, NOT_FOUND_JSON } from "./site-meta.mjs";
import { publicLanguageHit } from "./banned-public-language.mjs";

const TAG = "SITE_META";
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
const AGENT = readFileSync(join(ROOT, "src", "agent.mjs"), "utf8");
const ASSETS = { share: "/assets/dno-share-0123abcd.jpg", touch: "/assets/dno-touch-icon-4567ef01.png" };
const tags = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const attr = (html, sel) => tags(html, new RegExp("<meta " + sel + ' content="([^"]*)">', "g"));
const unesc = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

console.log("\n[" + TAG + "] the pages");
// The HTML routes the agent serves, read from its own router: a route answered with text/html is a page.
const htmlRoutes = [...AGENT.matchAll(/reqPath === "(\/[^"]*)"\) \{\n(?:(?!\n    \} else if)[\s\S])*?"Content-Type": ?"text\/html/g)].map((m) => m[1]).filter((r) => r !== "/dashboard");
check("P1 the table names exactly the 11 HTML routes the public router serves (the internal /dashboard aside)",
  SITE_ROUTES.length === 11 && htmlRoutes.length === 11 && htmlRoutes.every((r) => SITE_ROUTES.includes(r)), JSON.stringify(htmlRoutes));
check("P2 the origin is the fixed public one, never a request's Host header", PUBLIC_ORIGIN === "https://demos-oracle.com" && !/req\.headers\[?\.?["']?host/i.test(readFileSync(join(__dir, "site-meta.mjs"), "utf8")));
const bad = SITE_ROUTES.filter((r) => { const d = SITE_META[r].description; return typeof d !== "string" || d.length < 50 || d.length > 200 || /["<>]/.test(d) || publicLanguageHit(d) || /\s{2}/.test(d); });
check("P3 every description is 50 to 200 characters, attribute-safe and free of the banned public language", bad.length === 0, bad.join(", "));
check("P4 the three descriptions that already existed are kept word for word",
  SITE_META["/"].description === "Independent · not an official Demos product. A watch-only public observability layer for the Demos public testnet. Observe. Explain."
  && SITE_META["/sources"].description === "What DNO reads, which of it enters status, and which endpoints publish it."
  && SITE_META["/about-demos"].description === "What the Demos docs say about validators, per-block shards, node health and DAHR, and which of those DNO can see from outside. Every protocol statement links to its source.");
// Each title is the page's own <title>: in its file for the static pages, in the agent for the server-built ones.
const FILES = { "/": "homepage.html", "/sources": "sources.html", "/methodology": "methodology.html", "/criteria": "criteria.html", "/commerce": "commerce.html", "/commerce/methodology": "commerce-methodology.html", "/about-demos": "about-demos.html", "/agent": "agent-guide.html" };
const titleOf = (r) => FILES[r] ? (readFileSync(join(ROOT, FILES[r]), "utf8").match(/<title>([^<]*)<\/title>/) || [])[1] : (AGENT.includes("<title>" + SITE_META[r].title + "</title>") ? SITE_META[r].title : null);
const titleBad = SITE_ROUTES.filter((r) => titleOf(r) !== SITE_META[r].title);
check("P5 each og:title is the page's own <title>", titleBad.length === 0, titleBad.map((r) => r + "=" + titleOf(r)).join(", "));
const noDesc = Object.entries(FILES).filter(([, f]) => /<meta name="description"/.test(readFileSync(join(ROOT, f), "utf8")));
check("P6 no page file carries a description of its own (the table is the one place)", noDesc.length === 0, noDesc.map(([r]) => r).join(", "));

console.log("\n[" + TAG + "] the head tags");
const metaBad = SITE_ROUTES.filter((r) => {
  const h = pageMeta(r, ASSETS), url = PUBLIC_ORIGIN + r;
  const one = (sel) => attr(h, sel).length === 1;
  return !(["name=\"description\"", "property=\"og:site_name\"", "property=\"og:type\"", "property=\"og:title\"", "property=\"og:description\"", "property=\"og:url\"", "property=\"og:image\"", "property=\"og:image:width\"", "property=\"og:image:height\"", "property=\"og:image:alt\"", "name=\"twitter:card\""].every(one)
    && tags(h, /<link rel="canonical" href="([^"]*)">/g).length === 1 && tags(h, /<link rel="canonical" href="([^"]*)">/g)[0] === url
    && attr(h, 'property="og:url"')[0] === url && unesc(attr(h, 'name="description"')[0]) === SITE_META[r].description
    && unesc(attr(h, 'property="og:description"')[0]) === SITE_META[r].description && unesc(attr(h, 'property="og:title"')[0]) === SITE_META[r].title
    && attr(h, 'property="og:image"')[0] === PUBLIC_ORIGIN + ASSETS.share && attr(h, 'name="twitter:card"')[0] === "summary_large_image"
    && attr(h, 'property="og:image:width"')[0] === "1200" && attr(h, 'property="og:image:height"')[0] === "630"
    && h.includes('<link rel="apple-touch-icon" sizes="180x180" href="' + ASSETS.touch + '">'));
});
check("M1 every page gets each tag once: description, canonical and og:url on the public origin plus its own path, og:title its title, an absolute og:image, a large card, the touch icon", metaBad.length === 0, metaBad.join(", "));
check("M2 an unknown route gets no description, canonical or share tag (only the touch icon)", pageMeta("/nope", ASSETS) === '<link rel="apple-touch-icon" sizes="180x180" href="' + ASSETS.touch + '">' && pageMeta(null, {}) === "");
check("M3 without a share card the tags say so honestly: no og:image, a small card", !/og:image/.test(pageMeta("/", {})) && /twitter:card" content="summary"/.test(pageMeta("/", {})));
check("M4 text is escaped into attributes (the timeline's typographic apostrophe stays; quotes and brackets cannot appear)", pageMeta("/timeline", ASSETS).includes("Oracle’s own record") && !/content="[^"]*[<>][^"]*"/.test(SITE_ROUTES.map((r) => pageMeta(r, ASSETS)).join("")));
check("M5 the card's alt text says what DNO is and nothing about any reading", SHARE_CARD.alt === "DNO, Demos Network Oracle: independent observability, not an official Demos product." && !publicLanguageHit(SHARE_CARD.alt)
  && !/\b(stable|degraded|unknown|status|block|height|validator|\d)/i.test(SHARE_CARD.alt));

console.log("\n[" + TAG + "] the share card and the touch icon");
const jpegSize = (b) => { let i = 2; while (i < b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; } return null; };
const card = readFileSync(join(ROOT, "assets", "dno-share.jpg")), touch = readFileSync(join(ROOT, "assets", "dno-touch-icon.png"));
const cs = jpegSize(card);
check("A1 the share card is a JPEG of 1200 x 630 under 300 KB", card[0] === 0xff && card[1] === 0xd8 && cs && cs[0] === 1200 && cs[1] === 630 && card.length < 300000, JSON.stringify(cs) + " " + card.length);
check("A2 the touch icon is a PNG of 180 x 180", touch.readUInt32BE(0) === 0x89504e47 && touch.readUInt32BE(16) === 180 && touch.readUInt32BE(20) === 180);
const CARD_HTML = readFileSync(join(ROOT, "tools", "share-card", "card.html"), "utf8");
const cardText = CARD_HTML.slice(CARD_HTML.indexOf('<div class="card"'), CARD_HTML.indexOf('<div class="touch"')).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
check("A3 the card's words are the site header's, with no live value (no status, count or date)", cardText === "DNO Demos Network Oracle Independent observability · not an official Demos product. demos-oracle.com" && !/\d/.test(cardText.replace("demos-oracle.com", "")), cardText);
check("A4 the card uses the locked mark and the homepage artwork as they are on disk", CARD_HTML.includes('src="../../assets/dno-mark.jpg"') && CARD_HTML.includes('src="../../assets/dno-planet.jpg"'));
check("A5 the agent serves both as kit assets under their content hash and points the tags at them",
  /loadKitAsset\("assets\/dno-share\.jpg", "dno-share", "\.jpg", "image\/jpeg"\)/.test(AGENT) && /loadKitAsset\("assets\/dno-touch-icon\.png", "dno-touch-icon", "\.png", "image\/png"\)/.test(AGENT)
  && /SHARE_CARD_ASSET, TOUCH_ICON\]\.forEach/.test(AGENT) && /var META_ASSETS = \{ share: SHARE_CARD_ASSET \? SHARE_CARD_ASSET\.path : null, touch: TOUCH_ICON \? TOUCH_ICON\.path : null \};/.test(AGENT));

console.log("\n[" + TAG + "] the sitemap and the icon");
const sm = sitemapXml(), locs = tags(sm, /<loc>([^<]*)<\/loc>/g);
check("S1 the sitemap lists the 11 canonical URLs once each, and no date", locs.length === 11 && new Set(locs).size === 11 && SITE_ROUTES.every((r) => locs.includes(PUBLIC_ORIGIN + r)) && !/lastmod|changefreq|priority/.test(sm) && sm.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), locs.join(" "));
const png = readFileSync(join(ROOT, "assets", "dno-favicon.png")), ico = icoFromPng(png);
check("S2 /favicon.ico is one ICO entry wrapping the 64 x 64 favicon PNG byte for byte",
  ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1 && ico[6] === 64 && ico[7] === 64 && ico.readUInt16LE(10) === 1 && ico.readUInt16LE(12) === 32
  && ico.readUInt32LE(14) === png.length && ico.readUInt32LE(18) === 22 && ico.subarray(22).equals(png) && ico.length === png.length + 22);
check("S3 an image of 256 px or more is written as 0 in the entry, as the format requires", (() => { const p = Buffer.from(png); p.writeUInt32BE(256, 16); p.writeUInt32BE(300, 20); const i = icoFromPng(p); return i[6] === 0 && i[7] === 0; })());

console.log("\n[" + TAG + "] not found");
check("N1 a browser is a request whose Accept names text/html; curl's */* and JSON clients are not", wantsHtml("text/html,application/xhtml+xml,*/*;q=0.8") && wantsHtml("TEXT/HTML") && !wantsHtml("*/*") && !wantsHtml("application/json") && !wantsHtml(undefined) && !wantsHtml(""));
const PAGES = [["/", "home", "Live reading"], ["/docs", "docs", "API"]];
const nf = notFoundPage({ head: "<!--H-->", header: "<!--HEADER-->", footer: "<!--FOOTER-->" }, PAGES);
check("N2 the page is in the site's shell, titled, not for indexing, and links every page and the API docs",
  nf.includes("<title>Not found · Demos Network Oracle</title>") && nf.includes('<meta name="robots" content="noindex">') && nf.includes("<!--H-->") && nf.includes("<!--HEADER-->") && nf.includes("<!--FOOTER-->")
  && nf.includes("<h1>Page not found</h1>") && nf.includes('<a href="/">Live reading</a>') && nf.includes('<a href="/docs">API</a>') && nf.includes("Nothing is served at this address."));
check("N3 the page offers itself for no sharing: no canonical, no description, no og: tag", !/canonical|og:|name="description"/.test(nf) && !publicLanguageHit(nf.replace(/<[^>]+>/g, " ")));
check("N4 the JSON body is the one the API always answered", NOT_FOUND_JSON === '{"error":"Not found. Try /docs for API documentation."}');

console.log("\n[" + TAG + "] the agent's wiring");
const nfFn = (AGENT.match(/function notFound\(req, res\) \{([\s\S]*?)\n  \}\n/) || ["", ""])[1];
check("W1 one notFound answers both places: an unknown path, and the fleet-only routes on the public listener (so those stay indistinguishable)",
  /if \(!internal && isFleetRoute\(reqPath\)\) \{ notFound\(req, res\); return; \}/.test(AGENT) && /\} else \{\n      notFound\(req, res\);\n    \}\n  \}\n/.test(AGENT)
  && (AGENT.match(/Not found\. Try \/docs/g) || []).length === 0, nfFn.slice(0, 120));
check("W2 notFound: HTML 404 for a browser with no-store, JSON 404 otherwise, both with Vary: Accept",
  /if \(wantsHtml\(req\.headers\["accept"\]\)\)/.test(nfFn) && /res\.writeHead\(404, \{ "Content-Type": "text\/html; charset=utf-8", "Cache-Control": "no-store", "Vary": "Accept" \}\)/.test(nfFn)
  && /notFoundPage\(\{ head: siteHead\(null\), header: siteHeader\(""\), footer: siteFooter\(""\) \}, SITE_PAGES\)/.test(nfFn) && /res\.writeHead\(404, \{ "Vary": "Accept" \}\); res\.end\(NOT_FOUND_JSON\);/.test(nfFn));
check("W3 the root routes: /sitemap.xml as XML, /favicon.ico as an icon, /apple-touch-icon.png as a PNG",
  /reqPath === "\/sitemap\.xml"\) \{\n      res\.writeHead\(200, \{ "Content-Type": "application\/xml; charset=utf-8"/.test(AGENT) && /res\.end\(sitemapXml\(\)\);/.test(AGENT)
  && /reqPath === "\/favicon\.ico" && FAVICON_ICO\) \{\n      res\.writeHead\(200, \{ "Content-Type": "image\/x-icon"/.test(AGENT) && /var FAVICON_ICO = SITE_FAVICON \? icoFromPng\(SITE_FAVICON\.bytes\) : null;/.test(AGENT)
  && /reqPath === "\/apple-touch-icon\.png" && TOUCH_ICON\) \{\n      res\.writeHead\(200, \{ "Content-Type": "image\/png"/.test(AGENT));

console.log("\n[" + TAG + "] " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
