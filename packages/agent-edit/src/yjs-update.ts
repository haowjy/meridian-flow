// Semantic Yjs update helpers for distinguishing real document changes from wire bytes.
import * as Y from "yjs";

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function cloneYDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

export function yjsUpdateChangesDoc(doc: Y.Doc, update: Uint8Array): boolean {
  const probe = cloneYDoc(doc);
  try {
    const before = Y.encodeStateAsUpdate(probe);
    Y.applyUpdate(probe, update);
    return !bytesEqual(before, Y.encodeStateAsUpdate(probe));
  } finally {
    probe.destroy();
  }
}

export function effectiveYjsUpdate(doc: Y.Doc, update: Uint8Array): Uint8Array | null {
  return yjsUpdateChangesDoc(doc, update) ? update : null;
}

export function applyYjsUpdateIfEffective(
  doc: Y.Doc,
  update: Uint8Array,
  origin?: unknown,
): boolean {
  if (!yjsUpdateChangesDoc(doc, update)) return false;
  Y.applyUpdate(doc, update, origin);
  return true;
}

export function yjsDeltaUpdate(from: Y.Doc, to: Y.Doc): Uint8Array | null {
  const update = Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
  return effectiveYjsUpdate(to, update);
}

export function yjsUpdateFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  return doc;
}
