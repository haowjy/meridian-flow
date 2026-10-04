/** Rebuilds encoded Y.Doc state from the durable UpdateJournal. */

import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  bindDocumentAuthority,
  isDocumentHandleRetired,
  RetiredDocumentHandleError,
} from "../domain/document-handle.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";

export async function loadDocumentState(
  journal: UpdateJournal,
  docId: string,
  handle?: Y.Doc,
): Promise<Uint8Array | null> {
  const snapshot = await journal.read(docId);
  if (handle && snapshot.authority) {
    if (isDocumentHandleRetired(handle)) throw new RetiredDocumentHandleError();
    bindDocumentAuthority(handle, snapshot.authority as CheckpointAuthority);
  }
  if (!snapshot.checkpoint && snapshot.updates.length === 0) return null;

  const doc = createCollabYDoc({ gc: false });
  try {
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const entry of [...snapshot.updates].sort((a, b) => a.seq - b.seq)) {
      Y.applyUpdate(doc, entry.update);
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
