import type { UserId } from "@meridian/contracts";
import { matchDocumentPath } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentPreviousLocations, documents, projects } from "@meridian/database/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { createDocumentUriResolver } from "../document-uri-resolver.js";
import type { DocumentLinkHistory } from "../ports/document-link-resolver.js";
import { ownedByRequestSql } from "../tree/source-owner.js";

export function createDrizzleDocumentLinkHistory(db: Database): DocumentLinkHistory {
  const currentUri = createDocumentUriResolver(db);
  async function authorizedUri(documentId: string, input: { projectId: string; userId: string }) {
    const tx = currentDrizzleDb(db);
    const [row] = await tx
      .select({ id: documents.id })
      .from(documents)
      .leftJoin(projects, eq(projects.id, documents.projectId))
      .where(
        and(
          eq(documents.id, documentId),
          ownedByRequestSql(
            { projectId: sql`${documents.projectId}`, userId: sql`${documents.userId}` },
            { projectId: sql`${input.projectId}::uuid`, accountId: sql`${input.userId}::uuid` },
          ),
          or(
            isNull(documents.projectId),
            and(eq(projects.userId, input.userId as UserId), isNull(projects.deletedAt)),
          ),
        ),
      );
    return row ? currentUri(documentId) : null;
  }
  return {
    async previous(input, address) {
      const rows = await currentDrizzleDb(db)
        .select({
          path: documentPreviousLocations.path,
          documentId: documentPreviousLocations.documentId,
        })
        .from(documentPreviousLocations)
        .where(eq(documentPreviousLocations.contextSourceId, address.sourceId));
      const match = matchDocumentPath(rows, address.path, (row) => row.path);
      return match ? authorizedUri(match.documentId, input) : null;
    },
  };
}
