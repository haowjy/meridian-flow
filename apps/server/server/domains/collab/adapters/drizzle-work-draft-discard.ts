/** Atomic full Discard with branch → live → Work locking and selective draft-only membership cleanup. */

import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  contextSources,
  documentBranches,
  documents,
} from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleSavepoint } from "../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../shared/work-lifecycle-lock.js";
import { BranchCasConflictError, type BranchCoordinator } from "../domain/branch-coordinator.js";
import type { BranchCriticalSections } from "../domain/branch-critical-sections.js";
import type { BranchJournalReadStore } from "../domain/branch-push-contracts.js";
import type {
  ApplicationBranchStore,
  WorkDraftDiscard,
  WorkDraftEmptySettlement,
} from "../domain/ports/application-branch-store.js";

export function createDrizzleWorkDraftDiscard(
  db: Database,
  branches: ApplicationBranchStore,
  coordinator: BranchCoordinator,
  criticalSections: BranchCriticalSections,
  liveCoordinator: { withDocument<T>(id: string, run: (doc: Y.Doc) => Promise<T>): Promise<T> },
): WorkDraftDiscard {
  return async (command) => {
    const [manifest] = command.draftOnlyProjectId
      ? await currentDrizzleDb(db)
          .select({ branchId: documentBranches.id, documentId: documents.id })
          .from(documentBranches)
          .innerJoin(documents, eq(documents.id, documentBranches.documentId))
          .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
          .where(
            and(
              eq(contextSources.projectId, command.draftOnlyProjectId),
              eq(documents.kind, "manifest"),
              isNull(documents.deletedAt),
              eq(documentBranches.kind, "work_draft"),
              eq(documentBranches.status, "active"),
              eq(documentBranches.workId, command.workId),
            ),
          )
          .limit(1)
      : [];
    if (command.draftOnlyProjectId && !manifest)
      throw new Error("Draft discard manifest is unavailable");
    await criticalSections.withBranches(
      [...(manifest ? [manifest.branchId] : []), command.contentBranchId],
      (lease) =>
        liveCoordinator.withDocument(command.documentId, async (liveDoc) => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              await runInDrizzleSavepoint(db, async () => {
                await requireLockedActiveWorks(db, [command.workId]);
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
                const liveMembership =
                  manifest && command.draftOnlyProjectId
                    ? await branches.resolveManifestMembership({
                        projectId: command.draftOnlyProjectId,
                      })
                    : null;
                if (manifest && !liveMembership?.members.includes(command.documentId))
                  await branches.removeWorkManifestEntryForDraftDiscard({
                    lease,
                    manifestBranchId: manifest.branchId,
                    manifestDocumentId: manifest.documentId,
                    workId: command.workId,
                    documentId: command.documentId,
                  });
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

/** Reuses full Discard's generation reset only after a fenced empty-review check. */
export function createDrizzleEmptyDraftSettlement(
  db: Database,
  branches: ApplicationBranchStore,
  coordinator: BranchCoordinator,
  criticalSections: BranchCriticalSections,
  liveCoordinator: { withDocument<T>(id: string, run: (doc: Y.Doc) => Promise<T>): Promise<T> },
  journal: BranchJournalReadStore,
): WorkDraftEmptySettlement {
  return (command) =>
    criticalSections.withBranches([command.branchId], (lease) =>
      liveCoordinator.withDocument(command.documentId, async (liveDoc) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await runInDrizzleSavepoint(db, async () => {
              await requireLockedActiveWorks(db, [command.workId]);
              const branch = await branches.getBranch(command.branchId);
              if (
                branch?.kind !== "work_draft" ||
                branch.status !== "active" ||
                branch.workId !== command.workId ||
                branch.documentId !== command.documentId
              )
                return { draftClosed: false } as const;
              const rows = await journal.listReviewableJournalRows(
                branch.branchId,
                branch.generation,
              );
              const draftDoc = createCollabYDoc({ gc: false });
              const frozenLive = createCollabYDoc({ gc: false });
              try {
                Y.applyUpdate(draftDoc, branch.state);
                Y.applyUpdate(frozenLive, Y.encodeStateAsUpdate(liveDoc));
                if (!command.isEmpty(frozenLive, draftDoc, rows))
                  return { draftClosed: false } as const;
                const history = await journal.listJournalRowsForBranch({
                  branchId: branch.branchId,
                  generation: branch.generation,
                });
                const draftDisposition = history.some((row) => row.status === "pushed")
                  ? ("applied" as const)
                  : ("discarded" as const);
                const reset = await coordinator.resetFromDocIfUnchangedWithLease(lease, {
                  branchId: branch.branchId,
                  upstream: frozenLive,
                  expectedGeneration: branch.generation,
                  expectedState: branch.state,
                  expectedStateVector: branch.stateVector,
                  schemaVersion: branch.schemaVersion,
                });
                if (!reset) throw new BranchCasConflictError(branch.branchId);
                return { draftClosed: true, draftDisposition } as const;
              } finally {
                draftDoc.destroy();
                frozenLive.destroy();
              }
            });
          } catch (error) {
            if (!(error instanceof BranchCasConflictError) || attempt >= 3) throw error;
          }
        }
      }),
    );
}
