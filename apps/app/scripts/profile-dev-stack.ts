#!/usr/bin/env tsx
/** Build and serve the production client behind a same-origin dev-stack gateway. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { getApiRouteOwner } from "../src/server/api-route-ownership";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireEnvironment(): { listenPort: number; apiOrigin: URL } {
  const listenPort = Number(process.env.PORT);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error("The production-client gateway requires the PORT assigned by Portless.");
  }

  const rawApiOrigin = process.env.MERIDIAN_API_ORIGIN;
  if (!rawApiOrigin) throw new Error("MERIDIAN_API_ORIGIN is required.");
  const apiOrigin = new URL(rawApiOrigin);
  if (apiOrigin.protocol !== "https:") {
    throw new Error("MERIDIAN_API_ORIGIN must use HTTPS for a Portless dev stack.");
  }

  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caPath || !fs.existsSync(caPath)) {
    throw new Error(
      "Portless must provide NODE_EXTRA_CA_CERTS so SSR and proxied API requests trust its CA.",
    );
  }

  return { listenPort, apiOrigin };
}

async function reserveEphemeralPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an app port.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function proxyHeaders(request: IncomingMessage, target: URL, changeOrigin: boolean) {
  return {
    ...request.headers,
    ...(changeOrigin ? { host: target.host } : {}),
  };
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  origin: URL,
  changeOrigin: boolean,
): void {
  const target = new URL(request.url ?? "/", origin);
  const requestImpl = target.protocol === "https:" ? https.request : http.request;
  const upstream = requestImpl(
    target,
    {
      method: request.method,
      headers: proxyHeaders(request, target, changeOrigin),
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 500,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    if (!response.writableEnded) response.end(`Production-client gateway failed: ${error.message}`);
  });
  request.pipe(upstream);
}

function proxyUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, origin: URL): void {
  const target = new URL(request.url ?? "/", origin);
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const upstream =
    target.protocol === "https:"
      ? tls.connect({ host: target.hostname, port, servername: target.hostname })
      : net.connect({ host: target.hostname, port });

  upstream.once("connect", () => {
    const headers = proxyHeaders(request, target, true);
    const lines = [`${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", (error) => {
    if (socket.writable) {
      socket.end(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProduction-client WebSocket gateway failed: ${error.message}`,
      );
    }
  });
}

function waitForExit(child: ChildProcess, description: string, isStopping: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (isStopping()) {
        resolve();
        return;
      }
      reject(new Error(`${description} exited (code=${code}, signal=${signal}).`));
    });
  });
}

async function main(): Promise<void> {
  const { listenPort, apiOrigin } = requireEnvironment();
  const build = spawnSync("pnpm", ["build"], {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error(`Production client build failed (code=${build.status}).`);

  const appPort = await reserveEphemeralPort();
  const appOrigin = new URL(`http://127.0.0.1:${appPort}`);
  const app = spawn("node", [".output/server/index.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      // Only the built client must be production-mode. The local server keeps
      // dev login and debug routes available against the worktree server.
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(appPort),
    },
    stdio: "inherit",
  });

  const gateway = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://gateway.local").pathname;
    const serverOwned = getApiRouteOwner(pathname) === "server";
    proxyHttp(request, response, serverOwned ? apiOrigin : appOrigin, serverOwned);
  });
  gateway.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://gateway.local").pathname;
    if (getApiRouteOwner(pathname) !== "server") {
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, apiOrigin);
  });

  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(listenPort, "127.0.0.1", resolve);
  });
  console.log(
    `Production client gateway listening on http://127.0.0.1:${listenPort} (app ${appOrigin.origin}, API ${apiOrigin.origin})`,
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
    gateway.close();
    if (!app.killed) app.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await waitForExit(app, "Production app server", () => stopping);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
