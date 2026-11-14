/** Drizzle document projection and activity read-model effects. */
import type { Database } from "@meridian/database";
import { contextSources, documents, projects, threadDocuments } from "@meridian/database";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentPlacement } from "../../context/tree/tree-addresses.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";

export function createDrizzleDocumentProjectionEffects(
  db: Database,
  workProjection: WorkProjectionMutation,
): DocumentProjectionEffects {
  return {
    async touchDocumentActivity(input) {
      const activeDb = currentDrizzleDb(db);
      const [owner] = await activeDb
        .select({ projectId: documents.projectId })
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .limit(1);
      const placed = await loadDocumentPlacement(activeDb, input.documentId);
      const [source] = placed
        ? await activeDb
            .select({ workId: contextSources.workId })
            .from(contextSources)
            .where(eq(contextSources.id, placed.contextSourceId))
            .limit(1)
        : [];

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
      if (source?.workId) {
        await workProjection.touchWorks([source.workId], input.at);
      }
      const projectId = owner?.projectId;
      if (projectId) {
        await activeDb
          .update(projects)
          .set({ updatedAt: input.at, lastActivityAt: input.at })
          .where(eq(projects.id, projectId));
      }
    },
  };
}
