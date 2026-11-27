// Node cuts a request body after 300 s, which a browser's signed PUT of a large file over a slow uplink exceeds; Nitro exposes no server, so every server this process creates gets the longer limit
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

const createServer = http.createServer;
http.createServer = (...args) => {
  const server = createServer(...args);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
};
syncBuiltinESMExports();
