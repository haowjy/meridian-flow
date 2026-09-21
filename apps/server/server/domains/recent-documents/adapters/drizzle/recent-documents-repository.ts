/** Drizzle recents repository: upsert opened_at, prune to the newest 50, list with identity. */
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  folders,
  projects,
  userRecentDocuments,
  works,
} from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { mapAuthoritativeFile } from "../../../context/adapters/catalog-file-mapper.js";
import { classifyAuthoritativeIdentity } from "../../../context/adapters/project-context-availability.js";
import {
  type RecentDocumentsRepository,
  USER_RECENT_DOCUMENTS_CAP,
} from "../../ports/recent-documents-repository.js";

export function createDrizzleRecentDocumentsRepository(deps: {
  db: Database;
}): RecentDocumentsRepository {
  return {
    async record(userId: UserId, documentId: DocumentId) {
      const now = new Date();
      await deps.db
        .insert(userRecentDocuments)
        .values({ userId, documentId, openedAt: now })
        .onConflictDoUpdate({
          target: [userRecentDocuments.userId, userRecentDocuments.documentId],
          set: { openedAt: now },
        });
      const overflow = await deps.db
        .select({ documentId: userRecentDocuments.documentId })
        .from(userRecentDocuments)
        .where(eq(userRecentDocuments.userId, userId))
        .orderBy(desc(userRecentDocuments.openedAt))
        .offset(USER_RECENT_DOCUMENTS_CAP);
      const overflowIds = overflow.map((row) => row.documentId);
      if (overflowIds.length === 0) return;
      await deps.db
        .delete(userRecentDocuments)
        .where(
          and(
            eq(userRecentDocuments.userId, userId),
            inArray(userRecentDocuments.documentId, overflowIds),
          ),
        );
    },
    async listByUser(userId: UserId, limit = USER_RECENT_DOCUMENTS_CAP) {
      const capped = Math.min(Math.max(limit, 0), USER_RECENT_DOCUMENTS_CAP);
      if (capped === 0) return [];
      const rows = await deps.db
        .select({
          document: documents,
          source: contextSources,
          sourceProject: projects,
          work: works,
          openedAt: userRecentDocuments.openedAt,
        })
        .from(userRecentDocuments)
        .innerJoin(documents, eq(userRecentDocuments.documentId, documents.id))
        .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
        .leftJoin(works, eq(contextSources.workId, works.id))
        .innerJoin(
          projects,
          sql`${projects.id} = coalesce(${contextSources.projectId}, ${works.projectId})`,
        )
        .where(
          and(
            eq(userRecentDocuments.userId, userId),
            eq(projects.userId, userId),
            isNull(documents.deletedAt),
            isNull(projects.deletedAt),
            isNull(contextSources.deletedAt),
          ),
        )
        .orderBy(desc(userRecentDocuments.openedAt))
        .limit(capped);

      const sourceIds = [...new Set(rows.flatMap((row) => (row.source ? [row.source.id] : [])))];
      const folderRows = sourceIds.length
        ? await deps.db
            .select()
            .from(folders)
            .where(inArray(folders.contextSourceId, sourceIds as never))
        : [];
      const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));

      const documentsOut: RecentDocumentItem[] = [];
      for (const row of rows) {
        const { document, source, sourceProject, work, openedAt } = row;
        if (!source || !sourceProject) continue;
        if (work?.deletedAt || work?.status === "archived") continue;
        const classification = classifyAuthoritativeIdentity({
          row: { document, source, sourceProject, work },
          requestProjectId: sourceProject.id,
          actorUserId: userId,
          projectGeneration: "0",
          checkedGeneration: "0",
          foldersById,
        });
        if (classification.kind !== "valid") continue;
        try {
          const entry = mapAuthoritativeFile({
            document,
            scope: classification.identity.scope,
            scheme: classification.identity.scheme,
            workId: work?.id ?? null,
            workSlug: work && !work.isNoWork ? work.slug : null,
            parentPath: classification.identity.parentPath,
          });
          documentsOut.push({
            documentId: document.id,
            projectId: sourceProject.id,
            projectName: sourceProject.name,
            projectSlug: sourceProject.slug,
            scheme: classification.identity.scheme,
            path: `/${entry.path.join("/")}`,
            name: entry.name,
            filetype: document.fileType,
            editable: entry.editable,
            openedAt: openedAt.toISOString(),
          });
        } catch {}
      }
      return documentsOut;
    },
  };
}
