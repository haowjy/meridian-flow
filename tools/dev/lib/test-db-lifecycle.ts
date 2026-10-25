import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { validateDbName } from "./dev-db";

const MANAGED_TEST_SLUG_PREFIX = "test-run-";
const MANUAL_TEST_SLUG_PREFIX = "test-manual-";
const MANAGED_WORKER_PATTERN = /^(.*_test-run-\d+-\d+)-worker-\d+$/;

export interface DisposableTestDatabaseTarget {
  databaseName: string;
  databaseUrl: string;
  /** The managed run's template, whose collector drops this database; absent means drop it yourself. */
  managedTemplate: string | undefined;
}

/**
 * Places a suite-owned database under the managed run's worker prefix so the run's detached collector
 * drops it after Vitest exits. Test code must not drop it inline: PostgreSQL makes every DROP DATABASE
 * wait for a forced checkpoint, which takes tens of seconds while other runs share the server. Unmanaged
 * runs (CI) have no collector and get the caller's standalone name.
 */
export function disposableTestDatabaseTarget(
  ownerDatabaseUrl: string,
  unmanagedDatabaseName: string,
): DisposableTestDatabaseTarget {
  const url = new URL(ownerDatabaseUrl);
  const ownerName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const managedTemplate = ownerName.match(MANAGED_WORKER_PATTERN)?.[1];
  // Indexes far above any worker count keep suite databases distinct from worker clones.
  const databaseName = managedTemplate
    ? `${managedTemplate}-worker-${randomInt(1000, 1_000_000)}`
    : unmanagedDatabaseName;
  validateDbName(databaseName);
  url.pathname = `/${databaseName}`;
  return { databaseName, databaseUrl: url.toString(), managedTemplate };
}

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
      const ownerPid = match ? Number(match[1]) : undefined;
      return ownerPid !== undefined && ownerPid > 1 ? ownerPid : undefined;
    }

    const migrationPrefix = `${baseDatabaseName}_migrations_`;
    if (databaseName.startsWith(migrationPrefix)) {
      const match = databaseName.slice(migrationPrefix.length).match(/^(\d+)_(\d+)$/);
      const ownerPid = match ? Number(match[1]) : undefined;
      return ownerPid !== undefined && ownerPid > 1 ? ownerPid : undefined;
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

function parentProcessId(pid: number): number | undefined {
  try {
    const value = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parentPid = Number(value);
    return Number.isSafeInteger(parentPid) && parentPid >= 0 ? parentPid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAncestor(
  ancestorPid: number,
  descendantPid = process.pid,
  resolveParent = parentProcessId,
): boolean {
  if (
    !Number.isSafeInteger(ancestorPid) ||
    ancestorPid <= 1 ||
    !Number.isSafeInteger(descendantPid) ||
    descendantPid <= 1
  ) {
    return false;
  }

  const seen = new Set<number>();
  let currentPid: number | undefined = resolveParent(descendantPid);
  while (currentPid !== undefined && currentPid > 1 && !seen.has(currentPid)) {
    if (currentPid === ancestorPid) return true;
    seen.add(currentPid);
    currentPid = resolveParent(currentPid);
  }
  return false;
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
