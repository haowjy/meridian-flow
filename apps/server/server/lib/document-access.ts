import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { HTTPError } from "nitro/h3";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DocumentAccessPort {
  canAccessDocument(userId: UserId, documentId: string): Promise<boolean>;
  canAccessProjectDocument(
    userId: UserId,
    documentId: string,
    projectId: ProjectId,
  ): Promise<boolean>;
  requireOwnedDocument(documentId: string, userId: UserId): Promise<void>;
  projectIdForDocument(documentId: string): Promise<ProjectId | null>;
}
export function createAllowAllDocumentAccess(): DocumentAccessPort {
  return {
    async canAccessDocument() {
      return true;
    },
    async canAccessProjectDocument() {
      return true;
    },
    async requireOwnedDocument() {},
    async projectIdForDocument() {
      return null;
    },
  };
}
export function createDrizzleDocumentAccess(db: Database): DocumentAccessPort {
  async function canAccessDocument(userId: UserId, documentId: string): Promise<boolean> {
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
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
          or(eq(projects.userId, userId), eq(works.createdByUserId, userId)),
        ),
      )
      .limit(1);
    return !!row;
  }

  async function canAccessProjectDocument(
    userId: UserId,
    documentId: string,
    projectId: ProjectId,
  ): Promise<boolean> {
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
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
          or(
            and(eq(projects.id, projectId), eq(projects.userId, userId)),
            and(eq(works.projectId, projectId), eq(works.createdByUserId, userId)),
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  async function projectIdForDocument(documentId: string): Promise<ProjectId | null> {
    if (!UUID_PATTERN.test(documentId)) return null;
    const [row] = await db
      .select({
        projectId: sql<ProjectId | null>`coalesce(${contextSources.projectId}, ${works.projectId})`,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .where(
        and(
          eq(documents.id, documentId),
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
        ),
      )
      .limit(1);
    return row?.projectId ?? null;
  }

  return {
    canAccessDocument,
    canAccessProjectDocument,
    projectIdForDocument,
    async requireOwnedDocument(documentId, userId) {
      if (!(await canAccessDocument(userId, documentId))) {
        throw new HTTPError({ status: 404, message: "Document not found" });
      }
    },
  };
}
