/**
 * Day-30 purge of Trash's command entries (a Discard, a Restore or an Un-Apply that swapped a
 * draft out): the command row and the closed drafts that name it, in one transaction. This is the
 * only reader of the clock for them: Trash lists and Restore reopens whatever still exists, so
 * what is listed is exactly what restores, and a Restore after the purge finds no command and
 * answers `left_out purged`.
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
import { commands, documentDrafts } from "@meridian/database/schema";
import { discardedBy } from "@meridian/project-tree";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { ENTRY_KINDS } from "./drizzle-discard-entries.js";

const DISCARD_PURGE_BATCH_LIMIT = 100;

export function createDrizzleDiscardPurge(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    treeLists: Pick<TreeListStore, "read">;
  },
) {
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
    await deps.workProjection.mutate(
      branchId ? { branches: [branchId as never] } : {},
      async () => {
        const tx = currentDrizzleDb(db);
        const created = branchId ? await draftedCreates(branchId, ids) : new Set<string>();
        const documents = [...new Set((await closedDrafts(ids)).map((draft) => draft.documentId))];
        for (const id of documents.sort()) await lockDocumentMutation(tx, id);
        // Re-read under the keys: a Restore may have taken some of them.
        const doomed = (await closedDrafts(ids))
          .filter((draft) => !created.has(draft.documentId))
          .map((draft) => draft.id);
        if (doomed.length > 0)
          await tx.delete(documentDrafts).where(inArray(documentDrafts.id, doomed));
        await tx.delete(commands).where(inArray(commands.id, [...ids] as CommandId[]));
      },
    );
  }

  return {
    /** Purges the entries older than the retention; the number of command rows it removed. */
    async purge(now: Date = new Date()): Promise<number> {
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
      const byBranch = new Map<string | null, string[]>();
      for (const { id, branchId } of due)
        byBranch.set(branchId, [...(byBranch.get(branchId) ?? []), id]);
      for (const [branchId, ids] of byBranch) await purgeBranch(branchId, ids);
      return due.length;
    },
  };
}
