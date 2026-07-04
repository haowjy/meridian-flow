/**
 * Single owner of draft Yjs projections. All consumers reconstruct draft state
 * through these named projections only — never assemble base + rows by hand.
 */
import {
  type AgentEditCodec,
  type AgentEditModel,
  type JournalSnapshot,
  toDocHandle,
  touchedBlockHashesBetween,
  type UpdateJournal,
} from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export type DraftProjectionUpdate = {
  id?: number;
  seq?: number;
  updateData: Uint8Array;
  updateKind?: string | null;
};
export type DraftProjectionStore = {
  listUpdates(draftId: string): Promise<DraftProjectionUpdate[]>;
};

type HistoricalJournal = Pick<UpdateJournal, "read">;

/**
 * Room basis: live journal at the draft's stored `baseLiveUpdateSeq` plus draft
 * rows. Used when loading the Hocuspocus draft room.
 */
export async function buildStoredDraftProjection(
  journal: HistoricalJournal,
  draftStore: DraftProjectionStore,
  documentId: DocumentId,
  draftId: string,
  baseLiveUpdateSeq: number,
): Promise<Y.Doc> {
  const snapshot = await readLiveSnapshot(journal, documentId, baseLiveUpdateSeq);
  const draftUpdates = await draftStore.listUpdates(draftId);
  return projectDraftFromSnapshot(snapshot, draftUpdates);
}

/**
 * Review basis: live journal at the current (or supplied) head plus draft rows.
 * Used for preview, accept overlap, and review-model assembly.
 */
export async function buildReviewDraftProjection(
  journal: HistoricalJournal,
  draftStore: DraftProjectionStore,
  documentId: DocumentId,
  draftId: string,
  liveRevisionToken: number,
  tombstoneFreeBasisSeq?: number,
): Promise<Y.Doc> {
  const basisDoc = await buildLiveDocAtSeq(
    journal,
    documentId,
    tombstoneFreeBasisSeq ?? liveRevisionToken,
  );
  const draftUpdates = await draftStore.listUpdates(draftId);
  try {
    return projectDraftFromSnapshot(
      { checkpoint: Y.encodeStateAsUpdate(basisDoc), updates: [] },
      draftUpdates,
    );
  } finally {
    basisDoc.destroy();
  }
}

/** Live and projected draft docs at a review basis — caller destroys both. */
export async function buildReviewBasisDocs(
  journal: HistoricalJournal,
  draftStore: DraftProjectionStore,
  documentId: DocumentId,
  draftId: string,
  liveRevisionToken: number,
  tombstoneFreeBasisSeq?: number,
): Promise<{ liveDoc: Y.Doc; draftDoc: Y.Doc }> {
  const liveDoc = await buildLiveDocAtSeq(journal, documentId, liveRevisionToken);
  const basisDoc =
    tombstoneFreeBasisSeq === undefined
      ? liveDoc
      : await buildLiveDocAtSeq(journal, documentId, tombstoneFreeBasisSeq);
  const draftUpdates = await draftStore.listUpdates(draftId);
  try {
    const draftDoc = projectDraftFromSnapshot(
      { checkpoint: Y.encodeStateAsUpdate(basisDoc), updates: [] },
      draftUpdates,
    );
    return { liveDoc, draftDoc };
  } finally {
    if (basisDoc !== liveDoc) basisDoc.destroy();
  }
}

export async function buildDraftJournalSnapshot(
  journal: HistoricalJournal,
  draftStore: DraftProjectionStore & {
    getDraft(
      draftId: string,
    ): Promise<{ documentId: DocumentId; status: string; baseLiveUpdateSeq: number } | null>;
  },
  documentId: DocumentId,
  draftId: string,
): Promise<
  { status: "active"; revisionToken: number; snapshot: JournalSnapshot } | { status: "not_found" }
> {
  const draft = await draftStore.getDraft(draftId);
  if (!draft || draft.documentId !== documentId || draft.status !== "active")
    return { status: "not_found" };
  const baseDoc = await buildLiveDocAtSeq(journal, documentId, draft.baseLiveUpdateSeq);
  const draftUpdates = await draftStore.listUpdates(draftId);
  try {
    return {
      status: "active",
      revisionToken: Math.max(0, ...draftUpdates.map(updateSeq)),
      snapshot: {
        checkpoint: Y.encodeStateAsUpdate(baseDoc),
        updates: draftUpdates.map((update) => ({
          seq: updateSeq(update),
          update: update.updateData,
          updateKind: update.updateKind ?? null,
          meta: { origin: "system", seq: updateSeq(update) },
        })),
      },
    };
  } finally {
    baseDoc.destroy();
  }
}

export async function buildLiveDocAtSeq(
  journal: HistoricalJournal,
  documentId: DocumentId,
  seq?: number,
): Promise<Y.Doc> {
  const snapshot = await readLiveSnapshot(journal, documentId, seq);
  const doc = createCollabYDoc({ gc: false });
  applyLiveSnapshot(doc, snapshot);
  return doc;
}

/** Review projection from an encoded live doc (coordinator path) plus draft rows. */
export function buildProjectionFromEncodedLive(
  liveState: Uint8Array,
  draftUpdates: readonly DraftProjectionUpdate[],
): Y.Doc {
  return projectDraftFromSnapshot({ checkpoint: liveState, updates: [] }, draftUpdates);
}

export function serializePreview(doc: Y.Doc, codec: AgentEditCodec, model: AgentEditModel): string {
  const handle = toDocHandle(doc);
  if (model.getBlocks(handle).length === 0) return "";
  return codec.serialize(model.projectBlocks(handle));
}

export function computeOverlapBlocks(input: {
  baseDoc: Y.Doc;
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  codec: AgentEditCodec;
  model: AgentEditModel;
}): string[] {
  const liveTouched = touchedBlockHashesBetween({
    before: toDocHandle(input.baseDoc),
    after: toDocHandle(input.liveDoc),
    model: input.model,
    codec: input.codec,
  });
  const draftTouched = touchedBlockHashesBetween({
    before: toDocHandle(input.liveDoc),
    after: toDocHandle(input.draftDoc),
    model: input.model,
    codec: input.codec,
  });
  return [...draftTouched].filter((hash) => liveTouched.has(hash)).sort();
}

function projectDraftFromSnapshot(
  liveJournalUpdates: JournalSnapshot,
  draftUpdates: readonly DraftProjectionUpdate[],
): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  applyLiveSnapshot(doc, liveJournalUpdates);
  applyDraftUpdates(doc, draftUpdates);
  return doc;
}

function updateSeq(update: DraftProjectionUpdate): number {
  const seq = update.seq ?? update.id;
  if (seq === undefined) throw new Error("Draft projection update is missing a row sequence");
  return seq;
}

function applyLiveSnapshot(doc: Y.Doc, snapshot: JournalSnapshot): void {
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint, { type: "system" });
  for (const update of snapshot.updates) {
    Y.applyUpdate(doc, update.update, { type: "system" });
  }
}

export function applyDraftUpdate(doc: Y.Doc, update: DraftProjectionUpdate): void {
  if (update.updateKind === "replaceAll") {
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    fragment.delete(0, fragment.length);
  }
  Y.applyUpdate(doc, update.updateData, { type: "draft" });
}

export function applyDraftUpdates(doc: Y.Doc, updates: readonly DraftProjectionUpdate[]): void {
  for (const update of updates) applyDraftUpdate(doc, update);
}

function readLiveSnapshot(
  journal: HistoricalJournal,
  documentId: DocumentId,
  seq?: number,
): Promise<JournalSnapshot> {
  if (seq === undefined) return journal.read(documentId);
  return (
    journal.read as (
      docId: string,
      opts: { until: number; fromCheckpoint?: boolean },
    ) => Promise<JournalSnapshot>
  )(documentId, { until: seq, fromCheckpoint: false });
}
