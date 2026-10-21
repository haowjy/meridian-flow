/** Test writes that reach a draft through the coordinator operations a reply's save uses. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { assertSegmentRowsComplete } from "../domain/document-mutation-policy.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import {
  type AppendDraftJournalInput,
  DraftStaleUpdateError,
  type DraftStore,
} from "../domain/draft-store.js";

type SaveDoors = Pick<DraftCoordinator, "readDraft" | "prepareStagedRows" | "resetFromDoc">;

/**
 * Appends `rows` to the draft at `expectedGeneration` through the save's door
 * (`prepareStagedRows`), refusing a batch that doesn't add up to `sourceDoc`. True once
 * appended; false when there were no rows.
 */
export async function commitDraftRows(
  coordinator: Pick<DraftCoordinator, "prepareStagedRows">,
  batch: {
    draftId: string;
    expectedGeneration: number;
    sourceDoc: Y.Doc;
    rows: readonly Omit<AppendDraftJournalInput, "generation">[];
  },
): Promise<boolean> {
  const { write } = await coordinator.prepareStagedRows(
    batch.draftId,
    async (doc, snapshot) => {
      if (snapshot.generation !== batch.expectedGeneration)
        throw new DraftStaleUpdateError(`Draft ${batch.draftId}`);
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
  input: Omit<AppendDraftJournalInput, "generation">,
): Promise<boolean> {
  const staged = await coordinator.readDraft(input.draftId, async (doc, snapshot) => {
    const sourceDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(sourceDoc, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(sourceDoc, input.updateData);
    return { sourceDoc, generation: snapshot.generation };
  });
  try {
    return await commitDraftRows(coordinator, {
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
