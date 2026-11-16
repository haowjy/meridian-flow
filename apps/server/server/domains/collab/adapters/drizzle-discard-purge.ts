/**
 * Day-30 purge of Trash's command entries (a Discard, a Restore or an Un-Apply that swapped a
 * draft out): the command row and the closed drafts that name it, in one transaction. This is the
 * only reader of the clock for them: Trash lists and Restore reopens whatever still exists, so
 * what is listed is exactly what restores, and a Restore after the purge finds no command and
 * answers `left_out purged`. A draft's bytes are the only record of which of its parts were
 * applied, so each part's answer is written to its edit part before the draft goes.
 *
 * A drafted create's draft is not ours: the tree purges the create on its own clock
 * (`purgeUnviewed`), settling and releasing its drafts and content, and browsers delete their
 * local copy only on that record. The tree's `discarded` settlements stay.
 *
 * Lock order, a prefix of Restore's (the Work, the branch, the lists, the documents): the Work
 * (no `requireActive`: an archived or deleted Work's entries expire too), then the documents'
 * keys in id order. The lists are read without a key, before any document key. A Restore and the
 * purge take the same Work lock, so a Restore sees all of an entry or none of it. A row whose
 * branch is gone (its Work was purged, which cascades the branch and its drafts but not
 * `commands`) has nothing to lock.
 */
import type { CommandId } from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import {
  commands,
  documentDrafts,
  documentEditParts,
  observationFrontiers,
} from "@meridian/database/schema";
import { discardedBy } from "@meridian/project-tree";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { DraftDispositionView } from "../domain/draft-disposition.js";
import { draftRoom, supersededRoom } from "../domain/observation-rooms.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { ENTRY_KINDS } from "./drizzle-discard-entries.js";

const DISCARD_PURGE_BATCH_LIMIT = 100;

export function createDrizzleDiscardPurge(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    treeLists: Pick<TreeListStore, "read">;
    eventSink?: EventSink;
    /** What became of each of a draft's parts, read from its bytes. */
    readDisposition(draftId: string): Promise<Pick<DraftDispositionView, "parts"> | null>;
  },
) {
  /**
   * Each closed draft's parts as their bytes answer them, read before the locks: a closed draft
   * changes only when a Restore reopens it, and the purge then leaves it alone.
   */
  async function dispositionsOf(ids: readonly string[]) {
    const out = new Map<string, Pick<DraftDispositionView, "parts">["parts"]>();
    for (const draft of await closedDrafts(ids))
      out.set(draft.id, (await deps.readDisposition(draft.id))?.parts ?? []);
    return out;
  }

  /** The drafts still closed by these commands. */
  async function closedDrafts(ids: readonly string[]) {
    return currentDrizzleDb(db)
      .select({ id: documentDrafts.id, documentId: documentDrafts.documentId })
      .from(documentDrafts)
      .where(and(inArray(documentDrafts.closedBy, [...ids]), eq(documentDrafts.status, "closed")));
  }

  /** The documents these commands' own drafts created: the tree purges them, not this sweep. */
  async function draftedCreates(branchId: string, ids: readonly string[]): Promise<Set<string>> {
    const lists = await treeListsOfBranch(db, branchId as never);
    if (lists.length === 0) return new Set();
    return new Set(
      (
        await deps.treeLists.read({
          lists,
          view: (ends) =>
            ends.flatMap(({ writer }) => ids.flatMap((id) => discardedBy(writer.doc, id).created)),
        })
      ).flat(),
    );
  }

  async function purgeBranch(branchId: string | null, ids: readonly string[]): Promise<void> {
    const dispositions = await dispositionsOf(ids);
    await deps.workProjection.mutate(
      branchId ? { branches: [branchId as never] } : {},
      async () => {
        const tx = currentDrizzleDb(db);
        const created = branchId ? await draftedCreates(branchId, ids) : new Set<string>();
        const documents = [...new Set((await closedDrafts(ids)).map((draft) => draft.documentId))];
        for (const id of documents.sort()) await lockDocumentMutation(tx, id);
        // Re-read under the keys: a Restore may have taken some of them.
        const doomed = (await closedDrafts(ids)).filter((draft) => !created.has(draft.documentId));
        if (doomed.length > 0) {
          // The turn's card reads what became of each part from here once the bytes are gone.
          for (const { id } of doomed)
            for (const part of dispositions.get(id) ?? [])
              if (part.disposition !== "pending")
                await tx
                  .update(documentEditParts)
                  .set({ purgedDisposition: part.disposition })
                  .where(
                    and(
                      eq(documentEditParts.editId, part.editId),
                      eq(documentEditParts.ordinal, part.ordinal),
                    ),
                  );
          await tx.delete(documentDrafts).where(
            inArray(
              documentDrafts.id,
              doomed.map((draft) => draft.id),
            ),
          );
          // A frontier has no draft foreign key; its room key is the only ownership. The row
          // stays as the record that the model's view was of a closed draft, without the cut.
          for (const draft of doomed) {
            const room = draftRoom(draft.id);
            // A block's rows are one per room, so a second draft of the document in the same
            // block would collide on the rewrite: the first one's record already says it.
            await tx.delete(observationFrontiers).where(
              and(
                eq(observationFrontiers.roomKey, room),
                inArray(
                  observationFrontiers.sourceBlockId,
                  tx
                    .select({ id: observationFrontiers.sourceBlockId })
                    .from(observationFrontiers)
                    .where(eq(observationFrontiers.roomKey, supersededRoom(draft.documentId))),
                ),
              ),
            );
            await tx
              .update(observationFrontiers)
              .set({
                roomKey: supersededRoom(draft.documentId),
                snapshot: Buffer.alloc(0),
                journalPosition: null,
              })
              .where(eq(observationFrontiers.roomKey, room));
          }
        }
        await tx.delete(commands).where(inArray(commands.id, [...ids] as CommandId[]));
      },
    );
  }

  /**
   * One batch of the oldest due entries, each its own transaction: a failure is logged with its id
   * and stays for the next pass, and does not stop the entries after it. Returns how many it took.
   */
  async function purgeBatch(now: Date): Promise<number> {
    const due = await currentDrizzleDb(db)
      .select({
        id: commands.id,
        branchId: sql<string | null>`${commands.outcome} #>> '{result,branchId}'`,
      })
      .from(commands)
      .where(
        and(
          inArray(commands.kind, [...ENTRY_KINDS]),
          lte(commands.createdAt, deletionPurgeCutoff(now)),
        ),
      )
      .orderBy(commands.createdAt)
      .limit(DISCARD_PURGE_BATCH_LIMIT);
    let taken = 0;
    for (const { id, branchId } of due) {
      try {
        await purgeBranch(branchId, [id]);
        taken += 1;
      } catch (error) {
        if (!deps.eventSink) throw error;
        emitEvent(deps.eventSink, {
          level: "error",
          source: "collab.discard-purge",
          name: "purge.failed",
          payload: { id, error },
        });
      }
    }
    return taken;
  }

  return {
    /** Purges every entry older than the retention, batch by batch; the command rows it removed. */
    async purge(now: Date = new Date()): Promise<number> {
      let purged = 0;
      for (;;) {
        const taken = await purgeBatch(now);
        purged += taken;
        if (taken < DISCARD_PURGE_BATCH_LIMIT) return purged;
      }
    },
  };
}
