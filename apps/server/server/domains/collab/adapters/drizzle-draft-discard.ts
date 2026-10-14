/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around
 * it, and Work purge's disposal of a purged Work's drafts (§2.6, F10), which runs the
 * same kernel inside purge's transaction after purge's own lifecycle proof.
 *
 * Lock order (§14), after the in-process leases the callers take: the Work (purge:
 * threads, then the Work), the draft, then the one verified end-use scope
 * (`acquireEndUseScope`: namespaces of every created document's source and the draft's
 * location, re-read, then the documents). A scope that moved aborts the transaction and
 * rediscovers under the callers' bounded retry.
 *
 * The kernel reports the branches it closed or deleted (`retired`) so the caller retires
 * exactly their rooms and thread state after commit, and reconciles the catalog of every
 * source it touched inside the transaction (F23), as Apply does.
 */

import type { DraftId, ThreadId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../shared/work-lifecycle-lock.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import {
  acquireEndUseScope,
  type EndUseRequest,
  EndUseScopeChangedError,
  endUse,
  hiddenDocumentIds,
  readEndUseScope,
} from "../../context/tree/end-use.js";
import type { WorkDraftDisposal, WorkProjectionMutation } from "../../projects/index.js";
import type { BranchCriticalSections } from "../domain/branch-critical-sections.js";
import { DraftCommandExistsError } from "../domain/draft-commands.js";
import {
  type DiscardKernelInput,
  type DiscardKernelResult,
  type DraftBranchRef,
  DraftDiscardScopeChangedError,
  type DraftDiscardStore,
} from "../domain/draft-discard.js";
import type { Drafts } from "../domain/drafts.js";
import type { PeerRetirementCause, RetiredBranch } from "../domain/peer-retirement.js";
import { discardDraftEditParts } from "./drizzle-document-edits.js";
import { claimCommandWithinTx } from "./drizzle-draft-commands.js";

type KernelDeps = {
  drafts: Pick<Drafts, "close">;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
};

/** End the draft's use of `request`'s documents, then reconcile the catalog of every source touched. */
async function endUseReconciled(
  db: Database,
  deps: KernelDeps,
  draftId: DraftId,
  request: EndUseRequest,
  cause: PeerRetirementCause,
) {
  const scope = await readEndUseScope(db, request);
  const ended = await endUse(db, { draftId, documentIds: scope.documentIds });
  if (ended.tombstoned.length > 0 && scope.sourceIds.length > 0) {
    await deps.catalog.refreshSources(
      scope.sourceIds,
      ended.tombstoned.map((ref) => ref.id),
    );
  }
  return { ...ended, retired: ended.releasedBranches.map((branch) => retired(branch, cause)) };
}

/** A branch the kernel ended, as retirement names it: a thread peer says why. */
function retired(
  branch: { branchId: string; documentId: DocumentId; threadId: ThreadId | null },
  cause: PeerRetirementCause,
): RetiredBranch {
  return branch.threadId
    ? { ...branch, threadId: branch.threadId, cause }
    : { branchId: branch.branchId, documentId: branch.documentId, threadId: null };
}

/**
 * Closes the draft's branches (both kinds) on these documents, or on all of them, and
 * marks each closed text branch's pending edit parts discarded (§4.3), so model `write
 * undo` refuses `cant_undo_discarded` and the receipt card names the skip.
 */
async function closeDraftBranches(
  db: Database,
  draftId: DraftId,
  cause: PeerRetirementCause | ((documentId: DocumentId) => PeerRetirementCause),
  documentIds?: readonly DocumentId[],
): Promise<RetiredBranch[]> {
  if (documentIds?.length === 0) return [];
  const tx = currentDrizzleDb(db);
  const closed = await tx
    .update(documentBranches)
    .set({ status: "closed", updatedAt: new Date() })
    .where(
      and(
        eq(documentBranches.draftId, draftId),
        eq(documentBranches.status, "active"),
        documentIds ? inArray(documentBranches.documentId, [...documentIds]) : undefined,
      ),
    )
    .returning({
      branchId: documentBranches.id,
      documentId: documentBranches.documentId,
      threadId: documentBranches.threadId,
      kind: documentBranches.kind,
    });
  const textBranches = closed.filter((branch) => branch.kind === "work_draft");
  if (textBranches.length > 0) {
    await discardDraftEditParts(
      tx,
      textBranches.map((branch) => branch.branchId),
    );
  }
  return closed.map((branch) => {
    const documentId = branch.documentId as DocumentId;
    return retired(
      { ...branch, documentId, threadId: branch.threadId as ThreadId | null },
      typeof cause === "function" ? cause(documentId) : cause,
    );
  });
}

/**
 * The kernel's whole-draft arm: every document the draft created ends its use (tombstoned
 * and released when no draft uses it), then the draft row closes after every branch (closed above) and its
 * settlements. The caller holds every branch's lease, the draft and its verified scope.
 */
export async function discardWholeLocked(
  db: Database,
  deps: KernelDeps,
  draftId: DraftId,
): Promise<DiscardKernelResult> {
  const ended = await endUseReconciled(
    db,
    deps,
    draftId,
    { drafts: [{ draftId }] },
    "draft_closed",
  );
  const closed = await closeDraftBranches(db, draftId, "draft_closed");
  await deps.drafts.close(draftId, new Date());
  return {
    draftClosed: true,
    tombstoned: ended.tombstoned,
    releasedObjects: ended.releasedObjects,
    retired: [...ended.retired, ...closed],
  };
}

/** The verified scope, as Discard's callers retry it: a moved scope is a changed draft. */
async function acquireScope(db: Database, draftId: DraftId, request: EndUseRequest) {
  try {
    return await acquireEndUseScope(db, request);
  } catch (cause) {
    if (cause instanceof EndUseScopeChangedError) throw new DraftDiscardScopeChangedError(draftId);
    throw cause;
  }
}

export type DrizzleDraftDiscard = DraftDiscardStore & {
  /** The locked kernel: the caller holds §14's leases and locks and proved the Work's state. */
  kernel(input: DiscardKernelInput): Promise<DiscardKernelResult>;
};

export function createDrizzleDraftDiscard(
  db: Database,
  deps: KernelDeps & {
    drafts: Pick<Drafts, "lockActive" | "close">;
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

  async function kernel(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { draftId } = input;
    if (input.selection.kind === "whole") return discardWholeLocked(db, deps, draftId);
    const { items } = input.selection;
    // Created or edited is the document's visibility now, read under the locks the caller
    // holds: another Work's Apply may have revealed a create since the item was resolved.
    // The draft's create row goes either way; only a hidden document can be tombstoned by it.
    const withRows = items.filter((item) => item.origin === "created").map((i) => i.documentId);
    // Read before the end of use tombstones what no draft uses any more (§5.2): a hidden create is
    // a discarded document, a live document (a revealed create, an edit) a discarded edit.
    const hiddenNow = await hiddenDocumentIds(
      db,
      items.map((item) => item.documentId),
    );
    const ended = await endUseReconciled(
      db,
      deps,
      draftId,
      { drafts: [{ draftId, documentIds: withRows }] },
      "document_discarded",
    );
    // Close-only: the items' branches end with their pending edit parts marked discarded. The
    // review is a pure function of the text, so a discarded item simply leaves the list.
    const closed = await closeDraftBranches(
      db,
      draftId,
      (documentId) => (hiddenNow.has(documentId) ? "document_discarded" : "edit_discarded"),
      items.map((item) => item.documentId),
    );
    return {
      draftClosed: false,
      tombstoned: ended.tombstoned,
      releasedObjects: ended.releasedObjects,
      retired: [...ended.retired, ...closed],
    };
  }

  return {
    activeBranches,
    kernel,
    async discardLocked({ workId, kernel: input, leased, command }) {
      return runInDrizzleTransaction(db, async () => {
        // The command's claim is the transaction's first write (§4.6).
        if (
          command &&
          !(await claimCommandWithinTx(currentDrizzleDb(db), command.envelope, command.result))
        ) {
          throw new DraftCommandExistsError(command.envelope.commandId);
        }
        await requireLockedActiveWorks(db, [workId as WorkId]);
        if (!(await deps.drafts.lockActive(input.draftId))) return null;
        const items = input.selection.kind === "items" ? input.selection.items : null;
        const itemIds = items?.map((item) => item.documentId);
        const current = await activeBranches(input.draftId, itemIds);
        if (current.some((ref) => !leased.has(ref.branchId))) {
          throw new DraftDiscardScopeChangedError(input.draftId);
        }
        await acquireScope(db, input.draftId, {
          drafts: [
            {
              draftId: input.draftId,
              ...(items
                ? {
                    documentIds: items
                      .filter((item) => item.origin === "created")
                      .map((item) => item.documentId),
                  }
                : {}),
            },
          ],
          documentIds: itemIds ?? [],
        });
        return deps.workProjection.mutatePendingDraft([input.draftId], () => kernel(input));
      });
    },
  };
}

/** Discovery, leases and the purge transaction, rediscovered when the scope moves. */
const PURGE_ATTEMPTS = 3;

/**
 * Work purge's disposal (§2.6): discover the Work's drafts and every branch of them, any
 * status, outside any transaction; lease the branches; then, inside purge's transaction
 * after its deleted/cutoff proof, lock each draft, prove the set unchanged, acquire the
 * verified end-use scope of every active draft, and discard each whole through the
 * kernel. The public command's active-Work fence is never used. No pending projection
 * and no thread retirement: the Work and its threads are being deleted.
 */
export function createDrizzleWorkDraftDisposal(
  db: Database,
  deps: KernelDeps & {
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

  const sameSet = (a: readonly string[], b: readonly string[]) => {
    const sorted = [...b].sort();
    return a.length === b.length && [...a].sort().every((id, index) => id === sorted[index]);
  };

  return {
    async withDisposal(workId, run) {
      for (let attempt = 1; ; attempt += 1) {
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
              await acquireScope(db, active[0] ?? ("" as DraftId), {
                drafts: active.map((draftId) => ({ draftId })),
              });
              const releasedObjects: string[] = [];
              for (const draftId of active) {
                const ended = await discardWholeLocked(db, deps, draftId);
                releasedObjects.push(...ended.releasedObjects);
              }
              return { releasedObjects };
            }),
          );
        } catch (cause) {
          if (!(cause instanceof DraftDiscardScopeChangedError) || attempt >= PURGE_ATTEMPTS) {
            throw cause;
          }
        }
      }
    },
  };
}
