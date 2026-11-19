/** What the classifier says about a draft's pending changes: the Apply record a test needs to simulate an Apply. */
import {
  appliedParts,
  classifyChanges,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readApplyRecord,
  readBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { materializeDraftRead } from "../domain/draft-store.js";
import type { DraftDispositionStore } from "../domain/ports/draft-disposition-store.js";

const schema = buildDocumentSchema();

export async function classifiedDraft(store: DraftDispositionStore, draftId: string) {
  const cut = await store.capture(draftId);
  if (!cut?.draft.checkpoint) return null;
  const doc = materializeDraftRead(cut.draft);
  try {
    const applied = appliedParts(doc, cut.parts, readApplyRecord(doc));
    const provenance = {
      snapshot: Y.snapshot(doc),
      userId: cut.userId,
      parts: cut.parts.map((part, index) => ({
        ...part,
        status: applied[index] ? ("applied" as const) : ("pending" as const),
      })),
    };
    const projection = projectReview(
      diffBlocks(
        readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
        readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
      ),
    );
    return {
      projection,
      provenance,
      classifications: classifyChanges(doc, projection, provenance, { record: true }),
    };
  } finally {
    doc.destroy();
  }
}
