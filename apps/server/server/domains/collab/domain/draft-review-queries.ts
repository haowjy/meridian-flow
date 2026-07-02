/** Query assembly for draft review previews and immutable draft journals. */
import type { AgentEditCodec, AgentEditModel, UpdateJournal } from "@meridian/agent-edit";
import type {
  DraftReviewFallbackReason,
  ReviewHunk,
  ReviewOperation,
} from "@meridian/contracts/drafts";
import type { DocumentId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import {
  buildDraftDoc,
  buildDraftJournalSnapshot,
  buildLiveDocAtSeq,
  serializePreview,
} from "./draft-projection.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { IndexedDraftUpdate } from "./draft-review-operations.js";

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
  previewDraft(input: { documentId: DocumentId; draftId: string; surface?: "inline" }): Promise<{
    live: string;
    markdown: string;
    liveRevisionToken: number;
    draftRevisionToken: number;
    recommendedSurface: "inline" | "panel";
    fallbackReason?: DraftReviewFallbackReason;
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
      const liveDoc = await buildLiveDocAtSeq(input.journal, query.documentId, liveRevisionToken);
      const draftUpdates = await input.draftStore.listUpdates(query.draftId);
      const draftDoc = buildDraftDoc(
        { checkpoint: Y.encodeStateAsUpdate(liveDoc), updates: [] },
        draftUpdates,
      );
      try {
        const review = computeDraftReviewHunks({
          liveDoc,
          draftDoc,
          model: input.model,
          draftUpdates,
          requestedSurface: query.surface,
        });
        return {
          live: serializePreview(liveDoc, input.codec, input.model),
          markdown: serializePreview(draftDoc, input.codec, input.model),
          liveRevisionToken,
          draftRevisionToken: Math.max(0, ...draftUpdates.map((update) => update.id ?? 0)),
          inlineModelPresent: "operations" in review && "hunks" in review,
          ...review,
        };
      } finally {
        liveDoc.destroy();
        draftDoc.destroy();
      }
    },
  };
}
