/** Rebuilds encoded Y.Doc state from the durable UpdateJournal. */

import type { JournalSnapshot, UpdateJournal } from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import {
  bindDocumentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
} from "../domain/document-handle.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";
import { storedDocument } from "../domain/stored-document.js";

export async function loadDocumentState(
  journal: UpdateJournal,
  docId: string,
  handle?: Y.Doc,
  captured?: JournalSnapshot,
): Promise<Uint8Array | null> {
  const snapshot = captured ?? (await journal.read(docId));
  if (handle && snapshot.authority) {
    if (isDocumentHandleRetired(handle)) throw new RetiredDocumentHandleError();
    bindDocumentAuthority(handle, snapshot.authority as CheckpointAuthority);
  }
  if (!snapshot.checkpoint && snapshot.updates.length === 0) return null;

  const doc = storedDocument(snapshot);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
