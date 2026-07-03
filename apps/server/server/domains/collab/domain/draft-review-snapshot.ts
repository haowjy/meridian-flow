/** Canonical live/draft review snapshot builder for preview and accept decisions. */
import type { AgentEditCodec, AgentEditModel, UpdateJournal } from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import { buildReviewBasisDocs, serializePreview } from "./draft-projection.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { IndexedDraftUpdate } from "./draft-review-operations.js";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

export type DraftReviewSnapshotStore = {
  getDraft(
    draftId: string,
  ): Promise<{ documentId: DocumentId; status: string; baseLiveUpdateSeq: number } | null>;
  listUpdates(draftId: string): Promise<IndexedDraftUpdate[]>;
};

export type DraftReviewSnapshot = {
  liveRevisionToken: number;
  draftRevisionToken: number;
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  live: string;
  markdown: string;
  inlineModelPresent: boolean;
  operations?: DraftReviewOperationInternal[];
  hunks?: DraftReviewHunkInternal[];
  dispose(): void;
};

export async function buildDraftReviewSnapshot(input: {
  journal: Pick<UpdateJournal, "read">;
  draftStore: DraftReviewSnapshotStore;
  documentId: DocumentId;
  draftId: string;
  liveRevisionToken: number;
  draftUpdates: readonly IndexedDraftUpdate[];
  codec: AgentEditCodec;
  model: AgentEditModel;
}): Promise<DraftReviewSnapshot> {
  const { liveDoc, draftDoc } = await buildReviewBasisDocs(
    input.journal,
    input.draftStore,
    input.documentId,
    input.draftId,
    input.liveRevisionToken,
  );
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    liveDoc.destroy();
    draftDoc.destroy();
  };

  try {
    const review = computeDraftReviewHunks({
      liveDoc,
      draftDoc,
      model: input.model,
      draftUpdates: input.draftUpdates,
    });
    return {
      liveRevisionToken: input.liveRevisionToken,
      draftRevisionToken: latestDraftRevisionToken(input.draftUpdates),
      liveDoc,
      draftDoc,
      live: serializePreview(liveDoc, input.codec, input.model),
      markdown: serializePreview(draftDoc, input.codec, input.model),
      inlineModelPresent: "operations" in review,
      ...("operations" in review ? { operations: review.operations, hunks: review.hunks } : {}),
      dispose,
    };
  } catch (cause) {
    dispose();
    throw cause;
  }
}

function latestDraftRevisionToken(updates: readonly IndexedDraftUpdate[]): number {
  return updates.reduce((max, update) => Math.max(max, update.id), 0);
}
