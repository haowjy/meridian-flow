/** Thread-owned trail reads that retain captured evidence when the live document is unavailable. */
import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  changeTrailDocumentOccurrences,
  changeTrailShells,
} from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DocumentAccessPort } from "../../../lib/document-access.js";
import type {
  ChangeTrailDocumentDetailV1,
  ChangeTrailShellV1,
} from "../domain/trail-read-kernel.js";
import { parseTrailChangesV1 } from "../domain/trail-read-kernel.js";

export type ChangeTrailReader = ReturnType<typeof createDrizzleChangeTrailReader>;

export function createDrizzleChangeTrailReader(
  db: Database,
  documentAccess: Pick<DocumentAccessPort, "documentAccessState">,
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
        detailDocumentId: changeTrailDocumentDetails.documentId,
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

    const authorized = await Promise.all(
      rows.map(async (row) => {
        if (row.detailDocumentId === null) {
          return { kind: "unavailable" as const, documentId: row.documentId };
        }
        const anchorState = await documentAccess.documentAccessState(input.userId, row.documentId);
        return anchorState
          ? { kind: "detail" as const, documentId: row.documentId, anchorState }
          : null;
      }),
    );
    const authorizedDocumentIds = authorized.flatMap((row) =>
      row?.kind === "detail" ? [row.documentId] : [],
    );
    const detailRows =
      authorizedDocumentIds.length === 0
        ? []
        : await db
            .select({
              documentId: changeTrailDocumentDetails.documentId,
              documentTitle: changeTrailDocumentDetails.documentTitle,
              changes: changeTrailDocumentDetails.changes,
            })
            .from(changeTrailDocumentDetails)
            .where(
              and(
                eq(changeTrailDocumentDetails.trailId, input.trailId),
                inArray(changeTrailDocumentDetails.documentId, authorizedDocumentIds),
              ),
            );
    const detailsByDocumentId = new Map(detailRows.map((row) => [row.documentId, row]));

    const result: Array<ChangeTrailDocumentDetailV1 | { documentId: string; unavailable: true }> =
      [];
    for (const access of authorized) {
      if (!access) continue;
      if (access.kind === "unavailable") {
        result.push({ documentId: access.documentId, unavailable: true });
        continue;
      }
      const row = detailsByDocumentId.get(access.documentId);
      if (!row) {
        result.push({ documentId: access.documentId, unavailable: true });
        continue;
      }
      result.push({
        trailId: input.trailId,
        documentId: row.documentId,
        documentTitle: row.documentTitle,
        changes: parseTrailChangesV1(row.changes),
        anchorState: access.anchorState,
      });
    }
    return result;
  }

  return { listShells, readDetails };
}
