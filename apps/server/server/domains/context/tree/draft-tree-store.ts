/**
 * Writes of `draft_tree_changes`: what one draft says about a node. The foundation
 * writes only `created` document rows, at the draft's location (§6.2); folders are
 * implied by what a draft places under them (O-2).
 */
import type {
  ContextSourceId,
  DocumentId,
  DraftId,
  FolderId,
  ThreadId,
  TurnId,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { draftTreeChanges } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

/** Where a draft has a document. */
export type DraftDocumentLocation = {
  contextSourceId: ContextSourceId;
  parentFolderId: FolderId | null;
  name: string;
  extension: string;
};

/** The draft created (or joined) this document at `location`. The draft can't already have the row. */
export async function recordCreated(
  db: Database,
  input: {
    draftId: DraftId;
    documentId: DocumentId;
    location: DraftDocumentLocation;
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
  },
): Promise<void> {
  await currentDrizzleDb(db).insert(draftTreeChanges).values({
    draftId: input.draftId,
    nodeKind: "document",
    nodeId: input.documentId,
    created: true,
    contextSourceId: input.location.contextSourceId,
    parentFolderId: input.location.parentFolderId,
    name: input.location.name,
    extension: input.location.extension,
    createdThreadId: input.createdBy?.threadId ?? null,
    createdTurnId: input.createdBy?.turnId ?? null,
  });
}

/** The draft stops saying anything about these documents (its settlements are the registry's). */
export async function dropDocumentRows(
  db: Database,
  input: { draftId: DraftId; documentIds: readonly DocumentId[] },
): Promise<void> {
  if (input.documentIds.length === 0) return;
  await currentDrizzleDb(db)
    .delete(draftTreeChanges)
    .where(
      and(
        eq(draftTreeChanges.draftId, input.draftId),
        eq(draftTreeChanges.nodeKind, "document"),
        inArray(draftTreeChanges.nodeId, [...input.documentIds]),
      ),
    );
}
