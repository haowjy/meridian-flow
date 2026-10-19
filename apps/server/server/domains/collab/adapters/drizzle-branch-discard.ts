/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around
 * it, and Work purge's disposal of a purged Work's branches (§2.6, F10), which runs the
 * same kernel inside purge's transaction after purge's own lifecycle proof.
 *
 * Lock order (§14), after the live scopes an item Discard holds: the Work (purge: threads,
 * then the Work), the branch, then the one verified end-use scope (`acquireEndUseScope`:
 * namespaces of every created document's source and the branch's location, re-read, then
 * the documents), then draft rows as the kernel writes them. A scope that moved aborts
 * the transaction and runs again under the callers' bounded attempts.
 *
 * The kernel reports the drafts it closed or deleted (`retired`) so the caller retires
 * exactly their rooms and thread state after commit, and reconciles the catalog of every
 * source it touched inside the transaction (F23), as Apply does.
 */

import type { BranchId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentDrafts, draftWriteJournal } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { bumpDraftRevisions } from "../../../shared/draft-revisions.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import {
  acquireEndUseScope,
  type EndUseRequest,
  EndUseScopeChangedError,
  endUse,
  hiddenDocumentIds,
  readEndUseScope,
} from "../../context/tree/end-use.js";
import type { WorkBranchDisposal, WorkProjectionMutation } from "../../projects/index.js";
import { BranchCommandExistsError } from "../domain/branch-commands.js";
import {
  BranchDiscardScopeChangedError,
  type BranchDiscardStore,
  type DiscardItem,
  type DiscardKernelInput,
  type DiscardKernelResult,
} from "../domain/branch-discard.js";
import type { Branches } from "../domain/branches.js";
import { NO_ATTEMPT_SCOPE, runBoundedAttempts } from "../domain/draft-attempts.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import {
  DraftCasConflictError,
  type DraftRead,
  materializeDraftRead,
} from "../domain/draft-store.js";
import type { PeerRetirementCause, RetiredDraft } from "../domain/peer-retirement.js";
import type { ApplicationDraftStore } from "../domain/ports/application-draft-store.js";
import { claimCommandWithinTx } from "./drizzle-branch-commands.js";
import { settleDraftGeneration } from "./drizzle-document-edits.js";

type KernelDeps = {
  branches: Pick<Branches, "close">;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
};

/** End the branch's use of `request`'s documents, then reconcile the catalog of every source touched. */
async function endUseReconciled(
  db: Database,
  deps: KernelDeps,
  branchId: BranchId,
  request: EndUseRequest,
  cause: PeerRetirementCause,
  userId?: UserId,
) {
  const scope = await readEndUseScope(db, request);
  const ended = await endUse(db, {
    branchId,
    documentIds: scope.documentIds,
    actor: userId ? { userId } : { cause: "repair" },
  });
  if (ended.tombstoned.length > 0 && scope.sourceIds.length > 0) {
    await deps.catalog.refreshSources(
      scope.sourceIds,
      ended.tombstoned.map((ref) => ref.id),
    );
  }
  return {
    ...ended,
    retired: ended.releasedDrafts.map((documentDraft) => retired(documentDraft, cause)),
  };
}

/** A draft the kernel ended, as retirement names it: a thread peer says why. */
function retired(
  documentDraft: { draftId: string; documentId: DocumentId; threadId: ThreadId | null },
  cause: PeerRetirementCause,
): RetiredDraft {
  return documentDraft.threadId
    ? { ...documentDraft, threadId: documentDraft.threadId, cause }
    : { draftId: documentDraft.draftId, documentId: documentDraft.documentId, threadId: null };
}

/**
 * Closes the branch's drafts (both kinds) on these documents, or on all of them, and
 * marks each closed text draft's pending edit parts discarded (§4.3), so model `write
 * undo` refuses `cant_undo_discarded` and the receipt card names the skip.
 */
async function closeBranchDrafts(
  db: Database,
  branchId: BranchId,
  cause: PeerRetirementCause,
  documentIds?: readonly DocumentId[],
): Promise<RetiredDraft[]> {
  if (documentIds?.length === 0) return [];
  const tx = currentDrizzleDb(db);
  const open = await tx
    .select({ id: documentDrafts.id })
    .from(documentDrafts)
    .where(
      and(
        eq(documentDrafts.branchId, branchId),
        eq(documentDrafts.status, "active"),
        documentIds ? inArray(documentDrafts.documentId, [...documentIds]) : undefined,
      ),
    );
  const closed = await bumpDraftRevisions(
    tx,
    open.map((row) => row.id),
    { status: "closed" },
  );
  for (const documentDraft of closed) {
    if (documentDraft.kind === "work_draft") {
      await settleDraftGeneration(tx, documentDraft.draftId, documentDraft.generation, "discarded");
    }
  }
  return closed.map((documentDraft) =>
    retired(
      {
        ...documentDraft,
        documentId: documentDraft.documentId as DocumentId,
        threadId: documentDraft.threadId as ThreadId | null,
      },
      cause,
    ),
  );
}

/**
 * The kernel's whole-branch arm: every document the branch created ends its use (tombstoned
 * and released when no branch uses it), then the branch row closes after every draft (closed above) and its
 * settlements. The caller holds the branch and its verified scope.
 */
async function discardWholeLocked(
  db: Database,
  deps: KernelDeps,
  branchId: BranchId,
  userId?: UserId,
): Promise<DiscardKernelResult> {
  const ended = await endUseReconciled(
    db,
    deps,
    branchId,
    { branches: [{ branchId }] },
    "branch_closed",
    userId,
  );
  const closed = await closeBranchDrafts(db, branchId, "branch_closed");
  await deps.branches.close(branchId, new Date());
  return {
    branchClosed: true,
    tombstoned: ended.tombstoned,
    releasedObjects: ended.releasedObjects,
    retired: [...ended.retired, ...closed],
  };
}

/** The verified scope, as Discard's callers retry it: a moved scope is a changed branch. */
async function acquireScope(db: Database, branchId: BranchId, request: EndUseRequest) {
  try {
    return await acquireEndUseScope(db, request);
  } catch (cause) {
    if (cause instanceof EndUseScopeChangedError)
      throw new BranchDiscardScopeChangedError(branchId);
    throw cause;
  }
}

export type DrizzleBranchDiscard = BranchDiscardStore & {
  /** The locked kernel: the caller holds §14's locks and proved the Work's state. */
  kernel(input: DiscardKernelInput): Promise<DiscardKernelResult>;
};

export function createDrizzleBranchDiscard(
  db: Database,
  deps: KernelDeps & {
    branches: Pick<Branches, "lockActive" | "close">;
    drafts: Pick<ApplicationDraftStore, "readDraftAt" | "closeThreadPeersOf">;
    coordinator: Pick<DraftCoordinator, "resetFromDoc">;
    workProjection: Pick<WorkProjectionMutation, "mutate">;
  },
): DrizzleBranchDiscard {
  /**
   * Reset the branch's draft on an item from live when it holds reviewable rows, folding away
   * every row appended before the reset locks the draft, and close that draft's thread peers
   * (rows or not). The caller's attempt owns the reset until it completes.
   */
  async function resetItemText(
    input: Extract<DiscardKernelInput, { selection: { kind: "items" } }>,
    item: { documentId: DocumentId; draftId: string },
  ): Promise<readonly RetiredDraft[]> {
    const read = await deps.drafts.readDraftAt(item.draftId);
    const content = read?.documentDraft;
    // Gone with its tombstone, or no longer the branch's: no draft of this branch remains to reset.
    if (
      !read ||
      content?.kind !== "work_draft" ||
      content.status !== "active" ||
      content.branchId !== input.branchId ||
      content.documentId !== item.documentId
    ) {
      return [];
    }
    const hasPending = async () => {
      const [pending] = await currentDrizzleDb(db)
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .where(
          and(
            eq(draftWriteJournal.draftId, content.draftId),
            eq(draftWriteJournal.generation, content.generation),
            inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .limit(1);
      return Boolean(pending);
    };
    // A healthy rowless draft has no text to reset (unless its state cannot be read: Discard
    // is the recovery for a corrupt item, rows or not), but an open reply may still hold staged
    // writes on it, so its peers close either way.
    if (!(await hasPending()) && isReadable(read)) {
      // The decision holds only under the draft row: a frame takes no other lock. One that
      // committed since the read makes this a reset after all, recomputed by the next attempt.
      const [locked] = await currentDrizzleDb(db)
        .select({ revision: documentDrafts.revision })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, content.draftId))
        .for("update");
      if (Number(locked?.revision) !== content.revision || (await hasPending()))
        throw new DraftCasConflictError(content.draftId);
      return deps.drafts.closeThreadPeersOf([content.draftId], "edit_discarded");
    }
    const liveDoc = input.liveDocs.get(item.documentId);
    if (!liveDoc) throw new Error(`Discard of ${item.documentId} holds no live document`);
    const reset = await deps.coordinator.resetFromDoc(
      {
        draftId: content.draftId,
        upstream: liveDoc,
        expectedGeneration: content.generation,
        policy: "fold",
        schemaVersion: content.schemaVersion,
      },
      input.attempt,
    );
    if (!reset) throw new DraftCasConflictError(content.draftId);
    return deps.drafts.closeThreadPeersOf([content.draftId], "edit_discarded");
  }

  async function kernel(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { branchId } = input;
    // Only the items arm carries live documents.
    if (!("liveDocs" in input)) return discardWholeLocked(db, deps, branchId, input.userId);
    const { items } = input.selection;
    // Created or edited is the document's visibility now, read under the locks the caller
    // holds: another Work's Apply may have revealed a create since the item was resolved, and
    // a revealed create is an edited item (§2.2), reset from live with its draft kept. The
    // branch's create row goes either way; only a hidden document can be tombstoned by it.
    const withRows = items.filter((item) => item.origin === "created").map((i) => i.documentId);
    const hiddenNow = await hiddenDocumentIds(db, withRows);
    const isCreated = (item: DiscardItem) => hiddenNow.has(item.documentId);
    const created = items.filter(isCreated).map((item) => item.documentId);
    const ended = await endUseReconciled(
      db,
      deps,
      branchId,
      { branches: [{ branchId, documentIds: withRows }] },
      "document_discarded",
      input.userId,
    );
    // A hidden create another branch still uses stays, but this branch's drafts on it end.
    const retiredDrafts: RetiredDraft[] = [
      ...ended.retired,
      ...(await closeBranchDrafts(db, branchId, "document_discarded", created)),
    ];
    for (const item of items) {
      if (item.draftId && !isCreated(item)) {
        retiredDrafts.push(
          ...(await resetItemText(input, {
            documentId: item.documentId,
            draftId: item.draftId,
          })),
        );
      }
    }
    return {
      branchClosed: false,
      tombstoned: ended.tombstoned,
      releasedObjects: ended.releasedObjects,
      retired: retiredDrafts,
    };
  }

  return {
    kernel,
    deferUntilCommit: deferUntilDrizzleCommit,
    async discardLocked({ workId, kernel: input, command }) {
      return runInDrizzleTransaction(db, async () => {
        // The command's claim is the transaction's first write (§4.6).
        if (
          command &&
          !(await claimCommandWithinTx(currentDrizzleDb(db), command.envelope, command.result))
        ) {
          throw new BranchCommandExistsError(command.envelope.commandId);
        }
        // The Work and the branch enter the Work boundary before the branch row and the scope
        // locks (decision D17).
        return deps.workProjection.mutate(
          { works: [workId as WorkId], branches: [input.branchId] },
          async () => {
            if (!(await deps.branches.lockActive(input.branchId))) return null;
            const items = input.selection.kind === "items" ? input.selection.items : null;
            const itemIds = items?.map((item) => item.documentId);
            await acquireScope(db, input.branchId, {
              branches: [
                {
                  branchId: input.branchId,
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
            return kernel(input);
          },
          { seam: true, requireActive: true },
        );
      });
    },
  };
}

/** Purge transactions run again when a branch's end-use scope moved under them. */
const PURGE_ATTEMPTS = 3;

/**
 * Work purge's disposal (§2.6): inside purge's transaction after its deleted/cutoff proof,
 * lock each of the Work's active branches, acquire the verified end-use scope of every one,
 * and discard each whole through the kernel. A scope that moved rolls the purge transaction
 * back and runs it again, a bounded attempt each. The public command's active-Work fence is
 * never used. No pending projection and no thread retirement: the Work and its threads are
 * being deleted.
 */
export function createDrizzleWorkBranchDisposal(
  db: Database,
  deps: KernelDeps & { branches: Pick<Branches, "byOriginWork" | "lockActive" | "close"> },
): WorkBranchDisposal {
  async function dispose(workId: WorkId): Promise<{ releasedObjects: readonly string[] }> {
    const branchIds = (await deps.branches.byOriginWork(workId)).map((branch) => branch.id).sort();
    const active: BranchId[] = [];
    for (const branchId of branchIds) {
      if (await deps.branches.lockActive(branchId)) active.push(branchId);
    }
    if (active.length === 0) return { releasedObjects: [] };
    await acquireScope(db, active[0] as BranchId, {
      branches: active.map((branchId) => ({ branchId })),
    });
    const releasedObjects: string[] = [];
    for (const branchId of active) {
      const ended = await discardWholeLocked(db, deps, branchId);
      releasedObjects.push(...ended.releasedObjects);
    }
    return { releasedObjects };
  }

  return {
    withDisposal(workId, run) {
      return runBoundedAttempts({
        bound: PURGE_ATTEMPTS,
        // The purge transaction `run` opens is each attempt's one commit scope.
        scope: NO_ATTEMPT_SCOPE,
        isMiss: (cause) => cause instanceof BranchDiscardScopeChangedError,
        run: (attempt) => attempt.commit(() => run(() => dispose(workId))),
        exhausted: (cause) => {
          throw cause;
        },
      });
    },
  };
}

function isReadable(read: DraftRead): boolean {
  try {
    materializeDraftRead(read).destroy();
    return true;
  } catch {
    return false;
  }
}
