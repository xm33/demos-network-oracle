// W2: what each public page says about itself to search engines and link previews, the sitemap, the .ico wrapper
// and the not-found page for browsers. Pure functions: agent.mjs passes in the asset paths and the site shell, and
// src/site-meta.test.mjs runs every function here directly.
import { escHtml } from "./public-safety.mjs";

// The public origin. Fixed, never taken from a request's Host header, so a canonical URL cannot be steered by a request.
export const PUBLIC_ORIGIN = "https://demos-oracle.com";

// One entry per served HTML route. Each description is the page's own lede, shortened only; the homepage, /sources
// and /about-demos keep the description they already carried, word for word. The title is the page's own <title>.
export const SITE_META = {
  "/": {
    title: "Demos Network Oracle",
    description: "Independent · not an official Demos product. A watch-only public observability layer for the Demos public testnet. Observe. Explain."
  },
  "/sources": {
    title: "Sources · Demos Network Oracle",
    description: "What DNO reads, which of it enters status, and which endpoints publish it."
  },
  "/methodology": {
    title: "Methodology · Demos Network Oracle",
    description: "Every value DNO publishes comes from a published rule: the six fields, which seeds decide a round, what stays outside the reading, and the method in full, versioned and dated."
  },
  "/criteria": {
    title: "Criteria Catalog · Demos Network Oracle",
    description: "The definitions DNO would use for its observation criteria, published as definitions only: descriptive not prescriptive."
  },
  "/reference": {
    title: "Reference · Demos Network Oracle",
    description: "Reference tables: the fixnet probe and peer-listed identities. They enter no status, risk or agreement, and none is a validator list, a stake list or an official-node list."
  },
  "/timeline": {
    title: "Timeline · Demos Network Oracle",
    description: "Public-scope incidents and condition records from the Oracle’s own record since 2026-04-23, with the Oracle’s release events."
  },
  "/commerce": {
    title: "Commerce Infrastructure · Demos Network Oracle",
    description: "The public endpoints of the attestation authorities used by Demos agent commerce, probed every 5 minutes: whether they are reachable, responsive, and returning expected data."
  },
  "/commerce/methodology": {
    title: "Commerce Methodology · Demos Network Oracle",
    description: "How the Oracle checks whether the public attestation authorities used by Demos agent commerce, such as GLEIF, FINRA and the ECB, are reachable."
  },
  "/about-demos": {
    title: "About Demos · Demos Network Oracle",
    description: "What the Demos docs say about validators, per-block shards, node health and DAHR, and which of those DNO can see from outside. Every protocol statement links to its source."
  },
  "/agent": {
    title: "Agent Guide · Demos Network Oracle",
    description: "How software agents read DNO: which endpoint, which fields, how often, what the unknown states mean, and how to repeat the method."
  },
  "/docs": {
    title: "API · Demos Network Oracle",
    description: "Every route the public site serves, read-only, served with CORS for any origin: JSON unless noted, and the pages are HTML."
  }
};
export const SITE_ROUTES = Object.keys(SITE_META);

// The share card says what DNO is and nothing about any reading (W2-2).
export const SHARE_CARD = { width: 1200, height: 630, alt: "DNO, Demos Network Oracle: independent observability, not an official Demos product." };

// The head tags for one route. assets: { share: "/assets/dno-share-….jpg", touch: "/assets/dno-touch-icon-….png" }.
// An unknown route gets no tags: a page that is not in the table is not offered for sharing.
export function pageMeta(route, assets) {
  var m = Object.prototype.hasOwnProperty.call(SITE_META, route) ? SITE_META[route] : null;
  assets = assets || {};
  var touch = assets.touch ? '<link rel="apple-touch-icon" sizes="180x180" href="' + escHtml(assets.touch) + '">' : "";
  if (!m) return touch;
  var url = PUBLIC_ORIGIN + route, d = escHtml(m.description), t = escHtml(m.title);
  return '<meta name="description" content="' + d + '">'
    + '<link rel="canonical" href="' + escHtml(url) + '">'
    + '<meta property="og:site_name" content="Demos Network Oracle">'
    + '<meta property="og:type" content="website">'
    + '<meta property="og:title" content="' + t + '">'
    + '<meta property="og:description" content="' + d + '">'
    + '<meta property="og:url" content="' + escHtml(url) + '">'
    + (assets.share ? '<meta property="og:image" content="' + escHtml(PUBLIC_ORIGIN + assets.share) + '">'
      + '<meta property="og:image:width" content="' + SHARE_CARD.width + '"><meta property="og:image:height" content="' + SHARE_CARD.height + '">'
      + '<meta property="og:image:alt" content="' + escHtml(SHARE_CARD.alt) + '">' : "")
    + '<meta name="twitter:card" content="' + (assets.share ? "summary_large_image" : "summary") + '">'
    + touch;
}

// The 11 canonical URLs. No lastmod: DNO keeps no page edit dates, and a date nothing backs would be a claim.
export function sitemapXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + SITE_ROUTES.map(function(r) { return "  <url><loc>" + escHtml(PUBLIC_ORIGIN + r) + "</loc></url>\n"; }).join("")
    + "</urlset>\n";
}

// /favicon.ico: an ICO container holding one PNG image (allowed since Windows Vista; every current browser reads it).
// 6-byte header (reserved 0, type 1 = icon, count 1), one 16-byte entry, then the PNG bytes unchanged.
export function icoFromPng(png) {
  var w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  var head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(w >= 256 ? 0 : w, 6); head.writeUInt8(h >= 256 ? 0 : h, 7);
  head.writeUInt8(0, 8); head.writeUInt8(0, 9); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

// Browsers asking for an address nothing serves get a page in the site's shell; every other client keeps the JSON
// body it always had. shell: { head, header, footer } from the agent's site kit (header and footer with no page active).
export const NOT_FOUND_JSON = JSON.stringify({ error: "Not found. Try /docs for API documentation." });
export function wantsHtml(accept) { return typeof accept === "string" && /\btext\/html\b/i.test(accept); }
export function notFoundPage(shell, pages) {
  shell = shell || {};
  var list = (pages || []).map(function(p) { return '<li><a href="' + escHtml(p[0]) + '">' + escHtml(p[2]) + '</a></li>'; }).join("");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found · Demos Network Oracle</title>'
    + '<meta name="robots" content="noindex">' + (shell.head || "") + '<style>.nf-body{padding-block:40px 72px}</style></head><body>' + (shell.header || "")
    + '<main id="main"><header class="doc-head"><div class="wrap"><div><p class="doc-kicker">404</p><h1>Page not found</h1>'
    + '<p class="doc-lede">Nothing is served at this address. The pages are listed below; the API routes are on <a href="/docs">/docs</a>.</p>'
    + '</div></div></header><div class="wrap nf-body"><div class="prose"><section><ul>' + list + '</ul></section></div></div></main>'
    + (shell.footer || "") + '</body></html>';
}
