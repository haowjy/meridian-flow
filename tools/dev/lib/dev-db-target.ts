/** Resolve and guard database targets used by direct database admin commands. */
import { isLocalDevPostgres, parseTargetDatabase } from "./dev-db";
import { applyDevEnvToProcess, resolveMainDatabaseNames } from "./dev-env";
import { isProcessAncestor, managedTestDatabaseOwnerPid } from "./test-db-lifecycle";

export const ALLOW_MAIN_DATABASE = "--allow-main-database";
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
  const knownArgs = new Set([ALLOW_MAIN_DATABASE, MANAGED_TEST_DATABASE]);
  const unknownArgs = args.filter((arg) => !knownArgs.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown database admin argument(s): ${unknownArgs.join(", ")}`);
  }

  const allowMainDatabase = args.includes(ALLOW_MAIN_DATABASE);
  const managedTestDatabase = args.includes(MANAGED_TEST_DATABASE);
  if (allowMainDatabase && managedTestDatabase) {
    throw new Error(`${ALLOW_MAIN_DATABASE} and ${MANAGED_TEST_DATABASE} cannot be combined`);
  }

  const env = input.env ?? process.env;
  if (!managedTestDatabase) applyDevEnvToProcess(input.repoRoot, env);

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const { targetDb: databaseName } = parseTargetDatabase(databaseUrl);
  const mainDatabaseNames = resolveMainDatabaseNames(input.repoRoot);
  if (managedTestDatabase) {
    const ownerPid = managedTestDatabaseOwnerPid(databaseName, mainDatabaseNames);
    if (
      !isLocalDevPostgres(databaseUrl) ||
      ownerPid === undefined ||
      !isProcessAncestor(ownerPid)
    ) {
      throw new Error(
        `${MANAGED_TEST_DATABASE} requires an active, locally managed disposable database`,
      );
    }
  } else if (mainDatabaseNames.includes(databaseName) && !allowMainDatabase) {
    throw new Error(
      `Refusing to use registered main database "${databaseName}". ` +
        `Re-run with ${ALLOW_MAIN_DATABASE} only when this is intentional.`,
    );
  }

  return { databaseUrl, databaseName };
}
