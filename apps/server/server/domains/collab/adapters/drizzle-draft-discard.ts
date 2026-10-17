/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around
 * it, and Work purge's disposal of a purged Work's drafts (§2.6, F10), which runs the
 * same kernel inside purge's transaction after purge's own lifecycle proof.
 *
 * Lock order (§14), after the live scopes an item Discard holds: the Work (purge: threads,
 * then the Work), the draft, then the one verified end-use scope (`acquireEndUseScope`:
 * namespaces of every created document's source and the draft's location, re-read, then
 * the documents), then branch rows as the kernel writes them. A scope that moved aborts
 * the transaction and runs again under the callers' bounded attempts.
 *
 * The kernel reports the branches it closed or deleted (`retired`) so the caller retires
 * exactly their rooms and thread state after commit, and reconciles the catalog of every
 * source it touched inside the transaction (F23), as Apply does.
 */

import type { DraftId, ThreadId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branchWriteJournal, documentBranches } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { bumpBranchRevisions } from "../../../shared/branch-revisions.js";
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
import type { WorkDraftDisposal, WorkProjectionMutation } from "../../projects/index.js";
import { NO_ATTEMPT_SCOPE, runBoundedAttempts } from "../domain/branch-attempts.js";
import type { BranchCoordinator } from "../domain/branch-coordinator.js";
import {
  BranchCasConflictError,
  type BranchRead,
  materializeBranchRead,
} from "../domain/branch-store.js";
import { DraftCommandExistsError } from "../domain/draft-commands.js";
import {
  type DiscardItem,
  type DiscardKernelInput,
  type DiscardKernelResult,
  DraftDiscardScopeChangedError,
  type DraftDiscardStore,
} from "../domain/draft-discard.js";
import type { Drafts } from "../domain/drafts.js";
import type { PeerRetirementCause, RetiredBranch } from "../domain/peer-retirement.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";
import { settleDraftGeneration } from "./drizzle-document-edits.js";
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
  cause: PeerRetirementCause,
  documentIds?: readonly DocumentId[],
): Promise<RetiredBranch[]> {
  if (documentIds?.length === 0) return [];
  const tx = currentDrizzleDb(db);
  const open = await tx
    .select({ id: documentBranches.id })
    .from(documentBranches)
    .where(
      and(
        eq(documentBranches.draftId, draftId),
        eq(documentBranches.status, "active"),
        documentIds ? inArray(documentBranches.documentId, [...documentIds]) : undefined,
      ),
    );
  const closed = await bumpBranchRevisions(
    tx,
    open.map((row) => row.id),
    { status: "closed" },
  );
  for (const branch of closed) {
    if (branch.kind === "work_draft") {
      await settleDraftGeneration(tx, branch.branchId, branch.generation, "discarded");
    }
  }
  return closed.map((branch) =>
    retired(
      {
        ...branch,
        documentId: branch.documentId as DocumentId,
        threadId: branch.threadId as ThreadId | null,
      },
      cause,
    ),
  );
}

/**
 * The kernel's whole-draft arm: every document the draft created ends its use (tombstoned
 * and released when no draft uses it), then the draft row closes after every branch (closed above) and its
 * settlements. The caller holds the draft and its verified scope.
 */
async function discardWholeLocked(
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
  /** The locked kernel: the caller holds §14's locks and proved the Work's state. */
  kernel(input: DiscardKernelInput): Promise<DiscardKernelResult>;
};

export function createDrizzleDraftDiscard(
  db: Database,
  deps: KernelDeps & {
    drafts: Pick<Drafts, "lockActive" | "close">;
    branches: Pick<ApplicationBranchStore, "readBranchAt" | "closeThreadPeersOf">;
    coordinator: Pick<BranchCoordinator, "resetFromDoc">;
    workProjection: Pick<WorkProjectionMutation, "mutatePending">;
  },
): DrizzleDraftDiscard {
  /**
   * Reset the draft's branch on an item from live when it holds reviewable rows, folding away
   * every row appended before the reset locks the branch, and close that branch's thread peers
   * (rows or not). The caller's attempt owns the reset until it completes.
   */
  async function resetItemText(
    input: Extract<DiscardKernelInput, { selection: { kind: "items" } }>,
    item: { documentId: DocumentId; draftBranchId: string },
  ): Promise<readonly RetiredBranch[]> {
    const read = await deps.branches.readBranchAt(item.draftBranchId);
    const content = read?.branch;
    // Gone with its tombstone, or no longer the draft's: nothing of the draft left to reset.
    if (
      !read ||
      content?.kind !== "work_draft" ||
      content.status !== "active" ||
      content.draftId !== input.draftId ||
      content.documentId !== item.documentId
    ) {
      return [];
    }
    const hasPending = async () => {
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
      return Boolean(pending);
    };
    // A healthy rowless branch has no text to reset (unless its state cannot be read: Discard
    // is the recovery for a corrupt item, rows or not), but an open reply may still hold staged
    // writes on it, so its peers close either way.
    if (!(await hasPending()) && isReadable(read)) {
      // The decision holds only under the branch row: a frame takes no other lock. One that
      // committed since the read makes this a reset after all, recomputed by the next attempt.
      const [locked] = await currentDrizzleDb(db)
        .select({ revision: documentBranches.revision })
        .from(documentBranches)
        .where(eq(documentBranches.id, content.branchId))
        .for("update");
      if (Number(locked?.revision) !== content.revision || (await hasPending()))
        throw new BranchCasConflictError(content.branchId);
      return deps.branches.closeThreadPeersOf([content.branchId], "edit_discarded");
    }
    const liveDoc = input.liveDocs.get(item.documentId);
    if (!liveDoc) throw new Error(`Discard of ${item.documentId} holds no live document`);
    const reset = await deps.coordinator.resetFromDoc(
      {
        branchId: content.branchId,
        upstream: liveDoc,
        expectedGeneration: content.generation,
        policy: "fold",
        schemaVersion: content.schemaVersion,
      },
      input.attempt,
    );
    if (!reset) throw new BranchCasConflictError(content.branchId);
    return deps.branches.closeThreadPeersOf([content.branchId], "edit_discarded");
  }

  async function kernel(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { draftId } = input;
    // Only the items arm carries live documents.
    if (!("liveDocs" in input)) return discardWholeLocked(db, deps, draftId);
    const { items } = input.selection;
    // Created or edited is the document's visibility now, read under the locks the caller
    // holds: another Work's Apply may have revealed a create since the item was resolved, and
    // a revealed create is an edited item (§2.2), reset from live with its branch kept. The
    // draft's create row goes either way; only a hidden document can be tombstoned by it.
    const withRows = items.filter((item) => item.origin === "created").map((i) => i.documentId);
    const hiddenNow = await hiddenDocumentIds(db, withRows);
    const isCreated = (item: DiscardItem) => hiddenNow.has(item.documentId);
    const created = items.filter(isCreated).map((item) => item.documentId);
    const ended = await endUseReconciled(
      db,
      deps,
      draftId,
      { drafts: [{ draftId, documentIds: withRows }] },
      "document_discarded",
    );
    // A hidden create another draft still uses stays, but this draft's branches on it end.
    const retiredBranches: RetiredBranch[] = [
      ...ended.retired,
      ...(await closeDraftBranches(db, draftId, "document_discarded", created)),
    ];
    for (const item of items) {
      if (item.draftBranchId && !isCreated(item)) {
        retiredBranches.push(
          ...(await resetItemText(input, {
            documentId: item.documentId,
            draftBranchId: item.draftBranchId,
          })),
        );
      }
    }
    return {
      draftClosed: false,
      tombstoned: ended.tombstoned,
      releasedObjects: ended.releasedObjects,
      retired: retiredBranches,
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
          throw new DraftCommandExistsError(command.envelope.commandId);
        }
        // The Work and the draft enter the Work boundary before the draft row and the scope
        // locks (decision D17).
        return deps.workProjection.mutatePending(
          { works: [workId as WorkId], drafts: [input.draftId] },
          async () => {
            if (!(await deps.drafts.lockActive(input.draftId))) return null;
            const items = input.selection.kind === "items" ? input.selection.items : null;
            const itemIds = items?.map((item) => item.documentId);
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
            return kernel(input);
          },
          { seam: true, requireActive: true },
        );
      });
    },
  };
}

/** Purge transactions run again when a draft's end-use scope moved under them. */
const PURGE_ATTEMPTS = 3;

/**
 * Work purge's disposal (§2.6): inside purge's transaction after its deleted/cutoff proof,
 * lock each of the Work's active drafts, acquire the verified end-use scope of every one,
 * and discard each whole through the kernel. A scope that moved rolls the purge transaction
 * back and runs it again, a bounded attempt each. The public command's active-Work fence is
 * never used. No pending projection and no thread retirement: the Work and its threads are
 * being deleted.
 */
export function createDrizzleWorkDraftDisposal(
  db: Database,
  deps: KernelDeps & { drafts: Pick<Drafts, "byOriginWork" | "lockActive" | "close"> },
): WorkDraftDisposal {
  async function dispose(workId: WorkId): Promise<{ releasedObjects: readonly string[] }> {
    const draftIds = (await deps.drafts.byOriginWork(workId)).map((draft) => draft.id).sort();
    const active: DraftId[] = [];
    for (const draftId of draftIds) {
      if (await deps.drafts.lockActive(draftId)) active.push(draftId);
    }
    if (active.length === 0) return { releasedObjects: [] };
    await acquireScope(db, active[0] as DraftId, {
      drafts: active.map((draftId) => ({ draftId })),
    });
    const releasedObjects: string[] = [];
    for (const draftId of active) {
      const ended = await discardWholeLocked(db, deps, draftId);
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
        isMiss: (cause) => cause instanceof DraftDiscardScopeChangedError,
        run: (attempt) => attempt.commit(() => run(() => dispose(workId))),
        exhausted: (cause) => {
          throw cause;
        },
      });
    },
  };
}

function isReadable(read: BranchRead): boolean {
  try {
    materializeBranchRead(read).destroy();
    return true;
  } catch {
    return false;
  }
}
