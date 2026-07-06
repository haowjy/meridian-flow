/** Pure Yjs branch-to-branch propagation primitive for collab branch peers. */
import * as Y from "yjs";

/** The one sync primitive. Both pull and push use this. */
export function sync(from: Y.Doc, to: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
  Y.applyUpdate(to, update);
  return update;
}
