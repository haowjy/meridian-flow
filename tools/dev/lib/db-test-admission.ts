import postgres from "postgres";
import { parseTargetDatabase } from "./dev-db";

const ADVISORY_LOCK_NAMESPACE = 1_296_318_652;
const ADVISORY_LOCK_ID = 1;
const DEFAULT_WAIT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 5_000;
const CONNECTION_RESERVE = 20;
const RUNNER_CONNECTIONS = 2;
const CONNECTIONS_PER_WORKER = 8;

export interface DatabaseTestAdmission {
  workerBudget: number;
  maxConnections: number;
  usedConnections: number;
  release(): Promise<void>;
}

export function budgetDbTestWorkers(
  configuredWorkers: number,
  maxConnections: number,
  usedConnections: number,
): number {
  const available = maxConnections - usedConnections - CONNECTION_RESERVE - RUNNER_CONNECTIONS;
  return Math.max(0, Math.min(configuredWorkers, Math.floor(available / CONNECTIONS_PER_WORKER)));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireDatabaseTestAdmission(
  databaseUrl: string,
  configuredWorkers: number,
): Promise<DatabaseTestAdmission | undefined> {
  if (process.env.DB_TEST_ADMISSION === "off") {
    console.log("DB tests: cross-run admission disabled by DB_TEST_ADMISSION=off.");
    return undefined;
  }

  const waitMs = Number(process.env.DB_TEST_ADMISSION_WAIT_MS ?? DEFAULT_WAIT_MS);
  if (!Number.isInteger(waitMs) || waitMs < 1) {
    throw new Error("DB_TEST_ADMISSION_WAIT_MS must be a positive integer.");
  }

  const { adminConnString } = parseTargetDatabase(databaseUrl);
  const sql = postgres(adminConnString, { max: 1, connect_timeout: 5, idle_timeout: 0 });
  const startedAt = Date.now();
  let nextProgressAt = 0;
  try {
    while (true) {
      const [row] = await sql<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${ADVISORY_LOCK_NAMESPACE}, ${ADVISORY_LOCK_ID}) AS acquired`;
      if (row?.acquired) break;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= waitMs) {
        throw new Error(
          `Timed out after ${Math.ceil(elapsed / 1000)}s waiting for another DB test run. ` +
            "Set DB_TEST_ADMISSION=off only when this Postgres server has dedicated capacity.",
        );
      }
      if (elapsed >= nextProgressAt) {
        console.log(
          `DB tests: another run owns the shared Postgres budget; queued for ${Math.ceil(elapsed / 1000)}s...`,
        );
        nextProgressAt = elapsed + PROGRESS_INTERVAL_MS;
      }
      await wait(Math.min(1_000, waitMs - elapsed));
    }

    const [capacity] = await sql<{ max_connections: number; used_connections: number }[]>`
      SELECT current_setting('max_connections')::int AS max_connections,
        count(*)::int AS used_connections
      FROM pg_stat_activity`;
    if (!capacity) throw new Error("Postgres did not report its connection capacity.");
    const workerBudget = budgetDbTestWorkers(
      configuredWorkers,
      capacity.max_connections,
      capacity.used_connections,
    );
    if (workerBudget < 1) {
      throw new Error(
        `Postgres has no DB test worker capacity: ${capacity.used_connections}/${capacity.max_connections} ` +
          `connections are in use and ${CONNECTION_RESERVE} are reserved for development.`,
      );
    }
    console.log(
      `DB tests: admitted with ${capacity.used_connections}/${capacity.max_connections} connections in use; ` +
        `worker budget ${workerBudget}.`,
    );

    return {
      workerBudget,
      maxConnections: capacity.max_connections,
      usedConnections: capacity.used_connections,
      async release() {
        await sql.end();
      },
    };
  } catch (error) {
    await sql.end();
    throw error;
  }
}
