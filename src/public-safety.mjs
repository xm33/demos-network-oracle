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
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

// ---- identities --------------------------------------------------------------------------------------
// A Demos identity is 0x followed by 64 hex characters. Anything else from a peerlist is not stored.
export const IDENTITY_RE = /^0x[0-9a-fA-F]{64}$/;
export function isValidIdentity(id) { return typeof id === "string" && IDENTITY_RE.test(id); }
// The comparison form of a key: trimmed, lower case, without a leading 0x. Used only to compare, never published. One
// function for every "is this the listed key" question: the validator watch, the seed read and the witness read.
export function keyOf(value) {
  if (typeof value !== "string") return null;
  var s = value.trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-z]{1,128}$/.test(s) ? s : null;
}

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
// A version as releases name them (0.9.9, v1.2, 0.9.9 RC, 1.0.0-beta.2). Anything else is "no version": a node's free
// text never reaches a public surface as its version (four numbers and a port would pass sanitizeLabel).
const VERSION_RE = /^v?\d{1,2}\.\d{1,3}(\.\d{1,3})?([ -]?(rc|beta|alpha)[ .]?\d{0,2})?$/i;
export function versionOf(value) { return typeof value === "string" && VERSION_RE.test(value.trim()) ? value.trim() : null; }
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
// "internal error": a TypeError or ReferenceError. The runtime's fetch reports a peer that cannot be reached as a plain
// Error with a code, so these are a fault in DNO's own read (or a configured URL that is not one), and saying
// "connection failed" about the peer would be false. On 2026-10-01 every seed read threw a TypeError and was published
// as "connection failed".
export function probeErrorCategory(err, httpStatus) {
  if (Number.isInteger(httpStatus)) return "HTTP " + httpStatus;
  if (!err) return "no answer";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  if (err.name === "ResponseTooLarge") return "response too large";
  if (err instanceof SyntaxError || err instanceof RangeError) return "invalid response";  // RangeError: e.g. nesting too deep
  if (isInternalError(err)) return "internal error";
  return "connection failed";
}
// A fault in DNO's own code, as against anything a peer or the network can cause. The address check has the same line:
// a name that does not resolve is the peer's address; a TypeError or ReferenceError while checking it is not.
export function isInternalError(err) { return err instanceof TypeError || err instanceof ReferenceError; }

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
  if (allZeroHead && g[5] === 0) return false;                // ::/96: ::, ::1 and IPv4-compatible ::a.b.c.d (deprecated)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) return false; // ::ffff:0:a.b.c.d (IPv4-translated)
  if ((g[0] & 0xfe00) === 0xfc00) return false;               // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false;               // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return false;               // fec0::/10 site local (deprecated)
  if (g[0] === 0x2002) return false;                          // 2002::/16 6to4: carries an IPv4 address of any kind
  if (g[0] === 0x2001 && g[1] === 0) return false;            // 2001::/32 Teredo: carries an IPv4 address of any kind
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
// It resolves to null for an address it refuses and rejects only with a fault of its own (isInternalError): a caller
// must not read that rejection as "the address is not public".
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
    // A name that does not resolve is refused. A fault in DNO's own call is thrown on: it says nothing about the name
    // (the runtime's lookup rejects with a plain Error and a code such as ENOTFOUND for a name it cannot resolve).
    try { addrs = (await (lookupFn || dnsLookup)(host, { all: true })).map(function(a) { return a.address; }); }
    catch (e) { if (isInternalError(e)) throw e; return null; }
  }
  if (!addrs.length || !addrs.every(isPublicIp)) return null;
  // Only plain http is probed: a pinned https origin fails its certificate check (hostname) or rarely has one (IP).
  if (u.protocol !== "http:") return null;
  var ip = addrs[0];
  return u.protocol + "//" + (isIP(ip) === 6 ? "[" + ip + "]" : ip) + (u.port ? ":" + u.port : "");
}

// DNO's own reads use the runtime's fetch, never the global one. Importing the Demos SDK replaces globalThis.fetch
// (@bundlr-network/client -> near-api-js/lib/connect.js sets it to its node-fetch import, which under Bun is the
// runtime's node-fetch shim). That replacement's bodies are Node streams, which readJsonCapped cannot read: on
// 2026-10-01 every capped read threw. Bun.fetch is the runtime's own and is not replaced. Every capped read goes
// through nativeFetch.
export const nativeFetch = typeof Bun !== "undefined" && typeof Bun.fetch === "function" ? Bun.fetch.bind(Bun) : globalThis.fetch.bind(globalThis);

// Bodies DNO reads from peers are capped, and cappedJson() below is the one way to read one. It fetches with
// CAPPED_FETCH_OPTIONS (identity encoding is requested and the runtime must not expand a compressed body before the cap
// applies) and parses with readJsonCapped(): at most maxBytes are read from the wire and at most maxBytes are produced
// by decompression. Past the cap the error is named ResponseTooLarge; a peer streaming an endless or highly compressed
// body cannot exhaust memory.
// No kept connection: the connection is closed when the read ends. Kept open, it stays in the runtime's pool, and a peer
// that goes on sending after a complete response is received for as long as it sends. The runtime decides this by the
// request's Connection header when there is one, and by the keepalive option only when there is none, so both are fixed.
export const CAPPED_FETCH_OPTIONS = Object.freeze({ decompress: false, keepalive: false, headers: Object.freeze({ "Accept-Encoding": "identity", "Connection": "close" }) });
function responseTooLarge(maxBytes) { var e = new Error("response larger than " + maxBytes + " bytes"); e.name = "ResponseTooLarge"; return e; }
// One capped read with the runtime's fetch, and the only way DNO makes one. Resolves to { status, ok, headersMs, data }:
// data is the parsed JSON body when the status is read (2xx, or opts.read(status)), else undefined. It throws what the
// fetch or readJsonCapped throw (TimeoutError, ResponseTooLarge, SyntaxError, ...). On every path the request is aborted
// before this returns: cancelling a body does not make the runtime stop receiving it, so a response that is not read to
// its end (a status that is not read, a declared or streamed size past the cap) would be buffered until the timeout.
// Redirects are never followed: a 3xx is a status like any other (not ok, no data). An answer may not send DNO's read to
// another address, a loopback or private one included; the caller's init cannot turn this off.
// opts: { timeoutMs (5 s), maxBytes (2 MB), read(status) -> boolean, fetch } (fetch defaults to nativeFetch; tests may
// pass another). A call that names no cap is still capped.
export const CAPPED_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export async function cappedJson(url, init, opts) {
  var o = opts || {}, ctl = new AbortController(), started = Date.now();
  var maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : CAPPED_DEFAULT_MAX_BYTES;
  var timer = setTimeout(function() { ctl.abort(new DOMException("The operation timed out.", "TimeoutError")); }, o.timeoutMs || 5000);
  try {
    // The fixed options come last, so a caller's init cannot change them: no automatic decompression, no redirect, no
    // kept connection, this read's own signal (a caller's signal is not used), and identity encoding and a closed
    // connection whatever case the caller named those headers in.
    var headers = new Headers((init && init.headers) || {});
    Object.keys(CAPPED_FETCH_OPTIONS.headers).forEach(function(k) { headers.set(k, CAPPED_FETCH_OPTIONS.headers[k]); });
    var resp = await (o.fetch || nativeFetch)(url, Object.assign({}, init || {}, {
      decompress: CAPPED_FETCH_OPTIONS.decompress, keepalive: CAPPED_FETCH_OPTIONS.keepalive, redirect: "manual", signal: ctl.signal, headers: headers }));
    var out = { status: resp.status, ok: resp.ok, headersMs: Date.now() - started, data: undefined };
    if (o.read ? o.read(resp.status) : resp.ok) out.data = await readJsonCapped(resp, maxBytes);
    return out;
  } finally { clearTimeout(timer); try { ctl.abort(); } catch (e) {} }
}
export async function readJsonCapped(resp, maxBytes) {
  var declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw responseTooLarge(maxBytes);
  var raw = Buffer.alloc(0);
  if (resp.body) {
    var reader = resp.body.getReader(), chunks = [], total = 0;
    for (;;) {
      var part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch (e) {} throw responseTooLarge(maxBytes); }
      chunks.push(Buffer.from(part.value));
    }
    raw = Buffer.concat(chunks);
  }
  var enc = String(resp.headers.get("content-encoding") || "").trim().toLowerCase();
  var i = 0; while (i < raw.length && (raw[i] === 32 || raw[i] === 9 || raw[i] === 10 || raw[i] === 13)) i++;
  var plain = !enc || enc === "identity" || raw[i] === 123 || raw[i] === 91;   // "{" or "[": not encoded, or already decoded
  var text;
  if (plain) text = raw.toString("utf8");
  else {
    var zopts = { maxOutputLength: maxBytes };
    try {
      if (enc === "gzip" || enc === "x-gzip") text = gunzipSync(raw, zopts).toString("utf8");
      else if (enc === "deflate") text = inflateSync(raw, zopts).toString("utf8");
      else if (enc === "br") text = brotliDecompressSync(raw, zopts).toString("utf8");
      else throw new SyntaxError("unsupported content-encoding");
    } catch (e) {
      if (e && e.code === "ERR_BUFFER_TOO_LARGE") throw responseTooLarge(maxBytes);
      throw new SyntaxError("body could not be decoded");
    }
  }
  return JSON.parse(text);
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
