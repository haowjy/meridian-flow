/** Query assembly for draft review previews and immutable draft journals. */
import type { AgentEditCodec, AgentEditModel, UpdateJournal } from "@meridian/agent-edit";
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import type { DocumentId } from "@meridian/contracts/runtime";
import {
  buildDraftJournalSnapshot,
  buildReviewBasisDocs,
  serializePreview,
} from "./draft-projection.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type {
  DraftReviewOperationInternal,
  IndexedDraftUpdate,
} from "./draft-review-operations.js";

type DraftReviewStore = {
  listUpdates(draftId: string): Promise<IndexedDraftUpdate[]>;
  getDraft(
    draftId: string,
  ): Promise<{ documentId: DocumentId; status: string; baseLiveUpdateSeq: number } | null>;
};

type LatestLiveUpdateSeqStore = {
  latestUpdateSeq(documentId: DocumentId): Promise<number>;
};

export type DraftReviewQueries = {
  getDraftJournal(input: { documentId: DocumentId; draftId: string }): Promise<
    | {
        status: "active";
        draftRevisionToken: number;
        checkpoint: Uint8Array | null;
        updates: { seq: number; update: Uint8Array }[];
      }
    | { status: "not_found" }
  >;
  previewDraft(input: { documentId: DocumentId; draftId: string }): Promise<{
    live: string;
    markdown: string;
    liveRevisionToken: number;
    draftRevisionToken: number;
    inlineModelPresent: boolean;
    operations?: ReviewOperation[];
    hunks?: ReviewHunk[];
  }>;
};

export function createDraftReviewQueries(input: {
  journal: Pick<UpdateJournal, "read">;
  draftStore: DraftReviewStore;
  liveSeqStore: LatestLiveUpdateSeqStore;
  codec: AgentEditCodec;
  model: AgentEditModel;
}): DraftReviewQueries {
  return {
    async getDraftJournal(query) {
      const result = await buildDraftJournalSnapshot(
        input.journal,
        input.draftStore,
        query.documentId,
        query.draftId,
      );
      if (result.status === "not_found") return result;
      return {
        status: "active",
        draftRevisionToken: result.revisionToken,
        checkpoint: result.snapshot.checkpoint,
        updates: result.snapshot.updates.map((update) => ({
          seq: update.seq,
          update: update.update,
        })),
      };
    },

    async previewDraft(query) {
      const liveRevisionToken = await input.liveSeqStore.latestUpdateSeq(query.documentId);
      const draftUpdates = await input.draftStore.listUpdates(query.draftId);
      const { liveDoc, draftDoc } = await buildReviewBasisDocs(
        input.journal,
        input.draftStore,
        query.documentId,
        query.draftId,
        liveRevisionToken,
      );
      try {
        const review = computeDraftReviewHunks({
          liveDoc,
          draftDoc,
          model: input.model,
          draftUpdates,
        });
        return {
          live: serializePreview(liveDoc, input.codec, input.model),
          markdown: serializePreview(draftDoc, input.codec, input.model),
          liveRevisionToken,
          draftRevisionToken: Math.max(0, ...draftUpdates.map((update) => update.id ?? 0)),
          inlineModelPresent: "operations" in review,
          ...("operations" in review
            ? {
                operations: review.operations.map(toWireReviewOperation),
                hunks: review.hunks,
              }
            : {}),
        };
      } finally {
        liveDoc.destroy();
        draftDoc.destroy();
      }
    },
  };
}

function toWireReviewOperation(operation: DraftReviewOperationInternal): ReviewOperation {
  const {
    sourceUpdateIds: _sourceUpdateIds,
    acceptSourceUpdateIds: _acceptSourceUpdateIds,
    actorUserId: _actorUserId,
    ...wire
  } = operation;
  return wire;
}
