import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId, DraftId } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { documents, draftTreeNodes } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDestination } from "../domain/agent-destination.js";

export async function agentRoomFor(db: DrizzleDb, documentId: string): Promise<DocumentRoom> {
  const destination = currentDestination();
  const draftId = destination.kind === "draft" ? destination.draftId : null;
  const [row] = await db
    .select({ onlyInDraft: draftTreeNodes.existsOnlyInDraft })
    .from(documents)
    .leftJoin(
      draftTreeNodes,
      and(eq(draftTreeNodes.id, documents.id), eq(draftTreeNodes.draftId, draftId ?? "")),
    )
    .where(and(eq(documents.id, documentId as DocumentId), isNull(documents.contentPurgedAt)));
  if (!row) throw new DocumentNotFoundError(documentId);
  return draftId && !row.onlyInDraft
    ? { kind: "fork", draftId: draftId as DraftId, documentId }
    : { kind: "live", documentId };
}
