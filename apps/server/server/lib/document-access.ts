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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const effectiveProjectId = sql<ProjectId>`coalesce(${contextSources.projectId}, ${works.projectId})`;

export type DocumentAccessState = "available" | "deleted";

function activeEffectiveProject(input: { userId?: UserId; projectId?: ProjectId } = {}) {
  return and(
    isNull(projects.deletedAt),
    input.userId ? eq(projects.userId, input.userId) : undefined,
    input.projectId ? eq(projects.id, input.projectId) : undefined,
  );
}

export interface DocumentAccessPort {
  documentAccessState(userId: UserId, documentId: string): Promise<DocumentAccessState | null>;
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
    async documentAccessState() {
      return "available";
    },
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
  async function documentAccessState(
    userId: UserId,
    documentId: string,
    projectId?: ProjectId,
  ): Promise<DocumentAccessState | null> {
    if (!UUID_PATTERN.test(documentId)) return null;
    const [row] = await db
      .select({
        documentDeletedAt: documents.deletedAt,
        sourceDeletedAt: contextSources.deletedAt,
      })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .leftJoin(works, eq(contextSources.workId, works.id))
      .innerJoin(projects, eq(projects.id, effectiveProjectId))
      .where(
        and(
          eq(documents.id, documentId),
          contentDocumentPredicate(),
          activeEffectiveProject({ userId, projectId }),
        ),
      )
      .limit(1);
    if (!row) return null;
    return row.documentDeletedAt || row.sourceDeletedAt ? "deleted" : "available";
  }

  async function canAccessDocument(userId: UserId, documentId: string): Promise<boolean> {
    return (await documentAccessState(userId, documentId)) === "available";
  }

  async function canAccessProjectDocument(
    userId: UserId,
    documentId: string,
    projectId: ProjectId,
  ): Promise<boolean> {
    return (await documentAccessState(userId, documentId, projectId)) === "available";
  }

  async function projectIdForDocument(documentId: string): Promise<ProjectId | null> {
    if (!UUID_PATTERN.test(documentId)) return null;
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
    documentAccessState,
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
