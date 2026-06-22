import { execFileSync } from "node:child_process";
import path from "node:path";
import { formatPgError, pingDatabaseForUrl, readAppliedMigrationHashes } from "./dev-db";
import { applyDevEnvToProcess, DEV_DATABASES, resolveCurrentRepoRoot } from "./dev-env";
import { describeMigrationDrift, readExpectedMigrationHashes } from "./migration-state";

/** Start the local postgres:16 container and wait until healthy. */
export function ensureDevInfraUp(repoRoot: string): void {
  const composeFile = path.join(repoRoot, "tools/dev/docker-compose.yml");
  execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "--wait"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

/** Thrown when the dev infra preflight fails; carries an actionable message. */
export class DevInfraNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevInfraNotReadyError";
  }
}

/**
 * Fail-fast infra preflight shared by `pnpm dev` (and reusable by CI/bootstrap):
 * confirm every registered dev database URL is set and reachable before any app
 * server starts, so a stopped Postgres surfaces as a clear up-front error
 * instead of a runtime `HTTPError` on the first DB-touching request.
 *
 * Read-only — it never starts the container or creates databases (that stays an
 * explicit `pnpm dev:infra` / `pnpm bootstrap` step). On failure it throws a
 * `DevInfraNotReadyError` carrying the actionable `formatPgError` hint (matching
 * the throw-style of every `dev-db.ts` function, so this stays reusable by CI);
 * the `dev-tmux.ts` entry point catches it and exits.
 */
export async function assertDevInfraReady(): Promise<void> {
  const repoRoot = resolveCurrentRepoRoot();
  applyDevEnvToProcess(repoRoot);

  const active = DEV_DATABASES.map((db) => ({ db, dbUrl: process.env[db.envVar] })).filter(
    (entry): entry is { db: (typeof DEV_DATABASES)[number]; dbUrl: string } => Boolean(entry.dbUrl),
  );

  if (active.length === 0) {
    throw new DevInfraNotReadyError(
      "pnpm dev requires DATABASE_URL — did direnv load .envrc? try 'direnv allow', or copy .env.example to .env.",
    );
  }

  for (const { db, dbUrl } of active) {
    try {
      await pingDatabaseForUrl(dbUrl);
    } catch (err) {
      throw new DevInfraNotReadyError(
        `dev infra check failed — ${db.label} unreachable:\n  ${formatPgError(err)}`,
      );
    }

    await assertMigrationsCurrent(repoRoot, db, dbUrl);
  }
}

/**
 * Fail fast when a live dev database has drifted from the repo's migration
 * baseline. Without this, a worktree DB stamped from an older/squashed baseline
 * boots happily and only breaks later inside feature code (e.g. a missing column
 * surfacing as an opaque "database error" in chat). Best-effort: a check that
 * cannot run (no migrations dir configured, query failure) does not block dev.
 */
async function assertMigrationsCurrent(
  repoRoot: string,
  db: (typeof DEV_DATABASES)[number],
  dbUrl: string,
): Promise<void> {
  if (!db.migrationsDir) return;

  const expected = readExpectedMigrationHashes(path.join(repoRoot, db.migrationsDir));
  let applied: string[] | null;
  try {
    applied = await readAppliedMigrationHashes(dbUrl);
  } catch {
    // Diagnostic only — never let a drift probe failure block dev startup.
    return;
  }

  const drift = describeMigrationDrift({
    label: db.label,
    expected,
    applied,
    resetHint: db.resetHint ?? db.migrateScript,
  });
  if (drift) {
    throw new DevInfraNotReadyError(`dev infra check failed — ${drift}`);
  }
}
