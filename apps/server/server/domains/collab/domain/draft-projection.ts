/** Shared Yjs projection helpers for live documents plus draft updates. */
import {
  type AgentEditCodec,
  type AgentEditModel,
  type JournalSnapshot,
  toDocHandle,
  touchedBlockHashesBetween,
  type UpdateJournal,
} from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export type DraftProjectionUpdate = { id?: number; seq?: number; updateData: Uint8Array };
export type DraftProjectionStore = {
  listUpdates(draftId: string): Promise<DraftProjectionUpdate[]>;
};

type HistoricalJournal = Pick<UpdateJournal, "read">;

/**
 * Replays persisted live state first, then draft deltas, into a fresh collab doc.
 * The returned doc is owned by the caller and must be destroyed when no longer needed.
 */
export function buildDraftDoc(
  liveJournalUpdates: JournalSnapshot,
  draftUpdates: readonly DraftProjectionUpdate[],
): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  applyLiveSnapshot(doc, liveJournalUpdates);
  applyDraftUpdates(doc, draftUpdates);
  return doc;
}

/** Builds a draft projection from journal state at a live sequence plus stored draft deltas. */
export async function buildAtLiveSeq(
  journal: HistoricalJournal,
  draftStore: DraftProjectionStore,
  documentId: DocumentId,
  draftId: string,
  seq?: number,
): Promise<Y.Doc> {
  const snapshot = await readLiveSnapshot(journal, documentId, seq);
  const draftUpdates = await draftStore.listUpdates(draftId);
  return buildDraftDoc(snapshot, draftUpdates);
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

function applyDraftUpdates(doc: Y.Doc, updates: readonly DraftProjectionUpdate[]): void {
  for (const update of updates) Y.applyUpdate(doc, update.updateData, { type: "draft" });
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
