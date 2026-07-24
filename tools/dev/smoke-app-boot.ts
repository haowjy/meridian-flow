#!/usr/bin/env tsx
/**
 * App-boot smoke — boots the @meridian/app dev server far enough to SSR-render a
 * real routes, then asserts their exact public contract.
 *
 * `pnpm check` (lint + typecheck + unit tests) never boots the running app, so a
 * regression that only manifests at app runtime — a module that fails to
 * load/transform, a route that throws while server-rendering — passes green.
 * This smoke closes that gap cheaply: it starts `vite dev`, waits for the server
 * to listen, and requests `/` (auth redirect) and `/login` (a full SSR render
 * that pulls the document shell, its Lingui `Trans` macro, and the login page
 * through the dev transform pipeline). A broken module transform surfaces as a
 * 5xx on those routes even without authentication or a reachable database.
 *
 * Scope: this is the phase-1 boot check from issue #85 — it catches
 * transform/wiring-class breaks (e.g. the Babel-8 Lingui-macro regression that
 * 500'd the dev server). It does NOT log in or load an authenticated route, so
 * render crashes behind auth (the react-virtuoso-class regression) are out of
 * scope and would need a headless-browser phase gated on WorkOS dev secrets.
 *
 *   pnpm smoke:app-boot
 */

import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { APP_BOOT_ROUTES, routeContractFailure } from "./lib/app-boot-contract";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const HOST = "127.0.0.1";
/** Vite must report its bound address within this window or boot has failed. */
const READY_TIMEOUT_MS = 90_000;
/** First SSR request triggers on-demand transforms; allow a generous per-request budget. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How much of the child's captured output to echo when the smoke fails. */
const LOG_TAIL_LINES = 60;

/**
 * Dev-boot placeholders applied only when unset. The dev app skips production
 * env validation (NODE_ENV != production), so these let CI boot without WorkOS
 * secrets or a database — the smoke exercises the transform/render path, not
 * auth or persistence. DATABASE_URL is set but intentionally need not resolve.
 *
 * The WORKOS_* keys satisfy `@workos/authkit-session` ConfigurationProvider.validate,
 * which runs unconditionally in `meridianAuthkitMiddleware` regardless of
 * NODE_ENV — apiKey, clientId, redirectUri, and cookiePassword are all
 * `requiredKeys`, and cookiePassword must be >= 32 chars. Values here are
 * fake and never contact WorkOS: the smoke never authenticates.
 */
const BOOT_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: `postgresql://smoke:smoke@${HOST}:1/app_boot_smoke`,
  WORKOS_API_KEY: "sk_test_app_boot_smoke",
  WORKOS_CLIENT_ID: "client_ci",
  WORKOS_COOKIE_PASSWORD: "app-boot-smoke-cookie-password-000000000000",
  WORKOS_REDIRECT_URI: `http://${HOST}:1/api/auth/callback`,
  MERIDIAN_API_ORIGIN: `http://${HOST}:1`,
};

class RingLog {
  private lines: string[] = [];
  push(chunk: string): void {
    for (const line of chunk.split("\n")) this.lines.push(line);
    if (this.lines.length > LOG_TAIL_LINES) {
      this.lines = this.lines.slice(this.lines.length - LOG_TAIL_LINES);
    }
  }
  tail(): string {
    return this.lines.join("\n");
  }
}

async function fetchStatus(
  url: string,
): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    const body = await response.text();
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function reserveEphemeralPort(): Promise<number> {
  const reservation = net.createServer();
  return new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: HOST, port: 0, exclusive: true }, () => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        reservation.close();
        reject(new Error("Could not resolve an OS-assigned app smoke port."));
        return;
      }
      reservation.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function assertChildAlive(child: ChildProcess, phase: string): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `App dev server exited ${phase} (code=${child.exitCode}, signal=${child.signalCode}).`,
    );
  }
}

/** Resolve the actual address Vite reports after it has bound its HTTP server. */
function waitForBoundOrigin(child: ChildProcess, log: RingLog): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`App dev server did not bind within ${READY_TIMEOUT_MS}ms.\n${log.tail()}`));
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (!match) return;
      cleanup();
      resolve(match[1].replace(/\/$/, ""));
    };
    const onExit = () => {
      cleanup();
      reject(
        new Error(
          `App dev server exited before reporting its bound address (code=${child.exitCode}, signal=${child.signalCode}).\n${log.tail()}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
}

async function main(): Promise<void> {
  const repoRoot = resolveCurrentRepoRoot();
  applyDevEnvToProcess(repoRoot);
  for (const [key, value] of Object.entries(BOOT_ENV_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = value;
  }
  const port = await reserveEphemeralPort();

  const log = new RingLog();
  const child = spawn("pnpm", ["--filter", "@meridian/app", "exec", "vite", "dev"], {
    cwd: repoRoot,
    env: { ...process.env, HOST, PORT: String(port), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => log.push(d.toString()));

  try {
    const origin = await waitForBoundOrigin(child, log);
    assertChildAlive(child, "after binding");

    const failures: string[] = [];
    for (const route of APP_BOOT_ROUTES) {
      assertChildAlive(child, `before checking ${route.path}`);
      const result = await fetchStatus(`${origin}${route.path}`);
      if (!result.ok) {
        failures.push(`${route.path}: request failed (${result.error})`);
        continue;
      }
      assertChildAlive(child, `while checking ${route.path}`);
      const failure = routeContractFailure({
        path: route.path,
        expectedStatus: route.status,
        actualStatus: result.status,
        body: result.body,
        bodyMarker: "bodyMarker" in route ? route.bodyMarker : undefined,
      });
      if (failure) failures.push(`${failure}\n${result.body.slice(0, 800)}`);
      else console.log(`  ${route.path} -> ${result.status}`);
    }

    assertChildAlive(child, "at contract completion");
    if (failures.length > 0) {
      throw new Error(`App-boot smoke failed:\n${failures.join("\n")}\n\n${log.tail()}`);
    }
    console.log("App-boot smoke passed.");
  } finally {
    await stop(child);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
