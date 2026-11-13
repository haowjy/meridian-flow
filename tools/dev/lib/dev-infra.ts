import { execFileSync } from "node:child_process";
import path from "node:path";
import { formatPgError, pingDatabaseForUrl } from "./dev-db";
import { applyDevEnvToProcess, DEV_DATABASES, resolveCurrentRepoRoot } from "./dev-env";
import { currentBaselineStatus } from "./migration-runner";

const DEV_POSTGRES_CONTAINER = "meridian-dev-postgres-1";

function devPostgresIsHealthy(): boolean {
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.State.Status}} {{.State.Health.Status}}", DEV_POSTGRES_CONTAINER],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() === "running healthy";
  } catch {
    return false; // no such container
  }
}

/**
 * Start the shared dev Postgres (postgres:16 + pg_bigm) if it is not already running and
 * healthy. A running server is never reconciled: every worktree shares it, and a branch with
 * an older compose file would otherwise flip it back to the image that branch knows.
 * Moving onto a new image tag is the explicit `pnpm dev:infra:upgrade`.
 */
export function ensureDevInfraUp(repoRoot: string): void {
  if (devPostgresIsHealthy()) return;
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
      "pnpm dev requires DATABASE_URL — set it in the main checkout's .env (copy .env.example).",
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

async function assertMigrationsCurrent(
  repoRoot: string,
  db: (typeof DEV_DATABASES)[number],
  dbUrl: string,
): Promise<void> {
  if (!db.migrationsDir) return;
  const status = await currentBaselineStatus({
    databaseUrl: dbUrl,
    migrationsDirectory: path.join(repoRoot, db.migrationsDir),
  });
  if (status === "pending") {
    throw new DevInfraNotReadyError(
      `dev infra check failed — ${db.label}: baseline is not installed — run \`${db.catchUpHint ?? db.migrateScript}\``,
    );
  }
}
