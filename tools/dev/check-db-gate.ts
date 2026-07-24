#!/usr/bin/env tsx
/**
 * DB-gate check — runs the Postgres-backed db-gate suites when a local database
 * is reachable, and skips loudly (exit 0) when it is not.
 *
 * The db-gate (`*.db.test.ts`, run via `pnpm test:db`) is a required CI gate,
 * but it was invisible to local `pnpm check`: a db-gate regression could ship
 * red CI across several pushes while every local check stayed green. Folding
 * this into `pnpm check` closes that gap for anyone with the dev Postgres up.
 *
 * It must NOT hard-fail a plain `pnpm check` where no database exists — a
 * contributor without `pnpm dev:infra` running, or CI's `quality` job (which
 * runs `pnpm check` with no Postgres service; the dedicated `db-tests` job runs
 * the gate with a database). So a missing/unreachable DB skips with a warning
 * rather than failing. `pnpm test:db` remains the way to force the gate.
 *
 *   pnpm check:db
 */

import { type ChildProcess, spawn } from "node:child_process";
import { parseTargetDatabase, pingDatabaseForUrl } from "./lib/dev-db";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

async function pings(url: string): Promise<boolean> {
  try {
    await pingDatabaseForUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reachable means the Postgres *server* is up, not that this checkout's own
 * database exists: `pnpm test:db` creates its own managed test database. So try
 * the configured URL first (fast path), then fall back to the server-level
 * maintenance connection so a not-yet-bootstrapped worktree still runs the gate.
 */
async function isReachable(databaseUrl: string): Promise<boolean> {
  if (await pings(databaseUrl)) return true;
  try {
    return await pings(parseTargetDatabase(databaseUrl).adminConnString);
  } catch {
    return false;
  }
}

function runTestDb(repoRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("pnpm", ["test:db"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`pnpm test:db exited on ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = resolveCurrentRepoRoot();
  applyDevEnvToProcess(repoRoot);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn(
      "db-gate: skipped — DATABASE_URL is not set. Start Postgres with `pnpm dev:infra` and set it in .env to run the gate locally; CI runs it in the db-tests job.",
    );
    return;
  }

  if (!(await isReachable(databaseUrl))) {
    console.warn(
      "db-gate: skipped — Postgres is not reachable at the configured DATABASE_URL. Run `pnpm dev:infra` to start it. Force the gate with `pnpm test:db`.",
    );
    return;
  }

  console.log("db-gate: Postgres reachable — running required DB suites.");
  process.exitCode = await runTestDb(repoRoot);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
