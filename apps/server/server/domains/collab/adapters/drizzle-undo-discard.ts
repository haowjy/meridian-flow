/**
 * Restore of a Discard (design section 5), from the notice, the editor's Ctrl+Z or Trash: both
 * halves of what the command took, in one command. The records it settled come back as pending
 * copies in each list the Work spans (`restoreDiscard`). Each change of a draft's recorded delta
 * that still stands (read backwards) is merged back into the draft as an append; one the writer or
 * the model has written over since stays out, and the draft's current words stand. An entry ends
 * when a Restore brought all of it or none of it back.
 *
 * Lock order, after the command's claim: the Work (the Discard's branch names it), the owner's
 * active branch, the lists' keys, then the keys of the documents the copies and effects act on,
 * then the draft rows.
 */

import { readDelta, restoreChanges } from "@meridian/agent-edit/content-merge";
import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId, DocumentId, ProjectId } from "@meridian/contracts";
import type { UndoDiscardResult } from "@meridian/contracts/branches";
import type { Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { commands, discardCommandEffects, documentDrafts } from "@meridian/database/schema";
import { discardedBy, restoreDiscard } from "@meridian/project-tree";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import { draftSchema } from "../domain/draft-changes.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { UndoDiscardCommand, UndoDiscardStore } from "../domain/undo-discard.js";
import { closedOwnerBounce } from "./closed-owner-bounce.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { writeTextAnswer } from "./drizzle-text-answer.js";

export function createDrizzleUndoDiscard(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate" | "draftMembershipChanged">;
    branches: Pick<Branches, "ownerOf" | "ensureActiveForWrite">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
  },
): UndoDiscardStore {
  /**
   * Merges each effect's changes that still stand back into its draft. The documents brought back,
   * and the entries it ended: those with none of their changes left to bring, or all of them.
   */
  async function restoreText(
    tx: ReturnType<typeof currentDrizzleDb>,
    effects: readonly (typeof discardCommandEffects.$inferSelect)[],
  ): Promise<{ brought: DocumentId[]; ended: DocumentId[] }> {
    const brought: DocumentId[] = [];
    const ended: DocumentId[] = [];
    for (const effect of effects) {
      const [draft] = await tx
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(eq(documentDrafts.id, effect.draftId));
      // A draft the Work's purge deleted has nothing to merge into.
      if (!draft) {
        ended.push(effect.documentId);
        continue;
      }
      let result: ReturnType<typeof restoreChanges> | null = null;
      const write = deps.coordinator.prepareAppend(
        await deps.coordinator.loadBase(effect.draftId),
        [],
        {
          work: "active",
          authorServerRows(prefix) {
            const fragment = prefix.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
            result = restoreChanges(
              draftSchema,
              readDelta(draftSchema, effect.delta),
              readBlocks(fragment, draftSchema),
            );
            if (!result.brought) return [];
            const text = result.text;
            return captureMutationUpdates(prefix, () =>
              prefix.transact(() => writeBlocks(fragment, draftSchema, text)),
            );
          },
        },
      );
      try {
        await write.persist();
        write.transfer();
      } finally {
        write.dispose();
      }
      const done = result as ReturnType<typeof restoreChanges> | null;
      if (done?.brought) {
        brought.push(effect.documentId);
        // The draft holds changes again; its watermark stays stale and the projection judges it.
        await writeTextAnswer(db, deps.treeLists, {
          draftId: effect.draftId,
          hasEffect: true,
          hasEffectRevision: -1,
          listsHeld: true,
        });
      }
      if (!done?.brought || done.brought === done.total) ended.push(effect.documentId);
    }
    return { brought, ended };
  }

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
              const recorded = await tx
                .select()
                .from(discardCommandEffects)
                .where(eq(discardCommandEffects.commandId, request.discardCommandId));
              const effects = recorded.filter((effect) => effect.endedBy === null);
              const documentIds = new Set<string>([
                ...nodes,
                ...effects.map((effect) => effect.documentId),
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

              const text = await restoreText(tx, effects);
              if (text.ended.length > 0)
                await tx
                  .update(discardCommandEffects)
                  .set({ endedBy: commandId })
                  .where(
                    and(
                      eq(discardCommandEffects.commandId, request.discardCommandId),
                      inArray(discardCommandEffects.documentId, text.ended),
                    ),
                  );

              const treeCopies = restoredTree.reduce((sum, one) => sum + one.copies.length, 0);
              return {
                status: "restored",
                commandId,
                discardCommandId: request.discardCommandId,
                branchId: target.id as BranchId,
                restored: treeCopies + text.brought.length,
                brought: {
                  text: text.brought,
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
