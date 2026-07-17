import { resolveWorktreeDatabaseName } from "./dev-env";

const MANAGED_TEST_SLUG_PREFIX = "test-run-";

export function managedTestDatabaseUrl(
  sourceDatabaseUrl: string,
  baseDatabaseName: string,
  ownerPid = process.pid,
  startedAt = Date.now(),
): string {
  const databaseName = resolveWorktreeDatabaseName(
    baseDatabaseName,
    `${MANAGED_TEST_SLUG_PREFIX}${ownerPid}-${startedAt}`,
  );
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function managedTestDatabaseOwnerPid(
  databaseName: string,
  baseDatabaseNames: readonly string[],
): number | undefined {
  for (const baseDatabaseName of baseDatabaseNames) {
    const prefix = `${baseDatabaseName}_${MANAGED_TEST_SLUG_PREFIX}`;
    if (!databaseName.startsWith(prefix)) continue;
    const match = databaseName.slice(prefix.length).match(/^(\d+)-(\d+)$/);
    if (!match) return undefined;
    return Number(match[1]);
  }
  return undefined;
}

export function isUnmanagedTestDatabase(
  databaseName: string,
  baseDatabaseNames: readonly string[],
): boolean {
  return baseDatabaseNames.some((baseDatabaseName) => {
    const prefix = `${baseDatabaseName}_`;
    return (
      databaseName.startsWith(prefix) &&
      databaseName.slice(prefix.length).toLowerCase().includes("test")
    );
  });
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
  unmanaged: string[];
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
  const unmanaged = found.filter(
    (databaseName) =>
      managedTestDatabaseOwnerPid(databaseName, baseDatabaseNames) === undefined &&
      isUnmanagedTestDatabase(databaseName, baseDatabaseNames),
  );
  const protectedDatabases = new Set([...liveWorktreeDatabases, ...activeManaged, ...unmanaged]);
  return {
    activeManaged,
    unmanaged,
    orphaned: found.filter((databaseName) => !protectedDatabases.has(databaseName)),
  };
}
