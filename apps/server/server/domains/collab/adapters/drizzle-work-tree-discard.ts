/**
 * The tree half of a Work's Discard: its pending records settled discarded in every list it
 * spans (the press's Discard), and Work purge's disposal of a purged Work's branches (§2.6, F10).
 */
import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { discardDraft, newId, pendingRecords, recordsOfItem } from "@meridian/project-tree";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkBranchDisposal } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";

type KernelDeps = {
  branches: Pick<Branches, "close">;
  treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
};

/**
 * Settles the Work's pending tree records discarded, in every list it spans. With `documents`,
 * the records of those documents' items (and what stands on a node they create); without, all
 * of them. Returns the documents that had records, and the ones whose creation was discarded.
 */
export async function discardTreeRecords(
  db: Database,
  deps: Pick<KernelDeps, "treeLists">,
  input: {
    branchId: BranchId;
    userId?: UserId;
    commandId: string;
    documents?: readonly DocumentId[];
  },
): Promise<{ had: Set<DocumentId>; created: Set<DocumentId> }> {
  const had = new Set<DocumentId>();
  const created = new Set<DocumentId>();
  const by = input.userId ? `user:${input.userId}` : "system";
  const { result } = await deps.treeLists.submit({
    lists: await treeListsOfBranch(db, input.branchId),
    make: (copies) =>
      copies.flatMap(({ writer }) => {
        const pending = pendingRecords(writer.doc, input.branchId);
        const draft = writer.view({ draft: input.branchId });
        const items = input.documents;
        const only = items
          ? [...new Set(items.flatMap((id) => recordsOfItem(draft, pending, id)))]
          : pending;
        const discarded = new Set(
          discardDraft(
            writer,
            input.branchId,
            by,
            input.commandId,
            items ? only.map((r) => r.id) : undefined,
          ),
        );
        // A discarded delete had what it covered in the Work's view, not what its author saw.
        return pending
          .filter((record) => discarded.has(record.id))
          .map((record) => ({
            record,
            covered: draft.trash.find((entry) => entry.id === record.id)?.cascade ?? [],
          }));
      }),
  });
  for (const { record, covered } of result) {
    had.add(record.node as DocumentId);
    if (record.type === "create") created.add(record.node as DocumentId);
    for (const id of covered) had.add(id as DocumentId);
  }
  return { had, created };
}

/**
 * Work purge's disposal of one branch: every pending tree record of the Work is settled discarded
 * in each list, then the branch row closes. The caller holds the branch.
 */
async function disposeBranchLocked(
  db: Database,
  deps: KernelDeps,
  input: { branchId: BranchId },
): Promise<void> {
  await discardTreeRecords(db, deps, { ...input, commandId: newId() });
  await deps.branches.close(input.branchId, new Date());
  // The branch ended and its drafts closed: the rows of its view go.
  await deps.treeLists.resync(await treeListsOfBranch(db, input.branchId));
}

/**
 * Work purge's disposal (§2.6): inside purge's transaction after its deleted/cutoff proof, lock
 * each of the Work's active branches and discard its tree records. The public command's
 * active-Work fence is never used. No pending projection: the Work is being deleted. Its drafted
 * creates are in no view afterwards and retention purges them.
 */
export function createDrizzleWorkBranchDisposal(
  db: Database,
  deps: KernelDeps & {
    branches: Pick<Branches, "byOriginWork" | "activeByOriginLineages" | "lockActive" | "close">;
  },
): WorkBranchDisposal {
  async function dispose(
    workId: WorkId,
    lineageRootIds: readonly string[],
  ): Promise<{ releasedObjects: readonly string[] }> {
    const owned = [
      ...(await deps.branches.byOriginWork(workId)),
      ...(await deps.branches.activeByOriginLineages(lineageRootIds as ThreadId[])),
    ];
    const branchIds = owned.map((branch) => branch.id).sort();
    for (const branchId of branchIds) {
      if (await deps.branches.lockActive(branchId))
        await disposeBranchLocked(db, deps, { branchId });
    }
    return { releasedObjects: [] };
  }

  return {
    withDisposal(workId, run) {
      return run((roots) => dispose(workId, roots));
    },
  };
}
