/**
 * Postgres Discard (contract §12): the locked kernel, `discardItems`' transaction around
 * it, and Work purge's disposal of a purged Work's branches (§2.6, F10), which runs the
 * same kernel inside purge's transaction after purge's own lifecycle proof.
 *
 * The tree half is the package's `discardDraft`, run through `treeListStore.submit` in each
 * list the Work spans: the Work's pending records are settled discarded with the command's id.
 * A drafted create then is in no view, and its document and text stay until retention purges
 * them; nothing here releases a document.
 *
 * Lock order (`collab/.context/CONTEXT.md`), after the command's claim: the Work (purge: threads,
 * then the Work), the branch, the list's lock (inside `submit`), the item documents' mutexes
 * in ID order, then draft rows as the kernel writes them.
 *
 * Every draft the kernel closes retires after commit through the one close.
 */

import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentDrafts } from "@meridian/database/schema";
import { discardDraft, newId, pendingRecords } from "@meridian/project-tree";
import { and, eq, inArray } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkBranchDisposal, WorkProjectionMutation } from "../../projects/index.js";
import {
  BranchDiscardApplicableStateChangedError,
  BranchDiscardDraftChangedError,
  type BranchDiscardStore,
  type DiscardKernelInput,
  type DiscardKernelResult,
  type DiscardRefusal,
} from "../domain/branch-discard.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCloseCause } from "../domain/draft-retirement.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { runCommand } from "./drizzle-document-commands.js";
import type { DraftClose } from "./drizzle-draft-close.js";

type KernelDeps = {
  close: Pick<DraftClose, "closeDrafts">;
  branches: Pick<Branches, "close">;
  treeLists: Pick<TreeListStore, "lock" | "submit" | "resync">;
};

/**
 * Settles the Work's pending tree records discarded, in every list it spans. With `documents`,
 * the records of those documents' items (and what stands on a node they create); without, all
 * of them. Returns the documents that had records, and the ones whose creation was discarded.
 */
async function discardTreeRecords(
  db: Database,
  deps: KernelDeps,
  input: {
    branchId: BranchId;
    userId?: UserId;
    commandId: string;
    documents?: readonly DocumentId[];
  },
): Promise<{ had: Set<DocumentId>; created: Set<DocumentId> }> {
  const had = new Set<DocumentId>();
  const created = new Set<DocumentId>();
  const by = input.userId ? `user:${input.userId}` : "system";
  const { result } = await deps.treeLists.submit({
    lists: await treeListsOfBranch(db, input.branchId),
    make: (copies) =>
      copies.flatMap(({ writer }) => {
        const pending = pendingRecords(writer.doc, input.branchId);
        const items = input.documents;
        const only = items
          ? pending.filter(
              (record) =>
                items.includes(record.node as DocumentId) ||
                (record.type === "delete" &&
                  record.cascade.some((id) => items.includes(id as DocumentId))),
            )
          : pending;
        const discarded = new Set(
          discardDraft(
            writer,
            input.branchId,
            by,
            input.commandId,
            items ? only.map((r) => r.id) : undefined,
          ),
        );
        return pending.filter((record) => discarded.has(record.id));
      }),
  });
  for (const record of result) {
    had.add(record.node as DocumentId);
    if (record.type === "create") created.add(record.node as DocumentId);
    if (record.type === "delete") for (const id of record.cascade) had.add(id as DocumentId);
  }
  return { had, created };
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
 * The kernel's whole-branch arm: every pending tree record of the Work is settled discarded in
 * each list, its drafts close, then the branch row closes. The caller holds the branch.
 */
async function discardWholeLocked(
  db: Database,
  deps: KernelDeps,
  input: { branchId: BranchId; userId?: UserId; commandId?: string },
): Promise<DiscardKernelResult> {
  await discardTreeRecords(db, deps, { ...input, commandId: input.commandId ?? newId() });
  await closeBranchDrafts(db, deps, input.branchId, "branch_closed");
  await deps.branches.close(input.branchId, new Date());
  // The branch ended and its drafts closed: the rows of its view go.
  await deps.treeLists.resync(await treeListsOfBranch(db, input.branchId));
  return { closed: [] };
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
    const commandId = input.commandId ?? newId();
    if (input.selection.kind === "whole")
      return discardWholeLocked(db, deps, { branchId, userId: input.userId, commandId });
    const { items } = input.selection;
    const documents = items.map((item) => item.documentId);
    // The Work's lists' keys, then the documents', before the records are written: the rows
    // they write are the ones derivation locks under a document's key.
    await deps.treeLists.lock(await treeListsOfBranch(db, branchId));
    for (const id of [...documents].sort()) await lockDocumentMutation(currentDrizzleDb(db), id);
    // The Work's records on these documents settle discarded, in the list that holds them. A
    // created document is then in no view; it and its text stay until retention purges them.
    const { had, created } = await discardTreeRecords(db, deps, {
      branchId,
      userId: input.userId,
      commandId,
      documents,
    });
    const drafts = await lockActiveDrafts(db, branchId, documents);
    for (const item of items)
      if (
        item.ends === "item" &&
        item.draftSeenAt !== undefined &&
        (drafts.get(item.documentId) ?? null) !== item.draftSeenAt
      )
        throw new BranchDiscardDraftChangedError();
    // A tree-only Discard leaves the text to the writer's own Discard in the room; a whole-item
    // Discard closes the document's text draft too. Whatever the Work holds on the document
    // after this is the item's text alone, so an item with neither a record nor a draft was
    // already gone.
    const textClosed: DocumentId[] = [];
    const closed: DocumentId[] = [];
    for (const item of items) {
      if (created.has(item.documentId)) {
        closed.push(item.documentId);
        continue;
      }
      const hasText = drafts.has(item.documentId);
      const hasTree = had.has(item.documentId);
      if (item.ends === "tree") {
        if (!hasTree) throw new BranchDiscardApplicableStateChangedError();
        if (!hasText) closed.push(item.documentId);
        continue;
      }
      if (!hasTree && !hasText) throw new BranchDiscardApplicableStateChangedError();
      if (hasText) textClosed.push(item.documentId);
      closed.push(item.documentId);
    }
    await closeBranchDrafts(db, deps, branchId, "document_discarded", [
      ...new Set([...created, ...textClosed]),
    ]);
    return { closed };
  }

  return {
    kernel,
    async discardLocked({ kernel: input, command }) {
      const settled: { ended: DiscardKernelResult | DiscardRefusal | null } = { ended: null };
      await runCommand(
        db,
        command.envelope,
        // The branch's owner enters the Work boundary after the claim, before the branch row
        // and the list's lock.
        () =>
          deps.workProjection.mutate(
            { branches: [input.branchId] },
            async () => {
              settled.ended = null;
              if (await deps.branches.lockActive(input.branchId))
                settled.ended = await kernel(input);
              return command.result(settled.ended);
            },
            { seam: true, requireActive: true, allowFrozenLineage: true },
          ),
        (cause) => {
          const refused = discardRefusal(cause);
          if (!refused) return undefined;
          settled.ended = refused;
          return command.result(refused);
        },
      );
      return settled.ended;
    },
  };
}

/** The kernel's final refusals: the branch's state no longer allows this item's Discard. */
function discardRefusal(cause: unknown): DiscardRefusal | undefined {
  if (cause instanceof BranchDiscardApplicableStateChangedError) return { refused: "stale" };
  if (cause instanceof BranchDiscardDraftChangedError) return { refused: "draft_changed" };
  return undefined;
}

/**
 * Work purge's disposal (§2.6): inside purge's transaction after its deleted/cutoff proof,
 * lock each of the Work's active branches and discard each whole through the kernel. The
 * public command's active-Work fence is never used. No pending projection: the Work is being
 * deleted; its closed drafts retire after commit like any others. Its drafted creates are in
 * no view afterwards and retention purges them.
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
    for (const branchId of branchIds) {
      if (await deps.branches.lockActive(branchId))
        await discardWholeLocked(db, deps, { branchId });
    }
    return { releasedObjects: [] };
  }

  return {
    withDisposal(workId, run) {
      return run((roots) => dispose(workId, roots));
    },
  };
}
