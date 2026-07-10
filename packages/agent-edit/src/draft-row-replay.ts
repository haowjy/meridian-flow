/** Shared replay semantics for draft rows whose metadata changes projection behavior. */
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "./model/prosemirror-fragment.js";

export type DraftRowReplayUpdate = {
  update: Uint8Array;
  updateKind?: string | null;
};

export type DraftRowReplayOptions = {
  fragmentName?: string;
  origin?: unknown;
};

export function replayDraftRowUpdate(
  doc: Y.Doc,
  update: DraftRowReplayUpdate,
  options: DraftRowReplayOptions = {},
): void {
  if (update.updateKind !== "replaceAll") {
    Y.applyUpdate(doc, update.update, options.origin);
    return;
  }

  // Replay-only compatibility for rows written before whole-document overwrite
  // moved to the identity-preserving resolver. New writes never emit this kind.
  doc.transact(() => {
    const fragment = doc.getXmlFragment(options.fragmentName ?? PROSEMIRROR_FRAGMENT_NAME);
    fragment.delete(0, fragment.length);
    Y.applyUpdate(doc, update.update, options.origin);
  }, options.origin);
}
