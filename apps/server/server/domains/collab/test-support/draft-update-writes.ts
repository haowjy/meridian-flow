/** Test writes that reach a draft through the coordinator operations a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { assertSegmentRowsComplete } from "../domain/document-mutation-policy.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { AppendDraftJournalInput } from "../domain/draft-store.js";

type SaveDoors = Pick<DraftCoordinator, "readDraft" | "prepareStagedRows">;

/**
 * Appends `rows` to the draft at `expectedGeneration` through the save's door
 * (`prepareStagedRows`), refusing a batch that doesn't add up to `sourceDoc`. True once
 * appended; false when there were no rows.
 */
export async function commitDraftRows(
  coordinator: Pick<DraftCoordinator, "prepareStagedRows">,
  batch: {
    draftId: string;
    sourceDoc: Y.Doc;
    rows: readonly AppendDraftJournalInput[];
  },
): Promise<boolean> {
  const { write } = await coordinator.prepareStagedRows(
    batch.draftId,
    async (doc) => {
      for (const row of batch.rows) Y.applyUpdate(doc, row.updateData);
      assertSegmentRowsComplete(batch.sourceDoc, doc);
      return { result: null, rows: batch.rows };
    },
    true,
  );
  if (!write) return false;
  try {
    await write.persist();
  } catch (cause) {
    write.dispose();
    throw cause;
  }
  write.transfer();
  return true;
}

/** Journals `updateData` as one row on the draft's current generation. */
export async function commitJournaledUpdate(
  coordinator: SaveDoors,
  input: AppendDraftJournalInput,
): Promise<boolean> {
  const staged = await coordinator.readDraft(input.draftId, async (doc) => {
    const sourceDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(sourceDoc, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(sourceDoc, input.updateData);
    return { sourceDoc };
  });
  try {
    return await commitDraftRows(coordinator, {
      draftId: input.draftId,
      sourceDoc: staged.sourceDoc,
      rows: [input],
    });
  } finally {
    staged.sourceDoc.destroy();
  }
}
