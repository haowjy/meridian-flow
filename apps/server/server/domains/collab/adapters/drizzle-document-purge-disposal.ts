/** Collab-owned locking and draft retirement for one document content purge attempt. */
import type { BranchId, DocumentId, WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches, branchTreeChanges, documentDrafts } from "@meridian/database/schema";
import { and, eq, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentPurgeDraftDisposal } from "../../context/ports/document-trash.js";
import { acquireTreeScope, TreeScopeChangedError } from "../../context/tree/mutation-scope.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import { NO_ATTEMPT_SCOPE, runBoundedAttempts } from "../domain/draft-attempts.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { lockActiveDrafts } from "./drizzle-draft-close.js";

const PURGE_ATTEMPTS = 3;

/**
 * Draft appends lock only their draft row, while tree writes lock Work then branch. Holding
 * both sets before the purge recheck makes "no pending change" stable until commit.
 */
export function createDrizzleDocumentPurgeDisposal(
  db: Database,
  deps: {
    branches: Pick<Branches, "lockActive">;
    close: Pick<DraftClose, "closeDrafts">;
    workProjection: Pick<WorkProjectionMutation, "mutate">;
  },
): DocumentPurgeDraftDisposal {
  async function activeOwners(documentId: DocumentId) {
    return currentDrizzleDb(db)
      .selectDistinct({ branchId: branches.id, workId: branches.originWorkId })
      .from(branches)
      .leftJoin(
        documentDrafts,
        and(eq(documentDrafts.branchId, branches.id), eq(documentDrafts.documentId, documentId)),
      )
      .leftJoin(
        branchTreeChanges,
        and(
          eq(branchTreeChanges.branchId, branches.id),
          eq(branchTreeChanges.nodeKind, "document"),
          eq(branchTreeChanges.nodeId, documentId),
        ),
      )
      .where(
        and(
          eq(branches.status, "active"),
          or(eq(documentDrafts.status, "active"), eq(branchTreeChanges.nodeId, documentId)),
        ),
      );
  }

  return {
    withDisposal(documentId, run) {
      return runBoundedAttempts({
        bound: PURGE_ATTEMPTS,
        scope: NO_ATTEMPT_SCOPE,
        isMiss: (cause) => cause instanceof TreeScopeChangedError,
        run: (attempt) =>
          attempt.commit(async () => {
            const owners = await activeOwners(documentId);
            const branchIds = owners.map(({ branchId }) => branchId as BranchId).sort();
            const workIds = owners
              .flatMap(({ workId }) => (workId ? [workId as WorkId] : []))
              .sort();
            return deps.workProjection.mutate({ works: workIds, branches: branchIds }, async () => {
              const active: BranchId[] = [];
              for (const branchId of branchIds) {
                if (await deps.branches.lockActive(branchId)) active.push(branchId);
              }
              await acquireTreeScope(db, {
                branches: active.map((branchId) => ({ branchId, documentIds: [documentId] })),
                documentIds: [documentId],
              });
              await lockActiveDrafts(currentDrizzleDb(db), { documentIds: [documentId] });
              return run(async () => {
                await deps.close.closeDrafts(
                  currentDrizzleDb(db),
                  { documentIds: [documentId] },
                  "document_discarded",
                );
              });
            });
          }),
        exhausted: (cause) => {
          throw cause;
        },
      });
    },
  };
}
