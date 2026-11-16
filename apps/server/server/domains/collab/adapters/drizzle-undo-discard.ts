/**
 * Restore of a Discard (design section 7), from the notice or from Trash: both halves of what the
 * command ended, in one command. The records it settled come back as pending copies in each list
 * the Work spans (`restoreDiscard`). Each text draft it closed (`closed_by` still names it) is
 * reopened by `reopenDrafts` as the same row in the Work's current branch, so its receipts,
 * authorship and seeds come back with it. A newer draft of the same document closes under this
 * command and becomes a member of its own entry: restoring that entry swaps back.
 *
 * Lock order, after the command's claim: the Work (the Discard's branch names it), the owner's
 * active branch (made when a whole Discard closed the last one), the lists' keys, then the keys of
 * the documents the copies act on, then the draft rows.
 */

import type { BranchId, ProjectId } from "@meridian/contracts";
import type { UndoDiscardResult } from "@meridian/contracts/branches";
import type { Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { commands } from "@meridian/database/schema";
import { discardedBy, restoreDiscard } from "@meridian/project-tree";
import { and, eq, sql } from "drizzle-orm";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import type { UndoDiscardCommand, UndoDiscardStore } from "../domain/undo-discard.js";
import { closedOwnerBounce } from "./closed-owner-bounce.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { ENTRY_KINDS } from "./drizzle-discard-entries.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import type { ReopenDrafts } from "./drizzle-reopen-drafts.js";

const REOPENABLE: ReadonlySet<string> = new Set(ENTRY_KINDS);

/** A restore of this command that brought something back: stored with the Discard it named. */
async function restoredBefore(
  tx: ReturnType<typeof currentDrizzleDb>,
  projectId: ProjectId,
  userId: string,
  request: UndoDiscardCommand["request"],
): Promise<boolean> {
  const [found] = await tx
    .select({ id: commands.id })
    .from(commands)
    .where(
      and(
        eq(commands.projectId, projectId),
        eq(commands.kind, "undo_discard"),
        eq(commands.accountId, userId),
        sql`${commands.outcome} -> 'result' ->> 'status' = 'restored'`,
        sql`(${commands.outcome} -> 'result' ->> 'restored')::int > 0`,
        sql`${commands.outcome} -> 'result' ->> 'discardCommandId' = ${request.discardCommandId}`,
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
    reopen: ReopenDrafts;
  },
): UndoDiscardStore {
  return {
    async run(command: UndoDiscardCommand): Promise<UndoDiscardResult> {
      const { branchId, userId, request, envelope } = command;
      const commandId = envelope.commandId;
      /** Nothing came back, and `settled` says why. */
      const nothing = (settled: Settlement[], leftOut = 0): UndoDiscardResult => ({
        status: "restored",
        commandId,
        discardCommandId: request.discardCommandId,
        branchId,
        restored: 0,
        swapped: 0,
        leftOut,
        brought: { text: [], tree: [] },
        settled,
      });
      const purged = (items: string[] = []) =>
        nothing([{ rule: "left_out", items, why: "purged" }]);
      return runDocumentCommand(
        db,
        envelope,
        async () => {
          return deps.workProjection.mutate(
            { branches: [branchId] },
            async (): Promise<UndoDiscardResult> => {
              const tx = currentDrizzleDb(db);
              // It must be this account's own Discard, Restore or Un-Apply: Trash lists these and
              // nothing else. None found is an entry the purge took, which is no refusal.
              const [discard] = await tx
                .select({ kind: commands.kind })
                .from(commands)
                .where(
                  and(eq(commands.id, request.discardCommandId), eq(commands.accountId, userId)),
                );
              if (!discard || !REOPENABLE.has(discard.kind)) return purged();
              // A purged Work's branches went with it: no row names an owner to lock or write.
              const owner = (await deps.branches.ownerOf(branchId))?.owner;
              if (!owner) return purged();
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
              const drafts = await deps.reopen.closedBy(request.discardCommandId, branchId);
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
                      : ("already" as const);
                  }),
              });
              const restoredTree = result.flatMap((outcome) =>
                outcome === "already" ? [] : [outcome],
              );

              const {
                reopened,
                swapped,
                leftOut: edited,
              } = await deps.reopen.reopen({
                drafts,
                target: target.id,
                commandId,
                owner,
                leaveOutEdited: true,
              });

              const leftOut = restoredTree.flatMap((one) => one.leftOut);
              const editedChanges = edited.reduce((sum, one) => sum + one.changes, 0);
              const treeCopies = restoredTree.reduce((sum, one) => sum + one.copies.length, 0);
              const settled: Settlement[] = [];
              if (leftOut.length > 0)
                settled.push({
                  rule: "left_out",
                  items: [...new Set(leftOut.map(({ record }) => record.node))],
                  why: "purged",
                });
              if (edited.length > 0)
                settled.push({
                  rule: "left_out",
                  items: edited.map(({ documentId }) => documentId),
                  why: "changed_since",
                });
              // An entry with no member left: a restore took the members, or another Work holds
              // the records, or what it held left with its document's purge.
              if (treeCopies + reopened === 0 && leftOut.length === 0 && edited.length === 0)
                settled.push(
                  treeAlreadyRestored ||
                    foreignRecords ||
                    (await restoredBefore(tx, envelope.projectId, userId, request))
                    ? { rule: "already", state: "restored" }
                    : { rule: "left_out", items: [], why: "purged" },
                );
              return {
                status: "restored",
                commandId,
                discardCommandId: request.discardCommandId,
                branchId: target.id as BranchId,
                restored: treeCopies + reopened,
                swapped,
                leftOut: leftOut.length + editedChanges,
                brought: {
                  text: drafts
                    .filter((draft) => !edited.some((one) => one.documentId === draft.documentId))
                    .map((draft) => draft.documentId),
                  tree: [
                    ...new Set(restoredTree.flatMap((one) => one.copies.map((copy) => copy.node))),
                  ],
                },
                ...(settled.length > 0 ? { settled } : {}),
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
