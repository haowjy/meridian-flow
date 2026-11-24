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
    return false;
  }
}

export function ensureDevInfraUp(repoRoot: string): void {
  if (devPostgresIsHealthy()) return;
  const composeFile = path.join(repoRoot, "tools/dev/docker-compose.yml");
  execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "--wait"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

export class DevInfraNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevInfraNotReadyError";
  }
}

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
