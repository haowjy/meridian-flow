/** Own the lifecycle of the dedicated database used by the shared DB test project. */
import { dropDatabaseForUrl, isLocalDevPostgres } from "../../tools/dev/lib/dev-db";
import { resolveCurrentRepoRoot, resolveMainDatabaseNames } from "../../tools/dev/lib/dev-env";

const databaseUrl = process.env.DATABASE_URL;

export async function teardown(): Promise<void> {
  if (!databaseUrl || !isLocalDevPostgres(databaseUrl)) return;

  const repoRoot = resolveCurrentRepoRoot();
  await dropDatabaseForUrl(databaseUrl, resolveMainDatabaseNames(repoRoot));
}
