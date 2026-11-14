/**
 * Undo of a Discard: the tree half of the Discard's Trash entry (design section 5). The records
 * the Discard settled come back as fresh pending copies on the Work's current branch, in each list
 * the Work spans, in one command. The server keeps no closed text drafts to restore, so the
 * text of a discarded document stays as the Discard left it.
 *
 * Lock order, after the command's claim: the Work (the Discard's branch names it), the owner's
 * active branch (made when a whole Discard closed the last one), the lists' keys, then the keys of
 * the documents the copies act on, then the writes.
 */

import type { BranchId } from "@meridian/contracts";
import type { UndoDiscardResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { discardedBy, restoreDiscard } from "@meridian/project-tree";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { type TreeListStore, TreeRefusal } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { ApplyClickRefused } from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { UndoDiscardCommand, UndoDiscardStore } from "../domain/undo-discard.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { lookupCommand, runCommand } from "./drizzle-document-commands.js";
import { asLifecycleRefusal } from "./lifecycle-refusal.js";

export function createDrizzleUndoDiscard(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    branches: Pick<Branches, "ownerOf" | "ensureActiveForWrite">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit">;
  },
): UndoDiscardStore {
  return {
    async run(command: UndoDiscardCommand): Promise<UndoDiscardResult> {
      const { branchId, userId, request, envelope } = command;
      const commandId = envelope.commandId;
      const refused = (reason: Extract<UndoDiscardResult, { status: "refused" }>["reason"]) =>
        ({ status: "refused", commandId, reason }) as const;
      try {
        return await runCommand(
          db,
          envelope,
          () =>
            deps.workProjection.mutate(
              { branches: [branchId] },
              async (): Promise<UndoDiscardResult> => {
                const tx = currentDrizzleDb(db);
                // It must be this account's own Discard that took effect.
                const discard = await lookupCommand(tx, {
                  commandId: request.discardCommandId,
                  accountId: userId,
                });
                if (
                  discard.kind !== "stored" ||
                  discard.commandKind !== "discard" ||
                  discard.outcome.status !== "done"
                )
                  throw new ApplyClickRefused("not_found");
                const owner = (await deps.branches.ownerOf(branchId))?.owner;
                if (!owner) throw new ApplyClickRefused("not_found");
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
                for (const node of [...new Set(nodes)].sort())
                  await lockDocumentMutation(tx, node as never);
                const { result } = await deps.treeLists.submit({
                  lists,
                  make: (ends) => {
                    const outcomes = ends.map(({ writer }) =>
                      // Another Work's records, or none, are not this Discard's to restore.
                      discardedBy(writer.doc, request.discardCommandId).records.every(
                        (record) => record.draft === branchId,
                      )
                        ? restoreDiscard(
                            writer,
                            request.discardCommandId,
                            `user:${userId}`,
                            target.id,
                            commandId,
                          )
                        : ("superseded" as const),
                    );
                    if (outcomes.every((outcome) => outcome === "superseded"))
                      throw new TreeRefusal("superseded" as const);
                    return outcomes;
                  },
                });
                const restored = result.flatMap((outcome) =>
                  outcome === "superseded" ? [] : [outcome],
                );
                return {
                  status: "restored",
                  commandId,
                  branchId: target.id as BranchId,
                  restored: restored.reduce((sum, one) => sum + one.copies.length, 0),
                  leftOut: restored.reduce((sum, one) => sum + one.leftOut.length, 0),
                };
              },
              { requireActive: true, seam: true },
            ),
          (cause) =>
            cause instanceof TreeRefusal
              ? refused(cause.reason as "superseded")
              : cause instanceof ApplyClickRefused
                ? refused(cause.reason as "not_found")
                : undefined,
        );
      } catch (cause) {
        const mapped = asLifecycleRefusal(cause);
        if (mapped instanceof ApplyClickRefused) return refused(mapped.reason as "not_found");
        throw mapped;
      }
    },
  };
}
