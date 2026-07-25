/** Drizzle document projection and activity read-model effects. */
import type { Database } from "@meridian/database";
import { contextSources, documents, projects, threadDocuments, works } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";

export function createDrizzleDocumentProjectionEffects(db: Database): DocumentProjectionEffects {
  return {
    async updateProjection(input) {
      const activeDb = currentDrizzleDb(db);
      await activeDb
        .update(documents)
        .set({ markdownProjection: input.markdown, updatedAt: input.at })
        .where(eq(documents.id, input.documentId));
    },

    async touchDocumentActivity(input) {
      const activeDb = currentDrizzleDb(db);
      const [scope] = await activeDb
        .select({
          workId: contextSources.workId,
          sourceProjectId: contextSources.projectId,
          workProjectId: works.projectId,
        })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .leftJoin(works, eq(works.id, contextSources.workId))
        .where(eq(documents.id, input.documentId))
        .limit(1);

      if (input.threadId) {
        await activeDb
          .update(threadDocuments)
          .set({ lastTouchedAt: input.at })
          .where(
            and(
              eq(threadDocuments.threadId, input.threadId),
              eq(threadDocuments.documentId, input.documentId),
            ),
          );
      }
      if (scope?.workId) {
        await activeDb.update(works).set({ updatedAt: input.at }).where(eq(works.id, scope.workId));
      }
      const projectId = scope?.sourceProjectId ?? scope?.workProjectId;
      if (projectId) {
        await activeDb
          .update(projects)
          .set({ updatedAt: input.at, lastActivityAt: input.at })
          .where(eq(projects.id, projectId));
      }
    },

    async applyPushCompletion(input) {
      const activeDb = currentDrizzleDb(db);
      await activeDb
        .update(documents)
        .set({ markdownProjection: input.markdown, updatedAt: input.at })
        .where(eq(documents.id, input.documentId));
      await activeDb
        .update(threadDocuments)
        .set({ lastTouchedAt: input.at })
        .where(eq(threadDocuments.documentId, input.documentId));
      if (input.workId) {
        await activeDb.update(works).set({ updatedAt: input.at }).where(eq(works.id, input.workId));
      }
      const [scope] = await activeDb
        .select({ projectId: contextSources.projectId })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .where(and(eq(documents.id, input.documentId), isNull(documents.deletedAt)))
        .limit(1);
      if (scope?.projectId) {
        await activeDb
          .update(projects)
          .set({ updatedAt: input.at, lastActivityAt: input.at })
          .where(eq(projects.id, scope.projectId));
      }
    },
  };
}
