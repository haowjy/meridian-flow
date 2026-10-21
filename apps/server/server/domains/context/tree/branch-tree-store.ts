/**
 * Writes of `branch_tree_changes`: what one branch says about a node. The foundation
 * writes only `created` document rows, identity and attribution (the place is the
 * document row's, §6.2); folders are implied by what a branch places under them (O-2).
 */
import type { BranchId, DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branchTreeChanges } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

/** The branch created (or joined) this document; its place is the document row's. The branch can't already have the row. */
export async function recordCreated(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
  },
): Promise<void> {
  await currentDrizzleDb(db)
    .insert(branchTreeChanges)
    .values({
      branchId: input.branchId,
      nodeKind: "document",
      nodeId: input.documentId,
      created: true,
      createdThreadId: input.createdBy?.threadId ?? null,
      createdTurnId: input.createdBy?.turnId ?? null,
    });
}

/** The branch stops saying anything about these documents (its settlements are the registry's). */
export async function dropDocumentRows(
  db: Database,
  input: { branchId: BranchId; documentIds: readonly DocumentId[] },
): Promise<void> {
  if (input.documentIds.length === 0) return;
  await currentDrizzleDb(db)
    .delete(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.branchId, input.branchId),
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.nodeId, [...input.documentIds]),
      ),
    );
}
