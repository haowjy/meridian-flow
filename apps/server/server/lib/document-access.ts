import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import { isUuid } from "./uuid.js";

const effectiveProjectId = sql<ProjectId>`coalesce(${contextSources.projectId}, ${works.projectId})`;

function activeEffectiveProject(input: { userId?: UserId; projectId?: ProjectId } = {}) {
  return and(
    isNull(projects.deletedAt),
    input.userId ? eq(projects.userId, input.userId) : undefined,
    input.projectId ? eq(projects.id, input.projectId) : undefined,
  );
}

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
    if (!isUuid(documentId)) return false;
    const [row] = await db
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .innerJoin(projects, eq(projects.id, effectiveProjectId))
      .where(
        and(
          eq(documents.id, documentId),
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
          activeEffectiveProject({ userId }),
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
    if (!isUuid(documentId)) return false;
    const [row] = await db
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .innerJoin(projects, eq(projects.id, effectiveProjectId))
      .where(
        and(
          eq(documents.id, documentId),
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
          activeEffectiveProject({ userId, projectId }),
        ),
      )
      .limit(1);
    return !!row;
  }

  async function projectIdForDocument(documentId: string): Promise<ProjectId | null> {
    if (!isUuid(documentId)) return null;
    const [row] = await db
      .select({
        projectId: effectiveProjectId,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .innerJoin(projects, eq(projects.id, effectiveProjectId))
      .where(
        and(
          eq(documents.id, documentId),
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
          activeEffectiveProject(),
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
