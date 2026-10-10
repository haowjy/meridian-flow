/**
 * Atomic full Discard with branch → live → Work locking. A document the Work's draft
 * created ends that draft's use (bridge until lane D's `discardItems`, contract §9.1).
 */

import type { DraftId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branchWriteJournal } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import type * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleSavepoint } from "../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../shared/work-lifecycle-lock.js";
import { lockDocumentNamespaces } from "../../context/adapters/context-fs/document-locations.js";
import { endUse } from "../../context/tree/end-use.js";
import { BranchCasConflictError, type BranchCoordinator } from "../domain/branch-coordinator.js";
import type { BranchCriticalSections } from "../domain/branch-critical-sections.js";
import type { Drafts } from "../domain/drafts.js";
import type {
  ApplicationBranchStore,
  WorkDraftDiscard,
} from "../domain/ports/application-branch-store.js";

export function createDrizzleWorkDraftDiscard(
  db: Database,
  branches: ApplicationBranchStore,
  coordinator: BranchCoordinator,
  criticalSections: BranchCriticalSections,
  liveCoordinator: { withDocument<T>(id: string, run: (doc: Y.Doc) => Promise<T>): Promise<T> },
  drafts: Pick<Drafts, "lockActive">,
): WorkDraftDiscard {
  /** Work, then the draft, then the namespaces, then the document (contract §14). */
  async function endCreatedUse(draftId: DraftId, documentId: string): Promise<void> {
    if (!(await drafts.lockActive(draftId))) return;
    await lockDocumentNamespaces(db, [documentId]);
    await endUse(db, { draftId, documentIds: [documentId as never] });
  }

  return async (command) => {
    await criticalSections.withBranches([command.contentBranchId], (lease) =>
      liveCoordinator.withDocument(command.documentId, async (liveDoc) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await runInDrizzleSavepoint(db, async () => {
              await requireLockedActiveWorks(db, [command.workId]);
              if (command.createdBy) await endCreatedUse(command.createdBy, command.documentId);
              const content = await branches.getBranch(command.contentBranchId);
              if (
                content?.kind !== "work_draft" ||
                content.status !== "active" ||
                content.workId !== command.workId ||
                content.documentId !== command.documentId
              )
                throw new Error("Draft discard content owner changed");
              const [pending] = await currentDrizzleDb(db)
                .select({ id: branchWriteJournal.id })
                .from(branchWriteJournal)
                .where(
                  and(
                    eq(branchWriteJournal.branchId, content.branchId),
                    eq(branchWriteJournal.generation, content.generation),
                    inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
                  ),
                )
                .limit(1);
              if (!pending) return;
              const reset = await coordinator.resetFromDocIfUnchangedWithLease(lease, {
                branchId: content.branchId,
                upstream: liveDoc,
                expectedGeneration: content.generation,
                expectedState: content.state,
                expectedStateVector: content.stateVector,
                schemaVersion: content.schemaVersion,
              });
              if (!reset) throw new BranchCasConflictError(content.branchId);
            });
            return;
          } catch (error) {
            if (!(error instanceof BranchCasConflictError) || attempt >= 3) throw error;
          }
        }
      }),
    );
  };
}
