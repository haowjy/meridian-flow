/** Test writes that reach a branch through its owned session, the one door a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchCoordinator, SegmentRowsInput } from "../domain/branch-coordinator.js";
import type { AppendBranchJournalInput, BranchStore } from "../domain/branch-store.js";

type SessionDoors = Pick<
  BranchCoordinator,
  "withLeases" | "ownedSession" | "resetFromDocIfUnchangedWithLease"
>;

/** Commits segment rows to one branch through its owned session, taking the lease the way a save does. */
export function commitSegmentRows(
  coordinator: SessionDoors,
  input: SegmentRowsInput,
): Promise<boolean> {
  return coordinator.withLeases([input.branchId], (lease) =>
    coordinator.ownedSession(lease).commitSegmentRows(input),
  );
}

/** Journals `updateData` as one row on the branch's current generation. */
export function commitJournaledUpdate(
  coordinator: SessionDoors,
  input: Omit<AppendBranchJournalInput, "generation">,
): Promise<boolean> {
  return coordinator.withLeases([input.branchId], async (lease) => {
    const owned = coordinator.ownedSession(lease);
    const staged = await owned.read(input.branchId, async (doc, snapshot) => {
      const sourceDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(sourceDoc, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(sourceDoc, input.updateData);
      return { sourceDoc, generation: snapshot.generation };
    });
    try {
      return await owned.commitSegmentRows({
        branchId: input.branchId,
        expectedGeneration: staged.generation,
        sourceDoc: staged.sourceDoc,
        rows: [input],
      });
    } finally {
      staged.sourceDoc.destroy();
    }
  });
}

/** Resets an active Work draft to `upstream`, reading its expected state straight from the store. */
export function resetBranchFromDoc(
  coordinator: SessionDoors,
  store: Pick<BranchStore, "getBranch">,
  branchId: string,
  upstream: Y.Doc,
): Promise<boolean> {
  return coordinator.withLeases([branchId], async (lease) => {
    const expected = await store.getBranch(branchId);
    if (!expected) throw new Error(`Branch ${branchId} does not exist`);
    return coordinator.resetFromDocIfUnchangedWithLease(lease, {
      branchId,
      upstream,
      expectedGeneration: expected.generation,
      expectedRevision: expected.revision,
    });
  });
}
