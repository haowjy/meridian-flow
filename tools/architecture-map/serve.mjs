#!/usr/bin/env node
import { createServer } from "node:http";
import { createArchitectureServer, ENTRY, send } from "./server.mjs";

const [configFile, port = "4848"] = process.argv.slice(2);
if (!configFile) {
  console.error("usage: serve.mjs <path to map.config.mjs> [port]");
  process.exit(1);
}
const handle = await createArchitectureServer(configFile);
// keep: answer only our own host names, or another origin's page can point its name at 127.0.0.1 and read this
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
createServer((req, res) => {
  if (!hosts.has(req.headers.host)) {
    res.statusCode = 403;
    res.end("Unknown host");
    return;
  }
  const result =
    req.method === "GET" || req.method === "HEAD" ? handle(req.url.split(/[?#]/)[0]) : null;
  if (result) send(req, res, result);
  else {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(Number(port), "127.0.0.1", () => console.log(`http://localhost:${port}${ENTRY}`));
