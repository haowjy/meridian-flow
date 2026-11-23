/**
 * Work purge's disposal of a purged Work (§2.6, F10), inside purge's transaction after its
 * deleted/cutoff proof: the Work's drafts and those its purged lineages' roots name each have their
 * tree records discarded; the purge then deletes their rows, and their forks go with them. The Work and the
 * lineages it purges are gone for good, so nothing is recorded to take back. The public command's
 * active-Work fence is never used, and no pending projection runs: the Work is being deleted.
 * Its drafted creates are in no view afterwards and retention purges them.
 */
import type { DraftId, WorkId } from "@meridian/contracts";
import type { ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { newId } from "@meridian/project-tree";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkDraftDisposal } from "../../projects/index.js";
import type { Drafts } from "../domain/drafts.js";
import { treeListsOfDraft } from "./drizzle-draft-tree-lists.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";

export function createDrizzleWorkDraftDisposal(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "namedBy" | "lock">;
    treeLists: Pick<TreeListStore, "lock" | "submit" | "resync">;
  },
): WorkDraftDisposal {
  async function dispose(
    workId: WorkId,
    lineageRootIds: readonly string[],
  ): Promise<{ releasedObjects: readonly string[]; draftIds: readonly DraftId[] }> {
    const named = (await deps.drafts.namedBy({ workId, lineageRootIds })).sort();
    const draftIds: DraftId[] = [];
    for (const draftId of named) if (await deps.drafts.lock(draftId)) draftIds.push(draftId);
    // Every list in one call, after the drafts (the press's lock order): the drafts' lists, and
    // the Work's project's list, which the purge writes next.
    const [work] = await currentDrizzleDb(db)
      .select({ projectId: works.projectId })
      .from(works)
      .where(eq(works.id, workId));
    const lists = new Map<string, TreeList>();
    for (const draftId of draftIds)
      for (const list of await treeListsOfDraft(db, draftId)) lists.set(listKey(list), list);
    if (work?.projectId) {
      const list: TreeList = { kind: "project", projectId: work.projectId as ProjectId };
      lists.set(listKey(list), list);
    }
    if (lists.size > 0) await deps.treeLists.lock([...lists.values()]);
    // One pass per draft: its tree records settled discarded in each list, then its view's rows
    // go. The purge deletes the rows after the Work and chats naming them.
    for (const draftId of draftIds) {
      await discardTreeRecords(db, deps, { draftId, commandId: newId() });
      await deps.treeLists.resync(await treeListsOfDraft(db, draftId));
    }
    return { releasedObjects: [], draftIds };
  }

  return {
    withDisposal(workId, run) {
      return run((roots) => dispose(workId, roots));
    },
  };
}

function listKey(list: TreeList): string {
  return list.kind === "project" ? `project:${list.projectId}` : `account:${list.userId}`;
}
