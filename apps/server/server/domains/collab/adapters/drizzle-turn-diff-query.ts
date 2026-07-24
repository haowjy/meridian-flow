/** Read-only projection of folded collab trail rows for agent turn self-inspection. */

import type { TurnDiffChange, TurnDiffQuery } from "@meridian/agent-edit";
import type { TrailChangeV1 } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { changeTrailDocumentDetails, changeTrailShells } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { parseTrailChangesV1 } from "../domain/trail-read-kernel.js";

export function mapTrailChangeToTurnDiff(
  change: TrailChangeV1,
  documentId: string,
): TurnDiffChange {
  const protectedBody = change.writerProtection?.body;
  const sweptBody = change.swept?.removed;
  const capturedBody =
    protectedBody?.status === "available"
      ? protectedBody.markdown
      : sweptBody?.status === "available"
        ? sweptBody.markdown
        : null;
  const mergedOver = capturedBody
    ? [{ body: capturedBody, writerAuthored: change.writerProtection !== undefined }]
    : [];

  return {
    kind: change.kind,
    documentId,
    before: change.beforeText,
    after: change.afterTextAtReceipt,
    mergedOver,
  };
}

export function createDrizzleTurnDiffQuery(db: Database): TurnDiffQuery {
  return {
    async query(threadId, turnId, documentId) {
      const [shell] = await db
        .select({ id: changeTrailShells.id, state: changeTrailShells.state })
        .from(changeTrailShells)
        .where(
          and(
            eq(changeTrailShells.threadId, threadId),
            eq(changeTrailShells.turnId, turnId),
            eq(changeTrailShells.ownerKind, "turn"),
          ),
        )
        .limit(1);
      if (!shell) return null;

      const detailRows = await db
        .select({
          documentId: changeTrailDocumentDetails.documentId,
          changes: changeTrailDocumentDetails.changes,
        })
        .from(changeTrailDocumentDetails)
        .where(
          and(
            eq(changeTrailDocumentDetails.trailId, shell.id),
            documentId ? eq(changeTrailDocumentDetails.documentId, documentId) : undefined,
          ),
        );
      const documentIds = detailRows.map((row) => row.documentId);
      const changes = detailRows.flatMap((row) =>
        parseTrailChangesV1(row.changes).map((change) =>
          mapTrailChangeToTurnDiff(change, row.documentId),
        ),
      );

      let sharedEffects = false;
      if (documentIds.length > 0) {
        const [sharedDetail] = await db
          .select({ documentId: changeTrailDocumentDetails.documentId })
          .from(changeTrailDocumentDetails)
          .innerJoin(
            changeTrailShells,
            eq(changeTrailShells.id, changeTrailDocumentDetails.trailId),
          )
          .where(
            and(
              eq(changeTrailShells.threadId, threadId),
              eq(changeTrailShells.ownerKind, "shared"),
              inArray(changeTrailDocumentDetails.documentId, documentIds),
            ),
          )
          .limit(1);
        sharedEffects = sharedDetail !== undefined;
      }

      return { trailState: shell.state, changes, sharedEffects };
    },
  };
}
