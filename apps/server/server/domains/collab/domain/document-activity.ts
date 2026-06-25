/** Shared document activity/projection side effects for collab writes. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, documents, projects, threadDocuments, works } from "@meridian/database";
import { and, eq } from "drizzle-orm";

type ActivityDb = Pick<Database, "select" | "update">;

export async function touchDocumentActivity(
  db: ActivityDb,
  documentId: DocumentId,
  threadId: ThreadId | undefined,
  now: Date,
  options?: { touchAllThreadDocuments?: boolean },
): Promise<void> {
  const [scope] = await db
    .select({
      workId: contextSources.workId,
      sourceProjectId: contextSources.projectId,
      workProjectId: works.projectId,
    })
    .from(documents)
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(eq(documents.id, documentId))
    .limit(1);

  if (threadId) {
    await db
      .update(threadDocuments)
      .set({ lastTouchedAt: now })
      .where(
        and(eq(threadDocuments.threadId, threadId), eq(threadDocuments.documentId, documentId)),
      );
  } else if (options?.touchAllThreadDocuments) {
    await db
      .update(threadDocuments)
      .set({ lastTouchedAt: now })
      .where(eq(threadDocuments.documentId, documentId));
  }
  if (scope?.workId) {
    await db.update(works).set({ updatedAt: now }).where(eq(works.id, scope.workId));
  }
  const projectId = scope?.sourceProjectId ?? scope?.workProjectId;
  if (projectId) {
    await db
      .update(projects)
      .set({ updatedAt: now, lastActivityAt: now })
      .where(eq(projects.id, projectId));
  }
}

export async function updateMarkdownProjection(
  db: Database,
  documentId: DocumentId,
  markdown: string,
  now: Date,
): Promise<void> {
  await db
    .update(documents)
    .set({ markdownProjection: markdown, updatedAt: now })
    .where(eq(documents.id, documentId));
}
