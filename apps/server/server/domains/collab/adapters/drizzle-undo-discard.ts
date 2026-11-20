/**
 * Restore of a Discard (design section 5), from the notice, the editor's Ctrl+Z or Trash: both
 * halves of what the command took, in one command. The records it settled come back as pending
 * copies in each list the Work spans (`restoreDiscard`). The text half is the one Undo of a
 * writer's command (`undoCommandText`): each change the Discard took out that still stands comes
 * back into the draft; one the writer or the model has written over since stays out.
 *
 * Lock order, after the command's claim: the Work (the Discard's branch names it), the owner's
 * active branch, the lists' keys, then the keys of the documents the copies and edits act on,
 * then the draft rows.
 */

import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { BranchId, DocumentId, UserId } from "@meridian/contracts";
import type { UndoDiscardResult } from "@meridian/contracts/branches";
import type { Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { commands } from "@meridian/database/schema";
import { discardedBy, restoreDiscard } from "@meridian/project-tree";
import { and, eq } from "drizzle-orm";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import type { UndoDiscardCommand, UndoDiscardStore } from "../domain/undo-discard.js";
import { closedOwnerBounce } from "./closed-owner-bounce.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { documentsOfCommand, undoCommandText } from "./drizzle-command-edits.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";

export function createDrizzleUndoDiscard(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate" | "draftMembershipChanged">;
    branches: Pick<Branches, "ownerOf" | "ensureActiveForWrite">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    onCommitted(documentId: DocumentId): Promise<void>;
  },
): UndoDiscardStore {
  return {
    async run(command: UndoDiscardCommand): Promise<UndoDiscardResult> {
      const { branchId, userId, request, envelope } = command;
      const commandId = envelope.commandId;
      /** Nothing came back: the entry is gone, or its owner is closed (`settled` says that). */
      const nothing = (settled?: Settlement[]): UndoDiscardResult => ({
        status: "restored",
        commandId,
        discardCommandId: request.discardCommandId,
        branchId,
        restored: 0,
        brought: { text: [], tree: [] },
        ...(settled ? { settled } : {}),
      });
      return runDocumentCommand(
        db,
        envelope,
        async () => {
          return deps.workProjection.mutate(
            { branches: [branchId] },
            async (): Promise<UndoDiscardResult> => {
              const tx = currentDrizzleDb(db);
              // It must be this account's own Discard: Trash lists these and nothing else. None
              // found is an entry the purge took, which is no refusal.
              const [discard] = await tx
                .select({ kind: commands.kind })
                .from(commands)
                .where(
                  and(eq(commands.id, request.discardCommandId), eq(commands.accountId, userId)),
                );
              if (discard?.kind !== "discard") return nothing();
              // A purged Work's branches went with it: no row names an owner to lock or write.
              const owner = (await deps.branches.ownerOf(branchId))?.owner;
              if (!owner) return nothing();
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
              const texts = await documentsOfCommand(tx, request.discardCommandId, userId);
              const documentIds = new Set<string>([
                ...nodes,
                ...texts.map((text) => text.documentId),
              ]);
              for (const node of [...documentIds].sort())
                await lockDocumentMutation(tx, node as never);

              const { result } = await deps.treeLists.submit({
                lists,
                make: (ends) =>
                  ends.map(({ writer }) => {
                    const found = discardedBy(writer.doc, request.discardCommandId);
                    // Another Work's records, or none, are not this Discard's to restore.
                    const own = found.records.every((record) => record.draft === branchId);
                    return own
                      ? restoreDiscard(
                          writer,
                          request.discardCommandId,
                          `user:${userId}`,
                          target.id,
                          commandId,
                        )
                      : ("already" as const);
                  }),
              });
              const restoredTree = result.flatMap((outcome) =>
                outcome === "already" ? [] : [outcome],
              );

              const brought = (
                await undoCommandText(db, deps, {
                  commandId,
                  undoes: request.discardCommandId,
                  accountId: userId as UserId,
                })
              ).map((one) => one.documentId);

              const treeCopies = restoredTree.reduce((sum, one) => sum + one.copies.length, 0);
              return {
                status: "restored",
                commandId,
                discardCommandId: request.discardCommandId,
                branchId: target.id as BranchId,
                restored: treeCopies + brought.length,
                brought: {
                  text: brought,
                  tree: [
                    ...new Set(restoredTree.flatMap((one) => one.copies.map((copy) => copy.node))),
                  ],
                },
              };
            },
            { requireActive: true, seam: true },
          );
        },
        (cause) => {
          const settled = closedOwnerBounce(cause);
          return settled ? nothing(settled) : undefined;
        },
      );
    },
  };
}
