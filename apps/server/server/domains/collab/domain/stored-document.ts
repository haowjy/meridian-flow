/** The Y.Doc a journal snapshot stores. */
import type { JournalSnapshot } from "@meridian/agent-edit/integration";
import * as Y from "yjs";

/** The stored state as a document; the caller destroys it. */
export function storedDocument(snapshot: JournalSnapshot): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const entry of [...snapshot.updates].sort((a, b) => a.seq - b.seq)) {
    Y.applyUpdate(doc, entry.update);
  }
  return doc;
}
