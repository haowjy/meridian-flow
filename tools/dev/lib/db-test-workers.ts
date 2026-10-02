export const DEFAULT_DB_TEST_WORKERS = 8;
export const MAX_DB_TEST_WORKERS = 8;

export function parseDbTestWorkerCount(value: string | undefined): number {
  const workerCount = Number(value ?? DEFAULT_DB_TEST_WORKERS);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > MAX_DB_TEST_WORKERS) {
    throw new Error(
      `DB_TEST_WORKERS must be an integer from 1 to ${MAX_DB_TEST_WORKERS} (shared Postgres connection budget).`,
    );
  }
  return workerCount;
}

export function effectiveDbTestWorkerCount(configured: number, selectedSuites: number): number {
  if (!Number.isInteger(selectedSuites) || selectedSuites < 1) {
    throw new Error(`DB tests selected no suites (found ${selectedSuites}).`);
  }
  return Math.min(configured, selectedSuites);
}
