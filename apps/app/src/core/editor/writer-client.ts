/** Rotates content identity without leaving awareness on the old writer client. */
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";

export function rotateWriterClient(
  document: Y.Doc,
  adoptDocumentClient?: () => void,
  excluded: ReadonlySet<number> = new Set(),
) {
  document.clientID = allocateDocumentClient(document, excluded);
  adoptDocumentClient?.();
}
