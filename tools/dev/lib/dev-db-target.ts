import { isLocalDevPostgres, parseTargetDatabase } from "./dev-db";
import { applyDevEnvToProcess, resolveMainDatabaseNames } from "./dev-env";
import { isProcessAncestor, managedTestDatabaseOwnerPid } from "./test-db-lifecycle";

export const MANAGED_TEST_DATABASE = "--managed-test-database";

export interface DatabaseAdminTarget {
  readonly databaseUrl: string;
  readonly databaseName: string;
}

export function resolveDatabaseAdminTarget(input: {
  readonly repoRoot: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): DatabaseAdminTarget {
  const args = input.args[0] === "--" ? input.args.slice(1) : input.args;
  const unknownArgs = args.filter((arg) => arg !== MANAGED_TEST_DATABASE);
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown database admin argument(s): ${unknownArgs.join(", ")}`);
  }

  const managedTestDatabase = args.includes(MANAGED_TEST_DATABASE);

  const env = input.env ?? process.env;
  if (!managedTestDatabase) applyDevEnvToProcess(input.repoRoot, env);

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const { targetDb: databaseName } = parseTargetDatabase(databaseUrl);
  if (managedTestDatabase) {
    const ownerPid = managedTestDatabaseOwnerPid(
      databaseName,
      resolveMainDatabaseNames(input.repoRoot),
    );
    if (
      !isLocalDevPostgres(databaseUrl) ||
      ownerPid === undefined ||
      !isProcessAncestor(ownerPid)
    ) {
      throw new Error(
        `${MANAGED_TEST_DATABASE} requires an active, locally managed disposable database`,
      );
    }
  }

  return { databaseUrl, databaseName };
}
