/** Transaction fence for organizer mutations: import owner, project lifecycle, then liveness. */
import type { Database } from "@meridian/database";
import { imports, projects } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockProjectLifecycleShared } from "../../../shared/project-lifecycle-lock.js";
import type { ImportRecord } from "../ports/import-repository.js";

export type OrganizeFence = {
  importId: string;
  token: string;
  generation?: number;
};

export type OrganizeTransactionResult<T> =
  | { kind: "committed"; value: T }
  | { kind: "stale_owner" | "project_unavailable" };

export async function runOrganizeTransaction<T>(
  db: Database,
  fence: OrganizeFence,
  run: (record: ImportRecord) => Promise<T>,
): Promise<OrganizeTransactionResult<T>> {
  return runInDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    const [record] = await tx
      .select()
      .from(imports)
      .where(eq(imports.id, fence.importId))
      .for("update");
    if (
      record?.state !== "organizing" ||
      record.leaseToken !== fence.token ||
      record.leaseUntil === null ||
      (fence.generation !== undefined && record.placementGeneration !== fence.generation)
    )
      return { kind: "stale_owner" };
    const [{ current }] = await tx.execute<{ current: boolean }>(
      sql`select ${record.leaseUntil}::timestamptz > clock_timestamp() as current`,
    );
    if (!current) return { kind: "stale_owner" };
    if (!record.projectId) return { kind: "project_unavailable" };

    await lockProjectLifecycleShared(db, record.projectId);
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, record.projectId), isNull(projects.deletedAt)));
    if (!project) return { kind: "project_unavailable" };
    return { kind: "committed", value: await run(record as ImportRecord) };
  });
}
