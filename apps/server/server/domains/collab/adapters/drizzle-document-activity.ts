/** Drizzle document projection and activity read-model effects. */
import type { Database } from "@meridian/database";
import { contextSources, documents, projects, threadDocuments, works } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";

type ActivityDb = Pick<Database, "select" | "update">;

export function createDrizzleDocumentProjectionEffects(db: ActivityDb): DocumentProjectionEffects {
  return {
    async apply(input) {
      await db
        .update(documents)
        .set({ markdownProjection: input.markdown, updatedAt: input.at })
        .where(eq(documents.id, input.documentId));

      if (input.threadDocuments.kind === "thread") {
        await db
          .update(threadDocuments)
          .set({ lastTouchedAt: input.at })
          .where(
            and(
              eq(threadDocuments.threadId, input.threadDocuments.threadId),
              eq(threadDocuments.documentId, input.documentId),
            ),
          );
      } else if (input.threadDocuments.kind === "all") {
        await db
          .update(threadDocuments)
          .set({ lastTouchedAt: input.at })
          .where(eq(threadDocuments.documentId, input.documentId));
      }

      const needsDocumentScope =
        input.work.kind === "document_scope" || input.project.kind === "document_scope";
      const [scope] = needsDocumentScope
        ? await db
            .select({
              workId: contextSources.workId,
              sourceProjectId: contextSources.projectId,
              workProjectId: works.projectId,
            })
            .from(documents)
            .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
            .leftJoin(works, eq(works.id, contextSources.workId))
            .where(
              input.project.kind === "document_scope" && input.project.activeDocumentsOnly
                ? and(eq(documents.id, input.documentId), isNull(documents.deletedAt))
                : eq(documents.id, input.documentId),
            )
            .limit(1)
        : [];

      const workId =
        input.work.kind === "work"
          ? input.work.workId
          : input.work.kind === "document_scope"
            ? scope?.workId
            : null;
      if (workId) {
        await db.update(works).set({ updatedAt: input.at }).where(eq(works.id, workId));
      }

      const projectId =
        input.project.kind === "document_scope"
          ? (scope?.sourceProjectId ??
            (input.project.includeWorkProject ? scope?.workProjectId : null))
          : null;
      if (projectId) {
        await db
          .update(projects)
          .set({ updatedAt: input.at, lastActivityAt: input.at })
          .where(eq(projects.id, projectId));
      }
    },
  };
}
