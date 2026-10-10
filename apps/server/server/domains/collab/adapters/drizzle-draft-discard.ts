/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around
 * it, and Work purge's disposal of a purged Work's drafts (§2.6, F10), which runs the
 * same kernel inside purge's transaction after purge's own lifecycle proof.
 *
 * Lock order (§14), after the in-process leases the callers take: the Work (purge:
 * threads, then the Work), the draft, the namespaces of every created document's source
 * and the draft's location, every affected document, id order.
 */
import type { DraftId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branchWriteJournal, documentBranches } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../shared/work-lifecycle-lock.js";
import {
  type EndUseScope,
  endUse,
  endUseScope,
  lockEndUseScope,
  withinScope,
} from "../../context/tree/end-use.js";
import type { WorkDraftDisposal, WorkProjectionMutation } from "../../projects/index.js";
import { BranchCasConflictError, type BranchCoordinator } from "../domain/branch-coordinator.js";
import type { BranchCriticalSections } from "../domain/branch-critical-sections.js";
import {
  type DiscardKernelInput,
  type DiscardKernelResult,
  type DraftBranchRef,
  DraftDiscardScopeChangedError,
  type DraftDiscardStore,
} from "../domain/draft-discard.js";
import type { Drafts } from "../domain/drafts.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";

/**
 * The kernel's whole-draft arm: every document the draft created ends its use (tombstoned
 * and released when no draft uses it), then the draft closes with every branch and its
 * settlements. The caller holds every branch's lease, the draft, its namespaces and its
 * created documents' locks.
 */
export async function discardWholeLocked(
  db: Database,
  drafts: Pick<Drafts, "close">,
  draftId: DraftId,
): Promise<DiscardKernelResult> {
  const { documentIds } = await endUseScope(db, { draftId });
  const ended = await endUse(db, { draftId, documentIds });
  await drafts.close(draftId, new Date());
  return { draftClosed: true, ...ended };
}

export type DrizzleDraftDiscard = DraftDiscardStore & {
  /** The locked kernel: the caller holds §14's leases and locks and proved the Work's state. */
  kernel(input: DiscardKernelInput): Promise<DiscardKernelResult>;
};

export function createDrizzleDraftDiscard(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "lockActive" | "close">;
    branches: Pick<ApplicationBranchStore, "getBranch">;
    coordinator: Pick<BranchCoordinator, "resetFromDocIfUnchangedWithLease">;
    workProjection: Pick<WorkProjectionMutation, "mutatePendingDraft">;
  },
): DrizzleDraftDiscard {
  async function activeBranches(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<DraftBranchRef[]> {
    if (documentIds?.length === 0) return [];
    const rows = await currentDrizzleDb(db)
      .select({ branchId: documentBranches.id, documentId: documentBranches.documentId })
      .from(documentBranches)
      .where(
        and(
          eq(documentBranches.draftId, draftId),
          eq(documentBranches.status, "active"),
          documentIds ? inArray(documentBranches.documentId, [...documentIds]) : undefined,
        ),
      );
    return rows
      .map((row) => ({ branchId: row.branchId, documentId: row.documentId as DocumentId }))
      .sort((a, b) => a.branchId.localeCompare(b.branchId));
  }

  /** Reset the draft's branch on an item from live when it holds reviewable rows (CAS). */
  async function resetItemText(
    input: Extract<DiscardKernelInput, { selection: { kind: "items" } }>,
    item: { documentId: DocumentId; draftBranchId: string },
  ): Promise<void> {
    const content = await deps.branches.getBranch(item.draftBranchId);
    // Gone with its tombstone, or no longer the draft's: nothing of the draft left to reset.
    if (
      content?.kind !== "work_draft" ||
      content.status !== "active" ||
      content.draftId !== input.draftId ||
      content.documentId !== item.documentId
    ) {
      return;
    }
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
    const liveDoc = input.liveDocs.get(item.documentId);
    if (!liveDoc) throw new Error(`Discard of ${item.documentId} holds no live document`);
    const reset = await deps.coordinator.resetFromDocIfUnchangedWithLease(input.lease, {
      branchId: content.branchId,
      upstream: liveDoc,
      expectedGeneration: content.generation,
      expectedState: content.state,
      expectedStateVector: content.stateVector,
      schemaVersion: content.schemaVersion,
    });
    if (!reset) throw new BranchCasConflictError(content.branchId);
  }

  async function kernel(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { draftId } = input;
    // Only the items arm carries leases and live documents.
    if (!("lease" in input)) return discardWholeLocked(db, deps.drafts, draftId);
    const { items } = input.selection;
    const ended = await endUse(db, {
      draftId,
      documentIds: items.filter((item) => item.origin === "created").map((item) => item.documentId),
    });
    for (const item of items) {
      if (item.draftBranchId) {
        await resetItemText(input, {
          documentId: item.documentId,
          draftBranchId: item.draftBranchId,
        });
      }
    }
    return { draftClosed: false, ...ended };
  }

  /** What the kernel will end, locked, then read again to prove it held still. */
  async function lockScope(
    draftId: DraftId,
    createdIds: readonly DocumentId[] | undefined,
    alsoDocumentIds: readonly DocumentId[],
  ): Promise<void> {
    const read = (): Promise<EndUseScope> =>
      endUseScope(db, createdIds ? { draftId, documentIds: createdIds } : { draftId });
    const scope = await read();
    await lockEndUseScope(db, scope, alsoDocumentIds);
    if (!withinScope(scope, await read())) throw new DraftDiscardScopeChangedError(draftId);
  }

  return {
    activeBranches,
    kernel,
    async discardLocked({ workId, kernel: input, leased }) {
      return runInDrizzleTransaction(db, async () => {
        await requireLockedActiveWorks(db, [workId as WorkId]);
        if (!(await deps.drafts.lockActive(input.draftId))) return null;
        const items = input.selection.kind === "items" ? input.selection.items : null;
        const itemIds = items?.map((item) => item.documentId);
        const current = await activeBranches(input.draftId, itemIds);
        if (current.some((ref) => !leased.has(ref.branchId))) {
          throw new DraftDiscardScopeChangedError(input.draftId);
        }
        await lockScope(
          input.draftId,
          items?.filter((item) => item.origin === "created").map((item) => item.documentId),
          itemIds ?? [],
        );
        return deps.workProjection.mutatePendingDraft([input.draftId], () => kernel(input));
      });
    },
  };
}

/**
 * Work purge's disposal (§2.6): discover the Work's drafts and every branch of them, any
 * status, outside any transaction; lease the branches; then, inside purge's transaction
 * after its deleted/cutoff proof, lock each draft, prove the set unchanged, lock every
 * namespace and hidden document, and discard each active draft whole through the kernel.
 * The public command's active-Work fence is never used. No pending projection: the Work
 * is being deleted.
 */
export function createDrizzleWorkDraftDisposal(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "byOriginWork" | "lockActive" | "close">;
    criticalSections: BranchCriticalSections;
  },
): WorkDraftDisposal {
  async function branchIdsOf(draftIds: readonly DraftId[]): Promise<string[]> {
    if (draftIds.length === 0) return [];
    const rows = await currentDrizzleDb(db)
      .select({ id: documentBranches.id })
      .from(documentBranches)
      .where(inArray(documentBranches.draftId, [...draftIds]));
    return rows.map((row) => row.id).sort();
  }

  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().every((id, index) => id === [...b].sort()[index]);

  return {
    async withDisposal(workId, run) {
      for (let attempt = 0; ; attempt += 1) {
        const draftIds = (await deps.drafts.byOriginWork(workId)).map((draft) => draft.id);
        const branchIds = await branchIdsOf(draftIds);
        try {
          return await deps.criticalSections.withBranches(branchIds, () =>
            run(async () => {
              const active: DraftId[] = [];
              for (const draftId of [...draftIds].sort()) {
                if (await deps.drafts.lockActive(draftId)) active.push(draftId);
              }
              const now = (await deps.drafts.byOriginWork(workId)).map((draft) => draft.id);
              if (!sameSet(now, draftIds) || !sameSet(await branchIdsOf(now), branchIds)) {
                throw new DraftDiscardScopeChangedError(draftIds[0] ?? ("" as DraftId));
              }
              const scopes = await Promise.all(
                active.map((draftId) => endUseScope(db, { draftId })),
              );
              await lockEndUseScope(db, {
                documentIds: scopes.flatMap((scope) => scope.documentIds),
                sourceIds: scopes.flatMap((scope) => scope.sourceIds),
              });
              const releasedObjects: string[] = [];
              for (const draftId of active) {
                const ended = await discardWholeLocked(db, deps.drafts, draftId);
                releasedObjects.push(...ended.releasedObjects);
              }
              return { releasedObjects };
            }),
          );
        } catch (cause) {
          if (!(cause instanceof DraftDiscardScopeChangedError) || attempt >= 1) throw cause;
        }
      }
    },
  };
}
