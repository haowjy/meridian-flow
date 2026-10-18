/** Test writes that reach a branch through the coordinator operations a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { AppendDraftJournalInput, DraftStore } from "../domain/draft-store.js";

type SaveDoors = Pick<DraftCoordinator, "readDraft" | "commitSegmentRows" | "resetFromDoc">;

/** Journals `updateData` as one row on the branch's current generation. */
export async function commitJournaledUpdate(
  coordinator: SaveDoors,
  input: Omit<AppendDraftJournalInput, "generation">,
): Promise<boolean> {
  const staged = await coordinator.readDraft(input.draftId, async (doc, snapshot) => {
    const sourceDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(sourceDoc, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(sourceDoc, input.updateData);
    return { sourceDoc, generation: snapshot.generation };
  });
  try {
    return await coordinator.commitSegmentRows({
      draftId: input.draftId,
      expectedGeneration: staged.generation,
      sourceDoc: staged.sourceDoc,
      rows: [input],
    });
  } finally {
    staged.sourceDoc.destroy();
  }
}

/** Resets an active Work draft to `upstream`, reading its expected state straight from the store. */
export async function resetDraftFromDoc(
  coordinator: SaveDoors,
  store: Pick<DraftStore, "getDraft">,
  draftId: string,
  upstream: Y.Doc,
): Promise<boolean> {
  const expected = await store.getDraft(draftId);
  if (!expected) throw new Error(`Draft ${draftId} does not exist`);
  return coordinator.resetFromDoc({
    draftId,
    upstream,
    policy: "exact",
    expectedGeneration: expected.generation,
    expectedRevision: expected.revision,
  });
}
