/** Test writes that reach a branch through the coordinator operations a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchCoordinator, SegmentRowsInput } from "../domain/branch-coordinator.js";
import type { AppendBranchJournalInput, BranchStore } from "../domain/branch-store.js";

type SaveDoors = Pick<BranchCoordinator, "readBranch" | "commitSegmentRows" | "resetFromDoc">;

/** Commits segment rows to one branch the way a save does. */
export function commitSegmentRows(
  coordinator: SaveDoors,
  input: SegmentRowsInput,
): Promise<boolean> {
  return coordinator.commitSegmentRows(input);
}

/** Journals `updateData` as one row on the branch's current generation. */
export async function commitJournaledUpdate(
  coordinator: SaveDoors,
  input: Omit<AppendBranchJournalInput, "generation">,
): Promise<boolean> {
  const staged = await coordinator.readBranch(input.branchId, async (doc, snapshot) => {
    const sourceDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(sourceDoc, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(sourceDoc, input.updateData);
    return { sourceDoc, generation: snapshot.generation };
  });
  try {
    return await coordinator.commitSegmentRows({
      branchId: input.branchId,
      expectedGeneration: staged.generation,
      sourceDoc: staged.sourceDoc,
      rows: [input],
    });
  } finally {
    staged.sourceDoc.destroy();
  }
}

/** Resets an active Work draft to `upstream`, reading its expected state straight from the store. */
export async function resetBranchFromDoc(
  coordinator: SaveDoors,
  store: Pick<BranchStore, "getBranch">,
  branchId: string,
  upstream: Y.Doc,
): Promise<boolean> {
  const expected = await store.getBranch(branchId);
  if (!expected) throw new Error(`Branch ${branchId} does not exist`);
  return coordinator.resetFromDoc({
    branchId,
    upstream,
    policy: "exact",
    expectedGeneration: expected.generation,
    expectedRevision: expected.revision,
  });
}
