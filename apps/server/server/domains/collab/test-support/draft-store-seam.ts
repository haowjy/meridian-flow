/** Test reads and appends straight through a draft store's read seam and its one append door. */
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { readDraftAt } from "../adapters/drizzle-draft-storage.js";
import { createDocumentContainment } from "../domain/document-containment.js";
import { finalizeAppend } from "../domain/draft-receipts.js";
import {
  type AppendDraftJournalInput,
  type DraftStore,
  materializeDraftRead,
} from "../domain/draft-store.js";

/** A fresh paragraph of `text` from a new client: a row with a visible effect. */
export function proseDraftUpdate(text = "drafted"): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph]);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Appends `rows` (a writer's or an agent's) through the store's one append door, finalized on
 * the committed prefix as a coordinator's append is; the ids come back.
 */
export async function appendDraftRows(
  store: Pick<DraftStore, "readDraftAt" | "appendRows">,
  draftId: string,
  rows: readonly Omit<AppendDraftJournalInput, "draftId">[],
): Promise<readonly number[]> {
  const read = await store.readDraftAt(draftId);
  if (!read) throw new Error(`Draft ${draftId} does not exist`);
  const journals = rows.map((row) => ({
    ...row,
    draftId,
  }));
  const candidate = materializeDraftRead(read);
  let doc: Y.Doc | undefined;
  try {
    const outcome = await store.appendRows({
      draftId,
      documentId: read.documentDraft.documentId,
      base: {
        checkpointRevision: read.documentDraft.checkpointRevision,
        seq: Math.max(read.documentDraft.checkpointSeq, ...read.tail.map((row) => row.id)),
      },
      finalize(prefix) {
        const judged = finalizeAppend(prefix, {
          candidate,
          rows: journals,
          containment: createDocumentContainment(),
          validateWriter: () => {},
        });
        doc = judged.doc;
        return judged.finalization;
      },
    });
    if (outcome.status !== "appended")
      throw new Error(`Draft ${draftId} append was ${outcome.status}`);
    return outcome.rowIds;
  } finally {
    candidate.destroy();
    doc?.destroy();
  }
}

/**
 * A resolved draft with its content, read together through the draft store.
 */
export async function readResolvedDraft(
  store: Pick<DraftStore, "readDraftAt">,
  resolved: { draftId: string },
): Promise<{ draftId: string; doc: Y.Doc }> {
  const read = await store.readDraftAt(resolved.draftId);
  if (!read) throw new Error(`Draft ${resolved.draftId} does not exist`);
  return {
    draftId: read.documentDraft.draftId,
    doc: materializeDraftRead(read),
  };
}

/** The draft's content now (checkpoint ⊕ tail), as update bytes. */
export async function readDraftContent(
  store: Pick<DraftStore, "readDraftAt">,
  draftId: string,
): Promise<Uint8Array> {
  const read = await store.readDraftAt(draftId);
  if (!read) throw new Error(`Draft ${draftId} does not exist`);
  const doc = materializeDraftRead(read);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** The draft's content as the database holds it (checkpoint ⊕ tail), read through the seam. */
export async function draftContent(db: DrizzleDb, draftId: string): Promise<Uint8Array> {
  const read = await readDraftAt(db, draftId);
  if (!read) throw new Error(`Draft ${draftId} does not exist`);
  const doc = materializeDraftRead(read);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
