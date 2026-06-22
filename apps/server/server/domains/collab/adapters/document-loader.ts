/** Rebuilds encoded Y.Doc state from the durable UpdateJournal. */

import type { UpdateJournal } from "@meridian/agent-edit";
import * as Y from "yjs";

export async function loadDocumentState(
  journal: UpdateJournal,
  docId: string,
): Promise<Uint8Array | null> {
  const snapshot = await journal.read(docId);
  if (!snapshot.checkpoint && snapshot.updates.length === 0) return null;

  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const entry of [...snapshot.updates].sort((a, b) => a.seq - b.seq)) {
    Y.applyUpdate(doc, entry.update);
  }
  return Y.encodeStateAsUpdate(doc);
}
