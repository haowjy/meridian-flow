// Preloaded by `pnpm dev` (NODE_OPTIONS). `nitro dev` listens in its main thread, and Node cuts a
// request whose body takes longer than 300 s to arrive (408). With the local object store a
// browser's signed PUT is such a request: a 200 MiB file on a slow uplink needs more. Nitro
// doesn't expose the server, so every server this process creates gets the longer limit.
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
