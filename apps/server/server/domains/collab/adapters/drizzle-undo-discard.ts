/**
 * Undo of a Discard (design section 5): both halves of what the command ended, as fresh copies
 * on the Work's current branch, in one command. The records the Discard settled come back as
 * pending copies in each list the Work spans; the text drafts it closed (`discard_command_drafts`)
 * come back as new active drafts holding the closed ones' bytes, which a closed draft keeps until
 * its document's content is purged. Each half is copied once. A document the Work has drafted
 * again since keeps its newer draft: the Discard's text is left out and counted.
 *
 * Lock order, after the command's claim: the Work (the Discard's branch names it), the owner's
 * active branch (made when a whole Discard closed the last one), the lists' keys, then the keys of
 * the documents the copies act on, then the writes.
 */

import { randomUUID } from "node:crypto";
import type { BranchId } from "@meridian/contracts";
import type { UndoDiscardResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { discardCommandDrafts, documentDrafts } from "@meridian/database/schema";
import { discardedBy, restoreDiscard } from "@meridian/project-tree";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { ApplyClickRefused } from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { UndoDiscardCommand, UndoDiscardStore } from "../domain/undo-discard.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { lookupCommand, runCommand } from "./drizzle-document-commands.js";
import { asLifecycleRefusal } from "./lifecycle-refusal.js";

type Refusal = Extract<UndoDiscardResult, { status: "refused" }>["reason"];

class UndoDiscardRefused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

export function createDrizzleUndoDiscard(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    branches: Pick<Branches, "ownerOf" | "ensureActiveForWrite">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    coordinator: Pick<DraftCoordinator, "loadBase">;
  },
): UndoDiscardStore {
  return {
    async run(command: UndoDiscardCommand): Promise<UndoDiscardResult> {
      const { branchId, userId, request, envelope } = command;
      const commandId = envelope.commandId;
      const refused = (reason: Refusal) => ({ status: "refused", commandId, reason }) as const;
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
                // The drafts the Discard closed on the Discard's own branch.
                const closedDrafts = (
                  await tx
                    .select({
                      draftId: documentDrafts.id,
                      documentId: documentDrafts.documentId,
                      branchId: documentDrafts.branchId,
                      restoredBy: discardCommandDrafts.restoredBy,
                    })
                    .from(discardCommandDrafts)
                    .innerJoin(documentDrafts, eq(documentDrafts.id, discardCommandDrafts.draftId))
                    .where(eq(discardCommandDrafts.commandId, request.discardCommandId))
                ).filter((draft) => draft.branchId === branchId);
                const drafts = closedDrafts.filter((draft) => draft.restoredBy === null);
                const documentIds = new Set<string>([
                  ...nodes,
                  ...drafts.map((draft) => draft.documentId),
                ]);
                for (const node of [...documentIds].sort())
                  await lockDocumentMutation(tx, node as never);

                let treeAlreadyRestored = false;
                const { result } = await deps.treeLists.submit({
                  lists,
                  make: (ends) =>
                    ends.map(({ writer }) => {
                      const found = discardedBy(writer.doc, request.discardCommandId);
                      if (found.restored) treeAlreadyRestored = true;
                      // Another Work's records, or none, are not this Discard's to restore.
                      return found.records.every((record) => record.draft === branchId)
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

                let copied = 0;
                let leftOut = restoredTree.reduce((sum, one) => sum + one.leftOut.length, 0);
                for (const draft of drafts) {
                  const taken = await copyDraft(draft.draftId, target.id);
                  if (taken) copied += 1;
                  else leftOut += 1;
                  await tx
                    .update(discardCommandDrafts)
                    .set({ restoredBy: commandId })
                    .where(
                      and(
                        eq(discardCommandDrafts.commandId, request.discardCommandId),
                        eq(discardCommandDrafts.draftId, draft.draftId),
                      ),
                    );
                }
                if (copied > 0) await deps.treeLists.resync(lists);

                const treeCopies = restoredTree.reduce((sum, one) => sum + one.copies.length, 0);
                if (treeCopies + copied + leftOut === 0)
                  throw new UndoDiscardRefused(
                    treeAlreadyRestored || (closedDrafts.length > 0 && drafts.length === 0)
                      ? "already_restored"
                      : "nothing_to_restore",
                  );
                return {
                  status: "restored",
                  commandId,
                  branchId: target.id as BranchId,
                  restored: treeCopies + copied,
                  leftOut,
                };
              },
              { requireActive: true, seam: true },
            ),
          (cause) =>
            cause instanceof UndoDiscardRefused
              ? refused(cause.reason)
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

  /**
   * A new active draft on `branchId` holding what the closed one held: its seed, its base and its
   * text. Live that moved since is merged in by the next pull, as for any draft that fell behind.
   * False when the branch already has an active draft of the document.
   */
  async function copyDraft(draftId: string, branchId: BranchId): Promise<boolean> {
    const tx = currentDrizzleDb(db);
    const [row] = await tx.select().from(documentDrafts).where(eq(documentDrafts.id, draftId));
    if (!row) return false;
    const [active] = await tx
      .select({ id: documentDrafts.id })
      .from(documentDrafts)
      .where(
        and(
          eq(documentDrafts.documentId, row.documentId),
          eq(documentDrafts.branchId, branchId),
          eq(documentDrafts.kind, "work_draft"),
          eq(documentDrafts.status, "active"),
        ),
      );
    if (active) return false;
    const { replica } = await deps.coordinator.loadBase(draftId);
    await tx.insert(documentDrafts).values({
      ...row,
      id: `draft_${randomUUID()}`,
      branchId,
      status: "active",
      closedCause: null,
      state: Buffer.from(Y.encodeStateAsUpdate(replica.doc)),
      stateVector: Buffer.from(Y.encodeStateVector(replica.doc)),
      hasEffect: true,
      hasEffectRevision: -1,
      revision: 0,
      checkpointRevision: 0,
      checkpointSeq: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return true;
  }
}
