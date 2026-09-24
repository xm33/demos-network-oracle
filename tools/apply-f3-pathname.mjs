// apply-f3-pathname.mjs — rewrite agent.mjs HTTP router to use pathname.
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun apply-f3-pathname.mjs src/agent.mjs");
  process.exit(2);
}
let src = readFileSync(path, "utf8");

if (/var\s+reqPath\s*=\s*reqUrl\.pathname/.test(src)) {
  console.error("abort: reqPath already present — already applied?");
  process.exit(3);
}
if (!/if \(req\.url === "\/health"\)/.test(src)) {
  console.error("abort: expected if (req.url === \"/health\") not found — pin mismatch");
  process.exit(4);
}

const insert = `    // F-3: route on pathname so query strings do not 404 exact-match routes.
    var reqUrl = new URL(req.url, "http://d");
    var reqPath = reqUrl.pathname;
    var reqQuery = reqUrl.searchParams;

`;

src = src.replace(
  `    res.setHeader("Content-Type", "application/json");

    if (req.url === "/health") {`,
  `    res.setHeader("Content-Type", "application/json");

` + insert + `    if (reqPath === "/health") {`
);

src = src.replaceAll("req.url === ", "reqPath === ");

src = src.replace(
  `    } else if (req.url.indexOf("/incidents") === 0) {
      var incParams = new URLSearchParams(req.url.split("?")[1] || "");`,
  `    } else if (reqPath === "/incidents" || reqPath.indexOf("/incidents/") === 0) {
      var incParams = reqQuery;`
);

src = src.replace(
  `    } else if (req.url.startsWith("/private/commerce/status")) {
      var pcUrl = new URL(req.url, "http://d"); var pcTk = pcUrl.searchParams.get("token");`,
  `    } else if (reqPath === "/private/commerce/status" || reqPath.indexOf("/private/commerce/status/") === 0) {
      var pcTk = reqQuery.get("token");`
);

src = src.replace(
  `    } else if (req.url.indexOf("/history/export") === 0) {} else if (req.url.indexOf("/history/export") === 0) {
      var expFrom = 0, expTo = Infinity;
      var fromIdx = req.url.indexOf("from=");
      var toIdx = req.url.indexOf("to=");
      if (fromIdx !== -1) expFrom = parseInt(req.url.substring(fromIdx + 5), 10) || 0;
      if (toIdx !== -1) expTo = parseInt(req.url.substring(toIdx + 3), 10) || Infinity;`,
  `    } else if (reqPath === "/history/export" || reqPath.indexOf("/history/export/") === 0) {
      var expFrom = 0, expTo = Infinity;
      if (reqQuery.get("from")) expFrom = parseInt(reqQuery.get("from"), 10) || 0;
      if (reqQuery.get("to")) expTo = parseInt(reqQuery.get("to"), 10) || Infinity;`
);

if (/req\.url === /.test(src) || /req\.url\.indexOf/.test(src) || /req\.url\.startsWith/.test(src)) {
  console.error("abort: leftover req.url route compare after rewrite");
  process.exit(5);
}
if (!/reqPath === "\/health"/.test(src)) {
  console.error("abort: /health pathname match missing after rewrite");
  process.exit(6);
}

writeFileSync(path, src);
console.log("F-3 pathname router applied to " + path);
