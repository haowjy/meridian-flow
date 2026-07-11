/** Authoritative thread-shell and separately authorized manuscript-detail reads. */
import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  changeTrailDocumentOccurrences,
  changeTrailShells,
} from "@meridian/database/schema";
import { and, asc, eq } from "drizzle-orm";
import type { DocumentAccessPort } from "../../../lib/document-access.js";
import type {
  ChangeTrailDocumentDetailV1,
  ChangeTrailShellV1,
  TrailChangeV1,
} from "../domain/trail-read-kernel.js";

export type ChangeTrailReader = ReturnType<typeof createDrizzleChangeTrailReader>;

export function createDrizzleChangeTrailReader(
  db: Database,
  documentAccess: Pick<DocumentAccessPort, "canAccessDocument">,
) {
  async function listShells(threadId: string): Promise<ChangeTrailShellV1[]> {
    const rows = await db
      .select()
      .from(changeTrailShells)
      .where(eq(changeTrailShells.threadId, threadId))
      .orderBy(asc(changeTrailShells.createdAt), asc(changeTrailShells.id));
    return rows.map((row) => ({
      trailId: row.id,
      owner:
        row.ownerKind === "turn"
          ? { kind: "turn" as const, threadId: row.threadId, turnId: row.turnId as string }
          : { kind: "shared" as const, threadId: row.threadId, turnId: null },
      state: row.state,
      version: row.version,
      changeCount: row.changeCount,
      sweptChangeCount: row.sweptChangeCount,
      documentCount: row.documentCount,
      updatedAt: row.updatedAt.toISOString(),
      settledAt: row.settledAt?.toISOString() ?? null,
    }));
  }

  async function readDetails(input: {
    threadId: string;
    trailId: string;
    userId: UserId;
  }): Promise<Array<ChangeTrailDocumentDetailV1 | { documentId: string; unavailable: true }>> {
    const rows = await db
      .select({
        documentId: changeTrailDocumentOccurrences.documentId,
        documentTitle: changeTrailDocumentDetails.documentTitle,
        changes: changeTrailDocumentDetails.changes,
      })
      .from(changeTrailDocumentOccurrences)
      .innerJoin(
        changeTrailShells,
        eq(changeTrailShells.id, changeTrailDocumentOccurrences.trailId),
      )
      .leftJoin(
        changeTrailDocumentDetails,
        and(
          eq(changeTrailDocumentDetails.trailId, changeTrailDocumentOccurrences.trailId),
          eq(changeTrailDocumentDetails.documentId, changeTrailDocumentOccurrences.documentId),
        ),
      )
      .where(
        and(
          eq(changeTrailDocumentOccurrences.trailId, input.trailId),
          eq(changeTrailShells.threadId, input.threadId),
        ),
      )
      .orderBy(asc(changeTrailDocumentOccurrences.documentId));

    return Promise.all(
      rows.map(async (row) => {
        if (
          row.changes === null ||
          row.documentTitle === null ||
          !(await documentAccess.canAccessDocument(input.userId, row.documentId))
        ) {
          return { documentId: row.documentId, unavailable: true as const };
        }
        return {
          trailId: input.trailId,
          documentId: row.documentId,
          documentTitle: row.documentTitle,
          changes: row.changes as TrailChangeV1[],
        };
      }),
    );
  }

  return { listShells, readDetails };
}
