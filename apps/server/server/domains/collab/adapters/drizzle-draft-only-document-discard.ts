/** Atomic draft-only Discard: selective manifest removal and content reset, including archived Work. */
import type { Database } from "@meridian/database";
import { contextSources, documentBranches, documents } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleSavepoint } from "../../../shared/drizzle-transaction.js";
import { lockWorkLifecycle } from "../../../shared/work-lifecycle-lock.js";
import { WorkLifecycleUnavailableError } from "../../projects/domain/work-lifecycle.js";
import { BranchCasConflictError, type BranchCoordinator } from "../domain/branch-coordinator.js";
import type { BranchCriticalSections } from "../domain/branch-critical-sections.js";
import type {
  ApplicationBranchStore,
  DraftOnlyDocumentDiscard,
} from "../domain/ports/application-branch-store.js";

export function createDrizzleDraftOnlyDocumentDiscard(
  db: Database,
  branches: ApplicationBranchStore,
  coordinator: BranchCoordinator,
  criticalSections: BranchCriticalSections,
): DraftOnlyDocumentDiscard {
  return async (command) => {
    const [manifest] = await currentDrizzleDb(db)
      .select({ branchId: documentBranches.id, documentId: documents.id })
      .from(documentBranches)
      .innerJoin(documents, eq(documents.id, documentBranches.documentId))
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .where(
        and(
          eq(contextSources.projectId, command.projectId),
          eq(documents.kind, "manifest"),
          isNull(documents.deletedAt),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
          eq(documentBranches.workId, command.workId),
        ),
      )
      .limit(1);
    if (!manifest) throw new Error("Draft discard manifest is unavailable");
    await criticalSections.withBranches(
      [manifest.branchId, command.contentBranchId],
      async (lease) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await runInDrizzleSavepoint(db, async () => {
              const lifecycle = await lockWorkLifecycle(db, command.workId);
              if (lifecycle !== "active" && lifecycle !== "archived")
                throw new WorkLifecycleUnavailableError(command.workId, lifecycle);
              const content = await branches.getBranch(command.contentBranchId);
              if (
                content?.kind !== "work_draft" ||
                content.status !== "active" ||
                content.workId !== command.workId ||
                content.documentId !== command.documentId
              )
                throw new Error("Draft discard content owner changed");
              await branches.removeWorkManifestEntryForDraftDiscard({
                lease,
                manifestBranchId: manifest.branchId,
                manifestDocumentId: manifest.documentId,
                workId: command.workId,
                documentId: command.documentId,
              });
              const reset = await coordinator.resetFromDocIfUnchangedWithLease(lease, {
                branchId: content.branchId,
                upstream: command.liveDoc,
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
      },
    );
  };
}
