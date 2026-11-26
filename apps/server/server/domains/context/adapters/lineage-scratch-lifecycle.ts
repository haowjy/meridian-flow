import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, threads } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { lineageHasLiveMember, lockLineageOwners } from "../../../shared/draft-owner.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockProjectTreeList } from "../../../shared/tree-list-lock.js";
import type { FileAccessChanges } from "../../file-policy/index.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import type { ProjectHintPort } from "../ports/project-hints.js";
import { LIVE_TREE, visibleDocuments } from "../tree/tree-view.js";
import { lockContextNamespaces } from "./context-fs/document-locations.js";

export class LineageScratchUnavailableError extends Error {
  constructor() {
    super("Chat Scratch is unavailable because no chat in its lineage is live");
    this.name = "LineageScratchUnavailableError";
  }
}

export interface LineageScratchLifecycle {
  requireLive(projectId: string, rootThreadId: string): Promise<void>;
  ensureSource(projectId: string, rootThreadId: string): Promise<string>;
  reconcile(threadIds: readonly string[]): Promise<void>;
}

export function createDrizzleLineageScratchLifecycle(
  db: Database,
  arrivals?: Pick<DocumentArrivals, "settle">,
  liveness?: {
    fileAccessChanges: Pick<FileAccessChanges, "publish">;
    hints: ProjectHintPort;
  },
  sourceHints: Pick<ProjectHintPort, "publishSourcesHint"> | undefined = liveness?.hints,
): LineageScratchLifecycle {
  async function lock() {
    await lockContextNamespaces(db, [{ scheme: "scratch", workId: null }]);
  }
  async function requireLive(projectId: string, rootThreadId: string) {
    await lock();
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
            slug: "scratch",
          })
          .onConflictDoNothing()
          .returning({ id: contextSources.id });
        if (source) {
          sourceHints?.publishSourcesHint(projectId);
          return source.id;
        }
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
        const rootIds = [...new Set(roots.map((root) => root.id))].sort();
        await lockLineageOwners(db, rootIds);
        const projectIds = [...new Set(roots.map((root) => root.projectId))].sort();
        for (const projectId of projectIds) await lockProjectTreeList(db, projectId);
        await lockContextNamespaces(db, [
          { scheme: "scratch", workId: null },
          { scheme: "uploads", workId: null },
        ]);
        for (const rootThreadId of rootIds) {
          await reconcileSources(
            and(eq(contextSources.scope, "lineage"), eq(contextSources.rootThreadId, rootThreadId)),
            lineageHasLiveMember(rootThreadId),
          );
          const [root] = await currentDrizzleDb(db)
            .select({ live: lineageHasLiveMember(rootThreadId) })
            .from(threads)
            .where(eq(threads.id, rootThreadId));
          await liveness?.fileAccessChanges.publish({
            rootThreadId,
            closed: root?.live ? undefined : "chat_frozen",
          });
        }
        const named = await currentDrizzleDb(db)
          .select({ draft: threads.draftId, projectId: threads.projectId })
          .from(threads)
          .where(inArray(threads.id, rootIds));
        liveness?.hints.publishDraftHints(
          named.flatMap(({ draft, projectId }) =>
            draft ? [{ type: "draft-hint" as const, projectId, draft }] : [],
          ),
        );
        await reconcileSources(
          and(
            eq(contextSources.scope, "chat"),
            inArray(contextSources.chatThreadId, [...new Set(threadIds)]),
          ),
          sql`NOT EXISTS (SELECT 1 FROM threads chat WHERE chat.id = ${contextSources.chatThreadId} AND chat.deleted_at IS NOT NULL)`,
        );
        for (const projectId of projectIds) liveness?.hints.publishSourcesHint(projectId);
      }),
  };

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
      await arrivals.settle(content.map((document) => document.id as DocumentId));
    }
  }
}
