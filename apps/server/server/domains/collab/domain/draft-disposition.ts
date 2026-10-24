/** One text-derived review and disposition view for every receipt at a captured draft revision. */
import {
  type ApplyEntry,
  appliedParts,
  type ChangeClassification,
  classifyChanges,
  diffBlocks,
  type ItemRange,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  type ReviewProjection,
  readApplyRecord,
  readBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { assertReadableDraft, type DraftSnapshot, materializeDraftRead } from "./draft-store.js";
import type {
  DraftDispositionStore,
  DraftProvenance,
  DraftReceiptPart,
} from "./ports/draft-disposition-store.js";

export type PartDisposition = "applied" | "pending" | "discarded";
export interface DraftDispositionView {
  draft: DraftSnapshot;
  /** Released creation bytes have no snapshot, Apply record or projection. */
  provenance: DraftProvenance | null;
  projection: ReviewProjection | null;
  classifications: ReadonlyMap<string, ChangeClassification>;
  applyRecord: readonly ApplyEntry[];
  parts: readonly (DraftReceiptPart & { disposition: PartDisposition })[];
}

const schema = buildDocumentSchema();

export function createDraftDispositionReader(store: DraftDispositionStore) {
  return async (
    draftId: string,
    options?: { writerRanges?: readonly ItemRange[] },
  ): Promise<DraftDispositionView | null> => {
    const cut = await store.capture(draftId, options);
    if (!cut) return null;
    const draft = cut.draft.documentDraft;
    if (!cut.draft.checkpoint) {
      // Only a terminal released creation may have no bytes; never manufacture an empty draft.
      if (draft.status !== "closed" || !cut.contentReleased || cut.draft.tail.length)
        throw new Error(`Missing draft checkpoint: ${draftId}`);
      return {
        draft,
        provenance: null,
        projection: null,
        classifications: new Map(),
        applyRecord: [],
        parts: cut.parts.map((part) => ({ ...part, disposition: "discarded" })),
      };
    }
    assertReadableDraft(draft);
    const doc = materializeDraftRead(cut.draft);
    try {
      const applyRecord = readApplyRecord(doc);
      const applied = appliedParts(doc, cut.parts, applyRecord);
      const parts = cut.parts.map((part, index) => ({
        ...part,
        status: applied[index] ? ("applied" as const) : ("pending" as const),
      }));
      const provenance: DraftProvenance = {
        snapshot: Y.snapshot(doc),
        userId: cut.userId,
        parts,
        ...(cut.writers ? { writers: cut.writers } : {}),
      };
      const projection = projectReview(
        diffBlocks(
          readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
          readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
        ),
      );
      const classifications = classifyChanges(doc, projection, provenance, { record: true });
      const pending = new Set<number>();
      for (const change of classifications.values())
        for (const member of change.members) pending.add(member);
      return {
        draft,
        provenance,
        projection,
        classifications,
        applyRecord,
        parts: parts.map((part, index) => ({
          ...part,
          disposition:
            part.status === "applied"
              ? "applied"
              : draft.status === "active" && pending.has(index)
                ? "pending"
                : "discarded",
        })),
      };
    } finally {
      doc.destroy();
    }
  };
}
