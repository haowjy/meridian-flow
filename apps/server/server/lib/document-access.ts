import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, documents, projects, works } from "@meridian/database/schema";
import { and, eq, isNull, or } from "drizzle-orm";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DocumentAccessPort {
  canAccessDocument(userId: UserId, documentId: string): Promise<boolean>;
}
export function createAllowAllDocumentAccess(): DocumentAccessPort {
  return {
    async canAccessDocument() {
      return true;
    },
  };
}
export function createDrizzleDocumentAccess(db: Database): DocumentAccessPort {
  return {
    async canAccessDocument(userId, documentId) {
      if (!UUID_PATTERN.test(documentId)) return false;
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
        .leftJoin(projects, eq(contextSources.projectId, projects.id))
        .leftJoin(works, eq(contextSources.workId, works.id))
        .where(
          and(
            eq(documents.id, documentId),
            isNull(documents.deletedAt),
            isNull(contextSources.deletedAt),
            or(eq(projects.userId, userId), eq(works.createdByUserId, userId)),
          ),
        )
        .limit(1);
      return !!row;
    },
  };
}
