#!/usr/bin/env node
/**
 * Serves the map without a dev server of your own: `node tools/architecture-map/serve.mjs <config> [port]`,
 * then open http://localhost:<port>/architecture/. Same server code as the Vite plugin.
 */
import { createServer } from "node:http";
import { createArchitectureServer, ENTRY, send } from "./server.mjs";

const [configFile, port = "4848"] = process.argv.slice(2);
if (!configFile) {
  console.error("usage: serve.mjs <path to map.config.mjs> [port]");
  process.exit(1);
}
const handle = await createArchitectureServer(configFile);
createServer((req, res) => {
  const result = req.method === "GET" || req.method === "HEAD" ? handle(req.url.split(/[?#]/)[0]) : null;
  if (result) send(req, res, result);
  else {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(Number(port), "127.0.0.1", () => console.log(`http://localhost:${port}${ENTRY}`));
