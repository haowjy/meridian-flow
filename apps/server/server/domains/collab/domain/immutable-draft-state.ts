/** Lazy encodings shared only by finalized, immutable draft documents and save cuts. */
import type { SaveCut } from "@meridian/agent-edit/integration";
import * as Y from "yjs";

// Key lifetime is the immutable document's, not the append that produced it. An accessor
// created inside finalization would retain that operation's inputs and previous replica.
const encodings = new WeakMap<Y.Doc, Uint8Array>();

export function encodeImmutableDraft(doc: Y.Doc): Uint8Array {
  let encoded = encodings.get(doc);
  if (!encoded) {
    encoded = Y.encodeStateAsUpdate(doc);
    encodings.set(doc, encoded);
  }
  return encoded;
}

export class DraftSaveCut implements SaveCut {
  constructor(
    readonly beforeState: Uint8Array,
    private readonly afterDoc: Y.Doc,
  ) {}

  get afterState(): Uint8Array {
    return encodeImmutableDraft(this.afterDoc);
  }
}
