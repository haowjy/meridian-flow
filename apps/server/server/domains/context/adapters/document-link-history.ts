/** Scoped previous-location lookup, authorized against the reader's projects. */
import { documentPathCandidateNames, matchDocumentPath } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentPreviousLocations,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { createDocumentUriResolver } from "../document-uri-resolver.js";
import type { DocumentLinkHistory } from "../ports/document-link-resolver.js";
import { loadDocumentAddresses, presentSourceId } from "../tree/tree-addresses.js";

export function createDrizzleDocumentLinkHistory(db: Database): DocumentLinkHistory {
  const currentUri = createDocumentUriResolver(db);
  async function authorizedUri(documentId: string, input: { projectId: string; userId: string }) {
    const tx = currentDrizzleDb(db);
    const [row] = await tx
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .innerJoin(
        projects,
        eq(projects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
      )
      .where(
        and(
          eq(documents.id, documentId),
          eq(projects.userId, input.userId),
          isNull(projects.deletedAt),
          or(eq(projects.id, input.projectId), eq(projects.isPersonal, true)),
        ),
      );
    if (!row) return null;
    const uri = await currentUri(documentId);
    return uri ? { kind: "living" as const, uri } : { kind: "gone" as const };
  }
  return {
    async previous(input, address) {
      const scope = address.scope;
      const sourceId = await presentSourceId(db, {
        scheme: address.scheme,
        workId: scope.kind === "work" ? scope.workId : null,
        project: scope.kind === "user" ? { personalOf: scope.userId } : { id: input.projectId },
        ...(scope.kind === "lineage" ? { rootThreadId: scope.rootThreadId } : {}),
        ...(scope.kind === "chat" ? { chatThreadId: scope.chatId } : {}),
      });
      if (sourceId) {
        const removed = matchDocumentPath(
          (
            await Promise.all(
              documentPathCandidateNames(address.path).map((filename) =>
                loadDocumentAddresses(db, { sourceId, filename }),
              ),
            )
          )
            .flat()
            .filter((candidate) => candidate.deleted),
          address.path,
          (candidate) => candidate.path,
        );
        if (removed) return { kind: "gone" };
      }
      const rows = await currentDrizzleDb(db)
        .select({
          path: documentPreviousLocations.path,
          documentId: documentPreviousLocations.documentId,
        })
        .from(documentPreviousLocations)
        .innerJoin(contextSources, eq(contextSources.id, documentPreviousLocations.contextSourceId))
        .leftJoin(projects, eq(projects.id, contextSources.projectId))
        .where(
          and(
            eq(contextSources.slug, address.scheme),
            isNull(contextSources.deletedAt),
            scope.kind === "lineage"
              ? and(
                  eq(contextSources.rootThreadId, scope.rootThreadId),
                  eq(contextSources.projectId, scope.projectId),
                )
              : scope.kind === "chat"
                ? and(
                    eq(contextSources.chatThreadId, scope.chatId),
                    eq(contextSources.projectId, scope.projectId),
                  )
                : scope.kind === "work"
                  ? eq(contextSources.workId, scope.workId)
                  : scope.kind === "user"
                    ? and(
                        eq(projects.userId, scope.userId),
                        eq(projects.isPersonal, true),
                        isNull(projects.deletedAt),
                      )
                    : eq(contextSources.projectId, scope.projectId),
          ),
        );
      const match = matchDocumentPath(rows, address.path, (row) => row.path);
      return match ? authorizedUri(match.documentId, input) : null;
    },
  };
}
