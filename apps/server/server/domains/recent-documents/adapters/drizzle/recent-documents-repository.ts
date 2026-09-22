/** Drizzle recents repository: owner-gated upsert, prune unlistable rows, list with identity. */
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  DOCUMENT_KINDS,
  documents,
  folders,
  projects,
  userRecentDocuments,
  works,
} from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, lt, ne, not, or, type SQL, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { mapAuthoritativeFile } from "../../../context/adapters/catalog-file-mapper.js";
import { classifyAuthoritativeIdentity } from "../../../context/adapters/project-context-availability.js";
import {
  type RecentDocumentsRepository,
  RecentDocumentUnavailableError,
  USER_RECENT_DOCUMENTS_CAP,
  USER_RECENT_DOCUMENTS_TOUCH_INTERVAL_MS,
} from "../../ports/recent-documents-repository.js";

const CONTENT_SCHEMES: string[] = [...CONTEXT_URI_SCHEMES];

/** Rows the list will return. Record, list, and prune share this so cap slots are listable rows. */
function visibleIdentity(userId: UserId): SQL {
  const predicate = and(
    eq(projects.userId, userId),
    eq(documents.kind, DOCUMENT_KINDS.content),
    inArray(contextSources.slug, CONTENT_SCHEMES),
    isNull(documents.deletedAt),
    isNull(contextSources.deletedAt),
    isNull(projects.deletedAt),
    or(isNull(works.id), and(isNull(works.deletedAt), ne(works.status, "archived"))),
  );
  if (!predicate) throw new Error("Recent document visibility predicate is empty");
  return predicate;
}

type Db = ReturnType<typeof currentDrizzleDb>;

function projectIdentity() {
  return sql`${projects.id} = coalesce(${contextSources.projectId}, ${works.projectId})`;
}

async function prune(tx: Db, userId: UserId) {
  // Delete unlistable rows first so a soft-deleted document cannot occupy a cap slot.
  const stale = await tx
    .select({ documentId: userRecentDocuments.documentId })
    .from(userRecentDocuments)
    .innerJoin(documents, eq(userRecentDocuments.documentId, documents.id))
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .innerJoin(projects, projectIdentity())
    .where(and(eq(userRecentDocuments.userId, userId), not(visibleIdentity(userId))));
  if (stale.length > 0) {
    await tx.delete(userRecentDocuments).where(
      and(
        eq(userRecentDocuments.userId, userId),
        inArray(
          userRecentDocuments.documentId,
          stale.map((row) => row.documentId),
        ),
      ),
    );
  }
  const overflow = await tx
    .select({ documentId: userRecentDocuments.documentId })
    .from(userRecentDocuments)
    .where(eq(userRecentDocuments.userId, userId))
    .orderBy(desc(userRecentDocuments.openedAt), desc(userRecentDocuments.documentId))
    .offset(USER_RECENT_DOCUMENTS_CAP);
  const overflowIds = overflow.map((row) => row.documentId);
  if (overflowIds.length === 0) return;
  await tx
    .delete(userRecentDocuments)
    .where(
      and(
        eq(userRecentDocuments.userId, userId),
        inArray(userRecentDocuments.documentId, overflowIds),
      ),
    );
}

export function createDrizzleRecentDocumentsRepository(deps: {
  db: Database;
}): RecentDocumentsRepository {
  const db = () => currentDrizzleDb(deps.db);
  return {
    async record(userId: UserId, documentId: DocumentId) {
      return runInDrizzleTransaction(deps.db, async () => {
        const tx = db();
        const [visible] = await tx
          .select({ id: documents.id })
          .from(documents)
          .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
          .leftJoin(works, eq(contextSources.workId, works.id))
          .innerJoin(projects, projectIdentity())
          .where(and(eq(documents.id, documentId), visibleIdentity(userId)))
          .limit(1);
        if (!visible) throw new RecentDocumentUnavailableError(documentId);
        const now = new Date();
        // An open inside the interval is the same open: the row is already stored
        // and its rank has not moved, so the write is skipped and nothing returns.
        const touched = await tx
          .insert(userRecentDocuments)
          .values({ userId, documentId, openedAt: now })
          .onConflictDoUpdate({
            target: [userRecentDocuments.userId, userRecentDocuments.documentId],
            set: { openedAt: now },
            setWhere: lt(
              userRecentDocuments.openedAt,
              new Date(now.getTime() - USER_RECENT_DOCUMENTS_TOUCH_INTERVAL_MS),
            ),
          })
          .returning({ documentId: userRecentDocuments.documentId });
        if (touched.length === 0) return false;
        // Pruning is cap hygiene, not list correctness: the list filters
        // unlistable rows itself, so it only has to run when a row moved.
        await prune(tx, userId);
        return true;
      });
    },
    async listByUser(userId: UserId) {
      const tx = db();
      const rows = await tx
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
        .innerJoin(projects, projectIdentity())
        .where(and(eq(userRecentDocuments.userId, userId), visibleIdentity(userId)))
        .orderBy(desc(userRecentDocuments.openedAt))
        .limit(USER_RECENT_DOCUMENTS_CAP);

      const sourceIds = [...new Set(rows.flatMap((row) => (row.source ? [row.source.id] : [])))];
      const folderRows = sourceIds.length
        ? await tx
            .select()
            .from(folders)
            .where(inArray(folders.contextSourceId, sourceIds as never))
        : [];
      const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));

      const documentsOut: RecentDocumentItem[] = [];
      for (const row of rows) {
        const { document, source, sourceProject, work, openedAt } = row;
        if (!source || !sourceProject) {
          throw new Error(`Recent document ${document.id} is missing source identity`);
        }
        const classification = classifyAuthoritativeIdentity({
          row: { document, source, sourceProject, work },
          requestProjectId: sourceProject.id,
          actorUserId: userId,
          projectGeneration: "0",
          checkedGeneration: "0",
          foldersById,
        });
        if (classification.kind !== "valid") {
          throw new Error(`Recent document ${document.id} has inconsistent identity`);
        }
        const workSlug = work && !work.isNoWork ? work.slug : null;
        const entry = mapAuthoritativeFile({
          document,
          scope: classification.identity.scope,
          scheme: classification.identity.scheme,
          workId: work?.id ?? null,
          workSlug,
          parentPath: classification.identity.parentPath,
        });
        documentsOut.push({
          documentId: document.id,
          projectId: sourceProject.id,
          projectName: sourceProject.name,
          projectSlug: sourceProject.slug,
          workSlug,
          scheme: classification.identity.scheme,
          path: `/${entry.path.join("/")}`,
          name: entry.name,
          filetype: document.fileType,
          editable: entry.editable,
          openedAt: openedAt.toISOString(),
        });
      }
      return documentsOut;
    },
  };
}
