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
  if (
    process.env.NODE_ENV === "production" ||
    process.env.APP_ENV !== "dev" ||
    process.env.MERIDIAN_LOCAL_DEV_STACK !== "1"
  ) {
    throw new Error("The production-client profiler runs only in a local development stack.");
  }

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
  if (!/^(?:[a-z0-9-]+\.)?server\.meridian\.localhost$/.test(apiOrigin.hostname)) {
    throw new Error("MERIDIAN_API_ORIGIN must name this checkout's local Portless server.");
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

function proxyUpgrade(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  origin: URL,
  connections: Set<() => void>,
): void {
  const target = new URL(request.url ?? "/", origin);
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const upstream =
    target.protocol === "https:"
      ? tls.connect({ host: target.hostname, port, servername: target.hostname })
      : net.connect({ host: target.hostname, port });

  let responseStarted = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    connections.delete(close);
    socket.destroy();
    upstream.destroy();
  };
  connections.add(close);

  socket.once("error", close);
  socket.once("close", close);
  upstream.once("data", () => {
    responseStarted = true;
  });
  upstream.once("error", (error) => {
    if (!responseStarted && socket.writable && !socket.destroyed) {
      const body = `Production-client WebSocket gateway failed: ${error.message}`;
      upstream.removeListener("close", close);
      socket.end(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        close,
      );
      return;
    }
    close();
  });
  upstream.once("close", close);

  const connectEvent = target.protocol === "https:" ? "secureConnect" : "connect";
  upstream.once(connectEvent, () => {
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
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function observeChild(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function waitForChild(exit: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    exit.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function stopChild(child: ChildProcess, exit: Promise<ChildExit>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChild(exit, 5_000)) return;
  child.kill("SIGKILL");
  await waitForChild(exit, 2_000);
}

async function closeGateway(gateway: http.Server, connections: Set<() => void>): Promise<void> {
  for (const close of [...connections]) close();
  await new Promise<void>((resolve, reject) => {
    gateway.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
        reject(error);
      else resolve();
    });
    gateway.closeAllConnections();
  });
}

async function stopResources(
  gateway: http.Server,
  connections: Set<() => void>,
  child: ChildProcess,
  childExit: Promise<ChildExit>,
): Promise<void> {
  const results = await Promise.allSettled([
    closeGateway(gateway, connections),
    stopChild(child, childExit),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, "Production-client cleanup failed.");
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
  const appExit = observeChild(app);
  const connections = new Set<() => void>();

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
    proxyUpgrade(request, socket, head, apiOrigin, connections);
  });

  const gatewayError = new Promise<Error>((resolve) => gateway.once("error", resolve));
  const listening = new Promise<void>((resolve) => {
    gateway.listen(listenPort, "127.0.0.1", resolve);
  });
  let requestStop: (() => void) | undefined;
  const stopping = new Promise<void>((resolve) => {
    requestStop = resolve;
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  try {
    const startup = await Promise.race([
      listening.then(() => "listening" as const),
      appExit.then((exit) => ({ appExit: exit })),
      gatewayError.then((error) => ({ gatewayError: error })),
      stopping.then(() => "stopping" as const),
    ]);
    if (startup === "stopping") return;
    if (startup !== "listening") {
      if ("gatewayError" in startup) throw startup.gatewayError;
      const { code, signal, error } = startup.appExit;
      throw error ?? new Error(`Production app server exited (code=${code}, signal=${signal}).`);
    }

    console.log(
      `Production client gateway listening on http://127.0.0.1:${listenPort} (app ${appOrigin.origin}, API ${apiOrigin.origin})`,
    );

    const outcome = await Promise.race([
      appExit.then((exit) => ({ appExit: exit })),
      gatewayError.then((error) => ({ gatewayError: error })),
      stopping.then(() => "stopping" as const),
    ]);
    if (outcome === "stopping") return;
    if ("gatewayError" in outcome) throw outcome.gatewayError;
    const { code, signal, error } = outcome.appExit;
    throw error ?? new Error(`Production app server exited (code=${code}, signal=${signal}).`);
  } finally {
    if (requestStop) {
      process.removeListener("SIGINT", requestStop);
      process.removeListener("SIGTERM", requestStop);
    }
    await stopResources(gateway, connections, app, appExit);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
