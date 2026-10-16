/**
 * One lifecycle owner for lineage Scratch provisioning and for trash reconciliation of the
 * sources a thread owns: its lineage's Scratch and its own chat's uploads.
 */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, threads } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import { LIVE_TREE, visibleDocuments } from "../tree/tree-view.js";
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
  arrivals?: Pick<DocumentArrivals, "settle">,
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
          await lockContextNamespaces(db, { projectId, userId: "" }, [
            { scheme: "scratch", workId: null },
            { scheme: "uploads", workId: null },
          ]);
        for (const rootThreadId of [...new Set(roots.map((root) => root.id))].sort()) {
          await reconcileSources(
            and(eq(contextSources.scope, "lineage"), eq(contextSources.rootThreadId, rootThreadId)),
            lineageHasLiveMember(rootThreadId),
          );
        }
        // A chat's uploads follow that chat's own trash state, not its lineage's.
        await reconcileSources(
          and(
            eq(contextSources.scope, "chat"),
            inArray(contextSources.chatThreadId, [...new Set(threadIds)]),
          ),
          sql`NOT EXISTS (SELECT 1 FROM threads chat WHERE chat.id = ${contextSources.chatThreadId} AND chat.deleted_at IS NOT NULL)`,
        );
      }),
  };

  /** Hide the owner's sources while it is not live and reopen them on restore. */
  async function reconcileSources(owned: SQL | undefined, live: SQLWrapper) {
    const hidden = await currentDrizzleDb(db)
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(and(owned, isNotNull(contextSources.deletedAt)));
    const sources = await currentDrizzleDb(db)
      .update(contextSources)
      .set({
        deletedAt: sql`CASE WHEN ${live} THEN NULL ELSE coalesce(${contextSources.deletedAt}, now()) END`,
      })
      .where(owned)
      .returning({ id: contextSources.id, deletedAt: contextSources.deletedAt });
    const restored = sources.filter(
      (source) => source.deletedAt === null && hidden.some((row) => row.id === source.id),
    );
    if (arrivals && restored.length) {
      // Arrivals are live: a draft's hidden documents in a restored source settle nothing.
      const liveTree = visibleDocuments(LIVE_TREE);
      const content = await currentDrizzleDb(db)
        .select({ id: liveTree.id })
        .from(liveTree)
        .where(
          inArray(
            liveTree.contextSourceId,
            restored.map((source) => source.id),
          ),
        );
      // The registry filters deleted ancestors and only settles once.
      // Reconciliation already holds the namespaces in this transaction.
      await arrivals.settle(content.map((document) => document.id as DocumentId));
    }
    await catalog?.refreshSources(sources.map((source) => source.id));
  }
}
