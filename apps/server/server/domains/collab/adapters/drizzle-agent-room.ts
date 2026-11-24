import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId, DraftId, LinkView } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { documents, draftTreeNodes } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";

/**
 * The room a model call at `view` reads and writes `documentId` in (design §5): Live at Live; at a
 * draft, the draft's fork room whether or not the draft has written there, except for a document
 * only the draft holds (its pending create), whose text is in its own Live room.
 */
export async function agentRoomFor(
  db: DrizzleDb,
  documentId: string,
  view: LinkView,
): Promise<DocumentRoom> {
  const draftId = view.kind === "draft" ? view.draftId : null;
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
