/** Rotates content identity without leaving awareness on the old writer client. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export function rotateWriterClient(
  document: Y.Doc,
  adoptDocumentClient?: () => void,
  excluded: ReadonlySet<number> = new Set(),
) {
  const used = new Set([...Y.decodeStateVector(Y.encodeStateVector(document)).keys(), ...excluded]);
  let next = createCollabYDoc();
  while (next.clientID === document.clientID || used.has(next.clientID)) {
    next.destroy();
    next = createCollabYDoc();
  }
  document.clientID = next.clientID;
  adoptDocumentClient?.();
  next.destroy();
}
