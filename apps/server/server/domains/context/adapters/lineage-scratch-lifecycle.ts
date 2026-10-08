/** Lineage notes follow the presence of any live member, not the first chat's trash state. */

import type { Database } from "@meridian/database";
import { contextSources, threads } from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";

export async function reconcileLineageScratch(
  db: Database,
  threadIds: readonly string[],
): Promise<void> {
  if (!threadIds.length) return;
  const roots = await currentDrizzleDb(db)
    .select({ id: threads.rootThreadId })
    .from(threads)
    .where(inArray(threads.id, [...threadIds]));
  if (!roots.length) return;
  const sources = await currentDrizzleDb(db)
    .update(contextSources)
    .set({
      deletedAt: sql`CASE WHEN EXISTS (SELECT 1 FROM threads t WHERE t.root_thread_id = ${contextSources.rootThreadId} AND t.deleted_at IS NULL) THEN NULL ELSE coalesce(${contextSources.deletedAt}, now()) END`,
    })
    .where(
      and(
        eq(contextSources.scope, "lineage"),
        inArray(
          contextSources.rootThreadId,
          roots.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: contextSources.id });
  await createDrizzleContextCatalog(db).refreshSources(sources.map((source) => source.id));
}
