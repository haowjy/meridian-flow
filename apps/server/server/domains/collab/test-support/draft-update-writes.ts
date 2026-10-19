/** Test writes that reach a draft through the coordinator operations a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { AppendDraftJournalInput } from "../domain/draft-store.js";

type SaveDoors = Pick<DraftCoordinator, "readDraft" | "commitSegmentRows">;

/** Journals `updateData` as one row on the draft's current generation. */
export async function commitJournaledUpdate(
  coordinator: SaveDoors,
  input: AppendDraftJournalInput,
): Promise<boolean> {
  const staged = await coordinator.readDraft(input.draftId, async (doc, _snapshot) => {
    const sourceDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(sourceDoc, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(sourceDoc, input.updateData);
    return { sourceDoc };
  });
  try {
    return await coordinator.commitSegmentRows({
      draftId: input.draftId,
      sourceDoc: staged.sourceDoc,
      rows: [input],
    });
  } finally {
    staged.sourceDoc.destroy();
  }
}
