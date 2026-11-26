import { execFileSync } from "node:child_process";
import path from "node:path";
import { ensureDatabaseForUrl, formatPgError, isLocalDevPostgres } from "./dev-db";
import { applyDevEnvToProcess, DEV_DATABASES } from "./dev-env";
import { formatMigrationFailure, runMigrations } from "./migration-runner";

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
  // keep: `--no-recreate`. Without it compose rebuilds a stopped or still-starting container to match this checkout's compose file, and the container serves every checkout; only `pnpm dev:infra:upgrade` may move it
  execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "--wait", "--no-recreate"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

// keep: everything here is safe to repeat. A running container is left alone, an existing database is kept, and the baseline is installed only into a database that has none. A different installed baseline stops with the command that replaces it, because that one erases data
export async function prepareDevDatabases(
  repoRoot: string,
): Promise<{ database: string; created: boolean }[]> {
  // keep: fills a copy. `pnpm dev` hands its own environment to the stack, and `.env` values baked into it would outlive a restart that is meant to read the file again
  const env = { ...process.env };
  applyDevEnvToProcess(repoRoot, env);
  const prepared: { database: string; created: boolean }[] = [];
  for (const db of DEV_DATABASES) {
    const databaseUrl = env[db.envVar];
    if (!databaseUrl) continue;
    if (isLocalDevPostgres(databaseUrl)) ensureDevInfraUp(repoRoot);
    const { targetDb, created } = await ensureDatabaseForUrl(databaseUrl).catch(
      (error: unknown) => {
        throw new Error(`${db.label}: ${formatPgError(error)}`);
      },
    );
    try {
      await runMigrations({
        databaseUrl,
        migrationsDirectory: path.join(repoRoot, db.migrationsDir),
      });
    } catch (error) {
      throw new Error(formatMigrationFailure(error, { repoRoot }));
    }
    prepared.push({ database: targetDb, created });
  }
  if (prepared.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env in the main checkout and set it there.",
    );
  }
  return prepared;
}
