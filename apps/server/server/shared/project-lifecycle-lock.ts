/** Advisory gate serializing project deletion with mutations that publish project content. */
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

const lockKey = (projectId: string) => `project-lifecycle:${projectId}`;

export async function lockProjectLifecycleShared(db: DrizzleDb, projectId: string): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey(projectId)}, 0::bigint))`,
  );
}

export async function lockProjectLifecycleExclusive(
  db: DrizzleDb,
  projectId: string,
): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(projectId)}, 0::bigint))`,
  );
}
