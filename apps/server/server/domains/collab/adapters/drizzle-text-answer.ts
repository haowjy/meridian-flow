import type { Database } from "@meridian/database";
import { documentDrafts, treeNodes } from "@meridian/database/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListOfNode } from "./drizzle-branch-tree-lists.js";

/**
 * Writes whether a work draft holds text (`has_effect` and its watermark) and brings the list's
 * rows to it when they could change. Rows read that answer (a draft holding text, or not judged
 * since its last write, counts as holding it) only for a document live does not show (rule 7),
 * so only then, and only when the answer differs from what the rows may hold, is it a resync.
 * `revision` pins the write to the revision that was judged; false when the draft moved past it.
 * The caller holds the draft's Work. It holds no document key unless it passes `listsHeld`: it
 * then holds the list's key already (a key taken after a document key can deadlock) and a
 * document trashed since it read the lists throws from `resync`.
 */
export async function writeTextAnswer(
  db: Database,
  treeLists: Pick<TreeListStore, "lock" | "resync">,
  input: {
    draftId: string;
    revision?: number;
    hasEffect: boolean;
    hasEffectRevision: number;
    listsHeld?: boolean;
  },
): Promise<boolean> {
  const tx = currentDrizzleDb(db);
  const draft = and(
    eq(documentDrafts.id, input.draftId),
    input.revision === undefined ? undefined : eq(documentDrafts.revision, input.revision),
  );
  const [before] = await tx
    .select({
      documentId: documentDrafts.documentId,
      hasEffect: documentDrafts.hasEffect,
      stale: documentDrafts.hasEffectRevision,
      revision: documentDrafts.revision,
      trashed: isNotNull(treeNodes.trashRecord),
    })
    .from(documentDrafts)
    .leftJoin(treeNodes, eq(treeNodes.id, documentDrafts.documentId))
    .where(draft);
  if (!before) return false;
  const rowsMayChange =
    before.trashed &&
    (before.hasEffect !== input.hasEffect || (before.stale < before.revision && !input.hasEffect));
  // The list's key comes before the draft row's.
  const list = rowsMayChange ? await treeListOfNode(db, before.documentId) : null;
  if (list && !input.listsHeld) await treeLists.lock([list]);
  const written = await tx
    .update(documentDrafts)
    .set({ hasEffect: input.hasEffect, hasEffectRevision: input.hasEffectRevision })
    .where(draft)
    .returning({ id: documentDrafts.id });
  if (written.length === 0) return false;
  if (list) await treeLists.resync([list]);
  return true;
}
