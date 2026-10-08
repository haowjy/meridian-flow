/** One lifecycle owner for lineage provisioning and trash reconciliation. */
import type { Database } from "@meridian/database";
import { contextSources, threads } from "@meridian/database/schema";
import { and, eq, inArray, type SQLWrapper, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import { lockContextNamespaces } from "./context-fs/document-locations.js";

export class LineageScratchUnavailableError extends Error {
  constructor() {
    super("Chat Scratch is unavailable because no chat in its lineage is live");
    this.name = "LineageScratchUnavailableError";
  }
}

/** Identity is independent of availability: a trashed first chat can have live forks. */
export function lineageHasLiveMember(rootThreadId: string | SQLWrapper) {
  return sql<boolean>`EXISTS (SELECT 1 FROM threads member WHERE member.root_thread_id = ${rootThreadId} AND member.deleted_at IS NULL)`;
}

export interface LineageScratchLifecycle {
  requireLive(projectId: string, rootThreadId: string): Promise<void>;
  ensureSource(projectId: string, rootThreadId: string): Promise<string>;
  reconcile(threadIds: readonly string[]): Promise<void>;
}

export function createDrizzleLineageScratchLifecycle(
  db: Database,
  catalog?: ContextCatalogMutationPort,
): LineageScratchLifecycle {
  // Use the Scratch namespace boundary already held by context commands. Taking
  // a second lineage lock after that boundary would invert catalog lock order.
  async function lock(projectId: string) {
    await lockContextNamespaces(db, { projectId, userId: "" }, [
      { scheme: "scratch", workId: null },
    ]);
  }
  async function requireLive(projectId: string, rootThreadId: string) {
    await lock(projectId);
    const [root] = await currentDrizzleDb(db)
      .select({ live: lineageHasLiveMember(rootThreadId) })
      .from(threads)
      .where(
        and(
          eq(threads.id, rootThreadId),
          eq(threads.rootThreadId, rootThreadId),
          eq(threads.projectId, projectId),
        ),
      );
    if (!root?.live) throw new LineageScratchUnavailableError();
  }
  return {
    requireLive,
    ensureSource: (projectId, rootThreadId) =>
      runInDrizzleTransaction(db, async () => {
        await requireLive(projectId, rootThreadId);
        const [source] = await currentDrizzleDb(db)
          .insert(contextSources)
          .values({
            projectId,
            rootThreadId,
            scope: "lineage",
            name: "Scratch",
            slug: "scratch",
            adapterType: "local",
          })
          .onConflictDoNothing()
          .returning({ id: contextSources.id });
        if (source) return source.id;
        const [existing] = await currentDrizzleDb(db)
          .select({ id: contextSources.id })
          .from(contextSources)
          .where(
            and(
              eq(contextSources.projectId, projectId),
              eq(contextSources.rootThreadId, rootThreadId),
              eq(contextSources.slug, "scratch"),
            ),
          );
        if (!existing) throw new LineageScratchUnavailableError();
        return existing.id;
      }),
    reconcile: (threadIds) =>
      runInDrizzleTransaction(db, async () => {
        if (!threadIds.length) return;
        const roots = await currentDrizzleDb(db)
          .select({ id: threads.rootThreadId, projectId: threads.projectId })
          .from(threads)
          .where(inArray(threads.id, [...threadIds]));
        for (const projectId of [...new Set(roots.map((root) => root.projectId))].sort())
          await lock(projectId);
        for (const rootThreadId of [...new Set(roots.map((root) => root.id))].sort()) {
          const sources = await currentDrizzleDb(db)
            .update(contextSources)
            .set({
              deletedAt: sql`CASE WHEN ${lineageHasLiveMember(rootThreadId)} THEN NULL ELSE coalesce(${contextSources.deletedAt}, now()) END`,
            })
            .where(
              and(
                eq(contextSources.scope, "lineage"),
                eq(contextSources.rootThreadId, rootThreadId),
              ),
            )
            .returning({ id: contextSources.id });
          await catalog?.refreshSources(sources.map((source) => source.id));
        }
      }),
  };
}
