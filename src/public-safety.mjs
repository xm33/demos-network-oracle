// public-safety.mjs — small, pure helpers for everything that crosses DNO's public boundary.
//
// Two directions:
//   in  — values that arrive from peers (/info documents, peerlists) before they are stored or rendered;
//   out — values DNO serves (HTML cells, error strings, identities, admin checks).
// No module state. The only I/O is the optional DNS lookup in resolvePublicProbeOrigin(), which callers
// can replace for tests. Runtime tests: bun src/public-safety.test.mjs

import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

// ---- identities --------------------------------------------------------------------------------------
// A Demos identity is 0x followed by 64 hex characters. Anything else from a peerlist is not stored.
export const IDENTITY_RE = /^0x[0-9a-fA-F]{64}$/;
export function isValidIdentity(id) { return typeof id === "string" && IDENTITY_RE.test(id); }

// Public form used on every surface: first 6 characters, an ellipsis, last 4 ("0xabcd…1234").
export function truncIdentity(id) {
  if (typeof id !== "string" || id.length < 12) return "—";
  return id.substring(0, 6) + "…" + id.substring(id.length - 4);
}

// ---- heights and short strings from peers ------------------------------------------------------------
// Heights come from documents DNO does not control. Only safe non-negative integers survive;
// anything else (strings, HTML, negatives, NaN, floats, huge values) becomes null = "not observed".
export function sanitizeHeight(value) {
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Short peer-reported labels (sync status, version). Printable, conservative charset, bounded length.
export function sanitizeLabel(value, maxLen) {
  if (typeof value !== "string") return null;
  var s = value.trim();
  var max = maxLen || 32;
  if (!s || s.length > max) return null;
  return /^[A-Za-z0-9 ._:+\-()]+$/.test(s) ? s : null;
}

// ---- output escaping ---------------------------------------------------------------------------------
export function escHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---- probe errors ------------------------------------------------------------------------------------
// Raw fetch errors carry runtime text ("Unable to connect. Is the computer able to access the url?")
// and sometimes addresses. Public surfaces get a category only.
export function probeErrorCategory(err, httpStatus) {
  if (Number.isInteger(httpStatus)) return "HTTP " + httpStatus;
  if (!err) return "no answer";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  if (err instanceof RangeError) return "response too large";
  if (err instanceof SyntaxError) return "invalid response";
  return "connection failed";
}

// ---- admin token -------------------------------------------------------------------------------------
// An admin route is open only when a token of at least 16 characters is configured and the presented
// value matches it exactly. Unset or empty configuration never matches (fail closed).
export const MIN_ADMIN_TOKEN_LENGTH = 16;
export function adminTokenMatches(presented, configured) {
  if (typeof configured !== "string" || configured.length < MIN_ADMIN_TOKEN_LENGTH) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  var a = Buffer.from(presented, "utf8"), b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- outbound probes to peer-advertised addresses ---------------------------------------------------
function ipv4ToInt(ip) {
  var p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inV4(ip, base, bits) {
  var mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}
const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];
function expandV6(ip) {
  var s = ip.toLowerCase().split("%")[0];
  var v4tail = null;
  var m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) { v4tail = m[1]; s = s.slice(0, -m[1].length) + "0:0"; }
  var halves = s.split("::");
  if (halves.length > 2) return null;
  var head = halves[0] ? halves[0].split(":") : [];
  var tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  var fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  var groups = head.concat(new Array(fill).fill("0"), tail).map(function(g) { return parseInt(g || "0", 16); });
  if (groups.length !== 8 || groups.some(function(g) { return !(g >= 0 && g <= 0xffff); })) return null;
  return { groups: groups, v4tail: v4tail };
}
export function isPublicIp(ip) {
  var kind = isIP(ip);
  if (kind === 4) return !V4_BLOCKED.some(function(r) { return inV4(ip, r[0], r[1]); });
  if (kind !== 6) return false;
  var x = expandV6(ip);
  if (!x) return false;
  var g = x.groups;
  var allZeroHead = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (allZeroHead && g[5] === 0xffff) {                       // ::ffff:a.b.c.d (IPv4-mapped)
    var v4 = x.v4tail || [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
    return isPublicIp(v4);
  }
  if (g.every(function(v) { return v === 0; })) return false;  // ::
  if (allZeroHead && g[5] === 0 && g[6] === 0 && g[7] === 1) return false; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false;               // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false;               // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return false;               // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;       // 2001:db8::/32 documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // 100::/64 discard
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false;       // 64:ff9b::/96 NAT64
  return true;
}

// Peer-advertised connection strings become probe targets only when they are a bare origin
// (http(s)://host:port, no credentials, path, query or fragment) that resolves to public addresses only.
// resolvePublicProbeOrigin() returns the origin pinned to the address it checked, so the probe connects to that
// address and the name is not resolved a second time (no DNS rebinding between check and connect). Callers must
// also refuse redirects (fetch option redirect: "manual"), or a public address could forward the probe inward.
export function parseProbeOrigin(connection) {
  if (typeof connection !== "string") return null;
  var s = connection.trim();
  if (!s || s.length > 200) return null;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  var u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (!u.hostname) return null;
  return u;
}

export async function resolvePublicProbeOrigin(connection, lookupFn) {
  var u = parseProbeOrigin(connection);
  if (!u) return null;
  var host = u.hostname.replace(/^\[|\]$/g, "");
  var addrs;
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = (await (lookupFn || dnsLookup)(host, { all: true })).map(function(a) { return a.address; }); }
    catch (e) { return null; }
  }
  if (!addrs.length || !addrs.every(isPublicIp)) return null;
  // Only plain http is probed: a pinned https origin fails its certificate check (hostname) or rarely has one (IP).
  if (u.protocol !== "http:") return null;
  var ip = addrs[0];
  return u.protocol + "//" + (isIP(ip) === 6 ? "[" + ip + "]" : ip) + (u.port ? ":" + u.port : "");
}

// Parse a JSON response without holding more than maxBytes of it: a peer that streams an endless body fails with a
// RangeError instead of exhausting memory.
export async function readJsonCapped(resp, maxBytes) {
  var declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RangeError("response larger than " + maxBytes + " bytes");
  if (!resp.body) return JSON.parse("");
  var reader = resp.body.getReader(), chunks = [], total = 0;
  for (;;) {
    var part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch (e) {} throw new RangeError("response larger than " + maxBytes + " bytes"); }
    chunks.push(Buffer.from(part.value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Run async jobs with at most `limit` in flight.
export async function mapWithConcurrency(items, limit, fn) {
  var out = new Array(items.length), next = 0;
  async function worker() {
    while (next < items.length) { var i = next++; out[i] = await fn(items[i], i); }
  }
  var n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
