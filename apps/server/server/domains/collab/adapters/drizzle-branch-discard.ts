/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around
 * it, and Work purge's disposal of a purged Work's branches (§2.6, F10), which runs the
 * same kernel inside purge's transaction after purge's own lifecycle proof.
 *
 * Lock order (§14), after the live scopes an item Discard holds: the Work (purge: threads,
 * then the Work), the branch, then the one verified tree scope (`acquireTreeScope`:
 * namespaces of every created document's source and the branch's location, re-read, then
 * the documents), then draft rows as the kernel writes them. A scope that moved aborts
 * the transaction and runs again under the callers' bounded attempts.
 *
 * Every draft the kernel closes retires after commit through the one close; the kernel
 * reconciles the catalog of every source it touched inside the transaction (F23), as Apply does.
 */

import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentDrafts } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import { discardBranchTreeFacts } from "../../context/tree/branch-tree-changes.js";
import { endUse, hiddenDocumentIds } from "../../context/tree/end-use.js";
import {
  acquireTreeScope,
  readTreeScope,
  TreeScopeChangedError,
  type TreeScopeRequest,
} from "../../context/tree/mutation-scope.js";
import type { WorkBranchDisposal, WorkProjectionMutation } from "../../projects/index.js";
import { BranchCommandExistsError } from "../domain/branch-commands.js";
import {
  BranchDiscardApplicableStateChangedError,
  BranchDiscardDraftChangedError,
  BranchDiscardScopeChangedError,
  type BranchDiscardStore,
  type DiscardKernelInput,
  type DiscardKernelResult,
} from "../domain/branch-discard.js";
import type { Branches } from "../domain/branches.js";
import { NO_ATTEMPT_SCOPE, runBoundedAttempts } from "../domain/draft-attempts.js";
import type { DraftCloseCause } from "../domain/draft-retirement.js";
import { claimCommandWithinTx, settleCommandWithinTx } from "./drizzle-branch-commands.js";
import type { DraftClose } from "./drizzle-draft-close.js";

type KernelDeps = {
  removal: DocumentRemoval;
  close: Pick<DraftClose, "closeDrafts">;
  branches: Pick<Branches, "close">;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
};

/** End the branch's use of `request`'s documents, then reconcile the catalog of every source touched. */
async function endUseReconciled(
  db: Database,
  deps: KernelDeps,
  branchId: BranchId,
  request: TreeScopeRequest,
  userId?: UserId,
) {
  const scope = await readTreeScope(db, request);
  const ended = await endUse(db, {
    branchId,
    documentIds: scope.documentIds,
    removal: deps.removal,
    actor: userId ? { userId } : { cause: "repair" },
  });
  if (ended.tombstoned.length > 0 && scope.sourceIds.length > 0) {
    await deps.catalog.refreshSources(
      scope.sourceIds,
      ended.tombstoned.map((ref) => ref.id),
    );
  }
  return ended;
}

/**
 * Closes the branch's drafts (both kinds) on these documents, or on all of them. Closing
 * keeps each draft's bytes and apply record: the receipt and model `write undo` read them
 * to tell applied parts (`cant_undo_applied`) from discarded ones (`cant_undo_discarded`).
 */
async function closeBranchDrafts(
  db: Database,
  deps: KernelDeps,
  branchId: BranchId,
  cause: Exclude<DraftCloseCause, object>,
  documentIds?: readonly DocumentId[],
): Promise<void> {
  if (documentIds?.length === 0) return;
  await deps.close.closeDrafts(
    currentDrizzleDb(db),
    documentIds ? { documentIds, branchId } : { branchId },
    cause,
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
  await closeBranchDrafts(db, deps, branchId, "branch_closed");
  const ended = await endUseReconciled(db, deps, branchId, { branches: [{ branchId }] }, userId);
  await deps.branches.close(branchId, new Date());
  return { releasedObjects: ended.releasedObjects, closed: [] };
}

/** The branch's active text drafts on these documents, row-locked: each one's `updated_at`. */
async function lockActiveDrafts(
  db: Database,
  branchId: BranchId,
  documentIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, string>> {
  const rows = await currentDrizzleDb(db)
    .select({ documentId: documentDrafts.documentId, updatedAt: documentDrafts.updatedAt })
    .from(documentDrafts)
    .where(
      and(
        eq(documentDrafts.branchId, branchId),
        eq(documentDrafts.kind, "work_draft"),
        eq(documentDrafts.status, "active"),
        inArray(documentDrafts.documentId, [...documentIds]),
      ),
    )
    .for("update");
  return new Map(rows.map((row) => [row.documentId, row.updatedAt.toISOString()]));
}

/** The verified scope, as Discard's callers retry it: a moved scope is a changed branch. */
async function acquireScope(db: Database, branchId: BranchId, request: TreeScopeRequest) {
  try {
    return await acquireTreeScope(db, request);
  } catch (cause) {
    if (cause instanceof TreeScopeChangedError) throw new BranchDiscardScopeChangedError(branchId);
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
    workProjection: Pick<WorkProjectionMutation, "mutate">;
  },
): DrizzleBranchDiscard {
  async function kernel(input: DiscardKernelInput): Promise<DiscardKernelResult> {
    const { branchId } = input;
    if (input.selection.kind === "whole")
      return discardWholeLocked(db, deps, branchId, input.userId);
    const { items } = input.selection;
    const drafts = await lockActiveDrafts(
      db,
      branchId,
      items.map((item) => item.documentId),
    );
    for (const item of items)
      if (
        item.ends === "item" &&
        item.draftSeenAt !== undefined &&
        (drafts.get(item.documentId) ?? null) !== item.draftSeenAt
      )
        throw new BranchDiscardDraftChangedError();
    // Visibility is checked under the end-use locks: another Work may have revealed
    // the creation after resolution. That is a changed action, never permission to reset text.
    const withRows = items.filter((item) => item.origin === "created").map((i) => i.documentId);
    const hiddenNow = await hiddenDocumentIds(db, withRows);
    const created = items
      .filter((item) => item.origin === "created" && hiddenNow.has(item.documentId))
      .map((item) => item.documentId);
    // Any other item is the branch's move or delete of a live document, its text draft, or
    // both: its facts go (the hidden folders they prune were never in the live catalog), and a
    // whole-item Discard closes its text draft too. A tree-only Discard leaves the text to the
    // writer's own Discard in the room.
    const textClosed: DocumentId[] = [];
    const closed: DocumentId[] = [...created];
    for (const item of items) {
      if (created.includes(item.documentId)) continue;
      const ended = await discardBranchTreeFacts(db, {
        branchId,
        documentId: item.documentId,
        userId: input.userId ?? null,
      });
      const hasText = drafts.has(item.documentId);
      if (item.ends === "tree") {
        if (!ended.discarded) throw new BranchDiscardApplicableStateChangedError();
        if (!hasText) closed.push(item.documentId);
        continue;
      }
      if (!ended.discarded && !hasText) throw new BranchDiscardApplicableStateChangedError();
      if (hasText) textClosed.push(item.documentId);
      closed.push(item.documentId);
    }
    // A hidden create another branch still uses stays, but this branch's drafts on it end.
    await closeBranchDrafts(db, deps, branchId, "document_discarded", [...created, ...textClosed]);
    const ended = await endUseReconciled(
      db,
      deps,
      branchId,
      { branches: [{ branchId, documentIds: created }] },
      input.userId,
    );
    return { releasedObjects: ended.releasedObjects, closed };
  }

  return {
    kernel,
    deferUntilCommit: deferUntilDrizzleCommit,
    async discardLocked({ kernel: input, command }) {
      return runInDrizzleTransaction(db, async () => {
        // The branch's owner enters the Work boundary before the branch row and the scope
        // locks.
        return deps.workProjection.mutate(
          { branches: [input.branchId] },
          async () => {
            // Claims follow the Work boundary for every command, including conflicting deliveries.
            // The claim is pending until the kernel says what it ended, in this transaction.
            if (command && !(await claimCommandWithinTx(currentDrizzleDb(db), command.envelope))) {
              throw new BranchCommandExistsError(command.envelope.commandId);
            }
            const settle = async (ended: DiscardKernelResult | null) => {
              if (command)
                await settleCommandWithinTx(
                  currentDrizzleDb(db),
                  command.envelope.commandId,
                  command.result(ended),
                );
              return ended;
            };
            if (!(await deps.branches.lockActive(input.branchId))) return settle(null);
            const items = input.selection.kind === "items" ? input.selection.items : null;
            const itemIds = items?.map((item) => item.documentId);
            await acquireScope(db, input.branchId, {
              branches: [
                {
                  branchId: input.branchId,
                  ...(itemIds ? { documentIds: itemIds } : {}),
                },
              ],
              documentIds: itemIds ?? [],
            });
            return settle(await kernel(input));
          },
          { seam: true, requireActive: true, allowFrozenLineage: true },
        );
      });
    },
  };
}

/** Purge transactions run again when a branch's tree scope moved under them. */
const PURGE_ATTEMPTS = 3;

/**
 * Work purge's disposal (§2.6): inside purge's transaction after its deleted/cutoff proof,
 * lock each of the Work's active branches, acquire the verified tree scope of every one,
 * and discard each whole through the kernel. A scope that moved rolls the purge transaction
 * back and runs it again, a bounded attempt each. The public command's active-Work fence is
 * never used. No pending projection: the Work is being deleted; its closed drafts retire after
 * commit like any others.
 */
export function createDrizzleWorkBranchDisposal(
  db: Database,
  deps: KernelDeps & {
    branches: Pick<Branches, "byOriginWork" | "activeByOriginLineages" | "lockActive" | "close">;
  },
): WorkBranchDisposal {
  async function dispose(
    workId: WorkId,
    lineageRootIds: readonly string[],
  ): Promise<{ releasedObjects: readonly string[] }> {
    const owned = [
      ...(await deps.branches.byOriginWork(workId)),
      ...(await deps.branches.activeByOriginLineages(lineageRootIds as ThreadId[])),
    ];
    const branchIds = owned.map((branch) => branch.id).sort();
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
        run: (attempt) => attempt.commit(() => run((roots) => dispose(workId, roots))),
        exhausted: (cause) => {
          throw cause;
        },
      });
    },
  };
}
