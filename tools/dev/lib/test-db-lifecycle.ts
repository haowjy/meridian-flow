import { validateDbName } from "./dev-db";

const MANAGED_TEST_SLUG_PREFIX = "test-run-";
const MANUAL_TEST_SLUG_PREFIX = "test-manual-";

export function managedTestDatabaseUrl(
  sourceDatabaseUrl: string,
  baseDatabaseName: string,
  ownerPid = process.pid,
  startedAt = Date.now(),
): string {
  const databaseName = `${baseDatabaseName}_${MANAGED_TEST_SLUG_PREFIX}${ownerPid}-${startedAt}`;
  validateDbName(databaseName);
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function managedTestDatabaseWorkerUrl(
  templateDatabaseUrl: string,
  workerIndex: number,
): string {
  if (!Number.isInteger(workerIndex) || workerIndex < 1) {
    throw new Error(`DB test worker index must be a positive integer: ${workerIndex}`);
  }
  const url = new URL(templateDatabaseUrl);
  const templateName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const workerName = `${templateName}-worker-${workerIndex}`;
  validateDbName(workerName);
  url.pathname = `/${workerName}`;
  return url.toString();
}

export function managedTestDatabaseOwnerPid(
  databaseName: string,
  baseDatabaseNames: readonly string[],
): number | undefined {
  for (const baseDatabaseName of baseDatabaseNames) {
    const managedPrefix = `${baseDatabaseName}_${MANAGED_TEST_SLUG_PREFIX}`;
    if (databaseName.startsWith(managedPrefix)) {
      const match = databaseName.slice(managedPrefix.length).match(/^(\d+)-(\d+)(?:-worker-\d+)?$/);
      return match ? Number(match[1]) : undefined;
    }

    const migrationPrefix = `${baseDatabaseName}_migrations_`;
    if (databaseName.startsWith(migrationPrefix)) {
      const match = databaseName.slice(migrationPrefix.length).match(/^(\d+)_(\d+)$/);
      return match ? Number(match[1]) : undefined;
    }
  }
  return undefined;
}

export function isManualTestDatabase(
  databaseName: string,
  baseDatabaseNames: readonly string[],
): boolean {
  return baseDatabaseNames.some((baseDatabaseName) =>
    databaseName.startsWith(`${baseDatabaseName}_${MANUAL_TEST_SLUG_PREFIX}`),
  );
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface TestDatabaseCleanupClassification {
  activeManaged: string[];
  manual: string[];
  orphaned: string[];
}

export function classifyTestDatabaseCleanup(
  found: readonly string[],
  liveWorktreeDatabases: ReadonlySet<string>,
  baseDatabaseNames: readonly string[],
  ownerIsAlive = isProcessAlive,
): TestDatabaseCleanupClassification {
  const activeManaged = found.filter((databaseName) => {
    const ownerPid = managedTestDatabaseOwnerPid(databaseName, baseDatabaseNames);
    return ownerPid !== undefined && ownerIsAlive(ownerPid);
  });
  const manual = found.filter(
    (databaseName) =>
      managedTestDatabaseOwnerPid(databaseName, baseDatabaseNames) === undefined &&
      isManualTestDatabase(databaseName, baseDatabaseNames),
  );
  const protectedDatabases = new Set([...liveWorktreeDatabases, ...activeManaged, ...manual]);
  return {
    activeManaged,
    manual,
    orphaned: found.filter((databaseName) => !protectedDatabases.has(databaseName)),
  };
}
