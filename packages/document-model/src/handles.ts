import { type LoroDoc, type LoroMap, type LoroText, VersionVector } from "loro-crdt";
import { TEXT_KEY } from "./shape.js";

/**
 * Loro hands out a WASM handle for every container, version vector and cursor a call returns, and
 * WASM memory is never garbage collected: unfreed handles grow it without bound (2M unfreed
 * reads grew it by 470 MB). Use a handle inside `scoped` or one of these, and never keep one
 * past the call that made it.
 */
export function scoped<H extends { free(): void }, T>(handle: H, use: (handle: H) => T): T {
  try {
    return use(handle);
  } finally {
    handle.free();
  }
}

/** `use` on a text doc's text. */
export function inText<T>(doc: LoroDoc, use: (text: LoroText) => T): T {
  return scoped(doc.getText(TEXT_KEY), use);
}

/** `use` on one of a structure doc's maps. */
export function inMap<T>(doc: LoroDoc, name: string, use: (map: LoroMap) => T): T {
  return scoped(doc.getMap(name), use);
}

/** `use` on a doc's oplog version. */
export function inVersion<T>(doc: LoroDoc, use: (version: VersionVector) => T): T {
  return scoped(doc.oplogVersion(), use);
}

/** A doc's oplog version, encoded: a plain value to hold where a handle must not be held. */
export function encodedVersionOf(doc: LoroDoc): Uint8Array {
  return inVersion(doc, (version) => version.encode());
}

/** Whether `doc`'s oplog version is the one `encoded` (`encodedVersionOf`) holds. */
export function atVersion(doc: LoroDoc, encoded: Uint8Array): boolean {
  return scoped(VersionVector.decode(encoded), (at) =>
    inVersion(doc, (version) => version.compare(at) === 0),
  );
}

/** The update of `doc` beyond the version `encoded` (`encodedVersionOf`) holds. */
export function updateSince(doc: LoroDoc, encoded: Uint8Array): Uint8Array {
  return scoped(VersionVector.decode(encoded), (from) => doc.export({ mode: "update", from }));
}

/** Run `run`, and tell whether it added ops to `doc`; `run` gets the version from before it. */
export function grew<T>(
  doc: LoroDoc,
  run: (before: VersionVector) => T,
): { value: T; grew: boolean } {
  return scoped(doc.oplogVersion(), (before) => {
    const value = run(before);
    return { value, grew: inVersion(doc, (after) => after.compare(before) !== 0) };
  });
}

/** Free the vectors of a `RoomDocs.version()` or `shownVersion()` the caller is done with. */
export function freeVersion(version: ReadonlyMap<string, VersionVector>): void {
  for (const vector of version.values()) vector.free();
}
