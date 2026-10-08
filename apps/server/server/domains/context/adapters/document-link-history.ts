/** Authorized pending-link identities and chat-only previous-location fallback. */
import { matchDocumentPath } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentPreviousLocations,
  documents,
  linkRedirects,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../../projects/index.js";
import { resolveDocumentUri } from "../document-uri-resolver.js";
import type { DocumentLinkHistory } from "../ports/document-link-resolver.js";

export function createDrizzleDocumentLinkHistory(db: Database): DocumentLinkHistory {
  const authorities = createDrizzleProjectWorkAuthorityResolver(db);
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
    return row ? resolveDocumentUri(tx, authorities, documentId) : null;
  }
  return {
    async redirect(input) {
      if (!input.holder || !(await authorizedUri(input.holder.documentId, input))) return null;
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(linkRedirects)
        .where(
          and(
            eq(linkRedirects.sourceDocumentId, input.holder.documentId),
            eq(linkRedirects.href, input.holder.href),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        uri: row.targetDocumentId
          ? await authorizedUri(row.targetDocumentId, input)
          : row.intendedUri,
      };
    },
    async previous(input, address) {
      const scope = address.scope;
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
