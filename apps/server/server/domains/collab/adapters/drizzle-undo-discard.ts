/**
 * Restore of a Discard (design section 7), from the notice or from Trash: both halves of what the
 * command ended, in one command. The records it settled come back as pending copies in each list
 * the Work spans (`restoreDiscard`). Each text draft it closed (`closed_by` still names it) is
 * reopened as the same row in the Work's current branch, so its receipts, authorship and seeds
 * come back with it. A newer draft of the same document closes under this command and becomes a
 * member of its own entry: restoring that entry swaps back.
 *
 * Lock order, after the command's claim: the Work (the Discard's branch names it), the owner's
 * active branch (made when a whole Discard closed the last one), the lists' keys, then the keys of
 * the documents the copies act on, then the draft rows.
 */

import type { BranchId } from "@meridian/contracts";
import type { UndoDiscardResult } from "@meridian/contracts/branches";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { documentCommands, documentDrafts } from "@meridian/database/schema";
import { discardedBy, restoreDiscard } from "@meridian/project-tree";
import { and, eq, sql } from "drizzle-orm";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { ApplyClickRefused } from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { UndoDiscardCommand, UndoDiscardStore } from "../domain/undo-discard.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { runCommand } from "./drizzle-document-commands.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { asLifecycleRefusal } from "./lifecycle-refusal.js";

type Refusal = Extract<UndoDiscardResult, { status: "refused" }>["reason"];

class UndoDiscardRefused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

/** A restore of this command that took effect: stored with the Discard it named. */
async function restoredBefore(
  tx: ReturnType<typeof currentDrizzleDb>,
  userId: string,
  request: UndoDiscardCommand["request"],
): Promise<boolean> {
  const [found] = await tx
    .select({ id: documentCommands.id })
    .from(documentCommands)
    .where(
      and(
        eq(documentCommands.kind, "undo_discard"),
        eq(documentCommands.accountId, userId),
        sql`${documentCommands.outcome} -> 'result' ->> 'status' = 'restored'`,
        sql`${documentCommands.outcome} -> 'result' ->> 'discardCommandId' = ${request.discardCommandId}`,
      ),
    )
    .limit(1);
  return found !== undefined;
}

export function createDrizzleUndoDiscard(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate" | "draftMembershipChanged">;
    branches: Pick<Branches, "ownerOf" | "ensureActiveForWrite">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    close: Pick<DraftClose, "closeDrafts">;
  },
): UndoDiscardStore {
  return {
    async run(command: UndoDiscardCommand): Promise<UndoDiscardResult> {
      const { branchId, userId, request, envelope } = command;
      const commandId = envelope.commandId;
      const refused = (reason: Refusal) => ({ status: "refused", commandId, reason }) as const;
      return runCommand(
        db,
        envelope,
        async () => {
          // A purged Work's branches went with it, before the Work's boundary can be entered.
          const found = await deps.branches.ownerOf(branchId);
          if (!found) throw new UndoDiscardRefused("work_purged");
          if (found.branch.projectId !== envelope.projectId)
            throw new ApplyClickRefused("not_found");
          return deps.workProjection.mutate(
            { branches: [branchId] },
            async (): Promise<UndoDiscardResult> => {
              const tx = currentDrizzleDb(db);
              // It must be this account's own command that took effect, inside the retention.
              const [discard] = await tx
                .select({
                  kind: documentCommands.kind,
                  outcome: documentCommands.outcome,
                  at: documentCommands.createdAt,
                })
                .from(documentCommands)
                .where(
                  and(
                    eq(documentCommands.id, request.discardCommandId),
                    eq(documentCommands.accountId, userId),
                  ),
                );
              if (
                !discard ||
                (discard.kind !== "discard" && discard.kind !== "undo_discard") ||
                discard.outcome.status !== "done"
              )
                throw new ApplyClickRefused("not_found");
              if (discard.at <= deletionPurgeCutoff(new Date()))
                throw new UndoDiscardRefused("expired");
              const owner = (await deps.branches.ownerOf(branchId))?.owner;
              if (!owner) throw new UndoDiscardRefused("work_purged");
              approveBranchWriteJoin();
              const target = await deps.branches.ensureActiveForWrite({
                owner,
                projectId: envelope.projectId,
                threadId: null,
                userId,
              });
              const lists = await treeListsOfBranch(db, target.id);
              await deps.treeLists.lock(lists);
              const nodes = await deps.treeLists.read({
                lists,
                view: (ends) =>
                  ends.flatMap(({ writer }) =>
                    discardedBy(writer.doc, request.discardCommandId).records.map(
                      (record) => record.node,
                    ),
                  ),
              });
              // The drafts the command closed on its own branch, still closed under it.
              const drafts = await tx
                .select({ draftId: documentDrafts.id, documentId: documentDrafts.documentId })
                .from(documentDrafts)
                .where(
                  and(
                    eq(documentDrafts.closedBy, request.discardCommandId),
                    eq(documentDrafts.branchId, branchId),
                  ),
                );
              const documentIds = new Set<string>([
                ...nodes,
                ...drafts.map((draft) => draft.documentId),
              ]);
              for (const node of [...documentIds].sort())
                await lockDocumentMutation(tx, node as never);

              let treeAlreadyRestored = false;
              let foreignRecords = false;
              const { result } = await deps.treeLists.submit({
                lists,
                make: (ends) =>
                  ends.map(({ writer }) => {
                    const found = discardedBy(writer.doc, request.discardCommandId);
                    if (found.restored) treeAlreadyRestored = true;
                    // Another Work's records, or none, are not this Discard's to restore.
                    const own = found.records.every((record) => record.draft === branchId);
                    if (!own) foreignRecords = true;
                    return own
                      ? restoreDiscard(
                          writer,
                          request.discardCommandId,
                          `user:${userId}`,
                          target.id,
                          commandId,
                        )
                      : ("superseded" as const);
                  }),
              });
              const restoredTree = result.flatMap((outcome) =>
                outcome === "superseded" ? [] : [outcome],
              );

              let reopened = 0;
              let swapped = 0;
              for (const draft of drafts) {
                const [newer] = await tx
                  .select({ id: documentDrafts.id })
                  .from(documentDrafts)
                  .where(
                    and(
                      eq(documentDrafts.documentId, draft.documentId),
                      eq(documentDrafts.branchId, target.id),
                      eq(documentDrafts.kind, "work_draft"),
                      eq(documentDrafts.status, "active"),
                    ),
                  );
                if (newer) {
                  await deps.close.closeDrafts(
                    tx,
                    { draftIds: [newer.id] },
                    "edit_discarded",
                    commandId,
                  );
                  swapped += 1;
                }
                // Stale `has_effect` is re-judged by the projection sweep.
                await tx
                  .update(documentDrafts)
                  .set({
                    status: "active",
                    closedCause: null,
                    closedBy: null,
                    branchId: target.id,
                    hasEffect: true,
                    hasEffectRevision: -1,
                    updatedAt: new Date(),
                    revision: sql`${documentDrafts.revision} + 1`,
                  })
                  .where(eq(documentDrafts.id, draft.draftId));
                reopened += 1;
              }
              if (reopened > 0) {
                deps.workProjection.draftMembershipChanged(owner);
                await deps.treeLists.resync(lists);
              }

              const leftOut = restoredTree.reduce((sum, one) => sum + one.leftOut.length, 0);
              const treeCopies = restoredTree.reduce((sum, one) => sum + one.copies.length, 0);
              if (treeCopies + reopened === 0) {
                // The entry has no member left. A node left out was purged; a restore that
                // took the members says so; a Discard's text drafts leave only by their
                // document's purge, which deletes them.
                if (leftOut > 0) throw new UndoDiscardRefused("document_purged");
                if (treeAlreadyRestored || (await restoredBefore(tx, userId, request)))
                  throw new UndoDiscardRefused("already_restored");
                throw new UndoDiscardRefused(
                  foreignRecords ? "nothing_to_restore" : "document_purged",
                );
              }
              return {
                status: "restored",
                commandId,
                discardCommandId: request.discardCommandId,
                branchId: target.id as BranchId,
                restored: treeCopies + reopened,
                swapped,
                leftOut,
              };
            },
            { requireActive: true, seam: true },
          );
        },
        (raised) => {
          const cause = asLifecycleRefusal(raised);
          return cause instanceof UndoDiscardRefused
            ? refused(cause.reason)
            : cause instanceof ApplyClickRefused
              ? refused(cause.reason as "not_found")
              : undefined;
        },
      );
    },
  };
}
