/** First-chat identity lookup is independent of discovery of available lineage notes. */
import type { Database } from "@meridian/database";
import { contextSources, threads } from "@meridian/database/schema";
import { and, eq, exists, isNull, type SQL } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ScratchLineage, ScratchLineages } from "../scratch-owner.js";
import { LIVE_TREE, visibleDocuments } from "../tree/tree-view.js";
import { lineageHasLiveMember } from "./lineage-scratch-lifecycle.js";

export function createDrizzleScratchLineages(db: Database): ScratchLineages {
  async function roots(projectId: string, constraint: SQL | undefined): Promise<ScratchLineage[]> {
    const rows = await currentDrizzleDb(db)
      .select({
        projectId: threads.projectId,
        rootThreadId: threads.id,
        rootThreadRef: threads.ref,
        title: threads.title,
      })
      .from(threads)
      .where(
        and(eq(threads.projectId, projectId), eq(threads.rootThreadId, threads.id), constraint),
      );
    return rows.flatMap((row) =>
      row.rootThreadRef ? [{ ...row, rootThreadRef: row.rootThreadRef }] : [],
    );
  }
  const byId = async (projectId: string, rootThreadId: string) =>
    (await roots(projectId, eq(threads.id, rootThreadId)))[0] ?? null;
  return {
    byId,
    async byRef(projectId, ref) {
      return (await roots(projectId, eq(threads.ref, ref)))[0] ?? null;
    },
    async rootForThreadRef(projectId, ref) {
      const [member] = await currentDrizzleDb(db)
        .select({ rootThreadId: threads.rootThreadId })
        .from(threads)
        .where(and(eq(threads.projectId, projectId), eq(threads.ref, ref)))
        .limit(1);
      return member ? byId(projectId, member.rootThreadId) : null;
    },
    list(projectId) {
      const notes = visibleDocuments(LIVE_TREE);
      return roots(
        projectId,
        and(
          lineageHasLiveMember(threads.id),
          exists(
            currentDrizzleDb(db)
              .select({ id: notes.id })
              .from(contextSources)
              .innerJoin(notes, eq(notes.contextSourceId, contextSources.id))
              .where(
                and(
                  eq(contextSources.rootThreadId, threads.id),
                  eq(contextSources.scope, "lineage"),
                  eq(contextSources.slug, "scratch"),
                  isNull(contextSources.deletedAt),
                ),
              ),
          ),
        ),
      );
    },
  };
}
