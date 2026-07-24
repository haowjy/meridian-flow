#!/usr/bin/env tsx
/**
 * App-boot smoke — boots the @meridian/app dev server far enough to SSR-render a
 * real route, then asserts it does not 500.
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
import { setTimeout as sleep } from "node:timers/promises";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 31734;
/** Server must accept a connection within this window or the boot has failed. */
const READY_TIMEOUT_MS = 90_000;
/** First SSR request triggers on-demand transforms; allow a generous per-request budget. */
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
/** How much of the child's captured output to echo when the smoke fails. */
const LOG_TAIL_LINES = 60;

/** Routes that must not 5xx. `/` redirects (auth); `/login` fully SSR-renders. */
const ASSERTED_ROUTES = ["/", "/login"];

/**
 * Dev-boot placeholders applied only when unset. The dev app skips production
 * env validation (NODE_ENV != production), so these let CI boot without WorkOS
 * secrets or a database — the smoke exercises the transform/render path, not
 * auth or persistence. DATABASE_URL is set but intentionally need not resolve.
 */
const BOOT_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: `postgresql://smoke:smoke@${HOST}:1/app_boot_smoke`,
  WORKOS_API_KEY: "sk_test_app_boot_smoke",
  WORKOS_CLIENT_ID: "client_ci",
  WORKOS_COOKIE_PASSWORD: "app-boot-smoke-cookie-password-000000000000",
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
    const body = response.status >= 500 ? await response.text() : "";
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve when the server accepts a connection; reject if it never listens. */
async function waitForListening(port: number, child: ChildProcess, log: RingLog): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `App dev server exited before it started listening (code=${child.exitCode}, signal=${child.signalCode}).\n${log.tail()}`,
      );
    }
    // Any HTTP response — even a 5xx — means the server is up; route assertions
    // below decide pass/fail. A connection error means it is still starting.
    const result = await fetchStatus(`http://${HOST}:${port}/healthz`);
    if (result.ok) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`App dev server did not listen within ${READY_TIMEOUT_MS}ms.\n${log.tail()}`);
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
  // vite.config reads server.port from PORT, so it overrides any --port flag.
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  process.env.PORT = String(port);

  const log = new RingLog();
  const child = spawn("pnpm", ["--filter", "@meridian/app", "exec", "vite", "dev"], {
    cwd: repoRoot,
    env: { ...process.env, HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => log.push(d.toString()));

  try {
    await waitForListening(port, child, log);

    const failures: string[] = [];
    for (const route of ASSERTED_ROUTES) {
      const result = await fetchStatus(`http://${HOST}:${port}${route}`);
      if (!result.ok) {
        failures.push(`${route}: request failed (${result.error})`);
        continue;
      }
      if (result.status >= 500) {
        failures.push(`${route}: ${result.status}\n${result.body.slice(0, 800)}`);
        continue;
      }
      console.log(`  ${route} -> ${result.status}`);
    }

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
