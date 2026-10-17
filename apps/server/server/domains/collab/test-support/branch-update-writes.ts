/** Test writes that reach a branch through its owned session, the one door a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchCoordinator, SegmentRowsInput } from "../domain/branch-coordinator.js";
import { createBranchCriticalSections } from "../domain/branch-critical-sections.js";
import type { AppendBranchJournalInput, BranchStore } from "../domain/branch-store.js";

type SessionDoors = Pick<BranchCoordinator, "ownedSession" | "resetFromDocIfUnchangedWithLease">;

/** Commits segment rows to one branch through its owned session, the way a save does. */
export function commitSegmentRows(
  coordinator: SessionDoors,
  input: SegmentRowsInput,
): Promise<boolean> {
  return coordinator.ownedSession().commitSegmentRows(input);
}

/** Journals `updateData` as one row on the branch's current generation. */
export async function commitJournaledUpdate(
  coordinator: SessionDoors,
  input: Omit<AppendBranchJournalInput, "generation">,
): Promise<boolean> {
  const owned = coordinator.ownedSession();
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
}

/**
 * Resets an active Work draft to `upstream`, reading its expected state straight from the store.
 * The reset still names a lease; a private one covers it, excluding nothing.
 */
export function resetBranchFromDoc(
  coordinator: SessionDoors,
  store: Pick<BranchStore, "getBranch">,
  branchId: string,
  upstream: Y.Doc,
): Promise<boolean> {
  return createBranchCriticalSections().withBranches([branchId], async (lease) => {
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
